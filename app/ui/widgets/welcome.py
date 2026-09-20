"""起始页（仿 VSCode 的 Welcome）：未连接或未打开文件时占据编辑区。"""

from __future__ import annotations

from typing import List, Optional, Tuple

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QLabel, QPushButton, QVBoxLayout, QWidget

from app.ui.theme import Theme, refresh_style


def _kbd_shortcuts(pairs: List[Tuple[str, str]]) -> str:
    """把 [(快捷键, 说明), ...] 拼成等宽键名 + 说明，每条一行（Qt 富文本对
    键帽的 padding/边框支持很差，改用空格对齐，稳定且清爽）。"""
    width = max((len(keys) for keys, _ in pairs), default=0)
    lines = [f"{keys:<{width}}    {label}" for keys, label in pairs]
    return "\n".join(lines)


class WelcomeView(QWidget):
    """左对齐标题 + 主/次入口按钮 + kbd 键帽快捷键提示。"""

    connectRequested = Signal()
    openFolderRequested = Signal()

    def __init__(self, theme: Theme, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("welcome_view")

        self.title = QLabel("RemoteCodeEditor", self)
        title_font = self.title.font()
        title_font.setPointSizeF(title_font.pointSizeF() + 12)
        title_font.setBold(True)
        self.title.setFont(title_font)

        self.subtitle = QLabel("轻量级 SSH 远程代码编辑器 · 远端零常驻服务", self)

        # 主按钮实心 accent，次按钮弱化为描边样式（default 属性驱动 QSS）
        self.connect_button = QPushButton("连接主机…", self)
        self.connect_button.setDefault(True)
        self.connect_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.connect_button.clicked.connect(self.connectRequested)
        self.open_folder_button = QPushButton("打开远程文件夹…", self)
        self.open_folder_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.open_folder_button.clicked.connect(self.openFolderRequested)

        self.hint = QLabel("", self)
        self.hint.setWordWrap(True)

        # 左对齐排版，内容靠左上而不是居中（VSCode Welcome 的版式）
        layout = QVBoxLayout(self)
        layout.setContentsMargins(56, 48, 40, 40)
        layout.setSpacing(0)
        layout.addStretch(1)
        layout.addWidget(self.title, 0, Qt.AlignmentFlag.AlignLeft)
        layout.addSpacing(6)
        layout.addWidget(self.subtitle, 0, Qt.AlignmentFlag.AlignLeft)
        layout.addSpacing(28)
        layout.addWidget(self.connect_button, 0, Qt.AlignmentFlag.AlignLeft)
        layout.addSpacing(10)
        layout.addWidget(self.open_folder_button, 0, Qt.AlignmentFlag.AlignLeft)
        layout.addSpacing(32)
        layout.addWidget(self.hint, 0, Qt.AlignmentFlag.AlignLeft)
        layout.addStretch(2)

        self.apply_theme(theme)
        self.set_connected(False)

    def apply_theme(self, theme: Theme) -> None:
        self._theme = theme
        for label in (self.subtitle, self.hint):
            label.setProperty("muted", True)
            refresh_style(label)

    def set_connected(self, connected: bool) -> None:
        """连接之后「打开远程文件夹」才可用；「连接主机」在已连接时收起。"""
        self.connect_button.setVisible(not connected)
        self.open_folder_button.setEnabled(connected)
        pairs = (
            [("Ctrl+K", "连接主机"), ("Ctrl+O", "打开远程文件夹"), ("Ctrl+,", "设置")]
            if not connected
            else [("Ctrl+O", "打开远程文件夹"), ("Ctrl+F", "查找"), ("Shift+F5", "刷新 Git 标记")]
        )
        self.hint.setText(_kbd_shortcuts(pairs))
