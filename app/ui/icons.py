"""矢量图标：用 QPainter 现画 16×16 单色线条图标。

刻意不引入图标字体或 SVG 资源：一来打包时不需要额外的 Qt 模块，二来没有第三方
图标集的许可问题，三来颜色可以跟随主题即时重建（仿 VSCode Codicon 的风格：
16px 网格、1.3px 描边、圆角端点，未激活灰、激活亮）。
"""

from __future__ import annotations

from typing import Callable, Dict, List, Tuple

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QIcon, QPainter, QPainterPath, QPen, QPixmap

#: 图标逻辑坐标（所有绘制函数都只用 0..16 这个空间）
VIEWBOX = 16.0
STROKE = 1.3

Points = List[Tuple[float, float]]


def _polyline(points: Points) -> List[QPointF]:
    """折线的点序列（``QPainter.drawPolyline`` 只接受点，不接受 QPainterPath）。"""
    return [QPointF(x, y) for x, y in points]


def _dot(painter: QPainter, color: QColor, x: float, y: float, radius: float = 1.0) -> None:
    painter.save()
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(color)
    painter.drawEllipse(QPointF(x, y), radius, radius)
    painter.restore()


def _draw_host(painter: QPainter, color: QColor) -> None:
    """主机 / 连接：两层机架。"""
    painter.drawRoundedRect(QRectF(2.6, 2.6, 10.8, 4.6), 1.0, 1.0)
    painter.drawRoundedRect(QRectF(2.6, 8.8, 10.8, 4.6), 1.0, 1.0)
    _dot(painter, color, 4.8, 4.9, 0.85)
    _dot(painter, color, 4.8, 11.1, 0.85)


def _draw_disconnect(painter: QPainter, color: QColor) -> None:
    _draw_host(painter, color)
    painter.drawLine(QPointF(12.4, 12.4), QPointF(15.0, 15.0))


def _draw_folder(painter: QPainter, color: QColor) -> None:
    painter.drawPolyline(
        _polyline(
            [(2.2, 4.4), (6.1, 4.4), (7.4, 6.2), (13.8, 6.2), (13.8, 13.0), (2.2, 13.0), (2.2, 4.4)]
        )
    )


def _draw_files(painter: QPainter, color: QColor) -> None:
    """资源管理器：前后两张纸。"""
    painter.drawPolyline(_polyline([(5.4, 2.6), (13.6, 2.6), (13.6, 11.0)]))
    painter.drawRoundedRect(QRectF(2.4, 5.0, 8.4, 8.4), 1.0, 1.0)
    painter.drawLine(QPointF(4.6, 8.0), QPointF(8.6, 8.0))
    painter.drawLine(QPointF(4.6, 10.4), QPointF(8.6, 10.4))


def _draw_source_control(painter: QPainter, color: QColor) -> None:
    """源代码管理：分支上的三个提交点。"""
    painter.drawLine(QPointF(4.6, 5.4), QPointF(4.6, 10.6))
    path = QPainterPath(QPointF(4.6, 7.4))
    path.cubicTo(QPointF(4.6, 9.6), QPointF(8.0, 7.6), QPointF(11.4, 8.6))
    painter.drawPath(path)
    painter.drawEllipse(QPointF(4.6, 3.4), 1.8, 1.8)
    painter.drawEllipse(QPointF(4.6, 12.6), 1.8, 1.8)
    painter.drawEllipse(QPointF(11.4, 10.4), 1.8, 1.8)


def _draw_search(painter: QPainter, color: QColor) -> None:
    painter.drawEllipse(QPointF(7.0, 7.0), 4.4, 4.4)
    painter.drawLine(QPointF(10.3, 10.3), QPointF(13.8, 13.8))


def _draw_save(painter: QPainter, color: QColor) -> None:
    painter.drawPolyline(
        _polyline([(3.0, 2.6), (10.8, 2.6), (13.4, 5.2), (13.4, 13.4), (3.0, 13.4), (3.0, 2.6)])
    )
    painter.drawRect(QRectF(5.6, 2.6, 4.4, 3.6))
    painter.drawRect(QRectF(5.2, 9.4, 5.6, 4.0))


def _draw_refresh(painter: QPainter, color: QColor) -> None:
    path = QPainterPath()
    path.arcMoveTo(QRectF(3.0, 3.0, 10.0, 10.0), 60.0)
    path.arcTo(QRectF(3.0, 3.0, 10.0, 10.0), 60.0, 265.0)
    painter.drawPath(path)
    painter.drawPolyline(_polyline([(9.2, 2.2), (11.6, 2.6), (11.0, 5.0)]))


def _draw_collapse(painter: QPainter, color: QColor) -> None:
    """全部折叠：两个向上的折角（与 VSCode 的 collapse-all 同形）。"""
    painter.drawPolyline(_polyline([(4.4, 7.6), (8.0, 4.4), (11.6, 7.6)]))
    painter.drawPolyline(_polyline([(4.4, 12.0), (8.0, 8.8), (11.6, 12.0)]))


def _draw_new_file(painter: QPainter, color: QColor) -> None:
    painter.drawPolyline(
        _polyline([(3.0, 2.6), (9.0, 2.6), (12.4, 6.0), (12.4, 13.4), (3.0, 13.4), (3.0, 2.6)])
    )
    painter.drawPolyline(_polyline([(8.8, 2.8), (8.8, 6.2), (12.2, 6.2)]))
    painter.drawLine(QPointF(6.0, 9.4), QPointF(9.6, 9.4))
    painter.drawLine(QPointF(7.8, 7.6), QPointF(7.8, 11.2))


def _draw_new_folder(painter: QPainter, color: QColor) -> None:
    painter.drawPolyline(
        _polyline(
            [(2.2, 4.4), (6.1, 4.4), (7.4, 6.2), (13.8, 6.2), (13.8, 13.0), (2.2, 13.0), (2.2, 4.4)]
        )
    )
    painter.drawLine(QPointF(8.0, 8.2), QPointF(8.0, 11.6))
    painter.drawLine(QPointF(6.3, 9.9), QPointF(9.7, 9.9))


def _draw_settings(painter: QPainter, color: QColor) -> None:
    """设置：滑杆（比齿轮简单，同样一眼可读）。"""
    for y, knob in ((4.6, 6.2), (8.0, 10.2), (11.4, 5.4)):
        painter.drawLine(QPointF(2.8, y), QPointF(13.2, y))
        painter.save()
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(color)
        painter.drawEllipse(QPointF(knob, y), 1.7, 1.7)
        painter.restore()


def _draw_history(painter: QPainter, color: QColor) -> None:
    """历史 / 上游对比：时钟加回转箭头。"""
    painter.drawEllipse(QPointF(8.0, 8.4), 5.0, 5.0)
    painter.drawLine(QPointF(8.0, 5.4), QPointF(8.0, 8.6))
    painter.drawLine(QPointF(8.0, 8.6), QPointF(10.6, 10.0))


def _draw_close(painter: QPainter, color: QColor) -> None:
    """关闭：两条交叉线（Qt 自带的关闭图形是红色的，和 VSCode 风格不搭）。"""
    painter.drawLine(QPointF(4.6, 4.6), QPointF(11.4, 11.4))
    painter.drawLine(QPointF(11.4, 4.6), QPointF(4.6, 11.4))


DRAWERS: Dict[str, Callable[[QPainter, QColor], None]] = {
    "host": _draw_host,
    "disconnect": _draw_disconnect,
    "folder": _draw_folder,
    "files": _draw_files,
    "source-control": _draw_source_control,
    "search": _draw_search,
    "save": _draw_save,
    "refresh": _draw_refresh,
    "collapse": _draw_collapse,
    "new-file": _draw_new_file,
    "new-folder": _draw_new_folder,
    "settings": _draw_settings,
    "history": _draw_history,
    "close": _draw_close,
}


def render_pixmap(name: str, color: QColor, size: int) -> QPixmap:
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    drawer = DRAWERS.get(name)
    if drawer is None:  # pragma: no cover - 图标名写错时不要崩，画个空位
        return pixmap
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    painter.scale(size / VIEWBOX, size / VIEWBOX)
    pen = QPen(color, STROKE)
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    painter.setPen(pen)
    painter.setBrush(Qt.BrushStyle.NoBrush)
    drawer(painter, color)
    painter.end()
    return pixmap


def make_icon(name: str, color: QColor, *, size: int = 16) -> QIcon:
    """生成图标；同时提供 2 倍图，高 DPI 下不糊。"""
    icon = QIcon()
    icon.addPixmap(render_pixmap(name, color, size))
    icon.addPixmap(render_pixmap(name, color, size * 2))
    return icon


def icon_names() -> Tuple[str, ...]:
    return tuple(DRAWERS)
