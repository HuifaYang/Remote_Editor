"""SSH 主机管理面板：新增 / 编辑 / 删除 / 快速连接。"""

from __future__ import annotations

import logging
from typing import Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from app.config.hosts import HostConfig, HostStore
from app.ui.ssh_dialog import HostFormDialog
from app.utils.errors import ConfigError
from app.utils.ssh_keys import SSHConfigHost, load_ssh_config_hosts

logger = logging.getLogger(__name__)


class HostManagerDialog(QDialog):
    """主机列表面板。"""

    def __init__(self, store: HostStore, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("SSH 主机管理")
        self.setMinimumSize(460, 360)
        self._store = store
        self._connect_host: Optional[HostConfig] = None

        self.list_widget = QListWidget(self)
        self.list_widget.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.list_widget.itemDoubleClicked.connect(lambda _item: self._on_connect())

        self.add_button = QPushButton("新增", self)
        self.edit_button = QPushButton("编辑", self)
        self.delete_button = QPushButton("删除", self)
        self.connect_button = QPushButton("连接", self)
        self.import_button = QPushButton("从 ~/.ssh/config 导入", self)
        self.import_button.clicked.connect(self._on_import_config)
        self.add_button.clicked.connect(self._on_add)
        self.edit_button.clicked.connect(self._on_edit)
        self.delete_button.clicked.connect(self._on_delete)
        self.connect_button.clicked.connect(self._on_connect)

        toolbar = QHBoxLayout()
        for button in (self.add_button, self.edit_button, self.delete_button, self.import_button):
            toolbar.addWidget(button)
        toolbar.addStretch(1)
        toolbar.addWidget(self.connect_button)

        self.hint = QLabel("密码不会保存在配置文件中，连接时再输入。", self)
        self.hint.setStyleSheet("color: gray;")

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close, self)
        buttons.rejected.connect(self.reject)
        buttons.clicked.connect(lambda _b: self.reject())

        layout = QVBoxLayout(self)
        layout.addWidget(self.list_widget, 1)
        layout.addLayout(toolbar)
        layout.addWidget(self.hint)
        layout.addWidget(buttons)

        self.reload()

    # -- 数据 --------------------------------------------------------------
    def reload(self) -> None:
        self.list_widget.clear()
        for host in self._store.all():
            item = QListWidgetItem(f"{host.display_name}\n{host.target}")
            item.setData(Qt.ItemDataRole.UserRole, host.id)
            item.setToolTip(
                f"认证: {host.auth_method.label}\n"
                f"工作目录: {host.remote_workspace or '远端家目录'}"
            )
            self.list_widget.addItem(item)

    def current_host(self) -> Optional[HostConfig]:
        item = self.list_widget.currentItem()
        if item is None:
            return None
        return self._store.get(str(item.data(Qt.ItemDataRole.UserRole)))

    @property
    def connect_host(self) -> Optional[HostConfig]:
        """点击「连接」后希望主窗口连接的主机。"""
        return self._connect_host

    # -- 交互 --------------------------------------------------------------
    def _on_add(self) -> None:
        dialog = HostFormDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            try:
                self._store.add(dialog.host_config())
            except ConfigError as exc:
                QMessageBox.warning(self, "保存失败", exc.message)
            self.reload()

    def _on_edit(self) -> None:
        host = self.current_host()
        if host is None:
            QMessageBox.information(self, "未选择", "请先选择一台主机")
            return
        dialog = HostFormDialog(self, host)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            try:
                self._store.update(dialog.host_config())
            except ConfigError as exc:
                QMessageBox.warning(self, "保存失败", exc.message)
            self.reload()

    def _on_delete(self) -> None:
        host = self.current_host()
        if host is None:
            QMessageBox.information(self, "未选择", "请先选择一台主机")
            return
        confirm = QMessageBox.question(
            self,
            "删除主机",
            f"确定删除「{host.display_name}」吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if confirm == QMessageBox.StandardButton.Yes:
            self._store.delete(host.id)
            self.reload()

    def _on_import_config(self) -> None:
        """读取本机 ~/.ssh/config，把其中已配置好的主机导入主机列表。"""
        try:
            entries = load_ssh_config_hosts()
        except OSError as exc:  # pragma: no cover - 权限异常
            QMessageBox.warning(self, "读取失败", f"无法读取 ~/.ssh/config：{exc}")
            return
        if not entries:
            QMessageBox.information(
                self,
                "没有可导入的主机",
                "未在本机 ~/.ssh/config 中找到可导入的 Host 条目。\n"
                "（含通配符的 Host 段落会被忽略。）",
            )
            return

        imported = 0
        skipped = 0
        for entry in entries:
            if self._already_present(entry):
                skipped += 1
                continue
            try:
                self._store.add(HostConfig.from_ssh_config(entry))
            except ConfigError as exc:
                logger.warning("导入 %s 失败：%s", entry.alias, exc.message)
                skipped += 1
                continue
            imported += 1
        self.reload()
        QMessageBox.information(
            self,
            "导入完成",
            f"从 ~/.ssh/config 导入 {imported} 台主机，跳过 {skipped} 条（已存在或无效）。",
        )

    def _already_present(self, entry: SSHConfigHost) -> bool:
        return any(
            host.host == entry.connect_host
            and int(host.port) == int(entry.port or 22)
            and (not entry.username or host.username == entry.username)
            for host in self._store.all()
        )

    def _on_connect(self) -> None:
        host = self.current_host()
        if host is None:
            QMessageBox.information(self, "未选择", "请先选择一台主机")
            return
        self._connect_host = host
        self.accept()
