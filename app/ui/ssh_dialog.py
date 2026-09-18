"""SSH 连接对话框与主机编辑表单。"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from app.config.hosts import AuthMethod, HostConfig, HostStore
from app.utils.errors import ConfigError
from app.utils.paths import ssh_key_dir
from app.utils.ssh_keys import list_private_keys

logger = logging.getLogger(__name__)


@dataclass
class ConnectRequest:
    """连接请求（密码只存在于内存）。"""

    host: HostConfig
    password: Optional[str] = None
    passphrase: Optional[str] = None

    @property
    def secret_label(self) -> str:
        return "密码" if self.host.auth_method is AuthMethod.PASSWORD else "私钥口令"


class HostFormDialog(QDialog):
    """新增 / 编辑单个主机。"""

    def __init__(self, parent: Optional[QWidget] = None, host: Optional[HostConfig] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("编辑主机" if host else "新增主机")
        self.setMinimumWidth(420)
        self._host = host

        self.name_edit = QLineEdit(self)
        self.name_edit.setPlaceholderText("例如 Robot-3566")
        self.host_edit = QLineEdit(self)
        self.host_edit.setPlaceholderText("192.168.1.100")
        self.port_spin = QSpinBox(self)
        self.port_spin.setRange(1, 65535)
        self.port_spin.setValue(22)
        self.user_edit = QLineEdit(self)
        self.user_edit.setText("root")
        self.workspace_edit = QLineEdit(self)
        self.workspace_edit.setPlaceholderText("留空则连接后在远端选择")

        self.password_radio = QRadioButton("密码认证", self)
        self.key_radio = QRadioButton("私钥认证", self)
        self.password_radio.setChecked(True)
        self.key_combo = QComboBox(self)
        self.key_combo.setEditable(True)
        self.key_combo.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self.key_combo.lineEdit().setPlaceholderText("~/.ssh/id_ed25519")
        self.browse_button = QPushButton("浏览…", self)
        self.browse_button.clicked.connect(self._browse_key)
        self._load_local_keys()

        key_row = QHBoxLayout()
        key_row.addWidget(self.key_combo, 1)
        key_row.addWidget(self.browse_button)
        key_widget = QWidget(self)
        key_widget.setLayout(key_row)

        form = QFormLayout()
        form.addRow("名称", self.name_edit)
        form.addRow("主机 / IP", self.host_edit)
        form.addRow("端口", self.port_spin)
        form.addRow("用户名", self.user_edit)
        form.addRow("认证方式", self.password_radio)
        form.addRow("", self.key_radio)
        form.addRow("私钥文件", key_widget)
        form.addRow("远程工作目录", self.workspace_edit)

        hint = QLabel(
            "私钥列表来自本机 ~/.ssh（可直接选择或手动输入路径）；\n"
            "为安全起见，密码与私钥口令不会写入配置文件，工作目录可连接后再选择。",
            self,
        )
        hint.setWordWrap(True)
        hint.setProperty("muted", True)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel, self
        )
        buttons.accepted.connect(self._on_accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(10)
        layout.addLayout(form)
        layout.addWidget(hint)
        layout.addWidget(buttons)

        self.password_radio.toggled.connect(self._update_auth_fields)
        self._update_auth_fields()

        if host is not None:
            self._load(host)

    # -- 数据 --------------------------------------------------------------
    def _load(self, host: HostConfig) -> None:
        self.name_edit.setText(host.name)
        self.host_edit.setText(host.host)
        self.port_spin.setValue(int(host.port))
        self.user_edit.setText(host.username)
        self.workspace_edit.setText(host.remote_workspace)
        self.password_radio.setChecked(host.auth_method is AuthMethod.PASSWORD)
        self.key_radio.setChecked(host.auth_method is AuthMethod.PRIVATE_KEY)
        self._set_key_path(host.private_key_path)

    def host_config(self) -> HostConfig:
        host = self._host or HostConfig()
        host.name = self.name_edit.text().strip()
        host.host = self.host_edit.text().strip()
        host.port = int(self.port_spin.value())
        host.username = self.user_edit.text().strip() or "root"
        host.auth_method = (
            AuthMethod.PRIVATE_KEY if self.key_radio.isChecked() else AuthMethod.PASSWORD
        )
        host.private_key_path = self.key_path()
        host.remote_workspace = self.workspace_edit.text().strip()
        return host

    # -- 交互 --------------------------------------------------------------
    def _update_auth_fields(self) -> None:
        uses_key = self.key_radio.isChecked()
        self.key_combo.setEnabled(uses_key)
        self.browse_button.setEnabled(uses_key)
        if uses_key and not self.key_path():
            keys = list_private_keys()
            if keys:
                self._set_key_path(str(keys[0].path))

    def key_path(self) -> str:
        """当前选择的私钥路径。

        下拉框里显示的是「文件名（类型）」这样的标签，真正的路径存在 item data 里；
        用户手动输入的文本则原样返回。
        """
        text = self.key_combo.currentText().strip()
        index = self.key_combo.currentIndex()
        if index >= 0 and text == self.key_combo.itemText(index):
            data = self.key_combo.itemData(index)
            if data:
                return str(data)
        return text

    def _load_local_keys(self) -> None:
        """把 ``~/.ssh`` 里的私钥填进下拉框（读取失败则退化为纯手输）。"""
        try:
            keys = list_private_keys()
        except OSError as exc:  # pragma: no cover - 权限等异常时退化为手输
            logger.debug("扫描 ~/.ssh 失败：%s", exc)
            keys = []
        if not keys:
            self.key_combo.lineEdit().setPlaceholderText("未找到 ~/.ssh 私钥，可手动输入路径")
            return
        for key in keys:
            self.key_combo.addItem(key.label, str(key.path))
            tip = f"{key.path}\n{key.comment}" if key.comment else str(key.path)
            self.key_combo.setItemData(self.key_combo.count() - 1, tip, Qt.ItemDataRole.ToolTipRole)

    def _set_key_path(self, path: str) -> None:
        text = (path or "").strip()
        index = self.key_combo.findData(text) if text else -1
        if index >= 0:
            self.key_combo.setCurrentIndex(index)
        else:
            self.key_combo.setCurrentText(text)

    def _browse_key(self) -> None:
        start = str(ssh_key_dir() if ssh_key_dir().exists() else Path.home())
        path, _ = QFileDialog.getOpenFileName(self, "选择私钥文件", start)
        if path:
            self._set_key_path(path)

    def _on_accept(self) -> None:
        try:
            self.host_config().validate()
        except ConfigError as exc:
            QMessageBox.warning(self, "配置无效", exc.message)
            return
        self.accept()


class ConnectDialog(QDialog):
    """选择主机、填写凭据并连接。"""

    def __init__(self, store: HostStore, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("SSH 连接")
        # 留出足够宽度：主机行 + 三个管理按钮曾经把「密码」输入框挤到不可用
        self.setMinimumWidth(460)
        self._store = store

        self.host_combo = QComboBox(self)
        self.host_combo.setMinimumWidth(240)
        self.add_button = QPushButton("新增主机…", self)
        self.edit_button = QPushButton("编辑…", self)
        self.delete_button = QPushButton("删除", self)
        self.add_button.clicked.connect(self._add_host)
        self.edit_button.clicked.connect(self._edit_host)
        self.delete_button.clicked.connect(self._delete_host)

        host_row = QHBoxLayout()
        host_row.addWidget(self.host_combo, 1)

        # 三个管理按钮单独占一行：和下拉框挤在同一行会把对话框撑宽、
        # 反过来压缩「密码」输入框的可视宽度
        manage_row = QHBoxLayout()
        manage_row.addWidget(self.add_button)
        manage_row.addWidget(self.edit_button)
        manage_row.addWidget(self.delete_button)
        manage_row.addStretch(1)

        self.workspace_label = QLabel("-", self)
        self.workspace_label.setProperty("muted", True)
        self.workspace_label.setWordWrap(True)
        self.secret_edit = QLineEdit(self)
        self.secret_edit.setEchoMode(QLineEdit.EchoMode.Password)
        # 任何情况下都保证输入框有可用宽度（占位符 / 已输入的密码都不能被裁剪）
        self.secret_edit.setMinimumWidth(240)
        self.secret_edit.setMinimumHeight(self.secret_edit.fontMetrics().height() + 12)
        self.secret_label = QLabel("密码", self)
        self.show_secret = QPushButton("显示", self)
        self.show_secret.setMinimumWidth(56)
        self.show_secret.setCheckable(True)
        self.show_secret.toggled.connect(self._toggle_secret)

        secret_row = QHBoxLayout()
        secret_row.setContentsMargins(0, 0, 0, 0)
        secret_row.addWidget(self.secret_edit, 1)
        secret_row.addWidget(self.show_secret)
        secret_widget = QWidget(self)
        secret_widget.setLayout(secret_row)

        self.target_label = QLabel("-", self)
        self.target_label.setProperty("muted", True)

        form = QFormLayout()
        form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.DontWrapRows)
        form.addRow("主机", host_row)
        form.addRow("", manage_row)
        form.addRow("连接目标", self.target_label)
        form.addRow("默认文件夹", self.workspace_label)
        form.addRow(self.secret_label, secret_widget)

        self.buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel, self
        )
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setText("连接")
        self.buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        self.buttons.accepted.connect(self._on_accept)
        self.buttons.rejected.connect(self.reject)

        note = QLabel("连接成功后可在远端浏览并选择工作目录，无需事先填写路径。", self)
        note.setWordWrap(True)
        note.setProperty("muted", True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(10)
        layout.addLayout(form)
        layout.addWidget(note)
        layout.addWidget(self.buttons)

        self.host_combo.currentIndexChanged.connect(self._on_host_changed)
        self.reload_hosts()

    # -- 主机列表 ----------------------------------------------------------
    def reload_hosts(self, *, select_id: Optional[str] = None) -> None:
        hosts = self._store.all()
        self.host_combo.blockSignals(True)
        self.host_combo.clear()
        for host in hosts:
            self.host_combo.addItem(f"{host.display_name}  ({host.target})", host.id)
        self.host_combo.blockSignals(False)
        if not hosts:
            self.target_label.setText("请先新增一台主机")
            self.buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(False)
            return
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(True)
        if select_id:
            index = self.host_combo.findData(select_id)
            if index >= 0:
                self.host_combo.setCurrentIndex(index)
        self._on_host_changed()

    def selected_host(self) -> Optional[HostConfig]:
        host_id = self.host_combo.currentData()
        if not host_id:
            return None
        return self._store.get(str(host_id))

    def request(self) -> Optional[ConnectRequest]:
        host = self.selected_host()
        if host is None:
            return None
        secret = self.secret_edit.text()
        if host.auth_method is AuthMethod.PASSWORD:
            return ConnectRequest(host=host, password=secret)
        return ConnectRequest(host=host, passphrase=secret or None)

    # -- 交互 --------------------------------------------------------------
    def _on_host_changed(self) -> None:
        host = self.selected_host()
        if host is None:
            return
        self.target_label.setText(host.target)
        self.workspace_label.setText(
            host.remote_workspace or "连接后在远端选择"
        )
        self.secret_label.setText("密码" if host.auth_method is AuthMethod.PASSWORD else "私钥口令")
        self.secret_edit.clear()
        self.secret_edit.setPlaceholderText(
            "请输入登录密码" if host.auth_method is AuthMethod.PASSWORD else "私钥无口令可留空"
        )

    def _toggle_secret(self, visible: bool) -> None:
        self.secret_edit.setEchoMode(
            QLineEdit.EchoMode.Normal if visible else QLineEdit.EchoMode.Password
        )
        self.show_secret.setText("隐藏" if visible else "显示")

    def _add_host(self) -> None:
        dialog = HostFormDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            try:
                host = self._store.add(dialog.host_config())
            except ConfigError as exc:
                QMessageBox.warning(self, "保存失败", exc.message)
                return
            self.reload_hosts(select_id=host.id)

    def _edit_host(self) -> None:
        host = self.selected_host()
        if host is None:
            return
        dialog = HostFormDialog(self, host)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            try:
                updated = self._store.update(dialog.host_config())
            except ConfigError as exc:
                QMessageBox.warning(self, "保存失败", exc.message)
                return
            self.reload_hosts(select_id=updated.id)

    def _delete_host(self) -> None:
        host = self.selected_host()
        if host is None:
            return
        confirm = QMessageBox.question(
            self,
            "删除主机",
            f"确定删除「{host.display_name}」的配置吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self._store.delete(host.id)
        self.reload_hosts()

    def _on_accept(self) -> None:
        request = self.request()
        if request is None:
            QMessageBox.warning(self, "未选择主机", "请先选择或新增一台主机")
            return
        host = request.host
        if host.auth_method is AuthMethod.PASSWORD and not request.password:
            confirm = QMessageBox.question(
                self,
                "未填写密码",
                "密码为空，将尝试无密码登录（部分设备允许空密码）。是否继续？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if confirm != QMessageBox.StandardButton.Yes:
                return
        self.accept()
