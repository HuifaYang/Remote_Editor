"""交互式 shell 通道：在既有 SSH 连接上开一条 PTY，读写远端的 stdin/stdout。

约束回顾：**远端零常驻服务** —— 这里用的就是 sshd 自带的 shell 通道
（``transport.open_session()`` + ``get_pty()`` + ``invoke_shell()``），远端什么都不用装。

本模块**不认识 Qt**：读取线程把解码好的文本交给回调，回调由 UI 层负责切回 GUI 线程。
这样终端内核可以脱离界面单测（见 ``tests/test_shell_channel.py``）。
"""

from __future__ import annotations

import codecs
import logging
import socket
import threading
from typing import Callable, Optional

import paramiko

from app.remote.ssh_client import SSHClient
from app.utils.errors import SSHConnectionError

logger = logging.getLogger(__name__)

#: 终端类型：让远端程序知道我们支持 256 色 / 真彩
DEFAULT_TERM = "xterm-256color"
#: 每次 recv 的最大字节数（远端刷屏时一次读多点，少唤醒 GUI）
READ_CHUNK = 65536
#: recv 超时（秒）：用来周期性检查「是否已被要求退出」，不是网络超时
_POLL_INTERVAL = 0.4


class ShellChannel:
    """一条 shell 通道；``open()`` 阻塞，之后 ``start_reader()`` 起读取线程。"""

    def __init__(
        self,
        ssh: Optional[SSHClient] = None,
        *,
        term: str = DEFAULT_TERM,
        cols: int = 80,
        rows: int = 24,
        encoding: str = "utf-8",
        channel: Optional[object] = None,
    ) -> None:
        self._ssh = ssh
        self._term = term
        self._encoding = encoding
        self._channel = channel
        self._thread: Optional[threading.Thread] = None
        self._closed = threading.Event()
        self._write_lock = threading.Lock()
        self._decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
        self.cols = max(2, int(cols))
        self.rows = max(2, int(rows))

    # -- 生命周期 ----------------------------------------------------------
    def open(self) -> None:
        """建立通道（阻塞，必须放在工作线程）。"""
        if self._channel is not None:
            return
        ssh = self._ssh
        if ssh is None:
            raise SSHConnectionError("没有可用的 SSH 连接")
        with ssh.lock:
            transport = ssh.transport
            if transport is None or not transport.is_active():
                raise SSHConnectionError("SSH 连接已断开，请重新连接")
            try:
                channel = transport.open_session(timeout=ssh.options.timeout)
                channel.get_pty(term=self._term, width=self.cols, height=self.rows)
                channel.invoke_shell()
            except (paramiko.SSHException, OSError, socket.timeout) as exc:
                raise SSHConnectionError(f"打开终端失败：{exc}") from exc
        channel.settimeout(_POLL_INTERVAL)
        self._channel = channel

    def start_reader(
        self,
        on_data: Callable[[str], None],
        on_closed: Optional[Callable[[], None]] = None,
    ) -> None:
        """起读取线程；``on_data`` 收到解码后的文本，流结束调用 ``on_closed``。"""
        if self._thread is not None:  # pragma: no cover - 防御
            return
        self._thread = threading.Thread(
            target=self._read_loop, args=(on_data, on_closed), name="terminal-reader", daemon=True
        )
        self._thread.start()

    def _read_loop(
        self, on_data: Callable[[str], None], on_closed: Optional[Callable[[], None]]
    ) -> None:
        channel = self._channel
        while not self._closed.is_set() and channel is not None:
            try:
                data = channel.recv(READ_CHUNK)
            except socket.timeout:
                continue
            except (EOFError, OSError, paramiko.SSHException) as exc:
                # EOFError：连接在底层被关掉时 paramiko 会直接抛它（不是 OSError 子类）
                if not self._closed.is_set():
                    logger.info("终端通道读取结束: %s", exc)
                break
            if not data:
                break
            text = self._decoder.decode(data)
            if text:
                on_data(text)
        self._closed.set()
        if on_closed is not None:
            on_closed()

    # -- 写 ----------------------------------------------------------------
    def write(self, text: str) -> None:
        """把按键 / 粘贴内容发给远端（不是线程安全的调用点，用锁串行化）。"""
        channel = self._channel
        if channel is None or self._closed.is_set():
            return
        payload = text.encode(self._encoding, errors="replace")
        if not payload:
            return
        with self._write_lock:
            try:
                channel.sendall(payload)
            except (EOFError, OSError, paramiko.SSHException) as exc:
                logger.info("终端写入失败: %s", exc)
                self._closed.set()

    def resize(self, cols: int, rows: int) -> None:
        """通知远端窗口大小变化（远端据此重排，vim / htop 靠它）。"""
        cols, rows = max(2, int(cols)), max(2, int(rows))
        self.cols, self.rows = cols, rows
        channel = self._channel
        if channel is None or self._closed.is_set():
            return
        with self._write_lock:
            try:
                channel.resize_pty(width=cols, height=rows)
            except (EOFError, OSError, paramiko.SSHException):  # pragma: no cover
                pass

    def close(self) -> None:
        """关闭通道并等读取线程退出（半秒级，不阻塞界面）。"""
        self._closed.set()
        channel = self._channel
        if channel is not None:
            try:
                channel.close()
            except Exception:  # pragma: no cover - 关闭失败无所谓
                pass
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def exit_status(self) -> Optional[int]:
        channel = self._channel
        if channel is None:
            return None
        try:
            if channel.exit_status_ready():
                return channel.recv_exit_status()
        except Exception:  # pragma: no cover - 通道已关闭
            return None
        return None
