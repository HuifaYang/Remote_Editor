"""终端面板测试：页签生命周期、头部按钮、主题 / 字号跟随。

面板不认识网络（``open_shell`` 是注入的回调），所以这里可以完全脱机验证。
"""

from __future__ import annotations

from typing import List

from app.ui.theme import DARK, get_theme, monospace_font
from app.ui.widgets.terminal_panel import TerminalPanel
from app.ui.widgets.terminal_view import TerminalView


def make_panel(qtbot) -> tuple:
    opened: List[TerminalView] = []
    panel = TerminalPanel(
        theme=DARK,
        font=monospace_font(12),
        open_shell=opened.append,
        gpu=False,
    )
    qtbot.addWidget(panel)
    panel.resize(600, 240)
    panel.show()
    return panel, opened


def test_empty_panel_shows_a_hint(qtbot) -> None:
    panel, _opened = make_panel(qtbot)

    assert panel.count() == 0
    assert panel.hint.isVisibleTo(panel)
    assert not panel.tabs.isVisibleTo(panel)
    assert panel.current_view() is None


def test_new_terminal_creates_a_tab_and_asks_for_a_shell(qtbot) -> None:
    panel, opened = make_panel(qtbot)

    view = panel.new_terminal()

    assert panel.count() == 1
    assert opened == [view]
    assert panel.current_view() is view
    assert not panel.hint.isVisibleTo(panel)
    assert panel.tabs.tabText(0) == "终端 1"


def test_tabs_are_numbered_sequentially_even_after_closing(qtbot) -> None:
    panel, _opened = make_panel(qtbot)
    panel.new_terminal()
    panel.new_terminal()
    panel.close_tab(0)

    panel.new_terminal()

    assert [panel.tabs.tabText(i) for i in range(panel.count())] == ["终端 2", "终端 3"]


def test_header_buttons_emit_actions(qtbot) -> None:
    panel, opened = make_panel(qtbot)
    collapsed: List[bool] = []
    panel.collapseRequested.connect(lambda: collapsed.append(True))

    panel.new_button.click()
    panel.collapse_button.click()

    assert panel.count() == 1
    assert len(opened) == 1
    assert collapsed == [True]


def test_kill_button_closes_the_current_terminal(qtbot) -> None:
    panel, _opened = make_panel(qtbot)
    view = panel.new_terminal()

    panel.kill_button.click()

    assert panel.count() == 0
    assert not view.is_running()
    assert panel.hint.isVisibleTo(panel)


def test_closing_a_tab_stops_its_channel(qtbot) -> None:
    panel, _opened = make_panel(qtbot)
    view = panel.new_terminal()
    stopped: List[bool] = []
    view.stop = lambda: stopped.append(True)

    panel.close_tab(0)

    assert stopped == [True]
    assert panel.count() == 0


def test_tab_close_button_closes_that_tab(qtbot) -> None:
    """页签关闭按钮是自己画的（Qt 默认那个在深色主题下是红方块）。"""
    panel, _opened = make_panel(qtbot)
    first = panel.new_terminal()
    panel.new_terminal()

    panel._close_buttons[0].click()

    assert first not in panel.views()
    assert panel.count() == 1
    assert len(panel._close_buttons) == 1


def test_close_all_removes_every_tab(qtbot) -> None:
    panel, _opened = make_panel(qtbot)
    panel.new_terminal()
    panel.new_terminal()

    panel.close_all()

    assert panel.count() == 0
    assert panel.views() == []


def test_count_changes_are_announced(qtbot) -> None:
    panel, _opened = make_panel(qtbot)
    seen: List[int] = []
    panel.countChanged.connect(seen.append)

    panel.new_terminal()
    panel.close_tab(0)

    assert seen == [1, 0]


def test_theme_switch_rebuilds_header_icons_and_views(qtbot) -> None:
    panel, _opened = make_panel(qtbot)
    view = panel.new_terminal()
    before = panel.new_button.icon().cacheKey()

    panel.set_theme(get_theme("light"))

    assert panel.new_button.icon().cacheKey() != before
    assert view.canvas._theme is panel._theme


def test_font_change_reaches_every_view(qtbot) -> None:
    panel, _opened = make_panel(qtbot)
    view = panel.new_terminal()
    before = view.canvas.cell_size()

    panel.set_font(monospace_font(18))

    assert view.canvas.cell_size() != before
