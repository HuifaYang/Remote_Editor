"""列表项右侧的变更徽标（仿 VSCode 的装饰徽标）。

徽标是**画出来的图形**而不是文字后缀：一个填色的圆角方块加字母，位置固定在行的
右端，因此名称再长也不会把它挤掉，滚动时也对齐成一条竖线。

文件名文字本身**交给基类绘制**（带样式表时基类会按索引数据取文本，清空
``option.text`` 并不能阻止它再画一遍，于是出现「文件名画两遍、笔画错位叠加」的花屏），
本委托只补画右端的徽标；徽标是不透明的，长名称会由基类省略在行尾。

需要「文字可用区」时用 :meth:`text_rect`：矩形要向 ``QStyle`` 要
（``QStyledItemDelegate`` 上并没有 ``subElementRect``），右侧再让开徽标。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import (
    QApplication,
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
        # 文件名 / 图标与选中底色全部交给基类，本委托只额外补画右端的徽标
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

    def text_rect(self, option: QStyleOptionViewItem, widget: Optional[QWidget] = None) -> QRect:
        """基类给文字分配的矩形（让开图标），右侧再让开徽标。

        注意：文字矩形必须向 ``QStyle`` 要 —— ``QStyledItemDelegate`` 上没有
        ``subElementRect``（早先误写成 ``super().subElementRect``，异常被 Qt 吞掉，
        等于从没生效过）。
        """
        target = widget if widget is not None else option.widget
        style = target.style() if target is not None else None
        if style is None:
            app = QApplication.instance()
            style = app.style() if app is not None else None
        rect = (
            style.subElementRect(QStyle.SubElement.SE_ItemViewItemText, option, target)
            if style is not None
            else QRect(option.rect)
        )
        badge = option.index.data(BADGE_ROLE)
        if badge:
            rect.setRight(max(rect.left(), self.badge_rect(option).left() - 4))
        return rect

    def sizeHint(self, option, index) -> QSize:  # noqa: D102 - Qt 接口
        size = super().sizeHint(option, index)
        return QSize(size.width() + BADGE_SIZE + BADGE_MARGIN, size.height())
