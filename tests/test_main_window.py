"""主窗口集成测试：文件树、打开/保存、冲突处理、Git 标记、异步不阻塞 UI。"""

from __future__ import annotations

import time

import pytest
from PySide6.QtCore import QTimer

from app.cache.file_cache import FileCache
from app.config.hosts import HostStore
from app.config.settings import AppSettings, SettingsStore
from app.git.git_client import RepoInfo
from app.git.models import ChangeType
from app.ui.main_window import MainWindow
from app.ui.theme import get_theme
from app.ui.widgets.file_tree import DIR_ROLE, PATH_ROLE
from tests.fakes import DEFAULT_ROOT, FakeSession

MAIN_C = f"{DEFAULT_ROOT}/src/main.c"

ORIGINAL = "int main() {\n    return 0;\n}\n"
MODIFIED = "int main() {\n    return 1;\n}\n"
DIFF_TEXT = (
    "diff --git a/src/main.c b/src/main.c\n"
    "--- a/src/main.c\n"
    "+++ b/src/main.c\n"
    "@@ -1,3 +1,3 @@\n"
    " int main() {\n"
    "-    return 0;\n"
    "+    return 1;\n"
    " }\n"
)


@pytest.fixture
def window(qtbot, tmp_path) -> MainWindow:
    widget = MainWindow(
        settings_store=SettingsStore(tmp_path / "settings.json"),
        host_store=HostStore(tmp_path / "hosts.json"),
        cache=FileCache(tmp_path / "cache"),
    )
    # 测试中不弹「未保存确认」对话框
    widget._confirm_exit_with_unsaved = lambda: True  # type: ignore[method-assign]
    qtbot.addWidget(widget)
    return widget


@pytest.fixture
def session() -> FakeSession:
    session = FakeSession()
    session.fs.add_directory(DEFAULT_ROOT)
    session.fs.add_directory(f"{DEFAULT_ROOT}/src")
    session.fs.add_directory(f"{DEFAULT_ROOT}/logs")
    session.fs.add_file(MAIN_C, ORIGINAL)
    session.git.diff_text = DIFF_TEXT
    return session


@pytest.fixture
def wired(window: MainWindow, session: FakeSession):
    window.session = session
    window.workspace = DEFAULT_ROOT
    window._update_status_connection(True)
    window.file_tree.set_root(DEFAULT_ROOT)
    return window, session


def open_file(qtbot, window: MainWindow, session: FakeSession, path: str = MAIN_C):
    window.open_remote_file(path)
    qtbot.waitUntil(lambda: window.editor_tabs.index_of_path(path) >= 0, timeout=5000)
    return window.editor_tabs.document_for_path(path)


# ---------------------------------------------------------------------------
# 基础构建
# ---------------------------------------------------------------------------


def test_window_builds_without_connection(window: MainWindow) -> None:
    assert window.editor_tabs.count() == 0
    assert "Disconnected" in window.status.connection_cell.text()
    assert window.menuBar().actions()
    assert not window.action_save.isEnabled()


def test_tree_populated_after_listing(qtbot, wired) -> None:
    window, session = wired
    window._load_directory(DEFAULT_ROOT)
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)
    names = {root.child(index).text(0) for index in range(root.childCount())}
    assert names == {"src", "logs"}
    directory_item = next(
        root.child(index)
        for index in range(root.childCount())
        if root.child(index).text(0) == "logs"
    )
    assert directory_item.data(0, DIR_ROLE) is True
    assert directory_item.data(0, PATH_ROLE) == f"{DEFAULT_ROOT}/logs"
    assert directory_item.text(1) == "-"  # 目录不显示大小


def test_expand_directory_loads_children(qtbot, wired) -> None:
    window, session = wired
    window._load_directory(DEFAULT_ROOT)
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)
    src_item = next(
        root.child(index) for index in range(root.childCount()) if root.child(index).text(0) == "src"
    )
    src_item.setExpanded(True)
    qtbot.waitUntil(
        lambda: src_item.childCount() == 1 and src_item.child(0).text(0) == "main.c",
        timeout=5000,
    )
    assert src_item.child(0).text(0) == "main.c"
    assert src_item.child(0).data(0, DIR_ROLE) is False


# ---------------------------------------------------------------------------
# 打开 / 保存
# ---------------------------------------------------------------------------


def test_open_file_creates_tab(qtbot, wired) -> None:
    window, session = wired
    document = open_file(qtbot, window, session)
    assert document is not None
    assert document.language == "C"
    assert document.encoding in ("ascii", "utf-8")
    assert "main.c" in window.status.file_cell.text()
    assert window.action_save.isEnabled()


def test_open_file_loads_git_markers(qtbot, wired) -> None:
    window, session = wired
    document = open_file(qtbot, window, session)
    qtbot.waitUntil(lambda: bool(document.diff.markers), timeout=5000)
    assert document.diff.markers == {2: ChangeType.MODIFIED}
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None
    assert editor.marker_counts()[ChangeType.MODIFIED] == 1


def test_open_file_reuses_existing_tab(qtbot, wired) -> None:
    window, session = wired
    open_file(qtbot, window, session)
    open_file(qtbot, window, session)
    assert window.editor_tabs.count() == 1


def test_open_missing_file_does_not_crash(qtbot, wired, monkeypatch) -> None:
    window, session = wired
    messages = []
    monkeypatch.setattr(
        "app.ui.main_window.QMessageBox.warning",
        lambda *args, **kwargs: messages.append(args),
    )
    window.open_remote_file(f"{DEFAULT_ROOT}/ghost.c")
    qtbot.waitUntil(lambda: bool(messages), timeout=5000)
    assert window.editor_tabs.count() == 0


def test_save_uploads_content(qtbot, wired) -> None:
    window, session = wired
    document = open_file(qtbot, window, session)
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None
    editor.set_plain_text_silent(MODIFIED, language="C")
    editor.document().setModified(True)

    window._save_document(document)
    qtbot.waitUntil(lambda: bool(session.fs.writes), timeout=5000)
    path, text, encoding, newline = session.fs.writes[0]
    assert path == MAIN_C
    assert text == MODIFIED
    assert newline == "\n"
    assert not document.dirty
    assert not window.editor_tabs.tabText(0).endswith("*")


def test_unsaved_indicator_and_status(qtbot, wired) -> None:
    window, session = wired
    open_file(qtbot, window, session)
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None
    editor.insertPlainText("// x")
    qtbot.waitUntil(lambda: window.editor_tabs.tabText(0).endswith("*"), timeout=2000)
    assert "未保存" in window.status.save_cell.text()


def test_close_clean_tab(qtbot, wired) -> None:
    window, session = wired
    open_file(qtbot, window, session)
    window._close_current_tab()
    assert window.editor_tabs.count() == 0


# ---------------------------------------------------------------------------
# 冲突处理（需求 5.10）
# ---------------------------------------------------------------------------


def test_conflict_cancel_keeps_local_text(qtbot, wired, monkeypatch) -> None:
    window, session = wired
    document = open_file(qtbot, window, session)
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None
    editor.set_plain_text_silent(MODIFIED, language="C")
    editor.document().setModified(True)
    session.fs.add_file(MAIN_C, "remote changed\n")  # 远端被外部修改

    monkeypatch.setattr(window, "_ask_conflict", lambda _document: "cancel")
    window._save_document(document)
    qtbot.wait(200)
    assert session.fs.writes == []
    assert document.dirty


def test_conflict_overwrite_uploads(qtbot, wired, monkeypatch) -> None:
    window, session = wired
    document = open_file(qtbot, window, session)
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None
    editor.set_plain_text_silent(MODIFIED, language="C")
    editor.document().setModified(True)
    session.fs.add_file(MAIN_C, "remote changed\n")

    monkeypatch.setattr(window, "_ask_conflict", lambda _document: "overwrite")
    window._save_document(document)
    qtbot.waitUntil(lambda: bool(session.fs.writes), timeout=5000)
    assert session.fs.writes[0][1] == MODIFIED


def test_conflict_reload_discards_local_edits(qtbot, wired, monkeypatch) -> None:
    window, session = wired
    document = open_file(qtbot, window, session)
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None
    editor.set_plain_text_silent(MODIFIED, language="C")
    editor.document().setModified(True)
    session.fs.add_file(MAIN_C, "remote changed\n")

    monkeypatch.setattr(window, "_ask_conflict", lambda _document: "reload")
    window._save_document(document)
    qtbot.waitUntil(
        lambda: window.editor_tabs.current_document() is not None
        and window.editor_tabs.current_document().text == "remote changed\n",
        timeout=5000,
    )
    assert session.fs.writes == []


# ---------------------------------------------------------------------------
# Git 状态 / 主题 / 搜索
# ---------------------------------------------------------------------------


def test_status_shows_not_a_repository(qtbot, wired) -> None:
    window, session = wired
    session.git.repo = RepoInfo(directory=DEFAULT_ROOT, is_repository=False)
    window._refresh_repo_info()
    qtbot.waitUntil(lambda: "Not a repository" in window.status.git_cell.text(), timeout=5000)


def test_manual_git_refresh_updates_markers(qtbot, wired) -> None:
    window, session = wired
    document = open_file(qtbot, window, session)
    longer = "int main() {\n    return 0;\n}\n// tail\n"
    session.git.diff_text = (
        "--- a/src/main.c\n+++ b/src/main.c\n@@ -1,3 +1,4 @@\n"
        " int main() {\n"
        "     return 0;\n"
        " }\n"
        "+// tail\n"
    )
    session.fs.add_file(MAIN_C, longer)
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None
    editor.set_plain_text_silent(longer, language="C")
    window.editor_tabs.sync_text(document)
    window._refresh_git_for_current()
    qtbot.waitUntil(lambda: 4 in document.diff.markers, timeout=5000)
    assert document.diff.markers[4] is ChangeType.ADDED
    session.git.diff_text = (
        "--- a/src/main.c\n+++ b/src/main.c\n@@ -1,3 +1,4 @@\n"
        " int main() {\n"
        "     return 0;\n"
        " }\n"
        "+// tail\n"
    )
    window.editor_tabs.sync_text(document)
    window._refresh_git_for_current()
    qtbot.waitUntil(lambda: 4 in document.diff.markers, timeout=5000)
    assert document.diff.markers[4] is ChangeType.ADDED


def test_theme_change_updates_editors(qtbot, wired) -> None:
    window, session = wired
    open_file(qtbot, window, session)
    window.settings = AppSettings(theme="light")
    window.theme = get_theme("light")
    window._apply_settings_to_ui()
    editor = window.editor_tabs.current_editor()
    assert editor is not None
    assert editor.theme.name == "light"


def test_search_updates_result_label(qtbot, wired) -> None:
    window, session = wired
    open_file(qtbot, window, session)
    window._on_search("return", True, False, False)
    assert "处" in window.search_bar.result_label.text()
    window._on_replace_all("return", "exit", False, False)
    assert "已替换" in window.search_bar.result_label.text()


# ---------------------------------------------------------------------------
# 异步不阻塞 UI（验收 7 / 需求 5.13）
# ---------------------------------------------------------------------------


def test_long_running_task_keeps_ui_responsive(window: MainWindow, qtbot) -> None:
    ticks = []
    timer = QTimer()
    timer.setInterval(20)
    timer.timeout.connect(lambda: ticks.append(1))
    timer.start()

    result = {}

    def slow() -> str:
        time.sleep(0.3)
        return "done"

    window.runner.submit(slow, on_success=lambda value: result.update(value=value))
    qtbot.waitUntil(lambda: "value" in result, timeout=5000)
    timer.stop()

    assert result["value"] == "done"
    assert len(ticks) >= 3, "长任务执行期间事件循环应继续运行（GUI 不冻结）"


def test_task_error_callback_receives_exception(window: MainWindow, qtbot) -> None:
    captured = {}

    def boom() -> None:
        raise ValueError("bad thing")

    window.runner.submit(
        boom,
        on_error=lambda message, exc: captured.update(message=message, exc=exc),
    )
    qtbot.waitUntil(lambda: "exc" in captured, timeout=5000)
    assert isinstance(captured["exc"], ValueError)
    assert captured["message"]


def test_task_error_callback_single_argument(window: MainWindow, qtbot) -> None:
    captured = {}

    def boom() -> None:
        raise RuntimeError("nope")

    window.runner.submit(boom, on_error=lambda message: captured.update(message=message))
    qtbot.waitUntil(lambda: "message" in captured, timeout=5000)
    assert captured["message"]
