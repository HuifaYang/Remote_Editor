"""远程操作编排层。

GUI 与网络层之间的胶水：只做「调用 + 组装数据」，不涉及任何 Qt 控件，
因此可以安全地在工作线程中执行，也便于用假对象做单元测试。
"""

from __future__ import annotations

import logging
import posixpath
import time
from dataclasses import dataclass
from typing import List, Optional

from app.editor.syntax import detect_language
from app.git.git_client import FileStatus, RepoInfo, TreeStatus, relative_to
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
    #: 下载耗时（毫秒），用于排查「打开文件慢」时定位在哪一段
    elapsed_ms: float = 0.0


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
    started = time.perf_counter()
    entries = session.fs.list_dir(path)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    logger.info("列目录 %s：%d 项，%.0f ms", path, len(entries), elapsed_ms)
    return path, entries


def remote_home(session: RemoteSession) -> str:
    """远端家目录（会话内已缓存，不会重复执行命令）。"""
    return session.remote_home()


def list_subdirectories(session: RemoteSession, path: str) -> tuple[str, List[RemoteEntry]]:
    """列出目录下的**子目录**，用于工作目录选择器。

    ``~`` 与相对路径在这里（工作线程内）展开为绝对路径，避免 GUI 线程
    为了取家目录而阻塞；返回值中的路径即为展开后的结果。
    """
    resolved = session.expand_path(path)
    entries = [entry for entry in session.fs.list_dir(resolved) if entry.is_dir]
    return resolved, entries


def parent_of(path: str) -> str:
    """远程路径的上一级目录（POSIX 语义）。"""
    return posixpath.dirname(path.rstrip("/")) or "/"


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
    """下载并解码远程文件（下载与指纹采集共用一次 SFTP 会话）。"""
    started = time.perf_counter()
    decoded, entry = session.fs.read_text_with_stat(
        path, encoding=encoding, max_bytes=max_bytes
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    logger.info("下载完成 %s（%.0f ms，%d 字节）", path, elapsed_ms, entry.size)
    return LoadedFile(
        path=path,
        text=decoded.text,
        encoding=decoded.encoding,
        newline=detect_newline(decoded.text),
        size=entry.size,
        fingerprint=FileFingerprint(path=path, size=entry.size, mtime=entry.mtime),
        language=detect_language(path),
        elapsed_ms=elapsed_ms,
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


def load_tree_status(
    session: RemoteSession, directory: Optional[str] = None
) -> TreeStatus:
    """取整棵工作目录树的 Git 状态快照（文件树着色 + diff 复用）。

    复用会话已缓存的仓库识别结果，因此只有一个 ``git status`` 远端命令。
    """
    started = time.perf_counter()
    repo = session.repo_info()
    target = directory or session.workspace or repo.root or "/"
    if not repo.is_repository:
        # 目录本身不在仓库里时再确认一次（例如刚切换过工作目录）
        repo = session.git.repo_info(target)
        if not repo.is_repository:
            logger.info("当前目录不是 Git 仓库，跳过状态快照：%s", target)
            return TreeStatus()
    # 只扫描工作目录子树：界面上看到的都在这个范围内，大仓库（build/、install/）
    # 可以省掉整仓库遍历
    tree = session.git.tree_status(repo.root, info=repo, scope=target)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    logger.info(
        "Git 状态快照：%s（范围 %s，%d 处变更，%.0f ms）",
        repo.branch or "-",
        tree.scope or repo.root,
        tree.total,
        elapsed_ms,
    )
    return tree


def load_git_diff(
    session: RemoteSession,
    path: str,
    content: str,
    *,
    status: Optional[FileStatus] = None,
) -> FileDiff:
    """获取并解析当前文件相对 HEAD 的行级差异。

    :param status: 来自 :func:`load_tree_status` 的快照状态；传入后省掉一次
        ``git status`` 远端进程。
    """
    started = time.perf_counter()
    repo = session.repo_info()
    if not repo.is_repository:
        logger.info("当前目录不是 Git 仓库，跳过 diff：%s", path)
        return FileDiff(path=path)
    relative = relative_to(repo.root, path)
    diff = session.git.file_diff(repo.root, relative, content=content, status=status)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    logger.info(
        "Git diff %s：%s（状态来源=%s，%.0f ms）",
        relative,
        diff.summary,
        "快照" if status is not None and status.known else "实时查询",
        elapsed_ms,
    )
    return diff


def git_available(session: RemoteSession) -> bool:
    """检查远端是否具备 git（缺失时不应报错崩溃）。"""
    try:
        result = session.ssh.exec_command("command -v git", timeout=10)
    except Exception:  # pragma: no cover - 网络异常
        return False
    return result.ok and bool(result.stdout.strip())


def join_path(*parts: str) -> str:
    return posixpath.join(*parts)
