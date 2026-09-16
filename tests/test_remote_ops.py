"""远程操作编排层测试（使用假会话，无需真实网络）。"""

from __future__ import annotations

import pytest

from app.git.git_client import RepoInfo
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
    session._repo_info = RepoInfo(directory=DEFAULT_ROOT, is_repository=False)
    diff = remote_ops.load_git_diff(session, "/etc/hosts", "x\n")  # type: ignore[arg-type]
    assert diff.markers == {}
    assert session.git.diff_calls == []


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
