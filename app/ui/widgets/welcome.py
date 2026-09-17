"""起始页（仿 VSCode 的 Welcome）：未连接或未打开文件时占据编辑区。"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QLabel, QPushButton, QVBoxLayout, QWidget

from app.ui.theme import Theme


class WelcomeView(QWidget):
    """大标题 + 两个入口按钮 + 快捷键提示。"""

    connectRequested = Signal()
    openFolderRequested = Signal()

    def __init__(self, theme: Theme, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("welcome_view")

        self.title = QLabel("RemoteCodeEditor", self)
        title_font = self.title.font()
        title_font.setPointSizeF(title_font.pointSizeF() + 8)
        self.title.setFont(title_font)
        self.title.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.subtitle = QLabel("轻量级 SSH 远程代码编辑器 · 远端零常驻服务", self)
        self.subtitle.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.connect_button = QPushButton("连接主机…", self)
        self.connect_button.clicked.connect(self.connectRequested)
        self.open_folder_button = QPushButton("打开远程文件夹…", self)
        self.open_folder_button.clicked.connect(self.openFolderRequested)

        self.hint = QLabel("", self)
        self.hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.hint.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(40, 40, 40, 40)
        layout.setSpacing(10)
        layout.addStretch(2)
        layout.addWidget(self.title)
        layout.addWidget(self.subtitle)
        layout.addSpacing(16)
        layout.addWidget(self.connect_button, 0, Qt.AlignmentFlag.AlignHCenter)
        layout.addWidget(self.open_folder_button, 0, Qt.AlignmentFlag.AlignHCenter)
        layout.addSpacing(16)
        layout.addWidget(self.hint)
        layout.addStretch(3)

        self.apply_theme(theme)
        self.set_connected(False)

    def apply_theme(self, theme: Theme) -> None:
        self.title.setStyleSheet(f"color: {theme.editor_fg};")
        self.subtitle.setStyleSheet(f"color: {theme.gutter_fg};")
        self.hint.setStyleSheet(f"color: {theme.gutter_fg};")

    def set_connected(self, connected: bool) -> None:
        """连接之后「打开远程文件夹」才可用；「连接主机」在已连接时收起。"""
        self.connect_button.setVisible(not connected)
        self.open_folder_button.setEnabled(connected)
        self.hint.setText(
            "快捷键：Ctrl+K 连接主机 · Ctrl+O 打开远程文件夹 · Ctrl+, 设置"
            if not connected
            else "快捷键：Ctrl+O 打开远程文件夹 · Ctrl+F 查找 · Shift+F5 刷新 Git 标记"
        )
