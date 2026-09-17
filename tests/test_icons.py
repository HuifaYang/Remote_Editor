"""图标绘制测试：每个图标都要在 1x / 2x 下画出非空像素（名字写错就会变成空白）。"""

from __future__ import annotations

from PySide6.QtGui import QColor

from app.ui.icons import DRAWERS, icon_names, make_icon, render_pixmap

COLOUR = QColor("#c8c8c8")


def painted_pixels(pixmap) -> int:
    """数一数有多少像素被画上了（用于区分「画出来了」和「一片空白」）。"""
    image = pixmap.toImage()
    return sum(
        1
        for y in range(image.height())
        for x in range(image.width())
        if image.pixelColor(x, y).alpha() > 0
    )


def test_every_icon_draws_something(qtbot) -> None:
    for name in icon_names():
        pixmap = render_pixmap(name, COLOUR, 16)
        assert not pixmap.isNull()
        assert pixmap.width() == 16 and pixmap.height() == 16
        assert painted_pixels(pixmap) > 0, f"图标 {name} 画出来是空白"


def test_icons_stay_readable_at_high_dpi(qtbot) -> None:
    """2 倍图是给高 DPI 屏用的，同样要有内容。"""
    for name in icon_names():
        pixmap = render_pixmap(name, COLOUR, 32)
        assert pixmap.width() == 32
        assert painted_pixels(pixmap) > 0


def test_make_icon_ships_both_sizes(qtbot) -> None:
    icon = make_icon("files", COLOUR)
    sizes = {size.width() for size in icon.availableSizes()}
    assert {16, 32} <= sizes


def test_unknown_icon_is_blank_not_a_crash(qtbot) -> None:
    """图标名写错不该让界面崩掉，最多画一个空位。"""
    pixmap = render_pixmap("no-such-icon", QColor("#ffffff"), 16)
    assert not pixmap.isNull()
    assert painted_pixels(pixmap) == 0


def test_icon_names_match_the_drawer_table(qtbot) -> None:
    assert icon_names() == tuple(DRAWERS)
