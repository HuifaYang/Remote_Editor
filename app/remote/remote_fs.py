"""远程文件系统高层门面。

把 SSH / SFTP 细节收敛在这里，UI 只调用本类的语义化方法：
``list_dir`` / ``read_text`` / ``write_text`` / ``create_file`` / ``delete`` / ``rename`` 等。
"""

from __future__ import annotations

import logging
import posixpath
from dataclasses import dataclass
from typing import List, Optional

from app.remote.ssh_client import SSHClient
from app.remote.sftp_client import RemoteEntry, SftpClient
from app.utils.encoding import DecodedText
from app.utils.errors import SFTError

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FileFingerprint:
    """远程文件指纹，用于保存前的冲突检测。"""

    path: str
    size: int
    mtime: float

    def differs_from(self, other: Optional["FileFingerprint"]) -> bool:
        if other is None:
            return True
        return (self.size, round(self.mtime, 3)) != (other.size, round(other.mtime, 3))

    @property
    def label(self) -> str:
        return f"{self.size} bytes @ {self.mtime:.0f}"


class RemoteFileSystem:
    """远程文件操作门面。"""

    def __init__(self, ssh: SSHClient) -> None:
        self._ssh = ssh
        self.sftp = SftpClient(ssh)

    # -- 查询 --------------------------------------------------------------
    def list_dir(self, path: str) -> List[RemoteEntry]:
        return self.sftp.list_dir(path)

    def stat(self, path: str) -> RemoteEntry:
        return self.sftp.stat(path)

    def exists(self, path: str) -> bool:
        return self.sftp.exists(path)

    def is_dir(self, path: str) -> bool:
        try:
            return self.sftp.stat(path).is_dir
        except SFTError:
            return False

    def fingerprint(self, path: str) -> Optional[FileFingerprint]:
        """取文件指纹；文件不存在返回 ``None``。"""
        try:
            entry = self.sftp.stat(path)
        except SFTError:
            return None
        return FileFingerprint(path=path, size=entry.size, mtime=entry.mtime)

    # -- 读写 --------------------------------------------------------------
    def read_text(
        self,
        path: str,
        *,
        encoding: Optional[str] = None,
        max_bytes: Optional[int] = None,
    ) -> DecodedText:
        return self.sftp.read_text(path, encoding=encoding, max_bytes=max_bytes)

    def write_text(
        self,
        path: str,
        text: str,
        *,
        encoding: str = "utf-8",
        newline: str = "\n",
    ) -> None:
        self.sftp.write_text(path, text, encoding=encoding, newline=newline)

    # -- 结构与重命名 ------------------------------------------------------
    def create_file(self, path: str, *, content: str = "", encoding: str = "utf-8") -> None:
        self.sftp.create_file(path, content=content, encoding=encoding)

    def create_dir(self, path: str, *, parents: bool = False) -> None:
        self.sftp.mkdir(path, parents=parents)

    def delete(self, path: str, *, is_dir: Optional[bool] = None, recursive: bool = False) -> None:
        if is_dir is None:
            is_dir = self.is_dir(path)
        self.sftp.remove(path, is_dir=is_dir, recursive=recursive)

    def rename(self, source: str, target: str, *, overwrite: bool = False) -> None:
        self.sftp.rename(source, target, overwrite=overwrite)

    def join(self, *parts: str) -> str:
        """远程路径拼接（始终使用 POSIX 语义）。"""
        return posixpath.join(*parts)

    def parent(self, path: str) -> str:
        return posixpath.dirname(path.rstrip("/")) or "/"

    def basename(self, path: str) -> str:
        return posixpath.basename(path.rstrip("/"))
