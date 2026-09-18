"""文件图标主题（VSCode 文件图标主题规范）。

资源管理器里的**文件 / 文件夹图标**由图标主题决定，与 :mod:`app.ui.icons`
（工具栏那套自绘图标）是两回事：

* 主题文件是一份 JSON（``iconDefinitions`` / ``fileNames`` / ``fileExtensions`` /
  ``folderNames`` …），图标本体是 SVG 或 PNG，按 VSCode 的解析顺序取用；
  Material Icon Theme 等开源主题可直接放进来用；
* 找不到主题、或主题里没定义某个类型时返回 ``None``，由调用方回退到自绘 /
  系统图标，所以**没有任何图标主题时程序照常运行**。

SVG 由 PySide6 自带的 ``QtSvg`` 渲染，不引入第三方依赖。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QGuiApplication, QIcon, QPainter, QPixmap

from app.utils.paths import config_dir, resource_path

try:  # QtSvg 随 PySide6 一起分发；缺失时只影响 SVG 图标
    from PySide6.QtSvg import QSvgRenderer
except ImportError:  # pragma: no cover - 环境裁剪掉了 QtSvg
    QSvgRenderer = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

#: 图标逻辑尺寸（与文件树的 22px 行高配套）
ICON_SIZE = 16
#: 优先匹配的主题文件名，都没有时扫描目录里任意含 iconDefinitions 的 JSON
_PREFERRED_THEME_FILES = (
    "material-icons.json",
    "material-icon-theme.json",
    "icon-theme.json",
)


def bundled_icon_theme_dir() -> Path:
    return resource_path("assets", "icon-themes")


def user_icon_theme_dir() -> Path:
    """用户文件图标主题目录（打包之后仍然可写）：每个子目录是一套图标主题。"""
    return config_dir() / "icon-themes"


def icon_theme_dirs() -> Tuple[Path, ...]:
    """图标主题搜索目录：随程序分发的 ``assets/icon-themes`` 与用户配置目录。"""
    return (bundled_icon_theme_dir(), user_icon_theme_dir())


def render_icon_pixmap(path: Path, size: int = ICON_SIZE) -> Optional[QPixmap]:
    """把 SVG / PNG 图标渲染成 ``size`` 见方的像素图；失败返回 ``None``。"""
    if QGuiApplication.instance() is None:  # 还没有 QApplication 时不能建 QPixmap
        return None
    if path.suffix.lower() == ".svg":
        if QSvgRenderer is None:
            return None
        renderer = QSvgRenderer(str(path))
        if not renderer.isValid():
            logger.debug("SVG 图标无效: %s", path)
            return None
        pixmap = QPixmap(size, size)
        pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap)
        renderer.render(painter)
        painter.end()
        return pixmap
    pixmap = QPixmap(str(path))
    if pixmap.isNull():
        return None
    return pixmap.scaled(
        size,
        size,
        Qt.AspectRatioMode.KeepAspectRatio,
        Qt.TransformationMode.SmoothTransformation,
    )


@dataclass
class FileIconTheme:
    """一套文件图标主题。"""

    name: str
    display_name: str
    path: Path
    definitions: Dict[str, Any] = field(default_factory=dict)
    file: str = ""
    folder: str = ""
    folder_expanded: str = ""
    file_names: Dict[str, str] = field(default_factory=dict)
    file_extensions: Dict[str, str] = field(default_factory=dict)
    folder_names: Dict[str, str] = field(default_factory=dict)
    folder_names_expanded: Dict[str, str] = field(default_factory=dict)
    _cache: Dict[Tuple[str, int], QIcon] = field(default_factory=dict, repr=False)

    # -- 解析 --------------------------------------------------------------
    def icon_id_for(self, name: str, *, is_dir: bool, expanded: bool = False) -> str:
        """按 VSCode 的顺序解析图标 id：精确文件名 → 扩展名 → 默认图标。"""
        key = (name or "").lower()
        if is_dir:
            table = self.folder_names_expanded if expanded else self.folder_names
            if key in table:
                return table[key]
            return (self.folder_expanded if expanded else "") or self.folder
        if key in self.file_names:
            return self.file_names[key]
        for extension in self._extension_keys(key):
            if extension in self.file_extensions:
                return self.file_extensions[extension]
        return self.file

    @staticmethod
    def _extension_keys(name: str) -> List[str]:
        """候选扩展名，长的在前（``a.tar.gz`` → ``["tar.gz", "gz"]``）。"""
        parts = name.split(".")
        return [".".join(parts[index:]) for index in range(1, len(parts))]

    def icon_path(self, icon_id: str) -> Optional[Path]:
        definition = self.definitions.get(icon_id)
        if not isinstance(definition, dict):
            return None
        relative = definition.get("iconPath")
        if not isinstance(relative, str) or not relative:
            return None
        candidate = (self.path / relative).resolve()
        if candidate.is_file():
            return candidate
        # 主题包把 JSON 与 icons 目录放在不同层级时（Material Icon Theme 的 dist/ 布局），
        # 按文件名在主题目录附近再找一次
        for folder in (
            self.path,
            self.path.parent,
            self.path / "icons",
            self.path.parent / "icons",
        ):
            found = folder / Path(relative).name
            if found.is_file():
                return found
        logger.debug("图标文件不存在: %s（主题 %s）", relative, self.name)
        return None

    def icon_for(
        self, name: str, *, is_dir: bool, expanded: bool = False, size: int = ICON_SIZE
    ) -> Optional[QIcon]:
        """取某个文件 / 文件夹的图标；主题没定义时返回 ``None``。"""
        icon_id = self.icon_id_for(name, is_dir=is_dir, expanded=expanded)
        if not icon_id:
            return None
        cached = self._cache.get((icon_id, size))
        if cached is not None:
            return cached
        path = self.icon_path(icon_id)
        if path is None:
            return None
        pixmap = render_icon_pixmap(path, size)
        if pixmap is None:
            return None
        icon = QIcon(pixmap)
        hidpi = render_icon_pixmap(path, size * 2)  # 附 2 倍图，高分屏下不糊
        if hidpi is not None:
            icon.addPixmap(hidpi)
        self._cache[(icon_id, size)] = icon
        return icon


def _looks_like_icon_theme(path: Path) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(data, dict) and isinstance(data.get("iconDefinitions"), dict)


def _display_name(data: Dict[str, Any], directory: Path, theme_file: Path) -> str:
    """主题显示名：JSON 里的 ``name`` 优先，其次上游扩展的 ``package.json``，最后用目录名。"""
    name = data.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    for candidate in (
        theme_file.parent / "package.json",
        theme_file.parent.parent / "package.json",
        directory / "package.json",
    ):
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        for key in ("displayName", "name"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return directory.name


def _find_theme_json(directory: Path) -> Optional[Path]:
    """在主题目录里找主题 JSON。

    先看目录根部，再下探**一级**子目录 —— 上游把 JSON 放在 ``dist/`` 里打包是常见做法
    （Material Icon Theme 就是），用户直接解压 vsix 放进来的目录也能被认出来。
    """
    search_dirs = [directory]
    search_dirs += sorted(item for item in directory.iterdir() if item.is_dir())
    for folder in search_dirs:  # 先按约定的文件名找
        for name in _PREFERRED_THEME_FILES:
            candidate = folder / name
            if candidate.is_file():
                return candidate
    for folder in search_dirs:  # 再退化为「任意一个长得像主题的 JSON」
        for candidate in sorted(folder.glob("*.json")):
            if _looks_like_icon_theme(candidate):
                return candidate
    return None


def load_icon_theme(directory: Path) -> Optional[FileIconTheme]:
    """从一个目录加载图标主题；目录里没有合法主题时返回 ``None``。"""
    directory = Path(directory)
    if not directory.is_dir():
        return None
    theme_file = _find_theme_json(directory)
    if theme_file is None:
        return None
    try:
        data = json.loads(theme_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("读取图标主题 %s 失败: %s", theme_file, exc)
        return None
    if not isinstance(data, dict) or not isinstance(data.get("iconDefinitions"), dict):
        return None

    def table(key: str) -> Dict[str, str]:
        raw = data.get(key)
        if not isinstance(raw, dict):
            return {}
        return {str(k).lower(): str(v) for k, v in raw.items() if isinstance(v, str)}

    def single(key: str) -> str:
        value = data.get(key)
        return value if isinstance(value, str) else ""

    return FileIconTheme(
        name=directory.name,
        display_name=_display_name(data, directory, theme_file),
        path=theme_file.parent,
        definitions=data["iconDefinitions"],
        file=single("file"),
        folder=single("folder"),
        folder_expanded=single("folderExpanded"),
        file_names=table("fileNames"),
        file_extensions=table("fileExtensions"),
        folder_names=table("folderNames"),
        folder_names_expanded=table("folderNamesExpanded"),
    )


def available_icon_themes() -> Tuple[FileIconTheme, ...]:
    """扫描所有图标主题目录（同名只保留第一个）。"""
    themes: List[FileIconTheme] = []
    seen: set = set()
    for parent in icon_theme_dirs():
        if not parent.is_dir():
            continue
        for directory in sorted(parent.iterdir()):
            if not directory.is_dir():
                continue
            theme = load_icon_theme(directory)
            if theme is None or theme.name in seen:
                continue
            seen.add(theme.name)
            themes.append(theme)
    return tuple(themes)


def get_icon_theme(name: str) -> Optional[FileIconTheme]:
    """按名称取图标主题；名字为空或不存在时返回 ``None``（即用默认图标）。"""
    if not name:
        return None
    for theme in available_icon_themes():
        if theme.name == name:
            return theme
    return None


def icon_size() -> QSize:
    return QSize(ICON_SIZE, ICON_SIZE)
