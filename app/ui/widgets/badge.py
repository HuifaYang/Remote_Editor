"""列表项右侧的变更徽标（仿 VSCode 的装饰徽标）。

徽标是**画出来的图形**而不是文字后缀：一个填色的圆角方块加字母，位置固定在行的
右端，因此名称再长也不会把它挤掉，滚动时也对齐成一条竖线。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import QStyledItemDelegate, QStyleOptionViewItem, QWidget

#: 徽标字母（``U``/``A``/``M``/``D``/``R``/``!``）
BADGE_ROLE = Qt.ItemDataRole.UserRole + 40
#: 徽标填充色（``QColor``，由主题决定）
BADGE_COLOR_ROLE = Qt.ItemDataRole.UserRole + 41

BADGE_SIZE = 15
BADGE_MARGIN = 6


def badge_text_color(background: QColor) -> QColor:
    """按背景亮度选黑或白字，保证黄底上的字母也看得清。"""
    luminance = (
        0.299 * background.redF() + 0.587 * background.greenF() + 0.114 * background.blueF()
    )
    return QColor("#1f1f1f") if luminance > 0.6 else QColor("#ffffff")


class BadgeDelegate(QStyledItemDelegate):
    """在行的右端绘制变更徽标；没有徽标的行完全走默认绘制。"""

    def __init__(self, parent: Optional[QWidget] = None, *, size: int = BADGE_SIZE) -> None:
        super().__init__(parent)
        self._size = size

    def badge_rect(self, option: QStyleOptionViewItem) -> QRect:
        rect = option.rect
        top = rect.center().y() - self._size // 2 + 1
        return QRect(rect.right() - self._size - BADGE_MARGIN, top, self._size, self._size)

    def paint(self, painter, option, index) -> None:  # noqa: D102 - Qt 接口
        letter = index.data(BADGE_ROLE)
        if not letter:
            super().paint(painter, option, index)
            return

        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        text = opt.text
        # 先让基类只画背景（选中 / 悬停底色），文本与图标由我们自己排版，
        # 否则长文件名会钻到徽标底下
        opt.text = ""
        super().paint(painter, opt, index)

        painter.save()
        badge_rect = self.badge_rect(option)
        text_left = option.rect.left() + 2
        if not opt.icon.isNull():
            icon_size = option.decorationSize
            opt.icon.paint(
                painter,
                QRect(
                    text_left,
                    option.rect.center().y() - icon_size.height() // 2,
                    icon_size.width(),
                    icon_size.height(),
                ),
            )
            text_left += icon_size.width() + 4
        text_rect = QRect(
            text_left,
            option.rect.top(),
            max(0, badge_rect.left() - 4 - text_left),
            option.rect.height(),
        )
        colour = opt.palette.color(QPalette.ColorRole.Text)
        painter.setPen(colour)
        painter.drawText(
            text_rect,
            int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter),
            option.fontMetrics.elidedText(str(text), Qt.TextElideMode.ElideMiddle, text_rect.width()),
        )

        background = index.data(BADGE_COLOR_ROLE) or colour
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(background if isinstance(background, QColor) else QColor(background))
        painter.drawRoundedRect(badge_rect, 3.5, 3.5)
        font = QFont(option.font)
        font.setBold(True)
        font.setPointSizeF(max(6.0, font.pointSizeF() - 1.5))
        painter.setFont(font)
        painter.setPen(badge_text_color(background if isinstance(background, QColor) else QColor(background)))
        painter.drawText(badge_rect, int(Qt.AlignmentFlag.AlignCenter), str(letter))
        painter.restore()

    def sizeHint(self, option, index) -> QSize:  # noqa: D102 - Qt 接口
        size = super().sizeHint(option, index)
        return QSize(size.width() + BADGE_SIZE + BADGE_MARGIN, size.height())
