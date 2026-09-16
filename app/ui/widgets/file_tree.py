"""远程文件树控件。

只负责展示与交互，所有实际的文件操作通过信号交给主窗口（解耦，便于测试）。
目录采用懒加载：展开时才请求子节点，避免一次性遍历整个远程目录。
"""

from __future__ import annotations

import posixpath
from typing import List, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QAbstractItemView,
    QHeaderView,
    QMenu,
    QStyle,
    QTreeWidget,
    QTreeWidgetItem,
    QWidget,
)

from app.remote.sftp_client import RemoteEntry

PATH_ROLE = Qt.ItemDataRole.UserRole
DIR_ROLE = Qt.ItemDataRole.UserRole + 1
LOADED_ROLE = Qt.ItemDataRole.UserRole + 2


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

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setColumnCount(3)
        self.setHeaderLabels(["名称", "大小", "修改时间"])
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._show_context_menu)
        self.itemExpanded.connect(self._on_expanded)
        self.itemDoubleClicked.connect(self._on_double_clicked)
        header = self.header()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self._icon_dir = self.style().standardIcon(QStyle.StandardPixmap.SP_DirIcon)
        self._icon_file = self.style().standardIcon(QStyle.StandardPixmap.SP_FileIcon)

    # -- 根节点 ------------------------------------------------------------
    def set_root(self, path: str) -> QTreeWidgetItem:
        """设置工作目录根节点。"""
        self.clear()
        item = self._make_item(
            RemoteEntry(name=path.rstrip("/").rsplit("/", 1)[-1] or path, path=path, is_dir=True)
        )
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
        for entry in entries:
            item.addChild(self._make_item(entry))
        item.setData(0, LOADED_ROLE, True)
        item.setExpanded(True)

    def mark_loading(self, path: str) -> None:
        item = self._find_item(path)
        if item is not None:
            self._clear_children(item)
            placeholder = QTreeWidgetItem(["加载中…", "", ""])
            item.addChild(placeholder)

    def mark_failed(self, path: str, message: str) -> None:
        item = self._find_item(path)
        if item is None:
            return
        self._clear_children(item)
        placeholder = QTreeWidgetItem([message, "", ""])
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

    def _make_item(self, entry: RemoteEntry) -> QTreeWidgetItem:
        item = QTreeWidgetItem([entry.name, entry.size_label, entry.mtime_label])
        item.setData(0, PATH_ROLE, entry.path)
        item.setData(0, DIR_ROLE, entry.is_dir)
        item.setData(0, LOADED_ROLE, False)
        item.setIcon(0, self._icon_dir if entry.is_dir else self._icon_file)
        item.setToolTip(
            0,
            f"{entry.path}\n类型: {entry.kind_label}\n大小: {entry.size_label}\n"
            f"修改时间: {entry.mtime_label}\n权限: {entry.permission_label}",
        )
        if entry.is_dir:
            item.addChild(QTreeWidgetItem(["", "", ""]))
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
