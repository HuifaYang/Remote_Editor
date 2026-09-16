"""底部状态栏：连接状态 / Git / 文件 / 语言 / 编码 / 保存状态。"""

from __future__ import annotations

from typing import Optional

from PySide6.QtWidgets import QHBoxLayout, QLabel, QStatusBar, QWidget

from app.utils.paths import APP_NAME, APP_VERSION


class _Cell(QLabel):
    def __init__(self, title: str, value: str = "-", parent: Optional[QWidget] = None) -> None:
        super().__init__(f"{title}: {value}", parent)
        self._title = title
        self.setContentsMargins(6, 0, 6, 0)

    def set_value(self, value: str) -> None:
        self.setText(f"{self._title}: {value}")


class StatusBar(QStatusBar):
    """应用状态栏。"""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.connection_cell = _Cell("SSH", "Disconnected")
        self.git_cell = _Cell("Git", "-")
        self.file_cell = _Cell("File", "-")
        self.language_cell = _Cell("Language", "-")
        self.encoding_cell = _Cell("Encoding", "-")
        self.save_cell = _Cell("Status", "Ready")
        self.cursor_cell = _Cell("Ln", "1, Col 1")

        container = QWidget(self)
        layout = QHBoxLayout(container)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        for cell in (
            self.connection_cell,
            self.git_cell,
            self.file_cell,
            self.language_cell,
            self.encoding_cell,
            self.save_cell,
            self.cursor_cell,
        ):
            layout.addWidget(cell)
        layout.addStretch(1)
        self.addPermanentWidget(container, 1)

        self.showMessage(f"{APP_NAME} {APP_VERSION}", 4000)

    # -- 更新接口 ----------------------------------------------------------
    def set_connection(self, connected: bool, host: str = "") -> None:
        value = "Connected" if connected else "Disconnected"
        if connected and host:
            value = f"Connected · {host}"
        self.connection_cell.set_value(value)

    def set_git(self, label: str, summary: str = "") -> None:
        value = label if not summary else f"{label} {summary}"
        self.git_cell.set_value(value)

    def set_file(self, name: str) -> None:
        self.file_cell.set_value(name or "-")

    def set_language(self, language: str) -> None:
        self.language_cell.set_value(language or "-")

    def set_encoding(self, encoding: str) -> None:
        self.encoding_cell.set_value(encoding or "-")

    def set_save_status(self, status: str) -> None:
        self.save_cell.set_value(status)

    def set_cursor(self, line: int, column: int) -> None:
        self.cursor_cell.set_value(f"{line}, Col {column}")
