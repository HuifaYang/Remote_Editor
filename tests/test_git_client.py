"""Git 客户端测试：仓库识别、状态解析、Diff 获取（含未跟踪 / 已删除 / 混合变更）。"""

from __future__ import annotations

import shlex

import pytest

from app.git.git_client import (
    FileStatus,
    GitClient,
    TreeStatus,
    build_tree_status,
    relative_to,
)
from app.git.models import ChangeType
from tests.fakes import DEFAULT_ROOT, FakeSSHServer
from app.remote.ssh_client import CommandResult
from app.utils.errors import GitError


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
# 远端往返预算（性能回归防线：每次交互允许多少个远端进程）
# ---------------------------------------------------------------------------


def test_open_workspace_costs_two_remote_commands(client: GitClient, server: FakeSSHServer) -> None:
    """打开工作目录：1 次 rev-parse（含分支）+ 1 次限定范围的 status。"""
    server.commands.clear()
    info = client.repo_info(DEFAULT_ROOT)
    client.tree_status(DEFAULT_ROOT, info=info, scope=DEFAULT_ROOT)
    git_commands = [command for command in server.commands if " rev-parse" in command or " status " in command]
    assert len(git_commands) == 2
    assert "rev-parse --show-toplevel --abbrev-ref HEAD" in git_commands[0]
    assert f"status --porcelain -- {DEFAULT_ROOT}" in git_commands[1]


def test_opening_clean_file_costs_no_remote_command(
    client: GitClient, server: FakeSSHServer
) -> None:
    """打开未修改的文件：快照已判定干净，远端 Git 命令为 0。"""
    tree = client.tree_status(DEFAULT_ROOT)
    status = tree.status_for_diff(f"{DEFAULT_ROOT}/src/main.c")

    server.commands.clear()
    client.file_diff(DEFAULT_ROOT, "src/main.c", content="a\nb\nc\nd\n", status=status)

    assert server.commands == []


def test_opening_modified_file_costs_one_remote_command(
    client: GitClient, server: FakeSSHServer
) -> None:
    """打开已修改的文件：只有 1 次 git diff（旧实现为 status + diff 两次）。"""
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    tree = client.tree_status(DEFAULT_ROOT)
    status = tree.status_for_diff(f"{DEFAULT_ROOT}/src/main.c")

    server.commands.clear()
    client.file_diff(DEFAULT_ROOT, "src/main.c", content="a\nB\nc\nd\n", status=status)

    assert len(server.commands) == 1
    assert "diff --no-color" in server.commands[0]


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


class _StatusFailsServer(FakeSSHServer):
    """``git status`` 失败、其余命令正常（例如仓库所有权校验失败）。"""

    def exec_command(self, command: str, *, timeout=None):  # noqa: D401
        if "status --porcelain" in command:
            return CommandResult(command, 128, "", "fatal: detected dubious ownership")
        return super().exec_command(command, timeout=timeout)


def test_status_failure_is_not_treated_as_clean() -> None:
    """``git status`` 失败时必须返回「未知」，不能当成「未变更」。"""
    server = _StatusFailsServer()
    server.set_file("src/main.c", "a\nb\nc\nd\n")
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    client = GitClient(server)

    status = client.file_status(DEFAULT_ROOT, "src/main.c")

    assert status.known is False
    # 仍然要跑 git diff，否则行级标记会静默消失
    diff = client.file_diff(DEFAULT_ROOT, "src/main.c", content=server.worktree["src/main.c"])
    assert diff.markers == {2: ChangeType.MODIFIED}


def test_tree_status_marks_incomplete_when_status_fails() -> None:
    server = _StatusFailsServer()
    server.set_file("src/main.c", "a\nb\n")
    client = GitClient(server)

    tree = client.tree_status(DEFAULT_ROOT)

    assert tree.is_repository
    assert tree.complete is False
    # 不完整 → 不覆盖任何路径 → 单文件 diff 必须回退到实时查询
    assert tree.covers(f"{DEFAULT_ROOT}/src/main.c") is False
    assert tree.status_for_diff(f"{DEFAULT_ROOT}/src/main.c") is None


def test_status_map_parses_rename() -> None:
    class RenameServer(FakeSSHServer):
        def _status_output(self, command: str) -> str:
            return "R  old.c -> new.c\n"

    client = GitClient(RenameServer())
    statuses = client.status_map(DEFAULT_ROOT)
    assert "new.c" in statuses


# ---------------------------------------------------------------------------
# 文件树状态快照
# ---------------------------------------------------------------------------


def test_tree_status_maps_files_dirs_and_parents(
    client: GitClient, server: FakeSSHServer
) -> None:
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")  # 修改
    server.delete_worktree("src/util.c")  # 删除
    server.write_worktree("src/new.c", "n\n")  # 新增

    tree = client.tree_status(DEFAULT_ROOT)

    assert tree.is_repository
    assert tree.branch == "main"
    assert tree.files[f"{DEFAULT_ROOT}/src/main.c"] is ChangeType.MODIFIED
    assert tree.files[f"{DEFAULT_ROOT}/src/new.c"] is ChangeType.ADDED
    assert tree.files[f"{DEFAULT_ROOT}/src/util.c"] is ChangeType.DELETED
    # 目录取子树内优先级最高的变更：删除 > 新增 > 修改
    assert tree.dirs[f"{DEFAULT_ROOT}/src"] is ChangeType.DELETED
    assert tree.dirs[DEFAULT_ROOT] is ChangeType.DELETED
    assert tree.total == 3
    assert tree.label == "Git: main · 3 处变更"
    assert tree.letter_for(f"{DEFAULT_ROOT}/src/new.c") == "U"
    assert tree.letter_for(f"{DEFAULT_ROOT}/src/util.c") == "D"
    # 单文件 diff 复用同一份状态
    assert tree.file_status(f"{DEFAULT_ROOT}/src/new.c").untracked is True
    assert tree.file_status(f"{DEFAULT_ROOT}/src/main.c").worktree_status == "M"
    assert tree.file_status(f"{DEFAULT_ROOT}/src/untracked.c") is None


def test_tree_status_change_for_only_reports_real_changes(
    client: GitClient, server: FakeSSHServer
) -> None:
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    tree = client.tree_status(DEFAULT_ROOT)

    assert tree.change_for(f"{DEFAULT_ROOT}/src/main.c") is ChangeType.MODIFIED
    assert tree.change_for(f"{DEFAULT_ROOT}/src", is_dir=True) is ChangeType.MODIFIED
    assert tree.change_for(f"{DEFAULT_ROOT}/unrelated.c") is None
    assert tree.change_for(f"{DEFAULT_ROOT}", is_dir=True) is ChangeType.MODIFIED


def test_tree_status_clean_repository_has_no_changes(client: GitClient) -> None:
    tree = client.tree_status(DEFAULT_ROOT)
    assert tree.is_repository
    assert tree.files == {}
    assert tree.dirs == {}
    assert tree.label == "Git: main"


def test_tree_status_outside_repository_is_empty() -> None:
    tree = GitClient(FakeSSHServer(is_repo=False)).tree_status(DEFAULT_ROOT)
    assert tree == TreeStatus()
    assert not tree.is_repository
    assert tree.label == "Git: Not a repository"


def test_repo_info_uses_a_single_rev_parse(client: GitClient, server: FakeSSHServer) -> None:
    """仓库根与分支名合并成一次 rev-parse，避免两次远端进程。"""
    server.commands.clear()
    info = client.repo_info(DEFAULT_ROOT)
    assert info.root == DEFAULT_ROOT
    assert info.branch == "main"
    assert len([command for command in server.commands if "rev-parse" in command]) == 1


def test_tree_status_reuses_cached_repo_info(client: GitClient, server: FakeSSHServer) -> None:
    """传入已缓存的仓库识别结果时不再执行 rev-parse。"""
    server.commands.clear()
    info = client.repo_info(DEFAULT_ROOT)
    baseline = sum(1 for command in server.commands if "rev-parse" in command)
    assert baseline == 1

    server.commands.clear()
    client.tree_status(DEFAULT_ROOT, info=info)
    assert not [command for command in server.commands if "rev-parse" in command]
    assert len([command for command in server.commands if "status --porcelain" in command]) == 1


def test_tree_status_marks_folded_untracked_directory() -> None:
    class UntrackedDirServer(FakeSSHServer):
        def _status_output(self, command: str) -> str:
            return "?? build/\n"

    tree = GitClient(UntrackedDirServer()).tree_status(DEFAULT_ROOT)
    directory = f"{DEFAULT_ROOT}/build"
    assert tree.untracked_dirs == (directory,)
    assert tree.change_for(directory, is_dir=True) is ChangeType.ADDED
    # 折叠目录下的文件同样视为新增
    assert tree.change_for(f"{directory}/cmake.log") is ChangeType.ADDED


def test_build_tree_status_ignores_unchanged_and_empty_paths() -> None:
    statuses = {
        "": FileStatus(path="", index_status=" ", worktree_status=" "),
        "src/clean.c": FileStatus(path="src/clean.c", index_status=" ", worktree_status=" "),
        "src/main.c": FileStatus(path="src/main.c", index_status=" ", worktree_status="M"),
    }
    tree = build_tree_status(DEFAULT_ROOT, branch="dev", statuses=statuses)
    assert list(tree.files) == [f"{DEFAULT_ROOT}/src/main.c"]
    assert tree.branch == "dev"
    assert tree.label == "Git: dev · 1 处变更"


def test_build_tree_status_tolerates_trailing_slash_root() -> None:
    statuses = {"src/main.c": FileStatus(path="src/main.c", index_status=" ", worktree_status="M")}
    tree = build_tree_status(DEFAULT_ROOT + "/", statuses=statuses)
    assert tree.files == {f"{DEFAULT_ROOT}/src/main.c": ChangeType.MODIFIED}


def test_status_for_diff_reports_clean_inside_repository(
    client: GitClient, server: FakeSSHServer
) -> None:
    """仓库覆盖范围内、status 未列出的文件 = 未变更（无需再跑 git status）。"""
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    tree = client.tree_status(DEFAULT_ROOT)

    clean = tree.status_for_diff(f"{DEFAULT_ROOT}/src/util.c")
    assert clean is not None
    assert clean.change_type is None
    assert tree.status_for_diff(f"{DEFAULT_ROOT}/src/main.c") is not None
    assert tree.status_for_diff(f"{DEFAULT_ROOT}/src/main.c").change_type is ChangeType.MODIFIED


def test_status_for_diff_returns_none_outside_repository(client: GitClient) -> None:
    tree = client.tree_status(DEFAULT_ROOT)
    assert tree.status_for_diff("/etc/hosts") is None


def test_tree_status_scoped_to_workspace(client: GitClient, server: FakeSSHServer) -> None:
    """只扫描工作目录子树：范围外的变更不进入快照。"""
    server.set_file("other/x.c", "a\n")
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    server.write_worktree("other/x.c", "a\nB\n")
    scope = f"{DEFAULT_ROOT}/src"

    tree = client.tree_status(DEFAULT_ROOT, scope=scope)

    assert tree.scope == scope
    assert list(tree.files) == [f"{scope}/main.c"]
    # 范围外的文件不在覆盖范围：必须回退到实时查询，不能误判为「未变更」
    assert tree.status_for_diff(f"{DEFAULT_ROOT}/other/x.c") is None
    assert tree.status_for_diff(f"{scope}/main.c") is not None


def test_tree_status_defaults_to_repository_root(client: GitClient, server: FakeSSHServer) -> None:
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    tree = client.tree_status(DEFAULT_ROOT)
    assert tree.scope == DEFAULT_ROOT
    assert list(tree.files) == [f"{DEFAULT_ROOT}/src/main.c"]


def test_status_for_diff_distrusts_stale_snapshot(client: GitClient, server: FakeSSHServer) -> None:
    """文件在快照生成之后被改过时，「未变更」结论不再可信。"""
    tree = client.tree_status(DEFAULT_ROOT)
    assert tree.status_for_diff(f"{DEFAULT_ROOT}/src/util.c") is not None
    assert tree.status_for_diff(f"{DEFAULT_ROOT}/src/util.c", mtime=tree.fetched_at + 60) is None


def test_status_for_diff_marks_folded_untracked_dir_contents() -> None:
    class UntrackedDirServer(FakeSSHServer):
        def _status_output(self, command: str) -> str:
            return "?? build/\n"

    tree = GitClient(UntrackedDirServer()).tree_status(DEFAULT_ROOT)
    status = tree.status_for_diff(f"{DEFAULT_ROOT}/build/cmake.log")
    assert status is not None
    assert status.untracked is True


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


def test_file_diff_skips_remote_call_for_clean_file(
    client: GitClient, server: FakeSSHServer
) -> None:
    """未变更的文件连 git diff 都不必跑（打开文件的最常见情况）。"""
    tree = client.tree_status(DEFAULT_ROOT)
    status = tree.status_for_diff(f"{DEFAULT_ROOT}/src/main.c")
    server.commands.clear()

    diff = client.file_diff(DEFAULT_ROOT, "src/main.c", content="a\nb\nc\nd\n", status=status)

    assert diff.markers == {}
    assert server.commands == []


def test_file_diff_reuses_snapshot_status(client: GitClient, server: FakeSSHServer) -> None:
    """传入快照状态后不再执行 git status，只跑一次 git diff。"""
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    tree = client.tree_status(DEFAULT_ROOT)
    status = tree.file_status(f"{DEFAULT_ROOT}/src/main.c")

    server.commands.clear()
    diff = client.file_diff(
        DEFAULT_ROOT, "src/main.c", content="a\nB\nc\nd\n", status=status
    )
    assert diff.markers == {2: ChangeType.MODIFIED}
    assert not [command for command in server.commands if "status --porcelain" in command]
    assert len([command for command in server.commands if "diff --no-color" in command]) == 1


def test_file_diff_untracked_from_snapshot_skips_remote_commands(
    client: GitClient, server: FakeSSHServer
) -> None:
    server.write_worktree("src/new.c", "line1\nline2\n")
    tree = client.tree_status(DEFAULT_ROOT)
    status = tree.file_status(f"{DEFAULT_ROOT}/src/new.c")

    server.commands.clear()
    diff = client.file_diff(DEFAULT_ROOT, "src/new.c", content="line1\nline2\n", status=status)
    assert diff.is_new_file
    assert server.commands == []


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

    server = Failing()
    server.set_file("src/main.c", "a\nb\nc\nd\n")
    server.write_worktree("src/main.c", "a\nB\nc\nd\n")
    client = GitClient(server)
    with pytest.raises(GitError):
        client.file_diff(DEFAULT_ROOT, "src/main.c", content="a\n")


def test_head_content(client: GitClient, server: FakeSSHServer) -> None:
    """HEAD 内容查询（调试用）在假服务上返回空字符串。"""
    assert client.head_content(DEFAULT_ROOT, "src/main.c") in (None, "")


# ---------------------------------------------------------------------------
# 保存 / 删除后的本地状态更新（不发起远端命令）
# ---------------------------------------------------------------------------


def test_mark_saved_marks_clean_file_modified(server: FakeSSHServer, client: GitClient) -> None:
    """保存后本地就能把文件标成「已修改」，不需要再跑一次 git status。"""
    tree = client.tree_status(DEFAULT_ROOT)
    assert tree.change_for(f"{DEFAULT_ROOT}/src/main.c") is None

    server.commands.clear()
    assert tree.mark_saved(f"{DEFAULT_ROOT}/src/main.c") is True

    assert server.commands == []
    assert tree.change_for(f"{DEFAULT_ROOT}/src/main.c") is ChangeType.MODIFIED
    assert tree.change_for(f"{DEFAULT_ROOT}/src", is_dir=True) is ChangeType.MODIFIED
    status = tree.status_for_diff(f"{DEFAULT_ROOT}/src/main.c")
    assert status is not None
    assert status.worktree_status == "M"


def test_mark_saved_keeps_untracked_file_green() -> None:
    """未跟踪的新文件保存后仍是未跟踪（git add 之前不该变成「已修改」）。"""
    path = f"{DEFAULT_ROOT}/src/new.c"
    tree = build_tree_status(
        DEFAULT_ROOT,
        statuses={"src/new.c": FileStatus(path="src/new.c", index_status="?", worktree_status="?")},
    )
    assert tree.mark_saved(path) is True
    assert tree.change_for(path) is ChangeType.ADDED
    assert tree.letter_for(path) == "U"


def test_mark_saved_outside_scope_asks_for_refresh() -> None:
    tree = build_tree_status(
        "/repo", statuses={"a.c": FileStatus(path="a.c", worktree_status="M")}, scope="/repo/src"
    )
    assert tree.mark_saved("/repo/other/b.c") is False


def test_mark_saved_clean_clears_colour() -> None:
    """撤销掉全部修改并保存后，标记必须撤掉（否则会一直停在黄色）。"""
    path = f"{DEFAULT_ROOT}/src/main.c"
    tree = build_tree_status(
        DEFAULT_ROOT,
        statuses={"src/main.c": FileStatus(path="src/main.c", worktree_status="M")},
    )
    assert tree.change_for(path) is ChangeType.MODIFIED

    assert tree.mark_saved(path, clean=True) is True

    assert tree.change_for(path) is None
    assert tree.change_for(f"{DEFAULT_ROOT}/src", is_dir=True) is None
    assert tree.change_for(DEFAULT_ROOT, is_dir=True) is None
    status = tree.status_for_diff(path)
    assert status is not None
    assert status.change_type is None


def test_mark_removed_drops_untracked_path() -> None:
    """删掉未跟踪的产物：Git 视角没有变化，快照直接摘掉它。"""
    path = f"{DEFAULT_ROOT}/build"
    tree = build_tree_status(
        DEFAULT_ROOT,
        statuses={"build/": FileStatus(path="build/", index_status="?", worktree_status="?")},
    )
    assert tree.change_for(path, is_dir=True) is ChangeType.ADDED

    assert tree.mark_removed(path) is True

    assert tree.change_for(path, is_dir=True) is None
    assert tree.total == 0


def test_mark_removed_marks_tracked_file_deleted() -> None:
    """删掉已跟踪的文件：与 ``git status`` 的 `` D`` 一致，父目录继续按删除着色。"""
    path = f"{DEFAULT_ROOT}/src/main.c"
    tree = build_tree_status(
        DEFAULT_ROOT,
        statuses={"src/main.c": FileStatus(path="src/main.c", index_status=" ", worktree_status="M")},
    )
    assert tree.mark_removed(path) is True

    assert tree.change_for(path) is ChangeType.DELETED
    assert tree.letter_for(path) == "D"
    assert tree.change_for(f"{DEFAULT_ROOT}/src", is_dir=True) is ChangeType.DELETED
    assert tree.change_for(DEFAULT_ROOT, is_dir=True) is ChangeType.DELETED


def test_mark_removed_without_local_knowledge_asks_for_refresh() -> None:
    """快照里没有这个路径（可能是干净文件，也可能是被忽略的产物）→ 交给远端判断。"""
    tree = build_tree_status(DEFAULT_ROOT, statuses={})
    assert tree.mark_removed(f"{DEFAULT_ROOT}/src/main.c") is False


def test_mark_removed_outside_scope_asks_for_refresh() -> None:
    tree = build_tree_status(
        "/repo", statuses={"a.c": FileStatus(path="a.c", worktree_status="M")}, scope="/repo/src"
    )
    assert tree.mark_removed("/repo/other/b.c") is False


# ---------------------------------------------------------------------------
# 路径工具
# ---------------------------------------------------------------------------


def test_relative_to() -> None:
    assert relative_to("/home/u/proj", "/home/u/proj/src/main.c") == "src/main.c"
    assert relative_to("/home/u/proj/", "/home/u/proj/src/main.c") == "src/main.c"
    assert relative_to("/home/u/proj", "/home/u/proj") == "."
    assert relative_to("/home/u/proj", "/etc/hosts") == "hosts"


# ---------------------------------------------------------------------------
# 提交（源代码管理面板的「提交」按钮）
# ---------------------------------------------------------------------------


def test_commit_all_stages_everything_then_commits(client: GitClient, server: FakeSSHServer) -> None:
    """提交 = 先 ``git add -A``（暂存全部更改）再 ``git commit -m``。"""
    client.commit_all("feat: 新增充电对接", directory=DEFAULT_ROOT)

    assert any("add -A" in command for command in server.commands)
    commit = [c for c in server.commands if "commit -m" in c][-1]
    assert "feat: 新增充电对接" in commit


def test_commit_all_quotes_the_message(client: GitClient, server: FakeSSHServer) -> None:
    """提交信息经过 shell 引号包裹，特殊字符不会破坏命令。"""
    client.commit_all("fix: it's broken; rm -rf /", directory=DEFAULT_ROOT)

    commit = [c for c in server.commands if "commit -m" in c][-1]
    assert shlex.quote("fix: it's broken; rm -rf /") in commit


def test_commit_all_rejects_blank_message(client: GitClient, server: FakeSSHServer) -> None:
    """空白提交信息直接拒绝，不产生任何远端命令。"""
    with pytest.raises(GitError):
        client.commit_all("   ", directory=DEFAULT_ROOT)
    assert not [c for c in server.commands if "commit -m" in c]


def test_commit_all_reports_git_failure(client: GitClient, server: FakeSSHServer) -> None:
    """git 报错时抛出带原因的错误（例如没配 user.name）。"""
    server.fail_commands = True
    with pytest.raises(GitError):
        client.commit_all("chore: 试试", directory=DEFAULT_ROOT)
