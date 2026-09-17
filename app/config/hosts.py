"""SSH 主机配置的保存与管理。

**安全约束**：密码 / passphrase 永不写入本文件，仅存在于内存中，
需要每次连接时输入（后续版本可接入系统钥匙串）。
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config.settings import atomic_write_json, load_json
from app.utils.errors import ConfigError
from app.utils.paths import config_dir
from app.utils.ssh_keys import SSHConfigHost

logger = logging.getLogger(__name__)

HOSTS_FILENAME = "hosts.json"


class AuthMethod(str, Enum):
    PASSWORD = "password"
    PRIVATE_KEY = "private_key"

    @property
    def label(self) -> str:
        return "密码" if self is AuthMethod.PASSWORD else "私钥"


@dataclass
class HostConfig:
    """单台远程主机的连接信息。"""

    name: str = ""
    host: str = ""
    port: int = 22
    username: str = "root"
    auth_method: AuthMethod = AuthMethod.PASSWORD
    private_key_path: str = ""
    remote_workspace: str = ""
    id: str = field(default_factory=lambda: uuid.uuid4().hex)

    # -- 展示 --------------------------------------------------------------
    @property
    def display_name(self) -> str:
        return self.name or self.host or "未命名主机"

    @property
    def target(self) -> str:
        return f"{self.username}@{self.host}:{self.port}"

    def validate(self) -> None:
        """基本合法性校验，失败抛 :class:`ConfigError`。"""
        if not self.host.strip():
            raise ConfigError("主机地址不能为空")
        if not self.username.strip():
            raise ConfigError("用户名不能为空")
        if not (1 <= int(self.port) <= 65535):
            raise ConfigError("端口必须在 1-65535 之间")
        if self.auth_method is AuthMethod.PRIVATE_KEY and not self.private_key_path.strip():
            raise ConfigError("使用私钥认证时必须选择私钥文件")

    # -- 序列化（不含任何密码字段）-----------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "host": self.host,
            "port": int(self.port),
            "username": self.username,
            "auth_method": self.auth_method.value,
            "private_key_path": self.private_key_path,
            "remote_workspace": self.remote_workspace,
        }

    @classmethod
    def from_ssh_config(cls, entry: SSHConfigHost) -> "HostConfig":
        """把 ``~/.ssh/config`` 里的一个 Host 段落转成本项目的主机配置。

        带 ``IdentityFile`` 的段落按私钥认证导入，否则按密码认证（连接时输入）。
        """
        identity = (entry.identity_file or "").strip()
        return cls(
            name=entry.alias,
            host=entry.connect_host,
            port=max(1, min(65535, int(entry.port or 22))),
            username=entry.username or _local_username(),
            auth_method=AuthMethod.PRIVATE_KEY if identity else AuthMethod.PASSWORD,
            private_key_path=identity,
            remote_workspace="",
        )

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "HostConfig":
        raw_auth = str(data.get("auth_method", AuthMethod.PASSWORD.value))
        try:
            auth = AuthMethod(raw_auth)
        except ValueError:
            auth = AuthMethod.PASSWORD
        return cls(
            id=str(data.get("id") or uuid.uuid4().hex),
            name=str(data.get("name", "")),
            host=str(data.get("host", "")),
            port=int(data.get("port", 22) or 22),
            username=str(data.get("username", "root")),
            auth_method=auth,
            private_key_path=str(data.get("private_key_path", "")),
            remote_workspace=str(data.get("remote_workspace", "")),
        )


def _local_username() -> str:
    try:
        import getpass

        return getpass.getuser() or "root"
    except Exception:  # pragma: no cover - 容器等异常环境
        return "root"


def default_hosts_path() -> Path:
    return config_dir() / HOSTS_FILENAME


class HostStore:
    """主机列表的增删改查。"""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path or default_hosts_path()
        self._hosts: List[HostConfig] = []
        self._loaded = False

    # -- 读写 --------------------------------------------------------------
    def load(self) -> List[HostConfig]:
        if self._loaded:
            return list(self._hosts)
        raw = load_json(self.path, default=None)
        hosts: List[HostConfig] = []
        if isinstance(raw, dict):
            raw = raw.get("hosts", [])
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict):
                    try:
                        hosts.append(HostConfig.from_dict(item))
                    except (TypeError, ValueError) as exc:
                        logger.warning("忽略无效主机配置: %s", exc)
        self._hosts = hosts
        self._loaded = True
        return list(self._hosts)

    def save(self) -> None:
        payload = {"version": 1, "hosts": [host.to_dict() for host in self._hosts]}
        atomic_write_json(self.path, payload)

    # -- 操作 --------------------------------------------------------------
    def all(self) -> List[HostConfig]:
        return self.load()

    def get(self, host_id: str) -> Optional[HostConfig]:
        for host in self.load():
            if host.id == host_id:
                return host
        return None

    def find_by_name(self, name: str) -> List[HostConfig]:
        return [host for host in self.load() if host.name == name]

    def add(self, host: HostConfig) -> HostConfig:
        host.validate()
        self.load()
        if any(existing.id == host.id for existing in self._hosts):
            raise ConfigError(f"主机 ID 重复：{host.id}")
        self._hosts.append(host)
        self.save()
        return host

    def update(self, host: HostConfig) -> HostConfig:
        host.validate()
        self.load()
        for index, existing in enumerate(self._hosts):
            if existing.id == host.id:
                self._hosts[index] = host
                self.save()
                return host
        raise ConfigError("要更新的主机不存在")

    def upsert(self, host: HostConfig) -> HostConfig:
        if self.get(host.id) is None:
            return self.add(host)
        return self.update(host)

    def delete(self, host_id: str) -> bool:
        self.load()
        before = len(self._hosts)
        self._hosts = [host for host in self._hosts if host.id != host_id]
        if len(self._hosts) != before:
            self.save()
            return True
        return False
