"""真实 SSH / SFTP / Git 端到端测试。

用 paramiko 在本机启动一个**真实的 SSH 服务端**（内存中，绑定 127.0.0.1 随机端口），
再让本项目的 :class:`SSHClient` / :class:`SftpClient` / :class:`GitClient` /
:class:`RemoteSession` 真正走一遍 SSH 协议：

* 连接 / 密钥认证 / 密码认证 / 认证失败 / 连接被拒绝；
* 远程命令执行（真实 subprocess）；
* SFTP 目录列表、下载、上传、新建、重命名、删除（真实文件系统）；
* 在真实 git 仓库上获取并解析行级 diff；
* 最后通过 MainWindow 走一遍「打开 → 编辑 → 保存 → 远端文件更新」。

若当前环境不允许绑定/连接本地端口，整个模块会被跳过（不影响其它测试）。
"""

from __future__ import annotations

import os
import posixpath
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import List

import paramiko
import pytest

from app.config.hosts import AuthMethod, HostConfig
from app.git.git_client import GitClient
from app.git.models import ChangeType
from app.remote.session import RemoteSession
from app.remote.sftp_client import SftpClient
from app.remote.ssh_client import SSHClient, SSHConnectionOptions
from app.ui import remote_ops
from app.utils.errors import SSHAuthenticationError, SSHConnectionError, SSHSessionClosedError

USERNAME = "tester"
PASSWORD = "s3cret-pw"


# ---------------------------------------------------------------------------
# 服务端实现
# ---------------------------------------------------------------------------


class LocalSFTPServerInterface(paramiko.SFTPServerInterface):
    """把 SFTP 请求映射到本地文件系统。

    本类是**测试桩**：绝对路径按原样使用（远端与本地同机），
    相对路径则相对于 ``root`` 解析。
    """

    def __init__(self, server, root=None, *largs, **kwargs) -> None:
        self.root = str(root)
        super().__init__(server, *largs, **kwargs)

    # -- 路径 --------------------------------------------------------------
    def _real(self, path: str) -> str:
        if path.startswith("/"):
            return os.path.normpath(path)
        return os.path.normpath(os.path.join(self.root, path))

    def canonicalize(self, path: str) -> str:
        return posixpath.normpath(posixpath.join("/", path))

    # -- 目录 --------------------------------------------------------------
    def list_folder(self, path: str):
        try:
            entries = []
            for name in os.listdir(self._real(path)):
                full = os.path.join(self._real(path), name)
                attr = paramiko.SFTPAttributes.from_stat(os.stat(full))
                attr.filename = name
                entries.append(attr)
            return entries
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def stat(self, path: str):
        try:
            return paramiko.SFTPAttributes.from_stat(os.stat(self._real(path)))
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def lstat(self, path: str):
        try:
            return paramiko.SFTPAttributes.from_stat(os.lstat(self._real(path)))
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def mkdir(self, path: str, attr):
        try:
            os.mkdir(self._real(path))
            if attr is not None:
                paramiko.SFTPServer.set_file_attr(self._real(path), attr)
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def rmdir(self, path: str):
        try:
            os.rmdir(self._real(path))
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def remove(self, path: str):
        try:
            os.remove(self._real(path))
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def rename(self, oldpath: str, newpath: str):
        try:
            os.rename(self._real(oldpath), self._real(newpath))
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def chattr(self, path: str, attr):
        try:
            paramiko.SFTPServer.set_file_attr(self._real(path), attr)
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def symlink(self, target_path: str, path: str):
        try:
            os.symlink(target_path, self._real(path))
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def readlink(self, path: str):
        try:
            return os.readlink(self._real(path))
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    # -- 文件 --------------------------------------------------------------
    def open(self, path: str, flags: int, attr):
        real = self._real(path)
        try:
            binary_flag = getattr(os, "O_BINARY", 0)
            flags |= binary_flag
            mode = getattr(attr, "st_mode", None)
            fd = os.open(real, flags, mode) if mode is not None else os.open(real, flags)
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)
        if flags & os.O_WRONLY:
            file_mode = "ab" if flags & os.O_APPEND else "wb"
        elif flags & os.O_RDWR:
            file_mode = "a+b" if flags & os.O_APPEND else "r+b"
        else:
            file_mode = "rb"
        try:
            handle_file = os.fdopen(fd, file_mode)
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)
        handle = paramiko.SFTPHandle(flags)
        handle.filename = real
        handle.readfile = handle_file
        handle.writefile = handle_file
        return handle


class LocalSSHServerInterface(paramiko.ServerInterface):
    """极简 SSH 服务端：公钥 / 密码认证 + session + exec + sftp。"""

    def __init__(self, authorized_fingerprint: bytes, root: Path) -> None:
        self.authorized_fingerprint = authorized_fingerprint
        self.root = root
        self.shell_events: List[threading.Event] = []

    def check_auth_publickey(self, username: str, key: paramiko.PKey) -> int:
        if username == USERNAME and key.get_fingerprint() == self.authorized_fingerprint:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_auth_password(self, username: str, password: str) -> int:
        if username == USERNAME and password == PASSWORD:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username: str) -> str:
        return "publickey,password"

    def check_channel_request(self, kind: str, chanid: int) -> int:
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command: bytes) -> bool:
        command_text = command.decode("utf-8")
        event = threading.Event()
        self.shell_events.append(event)
        threading.Thread(
            target=self._run_command, args=(channel, command_text, event), daemon=True
        ).start()
        return True

    def check_channel_shell_request(self, channel) -> bool:
        return True

    def check_channel_pty_request(self, *args, **kwargs) -> bool:  # pragma: no cover
        return True

    def _run_command(self, channel, command_text: str, event: threading.Event) -> None:
        env = dict(os.environ)
        # 让「远端」的家目录就是服务端根目录，这样 ~ 展开后才能被 SFTP 解析到
        env["HOME"] = str(self.root)
        env.setdefault("GIT_AUTHOR_NAME", "Remote Tester")
        env.setdefault("GIT_AUTHOR_EMAIL", "tester@example.invalid")
        env.setdefault("GIT_COMMITTER_NAME", "Remote Tester")
        env.setdefault("GIT_COMMITTER_EMAIL", "tester@example.invalid")
        try:
            process = subprocess.run(
                command_text,
                shell=True,
                cwd=str(self.root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            if process.stdout:
                channel.sendall(process.stdout)
            if process.stderr:
                channel.sendall_stderr(process.stderr)
            channel.send_exit_status(process.returncode)
        finally:
            channel.close()
            event.set()


class InProcessSSHServer:
    """监听 127.0.0.1 的 SSH 服务端。"""

    def __init__(self, root: Path, authorized_fingerprint: bytes) -> None:
        self.root = Path(root)
        self.host_key = paramiko.RSAKey.generate(2048)
        self.interface_factory = lambda: LocalSSHServerInterface(
            authorized_fingerprint, self.root
        )
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.port = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def start(self) -> None:
        """绑定端口并开始监听；环境不允许时抛出 OSError（由测试跳过）。"""
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen(8)
        self.port = int(self.socket.getsockname()[1])
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            self.socket.close()
        except OSError:  # pragma: no cover
            pass

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                client, _address = self.socket.accept()
            except OSError:  # pragma: no cover - 关闭时
                return
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client_socket: socket.socket) -> None:
        transport = paramiko.Transport(client_socket)
        transport.add_server_key(self.host_key)
        transport.set_subsystem_handler(
            "sftp", paramiko.SFTPServer, LocalSFTPServerInterface, str(self.root)
        )
        server = self.interface_factory()
        try:
            transport.start_server(server=server)
            while transport.is_active():
                time.sleep(0.05)
        except Exception:  # pragma: no cover - 客户端断开
            pass
        finally:
            transport.close()


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def ssh_root(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("remote-root")


@pytest.fixture(scope="module")
def client_key_path(tmp_path_factory) -> Path:
    key = paramiko.RSAKey.generate(2048)
    path = tmp_path_factory.mktemp("keys") / "id_rsa"
    key.write_private_key_file(str(path))
    return path


@pytest.fixture(scope="module")
def ssh_server(ssh_root: Path, client_key_path: Path):
    key = paramiko.RSAKey.from_private_key_file(str(client_key_path))
    try:
        server = InProcessSSHServer(ssh_root, key.get_fingerprint())
        server.start()
    except (OSError, PermissionError, paramiko.SSHException) as exc:  # pragma: no cover - 受限环境
        pytest.skip(f"无法绑定本地端口，跳过真实 SSH 测试：{exc}", allow_module_level=True)
    yield server
    server.stop()


@pytest.fixture
def ssh_client(ssh_server: InProcessSSHServer, client_key_path: Path):
    client = SSHClient(
        SSHConnectionOptions(
            host="127.0.0.1",
            port=ssh_server.port,
            username=USERNAME,
            private_key_path=str(client_key_path),
            timeout=10,
            keepalive=0,
        )
    )
    try:
        client.connect()
    except SSHConnectionError as exc:  # pragma: no cover - 受限环境
        pytest.skip(f"无法连接本地 SSH 服务，跳过：{exc}")
    yield client
    client.close()


@pytest.fixture
def repo_root(ssh_server: InProcessSSHServer) -> Path:
    """在远端根目录下创建一个真实的 git 仓库。"""
    root = ssh_server.root / "project"
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Remote Tester",
        "GIT_AUTHOR_EMAIL": "tester@example.invalid",
        "GIT_COMMITTER_NAME": "Remote Tester",
        "GIT_COMMITTER_EMAIL": "tester@example.invalid",
    }
    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=root, check=True, env=env, capture_output=True)

    git("init", "-b", "main")
    (root / "main.c").write_text("int main() {\n    return 0;\n}\n", encoding="utf-8")
    (root / "util.c").write_text("void util(void) {}\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-m", "initial commit")
    return root


# ---------------------------------------------------------------------------
# 连接
# ---------------------------------------------------------------------------


def test_connect_with_private_key(ssh_client: SSHClient) -> None:
    assert ssh_client.connected


def test_exec_command_returns_output(ssh_client: SSHClient) -> None:
    result = ssh_client.exec_command("echo hello && pwd")
    assert result.ok
    assert "hello" in result.stdout


def test_exec_command_reports_failure(ssh_client: SSHClient) -> None:
    result = ssh_client.exec_command("exit 3")
    assert not result.ok
    assert result.exit_status == 3


def test_password_authentication(ssh_server: InProcessSSHServer) -> None:
    client = SSHClient(
        SSHConnectionOptions(
            host="127.0.0.1",
            port=ssh_server.port,
            username=USERNAME,
            password=PASSWORD,
            timeout=10,
            keepalive=0,
        )
    )
    client.connect()
    try:
        assert client.connected
    finally:
        client.close()


def test_wrong_password_raises_authentication_error(ssh_server: InProcessSSHServer) -> None:
    client = SSHClient(
        SSHConnectionOptions(
            host="127.0.0.1",
            port=ssh_server.port,
            username=USERNAME,
            password="wrong-password",
            timeout=10,
            keepalive=0,
        )
    )
    with pytest.raises(SSHAuthenticationError):
        client.connect()


def test_connection_refused_is_friendly() -> None:
    # 找一个未被监听的端口
    try:
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = int(probe.getsockname()[1])
        probe.close()
    except OSError as exc:  # pragma: no cover - 受限环境
        pytest.skip(f"当前环境不允许操作 socket：{exc}")
    client = SSHClient(
        SSHConnectionOptions(
            host="127.0.0.1",
            port=port,
            username="nobody",
            password="x",
            timeout=3,
            keepalive=0,
        )
    )
    with pytest.raises(SSHConnectionError):
        client.connect()


def test_missing_credentials_raises_auth_error() -> None:
    """未填写密码且未选择私钥时，应立即给出清晰提示。"""
    client = SSHClient(
        SSHConnectionOptions(host="127.0.0.1", port=22, username="root", timeout=3, keepalive=0)
    )
    with pytest.raises(SSHAuthenticationError):
        client.connect()


def test_disconnect_and_reconnect(ssh_server: InProcessSSHServer, client_key_path: Path) -> None:
    client = SSHClient(
        SSHConnectionOptions(
            host="127.0.0.1",
            port=ssh_server.port,
            username=USERNAME,
            private_key_path=str(client_key_path),
            timeout=10,
            keepalive=0,
        )
    )
    client.connect()
    client.close()
    assert not client.connected
    with pytest.raises(SSHSessionClosedError):
        client.exec_command("echo x")
    client.reconnect()
    assert client.connected
    assert client.exec_command("echo ok").ok
    client.close()


# ---------------------------------------------------------------------------
# SFTP（真实文件系统）
# ---------------------------------------------------------------------------


def test_sftp_list_and_download(ssh_client: SSHClient, repo_root: Path) -> None:
    client = SftpClient(ssh_client)
    names = {entry.name for entry in client.list_dir(str(repo_root))}
    assert {"main.c", "util.c", ".git"} <= names

    decoded = client.read_text(str(repo_root / "main.c"))
    assert decoded.text == "int main() {\n    return 0;\n}\n"


def test_sftp_upload_changes_real_file(ssh_client: SSHClient, repo_root: Path) -> None:
    client = SftpClient(ssh_client)
    target = str(repo_root / "main.c")
    client.write_text(target, "int main() {\n    return 42;\n}\n")
    assert (repo_root / "main.c").read_text(encoding="utf-8") == "int main() {\n    return 42;\n}\n"
    # 原子写不应留下临时文件
    leftovers = [name for name in os.listdir(repo_root) if name.startswith(".rce-upload-")]
    assert leftovers == []


def test_sftp_create_rename_delete(ssh_client: SSHClient, repo_root: Path) -> None:
    client = SftpClient(ssh_client)
    client.mkdir(str(repo_root / "build"), parents=True)
    client.create_file(str(repo_root / "build" / "note.txt"), content="hi\n")
    assert (repo_root / "build" / "note.txt").read_text(encoding="utf-8") == "hi\n"

    client.rename(str(repo_root / "build" / "note.txt"), str(repo_root / "build" / "readme.txt"))
    assert (repo_root / "build" / "readme.txt").exists()

    client.remove(str(repo_root / "build" / "readme.txt"))
    client.remove(str(repo_root / "build"), is_dir=True, recursive=True)
    assert not (repo_root / "build").exists()


def test_sftp_missing_file_error(ssh_client: SSHClient, repo_root: Path) -> None:
    from app.utils.errors import RemoteFileNotFoundError

    client = SftpClient(ssh_client)
    with pytest.raises(RemoteFileNotFoundError):
        client.read_bytes(str(repo_root / "ghost.c"))


def test_sftp_preserves_unicode_content(ssh_client: SSHClient, repo_root: Path) -> None:
    client = SftpClient(ssh_client)
    target = str(repo_root / "notes.md")
    client.write_text(target, "# 中文标题\n", encoding="utf-8")
    assert (repo_root / "notes.md").read_text(encoding="utf-8") == "# 中文标题\n"


# ---------------------------------------------------------------------------
# Git（真实仓库）
# ---------------------------------------------------------------------------


def test_git_repo_info_over_ssh(ssh_client: SSHClient, repo_root: Path) -> None:
    git = GitClient(ssh_client)
    info = git.repo_info(str(repo_root))
    assert info.is_repository
    assert info.branch == "main"
    assert info.root == str(repo_root)


def test_git_diff_over_ssh(ssh_client: SSHClient, repo_root: Path) -> None:
    (repo_root / "main.c").write_text(
        "int main() {\n    return 1;\n}\n// added tail\n", encoding="utf-8"
    )
    git = GitClient(ssh_client)
    content = (repo_root / "main.c").read_text(encoding="utf-8")
    diff = git.file_diff(str(repo_root), "main.c", content=content)
    assert diff.markers == {
        2: ChangeType.MODIFIED,
        4: ChangeType.ADDED,
    }


def test_git_diff_for_untracked_file(ssh_client: SSHClient, repo_root: Path) -> None:
    (repo_root / "brand_new.c").write_text("a\nb\n", encoding="utf-8")
    git = GitClient(ssh_client)
    diff = git.file_diff(str(repo_root), "brand_new.c", content="a\nb\n")
    assert diff.markers == {1: ChangeType.ADDED, 2: ChangeType.ADDED}


def test_git_tree_status_over_ssh(ssh_client: SSHClient, repo_root: Path) -> None:
    """真实仓库上验证状态快照：文件 / 目录着色与 diff 复用都基于它。"""
    (repo_root / "main.c").write_text("int main() {\n    return 1;\n}\n", encoding="utf-8")
    (repo_root / "brand_new.c").write_text("a\nb\n", encoding="utf-8")
    (repo_root / "util.c").unlink()
    git = GitClient(ssh_client)

    tree = git.tree_status(str(repo_root))

    assert tree.is_repository
    assert tree.branch == "main"
    assert tree.files[f"{repo_root}/main.c"] is ChangeType.MODIFIED
    assert tree.files[f"{repo_root}/brand_new.c"] is ChangeType.ADDED
    assert tree.files[f"{repo_root}/util.c"] is ChangeType.DELETED
    assert tree.dirs[str(repo_root)] is ChangeType.DELETED
    assert tree.label == "Git: main · 3 处变更"
    assert tree.status_for_diff(f"{repo_root}/main.c").worktree_status == "M"
    # 未修改且不在 status 输出里的文件 → 判定为干净，可跳过远端 git 调用
    clean = tree.status_for_diff(f"{repo_root}/main.c.orig")
    assert clean is not None
    assert clean.change_type is None


def test_git_diff_skips_remote_work_for_clean_file(
    ssh_client: SSHClient, repo_root: Path
) -> None:
    """未修改的文件：快照判定干净后不再执行任何远端 git 命令。"""
    git = GitClient(ssh_client)
    tree = git.tree_status(str(repo_root))
    status = tree.status_for_diff(f"{repo_root}/main.c")
    assert status.change_type is None

    diff = git.file_diff(
        str(repo_root), "main.c", content=(repo_root / "main.c").read_text(), status=status
    )

    assert diff.markers == {}
    assert not diff.has_changes


def test_git_diff_for_deleted_lines(ssh_client: SSHClient, repo_root: Path) -> None:
    # 删除文件中的一行（保留其他行），删除标记落在其后续行
    (repo_root / "multi.c").write_text("a\nb\nc\n", encoding="utf-8")
    subprocess.run(["git", "add", "multi.c"], cwd=repo_root, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "add multi.c"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "T",
            "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "T",
            "GIT_COMMITTER_EMAIL": "t@example.invalid",
        },
    )
    (repo_root / "multi.c").write_text("a\nc\n", encoding="utf-8")
    git = GitClient(ssh_client)
    diff = git.file_diff(str(repo_root), "multi.c", content="a\nc\n")
    assert diff.markers == {2: ChangeType.DELETED}


def test_git_diff_when_all_lines_removed(ssh_client: SSHClient, repo_root: Path) -> None:
    (repo_root / "emptied.c").write_text("only line\n", encoding="utf-8")
    subprocess.run(["git", "add", "emptied.c"], cwd=repo_root, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "add emptied.c"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "T",
            "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "T",
            "GIT_COMMITTER_EMAIL": "t@example.invalid",
        },
    )
    (repo_root / "emptied.c").write_text("", encoding="utf-8")
    git = GitClient(ssh_client)
    diff = git.file_diff(str(repo_root), "emptied.c", content="")
    assert diff.markers == {1: ChangeType.DELETED}


def test_not_a_repository(ssh_client: SSHClient, ssh_server: InProcessSSHServer) -> None:
    outside = ssh_server.root / "no-repo"
    outside.mkdir(exist_ok=True)
    git = GitClient(ssh_client)
    info = git.repo_info(str(outside))
    assert not info.is_repository
    assert info.label == "Git: Not a repository"


# ---------------------------------------------------------------------------
# 会话 / 编排层（真实 SSH）
# ---------------------------------------------------------------------------


def test_remote_session_full_flow(ssh_server: InProcessSSHServer, client_key_path: Path, repo_root: Path):
    host = HostConfig(
        name="Local-Test",
        host="127.0.0.1",
        port=ssh_server.port,
        username=USERNAME,
        auth_method=AuthMethod.PRIVATE_KEY,
        private_key_path=str(client_key_path),
        remote_workspace=str(repo_root),
    )
    session = RemoteSession(host, settings=_fast_settings())
    session.connect()
    try:
        assert session.connected
        assert session.repo_info().is_repository

        loaded = remote_ops.load_file(session, f"{repo_root}/main.c")
        assert loaded.text.startswith("int main()")

        # 修改本地内容 → 上传 → 远端文件真实变化
        updated = loaded.text.replace("return 0", "return 7")
        remote_ops.save_file(session, f"{repo_root}/main.c", updated)
        assert "return 7" in (repo_root / "main.c").read_text(encoding="utf-8")

        diff = remote_ops.load_git_diff(session, f"{repo_root}/main.c", updated)
        assert diff.markers, "修改后应产生行级标记"

        # 目录列表
        path, entries = remote_ops.list_directory(session, str(repo_root))
        assert path == str(repo_root)
        assert any(entry.name == "main.c" for entry in entries)
    finally:
        session.close()
    assert not session.connected


# ---------------------------------------------------------------------------
# MainWindow 端到端（打开 → 编辑 → Ctrl+S → 远端更新 + Gutter 标记）
# ---------------------------------------------------------------------------


def test_session_expands_tilde_workspace(
    ssh_server: InProcessSSHServer, client_key_path: Path, ssh_root: Path, repo_root: Path
):
    """回归：主机配置写 ``~/project/`` 时必须先展开成绝对路径再交给 SFTP。

    SFTP 不像交互式 shell 那样展开 ``~``，之前的实现会把 ``~/ros2_ws/src/``
    原样发给 SFTP 并得到 ENOENT。
    """
    host = HostConfig(
        name="Local-Test",
        host="127.0.0.1",
        port=ssh_server.port,
        username=USERNAME,
        auth_method=AuthMethod.PRIVATE_KEY,
        private_key_path=str(client_key_path),
        remote_workspace="~/project/",
    )
    session = RemoteSession(host, settings=_fast_settings())
    session.connect()
    try:
        assert session.home == str(ssh_root)
        assert session.workspace == str(repo_root)
        _path, entries = remote_ops.list_directory(session, session.workspace)
        assert {entry.name for entry in entries} >= {"main.c", "util.c"}
    finally:
        session.close()


def test_folder_picker_over_real_sftp(
    qtbot,
    ssh_server: InProcessSSHServer,
    client_key_path: Path,
    ssh_root: Path,
    repo_root: Path,
):
    """连接后选目录：默认落在远端家目录，只列目录，选中后路径可直接使用。"""
    from app.ui.workspace_dialog import RemoteFolderPickerDialog

    host = HostConfig(
        name="Local-Test",
        host="127.0.0.1",
        port=ssh_server.port,
        username=USERNAME,
        auth_method=AuthMethod.PRIVATE_KEY,
        private_key_path=str(client_key_path),
    )
    session = RemoteSession(host, settings=_fast_settings())
    session.connect()
    dialog = RemoteFolderPickerDialog(session, initial_path="~")
    qtbot.addWidget(dialog)
    try:
        qtbot.waitUntil(lambda: dialog.path_edit.text() == str(ssh_root), timeout=15000)
        names = [dialog.list_widget.item(i).text() for i in range(dialog.list_widget.count())]
        assert "project" in names
        assert "main.c" not in names  # 只列目录

        item = next(
            dialog.list_widget.item(i)
            for i in range(dialog.list_widget.count())
            if dialog.list_widget.item(i).text() == "project"
        )
        dialog._on_item_activated(item)
        qtbot.waitUntil(lambda: dialog.chosen_path() == str(repo_root), timeout=15000)
        child_names = [
            dialog.list_widget.item(i).text() for i in range(dialog.list_widget.count())
        ]
        assert "main.c" not in child_names and "util.c" not in child_names  # 只列目录

        # 选中的目录可以立刻用来列目录
        _path, entries = remote_ops.list_directory(session, dialog.chosen_path())
        assert {entry.name for entry in entries} >= {"main.c", "util.c"}
    finally:
        dialog.close()
        session.close()


@pytest.fixture
def window(qtbot, tmp_path):
    from app.cache.file_cache import FileCache
    from app.config.hosts import HostStore
    from app.config.settings import SettingsStore
    from app.ui.main_window import MainWindow

    widget = MainWindow(
        settings_store=SettingsStore(tmp_path / "settings.json"),
        host_store=HostStore(tmp_path / "hosts.json"),
        cache=FileCache(tmp_path / "cache"),
    )
    widget._confirm_exit_with_unsaved = lambda: True  # type: ignore[method-assign]
    qtbot.addWidget(widget)
    return widget


def test_main_window_edit_and_save_against_real_ssh(
    qtbot, window, ssh_server: InProcessSSHServer, client_key_path: Path, repo_root: Path
):
    host = HostConfig(
        name="Local-Test",
        host="127.0.0.1",
        port=ssh_server.port,
        username=USERNAME,
        auth_method=AuthMethod.PRIVATE_KEY,
        private_key_path=str(client_key_path),
        remote_workspace=str(repo_root),
    )
    session = RemoteSession(host, settings=_fast_settings())
    session.connect()
    window.session = session
    window.workspace = str(repo_root)
    window._update_status_connection(True)

    main_c = f"{repo_root}/main.c"
    window.open_remote_file(main_c)
    qtbot.waitUntil(lambda: window.editor_tabs.index_of_path(main_c) >= 0, timeout=15000)

    editor = window.editor_tabs.editor_for_path(main_c)
    assert editor is not None
    assert editor.language == "C"

    # 初始状态：文件与 HEAD 一致 → 无标记
    qtbot.wait(300)
    assert window.editor_tabs.document_for_path(main_c).diff.markers == {}

    # 编辑（纯本地）
    editor.set_plain_text_silent(
        "int main() {\n    return 9;\n}\n", language="C"
    )
    editor.document().setModified(True)

    window._save_document(window.editor_tabs.document_for_path(main_c))
    qtbot.waitUntil(
        lambda: "return 9" in (repo_root / "main.c").read_text(encoding="utf-8"),
        timeout=15000,
    )

    # 保存后应刷新出 Git 行级标记
    qtbot.waitUntil(
        lambda: bool(window.editor_tabs.document_for_path(main_c).diff.markers), timeout=15000
    )
    document = window.editor_tabs.document_for_path(main_c)
    assert document.diff.markers == {2: ChangeType.MODIFIED}
    assert editor.marker_counts()[ChangeType.MODIFIED] == 1
    assert not document.dirty

    session.close()


def _fast_settings():
    from app.config.settings import AppSettings

    return AppSettings(ssh_timeout_seconds=10, ssh_keepalive_seconds=0, ssh_strict_host_key=False)
