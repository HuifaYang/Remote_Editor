"""多标签编辑器容器。

把 :class:`Document`（数据）与 :class:`CodeEditor`（视图）绑定在一起，
并提供“按路径复用标签”“未保存标记”“光标位置”等能力。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional

from PySide6.QtCore import QSize, Qt, QTimer, Signal
from PySide6.QtWidgets import (
    QSplitter,
    QTabBar,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from app.config.settings import AppSettings
from app.editor.document import Document
from app.editor.editor import CodeEditor
from app.git.models import ChangeType
from app.ui.icons import make_icon
from app.ui.theme import Theme
from app.ui.widgets.markdown_preview import MarkdownPreview

#: 标签页关闭按钮：Qt 自带的图形在深色主题下是红色小方块，自己画一个灰色的叉
CLOSE_BUTTON_SIZE = 16
CLOSE_ICON_SIZE = 12


@dataclass
class EditorTab:
    """标签页内的文档 + 编辑器组合（Markdown 文件额外带一个预览面板）。"""

    document: Document
    editor: CodeEditor
    #: Markdown 预览（仅 .md 文件有；``None`` 表示普通代码文件）
    preview: Optional["MarkdownPreview"] = None
    #: 编辑器 / 预览的分屏容器（显示预览时要重新分配宽度，见 toggle_markdown_preview）
    splitter: Optional[QSplitter] = None
    _preview_refresh: Optional[QTimer] = None

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
    #: 点击 gutter 变更标记：弹出「与上一版差异」预览（Document, 行号）
    peekRequested = Signal(object, int)

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
            if tab.preview is not None:
                tab.preview.apply_theme(theme)
        self._refresh_close_buttons()

    def _refresh_close_buttons(self) -> None:
        icon = make_icon("close", self._theme.color("gutter_fg"), size=CLOSE_ICON_SIZE)
        tab_bar = self.tabBar()
        for tab in self._tabs():
            button = tab_bar.tabButton(
                self._tab_index(tab), QTabBar.ButtonPosition.RightSide
            )
            if isinstance(button, QToolButton):
                button.setIcon(icon)

    def apply_settings(self, settings: AppSettings) -> None:
        self._settings = settings
        for tab in self._tabs():
            tab.editor.apply_settings(settings)
            if tab.preview is not None:
                # 预览字号与编辑器同源（设置字号 × 缩放），两边不会一大一小
                tab.preview.set_base_font_size(settings.font_size)

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

        tab = EditorTab(document=document, editor=editor)

        page = QWidget(self)
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 0, 0, 0)
        # Markdown 文件：编辑器 + 预览放进一个可拖动分屏（预览默认隐藏）
        if document.language == "Markdown":
            preview = MarkdownPreview(self._theme, page)
            preview.set_base_font_size(self._settings.font_size)
            preview.set_markdown(editor.text_value())
            preview.setVisible(False)
            splitter = QSplitter(Qt.Orientation.Horizontal, page)
            splitter.addWidget(editor)
            splitter.addWidget(preview)
            splitter.setStretchFactor(0, 1)
            splitter.setStretchFactor(1, 1)
            layout.addWidget(splitter)
            tab.preview = preview
            tab.splitter = splitter
            tab._preview_refresh = self._make_preview_refresh(editor, preview)
        else:
            layout.addWidget(editor)

        page.editor_tab = tab  # type: ignore[attr-defined]

        index = self.addTab(page, document.tab_title)
        self.setTabToolTip(index, document.remote_path or document.display_name)
        self.tabBar().setTabButton(
            index, QTabBar.ButtonPosition.RightSide, self._make_close_button(page)
        )

        editor.cursorMoved.connect(self._on_editor_cursor)
        editor.document().modificationChanged.connect(
            lambda dirty, t=tab, i=index: self._on_modification_changed(t, dirty)
        )
        editor.saveRequested.connect(lambda t=tab: self.saveRequested.emit(t.document))
        editor.changePeekRequested.connect(
            lambda line, t=tab: self.peekRequested.emit(t.document, line)
        )

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

    def _make_close_button(self, page: QWidget) -> QToolButton:
        """自绘关闭按钮（Qt 默认图形的红色方块和 VSCode 风格不搭）。"""
        button = QToolButton(self)
        button.setObjectName("tab_close")
        button.setAutoRaise(True)
        button.setFixedSize(CLOSE_BUTTON_SIZE, CLOSE_BUTTON_SIZE)
        button.setIconSize(QSize(CLOSE_ICON_SIZE, CLOSE_ICON_SIZE))
        button.setToolTip("关闭")
        button.setCursor(Qt.CursorShape.ArrowCursor)
        button.setIcon(make_icon("close", self._theme.color("gutter_fg"), size=CLOSE_ICON_SIZE))
        button.clicked.connect(lambda: self._request_close_page(page))
        return button

    def _request_close_page(self, page: QWidget) -> None:
        """按页面（而不是序号）找标签，避免标签拖动后关错文件。"""
        index = self.indexOf(page)
        if index >= 0:
            self.close_document(index)

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

    # -- Markdown 预览 ------------------------------------------------------
    def _make_preview_refresh(
        self, editor: CodeEditor, preview: MarkdownPreview
    ) -> QTimer:
        """编辑后 300ms 刷新预览（节流，避免敲一个字符就重渲一次）。"""
        timer = QTimer(self)
        timer.setSingleShot(True)
        timer.setInterval(300)
        timer.timeout.connect(lambda: preview.set_markdown(editor.text_value()))
        editor.textChanged.connect(lambda: timer.start() or None)
        return timer

    def toggle_markdown_preview(self, document: Document) -> bool:
        """切换当前标签页的 Markdown 预览显隐；非 Markdown 文件返回 ``False``。

        可见性用 ``isHidden()`` 判断（``isVisible()`` 在父窗口未 show 时不可靠，
        离屏测试里尤其明显）。
        """
        tab = self.tab_at(self.index_of_path(document.remote_path))
        if tab is None or tab.preview is None:
            return False
        show = tab.preview.isHidden()
        tab.preview.setVisible(show)
        if show:
            tab.preview.set_markdown(tab.editor.text_value())
            self._split_preview(tab)
        return show

    @staticmethod
    def _split_preview(tab: EditorTab) -> None:
        """把编辑区与预览对半分配宽度。

        ``QSplitter`` 不会在隐藏的 widget 重新显示时自动给它宽度 —— 直接
        ``setVisible(True)`` 会让预览停在 0 宽（看着像「预览没出来」），
        必须显式重新分配一次尺寸。
        """
        splitter = tab.splitter
        if splitter is None:
            return
        total = splitter.width() or sum(splitter.sizes())
        if total > 0:
            half = total // 2
            splitter.setSizes([half, total - half])
        else:  # 还没完成布局：交给 stretch factor 平分
            splitter.setSizes([1, 1])

    def is_markdown_preview_visible(self, document: Document) -> bool:
        tab = self.tab_at(self.index_of_path(document.remote_path))
        return bool(tab is not None and tab.preview is not None and not tab.preview.isHidden())

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
