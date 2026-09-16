"""本地缓存。

需求约束（文档 5.9）：**远程文件才是唯一真实数据源**。
本模块只做体验优化：

* 缓存最近打开的文件内容（断网时可供只读参考）；
* 记录最近打开文件列表与光标位置，用于启动时恢复。

缓存永不用于“静默写回远程”，也不会覆盖远端数据。
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional

from app.config.settings import atomic_write_json, load_json
from app.utils.paths import cache_dir, ensure_dir

logger = logging.getLogger(__name__)

MAX_RECENT_FILES = 50


@dataclass
class RecentFile:
    """最近打开的文件记录。"""

    host_id: str
    path: str
    opened_at: float = field(default_factory=time.time)
    cursor_line: int = 1

    @property
    def label(self) -> str:
        return f"{self.path}"


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FileCache:
    """文件内容缓存 + 最近文件列表。"""

    def __init__(self, root: Optional[Path] = None, *, max_bytes: int = 8 * 1024 * 1024) -> None:
        self.root = root or cache_dir()
        self.max_bytes = max_bytes
        self._recent: List[RecentFile] = []
        self._loaded = False

    # -- 文件内容缓存 ------------------------------------------------------
    def _entry_dir(self, host_id: str, remote_path: str) -> Path:
        key = hashlib.sha256(f"{host_id}:{remote_path}".encode("utf-8")).hexdigest()[:32]
        return ensure_dir(self.root / "files" / key)

    def store(self, host_id: str, remote_path: str, data: bytes) -> Optional[Path]:
        """缓存文件内容；超过上限则跳过（缓存不是必须的）。"""
        if len(data) > self.max_bytes:
            logger.debug("文件过大，跳过缓存：%s", remote_path)
            return None
        directory = self._entry_dir(host_id, remote_path)
        target = directory / "content.bin"
        try:
            target.write_bytes(data)
            atomic_write_json(
                directory / "meta.json",
                {
                    "host_id": host_id,
                    "path": remote_path,
                    "size": len(data),
                    "hash": content_hash(data),
                    "cached_at": time.time(),
                },
            )
        except OSError as exc:  # pragma: no cover - 磁盘问题
            logger.warning("写入缓存失败：%s", exc)
            return None
        return target

    def read(self, host_id: str, remote_path: str) -> Optional[bytes]:
        target = self._entry_dir(host_id, remote_path) / "content.bin"
        if not target.exists():
            return None
        try:
            return target.read_bytes()
        except OSError:  # pragma: no cover
            return None

    def clear(self) -> None:
        import shutil

        if self.root.exists():
            shutil.rmtree(self.root, ignore_errors=True)
        logger.info("缓存已清空：%s", self.root)

    # -- 最近文件 ----------------------------------------------------------
    @property
    def recent_path(self) -> Path:
        return self.root / "recent.json"

    def recent(self) -> List[RecentFile]:
        if not self._loaded:
            raw = load_json(self.recent_path, default=[]) or []
            entries: List[RecentFile] = []
            if isinstance(raw, list):
                for item in raw:
                    if not isinstance(item, dict):
                        continue
                    try:
                        entries.append(
                            RecentFile(
                                host_id=str(item.get("host_id", "")),
                                path=str(item.get("path", "")),
                                opened_at=float(item.get("opened_at", 0)),
                                cursor_line=int(item.get("cursor_line", 1)),
                            )
                        )
                    except (TypeError, ValueError):
                        continue
            self._recent = entries
            self._loaded = True
        return list(self._recent)

    def add_recent(self, host_id: str, path: str, *, cursor_line: int = 1) -> None:
        entries = self.recent()
        entries = [
            entry for entry in entries if not (entry.host_id == host_id and entry.path == path)
        ]
        entries.insert(0, RecentFile(host_id=host_id, path=path, cursor_line=cursor_line))
        self._recent = entries[:MAX_RECENT_FILES]
        try:
            atomic_write_json(self.recent_path, [asdict(entry) for entry in self._recent])
        except Exception as exc:  # pragma: no cover - 缓存写失败不影响主流程
            logger.warning("写入最近文件失败：%s", exc)

    def forget_host(self, host_id: str) -> None:
        self._recent = [entry for entry in self.recent() if entry.host_id != host_id]
        try:
            atomic_write_json(self.recent_path, [asdict(entry) for entry in self._recent])
        except Exception as exc:  # pragma: no cover
            logger.warning("写入最近文件失败：%s", exc)
