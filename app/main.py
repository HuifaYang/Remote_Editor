"""RemoteCodeEditor 程序入口。

用法::

    python -m app.main
"""

from __future__ import annotations

import logging
import sys
from typing import List, Optional, Tuple

from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication

from app.config.hosts import HostStore
from app.config.settings import SettingsStore
from app.ui.fonts import load_bundled_fonts
from app.ui.main_window import MainWindow
from app.ui.theme import apply_theme, apply_ui_font, get_theme, reload_themes
from app.utils.logging_setup import configure_logging, install_exception_hook
from app.utils.paths import APP_NAME, APP_VERSION, resource_path

logger = logging.getLogger(__name__)


def _application_icon() -> Optional[QIcon]:
    """加载应用图标；资源缺失时返回 ``None``（不阻断启动）。"""
    for name in ("icon.png", "icon.ico"):
        path = resource_path("assets", name)
        if path.exists():
            icon = QIcon(str(path))
            if not icon.isNull():
                return icon
    return None


def build_application(argv: Optional[List[str]] = None) -> Tuple[QApplication, MainWindow]:
    """创建 QApplication 与主窗口（便于测试与复用）。"""
    app = QApplication.instance() or QApplication(argv if argv is not None else sys.argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationDisplayName(APP_NAME)
    app.setApplicationVersion(APP_VERSION)
    app.setOrganizationName(APP_NAME)

    icon = _application_icon()
    if icon is not None:
        app.setWindowIcon(icon)

    # 内置字体与主题都在启动时注册：程序自带资源，不依赖目标机器装了什么。
    # 界面字号必须在建控件之前下发（见 apply_ui_font 的说明）。
    load_bundled_fonts()
    apply_ui_font(app)
    settings_store = SettingsStore()
    settings = settings_store.load()
    reload_themes()
    apply_theme(app, get_theme(settings.theme))

    window = MainWindow(
        settings_store=settings_store,
        host_store=HostStore(),
    )
    return app, window


def main(argv: Optional[List[str]] = None) -> int:
    """程序主函数。"""
    configure_logging()
    install_exception_hook()
    app, window = build_application(argv)
    window.install_log_handler()
    window.show()
    logger.info("%s %s 已启动", APP_NAME, APP_VERSION)
    return app.exec()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
