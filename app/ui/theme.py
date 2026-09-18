"""集中式主题配置。

需求（文档 5.7.1）要求「颜色配置集中管理，禁止硬编码」，
因此所有 UI 与 Gutter 颜色都只在这里定义。
"""

from __future__ import annotations

import json
import logging
import re
import sys
from dataclasses import dataclass, fields as dataclass_fields
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PySide6.QtGui import QColor, QFont, QFontDatabase, QPalette
from PySide6.QtWidgets import QApplication, QWidget

from app.ui.fonts import preferred_monospace_family, preferred_ui_family
from app.utils.paths import config_dir, ensure_dir, resource_path, temp_dir

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Theme:
    """一套完整配色。"""

    name: str
    display_name: str
    dark: bool
    window_bg: str
    panel_bg: str
    editor_bg: str
    editor_fg: str
    gutter_bg: str
    gutter_fg: str
    current_line: str
    selection: str
    border: str
    accent: str
    status_fg: str
    # 界面外框（VSCode 风格：扁平、无边框、配色克制）
    menu_bg: str
    toolbar_bg: str
    tab_active_bg: str
    tab_inactive_bg: str
    list_hover: str
    list_selection: str
    list_inactive_selection: str
    status_bar_bg: str
    status_bar_fg: str
    # Git Gutter
    marker_added: str
    marker_modified: str
    marker_deleted: str
    # 语法高亮
    syntax_keyword: str
    syntax_string: str
    syntax_comment: str
    syntax_number: str
    syntax_function: str
    syntax_class: str
    syntax_builtin: str
    syntax_operator: str
    syntax_error: str
    syntax_meta: str
    # 终端（自绘网格）：底色 / 前景 / 光标 / 选区 + 16 色 ANSI 调色板
    terminal_bg: str
    terminal_fg: str
    terminal_cursor: str
    terminal_selection: str
    terminal_ansi: Tuple[str, ...]

    def color(self, attribute: str) -> QColor:
        value = getattr(self, attribute)
        return QColor(value)

    def ansi_color(self, index: int) -> str:
        """取第 ``index`` 号 ANSI 颜色（0-15），越界回退到前景色。"""
        if 0 <= index < len(self.terminal_ansi):
            return self.terminal_ansi[index]
        return self.terminal_fg

    def syntax_colors(self) -> Dict[str, QColor]:
        """返回语法高亮配色：{类别: 颜色}。"""
        return {
            field.name[len("syntax_") :]: QColor(getattr(self, field.name))
            for field in dataclass_fields(self)
            if field.name.startswith("syntax_")
        }


LIGHT = Theme(
    name="light",
    display_name="浅色",
    dark=False,
    # 对齐 VSCode「Light Modern」：白色编辑区 + 浅灰侧边栏，蓝色只用在强调处
    window_bg="#ffffff",
    panel_bg="#f8f8f8",
    editor_bg="#ffffff",
    editor_fg="#3b3b3b",
    gutter_bg="#ffffff",
    gutter_fg="#6e7681",
    current_line="#f5f5f5",
    selection="#add6ff",
    border="#e5e5e5",
    accent="#005fb8",
    status_fg="#3b3b3b",
    menu_bg="#ffffff",
    toolbar_bg="#f8f8f8",
    tab_active_bg="#ffffff",
    tab_inactive_bg="#f8f8f8",
    list_hover="#f2f2f2",
    list_selection="#e8e8e8",
    list_inactive_selection="#f2f2f2",
    status_bar_bg="#f8f8f8",
    status_bar_fg="#3b3b3b",
    marker_added="#1a7f37",
    marker_modified="#9a6700",
    marker_deleted="#cf222e",
    syntax_keyword="#a00095",
    syntax_string="#0a7d32",
    syntax_comment="#6a737d",
    syntax_number="#0b5fd0",
    syntax_function="#795e26",
    syntax_class="#267f99",
    syntax_builtin="#0550ae",
    syntax_operator="#3b3b3b",
    syntax_error="#cf222e",
    syntax_meta="#7d4e00",
    # 终端：VSCode Light Modern 的终端配色
    terminal_bg="#ffffff",
    terminal_fg="#3b3b3b",
    terminal_cursor="#000000",
    terminal_selection="#add6ff",
    terminal_ansi=(
        "#000000", "#cd3131", "#00bc00", "#949800",
        "#0451a5", "#bc05bc", "#0598bc", "#555555",
        "#666666", "#cd3131", "#14ce14", "#b5ba00",
        "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5",
    ),
)

DARK = Theme(
    name="dark",
    display_name="深色",
    dark=True,
    # 对齐 VSCode「Dark Modern」：中性灰外壳（不再用 #3c3c3c 菜单条 + 亮蓝状态栏）
    window_bg="#1f1f1f",
    panel_bg="#181818",
    editor_bg="#1f1f1f",
    editor_fg="#cccccc",
    gutter_bg="#1f1f1f",
    gutter_fg="#6e7681",
    current_line="#282828",
    selection="#264f78",
    border="#2b2b2b",
    accent="#0078d4",
    status_fg="#9d9d9d",
    menu_bg="#1f1f1f",
    toolbar_bg="#1f1f1f",
    tab_active_bg="#1f1f1f",
    tab_inactive_bg="#181818",
    list_hover="#2a2d2e",
    list_selection="#0078d4",
    list_inactive_selection="#37373d",
    status_bar_bg="#181818",
    status_bar_fg="#cccccc",
    marker_added="#3fb950",
    marker_modified="#e3b341",
    marker_deleted="#f85149",
    syntax_keyword="#c586c0",
    syntax_string="#ce9178",
    syntax_comment="#6a9955",
    syntax_number="#b5cea8",
    syntax_function="#dcdcaa",
    syntax_class="#4ec9b0",
    syntax_builtin="#569cd6",
    syntax_operator="#d4d4d4",
    syntax_error="#f85149",
    syntax_meta="#9cdcfe",
    # 终端：VSCode Dark Modern 的终端配色
    terminal_bg="#1f1f1f",
    terminal_fg="#cccccc",
    terminal_cursor="#ffffff",
    terminal_selection="#264f78",
    terminal_ansi=(
        "#000000", "#cd3131", "#0dbc79", "#e5e510",
        "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
        "#666666", "#f14c4c", "#23d18b", "#f5f543",
        "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
    ),
)

BUILTIN_THEMES: Tuple[Theme, ...] = (DARK, LIGHT)
_THEMES: Dict[str, Theme] = {theme.name: theme for theme in BUILTIN_THEMES}


def get_theme(name: str) -> Theme:
    """按名称取主题，未知名称回退到深色。"""
    return _THEMES.get((name or "").lower(), DARK)


def available_themes() -> Tuple[Theme, ...]:
    return tuple(_THEMES.values())


def default_monospace_family() -> str:
    """默认等宽字体：优先用内置字体，其次才是系统字体。"""
    bundled = preferred_monospace_family()
    if bundled:
        return bundled
    if sys.platform.startswith("win"):
        return "Consolas"
    if sys.platform == "darwin":
        return "Menlo"
    return "DejaVu Sans Mono"


def monospace_font(size: int = 12, family: str = "") -> QFont:
    """构造等宽字体。"""
    font = QFont(family or default_monospace_family())
    font.setStyleHint(QFont.StyleHint.Monospace)
    font.setFixedPitch(True)
    font.setPointSize(size)
    return font


# ---------------------------------------------------------------------------
# 外部主题：直接加载 VSCode 主题 JSON（GitHub Dark 等开源主题）
# ---------------------------------------------------------------------------

#: 外部主题文件后缀
THEME_SUFFIX = ".json"

#: VSCode 主题的 ``colors`` 键 → Theme 字段；按顺序取第一个可用的值
_VSCODE_COLOR_KEYS: Dict[str, Tuple[str, ...]] = {
    "window_bg": ("window.background", "editor.background"),
    "panel_bg": (
        "sideBar.background",
        "activityBar.background",
        "editorWidget.background",
        "editor.background",
    ),
    "editor_bg": ("editor.background", "sideBar.background"),
    "editor_fg": ("editor.foreground",),
    "gutter_bg": ("editorGutter.background", "editor.background"),
    "gutter_fg": ("editorLineNumber.foreground", "editorCodeLens.foreground"),
    "current_line": ("editor.lineHighlightBackground", "editor.background"),
    "selection": ("editor.selectionBackground", "list.activeSelectionBackground"),
    "border": ("panel.border", "contrastBorder", "editorGroup.border", "sideBar.border"),
    "accent": (
        "focusBorder",
        "button.background",
        "progressBar.background",
        "textLink.foreground",
    ),
    "status_fg": ("descriptionForeground", "editorCodeLens.foreground", "editor.foreground"),
    "menu_bg": ("menu.background", "dropdown.background", "editorWidget.background"),
    "toolbar_bg": ("toolbar.background", "editorWidget.background", "sideBar.background"),
    "tab_active_bg": ("tab.activeBackground", "editor.background"),
    "tab_inactive_bg": (
        "tab.inactiveBackground",
        "editorGroupHeader.tabsBackground",
        "sideBar.background",
    ),
    "list_hover": ("list.hoverBackground", "list.focusBackground"),
    "list_selection": ("list.activeSelectionBackground", "editor.selectionBackground"),
    "list_inactive_selection": ("list.inactiveSelectionBackground", "list.hoverBackground"),
    "status_bar_bg": ("statusBar.background", "activityBar.background"),
    "status_bar_fg": ("statusBar.foreground", "editor.foreground"),
    "marker_added": (
        "gitDecoration.addedResourceForeground",
        "gitDecoration.untrackedResourceForeground",
    ),
    "marker_modified": ("gitDecoration.modifiedResourceForeground",),
    "marker_deleted": ("gitDecoration.deletedResourceForeground",),
    "terminal_bg": ("terminal.background", "editor.background"),
    "terminal_fg": ("terminal.foreground", "editor.foreground"),
    "terminal_cursor": ("terminalCursor.foreground", "terminal.foreground"),
    "terminal_selection": ("terminal.selectionBackground", "editor.selectionBackground"),
}

#: 语法类别 → VSCode TextMate scope 前缀
_VSCODE_SYNTAX_SCOPES: Dict[str, Tuple[str, ...]] = {
    "keyword": ("keyword.control", "keyword.operator.new", "keyword", "storage.type"),
    "string": ("string.quoted", "string.template", "string"),
    "comment": ("comment.line", "comment.block", "comment"),
    "number": ("constant.numeric", "constant.language", "constant"),
    "function": ("entity.name.function", "support.function", "meta.function-call"),
    "class": ("entity.name.type", "entity.name.class", "support.class"),
    "builtin": ("support.type", "support.variable", "variable.language", "constant.other"),
    "operator": ("keyword.operator", "punctuation.separator"),
    "error": ("invalid",),
    "meta": ("meta.preprocessor", "meta.tag", "entity.name.tag", "storage.modifier.import"),
}

_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def user_theme_dir() -> Path:
    """用户配色主题目录（打包之后仍然可写）：放进去的 VSCode 主题 JSON 会被加载。

    与内置主题同名时**不覆盖内置**（扫描顺序是「内置 → 用户」，同名保留先扫到的）。
    """
    return config_dir() / "themes"


def external_theme_dirs() -> Tuple[Path, ...]:
    """外部主题目录：随程序分发的 ``assets/themes`` 与用户配置目录下的 ``themes``。"""
    return (resource_path("assets", "themes"), user_theme_dir())


def _normalize_color(value: Any, *, base: str = "#000000") -> Optional[str]:
    """把 VSCode 的颜色值转成 ``#rrggbb``。

    VSCode 用 ``#rrggbbaa`` 表示带透明度，而 Qt 的 8 位写法是 ``#aarrggbb``，
    直接塞进去会把 alpha 当红色用；这里统一按底色合成，抹掉透明度。
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not _HEX_COLOR_RE.match(text):
        return None
    if len(text) == 9 or len(text) == 5:
        body, alpha_text = text[:-2], text[-2:]
        colour = QColor(body)
        try:
            alpha = int(alpha_text, 16) / 255.0
        except ValueError:  # pragma: no cover - 正则已保证是十六进制
            return None
        background = QColor(base)
        if colour.isValid() and background.isValid() and alpha < 1.0:
            colour = QColor(
                round(colour.red() * alpha + background.red() * (1 - alpha)),
                round(colour.green() * alpha + background.green() * (1 - alpha)),
                round(colour.blue() * alpha + background.blue() * (1 - alpha)),
            )
    else:
        colour = QColor(text)
    return colour.name() if colour.isValid() else None


def _pick(
    colors: Dict[str, Any], keys: Sequence[str], fallback: str, *, base: Optional[str] = None
) -> str:
    """按顺序取第一个可用颜色；半透明色统一与 ``base``（编辑器底色）合成。"""
    background = base or fallback
    for key in keys:
        normalized = _normalize_color(colors.get(key), base=background)
        if normalized:
            return normalized
    return fallback


def _luminance(hex_color: str) -> float:
    colour = QColor(hex_color)
    if not colour.isValid():  # pragma: no cover - 颜色已在 _pick 里校验
        return 0.0
    return 0.299 * colour.redF() + 0.587 * colour.greenF() + 0.114 * colour.blueF()


def _scope_color(token_colors: Any, scopes: Sequence[str]) -> Optional[str]:
    """在 ``tokenColors`` 里按顺序找第一个命中 ``scopes`` 的前景色。"""
    for entry in token_colors or ():
        if not isinstance(entry, dict):
            continue
        raw_scope = entry.get("scope")
        if isinstance(raw_scope, str):
            entry_scopes = [item.strip() for item in raw_scope.split(",") if item.strip()]
        elif isinstance(raw_scope, (list, tuple)):
            entry_scopes = [str(item).strip() for item in raw_scope if str(item).strip()]
        else:
            entry_scopes = []
        settings = entry.get("settings")
        if not entry_scopes or not isinstance(settings, dict):
            continue
        foreground = settings.get("foreground")
        if not isinstance(foreground, str):
            continue
        for entry_scope in entry_scopes:
            for wanted in scopes:
                if entry_scope == wanted or entry_scope.startswith(wanted + "."):
                    return foreground
    return None


#: VSCode 主题里 ANSI 调色板的键名（顺序即 0-15 号色）
TERMINAL_ANSI_KEYS: Tuple[str, ...] = (
    "terminal.ansiBlack",
    "terminal.ansiRed",
    "terminal.ansiGreen",
    "terminal.ansiYellow",
    "terminal.ansiBlue",
    "terminal.ansiMagenta",
    "terminal.ansiCyan",
    "terminal.ansiWhite",
    "terminal.ansiBrightBlack",
    "terminal.ansiBrightRed",
    "terminal.ansiBrightGreen",
    "terminal.ansiBrightYellow",
    "terminal.ansiBrightBlue",
    "terminal.ansiBrightMagenta",
    "terminal.ansiBrightCyan",
    "terminal.ansiBrightWhite",
)


def theme_from_vscode(
    data: Dict[str, Any],
    *,
    name: str,
    display_name: str = "",
    base: Optional[Theme] = None,
) -> Theme:
    """把 VSCode 主题 JSON 映射成一套 :class:`Theme`。

    主题里没定义的键沿用 ``base``（默认按背景亮度在深色 / 浅色之间选），
    因此任意第三方主题都能安全加载，不会缺字段。
    """
    colors = data.get("colors") if isinstance(data.get("colors"), dict) else {}
    if base is None:
        probe = _normalize_color(colors.get("editor.background"))
        base = DARK if (probe is None or _luminance(probe) < 0.5) else LIGHT

    values: Dict[str, Any] = {
        field.name: getattr(base, field.name) for field in dataclass_fields(Theme)
    }
    editor_bg = _pick(colors, _VSCODE_COLOR_KEYS["editor_bg"], base.editor_bg)
    for field_name, keys in _VSCODE_COLOR_KEYS.items():
        values[field_name] = _pick(colors, keys, getattr(base, field_name), base=editor_bg)
    ansi = list(values["terminal_ansi"])
    for index, key in enumerate(TERMINAL_ANSI_KEYS):
        normalized = _normalize_color(colors.get(key), base=values["terminal_bg"])
        if normalized:
            ansi[index] = normalized
    values["terminal_ansi"] = tuple(ansi)

    for category, scopes in _VSCODE_SYNTAX_SCOPES.items():
        found = _scope_color(data.get("tokenColors"), scopes)
        normalized = _normalize_color(found, base=values["editor_bg"])
        if normalized:
            values[f"syntax_{category}"] = normalized

    values["name"] = name
    values["display_name"] = display_name or name
    values["dark"] = _luminance(values["editor_bg"]) < 0.5
    return Theme(**values)


def _slugify(text: str) -> str:
    slug = re.sub(r"[^0-9a-zA-Z]+", "-", text.strip().lower()).strip("-")
    return slug or "theme"


def load_theme_file(path: Path, *, base: Optional[Theme] = None) -> Optional[Theme]:
    """加载单个 VSCode 主题文件；不是合法主题时返回 ``None``。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("读取主题 %s 失败: %s", path, exc)
        return None
    if not isinstance(data, dict) or not isinstance(data.get("colors"), dict):
        return None
    return theme_from_vscode(
        data,
        name=_slugify(path.stem),
        display_name=str(data.get("name") or path.stem),
        base=base,
    )


def load_external_themes() -> Tuple[Theme, ...]:
    """扫描内置与用户主题目录，返回可用主题（同名只保留第一个）。"""
    themes: List[Theme] = []
    seen: set = set()
    for folder in external_theme_dirs():
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob(f"*{THEME_SUFFIX}")):
            theme = load_theme_file(path)
            if theme is None or theme.name in seen:
                continue
            seen.add(theme.name)
            themes.append(theme)
    return tuple(themes)


def reload_themes() -> Tuple[Theme, ...]:
    """重新扫描内置 + 外部主题（新增 / 删除主题文件后调用）。"""
    _THEMES.clear()
    for theme in BUILTIN_THEMES:
        _THEMES[theme.name] = theme
    for theme in load_external_themes():
        _THEMES.setdefault(theme.name, theme)
    return available_themes()


#: 界面默认字号。Qt 默认 9pt 偏小、界面显得发旧；VSCode 默认 13px ≈ 9.75pt，这里取 10pt。
#: 实际字号 = 该值 × ``ui_scale``（Ctrl+= / Ctrl+- 的全局缩放），见 :func:`apply_theme`。
UI_FONT_POINT_SIZE = 10.0

#: 需要统一施加「界面字体 + 字号」的外壳控件。刻意**不含** QPlainTextEdit / QTextEdit：
#: 编辑器与日志视图有各自的等宽字体，不能被界面字体覆盖。
_UI_FONT_SELECTORS = (
    "QMainWindow, QDialog, QMenuBar, QMenu, QToolBar, QToolButton, QStatusBar, QLabel,"
    "QTabBar, QTabWidget, QGroupBox, QPushButton, QDialogButtonBox, QLineEdit, QSpinBox,"
    "QComboBox, QCheckBox, QRadioButton, QTreeView, QListView, QTableView, QListWidget,"
    "QTreeWidget, QTableWidget, QHeaderView, QToolTip, QDockWidget"
)

#: 勾选框对勾 / 微调与下拉箭头的小图标：QSS 只能引用图片文件，
#: 所以运行时按当前主题颜色生成 SVG 写到临时目录（不随程序分发，也不落盘在配置目录）。
_GLYPH_DIR_NAME = "glyphs"

_CHECKMARK_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">'
    '<path fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round" '
    'stroke-linejoin="round" d="M3.4 8.4l2.9 2.9 6.3-6.8"/></svg>'
)

#: 箭头：``up`` / ``down`` 两个方向，路径点顺序不同
_ARROW_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">'
    '<path fill="none" stroke="{color}" stroke-width="1.8" stroke-linecap="round" '
    'stroke-linejoin="round" d="{path}"/></svg>'
)

_ARROW_PATHS = {"up": "M4 9.6L8 5.6l4 4", "down": "M4 6.4l4 4 4-4"}


def _rgba(color: str, alpha: float) -> str:
    """把主题色转成带透明度的 QSS 颜色（滚动条滑块用，能浮在任意底色上）。"""
    value = QColor(color)
    if not value.isValid():  # pragma: no cover - 主题字段都经过校验
        value = QColor("#808080")
    return f"rgba({value.red()}, {value.green()}, {value.blue()}, {alpha:.2f})"


def _blend(foreground: str, background: str, ratio: float) -> str:
    """把前景色与背景色按 ``ratio`` 混合，得到中性灰（用于箭头等小图标）。

    SVG 不认 QSS 的 ``rgba()`` 写法，所以这里统一给十六进制值。
    """
    front, back = QColor(foreground), QColor(background)
    if not front.isValid() or not back.isValid():  # pragma: no cover - 主题字段都经过校验
        return "#8b949e"
    mixed = QColor(
        round(front.red() * ratio + back.red() * (1 - ratio)),
        round(front.green() * ratio + back.green() * (1 - ratio)),
        round(front.blue() * ratio + back.blue() * (1 - ratio)),
    )
    return mixed.name()


def glyph_dir() -> Path:
    """运行时生成的小图标目录（放在临时目录，程序退出后由系统回收）。"""
    return ensure_dir(temp_dir() / _GLYPH_DIR_NAME)


def _write_glyph(name: str, content: str) -> str:
    """写出一个 SVG 并返回 QSS 可直接用的路径；目录不可写时返回空串。"""
    try:
        path = glyph_dir() / name
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            path.write_text(content, encoding="utf-8")
    except OSError as exc:  # pragma: no cover - 只在目录不可写时触发
        logger.warning("生成界面图标 %s 失败: %s", name, exc)
        return ""
    return path.as_posix()


def _glyph_urls(theme: Theme) -> Dict[str, str]:
    """按主题颜色生成勾选 / 箭头图标，返回 ``{名字: QSS url(...)}``。

    图片缺失（目录不可写）时对应项为空串，QSS 里退化成纯色色块，
    不会让样式表语法出错。
    """
    arrow_color = _blend(theme.editor_fg, theme.editor_bg, 0.5)
    glyphs = {
        "check": _write_glyph(
            f"check-{theme.name}.svg", _CHECKMARK_SVG.format(color="#ffffff")
        ),
        "arrow_up": _write_glyph(
            f"arrow-up-{theme.name}.svg",
            _ARROW_SVG.format(color=arrow_color, path=_ARROW_PATHS["up"]),
        ),
        "arrow_down": _write_glyph(
            f"arrow-down-{theme.name}.svg",
            _ARROW_SVG.format(color=arrow_color, path=_ARROW_PATHS["down"]),
        ),
    }
    return {
        key: f"url({value})" if value else "none" for key, value in glyphs.items()
    }


def ui_font() -> QFont:
    """界面字体：沿用系统界面字体族，只把字号调到现代编辑器常用的 10pt。"""
    font = QFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.GeneralFont))
    font.setPointSizeF(UI_FONT_POINT_SIZE)
    return font


def apply_ui_font(app: QApplication) -> None:
    """设置界面字号。**必须在建任何控件之前调用**。

    Qt/PySide 在本机版本上「控件已经存在之后再改 QApplication 字体」会埋雷：
    之后再调用 ``setStyleSheet`` 会随机段错误（离屏测试里能稳定复现，
    见 tests/test_file_tree.py 的徽标渲染用例）。所以字体只在启动阶段设一次，
    ``apply_theme`` 只管调色板与样式表。
    """
    app.setFont(ui_font())


def refresh_style(widget: QWidget) -> None:
    """动态属性改变后重刷样式（Qt 不会自动重算 QSS 选择器）。"""
    style = widget.style()
    style.unpolish(widget)
    style.polish(widget)


def apply_theme(
    app: QApplication,
    theme: Theme,
    *,
    ui_scale: float = 1.0,
    ui_family: str = "",
) -> None:
    """把主题应用到 QApplication（调色板 + 样式表 + 界面字体）。

    ``ui_scale`` 是全局缩放系数（Ctrl+= / Ctrl+-），同时作用于界面字号；
    ``ui_family`` 是界面字体族，留空时自动挑一个带中文字形的系统字体。
    """
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(theme.window_bg))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(theme.editor_fg))
    palette.setColor(QPalette.ColorRole.Base, QColor(theme.editor_bg))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor(theme.panel_bg))
    palette.setColor(QPalette.ColorRole.Text, QColor(theme.editor_fg))
    palette.setColor(QPalette.ColorRole.Button, QColor(theme.panel_bg))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(theme.editor_fg))
    palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(theme.panel_bg))
    palette.setColor(QPalette.ColorRole.ToolTipText, QColor(theme.editor_fg))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(theme.accent))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor("#ffffff"))
    app.setPalette(palette)
    accent_hover = QColor(theme.accent).lighter(125).name()
    glyphs = _glyph_urls(theme)
    # 界面字体：显式指定字体族与字号（而不是只改 QApplication 字体），
    # 这样 Ctrl+= 缩放只改样式表就能整体生效，不需要在运行时改应用字体。
    scale = max(0.5, min(3.0, float(ui_scale)))
    font_rules = f"font-size: {UI_FONT_POINT_SIZE * scale:g}pt;"
    family = ui_family or preferred_ui_family()
    if family:
        font_rules = f'font-family: "{family}"; ' + font_rules
    # 分隔线：深色主题下 border 与底色太接近，边界会「糊」在一起，
    # 这里向文本色靠一点，保证区域边界看得出来（VSCode 靠区域底色差，我们两者都要）
    divider = _blend(theme.border, theme.editor_fg, 0.18 if theme.dark else 0.10)
    # 滚动条滑块：半透明，能浮在侧边栏 / 编辑器任意底色上（VSCode 同款做法）
    slider = _rgba(theme.editor_fg, 0.20)
    slider_hover = _rgba(theme.editor_fg, 0.32)
    slider_active = _rgba(theme.editor_fg, 0.45)
    # 控件描边：比面板分隔线略深一点，让输入框有边界但不显得立体
    control_border = theme.border if theme.dark else _rgba(theme.editor_fg, 0.25)
    muted = _rgba(theme.editor_fg, 0.55) if theme.dark else theme.gutter_fg
    # 列表 / 菜单选中行：深色主题配白字，浅色主题的浅灰底必须配深色字
    selection_fg = "#ffffff" if theme.dark else theme.editor_fg

    # 仿 VSCode：扁平、无边框 / 无渐变 / 无立体感，选中与悬停用列表底色
    qss = (
        f"""
        QMainWindow, QDialog {{ background: {theme.window_bg}; }}
        {_UI_FONT_SELECTORS} {{ {font_rules} }}
        QWidget#title_bar {{ background: {theme.menu_bg};
                            border-bottom: 1px solid {divider}; }}
        QLabel#title_label {{ color: {theme.status_fg}; }}
        QMenuBar#title_menu_bar {{ background: transparent; padding: 0px; }}
        QMenuBar#title_menu_bar::item {{ padding: 3px 8px; }}
        QToolButton#window_minimize, QToolButton#window_maximize, QToolButton#window_close {{
            background: transparent; border: 0px; border-radius: 0px; padding: 0px; }}
        QToolButton#window_minimize:hover, QToolButton#window_maximize:hover {{
            background: {theme.list_hover}; }}
        QToolButton#window_close:hover {{ background: {theme.syntax_error}; }}
        QWidget#activity_bar {{ background: {theme.panel_bg};
                               border-right: 1px solid {divider}; }}
        QWidget#side_panel {{ border-right: 1px solid {divider}; }}
        QLabel[muted="true"] {{ color: {muted}; }}
        QLabel[severity="error"] {{ color: {theme.syntax_error}; }}
        QToolTip {{ color: {theme.editor_fg}; background: {theme.panel_bg};
                    border: 1px solid {theme.border}; border-radius: 3px; padding: 3px 6px; }}

        QMenuBar {{ background: {theme.menu_bg}; color: {theme.status_fg}; padding: 2px 4px; }}
        QMenuBar::item {{ background: transparent; padding: 4px 8px; border-radius: 4px; }}
        QMenuBar::item:selected {{ background: {theme.list_hover}; color: {theme.editor_fg}; }}
        QMenu {{ background: {theme.panel_bg}; color: {theme.editor_fg};
                 border: 1px solid {theme.border}; border-radius: 4px; padding: 4px; }}
        QMenu::item {{ padding: 5px 28px 5px 20px; border-radius: 4px; }}
        QMenu::item:selected {{ background: {theme.list_selection}; color: {selection_fg}; }}
        QMenu::separator {{ height: 1px; background: {theme.border}; margin: 4px 8px; }}

        QToolBar {{ background: {theme.toolbar_bg}; border: 0px; spacing: 2px; padding: 3px 6px; }}
        QToolBar::separator {{ background: {theme.border}; width: 1px; margin: 5px 6px; }}
        QToolButton {{ background: transparent; color: {theme.editor_fg};
                       border: 1px solid transparent; border-radius: 4px; padding: 4px 6px; }}
        QToolButton:hover {{ background: {theme.list_hover}; }}
        QToolButton:pressed {{ background: {theme.list_selection}; }}
        QToolButton:checked {{ background: {theme.list_selection}; }}
        QToolButton:disabled {{ color: {muted}; }}

        QStatusBar {{ background: {theme.status_bar_bg}; color: {theme.status_bar_fg};
                      border: 0px; border-top: 1px solid {divider}; }}
        QStatusBar QLabel {{ color: {theme.status_bar_fg}; padding: 0px 5px; }}
        QStatusBar::item {{ border: 0px; }}

        QWidget#terminal_panel {{ background: {theme.editor_bg};
                                  border-top: 1px solid {divider}; }}
        QWidget#terminal_panel QTabWidget::pane {{ border: 0px; }}
        QDockWidget {{ border: 0px; }}
        QDockWidget::title {{ background: {theme.panel_bg}; color: {theme.status_fg};
                              padding: 4px 8px; border-bottom: 1px solid {theme.border}; }}
        QSplitter::handle {{ background: {divider}; }}
        QSplitter::handle:horizontal {{ width: 1px; }}
        QSplitter::handle:vertical {{ height: 1px; }}
        QSplitter::handle:hover {{ background: {theme.accent}; }}

        QTabWidget::pane {{ border: 0px; }}
        QTabBar {{ background: {theme.tab_inactive_bg};
                  border-bottom: 1px solid {divider}; }}
        QTabBar::tab {{ background: {theme.tab_inactive_bg}; color: {muted};
                        padding: 6px 12px; border: 0px; border-right: 1px solid {divider};
                        border-top: 2px solid transparent; }}
        QTabBar::tab:selected {{ background: {theme.tab_active_bg}; color: {theme.editor_fg};
                                 border-top: 2px solid {theme.accent}; }}
        QTabBar::tab:hover:!selected {{ background: {theme.list_hover}; }}
        QToolButton#tab_close {{ background: transparent; border: 0px; padding: 0px; }}
        QToolButton#tab_close:hover {{ background: {theme.list_hover}; border-radius: 3px; }}

        QHeaderView::section {{ background: {theme.panel_bg}; color: {theme.status_fg};
                                border: 0px; border-right: 1px solid {theme.border};
                                border-bottom: 1px solid {theme.border}; padding: 3px 6px; }}

        QTreeView, QListView, QTableView {{ background: {theme.panel_bg}; color: {theme.editor_fg};
                                            border: 0px; outline: 0px;
                                            show-decoration-selected: 1; }}
        QTreeView::item:hover, QListView::item:hover {{ background: {theme.list_hover}; }}
        QTreeView::item:selected {{ background: {theme.list_selection}; color: {selection_fg}; }}
        QTreeView::item:selected:!active {{ background: {theme.list_inactive_selection}; }}
        QListWidget::item {{ padding: 3px 4px; border-radius: 3px; }}

        QLineEdit, QSpinBox, QComboBox, QPlainTextEdit, QTextEdit {{
            background: {theme.editor_bg}; color: {theme.editor_fg};
            border: 1px solid {control_border}; border-radius: 4px; padding: 3px 6px;
            selection-background-color: {theme.selection}; }}
        QLineEdit:focus, QSpinBox:focus, QComboBox:focus {{
            border: 1px solid {theme.accent}; }}
        QLineEdit:disabled, QSpinBox:disabled, QComboBox:disabled {{
            color: {muted}; background: {theme.panel_bg}; }}

        QComboBox::drop-down {{ border: 0px; width: 20px; }}
        QComboBox::down-arrow {{ image: {glyphs["arrow_down"]};
                                 width: 12px; height: 12px; }}
        QComboBox QAbstractItemView {{ background: {theme.panel_bg}; color: {theme.editor_fg};
                                       border: 1px solid {theme.border}; border-radius: 4px;
                                       padding: 4px; outline: 0px;
                                       selection-background-color: {theme.list_selection};
                                       selection-color: {selection_fg}; }}

        QSpinBox::up-button, QSpinBox::down-button {{
            background: transparent; border: 0px; width: 18px; }}
        QSpinBox::up-button:hover, QSpinBox::down-button:hover {{
            background: {theme.list_hover}; }}
        QSpinBox::up-arrow {{ image: {glyphs["arrow_up"]}; width: 11px; height: 11px; }}
        QSpinBox::down-arrow {{ image: {glyphs["arrow_down"]}; width: 11px; height: 11px; }}

        QPushButton {{ background: {theme.toolbar_bg}; color: {theme.editor_fg};
                       border: 1px solid {control_border}; border-radius: 4px;
                       padding: 5px 14px; }}
        QPushButton:hover {{ background: {theme.list_hover}; }}
        QPushButton:pressed {{ background: {theme.list_selection}; }}
        QPushButton:checked {{ background: {theme.list_selection}; color: {selection_fg}; }}
        QPushButton:default {{ background: {theme.accent}; color: #ffffff;
                               border: 1px solid {theme.accent}; }}
        QPushButton:default:hover {{ background: {accent_hover}; border-color: {accent_hover}; }}
        QPushButton:disabled {{ color: {muted}; background: {theme.panel_bg};
                                border-color: {theme.border}; }}

        QCheckBox, QRadioButton {{ color: {theme.editor_fg}; spacing: 6px; }}
        QCheckBox::indicator, QRadioButton::indicator {{ width: 15px; height: 15px; }}
        QCheckBox::indicator:unchecked, QRadioButton::indicator:unchecked {{
            border: 1px solid {control_border}; border-radius: 3px;
            background: {theme.editor_bg}; }}
        QCheckBox::indicator:unchecked:hover, QRadioButton::indicator:unchecked:hover {{
            border: 1px solid {theme.accent}; }}
        QCheckBox::indicator:checked {{ border: 1px solid {theme.accent}; border-radius: 3px;
                                        background: {theme.accent};
                                        image: {glyphs["check"]}; }}
        QCheckBox::indicator:disabled, QRadioButton::indicator:disabled {{
            border: 1px solid {theme.border}; background: {theme.panel_bg}; }}
        QRadioButton::indicator:unchecked {{ border-radius: 8px; }}
        QRadioButton::indicator:checked {{ border: 4px solid {theme.accent}; border-radius: 8px;
                                           background: {theme.editor_bg}; }}

        QGroupBox {{ border: 0px; border-top: 1px solid {theme.border};
                     margin-top: 10px; padding: 10px 0px 0px 0px; }}
        QGroupBox::title {{ subcontrol-origin: margin; subcontrol-position: top left;
                            left: 0px; padding: 0px 6px 0px 0px; color: {muted}; }}

        QScrollBar:vertical {{ background: transparent; width: 12px; margin: 0px; }}
        QScrollBar:horizontal {{ background: transparent; height: 12px; margin: 0px; }}
        QScrollBar::handle:vertical {{ background: {slider}; border-radius: 5px;
                                       min-height: 24px; margin: 3px; }}
        QScrollBar::handle:horizontal {{ background: {slider}; border-radius: 5px;
                                         min-width: 24px; margin: 3px; }}
        QScrollBar::handle:vertical:hover, QScrollBar::handle:horizontal:hover {{
            background: {slider_hover}; }}
        QScrollBar::handle:vertical:pressed, QScrollBar::handle:horizontal:pressed {{
            background: {slider_active}; }}
        QScrollBar::add-line, QScrollBar::sub-line {{ background: transparent;
                                                     width: 0px; height: 0px; border: 0px; }}
        QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}
        QScrollBar::up-arrow, QScrollBar::down-arrow,
        QScrollBar::left-arrow, QScrollBar::right-arrow {{ width: 0px; height: 0px; }}

        QProgressBar {{ background: {theme.panel_bg}; border: 0px; border-radius: 2px;
                        color: {theme.editor_fg}; text-align: center; }}
        QProgressBar::chunk {{ background: {theme.accent}; border-radius: 2px; }}
        """
    )
    app.setStyleSheet(qss)
