"""Git Diff 解析器单元测试。

严格覆盖需求文档 9 节要求的 12 类核心场景：
纯新增 / 纯删除 / 纯修改 / 新增+修改 / 修改+删除 / 全部混合 /
文件头删除 / 文件尾新增 / 连续多行修改 / 空文件 / 新文件 / 无变更。
"""

from __future__ import annotations

import difflib
from typing import Dict

from app.git.diff_parser import (
    build_added_file_diff,
    build_file_diff,
    line_count,
    parse_unified_diff,
)
from app.git.models import ChangeType, FileDiff

PATH = "src/main.c"


def make_diff(old: str, new: str, path: str = PATH, *, context: int = 3) -> str:
    """用 difflib 生成真实的 unified diff。"""
    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            n=context,
        )
    )


def markers(old: str, new: str, path: str = PATH) -> Dict[int, str]:
    """返回 {行号: 变更类型} 的可读字典。"""
    text = make_diff(old, new, path)
    diff = build_file_diff(text, path=path, new_line_count=line_count(new))
    return {line: change.value for line, change in sorted(diff.markers.items())}


# ---------------------------------------------------------------------------
# 12 类核心场景
# ---------------------------------------------------------------------------


def test_case01_pure_addition() -> None:
    """Case 1：仅新增。"""
    old = "a\nb\nc\n"
    new = "a\nb\nc\nNEW1\nNEW2\n"
    assert markers(old, new) == {4: "added", 5: "added"}


def test_case02_pure_deletion() -> None:
    """Case 2：仅删除（标记落在删除块之后的那一行）。"""
    old = "a\nb\nc\nd\n"
    new = "a\nb\nd\n"
    assert markers(old, new) == {3: "deleted"}


def test_case03_pure_modification() -> None:
    """Case 3：仅修改。"""
    old = "abc\ndef\nghi\njkl\n"
    new = "abc\nDEF\nghi\njkl\n"
    assert markers(old, new) == {2: "modified"}


def test_case04_addition_and_modification() -> None:
    """Case 4：新增 + 修改。"""
    old = "a\nb\nc\n"
    new = "a\nB\nc\nNEW\n"
    assert markers(old, new) == {2: "modified", 4: "added"}


def test_case05_modification_and_deletion() -> None:
    """Case 5：修改 + 删除。"""
    old = "a\nb\nc\nd\ne\n"
    new = "a\nB\nc\ne\n"
    assert markers(old, new) == {2: "modified", 4: "deleted"}


def test_case06_mixed_changes() -> None:
    """Case 6：新增 + 修改 + 删除。"""
    old = "a\nb\nc\nd\ne\n"
    new = "a\nB\nc\nNEW\nd\n"
    result = markers(old, new)
    assert result[2] == "modified"
    assert result[4] == "added"
    assert result[5] == "deleted"
    assert set(result.values()) == {"modified", "added", "deleted"}


def test_case07_deletion_at_file_head() -> None:
    """Case 7：文件头删除。"""
    old = "a\nb\nc\n"
    new = "b\nc\n"
    assert markers(old, new) == {1: "deleted"}


def test_case08_addition_at_file_tail() -> None:
    """Case 8：文件尾新增。"""
    old = "a\nb\n"
    new = "a\nb\nc\nd\n"
    assert markers(old, new) == {3: "added", 4: "added"}


def test_case09_consecutive_modifications() -> None:
    """Case 9：连续多行修改。"""
    old = "a\nb\nc\nd\ne\n"
    new = "a\nB\nC\nD\ne\n"
    assert markers(old, new) == {2: "modified", 3: "modified", 4: "modified"}


def test_case10_empty_file() -> None:
    """Case 10：空文件（两侧都为空 → 无标记）。"""
    assert markers("", "") == {}
    diff = build_file_diff("", path=PATH, new_line_count=0)
    assert not diff.has_changes


def test_case11_new_file() -> None:
    """Case 11：新文件（整文件新增）。"""
    text = (
        "--- /dev/null\n"
        "+++ b/src/new.c\n"
        "@@ -0,0 +1,3 @@\n"
        "+line1\n"
        "+line2\n"
        "+line3\n"
    )
    diff = build_file_diff(text, path="src/new.c", new_line_count=3)
    assert diff.is_new_file
    assert {line: change.value for line, change in diff.markers.items()} == {
        1: "added",
        2: "added",
        3: "added",
    }


def test_case12_no_change() -> None:
    """Case 12：完全没有修改。"""
    content = "a\nb\nc\n"
    diff = build_file_diff(make_diff(content, content), path=PATH, new_line_count=3)
    assert diff.markers == {}
    assert not diff.has_changes


# ---------------------------------------------------------------------------
# 特殊场景
# ---------------------------------------------------------------------------


def test_deletion_at_file_tail_marks_last_line() -> None:
    """尾部删除：标记落在最后一行（已删除行不存在）。"""
    old = "a\nb\nc\nd\n"
    new = "a\nb\n"
    assert markers(old, new) == {2: "deleted"}


def test_deletion_of_whole_file() -> None:
    """整个文件被删除。"""
    text = "--- a/src/gone.c\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n"
    diff = build_file_diff(text, path="src/gone.c", new_line_count=0)
    assert diff.is_deleted_file
    assert markers_of(diff) == {1: "deleted"}


def test_replacement_with_more_additions() -> None:
    """替换块中新增多于删除：多出的行标记为新增。"""
    old = "a\nb\nc\n"
    new = "a\nB1\nB2\nB3\nc\n"
    result = markers(old, new)
    assert result[2] == "modified"
    assert result[3] == "added"
    assert result[4] == "added"


def test_replacement_with_more_deletions() -> None:
    """替换块中删除多于新增：多余删除在后续行给出删除标记。"""
    old = "a\nb1\nb2\nb3\nc\n"
    new = "a\nB\nc\n"
    result = markers(old, new)
    assert result[2] == "modified"
    assert result[3] == "deleted"


def test_hunk_context_lines_with_dashes() -> None:
    """上下文行内容以 ``--`` 开头时不能被误判为文件头。"""
    old = "--- header ---\na\nb\n"
    new = "--- header ---\na\nB\n"
    assert markers(old, new) == {3: "modified"}


def test_deleted_line_content_starting_with_dashes() -> None:
    """被删除的行内容本身以 ``--`` 开头。"""
    old = "a\n--- separator\nb\n"
    new = "a\nb\n"
    assert markers(old, new) == {2: "deleted"}


def test_multiple_files_in_single_diff() -> None:
    """一个 diff 中包含多个文件。"""
    text = (
        "diff --git a/a.c b/a.c\n"
        "--- a/a.c\n"
        "+++ b/a.c\n"
        "@@ -1,2 +1,2 @@\n"
        " x\n"
        "-y\n"
        "+Y\n"
        "diff --git a/b.c b/b.c\n"
        "--- a/b.c\n"
        "+++ b/b.c\n"
        "@@ -1,1 +1,2 @@\n"
        " x\n"
        "+z\n"
    )
    parsed = parse_unified_diff(text, new_line_count=None)
    assert set(parsed.files) == {"a.c", "b.c"}
    assert parsed.for_path("a.c").markers == {2: ChangeType.MODIFIED}
    assert parsed.for_path("b.c").markers == {2: ChangeType.ADDED}


def test_binary_file_diff_has_no_markers() -> None:
    text = (
        "diff --git a/blob.bin b/blob.bin\n"
        "index 111..222 100644\n"
        "Binary files a/blob.bin and b/blob.bin differ\n"
    )
    parsed = parse_unified_diff(text, path="blob.bin", new_line_count=10)
    assert parsed.is_binary
    assert parsed.files["blob.bin"].is_binary
    assert parsed.files["blob.bin"].markers == {}


def test_marker_priority_prefers_modified() -> None:
    """同一行同时命中多类标记时保留优先级最高的（修改 > 新增 > 删除）。"""
    text = "@@ -1,1 +1,2 @@\n-a\n+A\n+A2\n"
    diff = build_file_diff(text, path=PATH, new_line_count=2)
    assert diff.markers[1] is ChangeType.MODIFIED
    assert diff.markers[2] is ChangeType.ADDED


def test_markers_clamped_to_existing_lines() -> None:
    """删除标记不能超出当前文件行数。"""
    old = "a\nb\n"
    new = "a\n"
    assert markers(old, new) == {1: "deleted"}


def test_build_added_file_diff_counts_lines() -> None:
    diff = build_added_file_diff("src/x.c", "1\n2\n3\n")
    assert diff.is_new_file
    assert diff.new_line_count == 3
    assert diff.added_lines == [1, 2, 3]


def test_file_diff_summary_and_labels() -> None:
    old = "a\nb\nc\n"
    new = "a\nB\nc\nNEW\n"
    diff = build_file_diff(make_diff(old, new), path=PATH, new_line_count=4)
    assert diff.added_lines == [4]
    assert diff.modified_lines == [2]
    assert diff.deleted_lines == []
    assert diff.summary == "+1 ~1 -0"
    assert diff.marker(2) is ChangeType.MODIFIED
    assert ChangeType.MODIFIED.label == "修改"


def test_clamp_to_truncates_out_of_range_markers() -> None:
    diff = FileDiff(path=PATH, markers={1: ChangeType.ADDED, 99: ChangeType.DELETED})
    clamped = diff.clamp_to(10)
    assert clamped.markers == {1: ChangeType.ADDED}


def test_parse_empty_diff_returns_empty_result() -> None:
    parsed = parse_unified_diff("", path=PATH, new_line_count=5)
    assert parsed.files == {}
    assert parsed.for_path(PATH).markers == {}


def markers_of(diff: FileDiff) -> Dict[int, str]:
    return {line: change.value for line, change in sorted(diff.markers.items())}
