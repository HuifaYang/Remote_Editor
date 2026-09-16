"""日志系统。

要求：
* 记录 SSH 连接、SFTP 传输、Git 命令、异常；
* **禁止**记录密码、私钥明文、passphrase。

实现方式：所有日志记录经过 :class:`SecretRedactor` 过滤器，
它会同时按“已注册的敏感值”和“password=xxx 模式”两种方式脱敏。
"""

from __future__ import annotations

import logging
import re
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Iterable, Optional

from app.utils.paths import APP_VERSION, ensure_dir, log_dir

REDACTED = "***"
LOG_FILENAME = "remote-code-editor.log"

_KEYWORD_PATTERN = re.compile(
    r"(?i)\b(pass ?word|passphrase|pwd|secret|token|private[_ -]?key)\b(\s*[:=]\s*)(\S+)"
)


class SecretRedactor(logging.Filter):
    """把日志中的敏感信息替换为 ``***``。"""

    def __init__(self, secrets: Optional[Iterable[str]] = None) -> None:
        super().__init__(name="secret-redactor")
        self._secrets: set[str] = set()
        self._lock = threading.Lock()
        for secret in secrets or ():
            self.add_secret(secret)

    def add_secret(self, secret: Optional[str]) -> None:
        if not secret or len(secret) < 3:
            return
        with self._lock:
            self._secrets.add(secret)

    def forget_secret(self, secret: Optional[str]) -> None:
        if not secret:
            return
        with self._lock:
            self._secrets.discard(secret)

    def redact(self, text: str) -> str:
        if not text:
            return text
        with self._lock:
            secrets = tuple(self._secrets)
        for secret in secrets:
            if secret in text:
                text = text.replace(secret, REDACTED)
        return _KEYWORD_PATTERN.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = self.redact(record.getMessage())
            record.args = ()
        except Exception:  # pragma: no cover - 日志本身不能抛异常
            return True
        return True


_redactor = SecretRedactor()
_configured = False


def get_redactor() -> SecretRedactor:
    return _redactor


def register_secret(secret: Optional[str]) -> None:
    """把密码 / passphrase 登记为敏感值，日志中出现即脱敏。"""
    _redactor.add_secret(secret)


def forget_secret(secret: Optional[str]) -> None:
    _redactor.forget_secret(secret)


def configure_logging(
    directory: Optional[Path] = None,
    *,
    level: int = logging.INFO,
    console: bool = True,
    max_bytes: int = 2 * 1024 * 1024,
    backup_count: int = 3,
) -> Path:
    """初始化根 logger，返回日志文件路径。"""
    global _configured

    target_dir = ensure_dir(directory or log_dir())
    log_path = target_dir / LOG_FILENAME

    root = logging.getLogger()
    if _configured:
        return log_path

    root.setLevel(level)
    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    try:
        file_handler: logging.Handler = RotatingFileHandler(
            log_path, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"
        )
    except OSError:  # pragma: no cover - 磁盘只读等极端情况
        file_handler = logging.NullHandler()
    file_handler.setFormatter(formatter)
    file_handler.addFilter(_redactor)
    root.addHandler(file_handler)

    if console:
        stream_handler = logging.StreamHandler()
        stream_handler.setFormatter(formatter)
        stream_handler.addFilter(_redactor)
        root.addHandler(stream_handler)

    logging.getLogger("paramiko").setLevel(logging.WARNING)
    root.info("RemoteCodeEditor %s 启动，日志目录: %s", APP_VERSION, target_dir)
    _configured = True
    return log_path


def install_exception_hook(logger_name: str = "app") -> None:
    """把未捕获异常写入日志，而不是只打印到 stderr。"""
    import sys

    logger = logging.getLogger(logger_name)

    def _hook(exc_type, exc_value, exc_tb):  # type: ignore[no-untyped-def]
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_tb)
            return
        logger.critical("未捕获异常", exc_info=(exc_type, exc_value, exc_tb))

    sys.excepthook = _hook
