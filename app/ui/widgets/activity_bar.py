"""左侧活动栏（仿 VSCode）：一列图标按钮，用来切换侧边栏视图或触发常用命令。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

from PySide6.QtCore import QSize, Signal
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QToolButton, QVBoxLayout, QWidget

from app.ui.icons import render_pixmap
from app.ui.theme import Theme

# 对齐 VSCode：活动栏图标明显大于文字（图标约 24px、按钮 44px、栏宽 52px），
# 视觉重心在图标上。上一轮把界面字号统一到代码字号后，图标若仍 18px 会显得偏小。
ACTIVITY_BAR_WIDTH = 52
BUTTON_SIZE = 44
ICON_SIZE = 24


@dataclass(frozen=True)
class ActivityItem:
    """一个活动栏条目。"""

    key: str
    tooltip: str
    icon: str
    #: ``True`` 表示切换侧边栏视图（互斥选中），``False`` 表示普通命令
    checkable: bool = False
    #: 是否贴到活动栏底部（设置之类的次级入口）
    at_bottom: bool = False


class ActivityBar(QWidget):
    """活动栏；点击后发出 ``itemTriggered(key, checked)``。"""

    itemTriggered = Signal(str, bool)

    def __init__(
        self,
        items: Sequence[ActivityItem],
        theme: Theme,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("activity_bar")
        self.setFixedWidth(ACTIVITY_BAR_WIDTH)
        self._items: List[ActivityItem] = list(items)
        self._buttons: Dict[str, QToolButton] = {}

        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.setSpacing(2)
        stretched = False
        for item in self._items:
            if item.at_bottom and not stretched:
                layout.addStretch(1)
                stretched = True
            button = QToolButton(self)
            button.setObjectName(f"activity_{item.key}")
            button.setFixedSize(BUTTON_SIZE, BUTTON_SIZE)
            button.setIconSize(QSize(ICON_SIZE, ICON_SIZE))
            button.setAutoRaise(True)
            button.setToolTip(item.tooltip)
            button.setCheckable(item.checkable)
            if item.checkable:
                button.setChecked(False)
            button.clicked.connect(
                lambda _checked=False, key=item.key: self.itemTriggered.emit(
                    key, self._buttons[key].isChecked()
                )
            )
            layout.addWidget(button)
            self._buttons[item.key] = button

        self._theme = theme
        self.apply_theme(theme)

    # -- 主题 / 选中状态 ---------------------------------------------------
    def apply_theme(self, theme: Theme, *, ui_scale: float = 1.0) -> None:
        """按主题重建图标，并按全局缩放重算栏宽 / 按钮 / 图标尺寸。

        VSCode 的窗口缩放（Ctrl+=）是「整个界面一起变大」，不是只放大文字，
        所以这里的固定像素都要乘 ``ui_scale``。
        """
        self._theme = theme
        scale = max(0.5, min(3.0, float(ui_scale)))
        self.setFixedWidth(round(ACTIVITY_BAR_WIDTH * scale))
        button_size = round(BUTTON_SIZE * scale)
        icon_size = round(ICON_SIZE * scale)
        normal = theme.color("gutter_fg")
        active = theme.color("editor_fg")
        for item in self._items:
            button = self._buttons[item.key]
            button.setFixedSize(button_size, button_size)
            button.setIconSize(QSize(icon_size, icon_size))
            button.setIcon(self._build_icon(item.icon, normal, active, icon_size))

    @staticmethod
    def _build_icon(name: str, normal, active, size: int = ICON_SIZE) -> QIcon:
        icon = QIcon()
        for scale in (1, 2):
            icon.addPixmap(render_pixmap(name, normal, size * scale))
            icon.addPixmap(
                render_pixmap(name, active, size * scale),
                QIcon.Mode.Normal,
                QIcon.State.On,
            )
        return icon

    def set_view(self, key: str) -> None:
        """把某个视图按钮设为选中（其余视图按钮取消选中）。"""
        for item in self._items:
            if not item.checkable:
                continue
            self._buttons[item.key].setChecked(item.key == key)

    def set_enabled(self, key: str, enabled: bool) -> None:
        button = self._buttons.get(key)
        if button is not None:
            button.setEnabled(enabled)

    def button(self, key: str) -> Optional[QToolButton]:
        return self._buttons.get(key)
