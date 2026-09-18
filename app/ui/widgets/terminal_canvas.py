"""终端画布：把 :class:`~app.terminal.screen.TerminalScreen` 的字符网格画出来。

渲染策略（用户要求「强渲染能力、GPU 渲染」）：

* **GPU 路径**：有真实窗口系统时用 ``QOpenGLWidget``（Qt 的 OpenGL 绘制引擎，
  真正的 GPU 合成），字符绘制仍是 QPainter 调用，但光栅化与合成都走显卡；
* **软渲染路径**：离屏 / 无 OpenGL 的平台（headless 测试、``QT_QPA_PLATFORM=offscreen``）
  自动退回普通 ``QWidget``，两条路径共用同一份绘制代码，行为一致；
* **少调用**：相邻同色同属性的格子合并成一段字符串一次绘制；背景色合并成矩形填充；
  只有宽字符（CJK）单独绘制，保证列对齐不被字距影响。

画布只负责「显示 + 输入转义序列」，不碰网络：数据由 :class:`TerminalView` 灌进来。
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional, Tuple

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontMetricsF,
    QGuiApplication,
    QKeyEvent,
    QMouseEvent,
    QPainter,
    QPaintEvent,
    QWheelEvent,
)
from PySide6.QtWidgets import QWidget

from app.terminal import keys as terminal_keys
from app.terminal.screen import (
    ATTR_BOLD,
    ATTR_DIM,
    ATTR_INVERSE,
    ATTR_UNDERLINE,
    Cell,
    Color,
    TerminalScreen,
    cell_width,
    color_256,
)
from app.ui.theme import Theme

try:  # PySide6 自带，不算新增依赖
    from PySide6.QtOpenGLWidgets import QOpenGLWidget
except ImportError:  # pragma: no cover - PySide6 一定带，防御性
    QOpenGLWidget = None  # type: ignore[assignment]

#: 光标闪烁周期（VSCode 用 530ms）
CURSOR_BLINK_MS = 530
#: 强制软渲染（排查显卡驱动问题时用）
NO_GPU_ENV = "REMOTE_EDITOR_NO_GPU"
#: 这些平台没有可用的 OpenGL 上下文，直接用软渲染
_SOFTWARE_PLATFORMS = {"offscreen", "minimal", "vnc", "webgl"}


def gpu_rendering_available() -> bool:
    """当前环境能不能用 QOpenGLWidget（离屏测试与无 GL 平台返回 ``False``）。"""
    if QOpenGLWidget is None or os.environ.get(NO_GPU_ENV):
        return False
    app = QGuiApplication.instance()
    if app is None:
        return False
    return app.platformName().lower() not in _SOFTWARE_PLATFORMS


class TerminalCanvasMixin:
    """两条渲染路径共用的绘制 / 交互实现。

    刻意不继承 ``QWidget``（否则和 ``QOpenGLWidget`` 的 MRO 打架），
    所以自己不声明信号：``dataEntered`` / ``sizeChanged`` / ``scrollRequested``
    由两个具体画布类声明，属性访问在运行期自然解析到宿主类上。
    """

    # -- 初始化 ------------------------------------------------------------
    def _init_terminal_state(self) -> None:
        self._theme: Optional[Theme] = None
        self._font = QFont()
        self._bold_font = QFont()
        self._cell_w = 8.0
        self._cell_h = 16.0
        self._ascent = 12.0
        self._color_cache: Dict[object, QColor] = {}
        self.scroll_offset = 0
        self._selection: Optional[Tuple[Tuple[int, int], Tuple[int, int]]] = None
        self._selecting = False
        self._cursor_on = True
        self._blink = QTimer(self)
        self._blink.setInterval(CURSOR_BLINK_MS)
        self._blink.timeout.connect(self._toggle_cursor)
        self._blink.start()
        self._screen: Optional[TerminalScreen] = None
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self.setCursor(Qt.CursorShape.IBeamCursor)
        self.setMouseTracking(True)

    # -- 数据 --------------------------------------------------------------
    def set_screen(self, screen: TerminalScreen) -> None:
        self._screen = screen
        self.update()

    def screen_model(self) -> Optional[TerminalScreen]:
        """当前屏幕模型（不叫 ``screen()``：那是 QWidget 自己的方法）。"""
        return self._screen

    def set_theme(self, theme: Theme) -> None:
        self._theme = theme
        self._color_cache.clear()
        self.update()

    def set_font(self, font: QFont) -> None:
        """设置等宽字体并重算单元格尺寸（列 / 行数由控件大小反推）。"""
        self._font = QFont(font)
        self._font.setFixedPitch(True)
        self._bold_font = QFont(self._font)
        self._bold_font.setBold(True)
        metrics = QFontMetricsF(self._font)
        self._cell_w = max(1.0, metrics.horizontalAdvance("M"))
        self._cell_h = max(1.0, metrics.height())
        self._ascent = metrics.ascent()
        self._enforce_size()

    def sync_size(self) -> None:
        """按当前控件尺寸重新计算列 / 行数（控件刚显示出来时调用）。"""
        self._enforce_size()

    def cell_size(self) -> Tuple[float, float]:
        return self._cell_w, self._cell_h

    def cols_for_width(self, width: int) -> int:
        return max(2, int(width // self._cell_w))

    def rows_for_height(self, height: int) -> int:
        return max(2, int(height // self._cell_h))

    def _enforce_size(self) -> None:
        """把控件尺寸换算成网格尺寸（拖窗口 / 改字号都要走这里）。"""
        screen = self._screen
        if screen is None:
            return
        cols = self.cols_for_width(self.width())
        rows = self.rows_for_height(self.height())
        if cols != screen.cols or rows != screen.rows:
            screen.resize(cols, rows)
            self.sizeChanged.emit(cols, rows)
        self.update()

    def sizeHint(self):  # noqa: D102 - 供布局使用
        from PySide6.QtCore import QSize

        return QSize(int(self._cell_w * 80), int(self._cell_h * 24))

    def resizeEvent(self, event) -> None:  # noqa: D102 - Qt 接口
        super().resizeEvent(event)
        self._enforce_size()

    # -- 点击 / 选择 -------------------------------------------------------
    def cell_at(self, position: QPoint) -> Optional[Tuple[int, int]]:
        """控件坐标 → ``(显示行号, 列号)``；超出内容区返回 ``None``。"""
        screen = self._screen
        if screen is None:
            return None
        row = int(position.y() // self._cell_h)
        col = int(position.x() // self._cell_w)
        col = max(0, min(screen.cols - 1, col))
        if not 0 <= row < self.rows_for_height(self.height()):
            return None
        return row, col

    def _absolute_line(self, display_row: int) -> int:
        """显示行号 → 「history + lines」里的绝对行号（选择要跟着滚动走）。"""
        screen = self._screen
        if screen is None:
            return 0
        return len(screen.history) - self.scroll_offset + display_row

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: D102 - Qt 接口
        if event.button() == Qt.MouseButton.LeftButton:
            cell = self.cell_at(event.position().toPoint())
            if cell is not None:
                anchor = (self._absolute_line(cell[0]), cell[1])
                self._selection = (anchor, anchor)
                self._selecting = True
                self.update()
        self.setFocus(Qt.FocusReason.MouseFocusReason)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: D102 - Qt 接口
        if not self._selecting or self._selection is None:
            return
        cell = self.cell_at(event.position().toPoint())
        if cell is None:
            return
        self._selection = (self._selection[0], (self._absolute_line(cell[0]), cell[1]))
        self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: D102 - Qt 接口
        self._selecting = False

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: D102 - Qt 接口
        self._selection = None
        self.update()

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: D102 - Qt 接口
        steps = event.angleDelta().y() / 120.0
        if steps:
            self.scrollRequested.emit(int(-steps))

    def has_selection(self) -> bool:
        return self._selection is not None and self._selection[0] != self._selection[1]

    def clear_selection(self) -> None:
        self._selection = None
        self.update()

    def selected_text(self) -> str:
        """选中区域的文本（跨行用 ``\\n`` 连接，行尾空白去掉）。"""
        screen = self._screen
        selection = self._selection
        if screen is None or selection is None:
            return ""
        (start_line, start_col), (end_line, end_col) = selection
        if (start_line, start_col) > (end_line, end_col):
            start_line, start_col, end_line, end_col = end_line, end_col, start_line, start_col
        buffer = screen.history + screen.lines
        rows: List[str] = []
        for line_index in range(start_line, end_line + 1):
            if not 0 <= line_index < len(buffer):
                continue
            line = buffer[line_index]
            first = start_col if line_index == start_line else 0
            last = end_col if line_index == end_line else len(line) - 1
            text = "".join(cell.char for cell in line[first : last + 1])
            rows.append(text.rstrip())
        return "\n".join(rows)

    # -- 光标闪烁 ----------------------------------------------------------
    def _toggle_cursor(self) -> None:
        if self._screen is None or not self._screen.cursor_visible:
            return
        self._cursor_on = not self._cursor_on
        self.update()

    # -- 绘制 --------------------------------------------------------------
    def _palette_color(self, spec: Color) -> QColor:
        cached = self._color_cache.get(spec)
        if cached is not None:
            return cached
        theme = self._theme
        color = QColor(theme.terminal_fg if theme else "#cccccc")
        if isinstance(spec, tuple):
            color = QColor(*spec)
        elif isinstance(spec, int):
            if 0 <= spec <= 15 and theme is not None:
                color = QColor(theme.ansi_color(spec))
            else:
                rgb = color_256(spec)
                if rgb is not None:
                    color = QColor(*rgb)
        self._color_cache[spec] = color
        return color

    def _cell_colors(self, cell: Cell) -> Tuple[QColor, QColor]:
        theme = self._theme
        bg = QColor(theme.terminal_bg if theme else "#1f1f1f")
        fg = QColor(theme.terminal_fg if theme else "#cccccc")
        if cell.bg is not None:
            bg = self._palette_color(cell.bg)
        if cell.fg is not None:
            fg = self._palette_color(cell.fg)
        if cell.attrs & ATTR_INVERSE:
            bg, fg = fg, bg
        if cell.attrs & ATTR_DIM:
            fg = QColor(
                (fg.red() + bg.red()) // 2, (fg.green() + bg.green()) // 2, (fg.blue() + bg.blue()) // 2
            )
        return fg, bg

    def _viewport(self, offset: Optional[int] = None) -> List[List[Cell]]:
        screen = self._screen
        if screen is None:
            return []
        return screen.viewport(self.scroll_offset if offset is None else offset)

    def _paint(self, painter: QPainter) -> None:
        screen = self._screen
        theme = self._theme
        base_bg = QColor(theme.terminal_bg if theme else "#1f1f1f")
        painter.fillRect(self.rect(), base_bg)
        if screen is None:
            return
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        painter.setFont(self._font)
        rows = self._viewport()
        selection_color = QColor(theme.terminal_selection if theme else "#264f78")
        base_line = len(screen.history) - self.scroll_offset

        for row_index, line in enumerate(rows):
            if row_index >= self.rows_for_height(self.height()):
                break
            self._paint_row_backgrounds(
                painter, line, base_line + row_index, row_index, selection_color
            )
            self._paint_row_text(painter, line, row_index)

        self._paint_cursor(painter, screen, base_line)

    def _paint_row_backgrounds(
        self,
        painter: QPainter,
        line: List[Cell],
        absolute_line: int,
        row_index: int,
        selection_color: QColor,
    ) -> None:
        """背景：合并同色的连续格子成一次 ``fillRect``（刷屏时能省掉大量调用）。"""
        span = self._selection_columns(absolute_line)
        empty = self._empty_color()
        y = row_index * self._cell_h
        run_start = 0
        run_color: Optional[QColor] = None
        for index in range(len(line) + 1):
            color: Optional[QColor] = None
            if index < len(line):
                cell = line[index]
                if not cell.wide_tail:
                    _fg, cell_bg = self._cell_colors(cell)
                    if cell_bg != empty:
                        color = cell_bg
            if span is not None and span[0] <= index <= span[1]:
                color = selection_color
            if index == len(line) or color != run_color:
                if run_color is not None and run_color != empty:
                    painter.fillRect(
                        QRectF(
                            run_start * self._cell_w,
                            y,
                            (index - run_start) * self._cell_w,
                            self._cell_h,
                        ),
                        run_color,
                    )
                run_start, run_color = index, color

    def _empty_color(self) -> QColor:
        return QColor(self._theme.terminal_bg if self._theme else "#1f1f1f")

    def _paint_row_text(self, painter: QPainter, line: List[Cell], row_index: int) -> None:
        """文本：同色同属性的连续格子拼成一个字符串一次绘制（空格也要进字符串，

        否则后面的字符会左移 —— 终端里空格是**占位**的，不能当空白丢掉）。
        """
        y = row_index * self._cell_h + self._ascent
        run_start = 0
        run_text: List[str] = []
        run_fg: Optional[QColor] = None
        run_attrs = 0

        def flush(end_index: int) -> None:
            nonlocal run_start, run_text, run_fg, run_attrs
            text = "".join(run_text)
            leading = len(text) - len(text.lstrip(" "))
            if text.strip() and run_fg is not None:
                painter.setFont(self._bold_font if run_attrs & ATTR_BOLD else self._font)
                painter.setPen(run_fg)
                painter.drawText(
                    QPointF((run_start + leading) * self._cell_w, y), text.lstrip(" ")
                )
                if run_attrs & ATTR_UNDERLINE:
                    painter.drawLine(
                        QPointF((run_start + leading) * self._cell_w, y + 1.5),
                        QPointF(end_index * self._cell_w, y + 1.5),
                    )
            run_start = end_index
            run_text = []
            run_fg = None
            run_attrs = 0

        index = 0
        while index < len(line):
            cell = line[index]
            if cell.wide_tail:
                index += 1
                continue
            alloc = cell_width(cell.char[0]) if cell.char else 1
            if alloc == 2:
                flush(index)
                fg, _bg = self._cell_colors(cell)
                painter.setFont(self._bold_font if cell.attrs & ATTR_BOLD else self._font)
                painter.setPen(fg)
                painter.drawText(QPointF(index * self._cell_w, y), cell.char)
                index += 2
                run_start = index
                continue
            fg, _bg = self._cell_colors(cell)
            if run_fg != fg or run_attrs != cell.attrs:
                flush(index)
                run_fg, run_attrs = fg, cell.attrs
            if not run_text:
                run_start = index
            run_text.append(cell.char or " ")
            index += 1
        flush(len(line))

    def _selection_columns(self, absolute_line: int) -> Optional[Tuple[int, int]]:
        selection = self._selection
        if selection is None:
            return None
        (start_line, start_col), (end_line, end_col) = selection
        if (start_line, start_col) > (end_line, end_col):
            start_line, start_col, end_line, end_col = end_line, end_col, start_line, start_col
        if not start_line <= absolute_line <= end_line:
            return None
        first = start_col if absolute_line == start_line else 0
        last = end_col if absolute_line == end_line else 10_000
        return first, last

    def _paint_cursor(self, painter: QPainter, screen: TerminalScreen, base_line: int) -> None:
        if (
            not screen.cursor_visible
            or self.scroll_offset
            or not self._cursor_on
            or not self.hasFocus()
        ):
            return
        row = screen.cursor_y
        col = screen.cursor_x
        if not 0 <= row < len(screen.lines) or not 0 <= col < screen.cols:
            return
        theme = self._theme
        color = QColor(theme.terminal_cursor if theme else "#ffffff")
        rect = QRectF(col * self._cell_w, row * self._cell_h, self._cell_w, self._cell_h)
        painter.fillRect(rect, color)
        cell = screen.lines[row][col]
        if cell.char and not cell.wide_tail and cell.char.strip():
            painter.setPen(QColor(theme.terminal_bg if theme else "#1f1f1f"))
            painter.setFont(self._bold_font if cell.attrs & ATTR_BOLD else self._font)
            painter.drawText(QPointF(col * self._cell_w, row * self._cell_h + self._ascent), cell.char)

    # -- 键盘 --------------------------------------------------------------
    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: D102 - Qt 接口
        modifiers = event.modifiers()
        ctrl = bool(modifiers & Qt.KeyboardModifier.ControlModifier)
        alt = bool(modifiers & Qt.KeyboardModifier.AltModifier)
        shift = bool(modifiers & Qt.KeyboardModifier.ShiftModifier)
        try:  # PySide 有时返回 Qt.Key 枚举，有时只给 int
            name = Qt.Key(event.key()).name
        except ValueError:  # pragma: no cover - 未知键位
            name = ""
        text = event.text()
        clip = QGuiApplication.clipboard()

        if ctrl and shift and name == "Key_C":
            self._copy_selection()
            return
        if ctrl and shift and name == "Key_V":
            self._paste(clip.text() if clip else "")
            return
        if ctrl and not shift and name == "Key_C" and self.has_selection():
            self._copy_selection()
            return
        if name == "Key_PageUp" and shift:
            self.scrollRequested.emit(self.rows_for_height(self.height()) - 1)
            return
        if name == "Key_PageDown" and shift:
            self.scrollRequested.emit(-(self.rows_for_height(self.height()) - 1))
            return

        key = terminal_keys.QT_KEY_NAMES.get(name)
        if key is None:
            key = "char" if text else ""
        if key == "char" and ctrl:
            control = terminal_keys.control_char(text)
            if not control:
                return
            text = control
        sequence = terminal_keys.encode_key(
            key,
            text,
            ctrl=ctrl,
            alt=alt,
            shift=shift,
            app_cursor=bool(self._screen and self._screen.application_cursor_keys),
        )
        if sequence:
            self.dataEntered.emit(sequence)

    def _copy_selection(self) -> None:
        text = self.selected_text()
        if text:
            clipboard = QGuiApplication.clipboard()
            if clipboard is not None:
                clipboard.setText(text)
        self.clear_selection()

    def _paste(self, text: str) -> None:
        if not text:
            return
        screen = self._screen
        if screen is not None and screen.bracketed_paste:
            text = "\x1b[200~" + text + "\x1b[201~"
        self.dataEntered.emit(text)


class RasterTerminalCanvas(TerminalCanvasMixin, QWidget):
    """:class:`QWidget` 版画布（离屏 / 无 OpenGL 时使用，绘制代码与 GPU 版完全一致）。"""

    dataEntered = Signal(str)
    sizeChanged = Signal(int, int)
    scrollRequested = Signal(int)

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._init_terminal_state()

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: D102 - Qt 接口
        painter = QPainter(self)
        self._paint(painter)
        painter.end()


if QOpenGLWidget is not None:

    class GpuTerminalCanvas(TerminalCanvasMixin, QOpenGLWidget):  # type: ignore[misc]
        """:class:`QOpenGLWidget` 版画布：绘制走 OpenGL（GPU 合成）。"""

        dataEntered = Signal(str)
        sizeChanged = Signal(int, int)
        scrollRequested = Signal(int)

        def __init__(self, parent: Optional[QWidget] = None) -> None:
            super().__init__(parent)
            self._init_terminal_state()

        def paintGL(self) -> None:  # noqa: D102 - Qt 接口
            painter = QPainter(self)
            self._paint(painter)
            painter.end()

else:  # pragma: no cover - 防御性分支

    class GpuTerminalCanvas(TerminalCanvasMixin, QWidget):  # type: ignore[no-redef]
        """OpenGL 不可用时的同名兜底，保证导入方不需要判空。"""

        dataEntered = Signal(str)
        sizeChanged = Signal(int, int)
        scrollRequested = Signal(int)

        def __init__(self, parent: Optional[QWidget] = None) -> None:
            super().__init__(parent)
            self._init_terminal_state()

        def paintEvent(self, event: QPaintEvent) -> None:  # noqa: D102
            painter = QPainter(self)
            self._paint(painter)
            painter.end()


def make_canvas(parent: Optional[QWidget] = None, *, gpu: Optional[bool] = None) -> TerminalCanvasMixin:
    """按环境挑画布实现；``gpu`` 可显式指定（测试用）。"""
    use_gpu = gpu_rendering_available() if gpu is None else gpu
    canvas_class = GpuTerminalCanvas if use_gpu else RasterTerminalCanvas
    canvas = canvas_class(parent)
    canvas.gpu = use_gpu
    return canvas
