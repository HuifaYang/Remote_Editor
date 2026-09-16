"""测试用的假对象：假 SSH 服务、假文件系统、假 Git 仓库。

其中 :class:`FakeSSHServer` 会用 :mod:`difflib` 生成**真实的 unified diff**，
因此可以端到端校验 diff 解析链路（而不是只校验手工编写的 diff 文本）。
"""

from __future__ import annotations

import difflib
import posixpath
import stat
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from app.git.git_client import RepoInfo
from app.remote.remote_fs import FileFingerprint
from app.remote.ssh_client import CommandResult
from app.remote.sftp_client import RemoteEntry
from app.utils.encoding import DecodedText, decode_bytes

DEFAULT_ROOT = "/home/user/project"


@dataclass
class FakeSSHServer:
    """模拟一个带 git 的远端 shell。"""

    root: str = DEFAULT_ROOT
    head: Dict[str, str] = field(default_factory=dict)
    worktree: Dict[str, str] = field(default_factory=dict)
    branch: str = "main"
    has_git: bool = True
    is_repo: bool = True
    fail_commands: bool = False
    commands: List[str] = field(default_factory=list)
    connected: bool = True

    # -- 便捷构造 ----------------------------------------------------------
    def set_file(self, path: str, content: str, *, commit: bool = True) -> None:
        """写入文件；``commit=True`` 时同时更新 HEAD 版本。"""
        self.worktree[path] = content
        if commit:
            self.head[path] = content

    def write_worktree(self, path: str, content: str) -> None:
        self.worktree[path] = content

    def delete_worktree(self, path: str) -> None:
        self.worktree.pop(path, None)

    # -- 命令模拟 ----------------------------------------------------------
    def exec_command(self, command: str, *, timeout: Optional[float] = None) -> CommandResult:
        self.commands.append(command)
        if self.fail_commands:
            return CommandResult(command, 1, "", "permission denied")

        if "command -v git" in command:
            return CommandResult(command, 0 if self.has_git else 1, "/usr/bin/git\n" if self.has_git else "", "")
        if "rev-parse --show-toplevel" in command:
            if not self.is_repo:
                return CommandResult(command, 128, "", "fatal: not a git repository")
            return CommandResult(command, 0, f"{self.root}\n", "")
        if "rev-parse --abbrev-ref HEAD" in command:
            return CommandResult(command, 0, f"{self.branch}\n", "")
        if "status --porcelain" in command:
            return CommandResult(command, 0, self._status_output(command), "")
        if "diff --no-color" in command:
            return CommandResult(command, 0, self._diff_output(command), "")
        if "printf" in command and "$HOME" in command:
            return CommandResult(command, 0, "/home/user", "")
        return CommandResult(command, 0, "", "")

    def close(self) -> None:  # pragma: no cover - 便于 session 复用
        self.connected = False

    def reconnect(self) -> None:  # pragma: no cover
        self.connected = True

    def drop_sftp(self) -> None:  # pragma: no cover
        pass

    def ensure_connected(self) -> None:  # pragma: no cover
        if not self.connected:
            self.connected = True

    @property
    def lock(self):  # pragma: no cover - 供 SftpClient 使用
        import threading

        return threading.RLock()

    # -- 内部 --------------------------------------------------------------
    def _target_path(self, command: str) -> str:
        marker = "-- "
        if marker in command:
            raw = command.split(marker, 1)[1].strip()
            return raw.strip("'\"")
        return ""

    def _status_output(self, command: str) -> str:
        target = self._target_path(command)
        lines: List[str] = []
        paths = [target] if target else sorted(set(self.head) | set(self.worktree))
        for path in paths:
            in_head = path in self.head
            in_work = path in self.worktree
            if not in_head and in_work:
                lines.append(f"?? {path}")
            elif in_head and not in_work:
                lines.append(f" D {path}")
            elif in_head and in_work and self.head[path] != self.worktree[path]:
                lines.append(f" M {path}")
        return "".join(line + "\n" for line in lines)

    def _diff_output(self, command: str) -> str:
        target = self._target_path(command)
        in_head = target in self.head
        in_work = target in self.worktree
        if not in_head and in_work:
            # 未跟踪文件：git diff 不会输出内容
            return ""
        if in_head and not in_work:
            # 已删除文件：git 输出 deleted file mode + 完整删除 hunk
            lines = self.head[target].splitlines(keepends=True)
            header = [
                f"diff --git a/{target} b/{target}\n",
                "deleted file mode 100644\n",
                f"--- a/{target}\n",
                "+++ /dev/null\n",
                f"@@ -1,{len(lines)} +0,0 @@\n",
            ]
            return "".join(header + [f"-{line}" for line in lines])
        old = self.head.get(target, "").splitlines(keepends=True)
        new = self.worktree.get(target, "").splitlines(keepends=True)
        if old == new:
            return ""
        diff = difflib.unified_diff(old, new, fromfile=f"a/{target}", tofile=f"b/{target}", n=3)
        return "".join(diff)


class FakeFileSystem:
    """模拟 :class:`app.remote.remote_fs.RemoteFileSystem`。"""

    def __init__(self) -> None:
        self.directories: Dict[str, List[RemoteEntry]] = {}
        self.files: Dict[str, str] = {}
        self._mtime: Dict[str, float] = {}
        self.fail_on_read: Optional[Exception] = None
        self.fail_on_write: Optional[Exception] = None
        self.writes: List[tuple] = []
        self.deleted: List[str] = []
        self.renamed: List[tuple] = []
        self.created: List[str] = []

    # -- 帮助方法 ----------------------------------------------------------
    def add_file(self, path: str, content: str = "") -> None:
        self.files[path] = content
        self._mtime[path] = time.time()
        directory = posixpath.dirname(path)
        entries = self.directories.setdefault(directory, [])
        if not any(entry.path == path for entry in entries):
            entries.append(
                RemoteEntry(
                    name=posixpath.basename(path),
                    path=path,
                    is_dir=False,
                    size=len(content.encode("utf-8")),
                    mtime=time.time(),
                    mode=stat.S_IFREG | 0o644,
                )
            )

    def add_directory(self, path: str) -> None:
        parent = posixpath.dirname(path)
        self.directories.setdefault(path, [])
        entries = self.directories.setdefault(parent, [])
        if not any(entry.path == path for entry in entries):
            entries.append(
                RemoteEntry(
                    name=posixpath.basename(path),
                    path=path,
                    is_dir=True,
                    mtime=time.time(),
                    mode=stat.S_IFDIR | 0o755,
                )
            )

    # -- 接口 --------------------------------------------------------------
    def list_dir(self, path: str) -> List[RemoteEntry]:
        return list(self.directories.get(path, []))

    def read_text(self, path, *, encoding=None, max_bytes=None) -> DecodedText:
        if self.fail_on_read is not None:
            raise self.fail_on_read
        if path not in self.files:
            from app.utils.errors import RemoteFileNotFoundError

            raise RemoteFileNotFoundError(f"文件不存在：{path}")
        raw = self.files[path].encode("utf-8")
        if max_bytes is not None and len(raw) > max_bytes:
            from app.utils.errors import SFTError

            raise SFTError("文件过大")
        return decode_bytes(raw, encoding=encoding)

    def write_text(self, path, text, *, encoding="utf-8", newline="\n") -> None:
        if self.fail_on_write is not None:
            raise self.fail_on_write
        self.writes.append((path, text, encoding, newline))
        self.files[path] = text
        self.add_file(path, text)

    def fingerprint(self, path: str) -> Optional[FileFingerprint]:
        if path not in self.files:
            return None
        content = self.files[path]
        return FileFingerprint(
            path=path,
            size=len(content.encode("utf-8")),
            mtime=self._mtime.get(path, 0.0),
        )

    def create_file(self, path: str, *, content: str = "", encoding: str = "utf-8") -> None:
        self.created.append(path)
        self.files[path] = content
        self.add_file(path, content)

    def create_dir(self, path: str, *, parents: bool = False) -> None:
        self.created.append(path)
        self.add_directory(path)

    def delete(self, path: str, *, is_dir=None, recursive: bool = False) -> None:
        self.deleted.append(path)
        self.files.pop(path, None)
        self.directories.pop(path, None)

    def rename(self, source: str, target: str, *, overwrite: bool = False) -> None:
        self.renamed.append((source, target))
        if source in self.files:
            self.files[target] = self.files.pop(source)

    def exists(self, path: str) -> bool:
        return path in self.files or path in self.directories

    def is_dir(self, path: str) -> bool:
        return path in self.directories

    def stat(self, path: str) -> RemoteEntry:
        from app.utils.errors import RemoteFileNotFoundError

        for entries in self.directories.values():
            for entry in entries:
                if entry.path == path:
                    return entry
        if path in self.files:
            return RemoteEntry(
                name=posixpath.basename(path),
                path=path,
                is_dir=False,
                size=len(self.files[path].encode("utf-8")),
                mtime=time.time(),
            )
        raise RemoteFileNotFoundError(f"路径不存在：{path}")

    def parent(self, path: str) -> str:
        return posixpath.dirname(path.rstrip("/")) or "/"

    def join(self, *parts: str) -> str:
        return posixpath.join(*parts)


class FakeGitClient:
    """模拟 :class:`app.git.git_client.GitClient`。"""

    def __init__(self, repo: Optional[RepoInfo] = None, diff_text: str = "") -> None:
        self.repo = repo or RepoInfo(
            directory=DEFAULT_ROOT, is_repository=True, root=DEFAULT_ROOT, branch="main"
        )
        self.diff_text = diff_text
        self.diff_calls: List[tuple] = []

    def repo_info(self, directory: str) -> RepoInfo:  # noqa: D401
        return self.repo

    def is_repository(self, directory: str) -> bool:
        return self.repo.is_repository

    def file_diff(self, directory: str, relative_path: str, *, content: str = "", head: str = "HEAD"):
        from app.git.diff_parser import build_file_diff, build_added_file_diff, line_count

        self.diff_calls.append((directory, relative_path, content))
        if self.diff_text:
            return build_file_diff(
                self.diff_text, path=relative_path, new_line_count=line_count(content)
            )
        return build_added_file_diff(relative_path, content)


class FakeSession:
    """可直接注入 MainWindow 的假会话。"""

    def __init__(self, host=None, workspace: str = DEFAULT_ROOT) -> None:
        from app.config.hosts import HostConfig

        self.host = host or HostConfig(name="Robot-3566", host="192.168.1.100")
        self.workspace = workspace
        self.fs = FakeFileSystem()
        self.git = FakeGitClient()
        self.ssh = FakeSSHServer(root=workspace)
        self.connected = True
        self.closed = False
        self._repo_info = self.git.repo

    def connect(self) -> None:  # pragma: no cover - 已连接
        self.connected = True

    def close(self) -> None:
        self.closed = True
        self.connected = False

    def reconnect(self) -> None:  # pragma: no cover
        self.connected = True

    def repo_info(self, *, refresh: bool = False) -> RepoInfo:
        return self._repo_info

    def set_workspace(self, path: str) -> None:
        self.workspace = path

    def state(self):  # pragma: no cover - 状态栏用
        from app.remote.session import SessionState

        return SessionState(
            host_name=self.host.display_name,
            connected=self.connected,
            workspace=self.workspace,
            repo=self._repo_info,
        )
