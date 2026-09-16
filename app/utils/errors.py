"""统一的异常类型与友好错误提示。

网络层只抛出本节定义的异常，UI 层通过 :func:`describe_error`
生成用户可读的提示文案，避免把 socket / paramiko 原始报错直接抛给用户。
"""

from __future__ import annotations

import errno
import socket
from typing import Optional


class AppError(Exception):
    """所有本项目自定义异常的基类。"""

    default_message = "发生未知错误"

    def __init__(self, message: str = "", *, detail: str = "") -> None:
        super().__init__(message or self.default_message)
        self.message = message or self.default_message
        self.detail = detail

    def __str__(self) -> str:  # pragma: no cover - 简单委托
        if self.detail:
            return f"{self.message} ({self.detail})"
        return self.message


class SSHError(AppError):
    """SSH 相关错误基类。"""

    default_message = "SSH 操作失败"


class SSHConnectionError(SSHError):
    """无法建立或维持连接。"""

    default_message = "无法连接到远程主机"


class SSHTimeoutError(SSHConnectionError):
    default_message = "连接超时"


class SSHAuthenticationError(SSHError):
    default_message = "认证失败，请检查用户名、密码或私钥"


class SSHHostKeyError(SSHError):
    default_message = "主机密钥校验失败"


class SSHSessionClosedError(SSHError):
    default_message = "SSH 连接已断开"


class SFTError(AppError):
    default_message = "SFTP 文件操作失败"


class RemoteFileNotFoundError(SFTError):
    default_message = "远程文件不存在"


class RemotePermissionError(SFTError):
    default_message = "远程权限不足"


class GitError(AppError):
    default_message = "Git 操作失败"


class NotAGitRepositoryError(GitError):
    default_message = "Git: Not a repository"


class EncodingError_(AppError):
    default_message = "无法识别文件编码"


class ConfigError(AppError):
    default_message = "配置文件读写失败"


def describe_error(exc: BaseException) -> str:
    """把任意异常转换为面向用户的中文提示。"""
    if isinstance(exc, AppError):
        return exc.message

    if isinstance(exc, socket.timeout):
        return "连接超时：远程主机无响应"
    if isinstance(exc, socket.gaierror):
        return "无法解析主机地址，请检查 IP / 域名是否正确"
    if isinstance(exc, ConnectionRefusedError):
        return "连接被拒绝：请确认远端 sshd 已启动且端口正确"
    if isinstance(exc, OSError):
        if exc.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH):
            return "网络不可达，请检查本地网络与板卡连接"
        if exc.errno in (errno.ETIMEDOUT, errno.EHOSTDOWN):
            return "连接超时：远程主机无响应"
        if exc.errno == errno.EACCES:
            return "本地权限不足"
    # paramiko 异常延迟导入，避免无网络依赖场景下的导入成本
    try:  # pragma: no cover - 依赖 paramiko 内部类型
        import paramiko

        if isinstance(exc, paramiko.AuthenticationException):
            return "认证失败，请检查用户名、密码或私钥是否正确"
        if isinstance(exc, paramiko.BadHostKeyException):
            return "主机密钥校验失败，可能遭遇中间人攻击"
        if isinstance(exc, paramiko.SSHException):
            return f"SSH 协议错误：{exc}"
    except Exception:  # pragma: no cover
        pass
    return f"{type(exc).__name__}: {exc}"


def find_message(exc: BaseException) -> Optional[str]:
    """取出异常中的原始文本（用于日志）。"""
    if isinstance(exc, AppError):
        return exc.detail or str(exc)
    return str(exc)
