"""远程会话：把 SSH / SFTP / Git 组合成一个可复用的对象。

生命周期：``connect()`` → 多次操作 → ``close()``（或断线后 ``reconnect()``）。
UI 层通过 :class:`SessionController` 把这个对象交给工作线程使用。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

from app.config.hosts import AuthMethod, HostConfig
from app.config.settings import AppSettings
from app.git.git_client import GitClient, RepoInfo
from app.remote.remote_fs import RemoteFileSystem, normalize_remote_path
from app.remote.ssh_client import SSHClient, SSHConnectionOptions
from app.utils.ssh_keys import default_private_key

logger = logging.getLogger(__name__)


@dataclass
class SessionState:
    """会话对外状态快照（供状态栏显示）。"""

    host_name: str = ""
    connected: bool = False
    workspace: str = ""
    repo: RepoInfo = field(default_factory=RepoInfo)

    @property
    def connection_label(self) -> str:
        return "SSH: Connected" if self.connected else "SSH: Disconnected"


class RemoteSession:
    """一条已连接（或待连接）的远程会话。"""

    def __init__(
        self,
        host: HostConfig,
        *,
        password: Optional[str] = None,
        passphrase: Optional[str] = None,
        settings: Optional[AppSettings] = None,
    ) -> None:
        self.host = host
        self.password = password
        self.passphrase = passphrase
        self.settings = settings or AppSettings()
        self.workspace = (host.remote_workspace or "").strip()
        #: 主机配置里显式保存过的工作目录（区别于自动回退的家目录）
        self.workspace_configured = bool(self.workspace)
        #: 远端家目录，连接后按需探测并缓存
        self.home = ""

        self._ssh: Optional[SSHClient] = None
        self._fs: Optional[RemoteFileSystem] = None
        self._git: Optional[GitClient] = None
        self._repo_info: Optional[RepoInfo] = None

    # -- 连接 --------------------------------------------------------------
    def build_options(self) -> SSHConnectionOptions:
        return SSHConnectionOptions(
            host=self.host.host,
            port=self.host.port,
            username=self.host.username,
            password=self.password,
            private_key_path=(
                self._key_path() if self.host.auth_method is AuthMethod.PRIVATE_KEY else ""
            ),
            passphrase=self.passphrase,
            timeout=float(self.settings.ssh_timeout_seconds),
            keepalive=int(self.settings.ssh_keepalive_seconds),
            strict_host_key=bool(self.settings.ssh_strict_host_key),
        )

    def _key_path(self) -> str:
        """私钥认证使用的私钥路径；未显式配置时回退到本机 ``~/.ssh`` 里的默认私钥。"""
        configured = (self.host.private_key_path or "").strip()
        if configured:
            return configured
        default_key = default_private_key()
        return str(default_key.path) if default_key is not None else ""

    def connect(self) -> None:
        """建立连接并解析工作目录（``~`` 相对远端家目录展开）。"""
        ssh = SSHClient(self.build_options())
        ssh.connect()
        self._ssh = ssh
        self._fs = RemoteFileSystem(ssh)
        self._git = GitClient(ssh)
        if not self.workspace_configured:
            self.workspace = self.remote_home()
        else:
            self.workspace = self.expand_path(self.workspace)
        logger.info("会话就绪：%s，工作目录 %s", self.host.target, self.workspace)

    def close(self) -> None:
        if self._ssh is not None:
            self._ssh.close()
        self._ssh = None
        self._fs = None
        self._git = None
        self._repo_info = None

    @property
    def connected(self) -> bool:
        return self._ssh is not None and self._ssh.connected

    def reconnect(self) -> None:
        if self._ssh is None:
            self.connect()
            return
        self._ssh.reconnect()
        self._repo_info = None

    def ensure_connected(self) -> None:
        if self._ssh is None:
            self.connect()
            return
        if not self._ssh.connected:
            self._ssh.drop_sftp()
            self._ssh.ensure_connected()

    # -- 资源访问 ----------------------------------------------------------
    @property
    def ssh(self) -> SSHClient:
        if self._ssh is None:
            raise RuntimeError("会话尚未建立连接")
        return self._ssh

    @property
    def fs(self) -> RemoteFileSystem:
        if self._fs is None:
            raise RuntimeError("会话尚未建立连接")
        return self._fs

    @property
    def git(self) -> GitClient:
        if self._git is None:
            raise RuntimeError("会话尚未建立连接")
        return self._git

    # -- 工作目录 / 仓库 ---------------------------------------------------
    def _detect_home(self) -> str:
        """获取远端家目录，失败则回退到 ``/``。"""
        try:
            result = self.ssh.exec_command("printf %s \"$HOME\"", timeout=10)
        except Exception as exc:  # pragma: no cover - 网络异常
            logger.warning("无法获取远端 HOME：%s", exc)
            return "/"
        home = result.stdout.strip()
        return home if result.ok and home else "/"

    def remote_home(self) -> str:
        """远端家目录（首次调用会执行一次 ``$HOME`` 查询并缓存）。"""
        if not self.home:
            self.home = self._detect_home()
        return self.home

    def expand_path(self, path: str) -> str:
        """把用户输入的路径展开为绝对路径（``~`` 与相对路径都相对家目录）。"""
        text = (path or "").strip()
        needs_home = text in ("", "~") or text.startswith("~/") or not text.startswith("/")
        home = self.remote_home() if needs_home else self.home
        return normalize_remote_path(text, home)

    def set_workspace(self, path: str) -> None:
        """切换工作目录（重启后仍生效需要同时写回 :class:`HostConfig`）。"""
        self.workspace = self.expand_path(path)
        self.workspace_configured = True
        self._repo_info = None

    def repo_info(self, *, refresh: bool = False) -> RepoInfo:
        """识别工作目录所属 Git 仓库（结果缓存，``refresh=True`` 时重新查询）。"""
        if self._repo_info is not None and not refresh:
            return self._repo_info
        try:
            self._repo_info = self.git.repo_info(self.workspace or "/")
        except Exception as exc:
            logger.warning("git 仓库识别失败: %s", exc)
            self._repo_info = RepoInfo(directory=self.workspace, error=str(exc))
        return self._repo_info

    def state(self) -> SessionState:
        return SessionState(
            host_name=self.host.display_name,
            connected=self.connected,
            workspace=self.workspace,
            repo=self._repo_info or RepoInfo(),
        )
