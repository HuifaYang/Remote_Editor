"""底部状态栏（仿 VSCode）：左区会话与仓库，右区编辑器字段，空值隐藏、hover 可点。"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QHBoxLayout, QLabel, QStatusBar, QWidget



class StatusItem(QLabel):
    """状态栏里的一项：可点击、hover 有底色，空文本时自动隐藏。"""

    clicked = Signal()

    def __init__(self, text: str = "", parent: Optional[QWidget] = None) -> None:
        super().__init__(text, parent)
        self.setContentsMargins(7, 0, 7, 0)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setProperty("statusItem", True)
        self._apply_visibility()

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()
        super().mousePressEvent(event)

    def set_text(self, text: str) -> None:
        self.setText(text)
        self._apply_visibility()

    def _apply_visibility(self) -> None:
        self.setVisible(bool(self.text()))


class StatusBar(QStatusBar):
    """应用状态栏。

    布局对齐 VSCode：左区放连接与 Git（连接状态、当前文件、分支与变更），
    右区放编辑器字段（行号、编码、语言、保存状态）。``*_cell`` 属性保持
    旧接口兼容，测试与主窗口调用不用改。
    """

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setSizeGripEnabled(False)

        # 左区：连接 → 当前文件 → Git
        self.connection_cell = StatusItem("⚡ 未连接")
        self.file_cell = StatusItem()
        self.git_cell = StatusItem()
        self.folder_cell = StatusItem()

        # 右区：编辑器字段
        self.save_cell = StatusItem()
        self.encoding_cell = StatusItem()
        self.language_cell = StatusItem()
        self.cursor_cell = StatusItem("行 1，列 1")

        left = QWidget(self)
        left_layout = QHBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(0)
        for cell in (
            self.connection_cell,
            self.file_cell,
            self.git_cell,
            self.folder_cell,
        ):
            left_layout.addWidget(cell)
        left_layout.addStretch(1)

        right = QWidget(self)
        right_layout = QHBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)
        for cell in (
            self.save_cell,
            self.encoding_cell,
            self.language_cell,
            self.cursor_cell,
        ):
            right_layout.addWidget(cell)

        self.addWidget(left, 1)
        self.addPermanentWidget(right, 0)

    # -- 更新接口 ----------------------------------------------------------
    def set_connection(self, connected: bool, host: str = "") -> None:
        if connected and host:
            self.connection_cell.set_text(f"⚡ 已连接 · {host}")
        elif connected:
            self.connection_cell.set_text("⚡ 已连接")
        else:
            self.connection_cell.set_text("⚡ 未连接")

    def set_folder(self, path: str) -> None:
        # "-" 是主窗口「未设置」的占位写法，不显示
        self.folder_cell.set_text("" if path in ("", "-") else path)

    def set_git(self, label: str, summary: str = "") -> None:
        # 仓库标签自带 "Git: " 前缀，去掉它，避免出现「Git: Git: main」
        value = label[len("Git: ") :] if label.startswith("Git: ") else label
        if not value or value == "-":
            self.git_cell.set_text("")
            return
        text = f"Git: {value}"
        if summary:
            text = f"{text} {summary}"
        self.git_cell.set_text(text)

    def set_file(self, name: str) -> None:
        self.file_cell.set_text(name or "")

    def set_language(self, language: str) -> None:
        self.language_cell.set_text(language or "")

    def set_encoding(self, encoding: str) -> None:
        self.encoding_cell.set_text(encoding or "")

    def set_save_status(self, status: str) -> None:
        self.save_cell.set_text(status)

    def set_cursor(self, line: int, column: int) -> None:
        self.cursor_cell.set_text(f"行 {line}，列 {column}")
