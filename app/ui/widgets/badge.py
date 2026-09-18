"""列表项右侧的变更徽标（仿 VSCode 的装饰徽标）。

徽标是**画出来的图形**而不是文字后缀：一个填色的圆角方块加字母，位置固定在行的
右端，因此名称再长也不会把它挤掉，滚动时也对齐成一条竖线。

文件名文字本身**交给基类绘制**，本委托只把它的可用宽度收窄到徽标左侧
（:meth:`subElementRect` 覆写），再补画徽标。原因：基类在带样式表时会按索引数据
自行取文本，清空 ``option.text`` 并不能阻止它再画一遍，于是就出现「文件名画两遍、
笔画错位叠加」的花屏。让基类独占文字绘制，样式表下的颜色与选中态也才和未变更行一致。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import (
    QStyle,
    QStyledItemDelegate,
    QStyleOptionViewItem,
    QWidget,
)

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
        # 文件名 / 图标与选中底色全部交给基类（它只在 subElementRect 收窄后的区域内
        # 排版文字），本委托只额外补画右端的徽标
        super().paint(painter, option, index)
        letter = index.data(BADGE_ROLE)
        if not letter:
            return
        background = index.data(BADGE_COLOR_ROLE) or option.palette.color(QPalette.ColorRole.Text)
        if not isinstance(background, QColor):
            background = QColor(background)

        painter.save()
        badge_rect = self.badge_rect(option)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(background)
        painter.drawRoundedRect(badge_rect, 3.5, 3.5)
        font = QFont(option.font)
        font.setBold(True)
        font.setPointSizeF(max(6.0, font.pointSizeF() - 1.5))
        painter.setFont(font)
        painter.setPen(badge_text_color(background))
        painter.drawText(badge_rect, int(Qt.AlignmentFlag.AlignCenter), str(letter))
        painter.restore()

    def subElementRect(  # noqa: D102 - Qt 接口
        self, element: QStyle.SubElement, option: QStyleOptionViewItem, widget: Optional[QWidget] = None
    ) -> QRect:
        # 让基类把文件名排在徽标左侧，宽度不够时由基类自己打省略号，
        # 这样「文字被画两遍」和「长文件名钻到徽标底下」两个问题一起消失
        rect = super().subElementRect(element, option, widget)
        if element == QStyle.SubElement.SE_ItemViewItemText and option.index.data(BADGE_ROLE):
            rect.setRight(max(rect.left(), self.badge_rect(option).left() - 4))
        return rect

    def sizeHint(self, option, index) -> QSize:  # noqa: D102 - Qt 接口
        size = super().sizeHint(option, index)
        return QSize(size.width() + BADGE_SIZE + BADGE_MARGIN, size.height())
