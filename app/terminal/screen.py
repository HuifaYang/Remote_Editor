"""VT100 / xterm 终端屏幕模型：字符网格 + 转义序列解释器。

只实现**真正会用到**的那部分（远端跑 ``bash`` / ``vim`` / ``htop`` / ``top`` 够用），
刻意不做完整 xterm 兼容：

* 光标移动 / 定位 / 保存恢复、插入删除行、擦除（ED / EL / ECH / DCH / ICH）；
* SGR（加粗 / 暗淡 / 斜体 / 下划线 / 反显 / 8·16·256 色 / 真彩）；
* 滚动区域（DECSTBM）与 IND / RI / SU / SD；
* 备用屏幕（``?1049``，vim / less 用）、光标显隐（``?25``）、自动换行（``?7``）；
* 宽字符（CJK 占两格）与增量 UTF-8 解码后的码点流；
* OSC 序列整体丢弃（标题、超链接），DCS 丢弃到 ST。

**不**实现：鼠标上报、括号粘贴的回显、DEC 字符集重映射（只吞掉序列）、
块状图形字符（``░`` 之类按普通宽字符处理，等宽字体里能正常显示）。

颜色用三种取值表示，避免与 Qt 耦合：``None`` = 默认色，``int`` = 调色板下标
（0-255），``(r, g, b)`` = 真彩。渲染层负责查表。
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Union

Color = Union[None, int, Tuple[int, int, int]]

#: 单元格属性位
ATTR_BOLD = 1
ATTR_DIM = 2
ATTR_ITALIC = 4
ATTR_UNDERLINE = 8
ATTR_INVERSE = 16

#: 默认回滚行数上限（约 5000 行 ≈ 每行 80 格时几 MB，够用又不失控）
DEFAULT_SCROLLBACK = 5000

#: CSI 参数上限，防止 ``\x1b[999999999C`` 之类把光标推到天上去
_PARAM_LIMIT = 100_000


@dataclass
class Cell:
    """一个字符格。``wide_tail`` 表示它是宽字符的右半格（不单独绘制）。"""

    char: str = " "
    fg: Color = None
    bg: Color = None
    attrs: int = 0
    wide_tail: bool = False

    def copy(self) -> "Cell":
        return Cell(self.char, self.fg, self.bg, self.attrs, self.wide_tail)


def cell_width(char: str) -> int:
    """字符占几格（东亚宽 / 全角字符占两格）。"""
    if unicodedata.east_asian_width(char) in ("W", "F"):
        return 2
    if unicodedata.combining(char):
        return 0
    return 1


class TerminalScreen:
    """一块字符网格 + 一个转义序列状态机。"""

    def __init__(self, cols: int = 80, rows: int = 24, scrollback: int = DEFAULT_SCROLLBACK) -> None:
        self.cols = max(2, int(cols))
        self.rows = max(2, int(rows))
        self.scrollback_limit = max(0, int(scrollback))
        self.history: List[List[Cell]] = []
        self.lines: List[List[Cell]] = []
        self.cursor_x = 0
        self.cursor_y = 0
        self.cursor_visible = True
        self.autowrap = True
        self.application_cursor_keys = False
        self.bracketed_paste = False
        self.scroll_top = 0
        self.scroll_bottom = self.rows - 1
        self.fg: Color = None
        self.bg: Color = None
        self.attrs = 0
        self.title = ""
        #: 需要回写给远端的内容（DSR / DA 的应答），由调用方取走后清空
        self.replies: List[str] = []
        #: 内容变化计数：渲染层用它判断要不要重绘（比逐格比较便宜）
        self.revision = 0
        self._saved: List[Tuple[int, int, Color, Color, int]] = []
        self._alt_saved: Optional[Tuple[List[List[Cell]], int, int]] = None
        self._state = "normal"
        self._csi = ""
        self._string_escaped = False
        self.reset()

    # -- 生命周期 ----------------------------------------------------------
    def reset(self) -> None:
        self.fg = None
        self.bg = None
        self.attrs = 0
        self.cursor_x = 0
        self.cursor_y = 0
        self.cursor_visible = True
        self.autowrap = True
        self.scroll_top = 0
        self.scroll_bottom = self.rows - 1
        self.lines = [self.blank_line() for _ in range(self.rows)]
        self._state = "normal"
        self._csi = ""
        self.revision += 1

    def resize(self, cols: int, rows: int) -> None:
        """改变网格尺寸：保留左上角内容（远端的 SIGWINCH 会自己重画）。"""
        cols, rows = max(2, int(cols)), max(2, int(rows))
        if cols == self.cols and rows == self.rows:
            return
        self.cols, self.rows = cols, rows
        for index, line in enumerate(self.lines):
            self.lines[index] = self._fit_line(line)
        if len(self.lines) > rows:
            self.lines = self.lines[:rows]
        while len(self.lines) < rows:
            self.lines.append(self.blank_line())
        self.cursor_x = min(self.cursor_x, cols - 1)
        self.cursor_y = min(self.cursor_y, rows - 1)
        self.scroll_top = 0
        self.scroll_bottom = rows - 1
        self.revision += 1

    def blank_line(self) -> List[Cell]:
        return [Cell() for _ in range(self.cols)]

    def _fit_line(self, line: List[Cell]) -> List[Cell]:
        if len(line) > self.cols:
            return line[: self.cols]
        return line + [Cell() for _ in range(self.cols - len(line))]

    # -- 读取（渲染 / 测试用） ---------------------------------------------
    def line(self, row: int) -> List[Cell]:
        """取可见区第 ``row`` 行（0 = 视口顶行）。"""
        if 0 <= row < len(self.lines):
            return self.lines[row]
        return self.blank_line()

    def text(self, row: int) -> str:
        """某一行去掉尾部空格的纯文本（测试用）。"""
        return "".join(cell.char for cell in self.line(row)).rstrip()

    def all_text(self) -> str:
        return "\n".join(self.text(row) for row in range(self.rows))

    def scrollback_lines(self) -> int:
        return len(self.history)

    # -- 输入 --------------------------------------------------------------
    def feed(self, data: str) -> None:
        """喂入**已解码**的文本（解码由调用方用增量解码器完成）。"""
        for char in data:
            self._feed_char(char)

    def _feed_char(self, char: str) -> None:
        state = self._state
        if state == "normal":
            self._handle_normal(char)
        elif state == "esc":
            self._handle_esc(char)
        elif state == "csi":
            self._handle_csi(char)
        elif state == "osc":
            self._handle_string(char, terminator="\x07")
        elif state == "dcs":
            self._handle_string(char, terminator=None)
        else:  # charset：吞掉字符集选择符，不做 G0/G1 重映射
            self._state = "normal"

    # -- 状态机 ------------------------------------------------------------
    def _handle_normal(self, char: str) -> None:
        if char == "\x1b":
            self._state = "esc"
            return
        code = ord(char)
        if code < 0x20 or code == 0x7F:
            self._control(code)
            return
        self.put_char(char)

    def _handle_esc(self, char: str) -> None:
        self._state = "normal"
        if char == "[":
            self._state = "csi"
            self._csi = ""
        elif char == "]":
            self._state = "osc"
        elif char in ("P", "^", "_"):
            self._state = "dcs"
        elif char in ("(", ")", "*", "+", "-", ".", "/"):
            self._state = "charset"
        elif char == "7":
            self._save_cursor()
        elif char == "8":
            self._restore_cursor()
        elif char == "D":
            self._index()
        elif char == "M":
            self._reverse_index()
        elif char == "E":
            self._index()
            self.cursor_x = 0
        elif char == "c":
            self.history.clear()
            self.reset()
        elif char in "=>78":
            pass  # 键盘小键盘模式 / 对齐测试，忽略

    def _handle_csi(self, char: str) -> None:
        if char == "\x1b":
            self._state = "esc"
            return
        code = ord(char)
        if 0x20 <= code <= 0x3F:  # 参数字节与中间字节
            self._csi += char
            return
        self._state = "normal"
        self._dispatch_csi(char)

    def _handle_string(self, char: str, *, terminator: Optional[str]) -> None:
        """OSC / DCS：整段丢弃。OSC 用 BEL 或 ST 结束，DCS 只认 ST。"""
        if terminator and char == terminator:
            self._state = "normal"
            self._string_escaped = False
            return
        if char == "\x1b":
            self._string_escaped = True
            return
        if self._string_escaped:
            self._string_escaped = False
            if char == "\\":
                self._state = "normal"
            return
        if self._state == "osc" and terminator is None:  # pragma: no cover - 防御
            self._state = "normal"

    # -- C0 控制符 ---------------------------------------------------------
    def _control(self, code: int) -> None:
        if code in (0x0A, 0x0B, 0x0C):  # LF / VT / FF
            self._index()
            if not self.autowrap and self.cursor_x > self.cols - 1:  # pragma: no cover
                self.cursor_x = self.cols - 1
        elif code == 0x0D:  # CR
            self.cursor_x = 0
        elif code == 0x08:  # BS
            self.cursor_x = max(0, self.cursor_x - 1)
        elif code == 0x09:  # TAB：跳到下一个 8 的倍数
            self.cursor_x = min(self.cols - 1, (self.cursor_x // 8 + 1) * 8)
        elif code == 0x07:  # BEL
            self.replies.append("\x07")

    # -- 字符写入 ----------------------------------------------------------
    def put_char(self, char: str) -> None:
        width = cell_width(char)
        if width == 0:  # 组合字符：并到前一格
            if self.cursor_x > 0:
                previous = self.lines[self.cursor_y][self.cursor_x - 1]
                previous.char += char
                self.revision += 1
            return
        if width == 2 and self.cursor_x == self.cols - 1:
            if self.autowrap:
                self._wrap()
            else:
                self.cursor_x = self.cols - 2
        if self.cursor_x >= self.cols:
            if self.autowrap:
                self._wrap()
            else:  # 不自动换行：停在最后一格，后续字符原地覆盖
                self.cursor_x = self.cols - 1
        line = self.lines[self.cursor_y]
        line[self.cursor_x] = Cell(char, self.fg, self.bg, self.attrs)
        if width == 2:
            line[self.cursor_x + 1] = Cell("", self.fg, self.bg, self.attrs, wide_tail=True)
        self.cursor_x += width
        if self.cursor_x >= self.cols:
            # 自动换行的「延迟折行」：光标停在最后一格右侧，写下一个字符才换行
            self.cursor_x = self.cols if self.autowrap else self.cols - 1
        self.revision += 1

    def _wrap(self) -> None:
        self.cursor_x = 0
        self._index()

    # -- 滚动 --------------------------------------------------------------
    def _index(self) -> None:
        """下移一行，到底就滚动（LF 的语义）。"""
        if self.cursor_y == self.scroll_bottom:
            self._scroll_up(1)
        else:
            self.cursor_y = min(self.rows - 1, self.cursor_y + 1)
            self.revision += 1

    def _reverse_index(self) -> None:
        if self.cursor_y == self.scroll_top:
            self._scroll_down(1)
        else:
            self.cursor_y = max(0, self.cursor_y - 1)
            self.revision += 1

    def _scroll_up(self, count: int) -> None:
        """区域内内容整体上移：顶部行进入回滚区（仅当区域从第 0 行开始）。"""
        for _ in range(count):
            line = self.lines.pop(self.scroll_top)
            self.lines.insert(self.scroll_bottom, self.blank_line())
            if self.scroll_top == 0 and self._alt_saved is None:
                self.history.append(line)
                if self.scrollback_limit and len(self.history) > self.scrollback_limit:
                    del self.history[: len(self.history) - self.scrollback_limit]
        self.revision += 1

    def _scroll_down(self, count: int) -> None:
        for _ in range(count):
            self.lines.pop(self.scroll_bottom)
            self.lines.insert(self.scroll_top, self.blank_line())
        self.revision += 1

    # -- CSI 分发 ----------------------------------------------------------
    def _dispatch_csi(self, final: str) -> None:
        raw = self._csi
        self._csi = ""
        private = ""
        while raw[:1] in ("?", "<", "=", ">"):
            private += raw[0]
            raw = raw[1:]
        params = self._parse_params(raw)
        if final == "m":
            self._sgr(params)
            return
        first = params[0] if params else 0

        if final == "A":
            self.cursor_y = max(self.scroll_top, self.cursor_y - max(1, first))
        elif final == "B":
            self.cursor_y = min(self.scroll_bottom, self.cursor_y + max(1, first))
        elif final in ("C", "a"):
            self.cursor_x = min(self.cols - 1, self.cursor_x + max(1, first))
        elif final == "D":
            self.cursor_x = max(0, self.cursor_x - max(1, first))
        elif final == "E":
            self.cursor_y = min(self.scroll_bottom, self.cursor_y + max(1, first))
            self.cursor_x = 0
        elif final == "F":
            self.cursor_y = max(self.scroll_top, self.cursor_y - max(1, first))
            self.cursor_x = 0
        elif final in ("G", "`"):
            self.cursor_x = self._clamp_col(first - 1)
        elif final in ("d",):
            self.cursor_y = self._clamp_row(first - 1)
        elif final in ("H", "f"):
            row = params[0] if params else 1
            col = params[1] if len(params) > 1 else 1
            self.cursor_y = self._clamp_row(row - 1)
            self.cursor_x = self._clamp_col(col - 1)
        elif final == "J":
            self._erase_display(first)
        elif final == "K":
            self._erase_line(first)
        elif final == "X":
            self._erase_chars(max(1, first))
        elif final == "P":
            self._delete_chars(max(1, first))
        elif final == "@":
            self._insert_chars(max(1, first))
        elif final == "L":
            self._insert_lines(max(1, first))
        elif final == "M":
            self._delete_lines(max(1, first))
        elif final == "S":
            self._scroll_up(max(1, first))
        elif final == "T":
            self._scroll_down(max(1, first))
        elif final == "r":
            top = (params[0] if params else 1) - 1
            bottom = (params[1] if len(params) > 1 else self.rows) - 1
            self._set_scroll_region(top, bottom)
        elif final in ("h", "l"):
            self._set_mode(private, params, enable=(final == "h"))
        elif final == "n":
            self._device_status(first)
        elif final == "c":
            self.replies.append("\x1b[?62;1;6c")  # 声明自己是 VT220 级别
        elif final == "s":
            self._save_cursor()
        elif final == "u":
            self._restore_cursor()
        self.revision += 1

    def _parse_params(self, raw: str) -> List[int]:
        if not raw:
            return []
        out: List[int] = []
        for chunk in raw.split(";"):
            if chunk == "":  # 空参数按 0 处理（xterm 语义）
                out.append(0)
                continue
            digits = "".join(ch for ch in chunk if ch.isdigit())
            out.append(min(_PARAM_LIMIT, int(digits)) if digits else 0)
        return out

    def _clamp_col(self, col: int) -> int:
        return max(0, min(self.cols - 1, col))

    def _clamp_row(self, row: int) -> int:
        return max(0, min(self.rows - 1, row))

    def _set_scroll_region(self, top: int, bottom: int) -> None:
        if 0 <= top < bottom < self.rows:
            self.scroll_top, self.scroll_bottom = top, bottom
        else:
            self.scroll_top, self.scroll_bottom = 0, self.rows - 1
        self.cursor_x = 0
        self.cursor_y = self.scroll_top

    # -- 擦除 / 插入 / 删除 -------------------------------------------------
    def _blank(self, cell: Cell) -> Cell:
        """擦除后的格子：保留底色，清掉字符与其它属性。"""
        return Cell(" ", None, cell.bg, 0)

    def _erase_display(self, mode: int) -> None:
        if mode == 0:
            self._erase_line(0)
            for row in range(self.cursor_y + 1, self.rows):
                self.lines[row] = [self._blank(c) for c in self.lines[row]]
        elif mode == 1:
            self._erase_line(1)
            for row in range(0, self.cursor_y):
                self.lines[row] = [self._blank(c) for c in self.lines[row]]
        elif mode in (2, 3):
            for row in range(self.rows):
                self.lines[row] = [self._blank(c) for c in self.lines[row]]
            if mode == 3:
                self.history.clear()

    def _erase_line(self, mode: int) -> None:
        line = self.lines[self.cursor_y]
        if mode == 0:
            span = range(self.cursor_x, self.cols)
        elif mode == 1:
            span = range(0, min(self.cols, self.cursor_x + 1))
        else:
            span = range(self.cols)
        for index in span:
            line[index] = self._blank(line[index])

    def _erase_chars(self, count: int) -> None:
        line = self.lines[self.cursor_y]
        for index in range(self.cursor_x, min(self.cols, self.cursor_x + count)):
            line[index] = self._blank(line[index])

    def _delete_chars(self, count: int) -> None:
        line = self.lines[self.cursor_y]
        count = min(count, self.cols - self.cursor_x)
        del line[self.cursor_x : self.cursor_x + count]
        line.extend([Cell() for _ in range(count)])

    def _insert_chars(self, count: int) -> None:
        line = self.lines[self.cursor_y]
        count = min(count, self.cols - self.cursor_x)
        for _ in range(count):
            line.insert(self.cursor_x, Cell())
            line.pop()

    def _insert_lines(self, count: int) -> None:
        if not (self.scroll_top <= self.cursor_y <= self.scroll_bottom):
            return
        for _ in range(count):
            self.lines.insert(self.cursor_y, self.blank_line())
            self.lines.pop(self.scroll_bottom + 1)

    def _delete_lines(self, count: int) -> None:
        if not (self.scroll_top <= self.cursor_y <= self.scroll_bottom):
            return
        for _ in range(count):
            self.lines.pop(self.cursor_y)
            self.lines.insert(self.scroll_bottom, self.blank_line())

    # -- SGR ---------------------------------------------------------------
    def _sgr(self, params: List[int]) -> None:
        if not params:
            params = [0]
        index = 0
        while index < len(params):
            code = params[index]
            if code == 0:
                self.fg = self.bg = None
                self.attrs = 0
            elif code == 1:
                self.attrs |= ATTR_BOLD
            elif code == 2:
                self.attrs |= ATTR_DIM
            elif code == 3:
                self.attrs |= ATTR_ITALIC
            elif code == 4:
                self.attrs |= ATTR_UNDERLINE
            elif code == 7:
                self.attrs |= ATTR_INVERSE
            elif code == 21:
                self.attrs &= ~ATTR_BOLD
            elif code == 22:
                self.attrs &= ~(ATTR_BOLD | ATTR_DIM)
            elif code == 23:
                self.attrs &= ~ATTR_ITALIC
            elif code == 24:
                self.attrs &= ~ATTR_UNDERLINE
            elif code == 27:
                self.attrs &= ~ATTR_INVERSE
            elif 30 <= code <= 37:
                self.fg = code - 30
            elif code == 39:
                self.fg = None
            elif 40 <= code <= 47:
                self.bg = code - 40
            elif code == 49:
                self.bg = None
            elif 90 <= code <= 97:
                self.fg = code - 90 + 8
            elif 100 <= code <= 107:
                self.bg = code - 100 + 8
            elif code in (38, 48):
                value, consumed = self._extended_color(params, index)
                if value is not _UNSET:
                    if code == 38:
                        self.fg = value
                    else:
                        self.bg = value
                index += consumed
            index += 1
        self.revision += 1

    def _extended_color(self, params: List[int], index: int):
        """解析 ``38;5;n`` / ``38;2;r;g;b``，返回 ``(颜色, 额外消耗的参数个数)``。"""
        if index + 1 >= len(params):
            return _UNSET, 0
        kind = params[index + 1]
        if kind == 5 and index + 2 < len(params):
            value = params[index + 2]
            return (value if 0 <= value <= 255 else _UNSET), 2
        if kind == 2 and index + 4 < len(params):
            red, green, blue = params[index + 2], params[index + 3], params[index + 4]
            if all(0 <= component <= 255 for component in (red, green, blue)):
                return (red, green, blue), 4
        return _UNSET, 0

    # -- 模式 --------------------------------------------------------------
    def _set_mode(self, private: str, params: List[int], *, enable: bool) -> None:
        if private != "?":
            return  # 只处理 DEC 私有模式
        for value in params or [0]:
            if value == 25:
                self.cursor_visible = enable
            elif value == 7:
                self.autowrap = enable
            elif value == 1:
                self.application_cursor_keys = enable
            elif value == 2004:
                self.bracketed_paste = enable
            elif value in (47, 1047, 1049):
                self._switch_alt_screen(enable)

    def _switch_alt_screen(self, enable: bool) -> None:
        if enable and self._alt_saved is None:
            self._alt_saved = (self.lines, self.cursor_x, self.cursor_y)
            self.lines = [self.blank_line() for _ in range(self.rows)]
            self.cursor_x = self.cursor_y = 0
            self._erase_display(2)
        elif not enable and self._alt_saved is not None:
            lines, cursor_x, cursor_y = self._alt_saved
            self._alt_saved = None
            self.lines = [self._fit_line(line) for line in lines]
            while len(self.lines) < self.rows:
                self.lines.append(self.blank_line())
            self.cursor_x = min(cursor_x, self.cols - 1)
            self.cursor_y = min(cursor_y, self.rows - 1)

    @property
    def alternate_screen(self) -> bool:
        return self._alt_saved is not None

    # -- 光标保存 / 恢复 ---------------------------------------------------
    def _save_cursor(self) -> None:
        self._saved.append((self.cursor_x, self.cursor_y, self.fg, self.bg, self.attrs))
        if len(self._saved) > 16:  # pragma: no cover - 防御
            self._saved.pop(0)

    def _restore_cursor(self) -> None:
        if not self._saved:
            self.cursor_x = self.cursor_y = 0
            return
        x, y, fg, bg, attrs = self._saved.pop()
        self.cursor_x, self.cursor_y = self._clamp_col(x), self._clamp_row(y)
        self.fg, self.bg, self.attrs = fg, bg, attrs

    # -- DSR ---------------------------------------------------------------
    def _device_status(self, code: int) -> None:
        if code == 5:
            self.replies.append("\x1b[0n")
        elif code == 6:
            x = self._clamp_col(self.cursor_x) + 1
            y = self._clamp_row(self.cursor_y) + 1
            self.replies.append(f"\x1b[{y};{x}R")

    def take_replies(self) -> str:
        text = "".join(self.replies)
        self.replies.clear()
        return text

    # -- 供渲染层使用 ------------------------------------------------------
    def viewport(self, offset: int = 0) -> List[List[Cell]]:
        """返回要绘制的行：``offset`` 为向上回滚的行数（0 = 贴底）。"""
        if offset <= 0:
            return self.lines
        offset = min(offset, len(self.history))
        return self.history[len(self.history) - offset :] + self.lines[: self.rows - offset]

    def scrollback_text(self) -> str:
        """整段回滚内容（导出 / 复制用）。"""
        rows = [ "".join(cell.char for cell in line).rstrip() for line in self.history ]
        return "\n".join(rows)


_UNSET = object()

#: 256 色调色板的 16-231 号（6×6×6 色立方）与 232-255 号（灰阶）由渲染层换算，
#: 这里只导出颜色立方步长，避免两处硬编码不一致。
CUBE_STEPS = (0, 95, 135, 175, 215, 255)


def color_256(index: int) -> Optional[Tuple[int, int, int]]:
    """把 16-255 号调色板下标换算成 RGB（0-15 交给主题的 ANSI 调色板）。"""
    if 16 <= index <= 231:
        value = index - 16
        return (
            CUBE_STEPS[value // 36],
            CUBE_STEPS[(value // 6) % 6],
            CUBE_STEPS[value % 6],
        )
    if 232 <= index <= 255:
        level = 8 + (index - 232) * 10
        return (level, level, level)
    return None


def default_palette() -> Dict[int, str]:
    """内置 ANSI 调色板（VSCode Dark Modern 的终端配色），主题缺字段时的兜底。"""
    return {
        0: "#000000",
        1: "#cd3131",
        2: "#0dbc79",
        3: "#e5e510",
        4: "#2472c8",
        5: "#bc3fbc",
        6: "#11a8cd",
        7: "#e5e5e5",
        8: "#666666",
        9: "#f14c4c",
        10: "#23d18b",
        11: "#f5f543",
        12: "#3b8eea",
        13: "#d670d6",
        14: "#29b8db",
        15: "#e5e5e5",
    }
