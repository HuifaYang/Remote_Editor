"""编辑器文档模型：与 Qt 控件解耦，便于单测。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from app.git.models import FileDiff
from app.remote.remote_fs import FileFingerprint


@dataclass
class Document:
    """一个打开的远程文件。"""

    remote_path: str
    host_id: str = ""
    text: str = ""
    saved_text: Optional[str] = None
    #: 打开时从远端读到的原始内容（判断「撤销回原样」时要用到，不随保存变化）
    loaded_text: str = ""
    #: 打开时该文件相对 HEAD 是否干净（来自文件树快照，快照答不上来时为 ``False``）
    clean_at_open: bool = False
    encoding: str = "utf-8"
    newline: str = "\n"
    language: str = "Plain Text"
    read_only: bool = False
    is_new_file: bool = False
    diff: FileDiff = field(default_factory=FileDiff)
    fingerprint: Optional[FileFingerprint] = None
    cursor_line: int = 1
    cursor_column: int = 1

    def __post_init__(self) -> None:
        # 未显式给出 saved_text 时，认为当前内容即已保存内容
        if self.saved_text is None:
            self.saved_text = self.text
        if not self.loaded_text:
            self.loaded_text = self.text

    @property
    def reverted(self) -> bool:
        """内容是否已经回到打开时的样子，且当时本来就是干净的。

        「撤销掉全部修改」之后文件相对 ``HEAD`` 依然干净，文件树着色应当撤掉。
        """
        return self.clean_at_open and self.text == self.loaded_text

    # -- 状态 --------------------------------------------------------------
    @property
    def dirty(self) -> bool:
        return self.text != self.saved_text

    @property
    def display_name(self) -> str:
        return self.remote_path.rstrip("/").rsplit("/", 1)[-1] or self.remote_path

    @property
    def tab_title(self) -> str:
        return f"{self.display_name}{'*' if self.dirty else ''}"

    def mark_saved(self, text: Optional[str] = None) -> None:
        if text is not None:
            self.text = text
        self.saved_text = self.text
        self.dirty_state_forgotten()

    def dirty_state_forgotten(self) -> None:
        """占位：dirty 由文本比较得出，无需额外状态。"""

    def apply_diff(self, diff: FileDiff) -> None:
        self.diff = diff

    # -- 文本操作 ----------------------------------------------------------
    def line_count(self) -> int:
        return len(self.text.splitlines())

    def replace_text(self, text: str) -> None:
        self.text = text
