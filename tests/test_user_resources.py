"""用户资源目录测试：打包之后主题 / 字体 / 图标主题仍然可以自己替换。

程序自带资源在 ``--onefile`` 打包后会被解压到临时目录，用户改不了，所以三类资源
都支持放在「配置目录」下新增。这套测试锁住两件事：**放在那里的资源真的能生效**，
以及**设置对话框里能看见并打开这个目录**（用户不用去翻文档猜路径）。
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

from app.config.settings import AppSettings
from app.ui import resources as resources_module
from app.ui import settings_dialog as settings_dialog_module
from app.ui.fonts import load_bundled_fonts, loaded_families, reset_cache
from app.ui.icon_theme import available_icon_themes
from app.ui.resources import (
    RESOURCE_HINT,
    ensure_user_resource_dirs,
    resource_root,
    user_resource_dirs,
)
from app.ui.theme import available_themes, reload_themes

#: 可用来「假装是用户自己下的字体」的系统字体：``(文件, 注册后会出现的字体族名)``
SYSTEM_FONT_CANDIDATES = (
    (Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"), "DejaVu Sans Mono"),
    (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), "DejaVu Sans"),
    (
        Path("/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"),
        "Liberation Mono",
    ),
)

#: 一份最小的 VSCode 配色主题
THEME_JSON = {
    "name": "User Theme",
    "type": "dark",
    "colors": {"editor.background": "#101010", "editor.foreground": "#dddddd"},
}

#: 一份最小的 VSCode 文件图标主题（只要 walk 得通，不关心图标长什么样）
ICON_THEME_JSON = {
    "name": "User Icons",
    "iconDefinitions": {"_file": {"iconPath": "./icons/file.svg"}},
    "file": "_file",
}


@pytest.fixture
def isolated_config(monkeypatch, tmp_path):
    """把配置目录指到 tmp（Linux 走 XDG_CONFIG_HOME），用完重扫主题恢复全局状态。"""
    if sys.platform.startswith("win"):  # pragma: no cover - 开发机是 Linux
        pytest.skip("配置目录由 APPDATA 决定，这里只测 Linux/macOS 分支")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    yield tmp_path
    reload_themes()


def test_user_resource_dirs_live_under_config_dir(isolated_config) -> None:
    assert resource_root() == isolated_config / "remote-code-editor"
    theme_dir, font_dir, icon_dir = user_resource_dirs()
    assert (theme_dir.name, font_dir.name, icon_dir.name) == ("themes", "fonts", "icon-themes")
    assert theme_dir.parent == font_dir.parent == icon_dir.parent == resource_root()


def test_ensure_user_resource_dirs_creates_all_three(isolated_config) -> None:
    created = ensure_user_resource_dirs()
    assert [path.is_dir() for path in created] == [True, True, True]
    # 重复调用应当是幂等的（用户点两次「打开」）
    assert ensure_user_resource_dirs() == created


def test_theme_dropped_into_user_dir_becomes_available(isolated_config) -> None:
    theme_dir, _font_dir, _icon_dir = user_resource_dirs()
    theme_dir.mkdir(parents=True)
    (theme_dir / "user-theme.json").write_text(json.dumps(THEME_JSON), encoding="utf-8")

    reload_themes()  # 设置对话框 / 启动时都会重扫，这里模拟同一步
    names = [theme.name for theme in available_themes()]
    assert "user-theme" in names
    assert names[0] == "dark"  # 内置主题仍在，且同名不会被用户目录覆盖


def test_icon_theme_dropped_into_user_dir_becomes_available(isolated_config) -> None:
    _theme_dir, _font_dir, icon_dir = user_resource_dirs()
    directory = icon_dir / "user-icons"
    (directory / "icons").mkdir(parents=True)
    (directory / "icons" / "file.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>', encoding="utf-8"
    )
    (directory / "material-icons.json").write_text(
        json.dumps(ICON_THEME_JSON), encoding="utf-8"
    )

    names = [theme.name for theme in available_icon_themes()]
    assert "user-icons" in names
    assert "material" in names  # 内置图标主题不受影响


def test_font_dropped_into_user_dir_is_registered(qapp, isolated_config) -> None:
    candidate = next((item for item in SYSTEM_FONT_CANDIDATES if item[0].is_file()), None)
    if candidate is None:  # pragma: no cover - 机器上没有可用的测试字体
        pytest.skip("本机找不到可用的测试字体")
    source, family = candidate

    _theme_dir, font_dir, _icon_dir = user_resource_dirs()
    font_dir.mkdir(parents=True)
    shutil.copy(source, font_dir / source.name)

    reset_cache()
    try:
        load_bundled_fonts()
        assert family in loaded_families()
    finally:
        reset_cache()


def test_settings_dialog_shows_resource_dir_and_opens_it(
    qtbot, isolated_config, monkeypatch
) -> None:
    opened = []
    # 只换掉「调系统文件管理器」这一步，`open_resource_dir` 建目录的逻辑照跑
    monkeypatch.setattr(resources_module, "open_in_file_manager", lambda path: opened.append(path) or True)

    dialog = settings_dialog_module.SettingsDialog(AppSettings(), None)
    qtbot.addWidget(dialog)

    assert str(resource_root()) in dialog.resource_path_label.toolTip()
    assert RESOURCE_HINT in dialog.resource_path_label.toolTip()
    assert dialog.resource_path_label.property("muted") is True

    dialog.resource_dir_button.click()
    assert opened == [resource_root()]
    # 点完之后三个目录必须真的建好了，用户拖文件进去就能用
    assert all(path.is_dir() for path in user_resource_dirs())
