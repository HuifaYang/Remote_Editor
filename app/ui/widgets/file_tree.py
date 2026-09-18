"""远程文件树控件。

只负责展示与交互，所有实际的文件操作通过信号交给主窗口（解耦，便于测试）。
目录采用懒加载：展开时才请求子节点，避免一次性遍历整个远程目录。

外观仿照 VSCode 的资源管理器：只有**一列文件名**（不会被大小 / 修改时间挤成
``command_handl…``），行高紧凑，大小 / 修改时间 / 权限等信息放 Tooltip。Git 状态来自
:class:`app.git.git_client.TreeStatus` 快照：未变更不着色，新增 / 修改 / 删除分别用
主题里的 marker 颜色着色，行右端画出 VSCode 风格的变更徽标（见 widgets/badge.py）。
"""

from __future__ import annotations

import posixpath
from typing import Dict, List, Optional

from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QAction, QBrush, QColor, QIcon
from PySide6.QtWidgets import (
    QAbstractItemView,
    QMenu,
    QStyle,
    QTreeWidget,
    QTreeWidgetItem,
    QWidget,
)

from app.git.git_client import TreeStatus
from app.git.models import ChangeType
from app.remote.sftp_client import RemoteEntry
from app.ui.icon_theme import FileIconTheme
from app.ui.theme import Theme
from app.ui.widgets.badge import BADGE_COLOR_ROLE, BADGE_ROLE, BadgeDelegate

PATH_ROLE = Qt.ItemDataRole.UserRole
DIR_ROLE = Qt.ItemDataRole.UserRole + 1
LOADED_ROLE = Qt.ItemDataRole.UserRole + 2
#: 该节点的 Git 变更类型（``ChangeType`` 的字符串值，未变更为空串）
CHANGE_ROLE = Qt.ItemDataRole.UserRole + 3
#: 不含 Git 状态的基础 Tooltip，便于状态刷新时重建
TOOLTIP_ROLE = Qt.ItemDataRole.UserRole + 4
#: 行高（VSCode 的资源管理器同样是紧凑的 22px 行）
ROW_HEIGHT = 22

_CHANGE_COLOR_ATTRIBUTE: Dict[ChangeType, str] = {
    ChangeType.ADDED: "marker_added",
    ChangeType.MODIFIED: "marker_modified",
    ChangeType.DELETED: "marker_deleted",
}


class RemoteFileTree(QTreeWidget):
    """远程文件浏览器。"""

    fileActivated = Signal(str)
    directoryExpandRequested = Signal(str)
    refreshRequested = Signal(str)
    createFileRequested = Signal(str)
    createDirectoryRequested = Signal(str)
    renameRequested = Signal(str)
    deleteRequested = Signal(str)
    propertiesRequested = Signal(str)
    copyPathRequested = Signal(str)

    def __init__(
        self, parent: Optional[QWidget] = None, *, theme: Optional[Theme] = None
    ) -> None:
        super().__init__(parent)
        self._theme = theme
        self._status: Optional[TreeStatus] = None
        # 单列（VSCode 式）：只显示名称，其余信息进 Tooltip，名称永远不会被挤没
        self.setColumnCount(1)
        self.setHeaderHidden(True)
        self.setIndentation(14)
        self.setIconSize(QSize(16, 16))
        # 所有行等高：大目录（数千项）下列表布局不必逐行算 sizeHint，展开明显更快
        self.setUniformRowHeights(True)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        # 变更徽标由委托绘制在行右端（图形而非文字，长文件名挤不掉它）
        self.setItemDelegate(BadgeDelegate(self))
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._show_context_menu)
        self.itemExpanded.connect(self._on_expanded)
        # 文件夹展开 / 收起时换用主题里的「打开 / 关闭」图标
        self.itemExpanded.connect(lambda item: self._refresh_icon(item))
        self.itemCollapsed.connect(lambda item: self._refresh_icon(item))
        self.itemDoubleClicked.connect(self._on_double_clicked)
        self._icon_theme: Optional[FileIconTheme] = None
        self._icon_dir = self.style().standardIcon(QStyle.StandardPixmap.SP_DirIcon)
        self._icon_file = self.style().standardIcon(QStyle.StandardPixmap.SP_FileIcon)

    # -- 主题 / Git 状态 ----------------------------------------------------
    def apply_theme(self, theme: Theme) -> None:
        """切换主题后重新着色（颜色只来自 :mod:`app.ui.theme`）。"""
        self._theme = theme
        self._recolor_items()

    def set_icon_theme(self, icon_theme: Optional[FileIconTheme]) -> None:
        """切换文件图标主题；``None`` 表示回退到系统图标。"""
        self._icon_theme = icon_theme
        self._refresh_icons()

    def _icon_for(self, name: str, *, is_dir: bool, expanded: bool = False) -> QIcon:
        if self._icon_theme is not None:
            icon = self._icon_theme.icon_for(name, is_dir=is_dir, expanded=expanded)
            if icon is not None:
                return icon
        return self._icon_dir if is_dir else self._icon_file

    def _refresh_icons(self) -> None:
        stack = [self.topLevelItem(index) for index in range(self.topLevelItemCount())]
        while stack:
            item = stack.pop()
            if item is None:
                continue
            self._refresh_icon(item)
            stack.extend(item.child(index) for index in range(item.childCount()))

    def _refresh_icon(self, item: QTreeWidgetItem) -> None:
        name = item.text(0)
        if not name or not item.data(0, PATH_ROLE):
            return  # 占位行（加载中 / 出错）不配图标
        is_dir = bool(item.data(0, DIR_ROLE))
        item.setIcon(0, self._icon_for(name, is_dir=is_dir, expanded=item.isExpanded()))

    def set_status_snapshot(self, status: Optional[TreeStatus]) -> None:
        """应用整棵文件树的 Git 状态快照；``None`` 表示清除着色。

        目录是懒加载的，快照更新时已展开的节点重新着色，之后新列出的子节点
        在 :meth:`_make_item` 里直接套用同一份快照。
        """
        self._status = status
        self._recolor_items()

    def refresh_status(self) -> None:
        """按当前快照重新着色（快照被就地更新后调用）。"""
        self._recolor_items()

    def status_snapshot(self) -> Optional[TreeStatus]:
        return self._status

    def is_directory(self, path: str) -> bool:
        """路径在当前树里是否是一个目录节点（用于判断右键目标）。"""
        item = self._find_item(path)
        return bool(item is not None and item.data(0, DIR_ROLE))

    def change_for(self, path: str, *, is_dir: bool = False) -> Optional[ChangeType]:
        if self._status is None:
            return None
        return self._status.change_for(path, is_dir=is_dir)

    def _color_for(self, change: Optional[ChangeType]) -> Optional[QColor]:
        if change is None or self._theme is None:
            return None
        attribute = _CHANGE_COLOR_ATTRIBUTE.get(change)
        return self._theme.color(attribute) if attribute else None

    def _recolor_items(self) -> None:
        stack = [self.topLevelItem(index) for index in range(self.topLevelItemCount())]
        while stack:
            item = stack.pop()
            if item is None:
                continue
            self._apply_status(item)
            stack.extend(item.child(index) for index in range(item.childCount()))

    def _apply_status(self, item: QTreeWidgetItem) -> None:
        path = item.data(0, PATH_ROLE)
        if not path:
            return
        is_dir = bool(item.data(0, DIR_ROLE))
        change = self.change_for(path, is_dir=is_dir)
        item.setData(0, CHANGE_ROLE, change.value if change else "")
        color = self._color_for(change)
        letter = "" if is_dir or self._status is None else self._status.letter_for(path)
        item.setData(0, BADGE_ROLE, letter)
        item.setData(0, BADGE_COLOR_ROLE, color)
        if color is None:
            # 显式清空前景色，让未变更的节点回到默认调色板颜色
            item.setData(0, Qt.ItemDataRole.ForegroundRole, None)
        else:
            item.setForeground(0, QBrush(color))
        self._refresh_tooltip(item, path, change)

    def _refresh_tooltip(
        self, item: QTreeWidgetItem, path: str, change: Optional[ChangeType]
    ) -> None:
        base = item.data(0, TOOLTIP_ROLE) or ""
        if change is None:
            item.setToolTip(0, base)
            return
        status = self._status.file_status(path) if self._status else None
        label = status.label if status is not None and status.label != "未变更" else change.label
        letter = self._status.letter_for(path) if self._status else ""
        suffix = f" [{letter}]" if letter else ""
        item.setToolTip(0, f"{base}\nGit: {label}{suffix}")

    # -- 根节点 ------------------------------------------------------------
    def set_root(self, path: str) -> QTreeWidgetItem:
        """设置工作目录根节点。"""
        self.clear()
        item = self._make_item(
            RemoteEntry(name=path.rstrip("/").rsplit("/", 1)[-1] or path, path=path, is_dir=True)
        )
        # 根节点的列举由调用方紧接着发起：先标成「已请求」，避免 setExpanded
        # 再触发一次 directoryExpandRequested，把同一条目录列两遍（高延迟下白白多花 3 秒）
        item.setData(0, LOADED_ROLE, True)
        item.setExpanded(True)
        self.addTopLevelItem(item)
        return item

    # -- 填充 --------------------------------------------------------------
    def set_children(self, path: str, entries: List[RemoteEntry]) -> None:
        """填充某个目录的子节点（由主窗口在异步列目录完成后调用）。"""
        item = self._find_item(path)
        if item is None and self.topLevelItemCount() == 0:
            item = self.set_root(path)
        if item is None:
            return
        self._clear_children(item)
        for entry in self._sorted_entries(entries):
            item.addChild(self._make_item(entry))
        item.setData(0, LOADED_ROLE, True)
        item.setExpanded(True)

    @staticmethod
    def _sorted_entries(entries: List[RemoteEntry]) -> List[RemoteEntry]:
        """目录在前、然后按名称排序（与 VSCode 资源管理器一致）。

        SFTP 返回的顺序由服务端 readdir 决定，不排序时每次刷新顺序都可能变化。
        """
        return sorted(
            entries, key=lambda entry: (not entry.is_dir, entry.name.lower(), entry.name)
        )

    def mark_loading(self, path: str) -> None:
        item = self._find_item(path)
        if item is not None:
            self._clear_children(item)
            placeholder = self._placeholder("加载中…")
            item.addChild(placeholder)

    def mark_failed(self, path: str, message: str) -> None:
        item = self._find_item(path)
        if item is None:
            return
        self._clear_children(item)
        placeholder = self._placeholder(message)
        placeholder.setForeground(0, self.palette().windowText())
        item.addChild(placeholder)
        item.setExpanded(True)

    # -- 查询 --------------------------------------------------------------
    def current_path(self) -> Optional[str]:
        item = self.currentItem()
        return item.data(0, PATH_ROLE) if item is not None else None

    def selected_paths(self) -> List[str]:
        return [
            item.data(0, PATH_ROLE)
            for item in self.selectedItems()
            if item.data(0, PATH_ROLE)
        ]

    def _find_item(self, path: str) -> Optional[QTreeWidgetItem]:
        stack = [self.topLevelItem(index) for index in range(self.topLevelItemCount())]
        while stack:
            item = stack.pop()
            if item is None:
                continue
            if item.data(0, PATH_ROLE) == path:
                return item
            stack.extend(item.child(index) for index in range(item.childCount()))
        return None

    @staticmethod
    def _clear_children(item: QTreeWidgetItem) -> None:
        for child in item.takeChildren():
            del child

    @staticmethod
    def _placeholder(text: str = "") -> QTreeWidgetItem:
        """占位行（加载中 / 失败 / 让目录显示展开箭头）。"""
        item = QTreeWidgetItem([text])
        item.setSizeHint(0, QSize(0, ROW_HEIGHT))
        return item

    def _make_item(self, entry: RemoteEntry) -> QTreeWidgetItem:
        item = QTreeWidgetItem([entry.name])
        item.setSizeHint(0, QSize(0, ROW_HEIGHT))
        item.setData(0, PATH_ROLE, entry.path)
        item.setData(0, DIR_ROLE, entry.is_dir)
        item.setData(0, LOADED_ROLE, False)
        item.setIcon(0, self._icon_for(entry.name, is_dir=entry.is_dir))
        item.setTextAlignment(0, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        item.setData(
            0,
            TOOLTIP_ROLE,
            f"{entry.path}\n类型: {entry.kind_label}\n大小: {entry.size_label}\n"
            f"修改时间: {entry.mtime_label}\n权限: {entry.permission_label}",
        )
        self._apply_status(item)
        if entry.is_dir:
            item.addChild(self._placeholder())
        return item

    # -- 交互 --------------------------------------------------------------
    def _on_expanded(self, item: QTreeWidgetItem) -> None:
        path = item.data(0, PATH_ROLE)
        is_dir = item.data(0, DIR_ROLE)
        loaded = item.data(0, LOADED_ROLE)
        if not path or not is_dir or loaded:
            return
        item.setData(0, LOADED_ROLE, True)
        self.directoryExpandRequested.emit(path)

    def _on_double_clicked(self, item: QTreeWidgetItem, _column: int) -> None:
        path = item.data(0, PATH_ROLE)
        if not path:
            return
        if item.data(0, DIR_ROLE):
            item.setExpanded(not item.isExpanded())
            return
        self.fileActivated.emit(path)

    def _show_context_menu(self, position) -> None:
        item = self.itemAt(position)
        path = item.data(0, PATH_ROLE) if item is not None else None
        is_dir = bool(item.data(0, DIR_ROLE)) if item is not None else True

        menu = QMenu(self)
        if item is not None and not is_dir:
            open_action = QAction("打开", self)
            open_action.triggered.connect(lambda: self.fileActivated.emit(path))
            menu.addAction(open_action)
            menu.addSeparator()

        target_dir = path if (item is not None and is_dir) else (
            posixpath.dirname(path) if path else None
        )
        if path and is_dir:
            refresh = QAction("刷新", self)
            refresh.triggered.connect(lambda: self.refreshRequested.emit(path))
            menu.addAction(refresh)
            new_file = QAction("新建文件", self)
            new_file.triggered.connect(lambda: self.createFileRequested.emit(path))
            menu.addAction(new_file)
            new_folder = QAction("新建文件夹", self)
            new_folder.triggered.connect(lambda: self.createDirectoryRequested.emit(path))
            menu.addAction(new_folder)
            menu.addSeparator()

        if path:
            rename = QAction("重命名", self)
            rename.triggered.connect(lambda: self.renameRequested.emit(path))
            menu.addAction(rename)
            delete = QAction("删除", self)
            delete.triggered.connect(lambda: self.deleteRequested.emit(path))
            menu.addAction(delete)
            menu.addSeparator()
            copy_path = QAction("复制路径", self)
            copy_path.triggered.connect(lambda: self.copyPathRequested.emit(path))
            menu.addAction(copy_path)
            info = QAction("属性", self)
            info.triggered.connect(lambda: self.propertiesRequested.emit(path))
            menu.addAction(info)

        if target_dir:
            menu.addSeparator()
            root_refresh = QAction("刷新工作目录", self)
            root_refresh.triggered.connect(lambda: self.refreshRequested.emit(""))
            menu.addAction(root_refresh)

        if not menu.isEmpty():
            menu.exec(self.viewport().mapToGlobal(position))
