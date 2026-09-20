"""源代码管理面板测试：只列与仓库不同的文件，空态友好，打开面板不产生远端请求。"""

from __future__ import annotations

from PySide6.QtGui import QColor

from app.git.git_client import FileStatus, build_tree_status
from app.ui.theme import DARK, LIGHT
from app.ui.widgets.badge import BADGE_COLOR_ROLE, BADGE_ROLE
from app.ui.widgets.scm_view import SourceControlView

ROOT = "/home/user/project"


def snapshot():
    statuses = {
        "src/main.c": FileStatus(path="src/main.c", index_status=" ", worktree_status="M"),
        "old.c": FileStatus(path="old.c", index_status=" ", worktree_status="D"),
        "notes.md": FileStatus(path="notes.md", index_status="?", worktree_status="?"),
    }
    return build_tree_status(ROOT, branch="main", statuses=statuses)


def make_view(qtbot, theme=DARK) -> SourceControlView:
    view = SourceControlView(theme)
    qtbot.addWidget(view)
    return view


def items_by_label(view) -> dict:
    return {
        view.tree.topLevelItem(index).text(0): view.tree.topLevelItem(index)
        for index in range(view.tree.topLevelItemCount())
    }


def test_lists_changes_relative_to_the_repository_root(qtbot) -> None:
    view = make_view(qtbot)
    view.set_snapshot(snapshot())

    # VSCode 版式：列表里是「文件名」（父目录单独一段弱化文字），路径不被截断
    assert list(items_by_label(view)) == ["notes.md", "old.c", "main.c"]
    assert view.paths() == [
        f"{ROOT}/notes.md",
        f"{ROOT}/old.c",
        f"{ROOT}/src/main.c",
    ]
    assert view.title.text() == "源代码管理"
    assert view.count_label.text() == "3"


def test_badge_and_colour_follow_the_change_type(qtbot) -> None:
    view = make_view(qtbot)
    view.set_snapshot(snapshot())
    items = items_by_label(view)

    # 徽标挂在最后一列（右端对齐）
    assert items["main.c"].data(1, BADGE_ROLE) == "M"
    assert items["main.c"].data(1, BADGE_COLOR_ROLE) == QColor(DARK.marker_modified)
    assert items["notes.md"].data(1, BADGE_ROLE) == "U"
    assert items["old.c"].data(1, BADGE_ROLE) == "D"
    assert items["old.c"].data(1, BADGE_COLOR_ROLE) == QColor(DARK.marker_deleted)


def test_clean_or_unknown_repository_shows_empty_state(qtbot) -> None:
    view = make_view(qtbot)

    view.set_snapshot(None)
    assert view.paths() == []
    assert view.empty_label.isVisibleTo(view)
    assert not view.tree.isVisibleTo(view)

    view.set_snapshot(build_tree_status(ROOT, branch="main"))
    assert view.paths() == []
    assert view.empty_label.isVisibleTo(view)
    assert not view.tree.isVisibleTo(view)


def test_clicking_an_entry_emits_its_path(qtbot) -> None:
    view = make_view(qtbot)
    view.set_snapshot(snapshot())
    seen = []
    view.fileActivated.connect(seen.append)

    view.tree.itemClicked.emit(view.tree.topLevelItem(0), 0)

    assert seen == [f"{ROOT}/notes.md"]


def test_refresh_button_asks_the_window_for_a_new_snapshot(qtbot) -> None:
    view = make_view(qtbot)
    seen = []
    view.refreshRequested.connect(lambda: seen.append(True))

    view.refresh_button.click()

    assert seen == [True]


def test_apply_theme_repaints_the_refresh_button(qtbot) -> None:
    view = make_view(qtbot)
    view.apply_theme(LIGHT)
    assert not view.refresh_button.icon().isNull()


def test_rows_show_parent_directory_in_the_second_column(qtbot) -> None:
    """父目录单独占一列并弱化显示，文件名本身不会被目录挤掉（VSCode 版式）。"""
    view = make_view(qtbot)
    view.set_snapshot(snapshot())
    items = items_by_label(view)

    assert items["main.c"].text(1) == "src"
    assert items["main.c"].foreground(1).color() == QColor(DARK.gutter_fg)
    # 根目录下的文件没有父目录，那一列留空
    assert items["old.c"].text(1) == ""


def test_commit_button_requires_message_and_changes(qtbot) -> None:
    view = make_view(qtbot)
    assert not view.commit_button.isEnabled()  # 还没有快照

    view.set_snapshot(snapshot())
    assert not view.commit_button.isEnabled()  # 有更改但没写信息

    view.commit_edit.setText("feat: 新增充电对接")
    assert view.commit_button.isEnabled()

    view.commit_edit.setText("   ")  # 纯空白不算
    assert not view.commit_button.isEnabled()


def test_commit_emits_message_and_can_be_cleared(qtbot) -> None:
    view = make_view(qtbot)
    view.set_snapshot(snapshot())
    seen = []
    view.commitRequested.connect(seen.append)

    view.commit_edit.setText("  fix: 修掉对接超时  ")
    view.commit_button.click()

    # 首尾空白被去掉后再发信号
    assert seen == ["fix: 修掉对接超时"]

    view.clear_message()
    assert view.commit_edit.text() == ""


def test_enter_in_message_box_commits(qtbot) -> None:
    view = make_view(qtbot)
    view.set_snapshot(snapshot())
    seen = []
    view.commitRequested.connect(seen.append)

    view.commit_edit.setText("chore: 整理日志")
    view.commit_edit.returnPressed.emit()

    assert seen == ["chore: 整理日志"]


def test_commit_without_changes_does_nothing(qtbot) -> None:
    """仓库干净时即使有信息也不提交（避免跑一次注定失败的 git commit）。"""
    view = make_view(qtbot)
    view.set_snapshot(build_tree_status(ROOT, branch="main"))
    seen = []
    view.commitRequested.connect(seen.append)

    view.commit_edit.setText("空提交")
    view.commit_edit.returnPressed.emit()

    assert seen == []


def test_collapse_hides_the_list(qtbot) -> None:
    view = make_view(qtbot)
    view.set_snapshot(snapshot())
    view.show()

    view.collapse_button.click()
    assert not view.tree.isVisibleTo(view)

    view.collapse_button.click()
    assert view.tree.isVisibleTo(view)
