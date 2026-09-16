"""编码探测与转换测试（UTF-8 / UTF-8 BOM / ASCII / 未知编码处理）。"""

from __future__ import annotations

import pytest

from app.utils.encoding import (
    SELECTABLE_ENCODINGS,
    DecodedText,
    UnknownEncodingError,
    decode_bytes,
    detect_newline,
    encode_text,
)


def test_decode_ascii() -> None:
    # 纯 ASCII 内容同时是合法 UTF-8，按 UTF-8 报告（保存时能安全写入中文）
    decoded = decode_bytes(b"hello world\n")
    assert decoded.encoding in ("ascii", "utf-8")
    assert decoded.text == "hello world\n"
    assert not decoded.has_bom


def test_decode_utf8_with_chinese() -> None:
    decoded = decode_bytes("// 中文注释\n".encode("utf-8"))
    assert decoded.encoding == "utf-8"
    assert decoded.text == "// 中文注释\n"


def test_decode_utf8_bom() -> None:
    decoded = decode_bytes("\ufeffint main() {}\n".encode("utf-8"))
    assert decoded.encoding == "utf-8-sig"
    assert decoded.has_bom
    assert decoded.text.startswith("int main")
    assert not decoded.text.startswith("\ufeff")


def test_decode_utf16_bom() -> None:
    decoded = decode_bytes("hello".encode("utf-16"))
    assert decoded.encoding in ("utf-16-le", "utf-16-be")
    assert "hello" in decoded.text


def test_unknown_encoding_raises_with_candidates() -> None:
    with pytest.raises(UnknownEncodingError) as info:
        decode_bytes(b"\x80\x81\xff")
    assert info.value.candidates == list(SELECTABLE_ENCODINGS)


def test_binary_bytes_raise_instead_of_crashing() -> None:
    with pytest.raises(UnknownEncodingError):
        decode_bytes(b"\xff\xff\xff\xff")


def test_decode_with_explicit_encoding() -> None:
    decoded = decode_bytes(b"caf\xe9\n", encoding="latin-1")
    assert decoded.text == "café\n"
    assert decoded.encoding == "latin-1"


def test_decode_with_wrong_explicit_encoding() -> None:
    with pytest.raises(UnknownEncodingError):
        decode_bytes(b"\xff\xfe\xfa", encoding="ascii")


def test_decode_gb18030_when_selected() -> None:
    decoded = decode_bytes("中文\n".encode("gb18030"), encoding="gb18030")
    assert decoded.text == "中文\n"


def test_detect_newline() -> None:
    assert detect_newline("a\nb\n") == "\n"
    assert detect_newline("a\r\nb\r\n") == "\r\n"
    assert detect_newline("a\r\nb\r\nc\n") == "\r\n"
    assert detect_newline("") == "\n"


def test_encode_text_converts_newlines() -> None:
    assert encode_text("a\nb\n", "utf-8", newline="\r\n") == b"a\r\nb\r\n"
    assert encode_text("a\r\nb\r", "utf-8", newline="\n") == b"a\nb\n"


def test_encode_text_utf8_sig_adds_bom() -> None:
    assert encode_text("hi", "utf-8-sig").startswith(b"\xef\xbb\xbf")


def test_decoded_text_round_trip_preserves_bytes() -> None:
    original = "int main() {\n\treturn 0;\n}\n".encode("utf-8")
    decoded = decode_bytes(original)
    assert decoded.encode(detect_newline(decoded.text)) == original


def test_decoded_text_round_trip_with_crlf() -> None:
    original = b"a\r\nb\r\n"
    decoded = decode_bytes(original)
    assert decoded.encode(detect_newline(decoded.text)) == original


def test_decoded_text_keeps_bom_on_write() -> None:
    raw = "\ufeffx\n".encode("utf-8")
    decoded = decode_bytes(raw)
    assert decoded.encode() == raw


def test_decoded_text_dataclass_defaults() -> None:
    decoded = DecodedText(text="x", encoding="utf-8")
    assert decoded.has_bom is False
