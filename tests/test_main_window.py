"""主窗口集成测试：文件树、打开/保存、冲突处理、Git 标记、异步不阻塞 UI。"""

from __future__ import annotations

import time

import pytest
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QDialog, QTabBar, QToolBar, QToolButton

from app.cache.file_cache import FileCache
from app.config.hosts import HostStore
from app.config.settings import AppSettings, SettingsStore
from app.git.git_client import RepoInfo
from app.git.models import ChangeType
from app.utils.errors import RemoteFileNotFoundError
from app.ui import main_window as main_window_module
from app.ui.main_window import MainWindow
from app.ui.theme import get_theme
from app.ui.widgets.file_tree import CHANGE_ROLE, DIR_ROLE, PATH_ROLE
from tests.fakes import DEFAULT_ROOT, FakeSession

MAIN_C = f"{DEFAULT_ROOT}/src/main.c"

SRC_DIR = f"{DEFAULT_ROOT}/src"

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


class FakeFolderPicker:
    """替换真实目录选择器，避免测试里弹出模态窗口。"""

    chosen = ""
    initial = ""

    def __init__(self, session, *, initial_path="", runner=None, parent=None) -> None:
        type(self).initial = initial_path

    def exec(self) -> int:
        return QDialog.DialogCode.Accepted

    def chosen_path(self) -> str:
        return type(self).chosen


class ExplodingFolderPicker:
    def __init__(self, *args, **kwargs) -> None:  # pragma: no cover - 只用于断言
        raise AssertionError("已经记住工作目录时不应再弹出选择器")


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
    assert directory_item.text(0) == "logs"  # 单列布局，没有大小 / 时间列


def test_connect_opens_remembered_workspace_without_prompt(qtbot, window, session, monkeypatch) -> None:
    session.host.remote_workspace = DEFAULT_ROOT
    session.workspace = DEFAULT_ROOT
    session.workspace_configured = True
    monkeypatch.setattr(main_window_module, "RemoteFolderPickerDialog", ExplodingFolderPicker)

    window._on_connected(session, None)

    assert window.workspace == DEFAULT_ROOT
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)
    assert window.action_open_folder.isEnabled()


def test_connect_prompts_folder_and_remembers_choice(qtbot, window, session, monkeypatch) -> None:
    host = session.host
    window.host_store.add(host)
    session.workspace = "/home/user"
    session.workspace_configured = False
    FakeFolderPicker.chosen = SRC_DIR
    FakeFolderPicker.initial = ""
    monkeypatch.setattr(main_window_module, "RemoteFolderPickerDialog", FakeFolderPicker)

    window._on_connected(session, None)

    # 默认定位到远端家目录，选择结果成为工作目录并写回主机配置
    assert FakeFolderPicker.initial == "/home/user"
    assert window.workspace == SRC_DIR
    assert session.workspace == SRC_DIR
    assert window.host_store.get(host.id).remote_workspace == SRC_DIR
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(
        lambda: root.childCount() == 1 and root.child(0).text(0) == "main.c", timeout=5000
    )


def test_stale_remembered_workspace_prompts_again(qtbot, window, session, monkeypatch) -> None:
    ghost = f"{DEFAULT_ROOT}/ghost"
    session.host.remote_workspace = ghost
    session.workspace = ghost
    session.workspace_configured = True
    real_list_dir = session.fs.list_dir

    def selective_list_dir(path: str):
        if path == ghost:
            raise RemoteFileNotFoundError(f"远程文件不存在：{path}")
        return real_list_dir(path)

    monkeypatch.setattr(session.fs, "list_dir", selective_list_dir)
    monkeypatch.setattr(main_window_module.QMessageBox, "warning", staticmethod(lambda *a, **k: None))
    FakeFolderPicker.chosen = SRC_DIR
    FakeFolderPicker.initial = ""
    monkeypatch.setattr(main_window_module, "RemoteFolderPickerDialog", FakeFolderPicker)

    window._on_connected(session, None)

    # 列目录失败是异步的：等主窗口重新选好目录
    qtbot.waitUntil(lambda: window.workspace == SRC_DIR, timeout=5000)
    assert FakeFolderPicker.initial == ghost  # 从失效的目录位置开始浏览
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(
        lambda: root.childCount() == 1 and root.child(0).text(0) == "main.c", timeout=5000
    )


def test_open_folder_action_switches_workspace(qtbot, wired, monkeypatch) -> None:
    window, session = wired
    session.fs.add_directory(SRC_DIR)
    FakeFolderPicker.chosen = SRC_DIR
    monkeypatch.setattr(main_window_module, "RemoteFolderPickerDialog", FakeFolderPicker)

    window._on_open_folder()

    assert window.workspace == SRC_DIR
    assert window.file_tree.topLevelItem(0).data(0, PATH_ROLE) == SRC_DIR


def test_open_folder_action_requires_connection(window: MainWindow, monkeypatch) -> None:
    monkeypatch.setattr(main_window_module, "RemoteFolderPickerDialog", ExplodingFolderPicker)
    monkeypatch.setattr(window, "_require_session", lambda: None)
    window._on_open_folder()  # 未连接：不弹窗也不报错
    assert window.workspace == ""


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
    session.set_repo(RepoInfo(directory=DEFAULT_ROOT, is_repository=False))
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
    assert window.file_tree._theme.name == "light"


def test_tree_colors_changed_directory_from_snapshot(qtbot, wired) -> None:
    """工作目录加载后，文件树按 Git 状态着色（目录取子树内最高优先级变更）。"""
    window, session = wired
    session.git.status_lines = {"src/main.c": " M", "logs/new.log": "??"}
    window._load_directory(DEFAULT_ROOT)
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)

    window._refresh_tree_status()

    src = next(root.child(i) for i in range(root.childCount()) if root.child(i).text(0) == "src")
    logs = next(root.child(i) for i in range(root.childCount()) if root.child(i).text(0) == "logs")
    qtbot.waitUntil(lambda: src.data(0, CHANGE_ROLE) != "", timeout=5000)
    assert src.foreground(0).color() == QColor(window.theme.marker_modified)
    assert logs.foreground(0).color() == QColor(window.theme.marker_added)
    # 根节点也跟随子树变更着色，状态栏显示变更总数
    assert root.foreground(0).color() == QColor(window.theme.marker_added)
    assert "2 处变更" in window.status.git_cell.text()


def test_tree_snapshot_cleared_when_not_a_repository(qtbot, wired) -> None:
    window, session = wired
    session.git.status_lines = {"src/main.c": " M"}
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)

    session.set_repo(RepoInfo(directory=DEFAULT_ROOT, is_repository=False))
    window._refresh_tree_status()

    qtbot.waitUntil(
        lambda: "Not a repository" in window.status.git_cell.text(), timeout=5000
    )
    snapshot = window.file_tree.status_snapshot()
    assert snapshot is not None
    assert snapshot.total == 0


def test_opening_file_reuses_tree_snapshot_status(qtbot, wired) -> None:
    """打开文件时复用文件树快照里的状态，不再额外跑一次 git status。"""
    window, session = wired
    session.git.status_lines = {"src/main.c": " M"}
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)

    session.git.diff_calls.clear()
    open_file(qtbot, window, session)
    qtbot.waitUntil(lambda: bool(session.git.diff_calls), timeout=5000)

    status = session.git.diff_calls[-1][3]
    assert status is not None
    assert status.worktree_status == "M"


def test_opening_unchanged_file_passes_clean_status(qtbot, wired) -> None:
    """未修改的文件被快照判定为干净：连 git diff 都不必跑。"""
    window, session = wired
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)

    session.git.diff_calls.clear()
    open_file(qtbot, window, session)
    qtbot.waitUntil(lambda: bool(session.git.diff_calls), timeout=5000)

    status = session.git.diff_calls[-1][3]
    assert status is not None
    assert status.change_type is None


def test_save_updates_tree_marks_without_remote_status(qtbot, wired) -> None:
    """保存后本地就把标记改成「已修改」：不再为每次保存跑一次 git status。"""
    window, session = wired
    window._load_directory(DEFAULT_ROOT)
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)

    document = open_file(qtbot, window, session)
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None
    editor.set_plain_text_silent(MODIFIED, language="C")
    editor.document().setModified(True)
    session.git.status_calls.clear()

    window._save_document(document)
    qtbot.waitUntil(lambda: bool(session.fs.writes), timeout=5000)

    def marked_modified() -> bool:
        snapshot = window.file_tree.status_snapshot()
        return snapshot is not None and snapshot.change_for(MAIN_C) is ChangeType.MODIFIED

    qtbot.waitUntil(marked_modified, timeout=5000)
    assert session.git.status_calls == []
    assert not window._git_timer.isActive()
    src = next(root.child(i) for i in range(root.childCount()) if root.child(i).text(0) == "src")
    assert src.foreground(0).color() == QColor(window.theme.marker_modified)


def test_delete_updates_tree_marks_without_remote_status(qtbot, wired) -> None:
    """删除已跟踪文件后本地记为「已删除」，父目录继续着色，不跑远端命令。"""
    window, session = wired
    removed = f"{DEFAULT_ROOT}/src/old.c"
    session.fs.add_file(removed, "x\n")
    session.git.status_lines = {"src/old.c": " M"}
    window._load_directory(DEFAULT_ROOT)
    window._load_directory(SRC_DIR)
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)
    window._refresh_tree_status()
    qtbot.waitUntil(
        lambda: window.file_tree.status_snapshot() is not None, timeout=5000
    )

    session.git.status_calls.clear()
    window._after_delete(removed)

    snapshot = window.file_tree.status_snapshot()
    assert snapshot.change_for(removed) is ChangeType.DELETED
    assert snapshot.change_for(SRC_DIR, is_dir=True) is ChangeType.DELETED
    assert session.git.status_calls == []
    assert not window._git_timer.isActive()


def test_save_outside_workspace_falls_back_to_remote_refresh(qtbot, wired) -> None:
    """快照覆盖不到的文件（工作目录之外）仍走延迟远端刷新兜底。"""
    window, session = wired
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)

    window._apply_saved_status("/home/user/other/file.c")

    assert window._git_timer.isActive()


def test_delete_without_snapshot_knowledge_schedules_refresh(qtbot, wired) -> None:
    """快照里没有该路径（干净文件或被忽略的产物）时，让远端给出准确答案。"""
    window, session = wired
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)

    window._forget_deleted_path(MAIN_C)

    assert window._git_timer.isActive()


def test_undoing_changes_clears_tree_colour(qtbot, wired) -> None:
    """改完变黄 → 撤销回原样并保存 → 标记撤掉（用户报告的 bug）。"""
    window, session = wired
    window._load_directory(DEFAULT_ROOT)
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)

    document = open_file(qtbot, window, session)
    assert document.clean_at_open
    editor = window.editor_tabs.editor_for_path(MAIN_C)
    assert editor is not None

    editor.set_plain_text_silent(MODIFIED, language="C")
    window.editor_tabs.sync_text(document)
    window._save_document(document)
    qtbot.waitUntil(
        lambda: window.file_tree.status_snapshot().change_for(MAIN_C) is ChangeType.MODIFIED,
        timeout=5000,
    )

    editor.set_plain_text_silent(ORIGINAL, language="C")
    window.editor_tabs.sync_text(document)
    assert document.reverted
    window._save_document(document)

    qtbot.waitUntil(
        lambda: not document.dirty
        and window.file_tree.status_snapshot().change_for(MAIN_C) is None,
        timeout=5000,
    )
    src = next(root.child(i) for i in range(root.childCount()) if root.child(i).text(0) == "src")
    assert src.foreground(0).color() != QColor(window.theme.marker_modified)


def test_workspace_open_lists_root_once(qtbot, window, session) -> None:
    """打开工作目录只列一次目录：展开信号与显式加载不再重复发请求。"""
    session.host.remote_workspace = DEFAULT_ROOT
    session.workspace = DEFAULT_ROOT
    session.workspace_configured = True
    session.fs.list_calls.clear()

    window._on_connected(session, None)

    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)
    assert session.fs.list_calls.count(DEFAULT_ROOT) == 1
    # F5 刷新仍然要真的重新列举
    window._refresh_workspace()
    qtbot.waitUntil(lambda: session.fs.list_calls.count(DEFAULT_ROOT) == 2, timeout=5000)


def test_expanding_a_prefetched_directory_hits_the_cache(qtbot, wired) -> None:
    """展开目录后后台预取其子目录：下一次点击直接上屏，不再等远端。"""
    window, session = wired
    window._load_directory(DEFAULT_ROOT)
    root = window.file_tree.topLevelItem(0)
    qtbot.waitUntil(lambda: root.childCount() == 2, timeout=5000)
    qtbot.waitUntil(lambda: SRC_DIR in window._dir_cache, timeout=5000)

    session.fs.list_calls.clear()
    window._load_directory(SRC_DIR)

    assert session.fs.list_calls == []
    src_item = next(
        root.child(index) for index in range(root.childCount()) if root.child(index).text(0) == "src"
    )
    assert src_item.childCount() == 1
    assert src_item.child(0).text(0) == "main.c"


def test_f5_drops_cached_listings(qtbot, wired) -> None:
    """F5 表示「我要看最新的」：缓存清空并强制回远端列举。"""
    window, session = wired
    window._load_directory(DEFAULT_ROOT)
    qtbot.waitUntil(lambda: bool(window._dir_cache), timeout=5000)

    window._refresh_workspace()

    assert window._dir_cache == {}
    qtbot.waitUntil(lambda: session.fs.list_calls.count(DEFAULT_ROOT) >= 2, timeout=5000)


def test_local_mutation_invalidates_the_directory_cache(qtbot, wired) -> None:
    """新建 / 删除 / 重命名后必须丢掉缓存，否则会看到过期目录。"""
    window, session = wired
    window._load_directory(DEFAULT_ROOT)
    qtbot.waitUntil(lambda: DEFAULT_ROOT in window._dir_cache, timeout=5000)

    window._after_mutation(DEFAULT_ROOT, "已创建")

    assert DEFAULT_ROOT not in window._dir_cache


def test_explorer_header_shows_folder_and_actions(qtbot, wired) -> None:
    """侧边栏顶部是当前文件夹名与常用操作图标（仿 VSCode 资源管理器）。"""
    window, session = wired
    window._open_workspace(DEFAULT_ROOT, persist=False)
    assert window.explorer_title.text() == "project"

    # 顶栏只放图标（文字会把文件夹名挤掉），图标名与顺序固定，含义放 Tooltip
    assert [name for _button, name in window.explorer_buttons] == [
        "new-file",
        "new-folder",
        "refresh",
        "collapse",
    ]
    for button, _name in window.explorer_buttons:
        assert isinstance(button, QToolButton)
        assert not button.icon().isNull()
        assert button.text() == ""
        assert button.toolTip()


def test_git_label_is_not_duplicated_in_status_bar(qtbot, wired) -> None:
    """仓库标签自带 "Git: " 前缀，状态栏不该显示成 "Git: Git: main"。"""
    window, session = wired
    window.status.set_git("Git: lifecycle · 2 处变更")
    assert window.status.git_cell.text() == "Git: lifecycle · 2 处变更"


def test_new_entry_target_follows_selection(qtbot, wired) -> None:
    """新建文件 / 文件夹的目标目录：选中的目录，否则工作目录。"""
    window, session = wired
    window._open_workspace(DEFAULT_ROOT, persist=False)
    qtbot.waitUntil(
        lambda: window.file_tree.topLevelItem(0).childCount() == 2, timeout=5000
    )
    assert window._new_entry_dir() == DEFAULT_ROOT

    root = window.file_tree.topLevelItem(0)
    logs = next(
        root.child(index) for index in range(root.childCount()) if root.child(index).text(0) == "logs"
    )
    window.file_tree.setCurrentItem(logs)
    assert window._new_entry_dir() == f"{DEFAULT_ROOT}/logs"


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


# ---------------------------------------------------------------------------
# VSCode 风格的窗口骨架：欢迎页、活动栏、源代码管理面板
# ---------------------------------------------------------------------------
def test_welcome_view_is_shown_until_a_file_is_opened(qtbot, wired) -> None:
    """空工作区显示欢迎页（VSCode 的空标签页），打开文件后切回标签页。"""
    window, session = wired
    assert window.editor_stack.currentWidget() is window.welcome

    open_file(qtbot, window, session)
    assert window.editor_stack.currentWidget() is window.editor_tabs

    window.editor_tabs.force_close(0)
    assert window.editor_stack.currentWidget() is window.welcome


def test_open_folder_is_only_offered_after_connecting(qtbot, window: MainWindow) -> None:
    """未连接时「打开远程文件夹」禁用（对齐 VSCode：先连接、再选目录）。"""
    assert not window.welcome.open_folder_button.isEnabled()
    assert window.welcome.connect_button.isVisibleTo(window)
    assert not window.activity_bar.button("open-folder").isEnabled()

    window.session = FakeSession()
    window._update_status_connection(True)

    assert window.welcome.open_folder_button.isEnabled()
    assert not window.welcome.connect_button.isVisibleTo(window)
    assert window.activity_bar.button("open-folder").isEnabled()


def test_activity_bar_view_buttons_toggle_the_side_panel(qtbot, wired) -> None:
    window, session = wired
    assert window.side_panel.currentWidget() is window.explorer

    window._on_activity_triggered("source-control", True)
    assert window.side_panel.currentWidget() is window.scm_view
    assert window.side_panel.isVisibleTo(window)

    # 再点一次当前的视图按钮 = 收起侧边栏
    window._on_activity_triggered("source-control", False)
    assert not window.side_panel.isVisibleTo(window)

    window._on_activity_triggered("files", True)
    assert window.side_panel.isVisibleTo(window)
    assert window.side_panel.currentWidget() is window.explorer


def test_source_control_panel_reuses_the_tree_snapshot(qtbot, wired) -> None:
    """切到源代码管理面板不产生任何远端请求，只复用文件树的那份快照。"""
    window, session = wired
    session.git.status_lines = {"src/main.c": " M", "logs/new.log": "??"}
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)
    calls_before = (len(session.fs.list_calls), len(session.git.status_calls))

    window._on_activity_triggered("source-control", True)

    assert (len(session.fs.list_calls), len(session.git.status_calls)) == calls_before
    assert window.scm_view.paths() == [
        f"{DEFAULT_ROOT}/logs/new.log",
        f"{DEFAULT_ROOT}/src/main.c",
    ]


def test_source_control_panel_opens_files_on_click(qtbot, wired) -> None:
    window, session = wired
    session.git.status_lines = {"src/main.c": " M"}
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: bool(window.scm_view.paths()), timeout=5000)

    item = window.scm_view.tree.topLevelItem(0)
    window.scm_view.tree.itemClicked.emit(item, 0)

    qtbot.waitUntil(lambda: window.editor_tabs.index_of_path(MAIN_C) >= 0, timeout=5000)


def test_source_control_refresh_button_refetches_git_status(qtbot, wired) -> None:
    window, session = wired
    session.git.status_lines = {"src/main.c": " M"}

    window.scm_view.refresh_button.click()

    qtbot.waitUntil(lambda: window.file_tree.status_snapshot() is not None, timeout=5000)
    assert window.scm_view.paths() == [MAIN_C]


def test_scm_and_tree_are_cleared_when_the_session_ends(qtbot, wired) -> None:
    window, session = wired
    session.git.status_lines = {"src/main.c": " M"}
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: bool(window.scm_view.paths()), timeout=5000)

    window._teardown_session()

    assert window.scm_view.paths() == []
    assert window.file_tree.status_snapshot() is None


def test_saving_a_file_updates_the_scm_panel_without_a_git_call(qtbot, wired) -> None:
    """保存后本地更新 Git 标记：SCM 面板跟着变，且不额外跑 git status。"""
    window, session = wired
    session.git.status_lines = {"src/main.c": " M"}
    window._refresh_tree_status()
    qtbot.waitUntil(lambda: window.scm_view.paths() == [MAIN_C], timeout=5000)

    document = window.editor_tabs.document_for_path(MAIN_C)
    if document is None:
        open_file(qtbot, window, session)
    calls_before = len(session.git.status_calls)

    window._apply_saved_status(MAIN_C, clean=True)

    assert window.scm_view.paths() == []
    assert len(session.git.status_calls) == calls_before


def test_tab_close_button_is_self_drawn_and_closes_the_document(qtbot, wired) -> None:
    """标签页用自绘的灰色叉（Qt 默认图形在深色主题下是个红块）。"""
    window, session = wired
    open_file(qtbot, window, session)
    button = window.editor_tabs.tabBar().tabButton(
        0, QTabBar.ButtonPosition.RightSide
    )
    assert isinstance(button, QToolButton)
    assert not button.icon().isNull()

    before = button.icon().cacheKey()
    window.theme = get_theme("light")
    window._apply_settings_to_ui()
    assert button.icon().cacheKey() != before

    button.click()
    assert window.editor_tabs.count() == 0


def test_toolbar_is_icon_only(qtbot, wired) -> None:
    """顶部工具栏只放图标（文字按钮会占掉一整行，对齐 VSCode 的图标风格）。"""
    window, session = wired
    toolbar = window.findChild(QToolBar)
    assert toolbar is not None
    assert toolbar.toolButtonStyle() == Qt.ToolButtonStyle.ToolButtonIconOnly

    for action in toolbar.actions():
        if action.isSeparator():
            continue
        # 图标画出来了，文字仍然保留给菜单 / 无障碍读屏使用
        assert not action.icon().isNull()
        assert action.text()


def test_explorer_shows_a_hint_until_a_folder_is_opened(qtbot, window: MainWindow) -> None:
    assert window.explorer_hint.isVisibleTo(window)
    assert not window.file_tree.isVisibleTo(window)

    window.session = FakeSession()
    window._update_status_connection(True)
    window._open_workspace(DEFAULT_ROOT, persist=False)

    assert not window.explorer_hint.isVisibleTo(window)
    assert window.file_tree.isVisibleTo(window)
