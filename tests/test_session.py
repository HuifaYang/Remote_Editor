"""远程会话测试：参数映射、工作目录探测、仓库缓存、断线重连。"""

from __future__ import annotations

from typing import List

import pytest

from app.config.hosts import AuthMethod, HostConfig
from app.config.settings import AppSettings
from app.remote import session as session_module
from app.remote.remote_fs import FileFingerprint
from app.remote.session import RemoteSession
from app.remote.ssh_client import CommandResult, SSHConnectionOptions
from app.git.git_client import RepoInfo
from app.utils.ssh_keys import PrivateKeyInfo


class FakeSSHClient:
    """替代 paramiko SSHClient 的最小实现。"""

    instances: List["FakeSSHClient"] = []

    def __init__(self, options: SSHConnectionOptions) -> None:
        self.options = options
        self.connected = False
        self.closed = False
        self.reconnects = 0
        self.commands: List[str] = []
        self.home = "/home/user"
        FakeSSHClient.instances.append(self)

    def connect(self) -> None:
        self.connected = True

    def close(self) -> None:
        self.connected = False
        self.closed = True

    def reconnect(self) -> None:
        self.reconnects += 1
        self.connected = True

    def ensure_connected(self) -> None:
        self.connected = True

    def drop_sftp(self) -> None:
        pass

    def exec_command(self, command: str, *, timeout=None) -> CommandResult:
        self.commands.append(command)
        if "$HOME" in command:
            return CommandResult(command, 0, self.home, "")
        return CommandResult(command, 0, "", "")


@pytest.fixture
def patched_ssh(monkeypatch):
    FakeSSHClient.instances.clear()
    monkeypatch.setattr(session_module, "SSHClient", FakeSSHClient)
    return FakeSSHClient


def test_connect_uses_remote_home(patched_ssh, host: HostConfig) -> None:
    host.remote_workspace = ""
    session = RemoteSession(host, password="secret")
    session.connect()
    client = patched_ssh.instances[-1]
    assert client.connected
    assert session.connected
    assert session.workspace == "/home/user"
    assert any("$HOME" in command for command in client.commands)


def test_connect_keeps_configured_workspace(patched_ssh, host: HostConfig) -> None:
    host.remote_workspace = "/opt/app"
    session = RemoteSession(host)
    session.connect()
    assert session.workspace == "/opt/app"
    assert patched_ssh.instances[-1].commands == []


def test_connect_expands_tilde_workspace(patched_ssh, host: HostConfig) -> None:
    host.remote_workspace = "~/ros2_ws/src/"
    session = RemoteSession(host)
    session.connect()
    assert session.workspace == "/home/user/ros2_ws/src"
    assert session.workspace_configured is True


def test_expand_path_handles_home_and_relative(patched_ssh, host: HostConfig) -> None:
    host.remote_workspace = "/opt/app"
    session = RemoteSession(host)
    session.connect()
    assert session.expand_path("~") == "/home/user"
    assert session.expand_path("~/ros2_ws") == "/home/user/ros2_ws"
    assert session.expand_path("logs") == "/home/user/logs"
    assert session.expand_path("/var/log/../tmp") == "/var/tmp"
    # 已经是绝对路径时不会为了取家目录而多跑一次命令
    assert session.expand_path("/opt/app") == "/opt/app"


def test_build_options_password_auth_ignores_key(patched_ssh, host: HostConfig) -> None:
    host.auth_method = AuthMethod.PASSWORD
    host.private_key_path = "/home/u/.ssh/id_rsa"
    settings = AppSettings(ssh_timeout_seconds=7, ssh_keepalive_seconds=11)
    session = RemoteSession(host, password="pw", settings=settings)
    options = session.build_options()
    assert options.password == "pw"
    assert options.private_key_path == ""
    assert options.timeout == 7
    assert options.keepalive == 11


def test_build_options_key_auth(patched_ssh, host: HostConfig) -> None:
    host.auth_method = AuthMethod.PRIVATE_KEY
    host.private_key_path = "/home/u/.ssh/id_ed25519"
    session = RemoteSession(host, passphrase="pp")
    options = session.build_options()
    assert options.private_key_path == "/home/u/.ssh/id_ed25519"
    assert options.passphrase == "pp"
    assert options.password is None


def test_build_options_falls_back_to_local_default_key(patched_ssh, host: HostConfig, tmp_path, monkeypatch) -> None:
    key_path = tmp_path / "id_ed25519"
    key_path.write_text("fake", encoding="utf-8")
    monkeypatch.setattr(
        session_module, "default_private_key", lambda: PrivateKeyInfo(path=key_path)
    )
    host.auth_method = AuthMethod.PRIVATE_KEY
    host.private_key_path = ""
    session = RemoteSession(host)
    assert session.build_options().private_key_path == str(key_path)


def test_repo_info_is_cached(patched_ssh, host: HostConfig, monkeypatch) -> None:
    session = RemoteSession(host)
    session.connect()
    calls = {"count": 0}

    def fake_repo_info(directory: str) -> RepoInfo:
        calls["count"] += 1
        return RepoInfo(directory=directory, is_repository=True, root="/repo", branch="main")

    monkeypatch.setattr(session.git, "repo_info", fake_repo_info)
    first = session.repo_info()
    second = session.repo_info()
    assert first is second
    assert calls["count"] == 1
    session.repo_info(refresh=True)
    assert calls["count"] == 2


def test_repo_info_handles_git_failure(patched_ssh, host: HostConfig, monkeypatch) -> None:
    session = RemoteSession(host)
    session.connect()

    def boom(directory: str) -> RepoInfo:
        raise RuntimeError("git not found")

    monkeypatch.setattr(session.git, "repo_info", boom)
    info = session.repo_info()
    assert not info.is_repository
    assert "git not found" in info.error


def test_ensure_connected_reconnects(patched_ssh, host: HostConfig) -> None:
    session = RemoteSession(host)
    session.connect()
    client = patched_ssh.instances[-1]
    client.connected = False
    session.ensure_connected()
    assert client.connected is True
    client.connected = False
    session.reconnect()
    assert client.reconnects == 1


def test_close_releases_connection(patched_ssh, host: HostConfig) -> None:
    session = RemoteSession(host)
    session.connect()
    client = patched_ssh.instances[-1]
    session.close()
    assert client.closed
    assert not session.connected
    assert session._ssh is None


def test_state_snapshot(patched_ssh, host: HostConfig) -> None:
    session = RemoteSession(host)
    session.connect()
    state = session.state()
    assert state.connected
    assert state.connection_label == "SSH: Connected"
    assert state.host_name == "Robot-3566"


def test_fingerprint_conflict_detection() -> None:
    first = FileFingerprint(path="/a.c", size=10, mtime=100.0)
    same = FileFingerprint(path="/a.c", size=10, mtime=100.0)
    changed = FileFingerprint(path="/a.c", size=12, mtime=101.0)
    assert not first.differs_from(same)
    assert first.differs_from(changed)
    assert first.differs_from(None)
