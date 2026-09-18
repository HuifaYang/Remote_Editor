"""终端内核测试：转义序列解释、网格、回滚、宽字符、SGR 颜色。

这一层是纯 Python（不碰 Qt），所以可以对「远端真的会发什么」逐条断言 ——
``bash`` 的提示符、``ls`` 的着色、``vim`` 切备用屏幕，都在这层锁住。
"""

from __future__ import annotations

from app.terminal.keys import control_char, encode_key
from app.terminal.screen import (
    ATTR_BOLD,
    ATTR_INVERSE,
    ATTR_UNDERLINE,
    TerminalScreen,
    cell_width,
    color_256,
)

# ---------------------------------------------------------------------------
# 写入与光标
# ---------------------------------------------------------------------------


def test_plain_text_wraps_and_lf_moves_down() -> None:
    screen = TerminalScreen(10, 3)
    screen.feed("hello\r\nworld")

    assert screen.text(0) == "hello"
    assert screen.text(1) == "world"
    assert (screen.cursor_x, screen.cursor_y) == (5, 1)


def test_carriage_return_and_tab() -> None:
    screen = TerminalScreen(20, 2)
    screen.feed("abc\rX\tY")

    assert screen.text(0) == "Xbc     Y"  # \t 跳到下一个 8 的倍数
    assert screen.cursor_x == 9


def test_autowrap_can_be_disabled() -> None:
    screen = TerminalScreen(5, 2)
    screen.feed("\x1b[?7l")
    screen.feed("abcdefgh")

    assert screen.text(0) == "abcdh"  # 不换行，最后一格被反复覆盖
    assert screen.text(1) == ""


def test_writing_past_the_last_line_scrolls_into_history() -> None:
    screen = TerminalScreen(10, 2)
    screen.feed("a\r\nb\r\nc\r\nd")

    assert screen.text(0) == "c"
    assert screen.text(1) == "d"
    assert screen.scrollback_lines() == 2
    assert screen.scrollback_text() == "a\nb"


def test_scrollback_limit_is_enforced() -> None:
    screen = TerminalScreen(10, 2, scrollback=3)
    for index in range(10):
        screen.feed(f"{index}\r\n")

    assert screen.scrollback_lines() == 3
    assert screen.scrollback_text().splitlines() == ["6", "7", "8"]


# ---------------------------------------------------------------------------
# CSI：定位 / 擦除 / 插入删除
# ---------------------------------------------------------------------------


def test_cursor_positioning_is_one_based() -> None:
    screen = TerminalScreen(10, 4)
    screen.feed("\x1b[3;4HX")

    assert screen.text(2) == "   X"
    assert (screen.cursor_x, screen.cursor_y) == (4, 2)


def test_erase_display_and_line() -> None:
    screen = TerminalScreen(10, 3)
    screen.feed("aaaa\r\nbbbb\r\ncccc")
    screen.feed("\x1b[2;2H\x1b[K")  # 擦掉第 2 行光标右侧
    assert screen.text(1) == "b"
    screen.feed("\x1b[2J")  # 全屏清空
    assert screen.all_text().strip() == ""


def test_erase_display_before_cursor_keeps_rest() -> None:
    screen = TerminalScreen(10, 2)
    screen.feed("abcdef\x1b[1;4H\x1b[1J")

    assert screen.text(0) == "    ef"  # 光标格本身也被擦掉


def test_insert_and_delete_characters() -> None:
    screen = TerminalScreen(10, 2)
    screen.feed("abcdef\x1b[1;1H\x1b[2P")
    assert screen.text(0) == "cdef"

    screen.feed("\x1b[2J\x1b[Habcdef\x1b[1;1H\x1b[2@")
    assert screen.text(0) == "  abcdef"


def test_insert_and_delete_lines_inside_scroll_region() -> None:
    screen = TerminalScreen(10, 4)
    screen.feed("1\r\n2\r\n3\r\n4")
    screen.feed("\x1b[2;1H\x1b[L")  # 在第 2 行插入空行，区域内最后一行被挤出
    assert [screen.text(row) for row in range(4)] == ["1", "", "2", "3"]

    screen.feed("\x1b[2;1H\x1b[M")  # 删掉一行，行尾补空行
    assert [screen.text(row) for row in range(4)] == ["1", "2", "3", ""]


def test_scroll_region_confines_line_feeds() -> None:
    screen = TerminalScreen(10, 5)
    screen.feed("1\r\n2\r\n3\r\n4\r\n5")
    screen.feed("\x1b[2;3r")  # 只在第 2~3 行滚动
    screen.feed("\x1b[3;1H\r\nX")

    # 只有区域内的 "2"/"3" 滚动：3 上移到第 2 行，其余行不受影响
    assert [screen.text(row) for row in range(5)] == ["1", "3", "X", "4", "5"]


def test_scroll_up_and_down_commands() -> None:
    screen = TerminalScreen(10, 3)
    screen.feed("a\r\nb\r\nc\x1b[1S")
    assert [screen.text(row) for row in range(3)] == ["b", "c", ""]
    screen.feed("\x1b[1T")
    assert [screen.text(row) for row in range(3)] == ["", "b", "c"]


def test_cursor_up_down_left_right_and_home_end() -> None:
    screen = TerminalScreen(10, 4)
    screen.feed("\x1b[3;3H\x1b[2A\x1b[2D")
    assert (screen.cursor_x, screen.cursor_y) == (0, 0)
    screen.feed("\x1b[B\x1b[C")
    assert (screen.cursor_x, screen.cursor_y) == (1, 1)
    screen.feed("\x1b[5G\x1b[4d")
    assert (screen.cursor_x, screen.cursor_y) == (4, 3)
    screen.feed("\x1b[H")
    assert (screen.cursor_x, screen.cursor_y) == (0, 0)


def test_save_and_restore_cursor_including_attributes() -> None:
    screen = TerminalScreen(10, 3)
    screen.feed("\x1b[1;31m\x1b[2;3H\x1b[s")
    screen.feed("\x1b[0m\x1b[1;1HXX")
    screen.feed("\x1b[uA")

    assert (screen.cursor_x, screen.cursor_y) == (3, 1)
    assert screen.lines[1][2].fg == 1  # 颜色也恢复了
    assert screen.text(0) == "XX"


# ---------------------------------------------------------------------------
# SGR
# ---------------------------------------------------------------------------


def test_sgr_basic_colors_and_attributes() -> None:
    screen = TerminalScreen(20, 2)
    screen.feed("\x1b[1;4;31;44mX\x1b[0mY")

    cell = screen.lines[0][0]
    assert cell.fg == 1
    assert cell.bg == 4
    assert cell.attrs & ATTR_BOLD
    assert cell.attrs & ATTR_UNDERLINE
    plain = screen.lines[0][1]
    assert plain.fg is None and plain.bg is None and plain.attrs == 0


def test_sgr_bright_and_256_and_truecolor() -> None:
    screen = TerminalScreen(20, 2)
    screen.feed("\x1b[91mA\x1b[38;5;208mB\x1b[38;2;10;20;30mC")

    assert screen.lines[0][0].fg == 9
    assert screen.lines[0][1].fg == 208
    assert screen.lines[0][2].fg == (10, 20, 30)


def test_sgr_inverse_flag_is_recorded() -> None:
    screen = TerminalScreen(10, 2)
    screen.feed("\x1b[7mX\x1b[27mY")

    assert screen.lines[0][0].attrs & ATTR_INVERSE
    assert not screen.lines[0][1].attrs & ATTR_INVERSE


def test_color_256_cube_and_grayscale() -> None:
    assert color_256(16) == (0, 0, 0)
    assert color_256(196) == (255, 0, 0)
    assert color_256(232) == (8, 8, 8)
    assert color_256(255) == (238, 238, 238)
    assert color_256(3) is None  # 0-15 交给主题调色板


# ---------------------------------------------------------------------------
# 宽字符 / 备用屏幕 / 杂项
# ---------------------------------------------------------------------------


def test_wide_characters_take_two_columns() -> None:
    screen = TerminalScreen(10, 2)
    screen.feed("中文abc")

    assert screen.text(0) == "中文abc"
    assert screen.cursor_x == 7
    assert screen.lines[0][1].wide_tail  # 第二个格子是右半格
    assert cell_width("中") == 2 and cell_width("a") == 1


def test_wide_character_at_the_last_column_wraps() -> None:
    screen = TerminalScreen(5, 2)
    screen.feed("abcd中")

    assert screen.text(0) == "abcd"
    assert screen.text(1) == "中"


def test_alternate_screen_keeps_the_primary_buffer() -> None:
    screen = TerminalScreen(10, 3)
    screen.feed("primary")
    screen.feed("\x1b[?1049h")
    assert screen.alternate_screen
    screen.feed("\x1b[2J\x1b[Hvimmode")

    assert screen.text(0) == "vimmode"
    screen.feed("\x1b[?1049l")
    assert not screen.alternate_screen
    assert screen.text(0) == "primary"
    assert screen.scrollback_lines() == 0  # 备用屏幕的内容不回滚


def test_cursor_visibility_and_application_cursor_keys_flags() -> None:
    screen = TerminalScreen(10, 2)
    assert screen.cursor_visible and not screen.application_cursor_keys

    screen.feed("\x1b[?25l\x1b[?1h\x1b[?2004h")
    assert not screen.cursor_visible
    assert screen.application_cursor_keys
    assert screen.bracketed_paste


def test_osc_sequences_are_swallowed() -> None:
    screen = TerminalScreen(20, 2)
    screen.feed("\x1b]0;窗口标题\x07ok\x1b]8;;http://example.com\x07link\x1b]8;;\x07")

    assert screen.text(0) == "oklink"


def test_dcs_and_charset_sequences_are_swallowed() -> None:
    screen = TerminalScreen(20, 2)
    screen.feed("a\x1bP1$r0m\x1b\\b\x1b(Bc")

    assert screen.text(0) == "abc"


def test_device_status_report_answers_are_queued() -> None:
    screen = TerminalScreen(10, 3)
    screen.feed("\x1b[2;3H")
    screen.feed("\x1b[6n")

    assert screen.take_replies() == "\x1b[2;3R"
    assert screen.take_replies() == ""  # 取走即清空


def test_resize_keeps_content_and_clears_scroll_region() -> None:
    screen = TerminalScreen(20, 5)
    screen.feed("keep me\r\nsecond\x1b[2;4r")
    screen.resize(10, 3)

    assert screen.cols == 10 and screen.rows == 3
    assert screen.text(0) == "keep me"
    assert screen.text(1) == "second"
    assert (screen.scroll_top, screen.scroll_bottom) == (0, 2)


def test_reset_clears_everything() -> None:
    screen = TerminalScreen(10, 3)
    screen.feed("text\x1b[1;31m")
    screen.feed("\x1bc")

    assert screen.all_text().strip() == ""
    assert screen.fg is None and screen.attrs == 0


def test_viewport_offsets_into_scrollback() -> None:
    screen = TerminalScreen(10, 2)
    screen.feed("a\r\nb\r\nc\r\nd")
    def line_text(cells) -> str:
        return "".join(cell.char for cell in cells).rstrip()

    assert [line_text(line) for line in screen.viewport(1)] == ["b", "c"]
    assert [line_text(line) for line in screen.viewport(2)] == ["a", "b"]


def test_revision_advances_on_writes() -> None:
    screen = TerminalScreen(10, 2)
    before = screen.revision
    screen.feed("x")

    assert screen.revision > before


def test_control_char_mapping_and_key_encoding() -> None:
    assert control_char("c") == "\x03"
    assert control_char(" ") == "\x00"
    assert control_char("1") == ""

    assert encode_key("up") == "\x1b[A"
    assert encode_key("up", app_cursor=True) == "\x1bOA"
    assert encode_key("f5") == "\x1b[15~"
    assert encode_key("enter") == "\r"
    assert encode_key("tab", shift=True) == "\x1b[Z"
    assert encode_key("char", "c", ctrl=True) == "\x03"
    assert encode_key("char", "x", alt=True) == "\x1bx"
