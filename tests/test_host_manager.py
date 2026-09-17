"""主机管理面板测试：从本机 ~/.ssh/config 导入主机。"""

from __future__ import annotations

import pytest

from app.config.hosts import AuthMethod
from app.ui import host_manager as host_manager_module
from app.ui.host_manager import HostManagerDialog
from app.utils.ssh_keys import SSHConfigHost


@pytest.fixture
def silent_message_boxes(monkeypatch):
    """记录弹窗内容，避免测试里出现阻塞式模态框。"""
    seen: list[tuple] = []
    monkeypatch.setattr(
        host_manager_module.QMessageBox,
        "information",
        staticmethod(lambda *args, **kwargs: seen.append(args)),
    )
    monkeypatch.setattr(
        host_manager_module.QMessageBox,
        "warning",
        staticmethod(lambda *args, **kwargs: seen.append(args)),
    )
    return seen


def test_imports_hosts_from_ssh_config(qtbot, host_store, monkeypatch, silent_message_boxes) -> None:
    entries = [
        SSHConfigHost(
            alias="lele",
            hostname="192.168.1.13",
            username="Le",
            identity_file="/home/u/.ssh/id_ed25519_lele",
        ),
        SSHConfigHost(alias="box", hostname="10.0.0.1", username="root"),
    ]
    monkeypatch.setattr(host_manager_module, "load_ssh_config_hosts", lambda: entries)
    dialog = HostManagerDialog(host_store)
    qtbot.addWidget(dialog)

    dialog._on_import_config()

    hosts = {host.name: host for host in host_store.all()}
    assert set(hosts) == {"lele", "box"}
    assert hosts["lele"].auth_method is AuthMethod.PRIVATE_KEY
    assert hosts["lele"].private_key_path == "/home/u/.ssh/id_ed25519_lele"
    assert hosts["box"].auth_method is AuthMethod.PASSWORD
    assert dialog.list_widget.count() == 2

    # 重复导入不会产生重复主机
    dialog._on_import_config()
    assert len(host_store.all()) == 2
    assert any("跳过 2 条" in str(args) for args in silent_message_boxes)


def test_import_reports_missing_entries(qtbot, host_store, monkeypatch, silent_message_boxes) -> None:
    monkeypatch.setattr(host_manager_module, "load_ssh_config_hosts", lambda: [])
    dialog = HostManagerDialog(host_store)
    qtbot.addWidget(dialog)

    dialog._on_import_config()

    assert host_store.all() == []
    assert silent_message_boxes  # 至少给了一次提示


def test_import_reports_read_failure(qtbot, host_store, monkeypatch, silent_message_boxes) -> None:
    def boom():
        raise OSError("permission denied")

    monkeypatch.setattr(host_manager_module, "load_ssh_config_hosts", boom)
    dialog = HostManagerDialog(host_store)
    qtbot.addWidget(dialog)

    dialog._on_import_config()

    assert silent_message_boxes
    assert host_store.all() == []
