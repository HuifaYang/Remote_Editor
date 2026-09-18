"""外部主题（VSCode 主题 JSON）加载测试。

主题文件是**用户可自己下载放入**的资源（GitHub Dark 等开源主题），
所以这里既验证字段映射，也验证「坏文件不能让程序起不来」。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.ui import theme as theme_module
from app.ui.theme import (
    DARK,
    LIGHT,
    available_themes,
    get_theme,
    load_external_themes,
    load_theme_file,
    reload_themes,
    theme_from_vscode,
)

GITHUB_DARK = {
    "name": "GitHub Dark Default",
    "colors": {
        "editor.background": "#0d1117",
        "editor.foreground": "#c9d1d9",
        "sideBar.background": "#010409",
        "focusBorder": "#1f6feb",
        "statusBar.background": "#0d1117",
        "statusBar.foreground": "#ffffff",
        "editor.selectionBackground": "#3392ff44",
        "gitDecoration.modifiedResourceForeground": "#d29922",
        "gitDecoration.addedResourceForeground": "#3fb950",
        "gitDecoration.deletedResourceForeground": "#f85149",
    },
    "tokenColors": [
        {"scope": "comment", "settings": {"foreground": "#8b949e"}},
        {"scope": ["string"], "settings": {"foreground": "#a5d6ff"}},
        {"scope": "keyword.control", "settings": {"foreground": "#ff7b72"}},
    ],
}


@pytest.fixture
def external_theme_dir(tmp_path, monkeypatch):
    """把主题目录指向临时目录，用例结束后恢复全局主题表。"""
    folder = tmp_path / "themes"
    folder.mkdir()
    monkeypatch.setattr(theme_module, "external_theme_dirs", lambda: (folder,))
    yield folder
    monkeypatch.undo()
    reload_themes()


def write_theme(folder: Path, filename: str, payload: dict) -> Path:
    path = folder / filename
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 字段映射
# ---------------------------------------------------------------------------


def test_maps_vscode_colors_to_theme_fields() -> None:
    theme = theme_from_vscode(GITHUB_DARK, name="github-dark", display_name="GitHub Dark")

    assert theme.name == "github-dark"
    assert theme.display_name == "GitHub Dark"
    assert theme.dark is True
    assert theme.editor_bg == "#0d1117"
    assert theme.editor_fg == "#c9d1d9"
    assert theme.panel_bg == "#010409"
    assert theme.accent == "#1f6feb"
    assert theme.status_bar_bg == "#0d1117"
    assert theme.marker_modified == "#d29922"
    assert theme.marker_added == "#3fb950"
    assert theme.marker_deleted == "#f85149"


def test_maps_token_colors_to_syntax_fields() -> None:
    theme = theme_from_vscode(GITHUB_DARK, name="github-dark")

    assert theme.syntax_comment == "#8b949e"
    assert theme.syntax_keyword == "#ff7b72"
    assert theme.syntax_string == "#a5d6ff"
    # 主题里没定义的语法类别沿用深色内置值，不会出现空字段
    assert theme.syntax_meta == DARK.syntax_meta


def test_composites_alpha_colors_over_background() -> None:
    """VSCode 用 ``#rrggbbaa``，Qt 用 ``#aarrggbb``；不换算会串色。"""
    theme = theme_from_vscode(
        {"colors": {"editor.background": "#000000", "editor.selectionBackground": "#ffffff80"}},
        name="alpha",
        base=DARK,
    )

    # 白色 50% 叠在纯黑背景上 → 中灰，而不是被当成 alpha=0xff 的红色
    assert theme.selection == "#808080"


def test_uses_light_base_for_light_themes() -> None:
    theme = theme_from_vscode(
        {"colors": {"editor.background": "#ffffff", "editor.foreground": "#24292f"}},
        name="lightish",
    )

    assert theme.dark is False
    # VSCode 主题没有「窗口底色」这个概念，按编辑器底色走
    assert theme.window_bg == "#ffffff"
    assert theme.marker_added == LIGHT.marker_added


def test_explicit_base_wins_over_auto_detection() -> None:
    theme = theme_from_vscode({"colors": {}}, name="empty", base=LIGHT)
    assert theme.dark is False
    assert theme.editor_bg == LIGHT.editor_bg


# ---------------------------------------------------------------------------
# 文件加载
# ---------------------------------------------------------------------------


def test_loads_theme_file(external_theme_dir) -> None:
    path = write_theme(external_theme_dir, "github-dark.json", GITHUB_DARK)

    theme = load_theme_file(path)

    assert theme is not None
    assert theme.name == "github-dark"  # 名称取文件名，稳定且可写进配置
    assert theme.display_name == "GitHub Dark Default"


def test_rejects_files_that_are_not_themes(tmp_path) -> None:
    broken = tmp_path / "broken.json"
    broken.write_text("{ not json", encoding="utf-8")
    assert load_theme_file(broken) is None

    other = write_theme(tmp_path, "other.json", {"version": "2.0.0"})
    assert load_theme_file(other) is None


def test_scans_external_theme_directory(external_theme_dir) -> None:
    write_theme(external_theme_dir, "github-dark.json", GITHUB_DARK)
    write_theme(external_theme_dir, "not-a-theme.json", {"hello": "world"})

    names = [theme.name for theme in load_external_themes()]

    assert names == ["github-dark"]


def test_reload_themes_exposes_external_theme_to_settings(external_theme_dir) -> None:
    write_theme(external_theme_dir, "github-dark.json", GITHUB_DARK)

    reload_themes()

    names = [theme.name for theme in available_themes()]
    assert names[:2] == ["dark", "light"]
    assert "github-dark" in names
    assert get_theme("github-dark").editor_bg == "#0d1117"
    # 未知主题依旧回退到深色
    assert get_theme("does-not-exist") is DARK


def test_builtin_theme_names_are_not_shadowed_by_files(external_theme_dir) -> None:
    """放一个同名主题文件不能把内置深色覆盖掉。"""
    write_theme(external_theme_dir, "dark.json", GITHUB_DARK)

    reload_themes()

    assert get_theme("dark") is DARK
