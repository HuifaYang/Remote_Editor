"""终端视图：一块 :class:`TerminalCanvas` + 滚动条 + 与远端 shell 通道的桥接。

线程模型：:class:`~app.remote.shell_channel.ShellChannel` 的读取在后台线程，
数据经 ``_ChannelBridge`` 的信号切回 GUI 线程再喂给屏幕模型 —— 与项目其余部分
（``TaskRunner`` + 信号回主线程）保持同一套约定，控件本身不做网络 I/O。

界面约定：终端不再是「弹窗」，而是底部面板里的一个页签（对齐 VSCode）；
打开 / 关闭 / 切换终端的编排在 :mod:`app.ui.widgets.terminal_panel` 与主窗口。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import QHBoxLayout, QLabel, QScrollBar, QVBoxLayout, QWidget

from app.remote.shell_channel import ShellChannel
from app.terminal.screen import DEFAULT_SCROLLBACK, TerminalScreen
from app.ui.theme import Theme
from app.ui.widgets.terminal_canvas import TerminalCanvasMixin, make_canvas


class _ChannelBridge(QObject):
    """把后台读取线程的回调转成 GUI 线程的信号。"""

    dataReceived = Signal(str)
    closed = Signal()


class TerminalView(QWidget):
    """一个终端页签的内容。"""

    #: 远端 shell 结束 / 通道断开
    closed = Signal()
    #: 需要通知远端窗口大小变化：``(列, 行)``
    resized = Signal(int, int)

    def __init__(
        self,
        *,
        theme: Theme,
        font: QFont,
        scrollback: int = DEFAULT_SCROLLBACK,
        gpu: Optional[bool] = None,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        #: 注意别叫 ``screen``：QWidget 有同名方法，会被实例属性遮住
        self.terminal = TerminalScreen(80, 24, scrollback=scrollback)
        self.channel: Optional[ShellChannel] = None
        self._bridge = _ChannelBridge(self)
        self._bridge.dataReceived.connect(self._on_data)
        self._bridge.closed.connect(self._on_channel_closed)
        self._closed = False
        self._attached = True

        self.canvas: TerminalCanvasMixin = make_canvas(self, gpu=gpu)
        self.canvas.set_screen(self.terminal)
        self.canvas.set_theme(theme)
        self.canvas.set_font(font)
        self.canvas.dataEntered.connect(self.send)

        self.scrollbar = QScrollBar(Qt.Orientation.Vertical, self)
        self.scrollbar.setRange(0, 0)
        self.scrollbar.setSingleStep(1)
        self.scrollbar.setInvertedAppearance(True)  # 0 = 贴底（和终端语义一致）
        self.scrollbar.setPageStep(1)
        self.scrollbar.valueChanged.connect(self._on_scrolled)
        self.canvas.scrollRequested.connect(self._scroll_by)
        self.canvas.sizeChanged.connect(self._on_canvas_resized)

        self.notice = QLabel("", self)
        self.notice.setProperty("muted", True)
        self.notice.setMargin(4)
        self.notice.setVisible(False)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        body = QHBoxLayout()
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(0)
        body.addWidget(self.canvas, 1)
        body.addWidget(self.scrollbar)
        layout.addLayout(body, 1)
        layout.addWidget(self.notice)

    # -- 通道 --------------------------------------------------------------
    def start(self, channel: ShellChannel) -> None:
        """接管一条已打开的通道并开始接收数据。"""
        self.channel = channel
        self._closed = False
        self._attached = True
        self.notice.setVisible(False)
        channel.start_reader(self._bridge.dataReceived.emit, self._bridge.closed.emit)
        self.canvas.sync_size()  # 面板可能刚显示出来，把真实列 / 行数报给远端
        self.canvas.setFocus(Qt.FocusReason.OtherFocusReason)

    def send(self, text: str) -> None:
        if self.channel is not None:
            self.channel.write(text)

    def stop(self) -> None:
        """关闭通道（页签关闭 / 断开连接时调用）。"""
        if self.channel is not None:
            self.channel.close()
            self.channel = None
        self._closed = True
        self._attached = False

    @property
    def attached(self) -> bool:
        """页签是否还挂在面板上（shell 打开是异步的，回调回来时可能已被关掉）。"""
        return self._attached

    def is_running(self) -> bool:
        return self.channel is not None and not self._closed

    def show_notice(self, text: str) -> None:
        self.notice.setText(text)
        self.notice.setVisible(True)

    @property
    def gpu_rendering(self) -> bool:
        return bool(getattr(self.canvas, "gpu", False))

    # -- 数据 --------------------------------------------------------------
    def _on_data(self, text: str) -> None:
        self.terminal.feed(text)
        replies = self.terminal.take_replies()
        if replies:
            self.send(replies)
        self._sync_scrollbar()
        self.canvas.update()

    def _on_channel_closed(self) -> None:
        self._closed = True
        self.channel = None
        self.show_notice("终端进程已结束")
        self.closed.emit()

    # -- 滚动 --------------------------------------------------------------
    def _sync_scrollbar(self) -> None:
        lines = self.terminal.scrollback_lines()
        self.scrollbar.setRange(0, lines)
        self.scrollbar.setPageStep(max(1, self.terminal.rows - 1))
        if self.canvas.scroll_offset > lines:
            self.canvas.scroll_offset = lines
        self.scrollbar.blockSignals(True)
        self.scrollbar.setValue(self.canvas.scroll_offset)
        self.scrollbar.blockSignals(False)

    def _scroll_by(self, delta: int) -> None:
        value = max(0, min(self.scrollbar.maximum(), self.canvas.scroll_offset + delta))
        self.scrollbar.setValue(value)  # 触发 _on_scrolled → 同步到画布

    def _on_scrolled(self, value: int) -> None:
        self.canvas.scroll_offset = value
        self.canvas.update()

    def scroll_to_bottom(self) -> None:
        self.scrollbar.setValue(0)

    # -- 外观 --------------------------------------------------------------
    def set_theme(self, theme: Theme) -> None:
        self.canvas.set_theme(theme)

    def set_font(self, font: QFont) -> None:
        self.canvas.set_font(font)

    def _on_canvas_resized(self, cols: int, rows: int) -> None:
        self._sync_scrollbar()
        if self.channel is not None:
            self.channel.resize(cols, rows)
        self.resized.emit(cols, rows)
