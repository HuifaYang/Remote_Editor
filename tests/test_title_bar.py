"""自绘标题栏测试（用户要求「不要系统标题栏，自己绘制，参考 VSCode」）。

要锁住的行为有三块：

1. 窗口是 frameless 的，标题栏在窗口内部，**真正的 QMenuBar 被搬进了标题栏**
   （不是另建一个 —— 那样菜单和快捷键都会失效）；
2. 窗口按钮：最小化 / 最大化（还原）图标与提示跟着窗口状态走，关闭按钮走正常关闭流程；
3. 无边框窗口必须自己实现的两件事：边缘缩放热区与拖动。

另外「删掉重复的顶部工具栏之后，命令仍然有菜单 / 活动栏入口」在
``test_main_window.py`` 里断言（那里有已连接的窗口 fixture）。
"""

from __future__ import annotations

from PySide6.QtCore import QPoint, QSize, Qt
from PySide6.QtWidgets import QApplication, QMenuBar

from app.cache.file_cache import FileCache
from app.config.hosts import HostStore
from app.config.settings import SettingsStore
from app.ui.main_window import MainWindow
from app.ui.theme import get_theme
from app.ui.widgets.title_bar import (
    RESIZE_MARGIN,
    TITLE_BAR_HEIGHT,
    WindowResizeFilter,
    _edges_for,
)


def make_window(qtbot, tmp_path) -> MainWindow:
    window = MainWindow(
        settings_store=SettingsStore(tmp_path / "settings.json"),
        host_store=HostStore(tmp_path / "hosts.json"),
        cache=FileCache(tmp_path / "cache"),
    )
    window._confirm_exit_with_unsaved = lambda: True  # type: ignore[method-assign]
    qtbot.addWidget(window)
    return window


# ---------------------------------------------------------------------------
# 窗口外壳与菜单栏
# ---------------------------------------------------------------------------


def test_window_is_frameless_with_a_self_drawn_title_bar(qtbot, tmp_path) -> None:
    window = make_window(qtbot, tmp_path)

    assert window.windowFlags() & Qt.WindowType.FramelessWindowHint
    assert window.menuWidget() is window.title_bar
    assert window.title_bar.height() == TITLE_BAR_HEIGHT
    assert window.title_bar.isAncestorOf(window.title_bar.title_label)


def test_menu_bar_is_the_real_one_and_lives_in_the_title_bar(qtbot, tmp_path) -> None:
    """菜单栏必须是 QMainWindow 自己那一个，只是被搬进了标题栏。

    自己 new 一个 QMenuBar 也「看起来能用」，但 Qt 下次调用 menuBar() 时会另建一个、
    把菜单 widget 顶掉 —— 所以这里断言的是**同一个对象**与**父控件**。
    """
    window = make_window(qtbot, tmp_path)
    menu_bar = window.title_bar.menu_bar

    assert isinstance(menu_bar, QMenuBar)
    assert window.menuBar() is menu_bar
    assert menu_bar.parent() is window.title_bar
    assert [action.text() for action in menu_bar.actions()] == ["文件", "编辑", "终端", "视图", "帮助"]

    file_menu = menu_bar.actions()[0].menu()
    texts = [action.text() for action in file_menu.actions() if not action.isSeparator()]
    assert "连接主机…" in texts
    assert "设置…" in texts


def test_menu_bar_is_visible_inside_the_title_bar(qtbot, tmp_path) -> None:
    """setMenuWidget() 会把原菜单栏隐藏，搬完之后必须显式恢复显示。"""
    window = make_window(qtbot, tmp_path)
    window.show()

    qtbot.waitUntil(lambda: window.title_bar.menu_bar.isVisible(), timeout=2000)
    assert window.title_bar.menu_bar.height() <= TITLE_BAR_HEIGHT


def test_title_label_mirrors_the_window_title(qtbot, tmp_path) -> None:
    window = make_window(qtbot, tmp_path)

    assert window.title_bar.title_label.text() == window.windowTitle()
    assert "RemoteCodeEditor" in window.title_bar.title_label.text()


# ---------------------------------------------------------------------------
# 窗口按钮
# ---------------------------------------------------------------------------


def test_window_buttons_have_icons_and_tooltips(qtbot, tmp_path) -> None:
    window = make_window(qtbot, tmp_path)

    for name, tooltip in (("window_minimize", "最小化"), ("window_maximize", "最大化")):
        button = window.title_bar._buttons[name]
        assert button.toolTip() == tooltip
        assert not button.icon().isNull()


def test_maximize_button_toggles_state_and_switches_its_icon(qtbot, tmp_path) -> None:
    window = make_window(qtbot, tmp_path)
    window.show()
    button = window.title_bar._buttons["window_maximize"]
    normal_icon = button.icon().cacheKey()

    button.click()
    assert window.isMaximized()
    assert button.toolTip() == "还原"
    assert button.icon().cacheKey() != normal_icon

    button.click()
    assert not window.isMaximized()
    assert button.toolTip() == "最大化"


def test_window_state_change_keeps_the_button_in_sync(qtbot, tmp_path) -> None:
    """窗口被系统或双击最大化时（不是点按钮），图标也要跟上。"""
    window = make_window(qtbot, tmp_path)
    window.show()

    window.showMaximized()
    assert window.title_bar._buttons["window_maximize"].toolTip() == "还原"

    window.showNormal()
    assert window.title_bar._buttons["window_maximize"].toolTip() == "最大化"


def test_close_button_closes_the_window(qtbot, tmp_path) -> None:
    window = make_window(qtbot, tmp_path)
    window.show()

    window.title_bar._buttons["window_close"].click()

    assert not window.isVisible()


def test_theme_switch_rebuilds_window_button_icons(qtbot, tmp_path) -> None:
    window = make_window(qtbot, tmp_path)
    before = window.title_bar._buttons["window_close"].icon().cacheKey()

    window.theme = get_theme("light")
    window._apply_settings_to_ui()

    assert window.title_bar._buttons["window_close"].icon().cacheKey() != before


# ---------------------------------------------------------------------------
# 边缘缩放热区（纯函数 + 事件过滤器）
# ---------------------------------------------------------------------------


def test_edges_for_covers_borders_and_corners() -> None:
    size = QSize(100, 50)

    assert _edges_for(QPoint(0, 0), size) == Qt.Edge.TopEdge | Qt.Edge.LeftEdge
    assert _edges_for(QPoint(99, 49), size) == Qt.Edge.RightEdge | Qt.Edge.BottomEdge
    assert _edges_for(QPoint(50, 0), size) == Qt.Edge.TopEdge
    assert _edges_for(QPoint(0, 25), size) == Qt.Edge.LeftEdge
    assert _edges_for(QPoint(50, 25), size) == Qt.Edge(0)  # 窗口中间不是热区


def test_edges_for_boundary_is_exactly_the_margin() -> None:
    size = QSize(100, 50)

    assert _edges_for(QPoint(RESIZE_MARGIN, 25), size) == Qt.Edge.LeftEdge
    assert _edges_for(QPoint(RESIZE_MARGIN + 1, 25), size) == Qt.Edge(0)
    assert _edges_for(QPoint(50, RESIZE_MARGIN), size) == Qt.Edge.TopEdge
    assert _edges_for(QPoint(50, RESIZE_MARGIN + 1), size) == Qt.Edge(0)


def test_resize_filter_is_held_by_the_window(qtbot, tmp_path) -> None:
    """事件过滤器挂在 QApplication 上，引用必须由窗口持有，否则会被 GC 掉。"""
    window = make_window(qtbot, tmp_path)

    assert isinstance(window._resize_filter, WindowResizeFilter)
    assert window._resize_filter.parent() is window
    assert QApplication.instance() is not None


def test_resize_filter_ignores_points_outside_and_the_maximized_window(qtbot, tmp_path) -> None:
    window = make_window(qtbot, tmp_path)
    window.show()
    resize_filter = window._resize_filter

    assert resize_filter._edges_at(QPoint(20000, 20000)) == Qt.Edge(0)

    window.showMaximized()
    assert resize_filter._edges_at(window.frameGeometry().topLeft()) == Qt.Edge(0)
    window.showNormal()


# ---------------------------------------------------------------------------
# 拖动（无边框窗口没有系统标题栏，只能自己拖）
# ---------------------------------------------------------------------------


def test_title_bar_drag_moves_the_window(qtbot, tmp_path) -> None:
    window = make_window(qtbot, tmp_path)
    window.show()
    window.move(200, 200)
    start = window.pos()
    middle = TITLE_BAR_HEIGHT // 2
    target = QPoint(120, middle + 25)

    qtbot.mousePress(window.title_bar, Qt.MouseButton.LeftButton, pos=QPoint(80, middle))
    qtbot.mouseMove(window.title_bar, target)
    qtbot.mouseRelease(window.title_bar, Qt.MouseButton.LeftButton, pos=target)

    # 拖动被窗口管理器接管时（startSystemMove 返回 True）位置由系统决定；
    # 这里只要求自己实现的兜底路径不炸，并且真的把窗口挪了位置
    assert window.pos() != start
