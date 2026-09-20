"""Gutter 点击弹出的「与上一版差异」内联预览（仿 VSCode 的 Peek Diff）。

点行号槽里的变更标记时弹出，浮在编辑器对应行的下方：红底列出被删 / 被改的
旧文本，绿底列出新文本。再次点击 gutter、按 Esc、或切换标签时关闭。

数据来自 :class:`app.git.models.HunkDetail`（diff 解析时已把旧 / 新文本记下来，
不需要再发远端请求）。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QFont, QTextCharFormat, QTextCursor
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from app.git.models import HunkDetail
from app.ui.icons import make_icon
from app.ui.theme import Theme


class _DiffText(QPlainTextEdit):
    """只读、无滚动条包裹的 diff 文本区（行级着底）。"""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setReadOnly(True)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.setSizeAdjustPolicy(QPlainTextEdit.SizeAdjustPolicy.AdjustToContents)

    def set_lines(self, removed, added, theme: Theme) -> None:
        """按行着底：删行红、增行绿（颜色经主题 + 透明度合成，不硬编码）。"""
        self.clear()
        cursor = self.textCursor()
        removed_bg = _tint(theme.color("marker_deleted"), theme.color("editor_bg"), 0.18)
        added_bg = _tint(theme.color("marker_added"), theme.color("editor_bg"), 0.18)
        fg = theme.color("editor_fg")

        def append(lines, prefix, bg) -> None:
            for line in lines:
                fmt = QTextCharFormat()
                fmt.setBackground(bg)
                fmt.setForeground(fg)
                cursor.insertText(f"{prefix} {line}\n", fmt)

        append(removed, "-", removed_bg)
        append(added, "+", added_bg)
        # 去掉末尾多出来的换行
        cursor.movePosition(QTextCursor.MoveOperation.End)
        cursor.deletePreviousChar()
        self.setTextCursor(QTextCursor(self.document()))


def _tint(color: QColor, base: QColor, ratio: float) -> QColor:
    """把 ``color`` 按 ``ratio`` 叠到 ``base`` 上，得到柔和的着底色。"""
    return QColor(
        round(color.red() * ratio + base.red() * (1 - ratio)),
        round(color.green() * ratio + base.green() * (1 - ratio)),
        round(color.blue() * ratio + base.blue() * (1 - ratio)),
    )


class PeekDiffView(QFrame):
    """浮动 diff 预览面板。"""

    closeRequested = Signal()

    def __init__(self, theme: Theme, font: QFont, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("peek_diff")
        self._theme = theme

        self.header = QLabel("", self)
        self.header.setObjectName("peek_diff_title")
        self.close_button = QToolButton(self)
        self.close_button.setAutoRaise(True)
        self.close_button.setToolTip("关闭（Esc）")
        self.close_button.setIcon(make_icon("close", theme.color("gutter_fg")))
        self.close_button.clicked.connect(self.closeRequested)

        header_row = QHBoxLayout()
        header_row.setContentsMargins(10, 4, 6, 4)
        header_row.setSpacing(6)
        header_row.addWidget(self.header, 1)
        header_row.addWidget(self.close_button)

        self.diff_text = _DiffText(self)
        self.diff_text.setFont(font)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addLayout(header_row)
        layout.addWidget(self.diff_text)

    def keyPressEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        if event.key() == Qt.Key.Key_Escape:
            self.closeRequested.emit()
            return
        super().keyPressEvent(event)

    def show_hunk(self, hunk: HunkDetail, path: str) -> None:
        """填充一个变更块并显示。"""
        name = path.rsplit("/", 1)[-1] or path
        self.header.setText(f"{name} · 第 {hunk.start_line} 行的改动")
        self.diff_text.set_lines(hunk.removed, hunk.added, self._theme)
        self.adjustSize()
        self.show()
