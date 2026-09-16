"""SSH 客户端封装（基于 paramiko，不依赖系统 ssh 命令）。

设计要点：

* 只暴露 :mod:`app.utils.errors` 中的异常类型，UI 层无需认识 paramiko；
* ``connect()`` / ``exec_command()`` 在调用线程执行，由上层放入工作线程，
  本类自身不创建线程，也不依赖 Qt，便于单元测试；
* 密码 / passphrase 会在连接时登记到日志脱敏器，避免误写入日志。
"""

from __future__ import annotations

import logging
import socket
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import paramiko

from app.utils.errors import (
    SSHAuthenticationError,
    SSHConnectionError,
    SSHHostKeyError,
    SSHSessionClosedError,
    SSHTimeoutError,
)
from app.utils.logging_setup import forget_secret, register_secret

logger = logging.getLogger(__name__)

DEFAULT_CONNECT_TIMEOUT = 15.0
DEFAULT_KEEPALIVE = 30


@dataclass
class SSHConnectionOptions:
    """建立一条 SSH 连接所需的全部参数。"""

    host: str
    port: int = 22
    username: str = "root"
    password: Optional[str] = None
    private_key_path: str = ""
    passphrase: Optional[str] = None
    timeout: float = DEFAULT_CONNECT_TIMEOUT
    keepalive: int = DEFAULT_KEEPALIVE
    strict_host_key: bool = False
    known_hosts_path: Optional[Path] = None
    allow_agent: bool = False
    extra: dict = field(default_factory=dict)

    @property
    def target(self) -> str:
        return f"{self.username}@{self.host}:{self.port}"


@dataclass(frozen=True)
class CommandResult:
    """远程命令执行结果。"""

    command: str
    exit_status: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.exit_status == 0

    @property
    def output(self) -> str:
        return self.stdout if self.stdout else self.stderr

    def raise_for_status(self, message: str = "远程命令执行失败") -> "CommandResult":
        from app.utils.errors import SSHError

        if not self.ok:
            detail = (self.stderr or self.stdout or "").strip()
            raise SSHError(f"{message}：{detail[:400]}" if detail else message)
        return self


def load_private_key(path: Path, *, passphrase: Optional[str] = None) -> paramiko.PKey:
    """从文件加载私钥。

    paramiko 3.x 提供 :meth:`PKey.from_path`；2.9 需要按类型逐个尝试，
    这里统一封装，保证两种版本都能用。
    """
    from_path = getattr(paramiko.PKey, "from_path", None)
    if callable(from_path):
        return from_path(str(path), passphrase=passphrase)

    key_classes = [
        getattr(paramiko, name)
        for name in ("Ed25519Key", "ECDSAKey", "RSAKey", "DSSKey")
        if hasattr(paramiko, name)
    ]
    last_error: Optional[Exception] = None
    for key_class in key_classes:
        try:
            return key_class.from_private_key_file(str(path), password=passphrase)
        except paramiko.PasswordRequiredException:
            raise
        except paramiko.SSHException as exc:
            last_error = exc
            continue
    raise paramiko.SSHException(f"无法解析私钥文件：{last_error}")


class SSHClient:
    """一条可复用的 SSH 连接（含按需创建的 SFTP 子系统）。"""

    def __init__(self, options: SSHConnectionOptions) -> None:
        self.options = options
        self._client: Optional[paramiko.SSHClient] = None
        self._sftp: Optional[paramiko.SFTPClient] = None
        self._secrets: list[str] = []
        self._lock = threading.RLock()

    # -- 状态 --------------------------------------------------------------
    @property
    def connected(self) -> bool:
        client = self._client
        if client is None:
            return False
        transport = client.get_transport()
        return bool(transport and transport.is_active())

    @property
    def transport(self) -> Optional[paramiko.Transport]:
        if self._client is None:
            return None
        return self._client.get_transport()

    @property
    def lock(self) -> threading.RLock:
        """串行化 SFTP 等非线程安全操作的锁。"""
        return self._lock

    # -- 连接管理 ----------------------------------------------------------
    def connect(self) -> None:
        """建立连接；失败时抛出统一的 SSH 异常。"""
        with self._lock:
            if self.connected:
                return
            self._close_locked()

            client = paramiko.SSHClient()
            client.set_log_channel("paramiko")
            if self.options.strict_host_key:
                client.load_system_host_keys()
                if self.options.known_hosts_path and self.options.known_hosts_path.exists():
                    client.load_host_keys(str(self.options.known_hosts_path))
                client.set_missing_host_key_policy(paramiko.RejectPolicy())
            else:
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            key, key_error = self._load_private_key()
            if key_error is not None and not self.options.password:
                raise key_error
            if key is None and not self.options.password:
                raise SSHAuthenticationError(
                    "未提供认证凭据：请填写密码，或选择私钥文件认证"
                )

            self._register_secrets()
            logger.info("连接 SSH %s", self.options.target)
            try:
                client.connect(
                    hostname=self.options.host,
                    port=int(self.options.port),
                    username=self.options.username,
                    password=self.options.password,
                    pkey=key,
                    timeout=float(self.options.timeout),
                    banner_timeout=float(self.options.timeout),
                    auth_timeout=float(self.options.timeout),
                    allow_agent=self.options.allow_agent,
                    look_for_keys=False,
                    compress=True,
                )
            except paramiko.AuthenticationException as exc:
                self._forget_secrets()
                raise SSHAuthenticationError(detail=str(exc)) from exc
            except paramiko.BadHostKeyException as exc:
                self._forget_secrets()
                raise SSHHostKeyError(detail=str(exc)) from exc
            except socket.timeout as exc:
                self._forget_secrets()
                raise SSHTimeoutError(detail=str(exc)) from exc
            except (ConnectionRefusedError, OSError) as exc:
                self._forget_secrets()
                raise self._wrap_network_error(exc) from exc
            except paramiko.SSHException as exc:
                self._forget_secrets()
                raise SSHConnectionError(f"SSH 协商失败：{exc}", detail=str(exc)) from exc
            except Exception as exc:  # pragma: no cover - 兜底
                self._forget_secrets()
                raise SSHConnectionError(detail=str(exc)) from exc

            transport = client.get_transport()
            if transport is not None and self.options.keepalive:
                transport.set_keepalive(int(self.options.keepalive))
            self._client = client
            logger.info("SSH 已连接 %s", self.options.target)

    def close(self) -> None:
        """关闭连接并清理敏感值登记。"""
        with self._lock:
            self._close_locked()

    def reconnect(self) -> None:
        """断线重连。"""
        logger.info("尝试重新连接 %s", self.options.target)
        self.close()
        self.connect()

    def ensure_connected(self) -> None:
        """工作线程在操作前调用；连接失效时自动重连一次。"""
        if self.connected:
            return
        logger.warning("SSH 连接不可用，尝试重连 %s", self.options.target)
        self.reconnect()

    # -- 命令执行 ----------------------------------------------------------
    def exec_command(self, command: str, *, timeout: Optional[float] = None) -> CommandResult:
        """执行远程命令并返回结果。"""
        with self._lock:
            client = self._require_client()
            wait = float(timeout if timeout is not None else self.options.timeout + 10)
            logger.debug("执行远程命令: %s", command)
            try:
                _stdin, stdout, stderr = client.exec_command(command, timeout=wait)
            except (paramiko.SSHException, OSError, socket.timeout) as exc:
                raise self._wrap_network_error(exc) from exc
            try:
                out = stdout.read().decode("utf-8", errors="replace")
                err = stderr.read().decode("utf-8", errors="replace")
                status = stdout.channel.recv_exit_status()
            except (paramiko.SSHException, OSError, socket.timeout) as exc:
                raise self._wrap_network_error(exc) from exc
        result = CommandResult(command=command, exit_status=status, stdout=out, stderr=err)
        logger.debug("命令结束 status=%s stderr=%s", status, err.strip()[:200])
        return result

    # -- SFTP --------------------------------------------------------------
    def open_sftp(self) -> paramiko.SFTPClient:
        """获取（或创建）SFTP 会话。"""
        with self._lock:
            if self._sftp is not None:
                return self._sftp
            client = self._require_client()
            try:
                self._sftp = client.open_sftp()
            except (paramiko.SSHException, OSError, socket.timeout) as exc:
                raise self._wrap_network_error(exc) from exc
            logger.debug("SFTP 子系统已建立")
            return self._sftp

    def drop_sftp(self) -> None:
        """丢弃缓存的 SFTP 会话（断线后调用）。"""
        with self._lock:
            self._sftp = None

    # -- 内部 --------------------------------------------------------------
    def _require_client(self) -> paramiko.SSHClient:
        if not self.connected:
            raise SSHSessionClosedError("SSH 连接已断开，请重新连接")
        assert self._client is not None
        return self._client

    def _close_locked(self) -> None:
        if self._sftp is not None:
            try:
                self._sftp.close()
            except Exception:  # pragma: no cover
                pass
            self._sftp = None
        if self._client is not None:
            try:
                self._client.close()
            except Exception:  # pragma: no cover
                pass
            self._client = None
        self._forget_secrets()

    def _load_private_key(self) -> tuple[Optional[paramiko.PKey], Optional[Exception]]:
        path_text = (self.options.private_key_path or "").strip()
        if not path_text:
            return None, None
        path = Path(path_text)
        if not path.exists():
            return None, SSHConnectionError(f"私钥文件不存在：{path}")
        try:
            key = load_private_key(path, passphrase=self.options.passphrase)
        except paramiko.PasswordRequiredException:
            return None, SSHAuthenticationError("私钥需要口令（passphrase），请填写")
        except paramiko.SSHException as exc:
            return None, SSHAuthenticationError(f"无法解析私钥：{exc}")
        except OSError as exc:
            return None, SSHConnectionError(f"无法读取私钥文件：{exc}")
        return key, None

    def _register_secrets(self) -> None:
        self._secrets = [value for value in (self.options.password, self.options.passphrase) if value]
        for secret in self._secrets:
            register_secret(secret)

    def _forget_secrets(self) -> None:
        for secret in self._secrets:
            forget_secret(secret)
        self._secrets = []

    def _wrap_network_error(self, exc: BaseException) -> Exception:
        if isinstance(exc, socket.timeout):
            return SSHTimeoutError(detail=str(exc))
        if isinstance(exc, ConnectionRefusedError):
            return SSHConnectionError("连接被拒绝：请确认远端 sshd 已启动且端口正确", detail=str(exc))
        if isinstance(exc, socket.gaierror):
            return SSHConnectionError("无法解析主机地址，请检查 IP / 域名", detail=str(exc))
        if isinstance(exc, paramiko.SSHException):
            return SSHSessionClosedError(f"SSH 会话异常：{exc}", detail=str(exc))
        return SSHConnectionError(detail=str(exc))
