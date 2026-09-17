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

    # 和 VSCode 一样显示相对仓库根的路径，而不是一长串绝对路径
    assert list(items_by_label(view)) == ["notes.md", "old.c", "src/main.c"]
    assert view.paths() == [
        f"{ROOT}/notes.md",
        f"{ROOT}/old.c",
        f"{ROOT}/src/main.c",
    ]
    assert "3 处更改" in view.title.text()


def test_badge_and_colour_follow_the_change_type(qtbot) -> None:
    view = make_view(qtbot)
    view.set_snapshot(snapshot())
    items = items_by_label(view)

    assert items["src/main.c"].data(0, BADGE_ROLE) == "M"
    assert items["src/main.c"].data(0, BADGE_COLOR_ROLE) == QColor(DARK.marker_modified)
    assert items["notes.md"].data(0, BADGE_ROLE) == "U"
    assert items["old.c"].data(0, BADGE_ROLE) == "D"
    assert items["old.c"].data(0, BADGE_COLOR_ROLE) == QColor(DARK.marker_deleted)


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
