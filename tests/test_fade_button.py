"""FadeButton 悬停淡入淡出动画的单元测试。"""

from __future__ import annotations

import pytest

from PySide6.QtGui import QColor

from app.ui.widgets.fade_button import FADE_DURATION_MS, FadeButton


@pytest.fixture
def button(qapp):
    return FadeButton(QColor("#888888"))


def test_starts_transparent(button) -> None:
    """初始无底色（progress 为 0）。"""
    assert button._progress == 0.0


def test_enter_animates_toward_full(button) -> None:
    """悬停进入：动画目标是完整底色。"""
    button._animate_to(1.0)
    assert button._animation.endValue() == 1.0
    assert button._animation.duration() == FADE_DURATION_MS


def test_leave_animates_toward_clear(button) -> None:
    """悬停离开：动画目标是透明。"""
    button._progress = 1.0
    button._animate_to(0.0)
    assert button._animation.endValue() == 0.0


def test_animation_value_updates_progress(button) -> None:
    """动画推进时 progress 跟着变（驱动重绘）。"""
    button._on_animation_value(0.5)
    assert button._progress == pytest.approx(0.5)


def test_set_hover_color_keeps_progress(button) -> None:
    """换主题更新底色不打断当前进度。"""
    button._progress = 0.7
    button.set_hover_color(QColor("#ff0000"))
    assert button._hover_color.name() == "#ff0000"
    assert button._progress == pytest.approx(0.7)
