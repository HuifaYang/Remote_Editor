"""起始页测试：只在该出现的时候提供「打开远程文件夹」（对齐 VSCode）。"""

from __future__ import annotations

from app.ui.theme import DARK, LIGHT
from app.ui.widgets.welcome import WelcomeView


def make_view(qtbot, theme=DARK) -> WelcomeView:
    view = WelcomeView(theme)
    qtbot.addWidget(view)
    return view


def test_disconnected_state_only_offers_connect(qtbot) -> None:
    view = make_view(qtbot)
    view.set_connected(False)

    assert view.connect_button.isVisibleTo(view)
    assert not view.open_folder_button.isEnabled()
    assert "Ctrl+K" in view.hint.text()


def test_connected_state_hides_connect_and_enables_open_folder(qtbot) -> None:
    view = make_view(qtbot)
    view.set_connected(True)

    assert not view.connect_button.isVisibleTo(view)
    assert view.open_folder_button.isEnabled()
    assert "打开远程文件夹" in view.hint.text()


def test_buttons_emit_their_signals(qtbot) -> None:
    view = make_view(qtbot)
    seen = []
    view.connectRequested.connect(lambda: seen.append("connect"))
    view.openFolderRequested.connect(lambda: seen.append("folder"))

    view.set_connected(False)
    view.connect_button.click()
    view.set_connected(True)
    view.open_folder_button.click()

    assert seen == ["connect", "folder"]


def test_apply_theme_keeps_the_layout(qtbot) -> None:
    view = make_view(qtbot)
    view.apply_theme(LIGHT)
    assert view.title.text() == "RemoteCodeEditor"
    assert view.open_folder_button.isEnabled() is False
