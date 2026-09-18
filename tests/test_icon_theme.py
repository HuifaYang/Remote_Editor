"""文件图标主题测试（VSCode 文件图标主题规范 + 文件树接入）。

图标主题是用户自己下载放进来的资源（Material Icon Theme 等），
所以这里用的是一份自造的迷你主题，同时验证「没有主题 / 主题坏了」的回退路径。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from PySide6.QtGui import QColor

from app.config.settings import AppSettings
from app.remote.sftp_client import RemoteEntry
from app.ui import icon_theme as icon_theme_module
from app.ui.icon_theme import (
    available_icon_themes,
    get_icon_theme,
    load_icon_theme,
    render_icon_pixmap,
)
from app.ui.theme import DARK
from app.ui.widgets.file_tree import RemoteFileTree

ROOT = "/home/user/project"

#: 自造的迷你图标：纯色方块，方便按像素断言「用的是哪个图标」
PY_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
    '<rect width="16" height="16" fill="#3572a5"/></svg>'
)
FILE_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
    '<rect width="16" height="16" fill="#888888"/></svg>'
)
FOLDER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
    '<rect width="16" height="16" fill="#dcb67a"/></svg>'
)

THEME_JSON = {
    "name": "Fixture Icons",
    "iconDefinitions": {
        "_file": {"iconPath": "./icons/file.svg"},
        "_py": {"iconPath": "./icons/py.svg"},
        "_folder": {"iconPath": "./icons/folder.svg"},
    },
    "file": "_file",
    "folder": "_folder",
    "fileNames": {"makefile": "_py"},
    "fileExtensions": {"py": "_py", "tar.gz": "_py"},
    "folderNames": {"src": "_folder"},
}


def write_theme(directory: Path, payload: dict = THEME_JSON) -> Path:
    icons = directory / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    (icons / "py.svg").write_text(PY_SVG, encoding="utf-8")
    (icons / "file.svg").write_text(FILE_SVG, encoding="utf-8")
    (icons / "folder.svg").write_text(FOLDER_SVG, encoding="utf-8")
    theme_file = directory / "material-icons.json"
    theme_file.write_text(json.dumps(payload), encoding="utf-8")
    return theme_file


@pytest.fixture
def icon_theme(tmp_path):
    directory = tmp_path / "fixture-icons"
    directory.mkdir()
    write_theme(directory)
    theme = load_icon_theme(directory)
    assert theme is not None
    return theme


@pytest.fixture
def icon_theme_search_dir(tmp_path, monkeypatch):
    """把图标主题搜索目录指向临时目录。"""
    parent = tmp_path / "icon-themes"
    directory = parent / "fixture-icons"
    directory.mkdir(parents=True)
    write_theme(directory)
    monkeypatch.setattr(icon_theme_module, "icon_theme_dirs", lambda: (parent,))
    return parent


# ---------------------------------------------------------------------------
# 图标解析
# ---------------------------------------------------------------------------


def test_resolves_icon_by_name_extension_and_default(icon_theme) -> None:
    assert icon_theme.icon_id_for("Makefile", is_dir=False) == "_py"  # 精确文件名优先
    assert icon_theme.icon_id_for("main.py", is_dir=False) == "_py"
    assert icon_theme.icon_id_for("a.tar.gz", is_dir=False) == "_py"  # 多段扩展名取最长的
    assert icon_theme.icon_id_for("b.tar.gz.bak", is_dir=False) == "_file"
    assert icon_theme.icon_id_for("unknown.xyz", is_dir=False) == "_file"
    assert icon_theme.icon_id_for("src", is_dir=True) == "_folder"
    assert icon_theme.icon_id_for("docs", is_dir=True) == "_folder"  # 没定义的目录用默认文件夹


def test_matching_is_case_insensitive(icon_theme) -> None:
    assert icon_theme.icon_id_for("MAIN.PY", is_dir=False) == "_py"
    assert icon_theme.icon_id_for("SRC", is_dir=True) == "_folder"


def test_renders_icon_with_a_2x_pixmap(icon_theme, qapp) -> None:
    icon = icon_theme.icon_for("main.py", is_dir=False)

    assert icon is not None
    sizes = sorted((size.width(), size.height()) for size in icon.availableSizes())
    assert (16, 16) in sizes
    assert (32, 32) in sizes


def test_icons_are_cached(icon_theme, qapp) -> None:
    first = icon_theme.icon_for("main.py", is_dir=False)
    second = icon_theme.icon_for("main.py", is_dir=False)

    assert first is second


def test_folder_expanded_icon_when_theme_defines_it(tmp_path) -> None:
    directory = tmp_path / "expanded"
    directory.mkdir()
    payload = dict(THEME_JSON)
    payload["iconDefinitions"] = dict(THEME_JSON["iconDefinitions"])
    payload["iconDefinitions"]["_folder_open"] = {"iconPath": "./icons/file.svg"}
    payload["folderExpanded"] = "_folder_open"
    write_theme(directory, payload)

    theme = load_icon_theme(directory)

    assert theme is not None
    assert theme.icon_id_for("docs", is_dir=True, expanded=True) == "_folder_open"
    assert theme.icon_id_for("docs", is_dir=True, expanded=False) == "_folder"


# ---------------------------------------------------------------------------
# 加载与回退
# ---------------------------------------------------------------------------


def test_finds_theme_json_with_a_nonstandard_name(tmp_path) -> None:
    directory = tmp_path / "odd-name"
    directory.mkdir()
    write_theme(directory)
    (directory / "material-icons.json").rename(directory / "whatever.json")

    assert load_icon_theme(directory) is not None


def test_finds_theme_json_in_a_subdirectory(tmp_path) -> None:
    """上游常把 JSON 放在 dist/ 里打包（Material Icon Theme 就是这样）。"""
    directory = tmp_path / "material"
    (directory / "dist").mkdir(parents=True)
    (directory / "dist" / "material-icons.json").write_text(
        json.dumps({"iconDefinitions": {"_f": {"iconPath": "./../icons/f.svg"}}, "file": "_f"}),
        encoding="utf-8",
    )
    (directory / "icons").mkdir()
    (directory / "icons" / "f.svg").write_text(FILE_SVG, encoding="utf-8")
    (directory / "package.json").write_text(
        json.dumps({"displayName": "Material Icon Theme"}), encoding="utf-8"
    )

    theme = load_icon_theme(directory)

    assert theme is not None
    assert theme.display_name == "Material Icon Theme"  # 显示名取自上游 package.json
    assert theme.icon_for("main.c", is_dir=False) is not None


def test_load_failures_return_none(tmp_path) -> None:
    assert load_icon_theme(tmp_path / "missing") is None
    assert load_icon_theme(tmp_path) is None  # 目录里没有主题 JSON

    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "icon-theme.json").write_text("{ not json", encoding="utf-8")
    assert load_icon_theme(broken) is None

    empty = tmp_path / "empty"
    empty.mkdir()
    write_theme(empty, {"name": "没有 iconDefinitions"})
    assert load_icon_theme(empty) is None


def test_relocates_icon_path_when_layout_differs(tmp_path, qapp) -> None:
    """主题把 JSON 与 icons 分在不同层级时（Material Icon Theme 的 dist/ 布局）也能找到。"""
    root = tmp_path / "material"
    (root / "icons").mkdir(parents=True)
    (root / "icons" / "py.svg").write_text(PY_SVG, encoding="utf-8")
    dist = root / "dist"
    dist.mkdir()
    (dist / "material-icons.json").write_text(
        json.dumps(
            {
                "iconDefinitions": {"_py": {"iconPath": "../icons/py.svg"}},
                "file": "_py",
            }
        ),
        encoding="utf-8",
    )

    theme = load_icon_theme(dist)

    assert theme is not None
    assert theme.icon_for("main.py", is_dir=False) is not None


def test_no_icon_theme_returns_none(icon_theme_search_dir) -> None:
    """没装任何主题时 get_icon_theme 返回 None，由界面回退到系统图标。"""
    assert get_icon_theme("") is None
    assert get_icon_theme("not-installed") is None
    assert [theme.name for theme in available_icon_themes()] == ["fixture-icons"]
    assert get_icon_theme("fixture-icons") is not None


def test_render_icon_pixmap_rejects_broken_svg(tmp_path, qapp) -> None:
    broken = tmp_path / "broken.svg"
    broken.write_text("<svg", encoding="utf-8")

    assert render_icon_pixmap(broken) is None


# ---------------------------------------------------------------------------
# 界面接入
# ---------------------------------------------------------------------------


def test_settings_default_to_material_icon_theme() -> None:
    assert AppSettings().icon_theme == "material"


def test_settings_dialog_lists_available_icon_themes(qtbot, icon_theme_search_dir) -> None:
    from app.ui.settings_dialog import SettingsDialog

    dialog = SettingsDialog(AppSettings(), None)
    qtbot.addWidget(dialog)
    labels = [
        dialog.icon_theme_combo.itemText(index)
        for index in range(dialog.icon_theme_combo.count())
    ]

    assert labels[0] == "跟随系统"
    assert "Fixture Icons" in labels

    dialog.icon_theme_combo.setCurrentIndex(labels.index("Fixture Icons"))
    assert dialog.result_settings().icon_theme == "fixture-icons"


def test_file_tree_uses_icon_theme_and_falls_back(qtbot, icon_theme) -> None:
    tree = RemoteFileTree(theme=DARK)
    qtbot.addWidget(tree)
    tree.resize(420, 300)
    tree.show()
    tree.set_root(ROOT)
    tree.set_children(
        ROOT,
        [
            RemoteEntry(name="main.py", path=f"{ROOT}/main.py", is_dir=False, size=1, mtime=0),
            RemoteEntry(name="src", path=f"{ROOT}/src", is_dir=True, size=0, mtime=0),
        ],
    )

    tree.set_icon_theme(icon_theme)

    # 目录在前排序，所以按名字取节点，不靠插入顺序
    root_item = tree.topLevelItem(0)
    items = {
        root_item.child(index).text(0): root_item.child(index)
        for index in range(root_item.childCount())
    }
    py_item, src_item = items["main.py"], items["src"]
    py_pixel = py_item.icon(0).pixmap(16, 16).toImage().pixelColor(8, 8)
    src_pixel = src_item.icon(0).pixmap(16, 16).toImage().pixelColor(8, 8)
    assert py_pixel == QColor("#3572a5")  # 主题里的 Python 图标
    assert src_pixel == QColor("#dcb67a")  # 主题里的文件夹图标

    tree.set_icon_theme(None)

    fallback_pixel = py_item.icon(0).pixmap(16, 16).toImage().pixelColor(8, 8)
    assert fallback_pixel != QColor("#3572a5")  # 已回退到系统图标
