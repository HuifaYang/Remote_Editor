"""底部终端面板：多个终端页签 + 新建 / 终止按钮（对齐 VSCode 的终端面板）。

面板自己**不开连接**：主窗口通过构造参数 ``open_shell`` 注入「给这个视图开一条远端
shell」的动作（阻塞的 ``ShellChannel.open()`` 必须放工作线程，见 ``MainWindow``）。
这样面板在测试里可以完全脱离网络使用。
"""

from __future__ import annotations

from typing import Callable, List, Optional

from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QTabBar,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from app.ui.icons import make_icon
from app.ui.theme import Theme
from app.ui.widgets.editor_tabs import CLOSE_BUTTON_SIZE, CLOSE_ICON_SIZE
from app.ui.widgets.terminal_view import TerminalView

#: 面板头部按钮的图标名（与 icons.py 注册的一致）
_HEADER_BUTTONS = (
    ("plus", "新建终端（Ctrl+Shift+`）"),
    ("trash", "终止当前终端"),
    ("collapse", "收起终端面板"),
)


class TerminalPanel(QWidget):
    """终端页签容器。"""

    #: 请求收起面板（主窗口负责隐藏 dock）
    collapseRequested = Signal()
    #: 页签数量变化（没有终端时主窗口可以选择关掉面板）
    countChanged = Signal(int)

    def __init__(
        self,
        *,
        theme: Theme,
        font: QFont,
        open_shell: Callable[[TerminalView], None],
        gpu: Optional[bool] = None,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self._theme = theme
        self._font = font
        self._open_shell = open_shell
        self._gpu = gpu
        self._counter = 0
        self._buttons: List[tuple] = []
        #: 每个页签右上角的自绘关闭按钮（换主题时要重画图标）
        self._close_buttons: List[QToolButton] = []

        self.header_title = QLabel("终端", self)
        self.header_title.setContentsMargins(10, 2, 4, 2)
        title_font = self.header_title.font()
        title_font.setPointSizeF(max(7.5, title_font.pointSizeF() - 1.5))
        self.header_title.setFont(title_font)

        header = QWidget(self)
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(4, 1, 4, 1)
        header_layout.setSpacing(1)
        header_layout.addWidget(self.header_title)
        header_layout.addStretch(1)
        self.new_button = QToolButton(header)
        self.kill_button = QToolButton(header)
        self.collapse_button = QToolButton(header)
        for button, (icon, tooltip), slot in (
            (self.new_button, _HEADER_BUTTONS[0], self._on_new_clicked),
            (self.kill_button, _HEADER_BUTTONS[1], self._on_kill_clicked),
            (self.collapse_button, _HEADER_BUTTONS[2], self.collapseRequested.emit),
        ):
            button.setIcon(make_icon(icon, theme.color("gutter_fg")))
            button.setToolTip(tooltip)
            button.setAutoRaise(True)
            button.clicked.connect(slot)
            header_layout.addWidget(button)
            self._buttons.append((button, icon))

        self.tabs = QTabWidget(self)
        self.tabs.setObjectName("terminal_tabs")
        self.tabs.setDocumentMode(True)
        self.tabs.setMovable(True)
        # 不用 Qt 自带的关闭按钮（深色主题下是红方块，和 VSCode 风格不搭）
        self.tabs.setTabsClosable(False)
        self.tabs.currentChanged.connect(self._on_tab_changed)

        self.hint = QLabel("没有打开的终端。\n点右上角「+」新建一个。", self)
        self.hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.hint.setProperty("muted", True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(header)
        layout.addWidget(self.tabs, 1)
        layout.addWidget(self.hint, 1)
        self._update_placeholder()

    # -- 页签 --------------------------------------------------------------
    def new_terminal(self, *, title: str = "") -> TerminalView:
        """新建一个终端页签并请求主窗口去连接；返回视图（测试可直接喂数据）。"""
        self._counter += 1
        view = TerminalView(theme=self._theme, font=self._font, gpu=self._gpu, parent=self)
        view.closed.connect(lambda v=view: self._on_view_closed(v))
        index = self.tabs.addTab(view, title or f"终端 {self._counter}")
        self.tabs.tabBar().setTabButton(
            index, QTabBar.ButtonPosition.RightSide, self._make_close_button(view)
        )
        self.tabs.setCurrentIndex(index)
        self._update_placeholder()
        self.countChanged.emit(self.count())
        self._open_shell(view)
        return view

    def _make_close_button(self, view: TerminalView) -> QToolButton:
        """页签右上角的关闭按钮（与编辑器标签同一个自绘图标）。"""
        button = QToolButton(self)
        button.setObjectName("tab_close")
        button.setAutoRaise(True)
        button.setFixedSize(CLOSE_BUTTON_SIZE, CLOSE_BUTTON_SIZE)
        button.setIconSize(QSize(CLOSE_ICON_SIZE, CLOSE_ICON_SIZE))
        button.setToolTip("关闭终端")
        button.setCursor(Qt.CursorShape.ArrowCursor)
        button.setIcon(
            make_icon("close", self._theme.color("gutter_fg"), size=CLOSE_ICON_SIZE)
        )
        button.clicked.connect(lambda: self._close_view(view))
        self._close_buttons.append(button)
        return button

    def _close_view(self, view: TerminalView) -> None:
        self.close_tab(self.tabs.indexOf(view))

    def close_tab(self, index: int) -> None:
        """关闭第 ``index`` 个页签（并停掉它的通道）。"""
        view = self.tabs.widget(index)
        if view is None:
            return
        button = self.tabs.tabBar().tabButton(index, QTabBar.ButtonPosition.RightSide)
        if button is not None and button in self._close_buttons:
            self._close_buttons.remove(button)
        self.tabs.removeTab(index)
        if isinstance(view, TerminalView):
            view.stop()
        view.deleteLater()
        self._update_placeholder()
        self.countChanged.emit(self.count())

    def close_all(self) -> None:
        for index in range(self.tabs.count() - 1, -1, -1):
            self.close_tab(index)

    def count(self) -> int:
        return self.tabs.count()

    def views(self) -> List[TerminalView]:
        return [self.tabs.widget(i) for i in range(self.tabs.count())]

    def current_view(self) -> Optional[TerminalView]:
        widget = self.tabs.currentWidget()
        return widget if isinstance(widget, TerminalView) else None

    def focus_current(self) -> None:
        view = self.current_view()
        if view is not None:
            view.canvas.setFocus(Qt.FocusReason.OtherFocusReason)

    def _on_new_clicked(self) -> None:
        self.new_terminal()

    def _on_kill_clicked(self) -> None:
        index = self.tabs.currentIndex()
        if index >= 0:
            self.close_tab(index)

    def _on_view_closed(self, view: TerminalView) -> None:
        # 远端主动退出：页签保留（能看到最后的输出），只更新提示
        del view

    def _on_tab_changed(self, index: int) -> None:
        del index

    def _update_placeholder(self) -> None:
        has_tabs = self.tabs.count() > 0
        self.tabs.setVisible(has_tabs)
        self.hint.setVisible(not has_tabs)

    # -- 外观 --------------------------------------------------------------
    def set_theme(self, theme: Theme) -> None:
        self._theme = theme
        color = theme.color("gutter_fg")
        for button, icon in self._buttons:
            button.setIcon(make_icon(icon, color))
        for button in list(self._close_buttons):
            button.setIcon(make_icon("close", color, size=CLOSE_ICON_SIZE))
        for view in self.views():
            view.set_theme(theme)

    def set_font(self, font: QFont) -> None:
        self._font = font
        for view in self.views():
            view.set_font(font)

    def apply_theme(self, theme: Theme) -> None:
        self.set_theme(theme)
