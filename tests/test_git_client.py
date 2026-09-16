"""Git 客户端测试：仓库识别、状态解析、Diff 获取（含未跟踪 / 已删除 / 混合变更）。"""

from __future__ import annotations

import pytest

from app.git.git_client import FileStatus, GitClient, relative_to
from app.git.models import ChangeType
from tests.fakes import DEFAULT_ROOT, FakeSSHServer


@pytest.fixture
def server() -> FakeSSHServer:
    server = FakeSSHServer()
    server.set_file("src/main.c", "a\nb\nc\nd\n")
    server.set_file("src/util.c", "x\ny\n")
    return server


@pytest.fixture
def client(server: FakeSSHServer) -> GitClient:
    return GitClient(server)


# ---------------------------------------------------------------------------
# 仓库识别
# ---------------------------------------------------------------------------


def test_repo_info_for_repository(client: GitClient) -> None:
    info = client.repo_info(DEFAULT_ROOT)
    assert info.is_repository
    assert info.root == DEFAULT_ROOT
    assert info.branch == "main"
    assert info.label == "Git: main"


def test_repo_info_for_non_repository() -> None:
    server = FakeSSHServer(is_repo=False)
    client = GitClient(server)
    info = client.repo_info(DEFAULT_ROOT)
    assert not info.is_repository
    assert info.label == "Git: Not a repository"


def test_repository_root_returns_none_outside_repo() -> None:
    client = GitClient(FakeSSHServer(is_repo=False))
    assert client.repository_root(DEFAULT_ROOT) is None
    assert client.is_repository(DEFAULT_ROOT) is False


def test_repo_info_survives_command_failure() -> None:
    server = FakeSSHServer(fail_commands=True)
    client = GitClient(server)
    info = client.repo_info(DEFAULT_ROOT)
    assert not info.is_repository


# ---------------------------------------------------------------------------
# 状态解析
# ---------------------------------------------------------------------------


def test_status_map_modified(client: GitClient, server: FakeSSHServer) -> None:
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    statuses = client.status_map(DEFAULT_ROOT)
    assert statuses["src/main.c"].worktree_status == "M"
    assert statuses["src/main.c"].label == "已修改"


def test_status_map_untracked(client: GitClient, server: FakeSSHServer) -> None:
    server.write_worktree("src/new.c", "n\n")
    statuses = client.status_map(DEFAULT_ROOT)
    assert statuses["src/new.c"].untracked


def test_status_map_deleted(client: GitClient, server: FakeSSHServer) -> None:
    server.delete_worktree("src/util.c")
    statuses = client.status_map(DEFAULT_ROOT)
    assert statuses["src/util.c"].is_deleted


def test_file_status_falls_back_to_default(client: GitClient) -> None:
    status = client.file_status(DEFAULT_ROOT, "src/unknown.c")
    assert isinstance(status, FileStatus)
    assert status.label == "未变更"


def test_status_map_parses_rename() -> None:
    class RenameServer(FakeSSHServer):
        def _status_output(self, command: str) -> str:
            return "R  old.c -> new.c\n"

    client = GitClient(RenameServer())
    statuses = client.status_map(DEFAULT_ROOT)
    assert "new.c" in statuses


# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------


def test_file_diff_modified(client: GitClient, server: FakeSSHServer) -> None:
    server.write_worktree("src/main.c", "a\nB\nc\nd\ne\n")
    content = server.worktree["src/main.c"]
    diff = client.file_diff(DEFAULT_ROOT, "src/main.c", content=content)
    assert diff.markers == {2: ChangeType.MODIFIED, 5: ChangeType.ADDED}
    assert diff.summary == "+1 ~1 -0"


def test_file_diff_pure_deletion(client: GitClient, server: FakeSSHServer) -> None:
    server.write_worktree("src/main.c", "a\nc\nd\n")
    diff = client.file_diff(DEFAULT_ROOT, "src/main.c", content=server.worktree["src/main.c"])
    assert diff.markers == {2: ChangeType.DELETED}


def test_file_diff_untracked_file_is_all_added(client: GitClient, server: FakeSSHServer) -> None:
    server.write_worktree("src/new.c", "line1\nline2\n")
    diff = client.file_diff(DEFAULT_ROOT, "src/new.c", content="line1\nline2\n")
    assert diff.is_new_file
    assert diff.markers == {1: ChangeType.ADDED, 2: ChangeType.ADDED}


def test_file_diff_no_changes(client: GitClient) -> None:
    diff = client.file_diff(DEFAULT_ROOT, "src/main.c", content="a\nb\nc\nd\n")
    assert diff.markers == {}
    assert not diff.has_changes


def test_file_diff_empty_file(client: GitClient, server: FakeSSHServer) -> None:
    server.write_worktree("src/empty.c", "")
    server.head["src/empty.c"] = ""
    diff = client.file_diff(DEFAULT_ROOT, "src/empty.c", content="")
    assert diff.markers == {}


def test_file_diff_for_deleted_file(client: GitClient, server: FakeSSHServer) -> None:
    server.delete_worktree("src/util.c")
    diff = client.file_diff(DEFAULT_ROOT, "src/util.c", content="")
    assert diff.is_deleted_file
    assert diff.markers == {1: ChangeType.DELETED}


def test_file_diff_reports_git_failure() -> None:
    from app.utils.errors import GitError

    class Failing(FakeSSHServer):
        def exec_command(self, command, *, timeout=None):  # noqa: D401
            from app.remote.ssh_client import CommandResult

            if "diff --no-color" in command:
                return CommandResult(command, 128, "", "fatal: ambiguous argument")
            return super().exec_command(command, timeout=timeout)

    client = GitClient(Failing())
    with pytest.raises(GitError):
        client.file_diff(DEFAULT_ROOT, "src/main.c", content="a\n")


def test_head_content(client: GitClient, server: FakeSSHServer) -> None:
    """HEAD 内容查询（调试用）在假服务上返回空字符串。"""
    assert client.head_content(DEFAULT_ROOT, "src/main.c") in (None, "")


# ---------------------------------------------------------------------------
# 路径工具
# ---------------------------------------------------------------------------


def test_relative_to() -> None:
    assert relative_to("/home/u/proj", "/home/u/proj/src/main.c") == "src/main.c"
    assert relative_to("/home/u/proj/", "/home/u/proj/src/main.c") == "src/main.c"
    assert relative_to("/home/u/proj", "/home/u/proj") == "."
    assert relative_to("/home/u/proj", "/etc/hosts") == "hosts"
