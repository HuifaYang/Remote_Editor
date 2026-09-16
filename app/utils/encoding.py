"""文件编码探测与转换。

需求 5.11：至少支持 UTF-8、UTF-8 BOM、ASCII；无法识别时提示用户手动选择，
绝不能因为一个非 UTF-8 文件导致程序崩溃。

因此这里**只自动识别 UTF-8 / UTF-8 BOM / ASCII**，
其它编码（GB18030、Latin-1…）必须由用户从 :data:`SELECTABLE_ENCODINGS` 中显式选择。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional

#: 带 BOM 的编码（按前缀长度从长到短匹配）
BOMS: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xfe\x00\x00", "utf-32-le"),
    (b"\x00\x00\xfe\xff", "utf-32-be"),
    (b"\xef\xbb\xbf", "utf-8-sig"),
    (b"\xff\xfe", "utf-16-le"),
    (b"\xfe\xff", "utf-16-be"),
)

UTF8_BOM = b"\xef\xbb\xbf"

#: 用户可手工选择的编码列表（解码失败时的提示）
SELECTABLE_ENCODINGS: tuple[str, ...] = (
    "utf-8",
    "utf-8-sig",
    "ascii",
    "gb18030",
    "big5",
    "latin-1",
    "utf-16",
)


class UnknownEncodingError(Exception):
    """无法自动识别文件编码（需要用户手动选择）。"""

    def __init__(self, message: str = "无法识别文件编码", *, candidates: Iterable[str] = ()) -> None:
        super().__init__(message)
        self.message = message
        self.candidates: List[str] = list(candidates)


@dataclass
class DecodedText:
    """解码结果。"""

    text: str
    encoding: str
    has_bom: bool = False

    def encode(self, newline: str = "\n") -> bytes:
        """按原始编码与换行风格回写为字节。"""
        normalized = self.text.replace("\r\n", "\n").replace("\r", "\n")
        if newline != "\n":
            normalized = normalized.replace("\n", newline)
        payload = normalized.encode(self.encoding)
        if self.has_bom and self.encoding == "utf-8" and not payload.startswith(UTF8_BOM):
            payload = UTF8_BOM + payload
        return payload


def detect_newline(text: str) -> str:
    """探测换行风格，默认 ``\\n``。"""
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    if crlf and crlf >= lf:
        return "\r\n"
    return "\n"


def decode_bytes(data: bytes, *, encoding: Optional[str] = None) -> DecodedText:
    """把文件字节解码为文本。

    :param encoding: 用户手工指定的编码；为 ``None`` 时自动探测。
    :raises UnknownEncodingError: 无法识别时（调用方应提示用户选择编码）。
    """
    if encoding:
        try:
            text = data.decode(encoding)
        except (UnicodeDecodeError, LookupError) as exc:
            raise UnknownEncodingError(f"使用 {encoding} 解码失败：{exc}") from exc
        has_bom = encoding == "utf-8-sig" or data.startswith(UTF8_BOM)
        if has_bom:
            text = text.lstrip("\ufeff")
        return DecodedText(text, encoding, has_bom)

    for bom, bom_encoding in BOMS:
        if data.startswith(bom):
            try:
                text = data.decode(bom_encoding)
            except UnicodeDecodeError as exc:
                raise UnknownEncodingError(f"BOM 指示编码 {bom_encoding} 解码失败") from exc
            return DecodedText(text.lstrip("\ufeff"), bom_encoding, True)

    try:
        return DecodedText(data.decode("utf-8"), "utf-8", False)
    except UnicodeDecodeError:
        pass

    try:
        return DecodedText(data.decode("ascii"), "ascii", False)
    except UnicodeDecodeError:
        pass

    raise UnknownEncodingError("文件不是 UTF-8 / ASCII 编码", candidates=SELECTABLE_ENCODINGS)


def encode_text(text: str, encoding: str = "utf-8", *, newline: str = "\n") -> bytes:
    """按指定编码编码文本，并统一换行风格。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if newline != "\n":
        normalized = normalized.replace("\n", newline)
    return normalized.encode(encoding)
