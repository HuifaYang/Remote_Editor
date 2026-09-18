"""终端与主窗口的集成测试：快捷键开关面板、开远端 shell、失败提示、断开清理。

用注入的假 ``ShellChannel`` 替掉真实 paramiko 通道（不碰网络），
真实链路的端到端在 ``test_ssh_end_to_end.py`` 里另有覆盖。
"""

from __future__ import annotations

from typing import List, Optional

import pytest
from PySide6.QtCore import Qt
from app.cache.file_cache import FileCache
from app.config.hosts import HostStore
from app.config.settings import SettingsStore
from app.ui import main_window as main_window_module
from app.ui.main_window import MainWindow
from tests.fakes import DEFAULT_ROOT, FakeSession

MAIN_C = f"{DEFAULT_ROOT}/src/main.c"
ORIGINAL = "int main() {\n    return 0;\n}\n"


class FakeShellChannel:
    """假通道：``open()`` 不碰网络，数据由测试手动推。"""

    created: List["FakeShellChannel"] = []
    fail_with: Optional[str] = None

    def __init__(self, ssh=None, **_kwargs) -> None:
        self.ssh = ssh
        self.written: List[str] = []
        self.resizes: List[tuple] = []
        self.closed = False
        self.opened = False
        self.on_data = None
        self.on_closed = None
        FakeShellChannel.created.append(self)

    def open(self) -> None:
        if FakeShellChannel.fail_with:
            raise RuntimeError(FakeShellChannel.fail_with)
        self.opened = True

    def start_reader(self, on_data, on_closed) -> None:
        self.on_data, self.on_closed = on_data, on_closed

    def write(self, text: str) -> None:
        self.written.append(text)

    def resize(self, cols: int, rows: int) -> None:
        self.resizes.append((cols, rows))

    def close(self) -> None:
        self.closed = True

    @property
    def is_closed(self) -> bool:  # pragma: no cover - 只是让替身更像真的
        return self.closed

    def push(self, text: str) -> None:
        assert self.on_data is not None
        self.on_data(text)


@pytest.fixture(autouse=True)
def fake_shell_channels(monkeypatch):
    FakeShellChannel.created = []
    FakeShellChannel.fail_with = None
    monkeypatch.setattr(main_window_module, "ShellChannel", FakeShellChannel)
    yield FakeShellChannel


@pytest.fixture
def window(qtbot, tmp_path) -> MainWindow:
    widget = MainWindow(
        settings_store=SettingsStore(tmp_path / "settings.json"),
        host_store=HostStore(tmp_path / "hosts.json"),
        cache=FileCache(tmp_path / "cache"),
    )
    widget._confirm_exit_with_unsaved = lambda: True  # type: ignore[method-assign]
    qtbot.addWidget(widget)
    widget.show()  # 面板的可见性断言需要窗口是「可见」的（离屏平台也能算可见）
    return widget


@pytest.fixture
def session() -> FakeSession:
    session = FakeSession()
    session.fs.add_directory(DEFAULT_ROOT)
    session.fs.add_directory(f"{DEFAULT_ROOT}/src")
    session.fs.add_file(MAIN_C, ORIGINAL)
    return session


@pytest.fixture
def wired(window: MainWindow, session: FakeSession):
    window.session = session
    window.workspace = DEFAULT_ROOT
    window._update_status_connection(True)
    return window, session


def open_terminal(qtbot, window: MainWindow):
    window.action_toggle_terminal.trigger()
    qtbot.waitUntil(lambda: window.terminal_panel.count() == 1, timeout=3000)
    view = window.terminal_panel.current_view()
    qtbot.waitUntil(lambda: view is not None and view.is_running(), timeout=3000)
    return view


# ---------------------------------------------------------------------------
# 开关与页签
# ---------------------------------------------------------------------------


def test_terminal_shortcuts_are_registered(window: MainWindow) -> None:
    shortcuts = {sequence.toString() for sequence in window.action_toggle_terminal.shortcuts()}

    assert shortcuts == {"Ctrl+`", "Ctrl+J"}
    assert window.action_new_terminal.shortcut().toString() in {"Ctrl+Shift+`"}


def test_ctrl_backtick_actually_toggles_the_panel(qtbot, wired) -> None:
    """光有 QKeySequence 不够：真按一次 Ctrl+`（VSCode 的同款快捷键）。"""
    from PySide6.QtWidgets import QApplication

    window, _session = wired
    QApplication.setActiveWindow(window)  # 快捷键是 WindowShortcut，窗口要在激活态

    qtbot.keyClick(window, Qt.Key.Key_QuoteLeft, Qt.KeyboardModifier.ControlModifier)

    qtbot.waitUntil(lambda: window.terminal_panel.count() == 1, timeout=3000)
    assert window.terminal_panel.isVisible()

    qtbot.keyClick(window, Qt.Key.Key_QuoteLeft, Qt.KeyboardModifier.ControlModifier)

    assert not window.terminal_panel.isVisible()
    assert not window.action_toggle_terminal.isChecked()


def test_toggle_without_a_connection_refuses_and_resets(window: MainWindow) -> None:
    assert window.session is None

    window.action_toggle_terminal.trigger()

    assert not window.terminal_panel.isVisible()
    assert window.terminal_panel.count() == 0
    assert not window.action_toggle_terminal.isChecked()
    assert "先连接" in window.status.save_cell.text()


def test_toggle_opens_the_panel_with_one_terminal(qtbot, wired) -> None:
    window, _session = wired

    view = open_terminal(qtbot, window)

    assert window.terminal_panel.isVisibleTo(window)
    assert window.terminal_panel.count() == 1
    assert view.is_running()
    assert len(FakeShellChannel.created) == 1
    assert FakeShellChannel.created[0].opened


def test_hiding_and_showing_again_reuses_the_existing_terminal(qtbot, wired) -> None:
    window, _session = wired
    open_terminal(qtbot, window)

    window.action_toggle_terminal.setChecked(False)
    assert not window.terminal_panel.isVisible()

    window.action_toggle_terminal.setChecked(True)

    assert window.terminal_panel.isVisible()
    assert window.terminal_panel.count() == 1  # 不再新建第二个


def test_new_terminal_adds_a_second_tab(qtbot, wired) -> None:
    window, _session = wired
    open_terminal(qtbot, window)

    window.action_new_terminal.trigger()
    qtbot.waitUntil(lambda: window.terminal_panel.count() == 2, timeout=3000)
    # 建通道是后台任务，断言数量前要等它落地（否则会和读取线程抢时序）
    qtbot.waitUntil(lambda: len(FakeShellChannel.created) == 2, timeout=3000)

    assert len(FakeShellChannel.created) == 2
    assert window.action_toggle_terminal.isChecked()


def test_new_terminal_opens_the_panel_first(qtbot, wired) -> None:
    window, _session = wired

    window.action_new_terminal.trigger()

    qtbot.waitUntil(lambda: window.terminal_panel.count() == 1, timeout=3000)
    assert window.terminal_panel.isVisible()
    assert window.action_toggle_terminal.isChecked()


def test_collapse_button_unchecks_the_action(qtbot, wired) -> None:
    window, _session = wired
    open_terminal(qtbot, window)

    window.terminal_panel.collapse_button.click()

    assert not window.action_toggle_terminal.isChecked()
    assert not window.terminal_panel.isVisible()


# ---------------------------------------------------------------------------
# 数据流
# ---------------------------------------------------------------------------


def test_shell_output_is_shown_in_the_terminal(qtbot, wired) -> None:
    window, _session = wired
    view = open_terminal(qtbot, window)

    FakeShellChannel.created[0].push("\x1b[32mhello\x1b[0m from board\r\n")

    assert view.terminal.text(0) == "hello from board"


def test_keyboard_input_goes_to_the_channel(qtbot, wired) -> None:
    window, _session = wired
    view = open_terminal(qtbot, window)

    view.canvas.dataEntered.emit("ls\r")

    assert FakeShellChannel.created[0].written == ["ls\r"]


def test_open_failure_is_reported_in_the_tab(qtbot, wired) -> None:
    window, _session = wired
    FakeShellChannel.fail_with = "端口 22 不可达"

    window.action_toggle_terminal.trigger()

    qtbot.waitUntil(lambda: window.terminal_panel.count() == 1, timeout=3000)
    view = window.terminal_panel.current_view()
    qtbot.waitUntil(lambda: "失败" in view.notice.text(), timeout=3000)

    assert "端口 22 不可达" in view.notice.text()
    assert not view.is_running()


# ---------------------------------------------------------------------------
# 生命周期
# ---------------------------------------------------------------------------


def test_disconnect_closes_every_terminal(qtbot, wired) -> None:
    window, _session = wired
    open_terminal(qtbot, window)
    channels = list(FakeShellChannel.created)

    window._teardown_session()

    assert all(channel.closed for channel in channels)
    assert window.terminal_panel.count() == 0
    assert not window.terminal_panel.isVisible()  # 空面板一起收起，勾选状态保持一致
    assert not window.action_toggle_terminal.isChecked()


def test_closing_the_window_stops_the_terminals(qtbot, wired) -> None:
    window, _session = wired
    open_terminal(qtbot, window)

    window.close()

    assert all(channel.closed for channel in FakeShellChannel.created)


def test_terminal_font_follows_the_global_zoom(qtbot, wired) -> None:
    window, _session = wired
    view = open_terminal(qtbot, window)
    before = view.canvas.cell_size()

    window._zoom(1)

    assert view.canvas.cell_size() != before
    assert window.terminal_panel._font.pointSizeF() > window.settings.font_size


def test_terminal_background_follows_the_theme(qtbot, wired) -> None:
    window, _session = wired
    view = open_terminal(qtbot, window)

    window._switch_theme("light")

    assert view.canvas._theme.name == "light"
