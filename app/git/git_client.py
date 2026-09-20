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
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

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
    #: 状态是否来自一次**成功的** ``git status``。命令失败时退回的默认值
    #: 不能当成「未变更」，否则会静默丢掉行级标记。
    known: bool = True

    @property
    def untracked(self) -> bool:
        return self.index_status == "?" and self.worktree_status == "?"

    @property
    def is_deleted(self) -> bool:
        return "D" in (self.index_status + self.worktree_status)

    @property
    def letter(self) -> str:
        """VSCode 风格的变更字母（未变更为空字符串）。"""
        if self.untracked:
            return "U"
        if self.index_status in ("R", "C"):
            return "R"
        if self.is_deleted:
            return "D"
        if "U" in (self.index_status + self.worktree_status):
            return "!"
        if self.index_status == "A":
            return "A"
        if "M" in (self.index_status + self.worktree_status) or self.index_status in ("T", "C"):
            return "M"
        return ""

    @property
    def change_type(self) -> Optional[ChangeType]:
        """把 porcelain 状态码映射到 Gutter / 文件树使用的三类标记。"""
        if self.untracked:
            return ChangeType.ADDED
        codes = self.index_status + self.worktree_status
        if "D" in codes:
            return ChangeType.DELETED
        if "?" in codes or self.index_status == "A":
            return ChangeType.ADDED
        if any(code in codes for code in "MRCTUX"):
            return ChangeType.MODIFIED
        return None

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


#: 目录颜色优先级：同一目录下有多类变更时取优先级最高的一种（与 §4.5 的行标记规则一致）
_CHANGE_PRIORITY = {ChangeType.DELETED: 3, ChangeType.ADDED: 2, ChangeType.MODIFIED: 1}


def merge_change(current: Optional[ChangeType], new: ChangeType) -> ChangeType:
    """按 ``DELETED > ADDED > MODIFIED`` 合并同一目标上的多类变更。"""
    if current is None or _CHANGE_PRIORITY[new] > _CHANGE_PRIORITY[current]:
        return new
    return current


@dataclass
class TreeStatus:
    """整棵文件树的 Git 状态快照（文件树着色 + 单文件 diff 复用）。

    路径一律是**绝对路径**，键与远程文件树控件的 ``PATH_ROLE`` 一致，便于直接着色。
    """

    root: str = ""
    branch: str = ""
    #: 本次 ``status`` 的路径范围（默认整个仓库）；决定「未变更」结论的适用范围
    scope: str = ""
    #: 文件 → 变更类型
    files: Dict[str, ChangeType] = field(default_factory=dict)
    #: 文件 → VSCode 风格字母（U/A/M/D/R/!）
    letters: Dict[str, str] = field(default_factory=dict)
    #: 目录 → 其子树内的最高优先级变更
    dirs: Dict[str, ChangeType] = field(default_factory=dict)
    #: 整体未跟踪（``git status`` 折叠成 ``?? dir/``）的目录
    untracked_dirs: Tuple[str, ...] = ()
    #: 快照生成时间（用于判断「未变更」结论是否仍然可信）
    fetched_at: float = 0.0
    #: ``git status`` 是否成功完成（失败时不能把「没列出」当成「未变更」）
    complete: bool = True
    #: 文件 → 原始 porcelain 状态（供 diff 复用，不参与展示）
    _statuses: Dict[str, "FileStatus"] = field(default_factory=dict, repr=False)

    @property
    def is_repository(self) -> bool:
        return bool(self.root)

    @property
    def total(self) -> int:
        return len(self.files)

    @property
    def counts(self) -> Dict[ChangeType, int]:
        counts: Dict[ChangeType, int] = {}
        for change in self.files.values():
            counts[change] = counts.get(change, 0) + 1
        return counts

    @property
    def label(self) -> str:
        if not self.is_repository:
            return "Git: Not a repository"
        name = self.branch or "unknown"
        return f"Git: {name} · {self.total} 处变更" if self.total else f"Git: {name}"

    def change_for(self, path: str, *, is_dir: bool = False) -> Optional[ChangeType]:
        """取某个路径的变更类型；未变化返回 ``None``（即不染色）。"""
        if path in self.untracked_dirs:
            return ChangeType.ADDED
        for directory in self.untracked_dirs:
            if path.startswith(directory.rstrip("/") + "/"):
                return ChangeType.ADDED
        return self.dirs.get(path) if is_dir else self.files.get(path)

    def changes(self) -> List[Tuple[str, ChangeType, str]]:
        """(绝对路径, 变更类型, 变更字母) 列表，按路径排序（供源代码管理面板使用）。"""
        return [
            (path, change, self.letters.get(path, ""))
            for path, change in sorted(self.files.items())
        ]

    def letter_for(self, path: str) -> str:
        return self.letters.get(path, "")

    def file_status(self, path: str) -> Optional["FileStatus"]:
        """取单文件的原始状态（供 diff 复用，避免再跑一次 ``git status``）。"""
        return self._statuses.get(path)

    def covers(self, path: str) -> bool:
        """该路径是否在快照覆盖范围内（本次 ``git status`` 已完整扫描仓库）。"""
        if not self.complete:
            return False
        base = (self.scope or self.root).rstrip("/")
        if not base:
            return False
        return path == base or path.startswith(base + "/")

    def is_untracked_path(self, path: str) -> bool:
        """路径是否位于 ``git status`` 折叠上报的未跟踪目录内。"""
        for directory in self.untracked_dirs:
            directory = directory.rstrip("/")
            if path == directory or path.startswith(directory + "/"):
                return True
        return False

    def status_for_diff(self, path: str, *, mtime: float = 0.0) -> Optional["FileStatus"]:
        """给单文件 diff 用的状态；能复用快照时就不必再跑 ``git status``。

        * 快照里有该文件 → 返回原始状态；
        * 位于折叠上报的未跟踪目录内 → 返回未跟踪状态；
        * 仓库覆盖范围内的其他路径 → 视为「未变更」（``git status`` 未列出即
          干净），但若文件在快照生成**之后**被改过（``mtime`` 更新），结论不再
          可信，返回 ``None`` 让调用方重新查询；
        * 不在覆盖范围内 → 返回 ``None``。
        """
        direct = self._statuses.get(path)
        if direct is not None:
            return direct
        if self.is_untracked_path(path):
            return FileStatus(path=path, index_status="?", worktree_status="?")
        if not self.covers(path):
            return None
        if mtime and self.fetched_at and mtime > self.fetched_at:
            return None
        return FileStatus(path=path)

    # -- 本地更新 ----------------------------------------------------------
    def mark_change(
        self, path: str, change: ChangeType, *, letter: str = "", status: Optional["FileStatus"] = None
    ) -> bool:
        """在本地给某个文件打上变更标记，不发起任何远端请求。

        保存之后我们本来就知道「这个文件变成了 modified / 仍是未跟踪」，
        没必要为此再跑一次 ``git status``。目录颜色会按新的文件集合重算。
        路径不在快照覆盖范围内时返回 ``False``（调用方应改为远端刷新）。
        """
        if not self.covers(path):
            return False
        previous = self.files.get(path)
        if previous is change and (status is None or self._statuses.get(path) is status):
            return True
        self.files[path] = change
        if letter:
            self.letters[path] = letter
        if status is not None:
            self._statuses[path] = status
        self._recompute_dirs()
        return True

    def _recompute_dirs(self) -> None:
        """按当前 ``files`` / ``untracked_dirs`` 重算目录颜色（纯本地、无 IO）。"""
        base = (self.root or "").rstrip("/")
        self.dirs = {}
        for absolute, change in self.files.items():
            self._propagate(absolute, change, base)
        for absolute in self.untracked_dirs:
            self.dirs[absolute.rstrip("/")] = merge_change(
                self.dirs.get(absolute.rstrip("/")), ChangeType.ADDED
            )
            self._propagate(absolute.rstrip("/"), ChangeType.ADDED, base)

    def _propagate(self, absolute: str, change: ChangeType, base: str) -> None:
        """把文件变更向上传播到目录（含仓库根），与 ``build_tree_status`` 一致。"""
        if not base:
            return
        parent = posixpath.dirname(absolute)
        while parent == base or parent.startswith(base + "/"):
            self.dirs[parent] = merge_change(self.dirs.get(parent), change)
            if parent == base:
                break
            parent = posixpath.dirname(parent)

    def mark_saved(self, path: str, *, clean: bool = False) -> bool:
        """文件刚上传成功：在本地更新它的状态，不发起远端请求。

        未跟踪的新文件在 ``git add`` 之前一直是「未跟踪」（保持绿色）；
        其余情况按「已修改」处理。真正的新文件由创建时的目录刷新负责识别。

        ``clean=True`` 表示上传后内容回到了打开时的样子、且打开时本来就是干净的：
        此时文件相对 ``HEAD`` 依旧干净，必须把着色**撤掉**，否则「撤销修改」之后
        会一直停留在黄色（用户报告的 bug）。
        """
        if clean:
            return self.mark_clean(path)
        previous = self._statuses.get(path)
        if previous is not None and previous.untracked:
            return self.mark_change(
                path,
                ChangeType.ADDED,
                letter="U",
                status=FileStatus(path=path, index_status="?", worktree_status="?"),
            )
        return self.mark_change(
            path,
            ChangeType.MODIFIED,
            letter="M",
            status=FileStatus(path=path, index_status=" ", worktree_status="M"),
        )

    def mark_clean(self, path: str) -> bool:
        """把一个文件标回「未变更」（撤销掉全部修改后使用）。"""
        if not self.covers(path):
            return False
        self.files.pop(path, None)
        self.letters.pop(path, None)
        # 显式记一份「已知且干净」的状态：随后打开这个文件时可以直接跳过 git diff
        self._statuses[path] = FileStatus(path=path)
        self._recompute_dirs()
        return True

    def mark_removed(self, path: str) -> bool:
        """路径刚在远端被删除：在本地更新快照，不发起远端请求。

        * 未跟踪的文件 / 目录被删掉 → 从快照里摘掉（Git 视角没有任何变化）；
        * 已跟踪的文件被删掉 → 记为 ``D``，与 ``git status`` 的 `` D`` 一致，
          父目录继续按删除着色（被删的文件本身会随目录刷新从文件树里消失）。

        路径不在快照覆盖范围内时返回 ``False``（调用方应改为远端刷新）。
        """
        if not self.covers(path):
            return False
        prefix = path.rstrip("/") + "/"
        targets = [item for item in self.files if item == path or item.startswith(prefix)]
        if not targets and not any(
            directory == path or directory.startswith(prefix) for directory in self.untracked_dirs
        ):
            # 快照里没有这个路径：可能是「被跟踪但干净」的文件（Git 会报 ``D``），
            # 也可能是被忽略的产物（Git 什么都不报）。本地判断不了，交给远端兜底。
            return False
        for absolute in targets:
            status = self._statuses.get(absolute)
            if status is not None and status.untracked:
                self.files.pop(absolute, None)
                self.letters.pop(absolute, None)
                self._statuses.pop(absolute, None)
            else:
                self.files[absolute] = ChangeType.DELETED
                self.letters[absolute] = "D"
                self._statuses[absolute] = FileStatus(
                    path=absolute, index_status=" ", worktree_status="D"
                )
        self.untracked_dirs = tuple(
            directory
            for directory in self.untracked_dirs
            if directory != path and not directory.startswith(prefix)
        )
        self._recompute_dirs()
        return True


def build_tree_status(
    root: str,
    *,
    branch: str = "",
    statuses: Optional[Dict[str, FileStatus]] = None,
    scope: str = "",
    complete: bool = True,
) -> TreeStatus:
    """把 ``status_map()`` 的相对路径结果整理成可直接用于着色的树状态快照。"""
    base = (root or "").rstrip("/")
    tree = TreeStatus(
        root=root,
        branch=branch,
        scope=(scope or root).rstrip("/"),
        fetched_at=time.time(),
        complete=complete,
    )
    untracked: List[str] = []
    for relative, status in (statuses or {}).items():
        relative = (relative or "").strip()
        if not relative:
            continue
        change = status.change_type
        if change is None:
            continue
        is_dir_entry = relative.endswith("/")
        absolute = posixpath.normpath(posixpath.join(base or "/", relative.rstrip("/")))
        if is_dir_entry:
            # `git status` 默认把整个未跟踪目录折叠成一条 `?? dir/`
            untracked.append(absolute)
            tree.dirs[absolute] = merge_change(tree.dirs.get(absolute), change)
        else:
            tree.files[absolute] = change
            letter = status.letter
            if letter:
                tree.letters[absolute] = letter
            tree._statuses[absolute] = status

        if base:
            # 目录颜色向上传播到仓库根（含根节点本身），与 VSCode 的资源管理器一致
            tree._propagate(absolute, change, base)
    tree.untracked_dirs = tuple(sorted(untracked))
    return tree


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
        """识别仓库并读取分支信息，任何失败都转成 ``error`` 文本而非抛异常。

        ``--show-toplevel`` 与 ``--abbrev-ref HEAD`` 合并成一次 ``rev-parse``：
        连接 / 切换目录时少一次远端进程与往返。
        """
        try:
            result = self.run(
                ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], directory=directory
            )
        except SSHSessionClosedError as exc:
            return RepoInfo(directory=directory, error=exc.message)
        except Exception as exc:  # pragma: no cover - 网络层已转异常
            return RepoInfo(directory=directory, error=str(exc))
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if not lines:
            return RepoInfo(directory=directory, is_repository=False)
        root = lines[0]
        if not root:
            return RepoInfo(directory=directory, is_repository=False)
        branch = lines[1] if len(lines) > 1 else ""
        if branch in ("", "HEAD"):
            # 未提交过任何 commit 的仓库 / detached HEAD：单独再问一次分支名
            branch = self.current_branch(root)
        return RepoInfo(directory=directory, is_repository=True, root=root, branch=branch)

    # -- 状态 --------------------------------------------------------------
    def status_map(
        self,
        directory: str,
        *,
        path: Optional[str] = None,
        scope: Optional[str] = None,
    ) -> Dict[str, FileStatus]:
        """``git status --porcelain`` → {相对路径: FileStatus}。

        :param scope: 限制扫描范围的目录。大仓库（含 ``build/``、``install/``）
            「整仓库扫描」可能耗时数秒，而界面只展示工作目录下的内容，
            因此默认只扫描工作目录所在子树。
        """
        return self.status_map_result(directory, path=path, scope=scope)[0]

    def status_map_result(
        self,
        directory: str,
        *,
        path: Optional[str] = None,
        scope: Optional[str] = None,
    ) -> Tuple[Dict[str, FileStatus], bool]:
        """同 :meth:`status_map`，但额外返回 ``git status`` 是否成功执行。"""
        args = ["status", "--porcelain"]
        target = path or scope
        if target:
            args += ["--", shlex.quote(target)]
        result = self.run(args, directory=directory)
        if not result.ok:
            logger.warning("git status 失败：%s", (result.stderr or result.stdout).strip()[:200])
            return {}, False
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
        return statuses, True

    def file_status(self, directory: str, relative_path: str) -> FileStatus:
        statuses, ok = self.status_map_result(directory, path=relative_path)
        if not ok:
            # 命令失败：返回「未知」而不是「未变更」，避免静默丢掉行级标记
            return FileStatus(path=relative_path, known=False)
        direct = statuses.get(relative_path)
        if direct is not None:
            return direct
        for name, status in statuses.items():
            if name.endswith(relative_path) or relative_path.endswith(name):
                return status
        return FileStatus(path=relative_path)

    def tree_status(
        self,
        directory: str,
        *,
        info: Optional[RepoInfo] = None,
        scope: Optional[str] = None,
    ) -> TreeStatus:
        """一次调用取回整棵文件树的 Git 状态快照。

        仓库识别 + ``git status --porcelain`` 共两次远端命令，供文件树着色、
        状态栏与单文件 diff 共用，
        避免每打开一个文件都重跑一次 ``git status``。

        :param info: 已缓存的仓库识别结果（来自 :meth:`RemoteSession.repo_info`），
            传入后不再执行 ``rev-parse``。
        :param scope: 只扫描该目录子树（通常是工作目录），大仓库下能省掉
            ``build/``、``install/`` 之类的漫长遍历。
        """
        info = info or self.repo_info(directory)
        if not info.is_repository:
            return TreeStatus()
        try:
            statuses, complete = self.status_map_result(info.root, scope=scope)
        except Exception as exc:  # pragma: no cover - 网络层已转异常
            logger.warning("获取 Git 状态失败 %s：%s", directory, exc)
            statuses, complete = {}, False
        tree = build_tree_status(
            info.root,
            branch=info.branch,
            statuses=statuses,
            scope=scope or info.root,
            complete=complete,
        )
        logger.info("Git 状态快照 %s：%d 个文件、%d 个目录", info.root, tree.total, len(tree.dirs))
        return tree

    # -- Diff --------------------------------------------------------------
    def file_diff(
        self,
        directory: str,
        relative_path: str,
        *,
        content: str = "",
        head: str = "HEAD",
        status: Optional[FileStatus] = None,
    ) -> FileDiff:
        """取“HEAD ↔ 工作区”的行级 diff。

        :param content: 当前编辑器中的文件内容（用于统计行数、识别未跟踪文件）。
        :param status: 已知的文件状态（来自 :class:`TreeStatus` 快照）。
            传入后不再执行 ``git status``，打开文件少一次远端进程与往返。
        """
        total_lines = line_count(content)
        if status is None:
            status = self.file_status(directory, relative_path)

        if status.untracked:
            logger.info("文件未跟踪，整体视为新增: %s", relative_path)
            return build_added_file_diff(relative_path, content)

        if status.known and status.change_type is None:
            # 状态干净 = 工作区 / 索引与 HEAD 一致 → `git diff HEAD` 必为空，
            # 直接省掉一次远端进程（打开未修改的文件是最高频操作）。
            logger.info("文件未变更，跳过 git diff: %s", relative_path)
            return FileDiff(path=relative_path, new_line_count=total_lines)

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

    # -- 提交 --------------------------------------------------------------
    def commit_all(self, message: str, *, directory: Optional[str] = None) -> str:
        """把工作区全部更改暂存并提交（对齐 VSCode 的「全部暂存 + 提交」）。

        返回 ``git commit`` 的输出，供状态栏展示。这是**显式的用户动作**，
        允许产生远端请求（与「打开源代码管理面板零请求」的性能预算互不影响）。
        """
        text = (message or "").strip()
        if not text:
            raise GitError("提交信息不能为空")
        self.run_checked(["add", "-A"], directory=directory, message="暂存更改失败")
        result = self.run_checked(
            ["commit", "-m", shlex.quote(text)],
            directory=directory,
            message="提交失败",
        )
        return (result.stdout or "").strip()


def relative_to(root: str, path: str) -> str:
    """把绝对路径转换成相对仓库根的路径（用于 git 命令参数）。"""
    normalized_root = root.rstrip("/") or "/"
    if path.startswith(normalized_root + "/"):
        return path[len(normalized_root) + 1 :]
    if path == normalized_root:
        return "."
    return posixpath.basename(path)
