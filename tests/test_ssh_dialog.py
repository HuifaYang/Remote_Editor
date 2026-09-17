"""SSH 对话框测试：本机私钥列表、默认工作目录提示。"""

from __future__ import annotations

import pytest

from app.config.hosts import AuthMethod, HostConfig
from app.ui import ssh_dialog as ssh_dialog_module
from app.ui.ssh_dialog import ConnectDialog, HostFormDialog
from app.utils.ssh_keys import PrivateKeyInfo


@pytest.fixture
def fake_keys(monkeypatch, tmp_path):
    """用假的 ~/.ssh 扫描结果替换真实扫描，避免测试结果依赖开发机环境。"""
    keys = [
        PrivateKeyInfo(path=tmp_path / "id_ed25519", key_type="OpenSSH", comment="a@b"),
        PrivateKeyInfo(path=tmp_path / "id_rsa", key_type="RSA", encrypted=True),
    ]
    monkeypatch.setattr(ssh_dialog_module, "list_private_keys", lambda: keys)
    return keys


def test_host_form_lists_local_private_keys(qtbot, fake_keys) -> None:
    dialog = HostFormDialog()
    qtbot.addWidget(dialog)
    assert dialog.key_combo.count() == 2
    assert dialog.key_combo.itemText(0) == "id_ed25519（OpenSSH）"

    dialog.key_radio.setChecked(True)
    dialog.key_combo.setCurrentIndex(0)
    dialog.name_edit.setText("Robot")
    dialog.host_edit.setText("192.168.1.13")
    config = dialog.host_config()
    assert config.auth_method is AuthMethod.PRIVATE_KEY
    # 下拉框显示的是标签，写回配置的必须是真实路径
    assert config.private_key_path == str(fake_keys[0].path)


def test_host_form_selects_default_key_for_key_auth(qtbot, fake_keys) -> None:
    dialog = HostFormDialog()
    qtbot.addWidget(dialog)
    dialog.key_radio.setChecked(True)
    assert dialog.key_path() == str(fake_keys[0].path)


def test_host_form_accepts_typed_key_path(qtbot, fake_keys) -> None:
    dialog = HostFormDialog()
    qtbot.addWidget(dialog)
    dialog.key_radio.setChecked(True)
    dialog.key_combo.setCurrentText("/opt/keys/custom")
    assert dialog.key_path() == "/opt/keys/custom"


def test_host_form_loads_existing_host(qtbot, fake_keys) -> None:
    host = HostConfig(
        host="1.2.3.4",
        auth_method=AuthMethod.PRIVATE_KEY,
        private_key_path=str(fake_keys[1].path),
        remote_workspace="/opt/app",
    )
    dialog = HostFormDialog(host=host)
    qtbot.addWidget(dialog)
    assert dialog.key_path() == str(fake_keys[1].path)
    assert dialog.host_config().remote_workspace == "/opt/app"


def test_host_form_handles_missing_local_keys(qtbot, monkeypatch) -> None:
    monkeypatch.setattr(ssh_dialog_module, "list_private_keys", lambda: [])
    dialog = HostFormDialog()
    qtbot.addWidget(dialog)
    assert dialog.key_combo.count() == 0
    dialog.key_radio.setChecked(True)
    assert dialog.key_path() == ""


def test_connect_dialog_shows_default_folder(qtbot, host_store, fake_keys) -> None:
    host = HostConfig(
        name="lele", host="192.168.1.13", username="Le", remote_workspace="/home/Le/ros2_ws"
    )
    host_store.add(host)
    dialog = ConnectDialog(host_store)
    qtbot.addWidget(dialog)
    assert dialog.target_label.text() == "Le@192.168.1.13:22"
    assert dialog.workspace_label.text() == "/home/Le/ros2_ws"

    dialog.secret_edit.setText("pw")
    request = dialog.request()
    assert request is not None
    assert request.password == "pw"
    assert request.host.id == host.id


def test_connect_dialog_hint_when_no_workspace(qtbot, host_store, fake_keys) -> None:
    host_store.add(HostConfig(name="box", host="10.0.0.1"))
    dialog = ConnectDialog(host_store)
    qtbot.addWidget(dialog)
    assert dialog.workspace_label.text() == "连接后在远端选择"
