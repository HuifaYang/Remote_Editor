"""Markdown 预览面板（仿 VSCode 的 Markdown Preview）。

用 ``QTextBrowser`` 渲染：Qt 6 的 ``QTextDocument.setMarkdown()`` 原生支持
Markdown → 富文本，**不需要引入第三方解析器**（符合「不新增依赖」约束）。
预览随编辑器内容实时刷新（外部节流），只读、不占编辑焦点。

颜色全部来自主题（链接 / 代码块 / 引用等着色经一张内联样式表注入）。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtGui import QFont
from PySide6.QtWidgets import QApplication, QTextBrowser, QWidget

from app.ui.theme import Theme


class MarkdownPreview(QTextBrowser):
    """只读的 Markdown 渲染视图。"""

    def __init__(self, theme: Theme, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("markdown_preview")
        self.setOpenExternalLinks(False)  # 远端文件里的链接不在本地浏览器打开
        self.setReadOnly(True)
        self._theme = theme
        self._markdown = ""

    def set_base_font_size(self, size: float) -> None:
        """预览正文 / 标题的字号跟随「设置字号 × 缩放」，与编辑器保持一致。

        文档默认字体**不会**跟着 QSS 的 ``font-size`` 变，必须在每次设置变更时
        显式下发；否则改字号或 Ctrl± 缩放之后，编辑器变了而预览没变，
        两边就会一大一小。
        """
        font = QFont(QApplication.font())
        if font.pixelSize() > 0:  # QSS 用了像素字号时以像素为准
            font.setPixelSize(max(1, round(float(size) * 96.0 / 72.0)))
        else:
            font.setPointSizeF(float(size))
        self.setFont(font)
        self.document().setDefaultFont(font)
        self.set_markdown(self._markdown)  # 重新排版

    def apply_theme(self, theme: Theme) -> None:
        self._theme = theme
        # 主题变了要重渲一次（颜色跟随）
        self.set_markdown(self._markdown)

    def set_markdown(self, text: str) -> None:
        """渲染 Markdown 文本（颜色随主题注入）。"""
        self._markdown = text
        theme = self._theme
        self.document().setDefaultStyleSheet(
            f"""
            body {{ color: {theme.editor_fg}; background: {theme.editor_bg}; }}
            a {{ color: {theme.accent}; }}
            code {{ color: {theme.syntax_string}; }}
            pre {{ color: {theme.editor_fg}; background: {theme.panel_bg};
                   padding: 8px; border-radius: 4px; }}
            blockquote {{ color: {theme.gutter_fg};
                          border-left: 3px solid {theme.border}; }}
            h1, h2, h3, h4 {{ color: {theme.editor_fg}; }}
            hr {{ background: {theme.border}; }}
            """
        )
        self.document().setMarkdown(text)
