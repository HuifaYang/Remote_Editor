"""源代码管理面板（仿 VSCode 的 SCM 视图）：列出与仓库不同的文件。

数据仍然来自文件树使用的那一份快照（`TreeStatus`），因此**打开这个面板不会产生
任何远端请求**；需要最新状态时点面板右上角的刷新（等价 `Shift+F5`）。
"""

from __future__ import annotations

import posixpath
from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QIcon
from PySide6.QtWidgets import (
    QAbstractItemView,
    QHBoxLayout,
    QLabel,
    QToolButton,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from app.git.git_client import TreeStatus
from app.git.models import ChangeType
from app.ui.icons import make_icon
from app.ui.theme import Theme, refresh_style
from app.ui.widgets.badge import BADGE_COLOR_ROLE, BADGE_ROLE, BadgeDelegate

FILE_ROLE = Qt.ItemDataRole.UserRole

_CHANGE_COLOR_ATTRIBUTE = {
    ChangeType.ADDED: "marker_added",
    ChangeType.MODIFIED: "marker_modified",
    ChangeType.DELETED: "marker_deleted",
}


class SourceControlView(QWidget):
    """「源代码管理」侧边栏视图。"""

    fileActivated = Signal(str)
    refreshRequested = Signal()

    def __init__(self, theme: Theme, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._theme = theme
        self._root = ""

        self.title = QLabel("源代码管理", self)
        title_font = self.title.font()
        title_font.setPointSizeF(max(7.5, title_font.pointSizeF() - 1.5))
        self.title.setFont(title_font)
        self.title.setContentsMargins(10, 4, 4, 4)

        self.refresh_button = QToolButton(self)
        self.refresh_button.setAutoRaise(True)
        self.refresh_button.setToolTip("刷新 Git 状态（Shift+F5）")
        self.refresh_button.clicked.connect(self.refreshRequested)

        header = QHBoxLayout()
        header.setContentsMargins(4, 1, 4, 1)
        header.setSpacing(1)
        header.addWidget(self.title)
        header.addStretch(1)
        header.addWidget(self.refresh_button)

        self.tree = QTreeWidget(self)
        self.tree.setColumnCount(1)
        self.tree.setHeaderHidden(True)
        self.tree.setRootIsDecorated(False)
        self.tree.setUniformRowHeights(True)
        self.tree.setIndentation(0)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.tree.setItemDelegate(BadgeDelegate(self.tree))
        self.tree.itemClicked.connect(self._on_item_clicked)

        self.empty_label = QLabel("没有检测到更改。", self)
        self.empty_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty_label.setWordWrap(True)
        self.empty_label.setContentsMargins(12, 18, 12, 12)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addLayout(header)
        layout.addWidget(self.tree, 1)
        layout.addWidget(self.empty_label)

        self.apply_theme(theme)
        self.set_snapshot(None)

    # -- 主题 --------------------------------------------------------------
    def apply_theme(self, theme: Theme) -> None:
        self._theme = theme
        self.refresh_button.setIcon(make_icon("refresh", theme.color("gutter_fg")))
        self.empty_label.setProperty("muted", True)
        refresh_style(self.empty_label)

    # -- 数据 --------------------------------------------------------------
    def set_snapshot(self, status: Optional[TreeStatus]) -> None:
        """用文件树快照填充列表；``None`` 表示还未识别出仓库。"""
        self.tree.clear()
        self._root = (status.root if status is not None else "") or ""
        changes = status.changes() if status is not None else []
        for path, change, letter in changes:
            item = QTreeWidgetItem([self._label_for(path)])
            item.setData(0, FILE_ROLE, path)
            item.setData(0, BADGE_ROLE, letter)
            colour = self._color_for(change)
            if colour is not None:
                item.setData(0, BADGE_COLOR_ROLE, colour)
                item.setForeground(0, colour)
            item.setToolTip(0, f"{path}\nGit: {change.label}")
            self.tree.addTopLevelItem(item)

        count = len(changes)
        self.title.setText(f"源代码管理 · {count} 处更改" if count else "源代码管理")
        self.tree.setVisible(count > 0)
        self.empty_label.setVisible(count == 0)

    def _label_for(self, path: str) -> str:
        """相对仓库根的路径（VSCode 的 SCM 列表也是这么显示）。"""
        if self._root and path.startswith(self._root.rstrip("/") + "/"):
            return path[len(self._root.rstrip("/")) + 1 :]
        return posixpath.basename(path) or path

    def _color_for(self, change: Optional[ChangeType]) -> Optional[QColor]:
        attribute = _CHANGE_COLOR_ATTRIBUTE.get(change) if change else None
        return self._theme.color(attribute) if attribute else None

    def _on_item_clicked(self, item: QTreeWidgetItem, _column: int) -> None:
        path = item.data(0, FILE_ROLE)
        if path:
            self.fileActivated.emit(str(path))

    def paths(self) -> list:
        """当前列出的文件路径（测试与「全部打开」用）。"""
        return [
            self.tree.topLevelItem(index).data(0, FILE_ROLE)
            for index in range(self.tree.topLevelItemCount())
        ]

    def icon_button_icon(self) -> QIcon:  # pragma: no cover - 仅为类型收敛
        return self.refresh_button.icon()
