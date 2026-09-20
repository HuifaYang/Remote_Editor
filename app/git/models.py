"""Git Diff 数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Iterable, List, Optional


class ChangeType(str, Enum):
    """行级变更类型。"""

    ADDED = "added"
    MODIFIED = "modified"
    DELETED = "deleted"

    @property
    def priority(self) -> int:
        """标记优先级：同一行同时命中多类时保留优先级高者。"""
        return {
            ChangeType.DELETED: 1,
            ChangeType.ADDED: 2,
            ChangeType.MODIFIED: 3,
        }[self]

    @property
    def label(self) -> str:
        return {
            ChangeType.ADDED: "新增",
            ChangeType.MODIFIED: "修改",
            ChangeType.DELETED: "删除",
        }[self]


@dataclass(frozen=True)
class LineMarker:
    """单行变更标记（行号为当前工作区文件的 1-based 行号）。"""

    line: int
    change: ChangeType
    old_line: Optional[int] = None


@dataclass(frozen=True)
class HunkDetail:
    """一个变更块的详细内容（供「点击 gutter 查看与上一版差异」使用）。

    ``start_line`` 是该块在当前工作区文件中的起始行号（1-based）；
    ``removed`` 是被删除 / 被改掉的旧文本，``added`` 是对应的新文本。
    """

    start_line: int
    removed: tuple = ()
    added: tuple = ()


@dataclass
class FileDiff:
    """单个文件的 Diff 解析结果。"""

    path: str = ""
    markers: Dict[int, ChangeType] = field(default_factory=dict)
    is_new_file: bool = False
    is_deleted_file: bool = False
    is_binary: bool = False
    hunk_count: int = 0
    new_line_count: int = 0
    #: 各变更块的旧 / 新文本（点击 gutter 查看 diff 用），按 start_line 升序
    hunks: tuple = ()

    # -- 统计 --------------------------------------------------------------
    @property
    def added_lines(self) -> List[int]:
        return self._lines_of(ChangeType.ADDED)

    @property
    def modified_lines(self) -> List[int]:
        return self._lines_of(ChangeType.MODIFIED)

    @property
    def deleted_lines(self) -> List[int]:
        return self._lines_of(ChangeType.DELETED)

    def _lines_of(self, change: ChangeType) -> List[int]:
        return sorted(line for line, kind in self.markers.items() if kind is change)

    @property
    def has_changes(self) -> bool:
        return bool(self.markers) or self.is_deleted_file

    @property
    def summary(self) -> str:
        return (
            f"+{len(self.added_lines)} "
            f"~{len(self.modified_lines)} "
            f"-{len(self.deleted_lines)}"
        )

    # -- 查询 --------------------------------------------------------------
    def marker(self, line: int) -> Optional[ChangeType]:
        return self.markers.get(line)

    def markers_in_range(self, first: int, last: int) -> Iterable[LineMarker]:
        for line in sorted(self.markers):
            if first <= line <= last:
                yield LineMarker(line, self.markers[line])

    def clamp_to(self, line_count: int) -> "FileDiff":
        """把超出当前文件行数的标记裁剪到合法范围。"""
        if line_count <= 0:
            return self
        cleaned = {line: kind for line, kind in self.markers.items() if line <= line_count}
        result = FileDiff(
            path=self.path,
            markers=cleaned,
            is_new_file=self.is_new_file,
            is_deleted_file=self.is_deleted_file,
            is_binary=self.is_binary,
            hunk_count=self.hunk_count,
            new_line_count=line_count,
        )
        return result

    @classmethod
    def empty(cls, path: str = "") -> "FileDiff":
        return cls(path=path)


def priority_merge(existing: Optional[ChangeType], new: ChangeType) -> ChangeType:
    """保留优先级更高的标记。"""
    if existing is None:
        return new
    return existing if existing.priority >= new.priority else new
