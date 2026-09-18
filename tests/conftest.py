"""pytest 全局配置：强制无界面平台，避免测试弹出窗口。"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

from app.cache.file_cache import FileCache  # noqa: E402
from app.config.hosts import HostConfig, HostStore  # noqa: E402
from app.config.settings import SettingsStore  # noqa: E402
from app.ui.theme import DARK, apply_theme  # noqa: E402

#: 「把 QApplication 的样式表恢复成空串」的替身。
#:
#: 实测坑：清空 QApplication 的样式表之后，本机 Qt/PySide 会在**下一次**
#: `apply_theme()` 的 `setStyleSheet()` 上段错误（表现为整个 pytest 进程直接崩，
#: 报 `Fatal Python error: Segmentation fault`）。所以恢复时给一条无副作用的规则，
#: 而不是空串；样式表内容会被下一个用例的 `apply_theme()` 整体覆盖。
NEUTRAL_STYLESHEET = "QWidget { }"


@pytest.fixture
def themed_app(qapp):
    """给 QApplication 套上真实主题 QSS，用完安全恢复。

    之所以要用「应用级」样式表而不是控件级：花屏、原生控件外观这些问题**只在
    QSS 生效时才出现**，控件级样式表复现不出来。
    """
    previous = qapp.styleSheet()
    apply_theme(qapp, DARK)
    yield qapp
    qapp.setStyleSheet(previous or NEUTRAL_STYLESHEET)


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
