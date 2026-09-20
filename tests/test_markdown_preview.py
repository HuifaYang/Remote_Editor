"""Markdown 预览：编辑器 + 预览分屏、切换显隐、随编辑刷新。"""

from __future__ import annotations

import pytest

from app.config.settings import AppSettings
from app.editor.document import Document
from app.ui.theme import DARK
from app.ui.widgets.editor_tabs import EditorTabs


@pytest.fixture
def tabs(themed_app, qtbot):
    widget = EditorTabs(DARK, AppSettings())
    qtbot.addWidget(widget)
    return widget


def _md_document() -> Document:
    return Document(
        remote_path="/home/le/README.md",
        text="# 标题\n\n正文 **加粗**\n",
        language="Markdown",
    )


def test_markdown_file_has_preview_panel(tabs) -> None:
    """Markdown 文件的标签页带预览面板（默认隐藏）。"""
    tab = tabs.add_document(_md_document())
    assert tab.preview is not None
    assert not tab.preview.isVisible()


def test_non_markdown_file_has_no_preview(tabs) -> None:
    """普通代码文件不带预览面板。"""
    doc = Document(remote_path="/home/le/main.py", text="x = 1\n", language="Python")
    tab = tabs.add_document(doc)
    assert tab.preview is None


def test_toggle_preview_shows_and_hides(tabs) -> None:
    doc = _md_document()
    tabs.add_document(doc)
    assert tabs.toggle_markdown_preview(doc) is True
    assert tabs.is_markdown_preview_visible(doc) is True
    assert tabs.toggle_markdown_preview(doc) is False
    assert tabs.is_markdown_preview_visible(doc) is False


def test_toggle_preview_rejects_non_markdown(tabs) -> None:
    doc = Document(remote_path="/home/le/main.py", text="x = 1\n", language="Python")
    tabs.add_document(doc)
    assert tabs.toggle_markdown_preview(doc) is False


def test_preview_renders_markdown_to_html(tabs) -> None:
    """预览内容被渲染成富文本（标题变成大字号块，不再是 `# 标题` 字面量）。"""
    doc = _md_document()
    tab = tabs.add_document(doc)
    tabs.toggle_markdown_preview(doc)
    html = tab.preview.toHtml()
    assert "标题" in html
    assert "<h1" in html.lower()  # 被渲染成标题，不是纯文本


def test_preview_refreshes_after_edit(tabs, qtbot) -> None:
    """编辑内容后预览跟着更新（节流刷新）。"""
    doc = _md_document()
    tab = tabs.add_document(doc)
    tabs.toggle_markdown_preview(doc)
    tab.editor.set_plain_text_silent("# 新标题\n\n改了\n", language="Markdown")
    # 触发一次手动刷新（绕过 300ms 节流计时器）
    tab.preview.set_markdown(tab.editor.text_value())
    assert "新标题" in tab.preview.toHtml()


def test_preview_gets_width_when_toggled_on_a_visible_widget(qtbot) -> None:
    """窗口已经显示之后再开预览，预览必须拿到实际宽度。

    ``QSplitter`` 不会在隐藏的 widget 重新显示时自动分配尺寸：早期实现直接
    ``setVisible(True)``，预览停在 0 宽 —— 用户看到「预览没出来 / Markdown 不渲染」
    就是这个原因。这里钉住「切换后确实分到宽度」。
    """
    widget = EditorTabs(DARK, AppSettings())
    qtbot.addWidget(widget)
    widget.resize(900, 500)
    widget.show()

    doc = _md_document()
    tab = widget.add_document(doc)
    widget.toggle_markdown_preview(doc)

    assert tab.preview is not None
    assert tab.preview.width() > 0


def test_preview_font_follows_editor_settings(tabs) -> None:
    """预览字号与编辑器同源（设置字号 × 缩放）。

    预览文档的默认字体不会跟着 QSS 的 ``font-size`` 变，早期实现里它一直停在
    建控件时的应用字体上 —— 结果改字号 / Ctrl± 之后编辑器变了、预览没变，
    两边一大一小（用户反馈过「字体差别那么大」）。
    """
    doc = _md_document()
    tab = tabs.add_document(doc)
    tabs.apply_settings(AppSettings(font_size=18))

    assert tab.editor.font().pointSizeF() == pytest.approx(18.0)
    assert tab.preview.document().defaultFont().pointSizeF() == pytest.approx(18.0)


def test_preview_font_matches_editor_on_open(tabs) -> None:
    """刚打开预览时两边字号就已经一致（不是等到下次改设置才对上）。"""
    tabs.apply_settings(AppSettings(font_size=15))
    doc = _md_document()
    tab = tabs.add_document(doc)

    assert tab.preview.document().defaultFont().pointSizeF() == pytest.approx(15.0)
    assert tab.editor.font().pointSizeF() == pytest.approx(15.0)
