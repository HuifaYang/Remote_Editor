"""通过 SSH 执行轻量 Git 原生命令，并在本地解析 Diff。

约束（见需求文档 5.7.4）：

* 远端不部署任何 Git 服务，只按需执行 ``git rev-parse`` / ``git status`` / ``git diff``；
* diff 文本回传本地，由 :mod:`app.git.diff_parser` 解析；
* 不下载整个仓库、不建索引、不常驻进程。
"""

from __future__ import annotations

import logging
import posixpath
import shlex
from dataclasses import dataclass
from typing import Dict, List, Optional

from app.git.diff_parser import build_added_file_diff, build_file_diff, line_count
from app.git.models import ChangeType, FileDiff
from app.remote.ssh_client import CommandResult, SSHClient
from app.utils.errors import GitError, SSHSessionClosedError

logger = logging.getLogger(__name__)

GIT_TIMEOUT = 30.0


@dataclass
class RepoInfo:
    """仓库识别结果。"""

    directory: str = ""
    is_repository: bool = False
    root: str = ""
    branch: str = ""
    error: str = ""

    @property
    def label(self) -> str:
        if not self.is_repository:
            return "Git: Not a repository"
        return f"Git: {self.branch or 'unknown'}"


@dataclass
class FileStatus:
    """``git status --porcelain`` 的解析结果。"""

    path: str
    index_status: str = " "
    worktree_status: str = " "

    @property
    def untracked(self) -> bool:
        return self.index_status == "?" and self.worktree_status == "?"

    @property
    def is_deleted(self) -> bool:
        return "D" in (self.index_status + self.worktree_status)

    @property
    def label(self) -> str:
        mapping = {
            "M": "已修改",
            "A": "新增",
            "D": "已删除",
            "R": "重命名",
            "C": "复制",
            "?": "未跟踪",
            "!": "忽略",
            "U": "冲突",
            " ": "未变更",
        }
        codes = {code for code in (self.index_status + self.worktree_status) if code != " "}
        if not codes:
            return "未变更"
        return "/".join(mapping.get(code, code) for code in sorted(codes))


class GitClient:
    """基于 SSH 命令通道的 Git 客户端。"""

    def __init__(self, ssh: SSHClient) -> None:
        self._ssh = ssh

    # -- 基础命令 ----------------------------------------------------------
    def _git_command(self, args: List[str], directory: Optional[str] = None) -> str:
        parts = ["git", "--no-pager", "-c", "color.ui=false", "-c", "core.quotepath=false"]
        if directory:
            parts += ["-C", shlex.quote(directory)]
        parts += args
        return " ".join(parts)

    def run(
        self,
        args: List[str],
        *,
        directory: Optional[str] = None,
        timeout: float = GIT_TIMEOUT,
    ) -> CommandResult:
        """执行 git 子命令（不抛异常，返回结果）。"""
        command = self._git_command(args, directory)
        return self._ssh.exec_command(command, timeout=timeout)

    def run_checked(
        self,
        args: List[str],
        *,
        directory: Optional[str] = None,
        message: str = "Git 命令执行失败",
        timeout: float = GIT_TIMEOUT,
    ) -> CommandResult:
        result = self.run(args, directory=directory, timeout=timeout)
        if not result.ok:
            detail = (result.stderr or result.stdout).strip()
            raise GitError(f"{message}：{detail[:300]}" if detail else message)
        return result

    # -- 仓库识别 ----------------------------------------------------------
    def repository_root(self, directory: str) -> Optional[str]:
        """返回仓库根目录；不是仓库时返回 ``None``。"""
        result = self.run(["rev-parse", "--show-toplevel"], directory=directory)
        if not result.ok:
            return None
        root = result.stdout.strip().splitlines()
        if not root:
            return None
        value = root[0].strip()
        return value or None

    def is_repository(self, directory: str) -> bool:
        return self.repository_root(directory) is not None

    def current_branch(self, directory: str) -> str:
        result = self.run(["rev-parse", "--abbrev-ref", "HEAD"], directory=directory)
        if not result.ok:
            return ""
        name = result.stdout.strip()
        return name if name and name != "HEAD" else "detached HEAD"

    def repo_info(self, directory: str) -> RepoInfo:
        """识别仓库并读取分支信息，任何失败都转成 ``error`` 文本而非抛异常。"""
        try:
            root = self.repository_root(directory)
        except SSHSessionClosedError as exc:
            return RepoInfo(directory=directory, error=exc.message)
        except Exception as exc:  # pragma: no cover - 网络层已转异常
            return RepoInfo(directory=directory, error=str(exc))
        if not root:
            return RepoInfo(directory=directory, is_repository=False)
        branch = self.current_branch(root)
        return RepoInfo(directory=directory, is_repository=True, root=root, branch=branch)

    # -- 状态 --------------------------------------------------------------
    def status_map(self, directory: str, *, path: Optional[str] = None) -> Dict[str, FileStatus]:
        """``git status --porcelain`` → {相对路径: FileStatus}。"""
        args = ["status", "--porcelain"]
        if path:
            args += ["--", path]
        result = self.run(args, directory=directory)
        if not result.ok:
            return {}
        statuses: Dict[str, FileStatus] = {}
        for raw in result.stdout.splitlines():
            if len(raw) < 4:
                continue
            index_status, worktree_status = raw[0], raw[1]
            name = raw[3:].strip()
            if " -> " in name:  # rename: "old -> new"
                name = name.split(" -> ")[-1].strip()
            name = name.strip('"')
            statuses[name] = FileStatus(
                path=name, index_status=index_status, worktree_status=worktree_status
            )
        return statuses

    def file_status(self, directory: str, relative_path: str) -> FileStatus:
        statuses = self.status_map(directory, path=relative_path)
        direct = statuses.get(relative_path)
        if direct is not None:
            return direct
        for name, status in statuses.items():
            if name.endswith(relative_path) or relative_path.endswith(name):
                return status
        return FileStatus(path=relative_path)

    # -- Diff --------------------------------------------------------------
    def file_diff(
        self,
        directory: str,
        relative_path: str,
        *,
        content: str = "",
        head: str = "HEAD",
    ) -> FileDiff:
        """取“HEAD ↔ 工作区”的行级 diff。

        :param content: 当前编辑器中的文件内容（用于统计行数、识别未跟踪文件）。
        """
        total_lines = line_count(content)
        status = self.file_status(directory, relative_path)

        if status.untracked:
            logger.info("文件未跟踪，整体视为新增: %s", relative_path)
            return build_added_file_diff(relative_path, content)

        result = self.run(["diff", "--no-color", head, "--", relative_path], directory=directory)
        if not result.ok:
            detail = (result.stderr or result.stdout).strip()
            raise GitError(f"获取 Git diff 失败：{detail[:300]}" if detail else "获取 Git diff 失败")

        diff = build_file_diff(result.stdout, path=relative_path, new_line_count=total_lines)
        if not diff.markers and status.is_deleted:
            diff.is_deleted_file = True
        logger.info(
            "Git diff %s: %s (hunks=%d)", relative_path, diff.summary, diff.hunk_count
        )
        return diff

    def head_content(self, directory: str, relative_path: str) -> Optional[str]:
        """取 HEAD 版本内容（调试 / 对比用，非必须）。"""
        result = self.run(["show", f"HEAD:{relative_path}"], directory=directory)
        if not result.ok:
            return None
        return result.stdout

    def marker_counts(self, diff: FileDiff) -> Dict[ChangeType, int]:
        counts = {ChangeType.ADDED: 0, ChangeType.MODIFIED: 0, ChangeType.DELETED: 0}
        for change in diff.markers.values():
            counts[change] += 1
        return counts


def relative_to(root: str, path: str) -> str:
    """把绝对路径转换成相对仓库根的路径（用于 git 命令参数）。"""
    normalized_root = root.rstrip("/") or "/"
    if path.startswith(normalized_root + "/"):
        return path[len(normalized_root) + 1 :]
    if path == normalized_root:
        return "."
    return posixpath.basename(path)
