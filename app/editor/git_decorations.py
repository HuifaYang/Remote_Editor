"""Git Gutter 标记的样式与绘制。

颜色来自 :class:`app.ui.theme.Theme`，本模块不硬编码任何颜色值。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

from PySide6.QtCore import QPoint, QRect
from PySide6.QtGui import QColor, QPainter

from app.git.models import ChangeType
from app.ui.theme import Theme

BAR_WIDTH = 3
DELETED_TRIANGLE_WIDTH = 8
DELETED_TRIANGLE_HEIGHT = 5


@dataclass(frozen=True)
class DecorationStyle:
    """三类变更的显示样式。"""

    added: QColor
    modified: QColor
    deleted: QColor
    bar_width: int = BAR_WIDTH
    dim: float = 0.75

    @classmethod
    def from_theme(cls, theme: Theme) -> "DecorationStyle":
        return cls(
            added=theme.color("marker_added"),
            modified=theme.color("marker_modified"),
            deleted=theme.color("marker_deleted"),
        )

    def color_for(self, change: ChangeType) -> QColor:
        if change is ChangeType.ADDED:
            return self.added
        if change is ChangeType.MODIFIED:
            return self.modified
        return self.deleted


class GitGutterDecorator:
    """保存当前文件的标记表，并负责在 gutter 中绘制出来。"""

    def __init__(self, style: Optional[DecorationStyle] = None) -> None:
        self.style = style or DecorationStyle(
            added=QColor("#2ea043"), modified=QColor("#d29922"), deleted=QColor("#d1242f")
        )
        self._markers: Dict[int, ChangeType] = {}

    # -- 数据 --------------------------------------------------------------
    def set_style(self, style: DecorationStyle) -> None:
        self.style = style

    def set_markers(self, markers: Optional[Dict[int, ChangeType]]) -> None:
        self._markers = dict(markers or {})

    def clear(self) -> None:
        self._markers.clear()

    @property
    def markers(self) -> Dict[int, ChangeType]:
        return dict(self._markers)

    @property
    def has_markers(self) -> bool:
        return bool(self._markers)

    def change_for_line(self, line: int) -> Optional[ChangeType]:
        return self._markers.get(line)

    def counts(self) -> Dict[ChangeType, int]:
        counts = {ChangeType.ADDED: 0, ChangeType.MODIFIED: 0, ChangeType.DELETED: 0}
        for change in self._markers.values():
            counts[change] += 1
        return counts

    # -- 绘制 --------------------------------------------------------------
    def paint_line(self, painter: QPainter, rect: QRect, change: Optional[ChangeType]) -> None:
        """在 ``rect``（单个可见行的 gutter 矩形）中绘制标记。"""
        if change is None or rect.height() <= 0:
            return
        color = self.style.color_for(change)
        left = rect.x()
        width = self.style.bar_width

        if change is ChangeType.ADDED:
            painter.fillRect(left, rect.y(), width, rect.height(), color)
            return

        if change is ChangeType.MODIFIED:
            height = max(int(rect.height() * self.style.dim), 2)
            painter.fillRect(left, rect.y() + rect.height() - height, width, height, color)
            faded = QColor(color)
            faded.setAlpha(90)
            painter.fillRect(left, rect.y(), width, rect.height() - height, faded)
            return

        # DELETED：在行的下边缘画一个向下的三角形，提示「此处有删除」
        triangle_width = min(max(width + DELETED_TRIANGLE_WIDTH, 8), max(rect.width(), 8))
        top = rect.y() + rect.height() - DELETED_TRIANGLE_HEIGHT
        painter.setBrush(color)
        painter.setPen(color)
        painter.drawPolygon(
            [
                QPoint(left, top),
                QPoint(left + triangle_width, top),
                QPoint(left, rect.y() + rect.height()),
            ]
        )

    @staticmethod
    def tooltip(change: ChangeType) -> str:
        return f"Git: {change.label}"
