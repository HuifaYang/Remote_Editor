"""多标签编辑器容器。

把 :class:`Document`（数据）与 :class:`CodeEditor`（视图）绑定在一起，
并提供“按路径复用标签”“未保存标记”“光标位置”等能力。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QTabWidget, QVBoxLayout, QWidget

from app.config.settings import AppSettings
from app.editor.document import Document
from app.editor.editor import CodeEditor
from app.git.models import ChangeType
from app.ui.theme import Theme


@dataclass
class EditorTab:
    """标签页内的文档 + 编辑器组合。"""

    document: Document
    editor: CodeEditor

    @property
    def remote_path(self) -> str:
        return self.document.remote_path


class EditorTabs(QTabWidget):
    """打开的远程文件集合。"""

    documentActivated = Signal(object)  # Document | None
    documentDirtyChanged = Signal(object, bool)
    saveRequested = Signal(object)
    closeDocumentRequested = Signal(object)
    cursorMoved = Signal(int, int)
    markersChanged = Signal(object, object)  # Document, Dict[int, ChangeType]

    def __init__(
        self,
        theme: Theme,
        settings: AppSettings,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self._theme = theme
        self._settings = settings
        self.setTabsClosable(True)
        self.setMovable(True)
        self.setDocumentMode(True)
        self.tabCloseRequested.connect(self._on_tab_close_requested)
        self.currentChanged.connect(self._on_current_changed)

    # -- 配置 --------------------------------------------------------------
    def apply_theme(self, theme: Theme) -> None:
        self._theme = theme
        for tab in self._tabs():
            tab.editor.set_theme(theme)

    def apply_settings(self, settings: AppSettings) -> None:
        self._settings = settings
        for tab in self._tabs():
            tab.editor.apply_settings(settings)

    # -- 查询 --------------------------------------------------------------
    def _tabs(self) -> List[EditorTab]:
        tabs: List[EditorTab] = []
        for index in range(self.count()):
            stored = self.widget(index)
            tab = getattr(stored, "editor_tab", None)
            if tab is not None:
                tabs.append(tab)
        return tabs

    @property
    def open_documents(self) -> List[Document]:
        return [tab.document for tab in self._tabs()]

    def current_tab(self) -> Optional[EditorTab]:
        widget = self.currentWidget()
        return getattr(widget, "editor_tab", None) if widget is not None else None

    def current_document(self) -> Optional[Document]:
        tab = self.current_tab()
        return tab.document if tab else None

    def current_editor(self) -> Optional[CodeEditor]:
        tab = self.current_tab()
        return tab.editor if tab else None

    def index_of_path(self, path: str) -> int:
        for index, tab in enumerate(self._tabs()):
            if tab.remote_path == path:
                return index
        return -1

    def tab_at(self, index: int) -> Optional[EditorTab]:
        if 0 <= index < self.count():
            return getattr(self.widget(index), "editor_tab", None)
        return None

    def document_for_path(self, path: str) -> Optional[Document]:
        index = self.index_of_path(path)
        tab = self.tab_at(index)
        return tab.document if tab else None

    def editor_for_path(self, path: str) -> Optional[CodeEditor]:
        tab = self.tab_at(self.index_of_path(path))
        return tab.editor if tab else None

    def activate_path(self, path: str) -> bool:
        index = self.index_of_path(path)
        if index < 0:
            return False
        self.setCurrentIndex(index)
        return True

    def dirty_documents(self) -> List[Document]:
        result: List[Document] = []
        for tab in self._tabs():
            if tab.editor.document().isModified():
                result.append(tab.document)
        return result

    # -- 打开 / 关闭 -------------------------------------------------------
    def add_document(self, document: Document, *, activate: bool = True) -> EditorTab:
        """新增或复用标签页。"""
        existing = self.index_of_path(document.remote_path)
        if existing >= 0:
            tab = self.tab_at(existing)
            if tab is not None:
                tab.document = document
                tab.editor.set_plain_text_silent(document.text, language=document.language)
                tab.editor.set_markers(document.diff.markers)
                self._update_title(existing, tab)
                if activate:
                    self.setCurrentIndex(existing)
                return tab

        editor = CodeEditor(self._theme, self._settings)
        editor.set_plain_text_silent(document.text, language=document.language)
        editor.set_markers(document.diff.markers)
        editor.setReadOnly(document.read_only)

        page = QWidget(self)
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(editor)

        tab = EditorTab(document=document, editor=editor)
        page.editor_tab = tab  # type: ignore[attr-defined]

        index = self.addTab(page, document.tab_title)
        self.setTabToolTip(index, document.remote_path or document.display_name)

        editor.cursorMoved.connect(self._on_editor_cursor)
        editor.document().modificationChanged.connect(
            lambda dirty, t=tab, i=index: self._on_modification_changed(t, dirty)
        )
        editor.saveRequested.connect(lambda t=tab: self.saveRequested.emit(t.document))

        if activate:
            self.setCurrentIndex(index)
        return tab

    def close_document(self, index: int) -> None:
        tab = self.tab_at(index)
        if tab is not None:
            self.closeDocumentRequested.emit(tab.document)
            return
        self.removeTab(index)

    def force_close(self, index: int) -> None:
        """忽略脏状态直接关闭（供主窗口在确认后调用）。"""
        tab = self.tab_at(index)
        self.blockSignals(True)
        self.removeTab(index)
        self.blockSignals(False)
        if tab is not None:
            tab.editor.deleteLater()
        self._on_current_changed(self.currentIndex() if self.count() else -1)

    def close_path(self, path: str) -> bool:
        index = self.index_of_path(path)
        if index < 0:
            return False
        self.force_close(index)
        return True

    # -- 内容 --------------------------------------------------------------
    def sync_text(self, document: Document) -> str:
        """把编辑器内容写回文档模型，并返回文本。"""
        editor = self.editor_for_path(document.remote_path)
        if editor is None:
            return document.text
        document.text = editor.text_value()
        return document.text

    def set_markers(self, document: Document, markers: Dict[int, ChangeType]) -> None:
        document.diff.markers = dict(markers)
        editor = self.editor_for_path(document.remote_path)
        if editor is not None:
            editor.set_markers(markers)
        self.markersChanged.emit(document, markers)

    def update_titles(self) -> None:
        for index, tab in enumerate(self._tabs()):
            self._update_title(index, tab)

    def _update_title(self, index: int, tab: EditorTab) -> None:
        dirty = tab.editor.document().isModified()
        self.setTabText(index, f"{tab.document.display_name}{'*' if dirty else ''}")
        self.setTabToolTip(index, tab.document.remote_path or tab.document.display_name)

    # -- 信号槽 ------------------------------------------------------------
    def _on_tab_close_requested(self, index: int) -> None:
        self.close_document(index)

    def _on_current_changed(self, index: int) -> None:
        tab = self.tab_at(index)
        if tab is None:
            self.documentActivated.emit(None)
            return
        self.documentActivated.emit(tab.document)
        self.cursorMoved.emit(tab.editor.current_line_number(), tab.editor.current_column())

    def _on_editor_cursor(self, line: int, column: int) -> None:
        tab = self.current_tab()
        if tab is None:
            return
        tab.document.cursor_line = line
        tab.document.cursor_column = column
        self.cursorMoved.emit(line, column)

    def _on_modification_changed(self, tab: EditorTab, dirty: bool) -> None:
        index = self._tab_index(tab)
        if index >= 0:
            self.setTabText(index, f"{tab.document.display_name}{'*' if dirty else ''}")
        self.documentDirtyChanged.emit(tab.document, dirty)

    def index_of_tab(self, tab: EditorTab) -> int:
        """返回标签页序号，不存在时返回 -1。"""
        return self._tab_index(tab)

    def indexOf_by_tab(self, tab: EditorTab) -> int:  # noqa: N802 - Qt 风格命名
        return self._tab_index(tab)

    def _tab_index(self, tab: EditorTab) -> int:
        for index in range(self.count()):
            if self.tab_at(index) is tab:
                return index
        return -1
