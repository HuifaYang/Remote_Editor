"""SFTP 文件操作封装。

* 目录列表 / 上传 / 下载 / 新建 / 删除 / 重命名 / 属性查询；
* 统一异常类型，UI 层不感知 paramiko；
* 写入采用「临时文件 + 原子替换」，避免上传中断导致远程文件损坏；
* 所有操作通过 :class:`SSHClient` 的锁串行化（paramiko SFTP 会话非线程安全）。
"""

from __future__ import annotations

import errno
import logging
import posixpath
import stat
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Iterable, List, Optional, Tuple

import paramiko

from app.remote.ssh_client import SSHClient
from app.utils.encoding import DecodedText, decode_bytes, encode_text
from app.utils.errors import (
    RemoteFileNotFoundError,
    RemotePermissionError,
    SFTError,
    SSHSessionClosedError,
)

logger = logging.getLogger(__name__)

CHUNK_SIZE = 64 * 1024
TMP_PREFIX = ".rce-upload-"


@dataclass(frozen=True)
class RemoteEntry:
    """远程文件 / 目录条目。"""

    name: str
    path: str
    is_dir: bool
    size: int = 0
    mtime: float = 0.0
    mode: int = 0
    is_symlink: bool = False

    @property
    def kind_label(self) -> str:
        if self.is_dir:
            return "目录"
        if self.is_symlink:
            return "符号链接"
        return "文件"

    @property
    def size_label(self) -> str:
        if self.is_dir:
            return "-"
        return human_size(self.size)

    @property
    def mtime_label(self) -> str:
        if not self.mtime:
            return "-"
        try:
            return datetime.fromtimestamp(self.mtime).strftime("%Y-%m-%d %H:%M")
        except (OSError, OverflowError, ValueError):  # pragma: no cover
            return "-"

    @property
    def permission_label(self) -> str:
        return stat.filemode(self.mode) if self.mode else "-"


def human_size(size: int) -> str:
    """人类可读的文件大小。"""
    value = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"  # pragma: no cover


class SftpClient:
    """面向业务的高层 SFTP 接口。"""

    def __init__(self, ssh: SSHClient) -> None:
        self._ssh = ssh

    # -- 基础 --------------------------------------------------------------
    def _session(self) -> paramiko.SFTPClient:
        try:
            return self._ssh.open_sftp()
        except Exception as exc:  # 统一转换
            raise self._translate(exc) from exc

    def _translate(self, exc: BaseException) -> Exception:
        if isinstance(exc, (RemoteFileNotFoundError, RemotePermissionError, SFTError)):
            return exc
        if isinstance(exc, SSHSessionClosedError):
            return exc
        if isinstance(exc, IOError) or isinstance(exc, OSError):
            code = getattr(exc, "errno", None)
            if code == errno.ENOENT:
                return RemoteFileNotFoundError(detail=str(exc))
            if code in (errno.EACCES, errno.EPERM):
                return RemotePermissionError(detail=str(exc))
            if code == errno.EEXIST:
                return SFTError("目标已存在", detail=str(exc))
            return SFTError(str(exc), detail=str(exc))
        if isinstance(exc, paramiko.SSHException):
            return SSHSessionClosedError(f"SFTP 会话异常：{exc}", detail=str(exc))
        return SFTError(str(exc), detail=str(exc))

    def _call(self, func: Callable[..., object], *args: object, **kwargs: object) -> object:
        with self._ssh.sftp_lock:
            try:
                return func(*args, **kwargs)
            except Exception as exc:
                raise self._translate(exc) from exc

    # -- 查询 --------------------------------------------------------------
    def exists(self, path: str) -> bool:
        try:
            self.stat(path)
            return True
        except RemoteFileNotFoundError:
            return False

    def stat(self, path: str) -> RemoteEntry:
        sftp = self._session()
        result = self._call(sftp.stat, path)
        return self._to_entry(path, result)

    def lstat(self, path: str) -> RemoteEntry:
        sftp = self._session()
        result = self._call(sftp.lstat, path)
        return self._to_entry(path, result)

    def list_dir(self, path: str) -> List[RemoteEntry]:
        """列出目录内容，目录在前、按名称排序。"""
        sftp = self._session()
        try:
            attributes = self._call(sftp.listdir_attr, path)
        except SFTError:
            raise
        entries: List[RemoteEntry] = []
        for attr in attributes:  # type: ignore[union-attr]
            name = attr.filename
            if name in (".", ".."):
                continue
            is_symlink = stat.S_ISLNK(attr.st_mode or 0)
            is_dir = stat.S_ISDIR(attr.st_mode or 0)
            full = posixpath.join(path.rstrip("/") or "/", name)
            if is_symlink and not is_dir:
                # 跟随符号链接，指向目录时按目录展示
                try:
                    target = self._call(sftp.stat, full)
                    is_dir = stat.S_ISDIR(getattr(target, "st_mode", 0) or 0)
                except Exception:  # pragma: no cover - 断链
                    is_dir = False
            entries.append(
                RemoteEntry(
                    name=name,
                    path=full,
                    is_dir=is_dir,
                    size=int(attr.st_size or 0),
                    mtime=float(attr.st_mtime or 0),
                    mode=int(attr.st_mode or 0),
                    is_symlink=is_symlink,
                )
            )
        entries.sort(key=lambda item: (not item.is_dir, item.name.lower()))
        return entries

    # -- 读取 --------------------------------------------------------------
    def read_bytes(self, path: str, *, max_bytes: Optional[int] = None) -> bytes:
        """读取整个文件；``max_bytes`` 用于拒绝超大文件。"""
        return self._read_all(path, max_bytes=max_bytes)[0]

    def read_text(
        self, path: str, *, encoding: Optional[str] = None, max_bytes: Optional[int] = None
    ) -> DecodedText:
        """读取并解码文本文件。"""
        return self.read_text_with_stat(path, encoding=encoding, max_bytes=max_bytes)[0]

    def read_text_with_stat(
        self, path: str, *, encoding: Optional[str] = None, max_bytes: Optional[int] = None
    ) -> Tuple[DecodedText, RemoteEntry]:
        """读取并解码文本文件，同时返回文件元信息（大小 / 修改时间）。

        供「下载 + 保存前冲突检测所需指纹」一次性完成，避免额外的 ``stat`` 往返。
        """
        data, entry = self._read_all(path, max_bytes=max_bytes)
        decoded = decode_bytes(data, encoding=encoding)
        if entry is None:  # pragma: no cover - 服务端不支持 fstat
            entry = RemoteEntry(path=path, name=posixpath.basename(path), is_dir=False, size=len(data))
        logger.info(
            "SFTP 下载 %s (%d bytes, %s)", path, len(data), decoded.encoding
        )
        return decoded, entry

    def _read_all(
        self, path: str, *, max_bytes: Optional[int] = None
    ) -> Tuple[bytes, Optional[RemoteEntry]]:
        """一次会话读完整个文件：open → fstat → 分块读（大文件走 prefetch 流水线）。

        相对「先 stat 再 open 逐块读」的做法省掉一次往返，并且大文件不必为每个
        64KB 数据块都等一次 RTT——弱网 / 高延迟链路上差距很明显。
        """
        sftp = self._session()
        handle = self._call(sftp.open, path, "rb")
        try:
            entry = self._entry_from_handle(path, handle)
            if entry is not None and entry.is_dir:
                raise SFTError(f"{path} 是目录，无法下载")
            if entry is not None and max_bytes is not None and entry.size > max_bytes:
                raise SFTError(
                    f"文件过大（{human_size(entry.size)}），已超过上限 {human_size(max_bytes)}"
                )
            if entry is not None and entry.size > CHUNK_SIZE:
                self._prefetch(handle, entry.size)
            chunks: List[bytes] = []
            received = 0
            while True:
                chunk = self._call(handle.read, CHUNK_SIZE)
                if not chunk:
                    break
                received += len(chunk)
                if max_bytes is not None and received > max_bytes:
                    raise SFTError(
                        f"文件过大（超过上限 {human_size(max_bytes)}）"
                    )
                chunks.append(chunk)
        finally:
            self._call(handle.close)
        return b"".join(chunks), entry

    def _entry_from_handle(self, path: str, handle: object) -> Optional[RemoteEntry]:
        """在已打开的句柄上取元信息（fstat），服务端不支持时返回 ``None``。"""
        stat_method = getattr(handle, "stat", None)
        if stat_method is None:  # pragma: no cover - 老版本 paramiko
            return None
        try:
            attr = self._call(stat_method)
        except Exception:  # pragma: no cover - 个别服务端不支持 fstat
            return None
        return self._to_entry(path, attr)  # type: ignore[arg-type]

    @staticmethod
    def _prefetch(handle: object, size: int) -> None:
        """让 paramiko 预先并发请求后续数据块（对高延迟链路提升明显）。"""
        prefetch = getattr(handle, "prefetch", None)
        if prefetch is None:  # pragma: no cover - 老版本 paramiko
            return
        try:
            prefetch(size)
        except Exception:  # pragma: no cover - 不支持时退化为同步读取
            logger.debug("prefetch 不可用，退化为逐块同步读取")

    # -- 写入 --------------------------------------------------------------
    def write_bytes(self, path: str, data: bytes, *, atomic: bool = True) -> None:
        """写入（覆盖）远程文件。"""
        sftp = self._session()
        if atomic:
            self._atomic_write(sftp, path, data)
        else:
            handle = self._open_write(sftp, path, "wb")
            try:
                self._write_chunks(handle, data)
            finally:
                self._call(handle.close)
        logger.info("SFTP 上传 %s (%d bytes)", path, len(data))

    def _open_write(self, sftp: paramiko.SFTPClient, path: str, mode: str = "wb") -> object:
        """打开写句柄并启用流水线写入（弱网下上传同样受 RTT 拖累）。"""
        handle = self._call(sftp.open, path, mode)
        setter = getattr(handle, "set_pipelined", None)
        if setter is not None:
            try:
                setter(True)
            except Exception:  # pragma: no cover - 个别服务端不支持
                logger.debug("set_pipelined 不可用，退化为同步写入")
        return handle

    def _write_chunks(self, handle: object, data: bytes) -> None:
        for offset in range(0, len(data), CHUNK_SIZE):
            self._call(handle.write, data[offset : offset + CHUNK_SIZE])
        flush = getattr(handle, "flush", None)
        if flush is not None:
            self._call(flush)

    def _atomic_write(self, sftp: paramiko.SFTPClient, path: str, data: bytes) -> None:
        directory = posixpath.dirname(path) or "."
        tmp_path = posixpath.join(directory, f"{TMP_PREFIX}{uuid.uuid4().hex[:8]}")
        existing_mode: Optional[int] = None
        try:
            existing_mode = int(self._call(sftp.stat, path).st_mode)  # type: ignore[union-attr]
        except SFTError:
            existing_mode = None

        handle = self._open_write(sftp, tmp_path, "wb")
        try:
            self._write_chunks(handle, data)
        finally:
            self._call(handle.close)

        try:
            if existing_mode is not None:
                try:
                    self._call(sftp.chmod, tmp_path, stat.S_IMODE(existing_mode))
                except SFTError:  # 某些 sftp 实现不支持 chmod
                    logger.debug("chmod 不受支持，跳过 %s", tmp_path)
            try:
                rename = getattr(sftp, "posix_rename", None)
                if rename is not None:
                    self._call(rename, tmp_path, path)
                else:  # pragma: no cover - 老版本 paramiko
                    self._call(sftp.remove, path)
                    self._call(sftp.rename, tmp_path, path)
            except SFTError:
                # 回退到普通 rename（部分服务端不支持 posix_rename）
                try:
                    self._call(sftp.remove, path)
                except SFTError:
                    pass
                self._call(sftp.rename, tmp_path, path)
        except Exception:
            try:
                self._call(sftp.remove, tmp_path)
            except Exception:  # pragma: no cover
                logger.debug("清理临时文件失败: %s", tmp_path)
            raise

    def write_text(
        self,
        path: str,
        text: str,
        *,
        encoding: str = "utf-8",
        newline: str = "\n",
        atomic: bool = True,
    ) -> None:
        """按指定编码写入文本。"""
        self.write_bytes(path, encode_text(text, encoding, newline=newline), atomic=atomic)

    # -- 结构与重命名 ------------------------------------------------------
    def mkdir(self, path: str, *, parents: bool = False) -> None:
        sftp = self._session()
        if parents:
            try:
                self._call(sftp.stat, path)
                return
            except SFTError:
                pass
            parent = posixpath.dirname(path.rstrip("/"))
            if parent and parent not in ("/", ""):
                self.mkdir(parent, parents=True)
        self._call(sftp.mkdir, path)
        logger.info("SFTP 新建目录 %s", path)

    def create_file(self, path: str, *, content: str = "", encoding: str = "utf-8") -> None:
        """新建空文件（已存在时报错，避免误覆盖）。"""
        sftp = self._session()
        if self.exists(path):
            raise SFTError(f"文件已存在：{path}")
        handle = self._call(sftp.open, path, "wb")
        try:
            if content:
                self._call(handle.write, encode_text(content, encoding))
        finally:
            self._call(handle.close)
        logger.info("SFTP 新建文件 %s", path)

    def remove(self, path: str, *, is_dir: bool = False, recursive: bool = False) -> None:
        """删除文件或目录。"""
        sftp = self._session()
        if is_dir:
            if recursive:
                for entry in self.list_dir(path):
                    child_dir = entry.is_dir and not entry.is_symlink
                    self.remove(entry.path, is_dir=child_dir, recursive=recursive)
            self._call(sftp.rmdir, path)
        else:
            self._call(sftp.remove, path)
        logger.info("SFTP 删除 %s", path)

    def rename(self, source: str, target: str, *, overwrite: bool = False) -> None:
        """重命名 / 移动。"""
        sftp = self._session()
        if not overwrite and self.exists(target):
            raise SFTError(f"目标已存在：{target}")
        if overwrite and self.exists(target):
            entry = self.stat(target)
            self.remove(target, is_dir=entry.is_dir, recursive=True)
        self._call(sftp.rename, source, target)
        logger.info("SFTP 重命名 %s -> %s", source, target)

    @staticmethod
    def _to_entry(path: str, attr: paramiko.SFTPAttributes) -> RemoteEntry:
        mode = int(attr.st_mode or 0)
        return RemoteEntry(
            name=posixpath.basename(path.rstrip("/")) or path,
            path=path,
            is_dir=stat.S_ISDIR(mode),
            size=int(attr.st_size or 0),
            mtime=float(attr.st_mtime or 0),
            mode=mode,
            is_symlink=stat.S_ISLNK(mode),
        )


def iter_remote_entries(entries: Iterable[RemoteEntry]) -> List[str]:
    """便捷函数：取出条目名列表。"""
    return [entry.name for entry in entries]
