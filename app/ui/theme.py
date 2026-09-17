"""集中式主题配置。

需求（文档 5.7.1）要求「颜色配置集中管理，禁止硬编码」，
因此所有 UI 与 Gutter 颜色都只在这里定义。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, fields as dataclass_fields
from typing import Dict, Tuple

from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import QApplication


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

    def color(self, attribute: str) -> QColor:
        value = getattr(self, attribute)
        return QColor(value)

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
    window_bg="#f3f3f3",
    panel_bg="#f8f8f8",
    editor_bg="#ffffff",
    editor_fg="#1f1f1f",
    gutter_bg="#f7f7f7",
    gutter_fg="#9a9a9a",
    current_line="#f0f4fa",
    selection="#cfe3ff",
    border="#d9d9d9",
    accent="#0a66c2",
    status_fg="#444444",
    menu_bg="#ececec",
    toolbar_bg="#ececec",
    tab_active_bg="#ffffff",
    tab_inactive_bg="#ececec",
    list_hover="#e8e8e8",
    list_selection="#0060c0",
    list_inactive_selection="#e4e6f1",
    status_bar_bg="#0060c0",
    status_bar_fg="#ffffff",
    marker_added="#2ea043",
    marker_modified="#d29922",
    marker_deleted="#d1242f",
    syntax_keyword="#a00095",
    syntax_string="#0a7d32",
    syntax_comment="#6a737d",
    syntax_number="#0b5fd0",
    syntax_function="#795e26",
    syntax_class="#267f99",
    syntax_builtin="#0550ae",
    syntax_operator="#444444",
    syntax_error="#d1242f",
    syntax_meta="#7d4e00",
)

DARK = Theme(
    name="dark",
    display_name="深色",
    dark=True,
    window_bg="#1f1f1f",
    panel_bg="#252526",
    editor_bg="#1e1e1e",
    editor_fg="#d4d4d4",
    gutter_bg="#1e1e1e",
    gutter_fg="#858585",
    current_line="#26262b",
    selection="#264f78",
    border="#333333",
    accent="#3794ff",
    status_fg="#cccccc",
    menu_bg="#3c3c3c",
    toolbar_bg="#3c3c3c",
    tab_active_bg="#1e1e1e",
    tab_inactive_bg="#2d2d2d",
    list_hover="#2a2d2e",
    list_selection="#094771",
    list_inactive_selection="#37373d",
    status_bar_bg="#007acc",
    status_bar_fg="#ffffff",
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
)

_THEMES: Dict[str, Theme] = {theme.name: theme for theme in (DARK, LIGHT)}


def get_theme(name: str) -> Theme:
    """按名称取主题，未知名称回退到深色。"""
    return _THEMES.get((name or "").lower(), DARK)


def available_themes() -> Tuple[Theme, ...]:
    return tuple(_THEMES.values())


def default_monospace_family() -> str:
    """跨平台等宽字体候选。"""
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


def apply_theme(app: QApplication, theme: Theme) -> None:
    """把主题应用到 QApplication（调色板 + 精简样式表）。"""
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
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor("#ffffff" if theme.dark else "#ffffff"))
    app.setPalette(palette)
    accent_hover = QColor(theme.accent).lighter(125).name()
    # 仿 VSCode：扁平、无边框、紧凑，选中 / 悬停用列表底色而不是系统高亮
    app.setStyleSheet(
        f"""
        QMainWindow, QDialog {{ background: {theme.window_bg}; }}
        QToolTip {{ color: {theme.editor_fg}; background: {theme.panel_bg};
                    border: 1px solid {theme.border}; padding: 2px 4px; }}
        QMenuBar {{ background: {theme.menu_bg}; color: {theme.status_fg}; padding: 1px 2px; }}
        QMenuBar::item {{ background: transparent; padding: 4px 8px; }}
        QMenuBar::item:selected {{ background: {theme.list_selection}; }}
        QMenu {{ background: {theme.panel_bg}; color: {theme.editor_fg};
                 border: 1px solid {theme.border}; padding: 4px 0px; }}
        QMenu::item {{ padding: 5px 26px 5px 22px; }}
        QMenu::item:selected {{ background: {theme.list_selection}; }}
        QMenu::separator {{ height: 1px; background: {theme.border}; margin: 4px 10px; }}
        QToolBar {{ background: {theme.toolbar_bg}; border: 0px; spacing: 2px; padding: 2px 4px; }}
        QToolBar::separator {{ background: {theme.border}; width: 1px; margin: 4px 6px; }}
        QToolButton {{ background: transparent; color: {theme.editor_fg};
                       border: 1px solid transparent; border-radius: 3px; padding: 4px 6px; }}
        QToolButton:hover {{ background: {theme.list_hover}; }}
        QToolButton:checked {{ background: {theme.list_selection}; }}
        QStatusBar {{ background: {theme.status_bar_bg}; color: {theme.status_bar_fg};
                      border: 0px; }}
        QStatusBar QLabel {{ color: {theme.status_bar_fg}; padding: 0px 5px; }}
        QStatusBar::item {{ border: 0px; }}
        QDockWidget {{ border: 0px; }}
        QDockWidget::title {{ background: {theme.panel_bg}; color: {theme.status_fg};
                              padding: 4px 8px; border-bottom: 1px solid {theme.border}; }}
        QSplitter::handle {{ background: {theme.border}; }}
        QSplitter::handle:horizontal {{ width: 1px; }}
        QSplitter::handle:vertical {{ height: 1px; }}
        QTabWidget::pane {{ border: 0px; }}
        QTabBar {{ background: {theme.tab_inactive_bg}; }}
        QTabBar::tab {{ background: {theme.tab_inactive_bg}; color: {theme.gutter_fg};
                        padding: 6px 12px; border: 0px; border-right: 1px solid {theme.border};
                        border-top: 1px solid transparent; }}
        QTabBar::tab:selected {{ background: {theme.tab_active_bg}; color: {theme.editor_fg};
                                 border-top: 1px solid {theme.accent}; }}
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
        QTreeView::item:selected {{ background: {theme.list_selection}; color: #ffffff; }}
        QTreeView::item:selected:!active {{ background: {theme.list_inactive_selection}; }}
        QLineEdit, QSpinBox, QComboBox {{ background: {theme.editor_bg}; color: {theme.editor_fg};
                                          border: 1px solid {theme.border}; border-radius: 2px;
                                          padding: 2px 4px; }}
        QLineEdit:focus, QSpinBox:focus, QComboBox:focus {{ border: 1px solid {theme.accent}; }}
        QPushButton {{ background: {theme.toolbar_bg}; color: {theme.editor_fg};
                       border: 1px solid {theme.border}; border-radius: 2px; padding: 4px 12px; }}
        QPushButton:hover {{ background: {theme.list_hover}; }}
        QPushButton:checked {{ background: {theme.list_selection}; color: #ffffff; }}
        QPushButton:default {{ background: {theme.accent}; color: #ffffff; border: 0px; }}
        QPushButton:default:hover {{ background: {accent_hover}; }}
        QPushButton:disabled {{ color: {theme.gutter_fg}; }}
        QCheckBox, QRadioButton, QGroupBox, QLabel {{ color: {theme.editor_fg}; }}
        """
    )
