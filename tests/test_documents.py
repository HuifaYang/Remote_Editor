"""编辑器文档模型测试（与 Qt 解耦）。"""

from __future__ import annotations

from app.editor.document import Document
from app.editor.syntax import detect_language
from app.git.models import ChangeType, FileDiff


def test_new_document_is_clean() -> None:
    document = Document(remote_path="/home/user/project/main.cpp", text="int main() {}\n")
    assert not document.dirty
    assert document.tab_title == "main.cpp"


def test_edit_marks_dirty_and_tab_title() -> None:
    document = Document(remote_path="/home/user/project/main.cpp", text="a\n", saved_text="a\n")
    document.text = "a\nb\n"
    assert document.dirty
    assert document.tab_title == "main.cpp*"


def test_mark_saved_clears_dirty() -> None:
    document = Document(remote_path="/x/main.c", text="a\n", saved_text="a\n")
    document.text = "b\n"
    document.mark_saved()
    assert not document.dirty
    assert document.saved_text == "b\n"


def test_display_name_and_line_count() -> None:
    document = Document(remote_path="/home/user/project/src/util.c", text="1\n2\n3\n")
    assert document.display_name == "util.c"
    assert document.line_count() == 3


def test_display_name_for_empty_path() -> None:
    document = Document(remote_path="/", text="")
    assert document.display_name == "/"


def test_apply_diff_stores_markers() -> None:
    document = Document(remote_path="/x/main.c")
    diff = FileDiff(path="/x/main.c", markers={2: ChangeType.MODIFIED})
    document.apply_diff(diff)
    assert document.diff.marker(2) is ChangeType.MODIFIED


def test_replace_text() -> None:
    document = Document(remote_path="/x/main.c", text="a\n")
    document.replace_text("b\n")
    assert document.text == "b\n"
    assert document.dirty


def test_language_detection_variants() -> None:
    assert detect_language("/a/main.cpp") == "C++"
    assert detect_language("/a/script.py") == "Python"
    assert detect_language("/a/CMakeLists.txt") == "CMake"
    assert detect_language("/a/config.yaml") == "YAML"
    assert detect_language("/a/README.md") == "Markdown"
    assert detect_language("/a/Makefile") == "Makefile"
    assert detect_language("/a/unknown.zzz") == "Plain Text"
