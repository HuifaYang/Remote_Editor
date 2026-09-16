"""代码编辑器控件。

包含：行号区、当前行高亮、自动缩进、Tab/空格、搜索替换、Git Gutter 着色。
网络与文件操作不在此处，编辑器只负责“文本 + 显示”。
"""

from __future__ import annotations

import logging
from typing import Dict, Optional

from PySide6.QtCore import QRect, QRegularExpression, QRegularExpressionMatch, QSize, Qt, Signal
from PySide6.QtGui import (
    QFont,
    QFontMetricsF,
    QKeyEvent,
    QPainter,
    QTextCursor,
    QTextDocument,
    QTextFormat,
    QTextOption,
)
from PySide6.QtWidgets import QPlainTextEdit, QTextEdit, QWidget

from app.config.settings import AppSettings
from app.editor.git_decorations import DecorationStyle, GitGutterDecorator
from app.editor.syntax import SyntaxHighlighter
from app.git.models import ChangeType
from app.ui.theme import Theme, monospace_font

logger = logging.getLogger(__name__)

GUTTER_PADDING = 8
MARKER_COLUMN = 6


class LineNumberArea(QWidget):
    """行号 + Git 标记区域。"""

    def __init__(self, editor: "CodeEditor") -> None:
        super().__init__(editor)
        self._editor = editor

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt 命名
        return QSize(self._editor.gutter_width(), 0)

    def paintEvent(self, event) -> None:  # noqa: N802
        self._editor.paint_gutter(event)


class CodeEditor(QPlainTextEdit):
    """QPlainTextEdit 的增强版。"""

    cursorMoved = Signal(int, int)
    saveRequested = Signal()

    def __init__(
        self,
        theme: Theme,
        settings: Optional[AppSettings] = None,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self._theme = theme
        self._settings = settings or AppSettings()

        self._gutter = LineNumberArea(self)
        self._decorator = GitGutterDecorator(DecorationStyle.from_theme(theme))
        self._marker_lines = 0

        self._font = monospace_font(self._settings.font_size, self._settings.font_family)
        self._apply_font()
        self.setLineWrapMode(
            QPlainTextEdit.LineWrapMode.WidgetWidth
            if self._settings.word_wrap
            else QPlainTextEdit.LineWrapMode.NoWrap
        )
        self.setTabChangesFocus(False)
        self.setCursorWidth(2)
        self.setWordWrapMode(
            QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere
            if self._settings.word_wrap
            else QTextOption.WrapMode.NoWrap
        )

        self._highlighter = SyntaxHighlighter(self.document(), theme, self._font)
        self._highlighter.set_language("Plain Text")

        self.blockCountChanged.connect(self._update_gutter_width)
        self.updateRequest.connect(self._on_update_request)
        self.cursorPositionChanged.connect(self._on_cursor_changed)
        self.document().modificationChanged.connect(lambda _dirty: self._schedule_highlight())

        self._highlight_current_line()
        self._update_gutter_width()

    # -- 配置 --------------------------------------------------------------
    @property
    def theme(self) -> Theme:
        return self._theme

    def set_theme(self, theme: Theme) -> None:
        self._theme = theme
        self._decorator.set_style(DecorationStyle.from_theme(theme))
        self._highlighter.set_theme(theme)
        self._highlight_current_line()
        self._gutter.update()
        self.viewport().update()

    def apply_settings(self, settings: AppSettings) -> None:
        self._settings = settings
        self._font = monospace_font(settings.font_size, settings.font_family)
        self._apply_font()
        self._highlighter.set_font(self._font)
        self.setLineWrapMode(
            QPlainTextEdit.LineWrapMode.WidgetWidth
            if settings.word_wrap
            else QPlainTextEdit.LineWrapMode.NoWrap
        )
        self._update_gutter_width()
        self._highlight_current_line()

    def _apply_font(self) -> None:
        self.setFont(self._font)
        self.document().setDefaultFont(self._font)
        space_width = QFontMetricsF(self._font).horizontalAdvance(" ")
        self.setTabStopDistance(max(space_width, 1.0) * max(self._settings.tab_size, 1))
        self._update_gutter_width()

    # -- 语言 / 标记 -------------------------------------------------------
    def set_language(self, language: str) -> None:
        self._highlighter.set_language(language)

    @property
    def language(self) -> str:
        return self._highlighter.language

    def set_markers(self, markers: Optional[Dict[int, ChangeType]]) -> None:
        self._decorator.set_markers(markers)
        self._gutter.update()
        self.viewport().update()

    def clear_markers(self) -> None:
        self._decorator.clear()
        self._gutter.update()

    @property
    def decorator(self) -> GitGutterDecorator:
        return self._decorator

    def marker_counts(self) -> Dict[ChangeType, int]:
        return self._decorator.counts()

    # -- 光标 --------------------------------------------------------------
    def current_line_number(self) -> int:
        return self.textCursor().blockNumber() + 1

    def current_column(self) -> int:
        return self.textCursor().positionInBlock() + 1

    def go_to_line(self, line: int, *, column: int = 1) -> None:
        block = self.document().findBlockByNumber(max(line - 1, 0))
        if not block.isValid():
            return
        cursor = QTextCursor(block)
        cursor.movePosition(
            QTextCursor.MoveOperation.Right, QTextCursor.MoveMode.MoveAnchor, max(column - 1, 0)
        )
        self.setTextCursor(cursor)
        self.centerCursor()

    # -- 内容 --------------------------------------------------------------
    def set_plain_text_silent(self, text: str, *, language: Optional[str] = None) -> None:
        """载入文本并重置撤销栈（加载文件时使用）。"""
        self.setPlainText(text)
        self.document().setModified(False)
        if language is not None:
            self.set_language(language)
        self._highlighter.invalidate()
        self._highlight_current_line()

    def text_value(self) -> str:
        return self.toPlainText()

    # -- 搜索 / 替换 -------------------------------------------------------
    def _search_flags(self, case_sensitive: bool) -> QTextDocument.FindFlag:
        flags = QTextDocument.FindFlag(0)
        if case_sensitive:
            flags |= QTextDocument.FindFlag.FindCaseSensitively
        return flags

    def _expression(self, pattern: str, *, case_sensitive: bool) -> QRegularExpression:
        """构造正则表达式（Qt6 的 regex 搜索走 QRegularExpression 重载）。"""
        options = QRegularExpression.PatternOption(0)
        if not case_sensitive:
            options |= QRegularExpression.PatternOption.CaseInsensitiveOption
        expression = QRegularExpression(pattern)
        expression.setPatternOptions(options)
        if not expression.isValid():
            raise ValueError(f"无效的正则表达式：{expression.errorString()}")
        return expression

    def _target(self, pattern: str, *, case_sensitive: bool, regex: bool):
        return self._expression(pattern, case_sensitive=case_sensitive) if regex else pattern

    @staticmethod
    def _expand_match(match: "QRegularExpressionMatch", replacement: str) -> str:
        """展开替换串中的 ``\\1`` 反向引用。"""
        result = replacement
        for index in range(1, match.lastCapturedIndex() + 1):
            result = result.replace(f"\\{index}", match.captured(index))
        return result

    def find(self, pattern: str, *, forward: bool = True, case_sensitive: bool = False,
             regex: bool = False, wrap: bool = True) -> bool:
        """查找下一个/上一个；命中返回 ``True``。"""
        if not pattern:
            return False
        target = self._target(pattern, case_sensitive=case_sensitive, regex=regex)
        flags = self._search_flags(case_sensitive)
        if not forward:
            flags |= QTextDocument.FindFlag.FindBackward

        found = self.document().find(target, self.textCursor(), flags)
        if found.isNull() and wrap:
            start = QTextCursor(self.document())
            start.movePosition(
                QTextCursor.MoveOperation.End if not forward else QTextCursor.MoveOperation.Start
            )
            found = self.document().find(target, start, flags)
        if found.isNull():
            return False
        self.setTextCursor(found)
        return True

    def find_next(self, pattern: str, *, case_sensitive: bool = False, regex: bool = False) -> bool:
        return self.find(pattern, forward=True, case_sensitive=case_sensitive, regex=regex)

    def find_previous(self, pattern: str, *, case_sensitive: bool = False, regex: bool = False) -> bool:
        return self.find(pattern, forward=False, case_sensitive=case_sensitive, regex=regex)

    def replace_current(self, pattern: str, replacement: str, *,
                        case_sensitive: bool = False, regex: bool = False) -> bool:
        """替换当前选中项（若未选中则先查找一处）。"""
        cursor = self.textCursor()
        if not cursor.hasSelection():
            if not self.find_next(pattern, case_sensitive=case_sensitive, regex=regex):
                return False
            cursor = self.textCursor()
        selected = cursor.selectedText().replace("\u2029", "\n")
        if regex:
            expression = self._expression(pattern, case_sensitive=case_sensitive)
            match = expression.match(selected)
            if match.hasMatch() and match.capturedStart() == 0 and match.capturedEnd() == len(selected):
                new_text = self._expand_match(match, replacement)
            else:
                if not self.find_next(pattern, case_sensitive=case_sensitive, regex=True):
                    return False
                return self.replace_current(
                    pattern, replacement, case_sensitive=case_sensitive, regex=True
                )
        else:
            matched = (
                selected == pattern
                if case_sensitive
                else selected.lower() == pattern.lower()
            )
            if not matched:
                if not self.find_next(pattern, case_sensitive=case_sensitive):
                    return False
                return self.replace_current(pattern, replacement, case_sensitive=case_sensitive)
            new_text = replacement
        cursor.insertText(new_text)
        self.setTextCursor(cursor)
        return True

    def replace_all(self, pattern: str, replacement: str, *,
                    case_sensitive: bool = False, regex: bool = False) -> int:
        """全部替换，返回替换次数。"""
        if not pattern:
            return 0
        if regex:
            return self._replace_all_regex(pattern, replacement, case_sensitive=case_sensitive)
        flags = self._search_flags(case_sensitive)
        cursor = QTextCursor(self.document())
        count = 0
        while True:
            found = self.document().find(pattern, cursor, flags)
            if found.isNull():
                break
            cursor = found
            cursor.insertText(replacement)
            count += 1
            if cursor.atEnd():
                break
        return count

    def count_matches(self, pattern: str, *, case_sensitive: bool = False, regex: bool = False) -> int:
        if not pattern:
            return 0
        target = self._target(pattern, case_sensitive=case_sensitive, regex=regex)
        flags = self._search_flags(case_sensitive)
        cursor = QTextCursor(self.document())
        count = 0
        while True:
            found = self.document().find(target, cursor, flags)
            if found.isNull():
                break
            cursor = found
            count += 1
            if cursor.atEnd():
                break
        return count

    def _replace_all_regex(
        self, pattern: str, replacement: str, *, case_sensitive: bool
    ) -> int:
        """正则全部替换（基于绝对偏移，支持 ``\\1`` 反向引用）。"""
        expression = self._expression(pattern, case_sensitive=case_sensitive)
        document = self.document()
        cursor = QTextCursor(document)
        cursor.beginEditBlock()
        count = 0
        offset = 0
        text = document.toPlainText()
        while count < 100_000:
            match = expression.match(text, offset)
            if not match.hasMatch():
                break
            start, end = match.capturedStart(), match.capturedEnd()
            if end == start:  # 空匹配：避免死循环
                offset = end + 1
                if offset >= len(text):
                    break
                continue
            new_text = self._expand_match(match, replacement)
            target_cursor = QTextCursor(document)
            target_cursor.setPosition(start)
            target_cursor.setPosition(end, QTextCursor.MoveMode.KeepAnchor)
            target_cursor.insertText(new_text)
            count += 1
            text = document.toPlainText()
            offset = start + len(new_text)
        cursor.endEditBlock()
        return count

    # -- 行号区绘制 --------------------------------------------------------
    def gutter_width(self) -> int:
        digits = max(len(str(self.blockCount())), 3)
        return MARKER_COLUMN + GUTTER_PADDING + self.fontMetrics().horizontalAdvance("9") * digits

    def paint_gutter(self, event) -> None:
        painter = QPainter(self._gutter)
        painter.fillRect(event.rect(), self._theme.color("gutter_bg"))
        font = QFont(self._font)
        painter.setFont(font)

        block = self.firstVisibleBlock()
        block_number = block.blockNumber()
        offset = self.contentOffset()
        top = int(self.blockBoundingGeometry(block).translated(offset).top())
        bottom = top + int(self.blockBoundingRect(block).height())
        gutter_width = self._gutter.width()
        text_right = gutter_width - GUTTER_PADDING

        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible() and bottom >= event.rect().top():
                line = block_number + 1
                change = self._decorator.change_for_line(line)
                cell = QRect(0, top, gutter_width, max(int(self.blockBoundingRect(block).height()), 1))
                self._decorator.paint_line(painter, cell, change)
                color = self._theme.color("gutter_fg")
                if change is not None:
                    color = self._decorator.style.color_for(change)
                    color.setAlpha(230)
                painter.setPen(color)
                painter.drawText(
                    0,
                    top,
                    text_right,
                    int(self.blockBoundingRect(block).height()),
                    int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter),
                    str(line),
                )
            block = block.next()
            top = bottom
            bottom = top + int(self.blockBoundingRect(block).height())
            block_number += 1

    def _update_gutter_width(self, _count: int = 0) -> None:
        self.setViewportMargins(self.gutter_width(), 0, 0, 0)

    def _on_update_request(self, rect, dy: int) -> None:
        if dy:
            self._gutter.scroll(0, dy)
        else:
            self._gutter.update(0, rect.y(), self._gutter.width(), rect.height())
        if rect.contains(self.viewport().rect()):
            self._update_gutter_width()

    def _on_cursor_changed(self) -> None:
        self._highlight_current_line()
        self.cursorMoved.emit(self.current_line_number(), self.current_column())

    def _schedule_highlight(self) -> None:
        self._highlighter.invalidate()

    def _highlight_current_line(self) -> None:
        selections: list[QTextEdit.ExtraSelection] = []
        if self._settings.highlight_current_line and not self.isReadOnly():
            selection = QTextEdit.ExtraSelection()
            selection.format.setBackground(self._theme.color("current_line"))
            selection.format.setProperty(QTextFormat.Property.FullWidthSelection, True)
            selection.cursor = self.textCursor()
            selection.cursor.clearSelection()
            selections.append(selection)
        self.setExtraSelections(selections)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        rect = self.contentsRect()
        self._gutter.setGeometry(
            QRect(rect.left(), rect.top(), self.gutter_width(), rect.height())
        )

    # -- 缩进 / 快捷键 -----------------------------------------------------
    def _indent_unit(self) -> str:
        if self._settings.use_spaces:
            return " " * max(self._settings.tab_size, 1)
        return "\t"

    def _leading_whitespace(self, text: str) -> str:
        return text[: len(text) - len(text.lstrip(" \t"))]

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802
        key = event.key()
        modifiers = event.modifiers()
        shift = bool(modifiers & Qt.KeyboardModifier.ShiftModifier)
        control = bool(modifiers & Qt.KeyboardModifier.ControlModifier)

        if key in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and not control:
            if self._auto_indent():
                return
        if key == Qt.Key.Key_Tab and not control:
            if self._indent_selection(reverse=False):
                return
        if key == Qt.Key.Key_Backtab or (key == Qt.Key.Key_Tab and shift):
            if self._indent_selection(reverse=True):
                return
        super().keyPressEvent(event)

    def _auto_indent(self) -> bool:
        cursor = self.textCursor()
        if cursor.hasSelection():
            return False
        block_text = cursor.block().text()
        indent = self._leading_whitespace(block_text)
        stripped = block_text.rstrip()
        extra = ""
        if stripped.endswith(("{", "(", "[")):
            extra = self._indent_unit()
        elif self.language == "Python" and stripped.endswith(":"):
            extra = self._indent_unit()
        cursor.insertText("\n" + indent + extra)
        return True

    def _indent_selection(self, *, reverse: bool) -> bool:
        cursor = self.textCursor()
        if not cursor.hasSelection():
            if reverse:
                return False
            # 插入到下一个制表位
            if self._settings.use_spaces:
                column = cursor.positionInBlock()
                size = max(self._settings.tab_size, 1)
                spaces = size - (column % size)
                cursor.insertText(" " * spaces)
            else:
                cursor.insertText("\t")
            return True

        start = cursor.selectionStart()
        end = cursor.selectionEnd()
        cursor.beginEditBlock()
        cursor.setPosition(start)
        cursor.movePosition(QTextCursor.MoveOperation.StartOfBlock)
        unit = self._indent_unit()
        while True:
            if reverse:
                cursor.movePosition(QTextCursor.MoveOperation.StartOfBlock)
                line_text = cursor.block().text()
                if line_text.startswith("\t"):
                    cursor.deleteChar()
                else:
                    remove = min(len(line_text) - len(line_text.lstrip(" ")), max(self._settings.tab_size, 1))
                    for _ in range(remove):
                        cursor.deleteChar()
            else:
                cursor.insertText(unit)
            if cursor.block().position() >= end or not cursor.movePosition(
                QTextCursor.MoveOperation.NextBlock
            ):
                break
        cursor.endEditBlock()
        return True
