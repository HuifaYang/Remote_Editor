"""内置字体加载测试。

内置字体的意义：程序自带字体文件，不依赖目标机器装了什么字体，
所以「没放字体」和「放了坏字体」都必须是安全路径，不能拖垮启动。
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

import pytest

from PySide6.QtGui import QFontDatabase

from app.ui.fonts import (
    MONOSPACE_PREFERENCE,
    load_bundled_fonts,
    loaded_families,
    preferred_monospace_family,
    reset_cache,
)
from app.ui.theme import default_monospace_family

#: 测试用的系统字体（只要求「有个真实的 TTF」，不关心是哪一款）
SYSTEM_FONT_CANDIDATES = (
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    Path("/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"),
)


@pytest.fixture(autouse=True)
def clean_font_registry():
    """每个用例前后清空记录，避免用例之间互相影响。"""
    reset_cache()
    yield
    reset_cache()


def system_font() -> Optional[Path]:
    for path in SYSTEM_FONT_CANDIDATES:
        if path.is_file():
            return path
    return None


def test_missing_directory_is_not_an_error(tmp_path) -> None:
    """字体目录不存在时照常返回空列表（不影响启动）。"""
    assert load_bundled_fonts(tmp_path / "not-there") == []
    assert loaded_families() == ()
    assert preferred_monospace_family() == ""


def test_loads_fonts_and_reports_families(tmp_path, qapp) -> None:
    source = system_font()
    if source is None:
        pytest.skip("系统里没有可用于测试的 TTF 字体")
    shutil.copy(source, tmp_path / "bundled.ttf")

    families = load_bundled_fonts(tmp_path)

    assert families, "应该至少注册出一个字体族"
    assert set(families) <= set(QFontDatabase.families())
    assert loaded_families() == tuple(families)
    # 重复调用不应该把同一个字族反复登记
    assert load_bundled_fonts(tmp_path) == families


def test_ignores_non_font_files_and_broken_fonts(tmp_path, qapp) -> None:
    """目录里的说明文件、损坏的字体文件都不该让启动失败。"""
    (tmp_path / "README.md").write_text("字体说明", encoding="utf-8")
    (tmp_path / "broken.ttf").write_bytes(b"definitely not a font")

    assert load_bundled_fonts(tmp_path) == []


def test_skips_registration_without_a_qapplication(tmp_path, monkeypatch) -> None:
    """还没建 QApplication 时不能碰 QFontDatabase（Qt 会直接崩），必须安全跳过。"""
    from app.ui import fonts as fonts_module

    source = system_font()
    if source is None:
        pytest.skip("系统里没有可用于测试的 TTF 字体")
    shutil.copy(source, tmp_path / "font.ttf")
    monkeypatch.setattr(fonts_module.QGuiApplication, "instance", staticmethod(lambda: None))

    assert load_bundled_fonts(tmp_path) == []


def test_preferred_monospace_family_uses_bundled_font(tmp_path, qapp) -> None:
    """内置等宽字体优先于系统默认（这是「不依赖外部字体」的落点）。"""
    source = system_font()
    if source is None:
        pytest.skip("系统里没有可用于测试的 TTF 字体")
    shutil.copy(source, tmp_path / "mono.ttf")
    families = load_bundled_fonts(tmp_path)
    assert families
    if families[0] not in MONOSPACE_PREFERENCE:
        pytest.skip(f"{families[0]} 不在等宽偏好列表里，无法断言优先级")

    preferred = preferred_monospace_family()
    assert preferred == families[0]
    assert default_monospace_family() == preferred
