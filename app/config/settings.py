"""应用设置（主题 / 编辑器 / SSH 默认参数）。

存储为 JSON，位于平台配置目录；写入使用临时文件 + 原子替换，
避免程序被强杀时损坏配置。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, Optional

from app.utils.errors import ConfigError
from app.utils.paths import config_dir, ensure_dir

logger = logging.getLogger(__name__)

SETTINGS_FILENAME = "settings.json"


@dataclass
class AppSettings:
    """全部可持久化设置。"""

    # 外观
    theme: str = "dark"
    font_family: str = ""
    font_size: int = 12
    # 编辑器
    tab_size: int = 4
    use_spaces: bool = True
    word_wrap: bool = False
    show_line_numbers: bool = True
    auto_save: bool = False
    auto_save_delay_ms: int = 1500
    highlight_current_line: bool = True
    # 文件
    max_file_size_mb: int = 32
    default_encoding: str = "utf-8"
    # SSH
    ssh_timeout_seconds: int = 15
    ssh_keepalive_seconds: int = 30
    ssh_strict_host_key: bool = False
    remote_workspace: str = ""
    # 日志
    log_level: str = "INFO"

    def merged(self, other: "AppSettings") -> "AppSettings":
        """用 ``other`` 中用户显式设置过的字段覆盖自身（供设置对话框使用）。"""
        return AppSettings(**{**asdict(self), **{k: v for k, v in asdict(other).items()}})

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AppSettings":
        known = {f.name: f.type for f in fields(cls)}
        kwargs: dict[str, Any] = {}
        for key, value in (data or {}).items():
            if key in known:
                kwargs[key] = value
        return cls(**kwargs)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def default_settings_path() -> Path:
    return config_dir() / SETTINGS_FILENAME


class SettingsStore:
    """设置的读写入口。"""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path or default_settings_path()
        self._cache: Optional[AppSettings] = None

    def load(self) -> AppSettings:
        if self._cache is not None:
            return self._cache
        settings = AppSettings()
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                settings = AppSettings.from_dict(raw)
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("读取设置失败，使用默认值: %s", exc)
                settings = AppSettings()
        self._cache = settings
        return settings

    def save(self, settings: AppSettings) -> None:
        self._cache = settings
        atomic_write_json(self.path, settings.to_dict())

    def update(self, **changes: Any) -> AppSettings:
        """更新若干字段并落盘。"""
        settings = self.load()
        for key, value in changes.items():
            if hasattr(settings, key):
                setattr(settings, key, value)
        self.save(settings)
        return settings


def atomic_write_json(path: Path, payload: Any) -> None:
    """原子写入 JSON：先写同目录临时文件，再 ``os.replace``。"""
    ensure_dir(path.parent)
    tmp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(path.parent), delete=False, suffix=".tmp"
        ) as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
            tmp_path = Path(handle.name)
        os.replace(tmp_path, path)
    except OSError as exc:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise ConfigError(f"写入配置文件失败：{exc}") from exc


def load_json(path: Path, default: Any = None) -> Any:
    """读取 JSON，失败时返回默认值。"""
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("读取 %s 失败: %s", path, exc)
        return default
