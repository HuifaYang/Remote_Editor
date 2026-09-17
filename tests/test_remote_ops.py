"""远程操作编排层测试（使用假会话，无需真实网络）。"""

from __future__ import annotations

import pytest

from app.git.git_client import RepoInfo
from app.git.models import ChangeType
from app.remote.remote_fs import normalize_remote_path
from app.remote.session import RemoteSession
from app.ui import remote_ops
from app.utils.errors import RemoteFileNotFoundError, SFTError
from tests.fakes import DEFAULT_ROOT, FakeSession


@pytest.fixture
def session() -> FakeSession:
    session = FakeSession()
    session.fs.add_directory(DEFAULT_ROOT)
    session.fs.add_directory(f"{DEFAULT_ROOT}/src")
    session.fs.add_file(f"{DEFAULT_ROOT}/src/main.c", "a\nb\nc\n")
    return session


def test_open_session_returns_state(host, monkeypatch) -> None:
    session = FakeSession(host=host)
    state = remote_ops.open_session(session)  # type: ignore[arg-type]
    assert state.connected
    assert state.workspace == DEFAULT_ROOT


def test_list_directory(session: FakeSession) -> None:
    path, entries = remote_ops.list_directory(session, f"{DEFAULT_ROOT}/src")  # type: ignore[arg-type]
    assert path.endswith("/src")
    assert [entry.name for entry in entries] == ["main.c"]


def test_normalize_remote_path_expands_home() -> None:
    assert normalize_remote_path("", "/home/user") == "/home/user"
    assert normalize_remote_path("", "") == "/"
    assert normalize_remote_path("~", "/home/user") == "/home/user"
    assert normalize_remote_path("~/ros2_ws/src/", "/home/user") == "/home/user/ros2_ws/src"
    assert normalize_remote_path("ros2_ws", "/home/user") == "/home/user/ros2_ws"
    assert normalize_remote_path("/opt/app/", "/home/user") == "/opt/app"
    assert normalize_remote_path("/var/log/../tmp", "/home/user") == "/var/tmp"


def test_remote_home_and_subdirectories(session: FakeSession) -> None:
    assert remote_ops.remote_home(session) == "/home/user"  # type: ignore[arg-type]
    path, entries = remote_ops.list_subdirectories(session, "~")  # type: ignore[arg-type]
    assert path == "/home/user"
    assert [entry.name for entry in entries] == ["project"]
    assert all(entry.is_dir for entry in entries)


def test_parent_of() -> None:
    assert remote_ops.parent_of("/home/user/project/") == "/home/user"
    assert remote_ops.parent_of("/home") == "/"
    assert remote_ops.parent_of("/") == "/"


def test_load_file(session: FakeSession) -> None:
    loaded = remote_ops.load_file(session, f"{DEFAULT_ROOT}/src/main.c")  # type: ignore[arg-type]
    assert loaded.text == "a\nb\nc\n"
    assert loaded.language == "C"
    assert loaded.encoding in ("ascii", "utf-8")
    assert loaded.newline == "\n"
    assert loaded.fingerprint.size == len(b"a\nb\nc\n")


def test_load_file_missing(session: FakeSession) -> None:
    with pytest.raises(RemoteFileNotFoundError):
        remote_ops.load_file(session, f"{DEFAULT_ROOT}/ghost.c")  # type: ignore[arg-type]


def test_load_file_enforces_size_limit(session: FakeSession) -> None:
    with pytest.raises(SFTError):
        remote_ops.load_file(session, f"{DEFAULT_ROOT}/src/main.c", max_bytes=2)  # type: ignore[arg-type]


def test_save_file_writes_and_returns_fingerprint(session: FakeSession) -> None:
    path = f"{DEFAULT_ROOT}/src/main.c"
    saved = remote_ops.save_file(session, path, "x\ny\n", encoding="utf-8")  # type: ignore[arg-type]
    assert session.fs.writes == [(path, "x\ny\n", "utf-8", "\n")]
    assert saved.fingerprint is not None
    assert saved.size == len(b"x\ny\n")


def test_create_and_delete_and_rename(session: FakeSession) -> None:
    remote_ops.create_file(session, f"{DEFAULT_ROOT}/src/new.c")  # type: ignore[arg-type]
    remote_ops.create_directory(session, f"{DEFAULT_ROOT}/build")  # type: ignore[arg-type]
    remote_ops.rename_path(session, f"{DEFAULT_ROOT}/src/new.c", f"{DEFAULT_ROOT}/src/renamed.c")  # type: ignore[arg-type]
    remote_ops.delete_path(session, f"{DEFAULT_ROOT}/src/renamed.c")  # type: ignore[arg-type]
    assert f"{DEFAULT_ROOT}/src/new.c" in session.fs.created
    assert f"{DEFAULT_ROOT}/build" in session.fs.created
    assert session.fs.renamed == [
        (f"{DEFAULT_ROOT}/src/new.c", f"{DEFAULT_ROOT}/src/renamed.c")
    ]
    assert session.fs.deleted == [f"{DEFAULT_ROOT}/src/renamed.c"]


def test_load_git_diff_uses_relative_path(session: FakeSession) -> None:
    path = f"{DEFAULT_ROOT}/src/main.c"
    diff = remote_ops.load_git_diff(session, path, "a\nB\nc\n")  # type: ignore[arg-type]
    assert session.git.diff_calls[0][0] == DEFAULT_ROOT
    assert session.git.diff_calls[0][1] == "src/main.c"
    assert diff.markers


def test_load_git_diff_outside_repository(session: FakeSession) -> None:
    session.set_repo(RepoInfo(directory=DEFAULT_ROOT, is_repository=False))
    diff = remote_ops.load_git_diff(session, "/etc/hosts", "x\n")  # type: ignore[arg-type]
    assert diff.markers == {}
    assert session.git.diff_calls == []


def test_load_git_diff_passes_snapshot_status(session: FakeSession) -> None:
    from app.git.git_client import FileStatus

    status = FileStatus(path="src/main.c", index_status=" ", worktree_status="M")
    remote_ops.load_git_diff(
        session, f"{DEFAULT_ROOT}/src/main.c", "a\n", status=status  # type: ignore[arg-type]
    )
    assert session.git.diff_calls[-1][3] is status


# ---------------------------------------------------------------------------
# 文件树 Git 状态快照
# ---------------------------------------------------------------------------


def test_load_tree_status_snapshot(session: FakeSession) -> None:
    session.git.status_lines = {"src/main.c": " M", "src/new.c": "??"}
    tree = remote_ops.load_tree_status(session)  # type: ignore[arg-type]
    assert tree.is_repository
    assert tree.branch == "main"
    assert tree.files == {
        f"{DEFAULT_ROOT}/src/main.c": ChangeType.MODIFIED,
        f"{DEFAULT_ROOT}/src/new.c": ChangeType.ADDED,
    }
    # 目录取子树内优先级最高的变更：新增 > 修改
    assert tree.dirs[f"{DEFAULT_ROOT}/src"] is ChangeType.ADDED


def test_load_tree_status_outside_repository(session: FakeSession) -> None:
    session.set_repo(RepoInfo(directory=DEFAULT_ROOT, is_repository=False))
    tree = remote_ops.load_tree_status(session)  # type: ignore[arg-type]
    assert not tree.is_repository
    assert tree.files == {}
    assert tree.label == "Git: Not a repository"


def test_load_tree_status_uses_explicit_directory(session: FakeSession) -> None:
    session.workspace = ""
    session.git.status_lines = {"src/main.c": " M"}
    tree = remote_ops.load_tree_status(session, DEFAULT_ROOT)  # type: ignore[arg-type]
    assert tree.is_repository
    assert tree.total == 1


def test_git_available(session: FakeSession) -> None:
    assert remote_ops.git_available(session) is True  # type: ignore[arg-type]
    session.ssh.has_git = False
    assert remote_ops.git_available(session) is False  # type: ignore[arg-type]


def test_join_path() -> None:
    assert remote_ops.join_path("/a", "b", "c.c") == "/a/b/c.c"


def test_close_session(session: FakeSession) -> None:
    remote_ops.close_session(session)  # type: ignore[arg-type]
    assert session.closed


def test_remote_session_requires_connection(host) -> None:
    session = RemoteSession(host)
    with pytest.raises(RuntimeError):
        _ = session.fs
