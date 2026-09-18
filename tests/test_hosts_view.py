"""侧边栏「远程资源管理器」测试（用户反馈：连接不该弹居中对话框）。

面板要能独立工作：列表来自 HostStore、单击主机发连接信号、展开显示历史工作目录、
凭据输入行留在面板里（密码 / 口令只经过内存）。真正的连接流程在
``test_main_window.py`` 里做集成断言。
"""

from __future__ import annotations

from PySide6.QtCore import QPoint, Qt
from PySide6.QtTest import QTest

from app.config.hosts import AuthMethod, HostConfig, HostStore
from app.ui.theme import DARK
from app.ui.widgets.hosts_view import (
    GROUP_TITLE,
    HOST_ID_ROLE,
    HostsView,
    WORKSPACE_KIND,
    KIND_ROLE,
    WORKSPACE_ROLE,
)


def make_host(name: str, *, auth: AuthMethod = AuthMethod.PASSWORD) -> HostConfig:
    return HostConfig(
        name=name,
        host=f"192.168.1.{len(name)}",
        username="root",
        auth_method=auth,
        private_key_path="/home/u/.ssh/id_ed25519" if auth is AuthMethod.PRIVATE_KEY else "",
    )


def make_view(qtbot, tmp_path, *hosts: HostConfig) -> HostsView:
    store = HostStore(tmp_path / "hosts.json")
    for host in hosts:
        store.add(host)
    view = HostsView(store, DARK)
    qtbot.addWidget(view)
    view.resize(280, 420)
    view.show()
    return view


# ---------------------------------------------------------------------------
# 列表
# ---------------------------------------------------------------------------


def test_empty_store_shows_a_hint(qtbot, tmp_path) -> None:
    view = make_view(qtbot, tmp_path)

    assert view.hint.isVisibleTo(view)
    assert not view.tree.isVisibleTo(view)
    assert view.tree.topLevelItemCount() == 1  # 只有 SSH 分组
    assert view.tree.topLevelItem(0).text(0) == GROUP_TITLE


def test_hosts_are_listed_with_target_in_tooltip(qtbot, tmp_path) -> None:
    robot, board = make_host("Robot"), make_host("Board")
    view = make_view(qtbot, tmp_path, robot, board)

    assert not view.hint.isVisibleTo(view)
    items = view._host_items()
    assert [item.text(0) for item in items] == ["Robot", "Board"]
    assert "root@192.168.1.5:22" in items[0].toolTip(0)
    assert [item.data(0, HOST_ID_ROLE) for item in items] == [robot.id, board.id]


def test_recent_workspaces_are_children_of_the_host(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    robot.remember_workspace("/home/u/project")
    robot.remember_workspace("/home/u/other")
    view = make_view(qtbot, tmp_path, robot)

    children = view.workspace_items(robot.id)

    assert [child.text(0) for child in children] == ["/home/u/other", "/home/u/project"]
    assert all(child.data(0, KIND_ROLE) == WORKSPACE_KIND for child in children)
    assert [child.data(0, WORKSPACE_ROLE) for child in children] == [
        "/home/u/other",
        "/home/u/project",
    ]


# ---------------------------------------------------------------------------
# 交互
# ---------------------------------------------------------------------------


def test_clicking_a_host_requests_a_connection(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    view = make_view(qtbot, tmp_path, robot)
    seen = []
    view.connectRequested.connect(seen.append)

    view.tree.setCurrentItem(view.host_item(robot.id))
    view.tree.itemClicked.emit(view.host_item(robot.id), 0)

    assert seen == [robot.id]


def test_clicking_the_expand_arrow_does_not_connect(qtbot, tmp_path) -> None:
    """点展开箭头是「看历史目录」，不该触发连接（否则想看历史就会连一次）。"""
    robot = make_host("Robot")
    robot.remember_workspace("/home/u/project")
    view = make_view(qtbot, tmp_path, robot)
    seen = []
    view.connectRequested.connect(seen.append)
    item = view.host_item(robot.id)
    rect = view.tree.visualItemRect(item)

    # 真点一次箭头热区（项矩形最左侧那条缩进带），而不是伪造 itemClicked
    QTest.mouseClick(
        view.tree.viewport(),
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
        QPoint(rect.left() + 3, rect.center().y()),
    )

    assert seen == []


def test_clicking_the_host_name_still_connects(qtbot, tmp_path) -> None:
    """用真实鼠标事件点主机名（箭头右侧）时必须连接。"""
    robot = make_host("Robot")
    view = make_view(qtbot, tmp_path, robot)
    seen = []
    view.connectRequested.connect(seen.append)
    item = view.host_item(robot.id)
    rect = view.tree.visualItemRect(item)

    QTest.mouseClick(
        view.tree.viewport(),
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
        QPoint(rect.left() + 80, rect.center().y()),
    )

    assert seen == [robot.id]


def test_clicking_a_recent_workspace_requests_connect_and_open(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    robot.remember_workspace("/home/u/project")
    view = make_view(qtbot, tmp_path, robot)
    seen = []
    view.openWorkspaceRequested.connect(lambda host_id, path: seen.append((host_id, path)))

    child = view.workspace_items(robot.id)[0]
    view.tree.itemClicked.emit(child, 0)

    assert seen == [(robot.id, "/home/u/project")]


def test_header_buttons_emit_requests(qtbot, tmp_path) -> None:
    view = make_view(qtbot, tmp_path)
    new_seen = []
    import_seen = []
    view.newHostRequested.connect(lambda: new_seen.append(True))
    view.importConfigRequested.connect(lambda: import_seen.append(True))

    view._buttons[0][0].click()
    view._buttons[1][0].click()

    assert new_seen == [True]
    assert import_seen == [True]


def test_collapse_keeps_the_group_open(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    robot.remember_workspace("/home/u/project")
    view = make_view(qtbot, tmp_path, robot)
    view.host_item(robot.id).setExpanded(True)

    view.collapse_all()

    assert not view.host_item(robot.id).isExpanded()
    assert view.tree.topLevelItem(0).isExpanded()


# ---------------------------------------------------------------------------
# 连接状态
# ---------------------------------------------------------------------------


def test_connected_host_is_marked_and_expanded(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    robot.remember_workspace("/home/u/project")
    view = make_view(qtbot, tmp_path, robot)

    view.set_connected(robot)

    assert view.connection_row.isVisibleTo(view)
    assert "Robot" in view.connection_label.text()
    assert view.host_item(robot.id).font(0).bold()
    assert view.host_item(robot.id).isExpanded()

    view.set_connected(None)
    assert not view.connection_row.isVisibleTo(view)
    assert not view.host_item(robot.id).font(0).bold()


def test_disconnect_button_emits_signal(qtbot, tmp_path) -> None:
    view = make_view(qtbot, tmp_path)
    seen = []
    view.disconnectRequested.connect(lambda: seen.append(True))

    view.disconnect_button.click()

    assert seen == [True]


# ---------------------------------------------------------------------------
# 凭据输入行（密码 / 私钥口令）
# ---------------------------------------------------------------------------


def test_secret_row_is_only_shown_on_demand(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    view = make_view(qtbot, tmp_path, robot)
    assert not view.secret_row.isVisibleTo(view)

    view.request_secret(robot, "密码")

    assert view.secret_row.isVisibleTo(view)
    assert view.secret_label.text() == "密码"
    assert view.secret_edit.echoMode() == view.secret_edit.EchoMode.Password


def test_submitting_the_secret_emits_host_id_and_secret(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    view = make_view(qtbot, tmp_path, robot)
    seen = []
    view.secretSubmitted.connect(lambda host_id, text: seen.append((host_id, text)))
    view.request_secret(robot, "密码")
    view.secret_edit.setText("s3cret")

    view.secret_edit.returnPressed.emit()

    assert seen == [(robot.id, "s3cret")]
    assert not view.secret_row.isVisibleTo(view)  # 提交后收起，不留明文
    assert view.secret_edit.text() == ""  # 输入框立即清空


def test_cancelling_the_secret_row_hides_and_clears(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    view = make_view(qtbot, tmp_path, robot)
    view.request_secret(robot, "密码")
    view.secret_edit.setText("abc")

    view.secret_cancel.click()

    assert not view.secret_row.isVisibleTo(view)
    assert view.secret_edit.text() == ""
    assert view.secret_host() is None


def test_password_hosts_need_a_secret_upfront_but_key_hosts_do_not(qtbot, tmp_path) -> None:
    password_host = make_host("Robot")
    key_host = make_host("Board", auth=AuthMethod.PRIVATE_KEY)
    view = make_view(qtbot, tmp_path, password_host, key_host)

    assert view.secret_needed_for(password_host) == "密码"
    # 私钥先乐观直连：真的被口令保护时，连接失败后再回来要口令
    assert view.secret_needed_for(key_host) is None


# ---------------------------------------------------------------------------
# 右键菜单
# ---------------------------------------------------------------------------


def test_context_menu_on_a_host_offers_edit_and_delete(qtbot, tmp_path) -> None:
    robot = make_host("Robot")
    view = make_view(qtbot, tmp_path, robot)
    edited = []
    deleted = []
    view.editHostRequested.connect(edited.append)
    view.deleteHostRequested.connect(deleted.append)

    menu = view.build_context_menu(view.host_item(robot.id))
    labels = [action.text() for action in menu.actions() if not action.isSeparator()]
    for action in menu.actions():
        if action.text() == "编辑…":
            action.trigger()
        elif action.text() == "删除":
            action.trigger()

    assert labels == ["连接", "编辑…", "删除"]
    assert edited == [robot.id]
    assert deleted == [robot.id]


def test_context_menu_on_empty_area_offers_add_and_import(qtbot, tmp_path) -> None:
    view = make_view(qtbot, tmp_path)

    menu = view.build_context_menu(None)

    assert [action.text() for action in menu.actions()] == ["新增主机…", "从 ~/.ssh/config 导入"]


def test_theme_switch_rebuilds_header_icons(qtbot, tmp_path) -> None:
    from app.ui.theme import get_theme

    view = make_view(qtbot, tmp_path)
    before = view._buttons[0][0].icon().cacheKey()

    view.apply_theme(get_theme("light"))

    assert view._buttons[0][0].icon().cacheKey() != before
