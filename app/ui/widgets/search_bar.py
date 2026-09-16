"""搜索 / 替换工具条（作用于当前激活的编辑器）。"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Signal
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QToolButton,
    QVBoxLayout,
    QWidget,
)


class SearchBar(QWidget):
    """查找与替换面板。"""

    searchRequested = Signal(str, bool, bool, bool)  # pattern, forward, case, regex
    replaceRequested = Signal(str, str, bool, bool)
    replaceAllRequested = Signal(str, str, bool, bool)
    closed = Signal()

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setVisible(False)

        self.search_edit = QLineEdit(self)
        self.search_edit.setPlaceholderText("查找")
        self.replace_edit = QLineEdit(self)
        self.replace_edit.setPlaceholderText("替换为")

        self.case_box = QCheckBox("区分大小写", self)
        self.regex_box = QCheckBox("正则", self)
        self.result_label = QLabel("", self)

        self.prev_button = QToolButton(self)
        self.prev_button.setText("↑")
        self.prev_button.setToolTip("上一个 (Shift+F3)")
        self.next_button = QToolButton(self)
        self.next_button.setText("↓")
        self.next_button.setToolTip("下一个 (F3)")
        self.replace_button = QPushButton("替换", self)
        self.replace_all_button = QPushButton("全部替换", self)
        self.toggle_replace_button = QToolButton(self)
        self.toggle_replace_button.setText("替换…")
        self.toggle_replace_button.setCheckable(True)
        self.close_button = QToolButton(self)
        self.close_button.setText("")
        self.close_button.setToolTip("关闭 (Esc)")

        top = QHBoxLayout()
        top.setContentsMargins(6, 4, 6, 0)
        top.addWidget(self.search_edit, 1)
        top.addWidget(self.result_label)
        top.addWidget(self.prev_button)
        top.addWidget(self.next_button)
        top.addWidget(self.case_box)
        top.addWidget(self.regex_box)
        top.addWidget(self.toggle_replace_button)
        top.addWidget(self.close_button)

        bottom = QHBoxLayout()
        bottom.setContentsMargins(6, 0, 6, 4)
        bottom.addWidget(self.replace_edit, 1)
        bottom.addWidget(self.replace_button)
        bottom.addWidget(self.replace_all_button)
        self._replace_row = bottom

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        layout.addLayout(top)
        layout.addLayout(bottom)
        self._set_replace_visible(False)

        self.search_edit.textChanged.connect(self._on_text_changed)
        self.search_edit.returnPressed.connect(lambda: self._emit_search(True))
        self.search_edit.textChanged.connect(lambda _t: None)
        self.prev_button.clicked.connect(lambda: self._emit_search(False))
        self.next_button.clicked.connect(lambda: self._emit_search(True))
        self.replace_button.clicked.connect(self._emit_replace)
        self.replace_all_button.clicked.connect(self._emit_replace_all)
        self.toggle_replace_button.toggled.connect(self._set_replace_visible)
        self.close_button.clicked.connect(self.close_bar)

        QShortcut(QKeySequence("Esc"), self, activated=self.close_bar)
        QShortcut(QKeySequence("F3"), self, activated=lambda: self._emit_search(True))
        QShortcut(QKeySequence("Shift+F3"), self, activated=lambda: self._emit_search(False))

    # -- 外部接口 ----------------------------------------------------------
    def activate(self, *, with_replace: bool = False) -> None:
        """显示面板并聚焦到搜索框，预填当前选中文本。"""
        self.setVisible(True)
        self.search_edit.setFocus()
        self.search_edit.selectAll()
        if with_replace:
            self.toggle_replace_button.setChecked(True)

    def close_bar(self) -> None:
        self.setVisible(False)
        self.closed.emit()

    def set_result(self, message: str) -> None:
        self.result_label.setText(message)

    def set_selection_prefill(self, text: str) -> None:
        if text and "\n" not in text:
            self.search_edit.setText(text)

    # -- 内部 --------------------------------------------------------------
    def _set_replace_visible(self, visible: bool) -> None:
        self.replace_edit.setVisible(visible)
        self.replace_button.setVisible(visible)
        self.replace_all_button.setVisible(visible)
        if visible:
            self.replace_edit.setFocus()

    def _on_text_changed(self, text: str) -> None:
        if not text:
            self.result_label.clear()

    def _emit_search(self, forward: bool) -> None:
        pattern = self.search_edit.text()
        if not pattern:
            return
        self.searchRequested.emit(
            pattern, forward, self.case_box.isChecked(), self.regex_box.isChecked()
        )

    def _emit_replace(self) -> None:
        self.replaceRequested.emit(
            self.search_edit.text(),
            self.replace_edit.text(),
            self.case_box.isChecked(),
            self.regex_box.isChecked(),
        )

    def _emit_replace_all(self) -> None:
        self.replaceAllRequested.emit(
            self.search_edit.text(),
            self.replace_edit.text(),
            self.case_box.isChecked(),
            self.regex_box.isChecked(),
        )
