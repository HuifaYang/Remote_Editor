"""SFTP 客户端测试：目录列表、下载、上传（原子写）、新建、删除、重命名、异常映射。"""

from __future__ import annotations

import errno
import posixpath
import stat
import threading
from typing import Dict, List

import pytest

from app.remote.sftp_client import SftpClient, human_size
from app.utils.errors import (
    RemoteFileNotFoundError,
    RemotePermissionError,
    SFTError,
)


class FakeAttributes:
    """模拟 paramiko 的 SFTPAttributes。"""

    def __init__(self, filename: str, mode: int, size: int = 0, mtime: float = 1700000000.0) -> None:
        self.filename = filename
        self.st_mode = mode
        self.st_size = size
        self.st_mtime = mtime


class FakeHandle:
    def __init__(self, node: Dict[str, object], mode: str) -> None:
        self._node = node
        self._mode = mode
        self._position = 0
        self.closed = False

    def read(self, size: int = -1) -> bytes:
        data = self._node["data"]  # type: ignore[assignment]
        assert isinstance(data, bytes)
        chunk = data[self._position :] if size < 0 else data[self._position : self._position + size]
        self._position += len(chunk)
        return chunk

    def write(self, data: bytes) -> int:
        current = self._node["data"]  # type: ignore[assignment]
        assert isinstance(current, bytes)
        self._node["data"] = current[: self._position] + data + current[self._position + len(data) :]
        self._position += len(data)
        return len(data)

    def close(self) -> None:
        self.closed = True


class FakeParamikoSFTP:
    """内存版 SFTP 服务端。"""

    def __init__(self, *, support_posix_rename: bool = True) -> None:
        self.files: Dict[str, Dict[str, object]] = {}
        self.directories: set[str] = {"/"}
        self.support_posix_rename = support_posix_rename
        self.chmod_calls: List[tuple] = []
        if not support_posix_rename:
            # 服务端不支持 posix_rename 扩展时，属性为 None，客户端会走回退分支
            self.posix_rename = None  # type: ignore[assignment]

    # -- 帮助 --------------------------------------------------------------
    def add_dir(self, path: str) -> None:
        self.directories.add(path)

    def add_file(self, path: str, data: bytes, mode: int = 0o100644) -> None:
        self.files[path] = {"data": data, "mode": mode}
        self.directories.add(posixpath.dirname(path) or "/")

    # -- SFTP 接口 ---------------------------------------------------------
    def listdir_attr(self, path: str) -> List[FakeAttributes]:
        if path not in self.directories:
            raise IOError(errno.ENOENT, "No such file")
        entries: List[FakeAttributes] = []
        prefix = path.rstrip("/") + "/"
        for name in sorted(self.directories):
            if name == path or not name.startswith(prefix):
                continue
            if "/" in name[len(prefix) :]:
                continue
            entries.append(FakeAttributes(name[len(prefix) :], stat.S_IFDIR | 0o755))
        for name, node in sorted(self.files.items()):
            if not name.startswith(prefix):
                continue
            if "/" in name[len(prefix) :]:
                continue
            entries.append(
                FakeAttributes(
                    name[len(prefix) :],
                    int(node["mode"]),
                    len(node["data"]),  # type: ignore[arg-type]
                )
            )
        return entries

    def stat(self, path: str) -> FakeAttributes:
        node = self.files.get(path)
        if node is not None:
            return FakeAttributes(
                posixpath.basename(path), int(node["mode"]), len(node["data"])  # type: ignore[arg-type]
            )
        if path in self.directories:
            return FakeAttributes(posixpath.basename(path), stat.S_IFDIR | 0o755)
        raise IOError(errno.ENOENT, "No such file")

    def lstat(self, path: str) -> FakeAttributes:
        return self.stat(path)

    def open(self, path: str, mode: str = "r") -> FakeHandle:
        if "r" in mode and path not in self.files:
            raise IOError(errno.ENOENT, "No such file")
        if "w" in mode and path not in self.files:
            self.files[path] = {"data": b"", "mode": 0o100644}
        node = self.files[path]
        if "w" in mode:
            node["data"] = b""
        return FakeHandle(node, mode)

    def mkdir(self, path: str) -> None:
        if path in self.directories:
            raise IOError(errno.EEXIST, "File exists")
        if posixpath.dirname(path) not in self.directories:
            raise IOError(errno.ENOENT, "No such file")
        self.directories.add(path)

    def remove(self, path: str) -> None:
        if path not in self.files:
            raise IOError(errno.ENOENT, "No such file")
        del self.files[path]

    def rmdir(self, path: str) -> None:
        if path not in self.directories:
            raise IOError(errno.ENOENT, "No such file")
        self.directories.discard(path)

    def rename(self, source: str, target: str) -> None:
        if source not in self.files:
            raise IOError(errno.ENOENT, "No such file")
        self.files[target] = self.files.pop(source)

    def posix_rename(self, source: str, target: str) -> None:
        self.rename(source, target)

    def chmod(self, path: str, mode: int) -> None:
        self.chmod_calls.append((path, mode))
        if path in self.files:
            self.files[path]["mode"] = stat.S_IFREG | mode


class FakeSSH:
    """只提供 SftpClient 需要的最小接口。"""

    def __init__(self, sftp: FakeParamikoSFTP) -> None:
        self._sftp = sftp
        self.lock = threading.RLock()

    def open_sftp(self) -> FakeParamikoSFTP:
        return self._sftp


@pytest.fixture
def sftp_server() -> FakeParamikoSFTP:
    server = FakeParamikoSFTP()
    server.add_dir("/home/user/project/src")
    server.add_file("/home/user/project/main.c", b"int main() {}\n")
    server.add_file("/home/user/project/src/util.c", "// 工具\n".encode("utf-8"))
    server.add_file("/home/user/project/bom.txt", "\ufeffhello\n".encode("utf-8"))
    return server


@pytest.fixture
def client(sftp_server: FakeParamikoSFTP) -> SftpClient:
    return SftpClient(FakeSSH(sftp_server))  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# 目录列表
# ---------------------------------------------------------------------------


def test_list_dir_sorts_directories_first(client: SftpClient) -> None:
    entries = client.list_dir("/home/user/project")
    assert [entry.name for entry in entries] == ["src", "bom.txt", "main.c"]
    assert entries[0].is_dir


def test_list_dir_returns_metadata(client: SftpClient) -> None:
    entries = {entry.name: entry for entry in client.list_dir("/home/user/project")}
    assert entries["main.c"].size == len(b"int main() {}\n")
    assert entries["main.c"].kind_label == "文件"
    assert entries["main.c"].mtime_label != "-"
    assert entries["src"].size_label == "-"


def test_list_dir_missing_path_raises(client: SftpClient) -> None:
    with pytest.raises(RemoteFileNotFoundError):
        client.list_dir("/home/user/nope")


def test_list_dir_permission_error_mapping() -> None:
    class Denied(FakeParamikoSFTP):
        def listdir_attr(self, path: str):  # type: ignore[override]
            raise IOError(errno.EACCES, "Permission denied")

    client = SftpClient(FakeSSH(Denied()))  # type: ignore[arg-type]
    with pytest.raises(RemotePermissionError):
        client.list_dir("/root")


# ---------------------------------------------------------------------------
# 下载
# ---------------------------------------------------------------------------


def test_read_text_utf8(client: SftpClient) -> None:
    decoded = client.read_text("/home/user/project/src/util.c")
    assert decoded.text == "// 工具\n"
    assert decoded.encoding == "utf-8"


def test_read_text_detects_bom(client: SftpClient) -> None:
    decoded = client.read_text("/home/user/project/bom.txt")
    assert decoded.encoding == "utf-8-sig"
    assert decoded.has_bom


def test_read_text_respects_max_bytes(client: SftpClient) -> None:
    with pytest.raises(SFTError):
        client.read_text("/home/user/project/main.c", max_bytes=4)


def test_read_missing_file(client: SftpClient) -> None:
    with pytest.raises(RemoteFileNotFoundError):
        client.read_bytes("/home/user/project/ghost.c")


def test_exists(client: SftpClient) -> None:
    assert client.exists("/home/user/project/main.c")
    assert not client.exists("/home/user/project/ghost.c")


# ---------------------------------------------------------------------------
# 上传
# ---------------------------------------------------------------------------


def test_write_text_atomic_replaces_content(
    client: SftpClient, sftp_server: FakeParamikoSFTP
) -> None:
    client.write_text("/home/user/project/main.c", "changed\n")
    assert sftp_server.files["/home/user/project/main.c"]["data"] == b"changed\n"
    leftovers = [name for name in sftp_server.files if name.startswith("/home/user/project/.rce-upload-")]
    assert leftovers == [], "临时文件应被清理"


def test_write_text_preserves_mode(client: SftpClient, sftp_server: FakeParamikoSFTP) -> None:
    client.write_text("/home/user/project/main.c", "x\n")
    assert sftp_server.chmod_calls, "应尝试保留原文件权限"
    assert stat.S_IMODE(int(sftp_server.files["/home/user/project/main.c"]["mode"])) == 0o644


def test_write_text_falls_back_without_posix_rename() -> None:
    server = FakeParamikoSFTP(support_posix_rename=False)
    server.add_file("/a/b.txt", b"old\n")
    client = SftpClient(FakeSSH(server))  # type: ignore[arg-type]
    client.write_text("/a/b.txt", "new\n")
    assert server.files["/a/b.txt"]["data"] == b"new\n"


def test_write_text_creates_file_when_missing(
    client: SftpClient, sftp_server: FakeParamikoSFTP
) -> None:
    client.write_text("/home/user/project/new.txt", "hi\n")
    assert sftp_server.files["/home/user/project/new.txt"]["data"] == b"hi\n"


def test_write_text_crlf_conversion(client: SftpClient, sftp_server: FakeParamikoSFTP) -> None:
    client.write_text("/home/user/project/main.c", "a\nb\n", newline="\r\n")
    assert sftp_server.files["/home/user/project/main.c"]["data"] == b"a\r\nb\r\n"


def test_write_permission_denied_mapping() -> None:
    class Denied(FakeParamikoSFTP):
        def open(self, path: str, mode: str = "r"):  # type: ignore[override]
            raise IOError(errno.EACCES, "Permission denied")

    client = SftpClient(FakeSSH(Denied()))  # type: ignore[arg-type]
    with pytest.raises(RemotePermissionError):
        client.write_text("/etc/passwd", "x")


# ---------------------------------------------------------------------------
# 新建 / 删除 / 重命名
# ---------------------------------------------------------------------------


def test_create_file(client: SftpClient, sftp_server: FakeParamikoSFTP) -> None:
    client.create_file("/home/user/project/new.c", content="#include\n")
    assert sftp_server.files["/home/user/project/new.c"]["data"] == b"#include\n"


def test_create_file_refuses_overwrite(client: SftpClient) -> None:
    with pytest.raises(SFTError):
        client.create_file("/home/user/project/main.c", content="oops")


def test_mkdir_with_parents(client: SftpClient, sftp_server: FakeParamikoSFTP) -> None:
    client.mkdir("/home/user/project/a/b/c", parents=True)
    assert "/home/user/project/a/b/c" in sftp_server.directories


def test_delete_file(client: SftpClient, sftp_server: FakeParamikoSFTP) -> None:
    client.remove("/home/user/project/main.c")
    assert "/home/user/project/main.c" not in sftp_server.files


def test_delete_directory_recursive(client: SftpClient, sftp_server: FakeParamikoSFTP) -> None:
    client.remove("/home/user/project/src", is_dir=True, recursive=True)
    assert "/home/user/project/src/util.c" not in sftp_server.files
    assert "/home/user/project/src" not in sftp_server.directories


def test_rename(client: SftpClient, sftp_server: FakeParamikoSFTP) -> None:
    client.rename("/home/user/project/main.c", "/home/user/project/app.c")
    assert "/home/user/project/app.c" in sftp_server.files
    assert "/home/user/project/main.c" not in sftp_server.files


def test_rename_refuses_existing_target(client: SftpClient) -> None:
    with pytest.raises(SFTError):
        client.rename("/home/user/project/main.c", "/home/user/project/bom.txt")


def test_rename_with_overwrite(client: SftpClient, sftp_server: FakeParamikoSFTP) -> None:
    client.rename("/home/user/project/main.c", "/home/user/project/bom.txt", overwrite=True)
    assert sftp_server.files["/home/user/project/bom.txt"]["data"] == b"int main() {}\n"


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


def test_human_size() -> None:
    assert human_size(0) == "0 B"
    assert human_size(512) == "512 B"
    assert human_size(2048) == "2.0 KB"
    assert human_size(5 * 1024 * 1024) == "5.0 MB"
