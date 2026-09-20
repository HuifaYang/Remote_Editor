"""外观样式测试：QSS 覆盖范围、运行时小图标、界面字号、主题色下发。

配色只能来自 :mod:`app.ui.theme`，所以这里既验证「样式表真的接管了原生控件」
（否则深色主题下还是 Fusion 的立体滚动条 / 箭头），也验证颜色确实取自主题。
"""

from __future__ import annotations

import pytest

from PySide6.QtGui import QPalette
from PySide6.QtWidgets import QLabel

from app.ui import theme as theme_module
from app.ui.theme import (
    DARK,
    LIGHT,
    UI_FONT_BASE_SIZE,
    UI_FONT_POINT_SIZE,
    apply_theme,
    apply_ui_font,
    refresh_style,
    ui_font,
    ui_metric_scale,
)


def test_qss_takes_over_native_controls(themed_app) -> None:
    """滚动条 / 下拉箭头 / 微调框 / 勾选框必须被样式表接管。

    这些控件以前没被覆盖，Qt 会用 Fusion 自带的立体边框和三角箭头画，
    深色主题下非常扎眼——也就是「看起来复古」的主要来源。
    """
    apply_theme(themed_app, DARK)
    qss = themed_app.styleSheet()

    for selector in (
        "QScrollBar:vertical",
        "QScrollBar::add-line",
        "QComboBox::down-arrow",
        "QSpinBox::up-arrow",
        "QCheckBox::indicator:checked",
        "QRadioButton::indicator:checked",
        "QGroupBox::title",
        "QTabBar::tab:selected",
        "QMenu::item:selected",
    ):
        assert selector in qss
    assert f"background: {DARK.window_bg}" in qss  # 颜色确实来自主题


def test_glyphs_are_generated_with_theme_colors(themed_app, tmp_path, monkeypatch) -> None:
    """QSS 只能引用图片，所以勾选 / 箭头图标按当前主题生成到临时目录。"""
    monkeypatch.setattr(theme_module, "glyph_dir", lambda: tmp_path)
    apply_theme(themed_app, DARK)

    check = tmp_path / "check-dark.svg"
    arrow = tmp_path / "arrow-down-dark.svg"
    assert check.is_file() and arrow.is_file()
    assert "#ffffff" in check.read_text(encoding="utf-8")
    assert f"url({check.as_posix()})" in themed_app.styleSheet()
    # 箭头颜色是前景 / 底色的中间灰，随主题变化（不是写死的）
    mixed = theme_module._blend(DARK.editor_fg, DARK.editor_bg, 0.5)
    assert mixed in arrow.read_text(encoding="utf-8")


def test_glyph_failure_degrades_to_plain_colors(themed_app, monkeypatch) -> None:
    """临时目录不可写时样式表仍然合法（退化成纯色块），不能因此切不了主题。"""

    def broken():
        raise OSError("read-only")

    monkeypatch.setattr(theme_module, "glyph_dir", broken)
    apply_theme(themed_app, DARK)

    assert "image: none" in themed_app.styleSheet()


def test_ui_font_point_size(qapp) -> None:
    """界面字号只在启动阶段下发；采样的是磅值，徽标等相对字号才有得算。"""
    font = ui_font()
    assert font.pointSizeF() == UI_FONT_POINT_SIZE
    assert font.pixelSize() == -1


def test_apply_ui_font_hands_font_to_the_application(qapp) -> None:
    """apply_ui_font 必须早于任何控件调用，这里用替身验证「确实下发了一次」。"""

    class _Recorder:
        def __init__(self) -> None:
            self.font = None

        def setFont(self, font) -> None:  # noqa: N802 - 模拟 QApplication 接口
            self.font = font

    recorder = _Recorder()
    apply_ui_font(recorder)

    assert recorder.font is not None
    assert recorder.font.pointSizeF() == UI_FONT_POINT_SIZE


def test_muted_and_error_labels_follow_theme(themed_app) -> None:
    """提示文字不再硬编码 gray / 红色，而是靠属性选择器取主题色。"""
    apply_theme(themed_app, LIGHT)

    def text_color(**properties) -> str:
        label = QLabel("提示")
        for key, value in properties.items():
            label.setProperty(key, value)
        refresh_style(label)
        label.ensurePolished()
        return label.palette().color(QPalette.ColorRole.WindowText).name()

    assert text_color() == LIGHT.editor_fg
    assert text_color(muted=True) == LIGHT.gutter_fg
    assert text_color(severity="error") == LIGHT.syntax_error


def test_ui_metric_scale_tracks_zoom_and_font_size() -> None:
    """尺寸比例 = 缩放 × (字号 ÷ 基准字号)。

    字号调大时图标 / 间距要同步变大，否则「图标比文字大」的比例会垮掉
    （用户反馈过：字号调到 14 后图标显得比字小）。
    """
    assert ui_metric_scale(1.0, UI_FONT_BASE_SIZE) == pytest.approx(1.0)
    assert ui_metric_scale(1.1, UI_FONT_BASE_SIZE) == pytest.approx(1.1)
    assert ui_metric_scale(1.0, 14) == pytest.approx(14 / UI_FONT_BASE_SIZE)
    assert ui_metric_scale(1.0, 14) > 1.0


def test_theme_pixel_metrics_follow_font_size(themed_app) -> None:
    """字体变大的同时，QSS 里的间距 / 控件尺寸也跟着变大（不是只放大文字）。"""
    apply_theme(themed_app, DARK, ui_font_size=12)
    small = themed_app.styleSheet()
    apply_theme(themed_app, DARK, ui_font_size=24)
    large = themed_app.styleSheet()

    assert "font-size: 12pt" in small
    assert "font-size: 24pt" in large
    # 行高 / 内边距这类尺寸也变了（否则界面会「字大框小」）
    assert small != large
