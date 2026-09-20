"""源代码管理面板（仿 VSCode 的 SCM 视图）。

结构对齐 VSCode：顶部面板标题 + 刷新，下面是**提交信息框与「提交」按钮**，
再下面是可折叠的「更改」分组（带数量），每行显示「文件名 + 弱化的父目录 + 状态徽标」。

数据仍然来自文件树使用的那一份快照（``TreeStatus``），因此**打开这个面板不会产生
任何远端请求**；只有点「刷新」或真的点「提交」时才会发命令。
"""

from __future__ import annotations

import posixpath
from typing import Optional

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QColor, QIcon
from PySide6.QtWidgets import (
    QAbstractItemView,
    QHeaderView,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
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
    #: 用户填写提交信息并点「提交」（消息已去除首尾空白）
    commitRequested = Signal(str)

    def __init__(self, theme: Theme, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._theme = theme
        self._root = ""
        self._changes = 0

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

        # 提交信息 + 提交按钮（对齐 VSCode：输入框在上，提交按钮在下、占满整行）
        self.commit_edit = QLineEdit(self)
        self.commit_edit.setObjectName("scm_message")
        self.commit_edit.setPlaceholderText("消息（回车提交）")
        self.commit_edit.returnPressed.connect(self._submit_commit)
        self.commit_edit.textChanged.connect(self.sync_commit_state)

        self.commit_button = QPushButton("提交", self)
        self.commit_button.setObjectName("scm_commit")
        self.commit_button.setToolTip("暂存全部更改并提交到远端仓库")
        self.commit_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.commit_button.clicked.connect(self._submit_commit)

        commit_area = QVBoxLayout()
        commit_area.setContentsMargins(10, 2, 10, 6)
        commit_area.setSpacing(6)
        commit_area.addWidget(self.commit_edit)
        commit_area.addWidget(self.commit_button)

        # 「更改」分组标题 + 数量 + 折叠
        self.section_title = QLabel("更改", self)
        self.section_title.setObjectName("scm_section_title")
        self.count_label = QLabel("", self)
        self.count_label.setProperty("muted", True)
        self.collapse_button = QToolButton(self)
        self.collapse_button.setAutoRaise(True)
        self.collapse_button.setToolTip("折叠分组")
        self.collapse_button.clicked.connect(self._toggle_section)
        self._collapsed = False

        section = QHBoxLayout()
        section.setContentsMargins(10, 2, 6, 2)
        section.setSpacing(6)
        section.addWidget(self.section_title)
        section.addWidget(self.count_label)
        section.addStretch(1)
        section.addWidget(self.collapse_button)

        self.tree = QTreeWidget(self)
        # 两列：第 0 列文件名（永远不会被目录挤掉），第 1 列弱化的父目录，
        # 徽标画在第 1 列右端（对齐 VSCode 的「文件名  目录  状态字母」）
        self.tree.setColumnCount(2)
        self.tree.setHeaderHidden(True)
        self.tree.setRootIsDecorated(False)
        self.tree.setUniformRowHeights(True)
        self.tree.setIndentation(0)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.tree.setItemDelegate(BadgeDelegate(self.tree))
        # 文件名列按内容、目录列撑满剩余宽度（徽标画在目录列右端 = 面板右缘）
        tree_header = self.tree.header()
        tree_header.setSectionResizeMode(0, QHeaderView.ResizeMode.Interactive)
        tree_header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        tree_header.setStretchLastSection(True)
        self.tree.itemClicked.connect(self._on_item_clicked)

        self.empty_label = QLabel("没有检测到更改。", self)
        self.empty_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty_label.setWordWrap(True)
        self.empty_label.setContentsMargins(12, 18, 12, 12)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addLayout(header)
        layout.addLayout(commit_area)
        layout.addLayout(section)
        layout.addWidget(self.tree, 1)
        layout.addWidget(self.empty_label)

        self.apply_theme(theme)
        self.set_snapshot(None)

    # -- 主题 --------------------------------------------------------------
    def apply_theme(self, theme: Theme) -> None:
        self._theme = theme
        self.refresh_button.setIcon(make_icon("refresh", theme.color("gutter_fg")))
        self.collapse_button.setIcon(make_icon("collapse", theme.color("gutter_fg")))
        self.empty_label.setProperty("muted", True)
        refresh_style(self.empty_label)
        # 行内父目录颜色也跟着主题走（由委托取用）
        self._repaint_rows()

    # -- 数据 --------------------------------------------------------------
    def set_snapshot(self, status: Optional[TreeStatus]) -> None:
        """用文件树快照填充列表；``None`` 表示还未识别出仓库。"""
        self.tree.clear()
        self._root = (status.root if status is not None else "") or ""
        changes = status.changes() if status is not None else []
        muted = self._theme.color("gutter_fg")
        for path, change, letter in changes:
            name, directory = self._split(path)
            item = QTreeWidgetItem([name, directory])
            item.setData(0, FILE_ROLE, path)
            item.setForeground(1, muted)
            # 徽标挂在最后一列（右端对齐成一条竖线）
            item.setData(1, BADGE_ROLE, letter)
            colour = self._color_for(change)
            if colour is not None:
                item.setData(1, BADGE_COLOR_ROLE, colour)
                item.setForeground(0, colour)
            item.setToolTip(0, f"{path}\nGit: {change.label}")
            self.tree.addTopLevelItem(item)
        if changes:
            # 列表在此之前是隐藏的（空态），此刻 viewport 宽度还没更新 ——
            # 等布局刷新完再算列宽，否则文件名列会被夹到最小值。
            QTimer.singleShot(0, self._fit_name_column)

        self._changes = len(changes)
        self.count_label.setText(f"{self._changes}" if self._changes else "")
        self.tree.setVisible(self._changes > 0 and not self._collapsed)
        self.empty_label.setVisible(self._changes == 0)
        self.sync_commit_state()

    def _fit_name_column(self) -> None:
        """文件名列按内容自适应，最多占一半宽度（其余留给父目录列）。

        注意：填充数据时控件可能还没完成布局（此时 ``viewport()`` 宽度不可信），
        所以除了填充后调一次，``resizeEvent`` 里也要再算一次。
        """
        self.tree.resizeColumnToContents(0)
        limit = max(80, self.tree.viewport().width() // 2)
        if self.tree.columnWidth(0) > limit:
            self.tree.setColumnWidth(0, limit)

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        super().resizeEvent(event)
        if self.tree.topLevelItemCount():
            self._fit_name_column()

    def _repaint_rows(self) -> None:
        """换主题后刷新父目录列的颜色（单元格颜色不会自动跟着主题变）。"""
        colour = self._theme.color("gutter_fg")
        for index in range(self.tree.topLevelItemCount()):
            self.tree.topLevelItem(index).setForeground(1, colour)
        self.tree.viewport().update()

    def _split(self, path: str) -> tuple:
        """绝对路径 → ``(文件名, 相对仓库根的父目录)``。"""
        relative = self._relative(path)
        directory = posixpath.dirname(relative)
        return posixpath.basename(relative) or relative, directory

    def _relative(self, path: str) -> str:
        """相对仓库根的路径（VSCode 的 SCM 列表也是这么显示的）。"""
        if self._root and path.startswith(self._root.rstrip("/") + "/"):
            return path[len(self._root.rstrip("/")) + 1 :]
        return posixpath.basename(path) or path

    def _label_for(self, path: str) -> str:
        """兼容旧调用：返回文件名（父目录走第二段文字）。"""
        return self._split(path)[0]

    def _color_for(self, change: Optional[ChangeType]) -> Optional[QColor]:
        attribute = _CHANGE_COLOR_ATTRIBUTE.get(change) if change else None
        return self._theme.color(attribute) if attribute else None

    # -- 提交 --------------------------------------------------------------
    def _submit_commit(self) -> None:
        message = self.commit_edit.text().strip()
        if not message or self._changes == 0:
            return
        self.commitRequested.emit(message)

    def sync_commit_state(self) -> None:
        """有提交信息且确实有更改时，「提交」才可点（主窗口提交结束也会调一次）。"""
        editable = bool(self.commit_edit.text().strip()) and self._changes > 0
        self.commit_button.setEnabled(editable)

    def clear_message(self) -> None:
        """提交成功后清空输入框。"""
        self.commit_edit.clear()

    @property
    def changes_count(self) -> int:
        return self._changes

    # -- 分组折叠 ----------------------------------------------------------
    def _toggle_section(self) -> None:
        self._collapsed = not self._collapsed
        self.tree.setVisible(self._changes > 0 and not self._collapsed)
        self.collapse_button.setToolTip("展开分组" if self._collapsed else "折叠分组")

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
