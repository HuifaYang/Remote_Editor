"""交互式 shell 通道测试：PTY 申请、增量解码、写回、窗口大小通知。

用假的 ``Transport`` / ``Channel``（不需要真网络），因此沙箱里也能跑 ——
真链路端到端那几条在 ``test_ssh_end_to_end.py`` 里另有覆盖（需要真实端口，通常跳过）。
"""

from __future__ import annotations

import socket
import threading
import time
from typing import List, Optional

import pytest

from app.remote.shell_channel import ShellChannel
from app.utils.errors import SSHConnectionError


class FakeChannel:
    """最小可用的 paramiko Channel 替身。"""

    def __init__(self) -> None:
        self.pty: Optional[tuple] = None
        self.shell = False
        self.sent: List[bytes] = []
        self.resize_calls: List[tuple] = []
        self.closed = False
        self.timeout: Optional[float] = None
        self._chunks: List[bytes] = []
        self._lock = threading.Lock()

    # -- 测试驱动 ----------------------------------------------------------
    def feed(self, data: bytes, *, eof: bool = False) -> None:
        with self._lock:
            if data:
                self._chunks.append(data)
            if eof:
                self._chunks.append(b"")
        # 唤醒正在 recv 的读取线程
        time.sleep(0.01)

    # -- paramiko 接口 -----------------------------------------------------
    def get_pty(self, term: str = "", width: int = 80, height: int = 24) -> None:
        self.pty = (term, width, height)

    def invoke_shell(self) -> None:
        self.shell = True

    def settimeout(self, value: float) -> None:
        self.timeout = value

    def recv(self, size: int) -> bytes:
        with self._lock:
            if self._chunks:
                return self._chunks.pop(0)
        raise socket.timeout()

    def sendall(self, payload: bytes) -> None:
        self.sent.append(payload)

    def resize_pty(self, width: int = 80, height: int = 24) -> None:
        self.resize_calls.append((width, height))

    def close(self) -> None:
        self.closed = True

    def exit_status_ready(self) -> bool:
        return True

    def recv_exit_status(self) -> int:
        return 0


class FakeTransport:
    def __init__(self, channel: FakeChannel, *, active: bool = True) -> None:
        self._channel = channel
        self._active = active
        self.timeout: Optional[float] = None

    def is_active(self) -> bool:
        return self._active

    def open_session(self, timeout: Optional[float] = None) -> FakeChannel:
        self.timeout = timeout
        return self._channel


class FakeSSH:
    """只实现 ShellChannel 用到的接口。"""

    class _Options:
        timeout = 5.0

    def __init__(self, channel: FakeChannel, *, active: bool = True) -> None:
        self._transport = FakeTransport(channel, active=active)
        self.options = self._Options()
        self.lock = threading.RLock()

    @property
    def transport(self) -> FakeTransport:
        return self._transport


def make_channel(**kwargs) -> tuple:
    channel = FakeChannel()
    ssh = FakeSSH(channel, active=kwargs.pop("active", True))
    return ShellChannel(ssh, **kwargs), channel


# ---------------------------------------------------------------------------
# 打开
# ---------------------------------------------------------------------------


def test_open_requests_a_pty_and_a_shell() -> None:
    shell, channel = make_channel(cols=100, rows=30)

    shell.open()

    assert channel.pty == ("xterm-256color", 100, 30)
    assert channel.shell
    assert channel.timeout is not None and channel.timeout > 0


def test_open_without_an_active_transport_raises() -> None:
    shell, _channel = make_channel(active=False)

    with pytest.raises(SSHConnectionError):
        shell.open()


def test_open_is_idempotent() -> None:
    shell, channel = make_channel()
    shell.open()
    shell.open()

    assert channel.pty is not None


# ---------------------------------------------------------------------------
# 写入 / 大小
# ---------------------------------------------------------------------------


def test_write_encodes_utf8_and_resize_notifies_the_remote() -> None:
    shell, channel = make_channel()
    shell.open()

    shell.write("ls -la\r")
    shell.write("中文\n")
    shell.resize(120, 40)

    assert channel.sent == ["ls -la\r".encode(), "中文\n".encode()]
    assert channel.resize_calls == [(120, 40)]
    assert (shell.cols, shell.rows) == (120, 40)


def test_write_after_close_is_ignored() -> None:
    shell, channel = make_channel()
    shell.open()
    shell.close()

    shell.write("ignored")
    shell.resize(90, 20)

    assert channel.sent == []
    assert shell.closed


# ---------------------------------------------------------------------------
# 读取线程
# ---------------------------------------------------------------------------


def test_reader_delivers_decoded_text_and_reports_close() -> None:
    shell, channel = make_channel()
    shell.open()
    received: List[str] = []
    closed = threading.Event()

    shell.start_reader(received.append, closed.set)
    channel.feed("hello ".encode())
    channel.feed("world\n".encode())
    channel.feed(b"", eof=True)

    assert closed.wait(2.0)
    assert "".join(received) == "hello world\n"


def test_reader_decodes_multibyte_characters_split_across_reads() -> None:
    """UTF-8 字符被 TCP 分片切开时不能出现乱码（增量解码器负责拼接）。"""
    shell, channel = make_channel()
    shell.open()
    received: List[str] = []
    closed = threading.Event()

    shell.start_reader(received.append, closed.set)
    payload = "中文".encode()
    channel.feed(payload[:2])  # 第一个字只来了一半
    channel.feed(payload[2:])
    channel.feed(b"", eof=True)

    assert closed.wait(2.0)
    assert "".join(received) == "中文"


def test_reader_stops_after_close() -> None:
    shell, channel = make_channel()
    shell.open()
    closed = threading.Event()
    shell.start_reader(lambda _text: None, closed.set)
    channel.feed("x".encode())

    shell.close()

    assert closed.wait(2.0)


def test_closed_flag_starts_false() -> None:
    shell, _channel = make_channel()
    shell.open()

    assert not shell.closed
    shell.close()
    assert shell.closed
