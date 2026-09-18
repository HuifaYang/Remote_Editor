"""远程文件树控件测试：Git 状态着色与列布局（VSCode 风格）。"""

from __future__ import annotations

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QImage
from app.git.git_client import FileStatus, build_tree_status
from app.remote.sftp_client import RemoteEntry
from app.ui.theme import DARK, LIGHT
from app.ui.widgets.file_tree import (
    CHANGE_ROLE,
    DIR_ROLE,
    PATH_ROLE,
    ROW_HEIGHT,
    RemoteFileTree,
)
from app.ui.widgets.badge import BADGE_COLOR_ROLE, BADGE_MARGIN, BADGE_ROLE, BADGE_SIZE

ROOT = "/home/user/project"
MAIN_C = f"{ROOT}/src/main.c"
UTIL_C = f"{ROOT}/src/util.c"
NEW_MD = f"{ROOT}/notes.md"


def make_entry(name: str, path: str, *, is_dir: bool = False, size: int = 120) -> RemoteEntry:
    return RemoteEntry(name=name, path=path, is_dir=is_dir, size=0 if is_dir else size, mtime=0)


def make_tree(qtbot, *, width: int = 420, theme=DARK) -> RemoteFileTree:
    tree = RemoteFileTree(theme=theme)
    qtbot.addWidget(tree)
    tree.resize(width, 400)
    # 需要 show 之后 viewport 才会跟随控件宽度（列布局依赖 viewport 宽度）
    tree.show()
    return tree


def render_viewport(tree: RemoteFileTree) -> QImage:
    """把文件树画到离屏图上，用于逐像素检查文字排版。"""
    image = QImage(tree.viewport().size(), QImage.Format.Format_RGB32)
    image.fill(QColor(DARK.panel_bg))
    tree.viewport().render(image)
    return image


def ink_mask(image: QImage, rect: QRect) -> tuple:
    """rect 内的「画上去的笔画」掩码：只关心有没有落笔，不关心具体颜色。

    着色行与未着色行只差文字颜色，比颜色没意义，比笔画位置才能看出「画了两遍」。
    """
    background = QColor(DARK.panel_bg).rgb() & 0xFFFFFF
    return tuple(
        1 if (image.pixel(x, y) & 0xFFFFFF) != background else 0
        for y in range(rect.top(), rect.bottom())
        for x in range(rect.left(), rect.right())
    )

def snapshot_with_changes():
    statuses = {
        "src/main.c": FileStatus(path="src/main.c", index_status=" ", worktree_status="M"),
        "src/util.c": FileStatus(path="src/util.c", index_status=" ", worktree_status="D"),
        "notes.md": FileStatus(path="notes.md", index_status="?", worktree_status="?"),
    }
    return build_tree_status(ROOT, branch="main", statuses=statuses)


def fill(tree: RemoteFileTree, entries) -> None:
    tree.set_root(ROOT)
    tree.set_children(ROOT, entries)


def child(tree: RemoteFileTree, index: int):
    return tree.topLevelItem(0).child(index)


def item_for(tree: RemoteFileTree, path: str):
    """按路径取节点（列表已按「目录在前 + 名称」排序，不能靠插入顺序）。"""
    stack = [tree.topLevelItem(0)]
    while stack:
        item = stack.pop()
        if item is not None and item.data(0, PATH_ROLE) == path:
            return item
        if item is not None:
            stack.extend(item.child(index) for index in range(item.childCount()))
    raise AssertionError(f"未找到节点：{path}")


# ---------------------------------------------------------------------------
# Git 状态着色
# ---------------------------------------------------------------------------


def test_unchanged_files_stay_uncolored(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(
        tree,
        [
            make_entry("src", f"{ROOT}/src", is_dir=True),
            make_entry("README.md", f"{ROOT}/README.md"),
        ],
    )

    tree.set_status_snapshot(snapshot_with_changes())

    readme = item_for(tree, f"{ROOT}/README.md")
    assert readme.data(0, CHANGE_ROLE) == ""
    assert readme.data(0, Qt.ItemDataRole.ForegroundRole) is None
    assert "Git:" not in readme.toolTip(0)


def test_changed_files_use_theme_marker_colors(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(
        tree,
        [
            make_entry("src", f"{ROOT}/src", is_dir=True),
            make_entry("main.c", MAIN_C),
            make_entry("util.c", UTIL_C),
            make_entry("notes.md", NEW_MD),
        ],
    )

    tree.set_status_snapshot(snapshot_with_changes())

    assert item_for(tree, MAIN_C).foreground(0).color() == QColor(DARK.marker_modified)
    assert item_for(tree, UTIL_C).foreground(0).color() == QColor(DARK.marker_deleted)
    assert item_for(tree, NEW_MD).foreground(0).color() == QColor(DARK.marker_added)
    # 目录取子树内优先级最高的变更（删除 > 新增 > 修改）
    assert item_for(tree, f"{ROOT}/src").foreground(0).color() == QColor(DARK.marker_deleted)
    # 仓库根同样被着色
    assert tree.topLevelItem(0).foreground(0).color() == QColor(DARK.marker_deleted)
    assert item_for(tree, MAIN_C).data(0, CHANGE_ROLE) == "modified"


def test_status_colors_follow_theme_switch(qtbot) -> None:
    tree = make_tree(qtbot, theme=DARK)
    fill(tree, [make_entry("main.c", MAIN_C)])
    tree.set_status_snapshot(snapshot_with_changes())
    item = child(tree, 0)
    assert item.foreground(0).color() == QColor(DARK.marker_modified)

    tree.apply_theme(LIGHT)

    assert item.foreground(0).color() == QColor(LIGHT.marker_modified)


def test_clearing_snapshot_removes_colors(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(tree, [make_entry("main.c", MAIN_C)])
    tree.set_status_snapshot(snapshot_with_changes())
    item = child(tree, 0)
    assert item.foreground(0).color() == QColor(DARK.marker_modified)

    tree.set_status_snapshot(None)

    assert item.data(0, Qt.ItemDataRole.ForegroundRole) is None
    assert item.data(0, CHANGE_ROLE) == ""


def test_lazily_listed_children_inherit_snapshot(qtbot) -> None:
    """快照先到、目录后展开时，新列出的子节点也要着色。"""
    tree = make_tree(qtbot)
    tree.set_root(ROOT)
    tree.set_status_snapshot(snapshot_with_changes())

    tree.set_children(ROOT, [make_entry("src", f"{ROOT}/src", is_dir=True)])
    tree.set_children(f"{ROOT}/src", [make_entry("main.c", MAIN_C)])

    child_item = child(tree, 0).child(0)
    assert child_item.data(0, CHANGE_ROLE) == "modified"
    assert child_item.foreground(0).color() == QColor(DARK.marker_modified)


def test_status_tooltip_mentions_git_state(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(tree, [make_entry("main.c", MAIN_C)])
    item = child(tree, 0)
    assert "Git:" not in item.toolTip(0)

    tree.set_status_snapshot(snapshot_with_changes())

    assert "Git: 已修改" in item.toolTip(0)
    assert MAIN_C in item.toolTip(0)


def test_untracked_tooltip_marks_new_file(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(tree, [make_entry("notes.md", NEW_MD)])
    tree.set_status_snapshot(snapshot_with_changes())
    assert "Git: 未跟踪" in child(tree, 0).toolTip(0)


def test_change_for_helper(qtbot) -> None:
    tree = make_tree(qtbot)
    assert tree.change_for(MAIN_C) is None
    tree.set_status_snapshot(snapshot_with_changes())
    assert tree.change_for(MAIN_C).value == "modified"
    assert tree.change_for(f"{ROOT}/src", is_dir=True).value == "deleted"


def test_snapshot_refresh_recolors_existing_items(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(tree, [make_entry("main.c", MAIN_C)])
    tree.set_status_snapshot(snapshot_with_changes())
    assert child(tree, 0).foreground(0).color() == QColor(DARK.marker_modified)

    tree.set_status_snapshot(build_tree_status(ROOT, branch="main"))

    assert child(tree, 0).data(0, CHANGE_ROLE) == ""
    assert child(tree, 0).data(0, Qt.ItemDataRole.ForegroundRole) is None


def test_loading_placeholder_survives_recolor(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(tree, [make_entry("main.c", MAIN_C)])
    tree.set_status_snapshot(snapshot_with_changes())
    tree.mark_loading(ROOT)
    tree.set_status_snapshot(snapshot_with_changes())  # 占位节点没有 PATH_ROLE，不应崩溃
    assert child(tree, 0).text(0) == "加载中…"


def test_items_keep_path_role_and_directory_flag(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(tree, [make_entry("src", f"{ROOT}/src", is_dir=True), make_entry("main.c", MAIN_C)])
    tree.set_status_snapshot(snapshot_with_changes())
    assert child(tree, 0).data(0, PATH_ROLE) == f"{ROOT}/src"
    assert child(tree, 0).data(0, DIR_ROLE) is True
    assert child(tree, 1).data(0, DIR_ROLE) is False


# ---------------------------------------------------------------------------
# VSCode 式单列布局
# ---------------------------------------------------------------------------


def test_tree_has_a_single_name_column(qtbot) -> None:
    """只有一列文件名：不会再出现「名称被挤成 command_handl…」的情况。"""
    tree = make_tree(qtbot, width=420)
    assert tree.columnCount() == 1
    assert tree.isHeaderHidden()
    tree.resize(420, 400)
    tree.show()
    assert tree.columnWidth(0) == tree.viewport().width()


def test_rows_are_compact_and_equal_height(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(tree, [make_entry("src", f"{ROOT}/src", is_dir=True), make_entry("main.c", MAIN_C)])
    for index in (0, 1):
        assert child(tree, index).sizeHint(0).height() == ROW_HEIGHT
    # 目录的占位子节点等高，展开瞬间不会跳行
    assert child(tree, 0).child(0).sizeHint(0).height() == ROW_HEIGHT


def test_size_and_mtime_live_in_the_tooltip(qtbot) -> None:
    tree = make_tree(qtbot)
    fill(tree, [make_entry("main.c", MAIN_C, size=25879)])
    tooltip = child(tree, 0).toolTip(0)
    assert "25.3 KB" in tooltip
    assert "修改时间" in tooltip
    assert "权限" in tooltip


def test_file_items_show_change_letter_badge(qtbot) -> None:
    """文件名后的 U/A/M/D 徽标；目录不加徽标（与 VSCode 的徽标规则一致）。"""
    tree = make_tree(qtbot)
    fill(
        tree,
        [
            make_entry("src", f"{ROOT}/src", is_dir=True),
            make_entry("main.c", MAIN_C),
            make_entry("util.c", UTIL_C),
            make_entry("notes.md", NEW_MD),
        ],
    )
    tree.set_status_snapshot(snapshot_with_changes())

    # 徽标是画出来的图形（BADGE_ROLE），不占用名称文本
    assert item_for(tree, f"{ROOT}/src").text(0) == "src"
    assert item_for(tree, f"{ROOT}/src").data(0, BADGE_ROLE) == ""
    assert item_for(tree, MAIN_C).text(0) == "main.c"
    assert item_for(tree, MAIN_C).data(0, BADGE_ROLE) == "M"
    assert item_for(tree, UTIL_C).data(0, BADGE_ROLE) == "D"
    assert item_for(tree, NEW_MD).data(0, BADGE_ROLE) == "U"
    # 徽标颜色同样来自主题：修改=黄、新增=绿、删除=红
    assert item_for(tree, MAIN_C).data(0, BADGE_COLOR_ROLE) == QColor(DARK.marker_modified)
    assert item_for(tree, NEW_MD).data(0, BADGE_COLOR_ROLE) == QColor(DARK.marker_added)
    assert item_for(tree, UTIL_C).data(0, BADGE_COLOR_ROLE) == QColor(DARK.marker_deleted)


def test_badge_disappears_when_file_becomes_clean(qtbot) -> None:
    """标记撤掉后徽标跟着消失（撤销修改、保存回原样的场景）。"""
    tree = make_tree(qtbot)
    fill(tree, [make_entry("main.c", MAIN_C)])
    tree.set_status_snapshot(snapshot_with_changes())
    assert child(tree, 0).data(0, BADGE_ROLE) == "M"

    tree.set_status_snapshot(build_tree_status(ROOT, branch="main"))

    assert child(tree, 0).text(0) == "main.c"
    assert child(tree, 0).data(0, BADGE_ROLE) == ""


def test_badged_filename_is_drawn_only_once(qtbot, themed_app) -> None:
    """着色行的文件名只画一遍，且笔画位置与未着色行一致。

    回归用例：徽标委托曾自己画一遍文件名，基类在样式表下又画一遍，两遍笔画错位叠加，
    看起来就像「有改动的文件名乱码」。
    """
    tree = make_tree(qtbot)
    fill(tree, [make_entry("main.c", MAIN_C)])
    item = item_for(tree, MAIN_C)
    row = tree.visualItemRect(item)
    # 只看徽标左侧的文字区，徽标本身的笔画不参与比较
    text_rect = QRect(
        row.left(), row.top(), row.width() - BADGE_SIZE - BADGE_MARGIN - 4, row.height()
    )

    tree.set_status_snapshot(snapshot_with_changes())
    assert item.data(0, BADGE_ROLE) == "M"
    colored = ink_mask(render_viewport(tree), text_rect)

    tree.set_status_snapshot(build_tree_status(ROOT, branch="main"))
    plain = ink_mask(render_viewport(tree), text_rect)

    assert sum(colored) > 0  # 确实画出了文件名，而不是空白
    assert colored == plain  # 着色没有让文件名多画一遍 / 挪位置


def test_children_are_sorted_directories_first(qtbot) -> None:
    """目录在前、其余按名称排序（SFTP 的原始顺序不该泄漏到界面上）。"""
    tree = make_tree(qtbot)
    fill(
        tree,
        [
            make_entry("README.md", f"{ROOT}/README.md"),
            make_entry("src", f"{ROOT}/src", is_dir=True),
            make_entry("CMakeLists.txt", f"{ROOT}/CMakeLists.txt"),
            make_entry("logs", f"{ROOT}/logs", is_dir=True),
        ],
    )
    assert [child(tree, index).text(0) for index in range(4)] == [
        "logs",
        "src",
        "CMakeLists.txt",
        "README.md",
    ]
