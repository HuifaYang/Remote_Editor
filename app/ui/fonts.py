"""内置字体：把 ``assets/fonts`` 里的字体注册进 Qt。

为了让界面和编辑器在**任何机器上**都长得一样（不依赖用户系统装了什么字体），
项目把用到的字体直接放在 ``assets/fonts`` 下，启动时批量注册。字体目录为空时
一切照旧（回退到系统字体），所以没放字体也不会启动失败。

只负责注册与查询，不硬编码任何字体名；配色依旧只来自 :mod:`app.ui.theme`。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from PySide6.QtGui import QFontDatabase, QGuiApplication

from app.utils.paths import config_dir, resource_path

logger = logging.getLogger(__name__)

#: 会尝试注册的字体文件后缀（Qt 支持 TTF / OTF，以及 TTC / OTC 集合）
FONT_SUFFIXES: Tuple[str, ...] = (".ttf", ".otf", ".ttc", ".otc")

#: 等宽字体偏好顺序：内置字体里排在前面的优先
MONOSPACE_PREFERENCE: Tuple[str, ...] = (
    "JetBrains Mono",
    "Cascadia Code",
    "Cascadia Mono",
    "Fira Code",
    "Source Code Pro",
    "IBM Plex Mono",
    "Hack",
    "Noto Sans Mono",
    "DejaVu Sans Mono",
)

#: 界面字体偏好顺序。**必须优先选带中文字形的字体**：Qt 的默认界面字体往往是
#: DejaVu Sans，中文会回退到点阵化的兜底字体，笔画粗糙、边界发虚 —— 这是
#: 「界面看起来很旧」的主要原因之一。
UI_FONT_PREFERENCE: Tuple[str, ...] = (
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "Microsoft YaHei UI",
    "Microsoft YaHei",
    "PingFang SC",
    "Noto Sans SC",
    "Segoe UI",
    "Ubuntu",
    "Noto Sans",
    "DejaVu Sans",
)

_loaded_families: List[str] = []


def bundled_font_dir() -> Path:
    return resource_path("assets", "fonts")


def user_font_dir() -> Path:
    """用户字体目录（打包之后仍然可写）：放进去的字体同样会在启动时注册。"""
    return config_dir() / "fonts"


def load_bundled_fonts(directory: Optional[Path] = None) -> List[str]:
    """注册内置字体（以及用户字体目录），返回本次新注册的字体族名。

    ``directory`` 显式给出时只加载该目录（测试与打包场景用），否则依次加载
    ``assets/fonts``（随程序分发）与 ``<配置目录>/fonts``（用户自己放，
    打包成 AppImage / exe 之后仍然可写）。可重复调用，结果稳定。
    """
    if QGuiApplication.instance() is None:
        # 没有 QApplication 时注册字体在 Qt 里是未定义行为（会直接崩），
        # 这里安全跳过；调用方应在建好 QApplication 之后再调用本函数。
        logger.debug("尚无 QApplication，跳过内置字体注册")
        return list(_loaded_families)
    folders = [Path(directory)] if directory is not None else [bundled_font_dir(), user_font_dir()]
    for folder in folders:
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            if path.suffix.lower() not in FONT_SUFFIXES or not path.is_file():
                continue
            font_id = QFontDatabase.addApplicationFont(str(path))
            if font_id < 0:
                logger.warning("字体注册失败: %s", path.name)
                continue
            for family in QFontDatabase.applicationFontFamilies(font_id):
                if family and family not in _loaded_families:
                    _loaded_families.append(family)
                    logger.info("已载入字体: %s（%s）", family, path.name)
    return list(_loaded_families)


def loaded_families() -> Tuple[str, ...]:
    """已注册的内置字体族（按注册顺序）。"""
    return tuple(_loaded_families)


def preferred_monospace_family(candidates: Sequence[str] = MONOSPACE_PREFERENCE) -> str:
    """在已注册的内置字体里挑一个等宽字体；没有内置字体时返回空串。"""
    families = set(_loaded_families)
    for name in candidates:
        if name in families:
            return name
    return ""


def preferred_ui_family(candidates: Sequence[str] = UI_FONT_PREFERENCE) -> str:
    """挑一个带中文字形、且本机真实可用的界面字体族；都没有时返回空串。"""
    if QGuiApplication.instance() is None:
        return ""
    available = set(QFontDatabase.families())
    for name in candidates:
        if name in available:
            return name
    return ""


def reset_cache() -> None:
    """仅供测试：清空已注册字体的记录（不卸载 Qt 里已注册的字体）。"""
    _loaded_families.clear()
