"""本机 ``~/.ssh`` 目录扫描：私钥清单与 OpenSSH 客户端配置解析。

两个用途：

* :func:`list_private_keys` —— 在「私钥认证」里直接列出本机可用私钥，
  而不是让用户从文件对话框里大海捞针；
* :func:`parse_ssh_config` / :func:`load_ssh_config_hosts` —— 读取 ``~/.ssh/config``，
  支持把这台机器上已经配好的 Host 一次性导入主机列表。

约束：只读、不修改任何文件；任何解析失败都降级为「忽略该条目」，
绝不向 UI 抛异常。
"""

from __future__ import annotations

import glob
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

from app.utils.paths import home_dir

logger = logging.getLogger(__name__)

MAX_KEY_FILE_SIZE = 128 * 1024
MAX_INCLUDE_DEPTH = 4
KEY_HEAD = 1024

_PRIVATE_KEY_MARKERS = (
    b"-----BEGIN OPENSSH PRIVATE KEY-----",
    b"-----BEGIN RSA PRIVATE KEY-----",
    b"-----BEGIN DSA PRIVATE KEY-----",
    b"-----BEGIN EC PRIVATE KEY-----",
    b"-----BEGIN PRIVATE KEY-----",
    b"-----BEGIN ENCRYPTED PRIVATE KEY-----",
)

#: 这些名字在 ``~/.ssh`` 里一定不是私钥，直接跳过，避免无谓的读取。
_NOT_KEY_NAMES = {
    "config",
    "environment",
    "rc",
    "known_hosts",
    "authorized_keys",
}

#: 优先作为默认私钥使用（与 OpenSSH 客户端的偏好一致）。
_PREFERRED_KEY_NAMES = ("id_ed25519", "id_ecdsa", "id_rsa", "id_dsa")


def ssh_dir() -> Path:
    """本机 ``~/.ssh`` 目录（不保证存在）。"""
    return home_dir() / ".ssh"


@dataclass(frozen=True)
class PrivateKeyInfo:
    """本机发现的一个私钥文件。"""

    path: Path
    key_type: str = "未知"
    comment: str = ""
    encrypted: bool = False
    mtime: float = 0.0

    @property
    def name(self) -> str:
        return self.path.name

    @property
    def label(self) -> str:
        suffix = "，已加密" if self.encrypted else ""
        return f"{self.name}（{self.key_type}{suffix}）"


def _key_type_from_head(head: bytes) -> str:
    if b"BEGIN OPENSSH PRIVATE KEY" in head:
        return "OpenSSH"
    if b"BEGIN RSA PRIVATE KEY" in head:
        return "RSA"
    if b"BEGIN DSA PRIVATE KEY" in head:
        return "DSA"
    if b"BEGIN EC PRIVATE KEY" in head:
        return "ECDSA"
    if b"BEGIN ENCRYPTED PRIVATE KEY" in head:
        return "PKCS#8"
    if b"BEGIN PRIVATE KEY" in head:
        return "PKCS#8"
    return "PEM"


def _read_public_comment(path: Path) -> str:
    """读取 ``<key>.pub`` 末尾的注释（通常是 ``user@host``）。"""
    for candidate in (path.with_suffix(path.suffix + ".pub"), Path(str(path) + ".pub")):
        try:
            if not candidate.is_file() or candidate.stat().st_size > 8192:
                continue
            parts = candidate.read_text(encoding="utf-8", errors="replace").split()
        except OSError:  # pragma: no cover - 权限异常
            continue
        if len(parts) >= 3:
            return parts[2][:64]
    return ""


def _is_encrypted(path: Path, key_type: str, head: bytes) -> bool:
    """判断私钥是否带口令。

    PEM 私钥可以直接看 ``Proc-Type`` 头；OpenSSH 新格式只能真正解析一次，
    这里用 paramiko 做准确判断，失败则保守地判定为「未加密」。
    """
    if b"ENCRYPTED" in head:
        return True
    if key_type != "OpenSSH":
        return False
    try:
        import paramiko

        paramiko.PKey.from_path(str(path))
    except Exception as exc:  # 包含 PasswordRequiredException
        return type(exc).__name__ == "PasswordRequiredException"
    return False


def looks_like_private_key(path: Path) -> bool:
    """按文件头判断是否是私钥（不依赖文件名）。"""
    try:
        if not path.is_file():
            return False
        stat = path.stat()
        if stat.st_size == 0 or stat.st_size > MAX_KEY_FILE_SIZE:
            return False
        with path.open("rb") as handle:
            head = handle.read(KEY_HEAD)
    except OSError:
        return False
    return any(marker in head for marker in _PRIVATE_KEY_MARKERS)


def _candidate_files(directory: Path) -> List[Path]:
    try:
        children: Iterable[Path] = sorted(directory.iterdir(), key=lambda item: item.name)
    except OSError as exc:  # pragma: no cover - 目录不存在 / 无权限
        logger.debug("无法读取 %s：%s", directory, exc)
        return []
    result: List[Path] = []
    for child in children:
        name = child.name
        if name.startswith(".") or name in _NOT_KEY_NAMES or name.endswith(".pub"):
            continue
        if name.startswith("known_hosts") or name.startswith("authorized_keys"):
            continue
        result.append(child)
    return result


def list_private_keys(directory: Optional[Path] = None) -> List[PrivateKeyInfo]:
    """列出目录（默认 ``~/.ssh``）中的私钥，按「常用优先 + 名称」排序。"""
    target = directory or ssh_dir()
    keys: List[PrivateKeyInfo] = []
    for path in _candidate_files(target):
        if not looks_like_private_key(path):
            continue
        try:
            with path.open("rb") as handle:
                head = handle.read(KEY_HEAD)
            mtime = path.stat().st_mtime
        except OSError:  # pragma: no cover - 竞态
            continue
        key_type = _key_type_from_head(head)
        keys.append(
            PrivateKeyInfo(
                path=path,
                key_type=key_type,
                comment=_read_public_comment(path),
                encrypted=_is_encrypted(path, key_type, head),
                mtime=mtime,
            )
        )
    return sorted(keys, key=_key_sort_key)


def _key_sort_key(info: PrivateKeyInfo):
    try:
        rank = _PREFERRED_KEY_NAMES.index(info.name)
    except ValueError:
        rank = len(_PREFERRED_KEY_NAMES)
    return (rank, info.name)


def default_private_key(directory: Optional[Path] = None) -> Optional[PrivateKeyInfo]:
    """返回最可能被使用的私钥（``id_ed25519`` → ``id_rsa`` → 任意一个）。"""
    keys = list_private_keys(directory)
    return keys[0] if keys else None


# ---------------------------------------------------------------------------
# ~/.ssh/config
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SSHConfigHost:
    """``~/.ssh/config`` 中的一个 ``Host`` 段落。"""

    alias: str
    hostname: str = ""
    port: int = 22
    username: str = ""
    identity_file: str = ""

    @property
    def connect_host(self) -> str:
        return self.hostname or self.alias

    @property
    def target(self) -> str:
        user = f"{self.username}@" if self.username else ""
        return f"{user}{self.connect_host}:{self.port}"


def _strip_comment(line: str) -> str:
    for index, char in enumerate(line):
        if char == "#":
            return line[:index]
    return line


def _parse_config_file(path: Path, *, depth: int, seen: set) -> List[SSHConfigHost]:
    if depth > MAX_INCLUDE_DEPTH:
        return []
    try:
        resolved = path.expanduser().resolve()
    except OSError:  # pragma: no cover
        resolved = path.expanduser()
    if resolved in seen or not resolved.is_file():
        return []
    seen.add(resolved)
    try:
        text = resolved.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:  # pragma: no cover - 权限异常
        logger.debug("无法读取 ssh 配置 %s：%s", resolved, exc)
        return []

    hosts: List[SSHConfigHost] = []
    current: Optional[dict] = None

    def flush() -> None:
        if current is None:
            return
        alias = current.get("alias", "")
        hostname = current.get("hostname", "") or alias
        if alias and hostname and not any(char in alias for char in "*?!"):
            hosts.append(
                SSHConfigHost(
                    alias=alias,
                    hostname=hostname,
                    port=int(current.get("port", 22)),
                    username=current.get("user", ""),
                    identity_file=current.get("identity_file", ""),
                )
            )

    for raw_line in text.splitlines():
        line = _strip_comment(raw_line).strip()
        if not line:
            continue
        parts = line.split(None, 1)
        keyword = parts[0].lower()
        value = parts[1].strip().strip('"') if len(parts) > 1 else ""

        if keyword in ("host", "match"):
            flush()
            current = None if keyword == "match" else {"alias": ""}
            if keyword == "host" and value:
                patterns = value.split()
                # 只保留第一个具体主机名；含通配符的段落整体跳过。
                current["alias"] = patterns[0]
                current["wildcard"] = any(char in patterns[0] for char in "*?!")
                current["alias"] = "" if current["wildcard"] else patterns[0]
            continue
        if keyword == "include":
            for pattern in value.split():
                target = Path(pattern).expanduser()
                if not target.is_absolute():
                    target = resolved.parent / target
                for match in sorted(glob.glob(str(target))):
                    hosts.extend(_parse_config_file(Path(match), depth=depth + 1, seen=seen))
            continue
        if current is None:
            continue
        if keyword == "hostname":
            current["hostname"] = value
        elif keyword == "port":
            try:
                current["port"] = int(value)
            except ValueError:
                pass
        elif keyword == "user":
            current["user"] = value
        elif keyword == "identityfile":
            current["identity_file"] = os.path.expanduser(value)
    flush()
    return hosts


def parse_ssh_config(path: Optional[Path] = None) -> List[SSHConfigHost]:
    """解析 ``~/.ssh/config``，返回其中的主机条目（忽略通配 Host）。"""
    return _parse_config_file(path or (ssh_dir() / "config"), depth=0, seen=set())


def load_ssh_config_hosts() -> List[SSHConfigHost]:
    """读取默认配置文件；不存在时返回空列表。"""
    return parse_ssh_config()
