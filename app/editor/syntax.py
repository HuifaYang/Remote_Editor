"""语法高亮（基于 Pygments，仅着色，不做任何语义分析 / LSP）。"""

from __future__ import annotations

import logging
import posixpath
from typing import Dict, List, Tuple

from pygments import lex
from pygments.lexers import get_lexer_by_name
from pygments.token import Token
from pygments.util import ClassNotFound
from PySide6.QtGui import QColor, QFont, QSyntaxHighlighter, QTextCharFormat

from app.ui.theme import Theme

logger = logging.getLogger(__name__)

#: 超过该字符数的文件不做高亮，避免大文件拖慢 UI（需求 5.12）
HIGHLIGHT_LIMIT = 1_500_000

#: 需求 5.6 要求至少支持的语言
SUPPORTED_LANGUAGES: Tuple[str, ...] = (
    "C",
    "C++",
    "Python",
    "Bash",
    "YAML",
    "JSON",
    "XML",
    "Markdown",
    "CMake",
)

_LEXER_BY_LANGUAGE: Dict[str, str] = {
    "C": "c",
    "C++": "cpp",
    "Python": "python",
    "Bash": "bash",
    "YAML": "yaml",
    "JSON": "json",
    "XML": "xml",
    "Markdown": "markdown",
    "CMake": "cmake",
    "Makefile": "make",
    "Plain Text": "text",
}

_EXTENSION_LANGUAGE: Dict[str, str] = {
    ".c": "C",
    ".h": "C",
    ".cc": "C++",
    ".cpp": "C++",
    ".cxx": "C++",
    ".hpp": "C++",
    ".hh": "C++",
    ".hxx": "C++",
    ".py": "Python",
    ".pyw": "Python",
    ".sh": "Bash",
    ".bash": "Bash",
    ".zsh": "Bash",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".json": "JSON",
    ".xml": "XML",
    ".html": "XML",
    ".htm": "XML",
    ".md": "Markdown",
    ".markdown": "Markdown",
    ".cmake": "CMake",
    ".txt": "Plain Text",
}

_SPECIAL_FILENAMES: Dict[str, str] = {
    "cmakelists.txt": "CMake",
    "makefile": "Makefile",
    "gnumakefile": "Makefile",
}


def detect_language(path: str) -> str:
    """按文件名 / 扩展名判断语言。"""
    if not path:
        return "Plain Text"
    name = posixpath.basename(path).lower()
    if name in _SPECIAL_FILENAMES:
        return _SPECIAL_FILENAMES[name]
    extension = posixpath.splitext(name)[1]
    return _EXTENSION_LANGUAGE.get(extension, "Plain Text")


def _token_formats(theme: Theme, font: QFont) -> Dict[str, QTextCharFormat]:
    colors = theme.syntax_colors()

    def make(key: str, *, bold: bool = False, italic: bool = False) -> QTextCharFormat:
        fmt = QTextCharFormat()
        fmt.setForeground(QColor(colors.get(key, theme.editor_fg)))
        style_font = QFont(font)
        style_font.setBold(bold)
        style_font.setItalic(italic)
        fmt.setFont(style_font)
        return fmt

    return {
        "comment": make("comment", italic=True),
        "keyword": make("keyword", bold=True),
        "string": make("string"),
        "number": make("number"),
        "function": make("function"),
        "class": make("class"),
        "builtin": make("builtin"),
        "operator": make("operator"),
        "error": make("error"),
        "meta": make("meta"),
        "text": make("operator"),
    }


def _categorize(token: Token) -> str:
    """把 Pygments token 归并到主题中的粗粒度类别。"""
    if token in Token.Comment:
        return "comment"
    if token in Token.Keyword:
        return "keyword"
    if token in Token.Literal.String or token in Token.Literal.Char:
        return "string"
    if token in Token.Literal.Number:
        return "number"
    if token in Token.Name.Function or token in Token.Name.Function.Magic:
        return "function"
    if token in Token.Name.Class or token in Token.Name.Namespace:
        return "class"
    if token in Token.Name.Builtin:
        return "builtin"
    if token in Token.Operator:
        return "operator"
    if token in Token.Error:
        return "error"
    if token in Token.Name.Decorator or token in Token.Name.Attribute:
        return "meta"
    return "text"


class SyntaxHighlighter(QSyntaxHighlighter):
    """整文件词法着色器。

    实现方式：整篇文本用 Pygments 词法分析一次得到绝对偏移的着色区间，
    再按 block 应用格式；文档被修改时标记为脏，下一次重绘时重新分析。
    这样多行注释 / 多行字符串也能正确着色。
    """

    def __init__(self, document, theme: Theme, font: QFont, language: str = "Plain Text") -> None:
        super().__init__(document)
        self._theme = theme
        self._font = QFont(font)
        self._language = language
        self._spans: List[Tuple[int, int, QTextCharFormat]] = []
        self._dirty = True
        self._disabled = False
        self.rebuild_formats()

    # -- 配置 --------------------------------------------------------------
    def set_theme(self, theme: Theme) -> None:
        self._theme = theme
        self.rebuild_formats()

    def set_font(self, font: QFont) -> None:
        self._font = QFont(font)
        self.rebuild_formats()

    def set_language(self, language: str) -> None:
        if language == self._language:
            return
        self._language = language
        self.invalidate()

    @property
    def language(self) -> str:
        return self._language

    def rebuild_formats(self) -> None:
        self._formats = _token_formats(self._theme, self._font)
        self.invalidate()

    def invalidate(self) -> None:
        self._dirty = True
        self.rehighlight()

    # -- QSyntaxHighlighter -------------------------------------------------
    def highlightBlock(self, text: str) -> None:
        if self._disabled:
            return
        if self._dirty:
            self._reanalyze()
        if not self._spans:
            return
        block = self.currentBlock()
        start = block.position()
        end = start + len(text)
        for span_start, span_end, fmt in self._spans:
            if span_end <= start:
                continue
            if span_start >= end:
                break
            left = max(span_start, start) - start
            right = min(span_end, end) - start
            if right > left:
                self.setFormat(left, right - left, fmt)

    # -- 内部 --------------------------------------------------------------
    def _lexer(self):
        name = _LEXER_BY_LANGUAGE.get(self._language, "text")
        try:
            return get_lexer_by_name(name, stripnl=False, ensurenl=False)
        except ClassNotFound:  # pragma: no cover - 兜底
            return get_lexer_by_name("text")

    def _reanalyze(self) -> None:
        self._dirty = False
        document = self.document()
        if document is None:  # pragma: no cover
            self._spans = []
            return
        text = document.toPlainText()
        if len(text) > HIGHLIGHT_LIMIT:
            if not self._disabled:
                logger.info("文件过大（%d 字符），已跳过高亮", len(text))
            self._disabled = True
            self._spans = []
            return
        self._disabled = False
        spans: List[Tuple[int, int, QTextCharFormat]] = []
        offset = 0
        formats = self._formats
        try:
            for token, value in lex(text, self._lexer()):
                length = len(value)
                if length:
                    category = _categorize(token)
                    fmt = formats.get(category)
                    if fmt is not None and category != "text":
                        spans.append((offset, offset + length, fmt))
                    offset += length
        except Exception as exc:  # pragma: no cover - 词法器异常不应影响编辑
            logger.warning("语法分析失败（%s）：%s", self._language, exc)
            spans = []
        self._spans = spans
