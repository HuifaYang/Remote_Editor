"""跨平台路径工具。

业务代码中禁止硬编码 ``C:\\Users\\xxx`` 或 ``/home/xxx``，
所有配置/缓存/日志目录统一从这里获取。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

APP_NAME = "RemoteCodeEditor"
APP_SLUG = "remote-code-editor"
APP_VERSION = "1.0.0"

_IS_WINDOWS = sys.platform.startswith("win")
_IS_MACOS = sys.platform == "darwin"


def _env_path(*names: str, default: str) -> Path:
    for name in names:
        value = os.environ.get(name)
        if value:
            return Path(value).expanduser()
    return Path(default).expanduser()


def home_dir() -> Path:
    """用户主目录（跨平台）。"""
    return Path.home()


def config_dir() -> Path:
    """配置文件目录。"""
    if _IS_WINDOWS:
        return _env_path("APPDATA", default=str(home_dir() / "AppData" / "Roaming")) / APP_NAME
    if _IS_MACOS:
        return home_dir() / "Library" / "Application Support" / APP_NAME
    return _env_path("XDG_CONFIG_HOME", default=str(home_dir() / ".config")) / APP_SLUG


def data_dir() -> Path:
    """本地数据目录（缓存、临时文件）。"""
    if _IS_WINDOWS:
        return _env_path("LOCALAPPDATA", default=str(home_dir() / "AppData" / "Local")) / APP_NAME
    if _IS_MACOS:
        return home_dir() / "Library" / "Caches" / APP_NAME
    return _env_path("XDG_CACHE_HOME", default=str(home_dir() / ".cache")) / APP_SLUG


def log_dir() -> Path:
    """日志目录。"""
    return data_dir() / "logs"


def cache_dir() -> Path:
    """文件缓存目录。"""
    return data_dir() / "cache"


def temp_dir() -> Path:
    """程序私有临时目录。"""
    return Path(tempfile.gettempdir()) / APP_SLUG


def ensure_dir(path: Path) -> Path:
    """确保目录存在并返回。"""
    path.mkdir(parents=True, exist_ok=True)
    return path


def ssh_key_dir() -> Path:
    """默认 SSH 私钥目录（仅用于在文件对话框中给出合理起始位置）。"""
    return home_dir() / ".ssh"


def resource_path(*parts: str) -> Path:
    """只读资源（图标等）路径，兼容源码运行与 PyInstaller 打包运行。

    PyInstaller ``--onefile`` 会把 ``--add-data`` 内容解压到 ``sys._MEIPASS``，
    这里统一处理，业务代码无需关心运行方式。
    """
    base = getattr(sys, "_MEIPASS", None)
    root = Path(base) if base else Path(__file__).resolve().parents[2]
    return root.joinpath(*parts)
