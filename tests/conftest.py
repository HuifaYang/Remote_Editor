"""pytest 全局配置：强制无界面平台，避免测试弹出窗口。"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

from app.cache.file_cache import FileCache  # noqa: E402
from app.config.hosts import HostConfig, HostStore  # noqa: E402
from app.config.settings import SettingsStore  # noqa: E402


@pytest.fixture
def settings_store(tmp_path):
    return SettingsStore(tmp_path / "settings.json")


@pytest.fixture
def host_store(tmp_path):
    return HostStore(tmp_path / "hosts.json")


@pytest.fixture
def file_cache(tmp_path):
    return FileCache(tmp_path / "cache")


@pytest.fixture
def host():
    return HostConfig(
        name="Robot-3566",
        host="192.168.1.100",
        port=22,
        username="root",
        remote_workspace="/home/user/project",
    )
