"""按键 → 转义序列。纯函数，不依赖 Qt（Qt 的 key 枚举在控件里先转成这里的名字）。"""

from __future__ import annotations

from typing import Dict

#: 光标移动类：应用光标模式（DECCKM）下用 SS3（``\\x1bO``）前缀
_CURSOR_KEYS = {
    "up": "A",
    "down": "B",
    "right": "C",
    "left": "D",
    "home": "H",
    "end": "F",
}

#: 功能键（xterm 传统编码）
_FUNCTION_KEYS = {
    "insert": "2~",
    "delete": "3~",
    "pageup": "5~",
    "pagedown": "6~",
    "f1": "OP",
    "f2": "OQ",
    "f3": "OR",
    "f4": "OS",
    "f5": "15~",
    "f6": "17~",
    "f7": "18~",
    "f8": "19~",
    "f9": "20~",
    "f10": "21~",
    "f11": "23~",
    "f12": "24~",
}

#: Ctrl + 字符 → 控制码（``Ctrl+A`` = 0x01 …）
_CTRL_CODES: Dict[str, str] = {chr(code + 96): chr(code) for code in range(1, 27)}
_CTRL_CODES.update({"@": "\x00", " ": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "_": "\x1f"})


def control_char(char: str) -> str:
    """``Ctrl + char`` 对应的控制字符；没有对应关系时返回空串。"""
    return _CTRL_CODES.get(char.lower() if len(char) == 1 else char, "")


def encode_key(
    key: str,
    text: str = "",
    *,
    ctrl: bool = False,
    alt: bool = False,
    shift: bool = False,
    app_cursor: bool = False,
) -> str:
    """把一次按键转成要发给远端的字节（返回 ``str``，由通道负责编码）。

    ``key`` 取值：``"char"`` 表示普通字符（用 ``text``），其余是
    ``up/down/left/right/home/end/insert/delete/pageup/pagedown/f1``… 或
    ``enter/backspace/tab/escape``。
    """
    sequence = ""
    if key == "enter":
        sequence = "\r"
    elif key == "backspace":
        sequence = "\x7f"
    elif key == "tab":
        sequence = "\x1b[Z" if shift else "\t"
    elif key == "escape":
        sequence = "\x1b"
    elif key in _CURSOR_KEYS:
        sequence = (f"\x1bO{_CURSOR_KEYS[key]}" if app_cursor else f"\x1b[{_CURSOR_KEYS[key]}")
    elif key in _FUNCTION_KEYS:
        code = _FUNCTION_KEYS[key]
        sequence = f"\x1b{code}" if code.startswith("O") else f"\x1b[{code}"
    elif key == "char":
        sequence = text
        if ctrl:
            control = control_char(text)
            if control:
                sequence = control
        if alt and sequence:
            sequence = "\x1b" + sequence
    elif key == "ctrl":
        sequence = control_char(text)
    return sequence


#: Qt 的 key 名字 → 本模块的 key 名字（控件里用 ``Qt.Key`` 的 ``name`` 属性查这张表）
QT_KEY_NAMES = {
    "Key_Return": "enter",
    "Key_Enter": "enter",
    "Key_Backspace": "backspace",
    "Key_Tab": "tab",
    "Key_Escape": "escape",
    "Key_Up": "up",
    "Key_Down": "down",
    "Key_Left": "left",
    "Key_Right": "right",
    "Key_Home": "home",
    "Key_End": "end",
    "Key_Insert": "insert",
    "Key_Delete": "delete",
    "Key_PageUp": "pageup",
    "Key_PageDown": "pagedown",
    "Key_F1": "f1",
    "Key_F2": "f2",
    "Key_F3": "f3",
    "Key_F4": "f4",
    "Key_F5": "f5",
    "Key_F6": "f6",
    "Key_F7": "f7",
    "Key_F8": "f8",
    "Key_F9": "f9",
    "Key_F10": "f10",
    "Key_F11": "f11",
    "Key_F12": "f12",
    "Key_Space": "char",
}
