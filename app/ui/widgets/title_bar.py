"""自绘窗口外壳：标题栏 + 无边框窗口的边缘缩放。

用户要求「不要系统标题栏，自己绘制」（对齐 VSCode），因此主窗口是 frameless 的，
原本由窗口管理器提供的三件事都要自己实现：

* **菜单栏**：VSCode 把菜单和窗口标题放在同一行，所以主窗口真正的 ``QMenuBar``
  （由 :class:`QMainWindow` 创建、拥有全部 QAction 与快捷键）会被**搬进本控件**，
  本控件再通过 ``QMainWindow.setMenuWidget()`` 顶到窗口最上方。注意菜单栏必须是
  *主窗口自己的那一个*：自己 new 一个 ``QMenuBar`` 会让 Qt 在下次 ``menuBar()``
  调用时另建一个、把菜单 widget 顶掉（实测，见 ``tests/test_title_bar.py``）。
* **移动**：拖标题栏 → ``QWindow.startSystemMove()``（交给窗口管理器，跨平台且保留
  边缘吸附 / 多显示器行为）；调用失败（个别平台）时退回手动移动；
* **最大化 / 还原 / 最小化 / 关闭**：标题栏右侧的自绘按钮；双击标题栏也能最大化；
* **缩放**：窗口四周 5px 作为热区（:class:`WindowResizeFilter`），按下后调用
  ``QWindow.startSystemResize()``。热区挂在 QApplication 上，所以即使鼠标停在
  滚动条、编辑器这类子控件上，边缘依然可以拖动缩放。

配色一律取自 :mod:`app.ui.theme`（标题栏底色 / 分隔线 / 关闭按钮的警示色都是主题字段），
按钮图标沿用 :mod:`app.ui.icons` 的自绘线条图标。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QEvent, QObject, QPoint, QSize, Qt
from PySide6.QtGui import QColor, QCursor, QIcon, QMouseEvent
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QMenuBar,
    QWidget,
)

from app.ui.icons import render_pixmap
from app.ui.theme import Theme
from app.ui.widgets.fade_button import FadeButton

TITLE_BAR_HEIGHT = 34
WINDOW_BUTTON_SIZE = QSize(46, TITLE_BAR_HEIGHT)
TITLE_ICON_SIZE = 16
#: 边缘缩放热区宽度（像素）
RESIZE_MARGIN = 5

#: 窗口按钮：``(objectName, 图标名, 提示)``
WINDOW_BUTTONS = (
    ("window_minimize", "minimize", "最小化"),
    ("window_maximize", "maximize", "最大化"),
    ("window_close", "close", "关闭"),
)


def _window_icon(name: str, normal: QColor, active: QColor, size: int = TITLE_ICON_SIZE) -> QIcon:
    """窗口按钮图标：正常态用主题前景灰，悬停（``QIcon.Mode.Active``）用高对比色。

    关闭按钮悬停时底色是警示红，所以图标必须能在红底上看得清。
    """
    icon = QIcon()
    for scale in (1, 2):
        icon.addPixmap(render_pixmap(name, normal, size * scale))
        icon.addPixmap(render_pixmap(name, active, size * scale), QIcon.Mode.Active)
    return icon


class TitleBar(QWidget):
    """标题栏：左菜单、中标题、右窗口按钮；同时负责拖动与双击最大化。"""

    def __init__(
        self,
        window: QWidget,
        menu_bar: QMenuBar,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("title_bar")
        self.setFixedHeight(TITLE_BAR_HEIGHT)
        self._window = window
        self._drag_origin: Optional[QPoint] = None
        self._theme: Optional[Theme] = None
        self._ui_scale: float = 1.0

        layout = QHBoxLayout(self)
        layout.setContentsMargins(6, 0, 0, 0)
        layout.setSpacing(4)

        # 菜单栏直接住进标题栏（VSCode 也是菜单和窗口标题同一行）。
        # 这里只是「接管」主窗口已有的那一个，不新建：见类文档里的说明。
        self.menu_bar = menu_bar
        self.menu_bar.setObjectName("title_menu_bar")
        layout.addWidget(self.menu_bar)
        layout.addStretch(1)

        self.title_label = QLabel("", self)
        self.title_label.setObjectName("title_label")
        self.title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.title_label)
        layout.addStretch(1)

        self._buttons = {}
        for object_name, icon_name, tooltip in WINDOW_BUTTONS:
            button = FadeButton(QColor("#888888"), radius=0.0, parent=self)
            button.setObjectName(object_name)
            button.setToolTip(tooltip)
            button.setFixedSize(WINDOW_BUTTON_SIZE)
            button.setIconSize(QSize(TITLE_ICON_SIZE, TITLE_ICON_SIZE))
            layout.addWidget(button)
            self._buttons[object_name] = button

        self._buttons["window_minimize"].clicked.connect(self._window.showMinimized)
        self._buttons["window_maximize"].clicked.connect(self.toggle_maximized)
        self._buttons["window_close"].clicked.connect(self._window.close)
        self.sync_window_state()

    # -- 状态同步 ----------------------------------------------------------
    def apply_theme(self, theme: Theme, *, ui_scale: float = 1.0) -> None:
        """按主题重建窗口按钮图标，并按全局缩放重算栏高 / 按钮 / 图标尺寸。

        VSCode 的窗口缩放是「整个界面一起变大」，标题栏高度与按钮尺寸也要随字号走。
        """
        self._theme = theme
        self._ui_scale = max(0.5, min(3.0, float(ui_scale)))
        scale = self._ui_scale
        self.setFixedHeight(round(TITLE_BAR_HEIGHT * scale))
        icon_size = round(TITLE_ICON_SIZE * scale)
        button_size = QSize(
            round(WINDOW_BUTTON_SIZE.width() * scale),
            round(TITLE_BAR_HEIGHT * scale),
        )
        normal = theme.color("status_fg")
        active = theme.color("editor_fg")
        # 三个窗口按钮的悬停底色统一为中性灰（与 VSCode 一致：关闭不再是单独的红块）
        hover_neutral = theme.color("list_hover")
        for object_name, icon_name, _tooltip in WINDOW_BUTTONS:
            button = self._buttons[object_name]
            button.setFixedSize(button_size)
            button.setIconSize(QSize(icon_size, icon_size))
            button.setIcon(_window_icon(icon_name, normal, active, icon_size))
            button.set_hover_color(hover_neutral)

    def set_title(self, text: str) -> None:
        self.title_label.setText(text)

    def is_maximized(self) -> bool:
        return bool(self._window.windowState() & Qt.WindowState.WindowMaximized)

    def toggle_maximized(self) -> None:
        if self.is_maximized():
            self._window.showNormal()
        else:
            self._window.showMaximized()
        self.sync_window_state()

    def sync_window_state(self) -> None:
        """最大化 / 还原按钮的图标与提示跟着窗口状态走。"""
        maximized = self.is_maximized()
        button = self._buttons["window_maximize"]
        button.setToolTip("还原" if maximized else "最大化")
        color = self._theme.color("status_fg") if self._theme else QColor("#cccccc")
        active = self._theme.color("editor_fg") if self._theme else QColor("#ffffff")
        icon_size = round(TITLE_ICON_SIZE * self._ui_scale)
        button.setIcon(
            _window_icon("restore" if maximized else "maximize", color, active, icon_size)
        )

    # -- 拖动 --------------------------------------------------------------
    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: D102 - Qt 接口
        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return
        handle = self._window.windowHandle()
        if handle is not None and handle.startSystemMove():
            # 交给窗口管理器：锁定 / 吸附 / 跨屏行为都和原生窗口一致
            event.accept()
            return
        self._drag_origin = event.globalPosition().toPoint() - self._window.frameGeometry().topLeft()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: D102 - Qt 接口
        if self._drag_origin is None or not (event.buttons() & Qt.MouseButton.LeftButton):
            super().mouseMoveEvent(event)
            return
        self._window.move(event.globalPosition().toPoint() - self._drag_origin)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: D102 - Qt 接口
        self._drag_origin = None

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: D102 - Qt 接口
        if event.button() == Qt.MouseButton.LeftButton:
            self.toggle_maximized()
            return
        super().mouseDoubleClickEvent(event)


def _edges_for(local: QPoint, size: QSize, margin: int = RESIZE_MARGIN) -> Qt.Edge:
    """窗口内坐标 ``local`` 落在哪些边缘的缩放热区里（不在热区返回 0）。"""
    edges = Qt.Edge(0)
    if local.x() <= margin:
        edges |= Qt.Edge.LeftEdge
    elif local.x() >= size.width() - margin:
        edges |= Qt.Edge.RightEdge
    if local.y() <= margin:
        edges |= Qt.Edge.TopEdge
    elif local.y() >= size.height() - margin:
        edges |= Qt.Edge.BottomEdge
    return edges


_CURSORS = {
    Qt.Edge.TopEdge: Qt.CursorShape.SizeVerCursor,
    Qt.Edge.BottomEdge: Qt.CursorShape.SizeVerCursor,
    Qt.Edge.LeftEdge: Qt.CursorShape.SizeHorCursor,
    Qt.Edge.RightEdge: Qt.CursorShape.SizeHorCursor,
    Qt.Edge.TopEdge | Qt.Edge.LeftEdge: Qt.CursorShape.SizeFDiagCursor,
    Qt.Edge.BottomEdge | Qt.Edge.RightEdge: Qt.CursorShape.SizeFDiagCursor,
    Qt.Edge.TopEdge | Qt.Edge.RightEdge: Qt.CursorShape.SizeBDiagCursor,
    Qt.Edge.BottomEdge | Qt.Edge.LeftEdge: Qt.CursorShape.SizeBDiagCursor,
}


class WindowResizeFilter(QObject):
    """给无边框窗口装一圈缩放热区。

    挂在 ``QApplication`` 上而不是某个控件上：鼠标停在滚动条 / 编辑器上也照样能拖边缘，
    这正是「自己画标题栏」最容易漏掉的一环。
    """

    def __init__(self, window: QWidget, parent: Optional[QObject] = None) -> None:
        super().__init__(parent or window)
        self._window = window

    def _edges_at(self, global_pos: QPoint) -> Qt.Edge:
        if not self._window.isVisible() or self._window.isFullScreen():
            return Qt.Edge(0)
        if self._window.windowState() & Qt.WindowState.WindowMaximized:
            return Qt.Edge(0)  # 最大化时不需要缩放，也不该出现缩放光标
        geometry = self._window.frameGeometry()
        if not geometry.contains(global_pos):
            return Qt.Edge(0)
        return _edges_for(global_pos - geometry.topLeft(), geometry.size())

    def eventFilter(self, obj: QObject, event: QEvent) -> bool:  # noqa: D102 - Qt 接口
        kind = event.type()
        if kind not in (QEvent.Type.MouseMove, QEvent.Type.MouseButtonPress):
            return False
        widget = QApplication.widgetAt(QCursor.pos())
        if widget is None or widget.window() is not self._window:
            return False
        edges = self._edges_at(QCursor.pos())
        if kind == QEvent.Type.MouseMove:
            cursor = _CURSORS.get(edges)
            if cursor is None:
                widget.unsetCursor()
            elif widget.cursor().shape() != cursor:
                widget.setCursor(cursor)
            return False
        if edges and event.button() == Qt.MouseButton.LeftButton:  # type: ignore[attr-defined]
            handle = self._window.windowHandle()
            if handle is not None and handle.startSystemResize(edges):
                return True
        return False
