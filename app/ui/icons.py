"""矢量图标：优先用 ``assets/ui-icons/`` 里的 Codicons SVG，加载失败回退 QPainter 手画。

Codicons 是 VSCode 官方图标集（CC-BY 4.0），16/24px 网格、描边粗细统一，
比手画线条工整得多 —— 这是界面「现代感」最直观的一块。所有 SVG 都是
``fill="currentColor"``，渲染前把 ``currentColor`` 换成主题色再交给 ``QtSvg``，
颜色因此可以跟随主题即时重建。某个图标没有对应 SVG（或 SVG 损坏 / 目录缺失）
时回退到下面的 QPainter 手画实现，不会让启动报错。
"""

from __future__ import annotations

from functools import lru_cache
from typing import Callable, Dict, List, Optional, Tuple

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QGuiApplication, QIcon, QPainter, QPainterPath, QPen, QPixmap

from app.utils.paths import resource_path

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


def _draw_minimize(painter: QPainter, color: QColor) -> None:
    """最小化：一条横线。"""
    painter.drawLine(QPointF(3.6, 8.0), QPointF(12.4, 8.0))


def _draw_maximize(painter: QPainter, color: QColor) -> None:
    """最大化：一个方框。"""
    painter.drawRoundedRect(QRectF(3.8, 3.8, 8.4, 8.4), 0.8, 0.8)


def _draw_restore(painter: QPainter, color: QColor) -> None:
    """还原：两个叠起来的方框。"""
    painter.drawRoundedRect(QRectF(3.0, 5.4, 7.6, 7.6), 0.8, 0.8)
    painter.drawPolyline(_polyline([(5.6, 5.4), (5.6, 3.0), (13.0, 3.0), (13.0, 10.4), (10.6, 10.4)]))


def _draw_plus(painter: QPainter, color: QColor) -> None:
    """新增：一个加号（远程资源管理器里「新增主机」）。"""
    painter.drawLine(QPointF(8.0, 3.4), QPointF(8.0, 12.6))
    painter.drawLine(QPointF(3.4, 8.0), QPointF(12.6, 8.0))


def _draw_download(painter: QPainter, color: QColor) -> None:
    """导入：向下的箭头 + 底部托盘（把 ~/.ssh/config 里的主机收进来）。"""
    painter.drawLine(QPointF(8.0, 3.0), QPointF(8.0, 10.2))
    painter.drawPolyline(_polyline([(4.8, 7.2), (8.0, 10.4), (11.2, 7.2)]))
    painter.drawPolyline(_polyline([(3.2, 11.6), (3.2, 13.2), (12.8, 13.2), (12.8, 11.6)]))


def _draw_trash(painter: QPainter, color: QColor) -> None:
    """删除：垃圾桶（右键菜单里删除主机 / 文件）。"""
    painter.drawLine(QPointF(2.8, 4.6), QPointF(13.2, 4.6))
    painter.drawPolyline(_polyline([(6.2, 4.4), (6.2, 2.8), (9.8, 2.8), (9.8, 4.4)]))
    painter.drawPolyline(
        _polyline([(3.8, 4.8), (4.6, 13.4), (11.4, 13.4), (12.2, 4.8)])
    )
    painter.drawLine(QPointF(6.6, 7.0), QPointF(6.9, 11.4))
    painter.drawLine(QPointF(9.4, 7.0), QPointF(9.1, 11.4))


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
    "minimize": _draw_minimize,
    "maximize": _draw_maximize,
    "restore": _draw_restore,
    "plus": _draw_plus,
    "download": _draw_download,
    "trash": _draw_trash,
}


#: 项目图标名 → ``assets/ui-icons/`` 里的 Codicon SVG 文件名（不含扩展名）。
#: 没列在这里的名字会回退到 ``DRAWERS`` 的手画实现。
_CODICON_MAP: Dict[str, str] = {
    "host": "remote",
    "disconnect": "debug-disconnect",
    "folder": "folder",
    "files": "files",
    "source-control": "source-control",
    "search": "search",
    "save": "save",
    "refresh": "refresh",
    "collapse": "collapse-all",
    "new-file": "new-file",
    "new-folder": "new-folder",
    "settings": "settings-gear",
    "history": "history",
    "close": "close",
    "minimize": "chrome-minimize",
    "maximize": "chrome-maximize",
    "restore": "chrome-restore",
    "plus": "add",
    "download": "cloud-download",
    "trash": "trash",
}

#: Codicon SVG 目录（缺失时整体回退手画）
_UI_ICON_DIR = "ui-icons"


@lru_cache(maxsize=1)
def _svg_dir_available() -> bool:
    try:
        return resource_path("assets", _UI_ICON_DIR).is_dir()
    except Exception:  # pragma: no cover - 打包路径异常时回退手画
        return False


def _render_svg_pixmap(name: str, color: QColor, size: int) -> Optional[QPixmap]:
    """用 ``QtSvg`` 渲染 Codicon SVG 并按 ``color`` 染色；失败返回 ``None``。

    把 SVG 文本里的 ``currentColor`` 换成目标色再渲染 —— QtSvg 不会把
    ``currentColor`` 解析成画笔颜色，直接染是最可靠的做法。
    """
    svg_name = _CODICON_MAP.get(name)
    if not svg_name or not _svg_dir_available():
        return None
    # QtSvg / QPixmap 在没有 QApplication 时会 abort，先判空
    if QGuiApplication.instance() is None:
        return None
    try:
        from PySide6.QtSvg import QSvgRenderer
    except Exception:  # pragma: no cover - 极少数环境缺 QtSvg 模块
        return None
    svg_path = resource_path("assets", _UI_ICON_DIR, f"{svg_name}.svg")
    try:
        raw = svg_path.read_text(encoding="utf-8")
    except OSError:
        return None
    tinted = raw.replace("currentColor", color.name())
    renderer = QSvgRenderer(tinted.encode("utf-8"))
    if not renderer.isValid():
        return None
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    renderer.render(painter)
    painter.end()
    return pixmap


def render_pixmap(name: str, color: QColor, size: int) -> QPixmap:
    # 优先用 Codicons SVG（工整），加载不到再回退 QPainter 手画
    svg = _render_svg_pixmap(name, color, size)
    if svg is not None:
        return svg
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
