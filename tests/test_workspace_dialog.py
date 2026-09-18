"""远程文件夹选择器测试：默认定位家目录、进入子目录、返回上级、错误提示。"""

from __future__ import annotations

import pytest
from PySide6.QtWidgets import QDialog

from app.ui.workspace_dialog import RemoteFolderPickerDialog
from app.utils.errors import RemoteFileNotFoundError
from tests.fakes import DEFAULT_ROOT, FakeSession

SRC = f"{DEFAULT_ROOT}/src"


@pytest.fixture
def session() -> FakeSession:
    session = FakeSession()
    session.fs.add_directory("/home/user")
    session.fs.add_directory(DEFAULT_ROOT)
    session.fs.add_directory(SRC)
    session.fs.add_file(f"{DEFAULT_ROOT}/readme.md", "hi\n")
    return session


def open_picker(qtbot, session: FakeSession, initial: str = "~") -> RemoteFolderPickerDialog:
    dialog = RemoteFolderPickerDialog(session, initial_path=initial)  # type: ignore[arg-type]
    qtbot.addWidget(dialog)
    return dialog


def test_picker_falls_back_to_home_and_lists_only_directories(qtbot, session) -> None:
    dialog = open_picker(qtbot, session, initial="")
    qtbot.waitUntil(lambda: dialog.path_edit.text() == "/home/user", timeout=5000)
    assert dialog.list_widget.count() == 1
    assert dialog.list_widget.item(0).text() == "project"
    assert dialog.chosen_path() == "/home/user"


def test_picker_expands_tilde_on_start(qtbot, session) -> None:
    dialog = open_picker(qtbot, session, initial="~/")
    qtbot.waitUntil(lambda: dialog.path_edit.text() == "/home/user", timeout=5000)
    assert "~" not in dialog.chosen_path()


def test_picker_enters_subdirectory(qtbot, session) -> None:
    dialog = open_picker(qtbot, session, initial="/home/user")
    qtbot.waitUntil(lambda: dialog.list_widget.count() == 1, timeout=5000)
    dialog._on_item_activated(dialog.list_widget.item(0))
    qtbot.waitUntil(lambda: dialog.path_edit.text() == DEFAULT_ROOT, timeout=5000)
    # 只列目录：readme.md 不出现在列表里
    assert [dialog.list_widget.item(i).text() for i in range(dialog.list_widget.count())] == ["src"]


def test_picker_up_button(qtbot, session) -> None:
    dialog = open_picker(qtbot, session, initial=SRC)
    qtbot.waitUntil(lambda: dialog.path_edit.text() == SRC, timeout=5000)
    dialog._go_up()
    qtbot.waitUntil(lambda: dialog.path_edit.text() == DEFAULT_ROOT, timeout=5000)
    assert dialog.chosen_path() == DEFAULT_ROOT


def test_picker_accepts_selected_directory(qtbot, session) -> None:
    dialog = open_picker(qtbot, session, initial=DEFAULT_ROOT)
    qtbot.waitUntil(lambda: dialog.list_widget.count() == 1, timeout=5000)
    dialog.list_widget.setCurrentRow(0)
    dialog.accept()
    assert dialog.result() == QDialog.DialogCode.Accepted
    assert dialog.chosen_path() == SRC


def test_picker_validates_typed_path_before_accepting(qtbot, session) -> None:
    dialog = open_picker(qtbot, session, initial=DEFAULT_ROOT)
    qtbot.waitUntil(lambda: dialog.path_edit.text() == DEFAULT_ROOT, timeout=5000)
    dialog.path_edit.setText(SRC)
    dialog.accept()
    # 手输路径先异步校验，通过后才关闭
    qtbot.waitUntil(lambda: dialog.result() == QDialog.DialogCode.Accepted, timeout=5000)
    assert dialog.chosen_path() == SRC


def test_picker_keeps_open_for_invalid_typed_path(qtbot, session, monkeypatch) -> None:
    def boom(path: str):
        raise RemoteFileNotFoundError(f"远程文件不存在：{path}")

    dialog = open_picker(qtbot, session, initial=DEFAULT_ROOT)
    qtbot.waitUntil(lambda: dialog.path_edit.text() == DEFAULT_ROOT, timeout=5000)
    monkeypatch.setattr(session.fs, "list_dir", boom)
    dialog.path_edit.setText("/home/user/ghost")
    dialog.accept()
    qtbot.waitUntil(lambda: "无法读取" in dialog.status_label.text(), timeout=5000)
    assert dialog.result() != QDialog.DialogCode.Accepted
    # 报错颜色走主题（severity 属性选择器），不再硬编码红色
    assert dialog.status_label.property("severity") == "error"


def test_picker_reports_listing_failure(qtbot, session, monkeypatch) -> None:
    def boom(path: str):
        raise RemoteFileNotFoundError(f"远程文件不存在：{path}")

    monkeypatch.setattr(session.fs, "list_dir", boom)
    dialog = open_picker(qtbot, session, initial="/home/user")
    qtbot.waitUntil(lambda: "无法读取" in dialog.status_label.text(), timeout=5000)
    assert dialog.result() != QDialog.DialogCode.Accepted
    assert dialog.list_widget.count() == 0
