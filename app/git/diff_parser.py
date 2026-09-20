"""Unified Diff 解析器（纯函数，无 IO，可独立单元测试）。

输入：``git diff`` 产生的 unified diff 文本
输出：:class:`FileDiff` —— 当前工作区文件每一行的变更类型

标记规则（对齐 VSCode Gutter 行为）：

* 纯新增块        → 新增行标 ``ADDED``（绿色）
* 纯删除块        → 已删除的行已不存在，在其**后续行**标 ``DELETED``（红色）；
                    若删除发生在文件末尾，则标在最后一行；新文件为空时标在第 1 行
* 替换块（-N +M） → 前 ``min(N, M)`` 行标 ``MODIFIED``（黄色/橙色）
                    * M > N：多出的新增行标 ``ADDED``
                    * N > M：多出的删除行在其后续行标 ``DELETED``
* 新文件          → 整文件 ``ADDED``
* 二进制文件      → 不做行标记，仅置 ``is_binary``
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.git.models import ChangeType, FileDiff, HunkDetail, priority_merge

HUNK_HEADER_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")

_FILE_HEADER_PREFIXES = (
    "diff --git ",
    "index ",
    "old mode ",
    "new mode ",
    "similarity index ",
    "dissimilarity index ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
    "Binary files ",
    "GIT binary patch",
)

_NO_NEWLINE_MARKER = "\\ No newline at end of file"


@dataclass
class _PendingBlock:
    """一个连续的变更块（含每行的旧 / 新文本，供点击查看 diff 用）。"""

    start_line: int  # 新增侧起始行号（1-based）
    deletions: int = 0
    additions: int = 0
    removed: List[str] = field(default_factory=list)
    added: List[str] = field(default_factory=list)


@dataclass
class ParsedDiff:
    """一次 diff 文本的解析结果（可能包含多个文件）。"""

    files: Dict[str, FileDiff] = field(default_factory=dict)
    is_binary: bool = False

    def for_path(self, path: str) -> FileDiff:
        """按路径取结果，找不到时按后缀宽松匹配。"""
        if path in self.files:
            return self.files[path]
        for key, value in self.files.items():
            if key and path and (key.endswith(path) or path.endswith(key)):
                return value
        if len(self.files) == 1:
            return next(iter(self.files.values()))
        return FileDiff.empty(path)


def split_lines(text: str) -> List[str]:
    """按行切分（不含换行符）。空字符串 → []。"""
    if not text:
        return []
    return text.splitlines()


def line_count(text: str) -> int:
    """文本行数。"""
    return len(split_lines(text))


def parse_unified_diff(
    diff_text: str,
    *,
    path: str = "",
    new_line_count: Optional[int] = None,
) -> ParsedDiff:
    """解析 unified diff 文本。

    :param path: diff 未显式给出文件名时使用的路径（单文件 diff 场景）。
    :param new_line_count: 当前工作区文件的实际行数，用于修正尾部删除的标记位置。
    """
    result = ParsedDiff()
    if not diff_text:
        return result

    builders: Dict[str, _FileDiffBuilder] = {}
    current: Optional[_FileDiffBuilder] = None

    def ensure_current() -> _FileDiffBuilder:
        """没有当前文件时，按传入的 fallback 路径创建一个。"""
        nonlocal current
        if current is None:
            current = builders.setdefault(path, _FileDiffBuilder(path=path))
        return current

    pending: Optional[_PendingBlock] = None
    in_hunk = False
    hunk_new_line = 0
    old_remaining = 0
    new_remaining = 0

    def finish_block() -> None:
        nonlocal pending
        if pending is not None and current is not None:
            current.apply_block(pending)
        pending = None

    for raw in diff_text.splitlines():
        header = HUNK_HEADER_RE.match(raw)
        if header:
            finish_block()
            builder = ensure_current()
            old_start, old_len, new_start, new_len = _parse_hunk_counts(header)
            builder.hunk_count += 1
            builder.note_hunk_end(new_start + max(new_len - 1, 0))
            if old_start == 0 and old_len == 0:
                builder.is_new_file = True
            in_hunk = True
            hunk_new_line = max(new_start, 1)
            old_remaining = old_len
            new_remaining = new_len
            continue

        if in_hunk:
            if raw.startswith(_NO_NEWLINE_MARKER):
                continue
            if raw[:1] == "+":
                if pending is None:
                    pending = _PendingBlock(start_line=hunk_new_line)
                pending.additions += 1
                pending.added.append(raw[1:])
                hunk_new_line += 1
                new_remaining -= 1
            elif raw[:1] == "-":
                if pending is None:
                    pending = _PendingBlock(start_line=hunk_new_line)
                pending.deletions += 1
                pending.removed.append(raw[1:])
                old_remaining -= 1
            else:
                # 上下文行（正常情况下以空格开头）
                finish_block()
                hunk_new_line += 1
                old_remaining -= 1
                new_remaining -= 1
            if (old_remaining <= 0 and new_remaining <= 0) or (
                old_remaining < 0 and new_remaining < 0
            ):
                finish_block()
                in_hunk = False
            continue

        # --- hunk 之外的头部信息 ---
        if raw.startswith("--- "):
            target = raw[4:].strip()
            if target == "/dev/null":
                ensure_current().is_new_file = True
            continue
        if raw.startswith("+++ "):
            target = raw[4:].strip()
            if target == "/dev/null":
                ensure_current().is_deleted_file = True
            else:
                finish_block()
                name = _normalize_path(target, path)
                current = builders.setdefault(name, _FileDiffBuilder(path=name))
            continue
        if raw.startswith("new file mode"):
            ensure_current().is_new_file = True
            continue
        if raw.startswith("deleted file mode"):
            ensure_current().is_deleted_file = True
            continue
        if raw.startswith("Binary files ") or raw.startswith("GIT binary patch"):
            ensure_current().is_binary = True
            result.is_binary = True
            continue
        if raw.startswith(_FILE_HEADER_PREFIXES):
            finish_block()
            continue

    finish_block()
    for name, builder in list(builders.items()):
        builder.finalize(new_line_count)
        # 丢弃仅由头部产生的空条目
        if not builder.hunk_count and not (
            builder.is_new_file or builder.is_deleted_file or builder.is_binary
        ):
            del builders[name]
    result.files = {name: builder.to_file_diff() for name, builder in builders.items()}
    return result


# ---------------------------------------------------------------------------
# 内部实现
# ---------------------------------------------------------------------------


def _parse_hunk_counts(match: "re.Match[str]") -> Tuple[int, int, int, int]:
    old_start = int(match.group(1))
    old_len = int(match.group(2)) if match.group(2) is not None else 1
    new_start = int(match.group(3))
    new_len = int(match.group(4)) if match.group(4) is not None else 1
    if old_start == 0:
        old_len = 0
    if new_start == 0:
        new_len = 0
    return old_start, old_len, new_start, new_len


def _normalize_path(raw: str, fallback: str) -> str:
    name = raw.split("\t")[0].strip()
    if name in ("/dev/null", ""):
        return fallback
    for prefix in ("a/", "b/"):
        if name.startswith(prefix):
            name = name[len(prefix) :]
            break
    return name or fallback


class _FileDiffBuilder:
    """累积单个文件的标记，最后统一裁剪为 :class:`FileDiff`。"""

    def __init__(self, path: str) -> None:
        self.path = path
        self.markers: Dict[int, ChangeType] = {}
        self.is_new_file = False
        self.is_deleted_file = False
        self.is_binary = False
        self.hunk_count = 0
        self.last_hunk_end = 0
        #: 变更块的旧 / 新文本（点击 gutter 查看 diff 用）
        self.hunks: List[HunkDetail] = []

    # -- 记录 --------------------------------------------------------------
    def note_hunk_end(self, new_end: int) -> None:
        self.last_hunk_end = max(self.last_hunk_end, new_end)

    def mark(self, line: int, change: ChangeType) -> None:
        if line <= 0:
            return
        self.markers[line] = priority_merge(self.markers.get(line), change)

    def apply_block(self, block: _PendingBlock) -> None:
        if block.additions == 0 and block.deletions == 0:
            return
        # 记录这个变更块的旧 / 新文本（start_line 是新增侧起始行号）
        if block.removed or block.added:
            self.hunks.append(
                HunkDetail(
                    start_line=max(block.start_line, 1),
                    removed=tuple(block.removed),
                    added=tuple(block.added),
                )
            )
        if block.deletions == 0:
            for offset in range(block.additions):
                self.mark(block.start_line + offset, ChangeType.ADDED)
            return
        if block.additions == 0:
            self._mark_deletion(block.start_line)
            return

        common = min(block.deletions, block.additions)
        for offset in range(common):
            self.mark(block.start_line + offset, ChangeType.MODIFIED)
        for offset in range(common, block.additions):
            self.mark(block.start_line + offset, ChangeType.ADDED)
        if block.deletions > common:
            self._mark_deletion(block.start_line + common)

    def _mark_deletion(self, position: int) -> None:
        """删除标记落在 ``position``（即删除块之后的那一行）。"""
        position = max(position, 1)
        if self.last_hunk_end and position > self.last_hunk_end:
            position = max(self.last_hunk_end, 1)
        self.mark(position, ChangeType.DELETED)

    def finalize(self, new_line_count: Optional[int]) -> None:
        count = new_line_count if new_line_count is not None else self.last_hunk_end
        if count <= 0:
            # 空文件（或整个文件被删除）：删除标记落在唯一的那一行上
            if self.is_deleted_file and not self.markers:
                self.mark(1, ChangeType.DELETED)
            return
        for line in list(self.markers):
            if line > count:
                change = self.markers.pop(line)
                if change is ChangeType.DELETED:
                    self.mark(count, ChangeType.DELETED)

    def to_file_diff(self) -> FileDiff:
        return FileDiff(
            path=self.path,
            markers=dict(self.markers),
            is_new_file=self.is_new_file,
            is_deleted_file=self.is_deleted_file,
            is_binary=self.is_binary,
            hunk_count=self.hunk_count,
            new_line_count=self.last_hunk_end,
            hunks=tuple(sorted(self.hunks, key=lambda hunk: hunk.start_line)),
        )


def build_file_diff(
    diff_text: str,
    *,
    path: str = "",
    new_line_count: Optional[int] = None,
) -> FileDiff:
    """解析单文件 diff（常用入口）。"""
    parsed = parse_unified_diff(diff_text, path=path, new_line_count=new_line_count)
    return parsed.for_path(path)


def build_added_file_diff(path: str, content: str) -> FileDiff:
    """未跟踪的新文件：整文件视为新增。"""
    total = line_count(content)
    diff = FileDiff(path=path, is_new_file=True, new_line_count=total)
    for number in range(1, total + 1):
        diff.markers[number] = ChangeType.ADDED
    return diff
