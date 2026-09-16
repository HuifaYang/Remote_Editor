"""日志查看面板：把 Python logging 的输出实时显示到 GUI。"""

from __future__ import annotations

import logging
from typing import Optional

from PySide6.QtCore import QObject, Signal, Slot
from PySide6.QtWidgets import QPlainTextEdit, QWidget

from app.ui.theme import monospace_font

MAX_BLOCKS = 2000


class _LogBridge(QObject):
    """在 GUI 线程接收日志文本。"""

    message = Signal(str)


class QtLogHandler(logging.Handler):
    """把日志转发到 GUI（线程安全：通过信号跨线程投递）。"""

    def __init__(self, widget: "LogView", level: int = logging.INFO) -> None:
        super().__init__(level=level)
        self._bridge = _LogBridge()
        self._bridge.message.connect(widget.append_line)
        self.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
        )

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - 日志线程
        try:
            self._bridge.message.emit(self.format(record))
        except Exception:
            pass


class LogView(QPlainTextEdit, QWidget):
    """只读日志面板。"""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setReadOnly(True)
        self.setMaximumBlockCount(MAX_BLOCKS)
        font = monospace_font(10)
        self.setFont(font)

    @Slot(str)
    def append_line(self, line: str) -> None:
        self.appendPlainText(line)

    def install_handler(self, level: int = logging.INFO) -> QtLogHandler:
        """挂载到根 logger，返回 handler（便于移除）。"""
        handler = QtLogHandler(self, level=level)
        logging.getLogger().addHandler(handler)
        return handler

    def clear_log(self) -> None:
        self.clear()
