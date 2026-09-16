"""编辑器控件测试：打开、修改、保存状态、搜索、替换、缩进、Gutter 绘制。"""

from __future__ import annotations

import pytest
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPixmap

from app.config.settings import AppSettings
from app.editor.editor import CodeEditor
from app.git.models import ChangeType
from app.ui.theme import DARK, LIGHT, get_theme

SAMPLE = "int main() {\n    return 0;\n}\n"


@pytest.fixture
def editor(qtbot) -> CodeEditor:
    widget = CodeEditor(get_theme("dark"), AppSettings())
    qtbot.addWidget(widget)
    widget.resize(640, 320)
    widget.show()
    return widget


def test_editor_loads_text_and_language(editor: CodeEditor) -> None:
    editor.set_plain_text_silent(SAMPLE, language="C++")
    assert editor.text_value() == SAMPLE
    assert editor.language == "C++"
    assert editor.blockCount() == 4
    assert editor.current_line_number() == 1


def test_gutter_width_grows_with_line_count(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("a\n")
    narrow = editor.gutter_width()
    editor.set_plain_text_silent("\n".join(str(index) for index in range(2000)) + "\n")
    assert editor.gutter_width() > narrow


def test_set_and_clear_markers(editor: CodeEditor) -> None:
    editor.set_plain_text_silent(SAMPLE)
    editor.set_markers({1: ChangeType.ADDED, 2: ChangeType.MODIFIED, 3: ChangeType.DELETED})
    counts = editor.marker_counts()
    assert counts[ChangeType.ADDED] == 1
    assert counts[ChangeType.MODIFIED] == 1
    assert counts[ChangeType.DELETED] == 1
    editor.clear_markers()
    assert editor.marker_counts()[ChangeType.ADDED] == 0


def test_gutter_paints_marker_colors(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("line1\nline2\nline3\nline4\n")
    editor.set_theme(LIGHT)
    editor.set_markers(
        {1: ChangeType.ADDED, 2: ChangeType.MODIFIED, 3: ChangeType.DELETED}
    )
    pixmap = QPixmap(editor.gutter_width(), editor.viewport().height() or 200)
    pixmap.fill(QColor("#000000"))
    editor._gutter.render(pixmap)
    image = pixmap.toImage()

    found = set()
    for y in range(min(image.height(), 120)):
        for x in range(min(image.width(), 8)):
            found.add(image.pixelColor(x, y).name())
    assert LIGHT.marker_added in found
    assert LIGHT.marker_modified in found
    assert LIGHT.marker_deleted in found


def test_theme_switch_updates_marker_colors(editor: CodeEditor) -> None:
    editor.set_theme(DARK)
    assert editor.decorator.style.added.name() == DARK.marker_added
    editor.set_theme(LIGHT)
    assert editor.decorator.style.added.name() == LIGHT.marker_added


def test_tab_inserts_spaces(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("")
    editor.keyPressEvent(_key_event(Qt.Key.Key_Tab))
    assert editor.text_value() == "    "


def test_shift_tab_is_ignored_without_selection(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("    x\n")
    editor.go_to_line(1, column=6)
    assert editor._indent_selection(reverse=True) is False


def test_auto_indent_after_brace(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("    if (x) {\n")
    cursor = editor.textCursor()
    cursor.movePosition(cursor.MoveOperation.EndOfBlock)
    editor.setTextCursor(cursor)
    editor._auto_indent()
    lines = editor.text_value().splitlines()
    assert lines[-1] == "    " + "    "


def test_auto_indent_keeps_existing_indent(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("        value = 1\n")
    cursor = editor.textCursor()
    cursor.movePosition(cursor.MoveOperation.EndOfBlock)
    editor.setTextCursor(cursor)
    editor._auto_indent()
    assert editor.text_value().splitlines()[-1] == "        "


def test_find_next_and_wrap(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("alpha\nbeta\nalpha\n")
    assert editor.find_next("beta")
    assert editor.current_line_number() == 2
    assert editor.find_next("alpha")
    assert editor.current_line_number() == 3
    # 到达末尾后应回绕到开头
    assert editor.find_next("alpha")
    assert editor.current_line_number() == 1


def test_find_previous(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("alpha\nbeta\nalpha\n")
    editor.go_to_line(3)
    assert editor.find_previous("alpha")
    assert editor.current_line_number() == 1


def test_find_case_sensitive(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("Value\nvalue\n")
    assert editor.count_matches("value") == 2
    assert editor.count_matches("value", case_sensitive=True) == 1


def test_find_regex(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("abc123\ndef\n")
    assert editor.count_matches(r"\d+", regex=True) == 1
    with pytest.raises(ValueError):
        editor.find_next("([", regex=True)


def test_replace_all(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("foo bar foo\nfoo\n")
    count = editor.replace_all("foo", "baz")
    assert count == 3
    assert editor.text_value() == "baz bar baz\nbaz\n"


def test_replace_current_without_selection(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("foo\nfoo\n")
    assert editor.replace_current("foo", "bar")
    assert editor.text_value().splitlines()[0] == "bar"


def test_replace_all_regex(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("a1 b2 c3\n")
    count = editor.replace_all(r"[0-9]", "#", regex=True)
    assert count == 3
    assert editor.text_value() == "a# b# c#\n"


def test_undo_redo(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("")
    cursor = editor.textCursor()
    cursor.beginEditBlock()
    cursor.insertText("hello")
    cursor.endEditBlock()
    cursor = editor.textCursor()
    cursor.beginEditBlock()
    cursor.insertText(" world")
    cursor.endEditBlock()
    editor.undo()
    assert editor.text_value() == "hello"
    editor.redo()
    assert editor.text_value() == "hello world"


def test_go_to_line(editor: CodeEditor) -> None:
    editor.set_plain_text_silent("\n".join(f"line{index}" for index in range(1, 21)))
    editor.go_to_line(17)
    assert editor.current_line_number() == 17


def test_modified_flag_reset_by_silent_load(editor: CodeEditor) -> None:
    editor.insertPlainText("dirty")
    assert editor.document().isModified()
    editor.set_plain_text_silent("clean\n")
    assert not editor.document().isModified()


def test_apply_settings_changes_font_size(editor: CodeEditor) -> None:
    settings = AppSettings(font_size=20, tab_size=2, use_spaces=False)
    editor.apply_settings(settings)
    assert editor.font().pointSize() == 20
    editor.set_plain_text_silent("")
    editor._indent_selection(reverse=False)
    assert editor.text_value() == "\t"


def test_editor_signals_cursor_moved(editor: CodeEditor, qtbot) -> None:
    editor.set_plain_text_silent("a\nb\nc\n")
    with qtbot.waitSignal(editor.cursorMoved, timeout=1000) as blocker:
        editor.go_to_line(3)
    assert blocker.args[0] == 3


def _key_event(key):
    from PySide6.QtGui import QKeyEvent
    from PySide6.QtCore import QEvent

    return QKeyEvent(QEvent.Type.KeyPress, key, Qt.KeyboardModifier.NoModifier)
