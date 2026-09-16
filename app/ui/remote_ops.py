"""远程操作编排层。

GUI 与网络层之间的胶水：只做「调用 + 组装数据」，不涉及任何 Qt 控件，
因此可以安全地在工作线程中执行，也便于用假对象做单元测试。
"""

from __future__ import annotations

import logging
import posixpath
from dataclasses import dataclass
from typing import List, Optional

from app.editor.syntax import detect_language
from app.git.git_client import RepoInfo, relative_to
from app.git.models import FileDiff
from app.remote.remote_fs import FileFingerprint
from app.remote.session import RemoteSession, SessionState
from app.remote.sftp_client import RemoteEntry
from app.utils.encoding import detect_newline

logger = logging.getLogger(__name__)


@dataclass
class LoadedFile:
    """一次文件下载的结果。"""

    path: str
    text: str
    encoding: str
    newline: str
    size: int
    fingerprint: FileFingerprint
    language: str


@dataclass
class SavedFile:
    """一次上传的结果。"""

    path: str
    fingerprint: Optional[FileFingerprint]
    size: int


# ---------------------------------------------------------------------------
# 连接 / 目录
# ---------------------------------------------------------------------------


def open_session(session: RemoteSession) -> SessionState:
    """建立连接并返回状态快照。"""
    session.connect()
    session.repo_info(refresh=True)
    return session.state()


def close_session(session: RemoteSession) -> None:
    session.close()


def list_directory(session: RemoteSession, path: str) -> tuple[str, List[RemoteEntry]]:
    """列出目录，返回 (路径, 条目列表)。"""
    return path, session.fs.list_dir(path)


# ---------------------------------------------------------------------------
# 文件读写
# ---------------------------------------------------------------------------


def load_file(
    session: RemoteSession,
    path: str,
    *,
    encoding: Optional[str] = None,
    max_bytes: Optional[int] = None,
) -> LoadedFile:
    """下载并解码远程文件。"""
    fingerprint = session.fs.fingerprint(path)
    decoded = session.fs.read_text(path, encoding=encoding, max_bytes=max_bytes)
    return LoadedFile(
        path=path,
        text=decoded.text,
        encoding=decoded.encoding,
        newline=detect_newline(decoded.text),
        size=len(decoded.text.encode(decoded.encoding, errors="replace")),
        fingerprint=fingerprint or FileFingerprint(path=path, size=0, mtime=0.0),
        language=detect_language(path),
    )


def save_file(
    session: RemoteSession,
    path: str,
    text: str,
    *,
    encoding: str = "utf-8",
    newline: str = "\n",
) -> SavedFile:
    """上传文本并按原编码写回，返回新的文件指纹。"""
    session.fs.write_text(path, text, encoding=encoding, newline=newline)
    fingerprint = session.fs.fingerprint(path)
    return SavedFile(
        path=path,
        fingerprint=fingerprint,
        size=len(text.encode(encoding, errors="replace")),
    )


def create_file(session: RemoteSession, path: str, *, content: str = "") -> str:
    session.fs.create_file(path, content=content)
    return path


def create_directory(session: RemoteSession, path: str) -> str:
    session.fs.create_dir(path)
    return path


def delete_path(session: RemoteSession, path: str) -> str:
    session.fs.delete(path)
    return path


def rename_path(session: RemoteSession, source: str, target: str) -> tuple[str, str]:
    session.fs.rename(source, target)
    return source, target


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------


def load_repo_info(session: RemoteSession, directory: Optional[str] = None) -> RepoInfo:
    """识别仓库（用于状态栏显示）。"""
    return session.git.repo_info(directory or session.workspace or "/")


def load_git_diff(session: RemoteSession, path: str, content: str) -> FileDiff:
    """获取并解析当前文件相对 HEAD 的行级差异。"""
    repo = session.repo_info()
    if not repo.is_repository:
        logger.info("当前目录不是 Git 仓库，跳过 diff：%s", path)
        return FileDiff(path=path)
    relative = relative_to(repo.root, path)
    return session.git.file_diff(repo.root, relative, content=content)


def git_available(session: RemoteSession) -> bool:
    """检查远端是否具备 git（缺失时不应报错崩溃）。"""
    try:
        result = session.ssh.exec_command("command -v git", timeout=10)
    except Exception:  # pragma: no cover - 网络异常
        return False
    return result.ok and bool(result.stdout.strip())


def join_path(*parts: str) -> str:
    return posixpath.join(*parts)
