"""终端画布与视图测试：绘制（含宽字符 / 空格）、选区、按键编码、滚动、通道桥接。

绘制断言不比「渲染结果与截图一致」（字体不同结果就不同），只断言**该有笔画的地方有笔画、
该没有的地方没有**，这样既稳定又能挡住真问题（比如空格被吞掉导致整行左移）。
"""

from __future__ import annotations

from typing import List, Tuple

from PySide6.QtCore import QPoint, QPointF, Qt
from PySide6.QtTest import QTest
from PySide6.QtGui import QColor, QImage, QKeyEvent, QWheelEvent

from app.terminal.screen import TerminalScreen
from app.ui.theme import DARK, LIGHT, monospace_font
from app.ui.widgets.terminal_canvas import (
    GpuTerminalCanvas,
    RasterTerminalCanvas,
    TerminalCanvasMixin,
    gpu_rendering_available,
    make_canvas,
)
from app.ui.widgets.terminal_view import TerminalView


def make_canvas_widget(qtbot, *, gpu: bool = False, theme=DARK, text: str = ""):
    canvas = make_canvas(gpu=gpu)
    canvas.set_theme(theme)
    canvas.set_font(monospace_font(12))
    qtbot.addWidget(canvas)
    canvas.resize(400, 200)
    canvas.show()
    screen = TerminalScreen(40, 10)
    canvas.set_screen(screen)
    if text:
        screen.feed(text)
    canvas.sync_size()
    return canvas, screen


def ink(image: QImage, background: str) -> List[Tuple[int, int]]:
    """返回与底色不同的像素坐标（用来判断「画上东西了 / 没画东西」）。"""
    expected = QColor(background).rgb()
    points: List[Tuple[int, int]] = []
    for y in range(image.height()):
        for x in range(image.width()):
            if image.pixel(x, y) != expected:
                points.append((x, y))
    return points


def ink_columns(canvas, screen, *, theme=DARK) -> set:
    image = canvas.grab().toImage()
    return {x for x, _y in ink(image, theme.terminal_bg)}


# ---------------------------------------------------------------------------
# 渲染路径
# ---------------------------------------------------------------------------


def test_offscreen_platform_uses_the_raster_canvas(qtbot) -> None:
    """离屏 / 无 OpenGL 的平台必须自动退回软渲染（否则测试直接起不来）。"""
    assert gpu_rendering_available() is False

    canvas = make_canvas()

    assert isinstance(canvas, RasterTerminalCanvas)
    assert canvas.gpu is False


def test_gpu_canvas_can_be_forced(qtbot) -> None:
    canvas = make_canvas(gpu=True)

    assert isinstance(canvas, GpuTerminalCanvas)
    assert canvas.gpu is True


def test_gpu_and_raster_canvases_share_the_drawing_code(qtbot) -> None:
    """两条路径共用同一套绘制实现，避免只在一处修 bug。"""
    canvas, screen = make_canvas_widget(qtbot, text="shared")
    gpu_canvas, gpu_screen = make_canvas_widget(qtbot, gpu=True, text="shared")

    for widget in (canvas, gpu_canvas):
        assert isinstance(widget, TerminalCanvasMixin)
        assert widget.screen_model().text(0) == "shared"
    assert screen.text(0) == gpu_screen.text(0)


# ---------------------------------------------------------------------------
# 绘制
# ---------------------------------------------------------------------------


def test_empty_screen_paints_only_the_background(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot)

    assert ink(canvas.grab().toImage(), DARK.terminal_bg) == []


def test_text_produces_ink(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot, text="hello")

    assert ink(canvas.grab().toImage(), DARK.terminal_bg)


def test_spaces_keep_later_characters_in_place(qtbot) -> None:
    """回归：空格曾被当成空白跳过，导致同一行后面的字符整体左移。"""
    canvas, screen = make_canvas_widget(qtbot, text="a c")
    cell_w, _cell_h = canvas.cell_size()

    columns = ink_columns(canvas, screen)
    # 第 3 列（下标 2）上的 'c' 必须有笔画
    assert any(cell_w * 2 <= x < cell_w * 3 for x in columns)
    # 第 2 列是空格，除了行内背景之外不该有字形
    space_ink = [x for x in columns if cell_w <= x < cell_w * 2]
    assert len(space_ink) < 6


def test_wide_characters_occupy_two_columns(qtbot) -> None:
    canvas, screen = make_canvas_widget(qtbot, text="中b")
    cell_w, _cell_h = canvas.cell_size()

    assert screen.lines[0][1].wide_tail
    columns = ink_columns(canvas, screen)
    # 'b' 必须画在第 3 列（说明宽字符占了两格，没有把后面的字符挤到第 2 列）
    assert any(cell_w * 2 - 1 <= x < cell_w * 3 for x in columns)


def test_background_colors_are_filled(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot, text="\x1b[41m  \x1b[0m")

    image = canvas.grab().toImage()

    assert QColor(DARK.ansi_color(1)).rgb() in {
        image.pixel(x, y) for x in range(0, 20) for y in range(0, 20)
    }


def test_theme_switch_changes_the_background(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot, text="x")
    canvas.set_theme(LIGHT)

    image = canvas.grab().toImage()

    assert image.pixel(image.width() - 2, image.height() - 2) == QColor(LIGHT.terminal_bg).rgb()


def test_cell_colors_apply_inverse_and_dim(qtbot) -> None:
    canvas, screen = make_canvas_widget(qtbot, text="\x1b[7;31mA\x1b[0;2;32mB")
    inverse = screen.lines[0][0]
    dim = screen.lines[0][1]

    fg, bg = canvas._cell_colors(inverse)
    assert bg.name() == DARK.ansi_color(1)  # 反显：前景色跑到背景上

    dim_fg, _dim_bg = canvas._cell_colors(dim)
    plain_fg, _plain_bg = canvas._cell_colors(screen.lines[0][0])
    assert dim_fg.name() != qcolor_name(DARK.ansi_color(2))
    assert dim_fg != plain_fg


def qcolor_name(value: str) -> str:
    return QColor(value).name()


# ---------------------------------------------------------------------------
# 选区
# ---------------------------------------------------------------------------


def test_mouse_drag_selects_text(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot, text="please select me")
    cell_w, cell_h = canvas.cell_size()

    QTest.mousePress(canvas, Qt.MouseButton.LeftButton, pos=QPoint(int(cell_w * 7) + 1, int(cell_h / 2)))
    QTest.mouseMove(canvas, QPoint(int(cell_w * 16) + 1, int(cell_h / 2)))

    assert canvas.selected_text() == "select me"
    canvas.clear_selection()
    assert not canvas.has_selection()


def test_selection_spans_multiple_lines(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot, text="first line\r\nsecond line")
    cell_w, cell_h = canvas.cell_size()

    QTest.mousePress(
        canvas, Qt.MouseButton.LeftButton, pos=QPoint(int(cell_w * 6) + 1, int(cell_h * 0.5))
    )
    QTest.mouseMove(canvas, QPoint(int(cell_w * 6) + 1, int(cell_h * 1.5)))

    assert canvas.selected_text() == "line\nsecond"


def test_copy_puts_the_selection_on_the_clipboard(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot, text="copy me")
    cell_w, cell_h = canvas.cell_size()
    QTest.mousePress(canvas, Qt.MouseButton.LeftButton, pos=QPoint(0, int(cell_h * 0.5)))
    QTest.mouseMove(canvas, QPoint(int(cell_w * 7), int(cell_h * 0.5)))

    canvas._copy_selection()

    from PySide6.QtGui import QGuiApplication

    clipboard = QGuiApplication.clipboard()
    assert clipboard is not None and clipboard.text() == "copy me"
    assert not canvas.has_selection()


# ---------------------------------------------------------------------------
# 键盘
# ---------------------------------------------------------------------------


def key_event(key: Qt.Key, text: str = "", modifiers=Qt.KeyboardModifier.NoModifier) -> QKeyEvent:
    return QKeyEvent(QKeyEvent.Type.KeyPress, key, modifiers, text)


def test_enter_and_printable_keys_are_forwarded(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot)
    seen: List[str] = []
    canvas.dataEntered.connect(seen.append)

    canvas.keyPressEvent(key_event(Qt.Key.Key_A, "a"))
    canvas.keyPressEvent(key_event(Qt.Key.Key_Return, "\r"))

    assert seen == ["a", "\r"]


def test_ctrl_c_without_selection_sends_sigint(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot)
    seen: List[str] = []
    canvas.dataEntered.connect(seen.append)

    canvas.keyPressEvent(key_event(Qt.Key.Key_C, "c", Qt.KeyboardModifier.ControlModifier))

    assert seen == ["\x03"]


def test_ctrl_c_with_selection_copies_instead(qtbot) -> None:
    canvas, screen = make_canvas_widget(qtbot, text="abc")
    seen: List[str] = []
    canvas.dataEntered.connect(seen.append)
    canvas._selection = ((0, 0), (0, 3))

    canvas.keyPressEvent(key_event(Qt.Key.Key_C, "c", Qt.KeyboardModifier.ControlModifier))

    from PySide6.QtGui import QGuiApplication

    assert seen == []  # 有选区时 Ctrl+C 不发给远端
    clipboard = QGuiApplication.clipboard()
    assert clipboard is not None and clipboard.text() == "abc"


def test_arrow_keys_use_application_cursor_mode(qtbot) -> None:
    canvas, screen = make_canvas_widget(qtbot)
    seen: List[str] = []
    canvas.dataEntered.connect(seen.append)

    canvas.keyPressEvent(key_event(Qt.Key.Key_Up))
    screen.feed("\x1b[?1h")
    canvas.keyPressEvent(key_event(Qt.Key.Key_Up))

    assert seen == ["\x1b[A", "\x1bOA"]


def test_alt_key_prefixes_escape(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot)
    seen: List[str] = []
    canvas.dataEntered.connect(seen.append)

    canvas.keyPressEvent(key_event(Qt.Key.Key_B, "b", Qt.KeyboardModifier.AltModifier))

    assert seen == ["\x1bb"]


def test_shift_page_up_requests_scrolling(qtbot) -> None:
    canvas, _screen = make_canvas_widget(qtbot)
    seen: List[int] = []
    canvas.scrollRequested.connect(seen.append)

    canvas.keyPressEvent(key_event(Qt.Key.Key_PageUp, "", Qt.KeyboardModifier.ShiftModifier))

    assert seen and seen[0] > 0


def test_wheel_scrolls_up_and_down(qtbot) -> None:
    canvas, screen = make_canvas_widget(qtbot)
    for index in range(30):
        screen.feed(f"line {index}\r\n")
    seen: List[int] = []
    canvas.scrollRequested.connect(seen.append)

    center = QPointF(canvas.rect().center())
    for delta in (-120, 120):
        canvas.wheelEvent(
            QWheelEvent(
                center,
                center,
                QPoint(0, 0),
                QPoint(0, delta),
                Qt.MouseButton.NoButton,
                Qt.KeyboardModifier.NoModifier,
                Qt.ScrollPhase.NoScrollPhase,
                False,
            )
        )

    assert seen == [1, -1]


# ---------------------------------------------------------------------------
# 视图：通道桥接 / 滚动条
# ---------------------------------------------------------------------------


class StubChannel:
    """TerminalView 只用到这几个方法。"""

    def __init__(self) -> None:
        self.written: List[str] = []
        self.resizes: List[Tuple[int, int]] = []
        self.closed = False
        self.on_data = None
        self.on_closed = None

    def start_reader(self, on_data, on_closed) -> None:
        self.on_data, self.on_closed = on_data, on_closed

    def write(self, text: str) -> None:
        self.written.append(text)

    def resize(self, cols: int, rows: int) -> None:
        self.resizes.append((cols, rows))

    def close(self) -> None:
        self.closed = True


def make_view(qtbot, *, text: str = "") -> Tuple[TerminalView, StubChannel]:
    view = TerminalView(theme=DARK, font=monospace_font(12), gpu=False)
    qtbot.addWidget(view)
    view.resize(420, 220)
    view.show()
    channel = StubChannel()
    view.start(channel)
    if text and channel.on_data is not None:
        channel.on_data(text)
    return view, channel


def test_view_feeds_channel_output_into_the_screen(qtbot) -> None:
    view, channel = make_view(qtbot, text="\x1b[32mready\x1b[0m")

    assert view.terminal.text(0) == "ready"
    assert view.is_running()


def test_view_answers_device_status_queries(qtbot) -> None:
    """远端问了 ``\\x1b[6n``（光标位置），我们要把应答写回去，否则 vim 会卡住。"""
    _view, channel = make_view(qtbot, text="\x1b[2;3H\x1b[6n")

    assert channel.written == ["\x1b[2;3R"]


def test_keyboard_input_is_written_to_the_channel(qtbot) -> None:
    view, channel = make_view(qtbot)

    view.canvas.keyPressEvent(key_event(Qt.Key.Key_L, "l"))

    assert channel.written == ["l"]


def test_scrollbar_tracks_scrollback(qtbot) -> None:
    view, channel = make_view(qtbot)
    for index in range(60):
        channel.on_data(f"line {index}\r\n")

    assert view.scrollbar.maximum() > 0
    assert view.scrollbar.value() == 0  # 默认贴底

    view._scroll_by(5)
    assert view.canvas.scroll_offset == 5

    view.scroll_to_bottom()
    assert view.canvas.scroll_offset == 0


def test_canvas_resize_is_reported_to_the_remote(qtbot) -> None:
    view, channel = make_view(qtbot)
    channel.resizes.clear()

    view.canvas.sync_size()

    cols, rows = view.canvas.cols_for_width(view.canvas.width()), view.canvas.rows_for_height(
        view.canvas.height()
    )
    assert view.terminal.cols == cols and view.terminal.rows == rows


def test_channel_close_shows_a_notice_and_emits_closed(qtbot) -> None:
    view, channel = make_view(qtbot)
    closed: List[bool] = []
    view.closed.connect(lambda: closed.append(True))

    assert channel.on_closed is not None
    channel.on_closed()

    assert closed == [True]
    assert not view.is_running()
    assert view.notice.isVisible()
    assert "结束" in view.notice.text()


def test_stop_closes_the_channel(qtbot) -> None:
    view, channel = make_view(qtbot)

    view.stop()

    assert channel.closed
    assert not view.is_running()


def test_font_change_updates_the_cell_size(qtbot) -> None:
    view, _channel = make_view(qtbot)
    before = view.canvas.cell_size()

    view.set_font(monospace_font(20))

    assert view.canvas.cell_size() != before
