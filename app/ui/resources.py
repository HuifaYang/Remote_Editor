"""用户可替换资源目录：打包之后依然能自己加主题 / 字体 / 文件图标。

程序自带的资源放在 ``assets/`` 下，打包成 AppImage / exe 之后被 PyInstaller
``--onefile`` 解压到临时目录，**用户没法直接替换**。所以三类资源都额外支持
「配置目录」这一层：

======================  ============================  =========================
资源                     用户目录                       放什么
======================  ============================  =========================
配色主题                 ``<配置目录>/themes/``         VSCode 主题 ``*.json``
字体                     ``<配置目录>/fonts/``          ``.ttf/.otf/.ttc/.otc``
文件图标主题             ``<配置目录>/icon-themes/``    每个子目录一套图标主题
======================  ============================  =========================

搜索顺序是「随程序分发 → 用户目录」，**同一名字时内置资源优先**（也就是说用户目录
用来*新增*资源）。目录在哪里由 :func:`app.utils.paths.config_dir` 决定，各平台的实际
路径见 ``docs/packaging.md``；设置对话框的「外观 → 资源目录」里有「打开」按钮，
点开的就是这个目录。
"""

from __future__ import annotations

from pathlib import Path
from typing import Tuple

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices

from app.ui.fonts import user_font_dir
from app.ui.icon_theme import user_icon_theme_dir
from app.ui.theme import user_theme_dir
from app.utils.paths import config_dir, ensure_dir

#: 设置对话框里展示给用户的一句话说明（与 docs/packaging.md 保持一致）
RESOURCE_HINT = "themes/ 放配色主题（VSCode JSON），fonts/ 放字体，icon-themes/ 放文件图标主题。"


def resource_root() -> Path:
    """三类用户资源的公共父目录（即配置目录）。"""
    return config_dir()


def user_resource_dirs() -> Tuple[Path, Path, Path]:
    """``(配色主题, 字体, 文件图标主题)`` 三个用户目录（只给路径，不创建）。"""
    return (user_theme_dir(), user_font_dir(), user_icon_theme_dir())


def ensure_user_resource_dirs() -> Tuple[Path, Path, Path]:
    """确保三个用户资源目录都存在（点「打开资源目录」时调用）。"""
    theme_dir, font_dir, icon_dir = user_resource_dirs()
    return (ensure_dir(theme_dir), ensure_dir(font_dir), ensure_dir(icon_dir))


def open_in_file_manager(path: Path) -> bool:
    """用系统文件管理器打开目录；无桌面环境时返回 ``False``（不抛异常）。"""
    return QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))


def open_resource_dir() -> bool:
    """建好目录再打开，返回是否成功发起（纯 GUI 动作，测试里会被替换掉）。"""
    ensure_dir(resource_root())
    ensure_user_resource_dirs()
    return open_in_file_manager(resource_root())
