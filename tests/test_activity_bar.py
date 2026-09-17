"""活动栏测试：点击发信号、视图按钮互斥、跟随连接状态启用、换主题重建图标。"""

from __future__ import annotations

from app.ui.theme import DARK, LIGHT
from app.ui.widgets.activity_bar import ActivityBar, ActivityItem

ITEMS = (
    ActivityItem("files", "资源管理器", "files", checkable=True),
    ActivityItem("source-control", "源代码管理", "source-control", checkable=True),
    ActivityItem("open-folder", "打开远程文件夹…", "folder"),
    ActivityItem("settings", "设置…", "settings", at_bottom=True),
)


def make_bar(qtbot) -> ActivityBar:
    bar = ActivityBar(ITEMS, DARK)
    qtbot.addWidget(bar)
    return bar


def test_click_emits_key_and_checked_state(qtbot) -> None:
    bar = make_bar(qtbot)
    seen = []
    bar.itemTriggered.connect(lambda key, checked: seen.append((key, checked)))

    bar.button("source-control").click()
    assert seen[-1] == ("source-control", True)

    # 再点一次表示「收起」，按钮自身状态要如实上报
    bar.button("source-control").click()
    assert seen[-1] == ("source-control", False)


def test_command_button_reports_unchecked_state(qtbot) -> None:
    """非切换型按钮（连接 / 打开文件夹）也会带上状态，槽函数按 key 分发即可。"""
    bar = make_bar(qtbot)
    seen = []
    bar.itemTriggered.connect(lambda key, checked: seen.append((key, checked)))

    bar.button("open-folder").click()

    assert seen == [("open-folder", False)]
    assert not bar.button("open-folder").isCheckable()


def test_set_view_is_mutually_exclusive(qtbot) -> None:
    bar = make_bar(qtbot)
    bar.set_view("files")
    assert bar.button("files").isChecked()

    bar.set_view("source-control")

    assert bar.button("source-control").isChecked()
    assert not bar.button("files").isChecked()

    # 空 key = 收起侧边栏，所有视图按钮都取消选中
    bar.set_view("")
    assert not bar.button("files").isChecked()
    assert not bar.button("source-control").isChecked()


def test_buttons_can_be_disabled_individually(qtbot) -> None:
    bar = make_bar(qtbot)
    bar.set_enabled("open-folder", False)
    assert not bar.button("open-folder").isEnabled()
    assert bar.button("files").isEnabled()

    bar.set_enabled("open-folder", True)
    assert bar.button("open-folder").isEnabled()


def test_unknown_key_is_ignored(qtbot) -> None:
    bar = make_bar(qtbot)
    bar.set_enabled("no-such-item", False)  # 不该抛异常
    assert bar.button("no-such-item") is None


def test_apply_theme_rebuilds_icons(qtbot) -> None:
    bar = make_bar(qtbot)
    bar.apply_theme(LIGHT)
    for key in ("files", "source-control", "open-folder", "settings"):
        assert not bar.button(key).icon().isNull()
