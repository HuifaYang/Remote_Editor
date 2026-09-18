"""远程资源管理器（侧边栏视图）：主机列表 + 每台主机的工作目录历史。

用户反馈「点连接为什么弹窗在中间？」—— 选主机从**居中模态框**改成**侧边栏面板**
（对齐 VSCode 的 Remote Explorer）：

* 单击主机名 = 连接（主机配置早就存在，不需要再让用户「选一台再点连接」）；
* 展开主机 = 这台主机最近打开过的工作目录，单击某个目录 = 连接并直接打开它
  （历史由 :meth:`app.config.hosts.HostConfig.remember_workspace` 维护）；
* 右键主机 = 连接 / 编辑 / 删除；面板头部只有「新增主机」与「从 ~/.ssh/config 导入」
  两个按钮（用户反馈过按钮重复，所以能进右键菜单的就别摆按钮）。

**凭据仍然要输入**，但输入行做在面板底部（不是居中对话框）：填完回车即连。
密码 / 口令只经过这一个控件，从不上盘（需求 §1）。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QEvent, QObject, QPoint, Qt, Signal
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QToolButton,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from app.config.hosts import AuthMethod, HostConfig, HostStore
from app.ui.icons import make_icon
from app.ui.theme import Theme

#: 主机项上存 host id 的自定义角色
HOST_ID_ROLE = Qt.ItemDataRole.UserRole
#: 历史工作目录项上存路径的角色
WORKSPACE_ROLE = Qt.ItemDataRole.UserRole + 1
#: 项类型标记：主机 / 历史目录（分组项没有标记）
KIND_ROLE = Qt.ItemDataRole.UserRole + 2

HOST_KIND = "host"
WORKSPACE_KIND = "workspace"

#: 分组标题（对齐 VSCode 的 SSH 分组）
GROUP_TITLE = "SSH"


class HostsView(QWidget):
    """主机列表面板：只发信号，不自己做连接 / 存储以外的逻辑。"""

    #: 请求连接某台主机（不带凭据；需要凭据时由主窗口回来调 :meth:`request_secret`）
    connectRequested = Signal(str)
    #: 连接这台主机并打开这个历史工作目录
    openWorkspaceRequested = Signal(str, str)
    newHostRequested = Signal()
    editHostRequested = Signal(str)
    deleteHostRequested = Signal(str)
    importConfigRequested = Signal()
    disconnectRequested = Signal()
    #: 用户在面板底部填好凭据并提交：``(主机 id, 密码或口令)``
    secretSubmitted = Signal(str, str)

    def __init__(self, host_store: HostStore, theme: Theme, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._store = host_store
        self._theme = theme
        self._connected_id = ""
        self._secret_host: Optional[HostConfig] = None
        self._buttons = []
        # 最近一次按下的位置（视口坐标）：判断点的是不是展开箭头。
        # 不能用 QCursor.pos()：那是全局位置，程序化触发 / 离屏测试时完全不可靠。
        self._press_position: Optional[QPoint] = None

        self.header_title = QLabel("远程资源管理器", self)
        self.header_title.setContentsMargins(10, 4, 4, 4)
        title_font = self.header_title.font()
        title_font.setPointSizeF(max(7.5, title_font.pointSizeF() - 1.5))
        self.header_title.setFont(title_font)

        header = QWidget(self)
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(4, 1, 4, 1)
        header_layout.setSpacing(1)
        header_layout.addWidget(self.header_title)
        header_layout.addStretch(1)
        for icon, tooltip, slot in (
            ("plus", "新增主机…", self.newHostRequested.emit),
            ("download", "从 ~/.ssh/config 导入", self.importConfigRequested.emit),
            ("collapse", "全部折叠", self.collapse_all),
        ):
            button = QToolButton(header)
            button.setIcon(make_icon(icon, theme.color("gutter_fg")))
            button.setToolTip(tooltip)
            button.setAutoRaise(True)
            button.clicked.connect(slot)
            header_layout.addWidget(button)
            self._buttons.append((button, icon))

        # 连接状态条：只有连着的时候才出现（断开按钮跟着它一起出现，不占常驻位置）
        self.connection_row = QWidget(self)
        connection_layout = QHBoxLayout(self.connection_row)
        connection_layout.setContentsMargins(10, 3, 6, 3)
        connection_layout.setSpacing(6)
        self.connection_label = QLabel("", self.connection_row)
        self.connection_label.setProperty("muted", True)
        self.disconnect_button = QPushButton("断开", self.connection_row)
        self.disconnect_button.setToolTip("断开当前连接（有未保存文件时会先确认）")
        self.disconnect_button.clicked.connect(self.disconnectRequested.emit)
        connection_layout.addWidget(self.connection_label, 1)
        connection_layout.addWidget(self.disconnect_button)
        self.connection_row.setVisible(False)

        self.tree = QTreeWidget(self)
        self.tree.setObjectName("hosts_tree")
        self.tree.setHeaderHidden(True)
        self.tree.setRootIsDecorated(True)
        self.tree.setUniformRowHeights(True)
        self.tree.setIndentation(14)
        self.tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.tree.customContextMenuRequested.connect(self._on_context_menu)
        self.tree.itemClicked.connect(self._on_item_clicked)
        self.tree.viewport().installEventFilter(self)

        self.hint = QLabel("还没有主机。\n\n点右上角「+」新增，或从 ~/.ssh/config 导入。", self)
        self.hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.hint.setWordWrap(True)
        self.hint.setProperty("muted", True)

        # 凭据输入行（默认隐藏）：密码 / 私钥口令，回车即提交
        self.secret_row = QWidget(self)
        secret_layout = QHBoxLayout(self.secret_row)
        secret_layout.setContentsMargins(10, 4, 6, 8)
        secret_layout.setSpacing(6)
        self.secret_label = QLabel("密码", self.secret_row)
        self.secret_edit = QLineEdit(self.secret_row)
        self.secret_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.secret_edit.setPlaceholderText("输入后回车连接")
        self.secret_edit.returnPressed.connect(self._submit_secret)
        self.secret_ok = QPushButton("连接", self.secret_row)
        self.secret_ok.clicked.connect(self._submit_secret)
        self.secret_cancel = QPushButton("取消", self.secret_row)
        self.secret_cancel.clicked.connect(self.hide_secret)
        secret_layout.addWidget(self.secret_label)
        secret_layout.addWidget(self.secret_edit, 1)
        secret_layout.addWidget(self.secret_ok)
        secret_layout.addWidget(self.secret_cancel)
        self.secret_row.setVisible(False)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(header)
        layout.addWidget(self.connection_row)
        layout.addWidget(self.tree, 1)
        layout.addWidget(self.hint, 1)
        layout.addWidget(self.secret_row)

        self.reload()

    # -- 数据 --------------------------------------------------------------
    def reload(self, *, selected_id: str = "") -> None:
        """重建主机树（主机列表或历史目录变化后调用）。"""
        self.tree.clear()
        hosts = self._store.all()
        group = QTreeWidgetItem([GROUP_TITLE])
        group.setFlags(Qt.ItemFlag.ItemIsEnabled)
        group.setData(0, KIND_ROLE, "")
        self.tree.addTopLevelItem(group)
        for host in hosts:
            group.addChild(self._make_host_item(host))
        group.setExpanded(True)

        self.hint.setVisible(not hosts)
        self.tree.setVisible(bool(hosts))
        self._sync_connected_item()
        if selected_id:
            self.select_host(selected_id)
        elif self._connected_id:
            self.select_host(self._connected_id)

    def _make_host_item(self, host: HostConfig) -> QTreeWidgetItem:
        item = QTreeWidgetItem([host.display_name])
        item.setData(0, KIND_ROLE, HOST_KIND)
        item.setData(0, HOST_ID_ROLE, host.id)
        item.setToolTip(0, f"{host.target}\n单击连接；展开可看到最近打开过的目录")
        for path in host.recent_workspaces:
            child = QTreeWidgetItem([path])
            child.setData(0, KIND_ROLE, WORKSPACE_KIND)
            child.setData(0, HOST_ID_ROLE, host.id)
            child.setData(0, WORKSPACE_ROLE, path)
            child.setToolTip(0, f"连接 {host.display_name} 并打开 {path}")
            item.addChild(child)
        if host.recent_workspaces:
            item.setToolTip(0, f"{host.target}\n单击连接；展开可看到最近打开过的目录")
        return item

    def host_item(self, host_id: str) -> Optional[QTreeWidgetItem]:
        for item in self._host_items():
            if item.data(0, HOST_ID_ROLE) == host_id:
                return item
        return None

    def _host_items(self):
        group = self.tree.topLevelItem(0)
        if group is None:
            return []
        return [group.child(index) for index in range(group.childCount())]

    def select_host(self, host_id: str) -> None:
        item = self.host_item(host_id)
        if item is not None:
            self.tree.setCurrentItem(item)

    def workspace_items(self, host_id: str):
        item = self.host_item(host_id)
        if item is None:
            return []
        return [item.child(index) for index in range(item.childCount())]

    # -- 状态 --------------------------------------------------------------
    def set_connected(self, host: Optional[HostConfig]) -> None:
        """连接状态变化：状态条 + 主机项加粗（同一台主机连没连一眼能看出来）。"""
        self._connected_id = host.id if host is not None else ""
        if host is None:
            self.connection_label.setText("")
            self.connection_row.setVisible(False)
        else:
            self.connection_label.setText(f"已连接：{host.display_name}")
            self.connection_row.setVisible(True)
        if host is not None:
            self.hide_secret()
            item = self.host_item(host.id)
            if item is not None:
                item.setExpanded(True)  # 展开就能看到这台主机的历史目录
        self._sync_connected_item()

    def _sync_connected_item(self) -> None:
        for item in self._host_items():
            connected = item.data(0, HOST_ID_ROLE) == self._connected_id
            font = item.font(0)
            font.setBold(connected)
            item.setFont(0, font)

    def collapse_all(self) -> None:
        self.tree.collapseAll()
        group = self.tree.topLevelItem(0)
        if group is not None:
            group.setExpanded(True)

    def apply_theme(self, theme: Theme) -> None:
        self._theme = theme
        color = theme.color("gutter_fg")
        for button, icon in self._buttons:
            button.setIcon(make_icon(icon, color))

    # -- 凭据 --------------------------------------------------------------
    def request_secret(self, host: HostConfig, label: str, *, hint: str = "") -> None:
        """显示底部凭据输入行（密码 / 私钥口令），焦点直接落在输入框上。"""
        self._secret_host = host
        self.secret_label.setText(label)
        self.secret_edit.clear()
        self.secret_edit.setPlaceholderText(hint or "输入后回车连接")
        self.secret_row.setVisible(True)
        self.secret_edit.setFocus()

    def hide_secret(self) -> None:
        self._secret_host = None
        self.secret_edit.clear()
        self.secret_row.setVisible(False)

    def secret_host(self) -> Optional[HostConfig]:
        return self._secret_host

    def _submit_secret(self) -> None:
        host = self._secret_host
        if host is None:
            return
        text = self.secret_edit.text()
        self.hide_secret()
        self.secretSubmitted.emit(host.id, text)

    # -- 交互 --------------------------------------------------------------
    def _on_item_clicked(self, item: QTreeWidgetItem, column: int) -> None:
        """单击连接（对齐 VSCode），但点「展开箭头」不算 —— 那是要看历史目录。"""
        if column != 0 or self._is_branch_click(item):
            return
        kind = item.data(0, KIND_ROLE)
        host_id = str(item.data(0, HOST_ID_ROLE) or "")
        if not host_id:
            return
        if kind == WORKSPACE_KIND:
            self.openWorkspaceRequested.emit(host_id, str(item.data(0, WORKSPACE_ROLE) or ""))
        elif kind == HOST_KIND:
            self.connectRequested.emit(host_id)

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        """记下按下位置，供 :meth:`_is_branch_click` 判断箭头热区。"""
        if watched is self.tree.viewport() and event.type() == QEvent.Type.MouseButtonPress:
            self._press_position = event.position().toPoint()
        return super().eventFilter(watched, event)

    def _is_branch_click(self, item: QTreeWidgetItem) -> bool:
        """按下的位置是否落在展开箭头的热区里。

        用项的视口矩形 + 缩进量算，不依赖 QCursor（全局坐标在离屏 / 程序化触发时不可信）；
        没有真实的按下事件（例如测试里直接发 ``itemClicked``）就当作不是箭头。
        """
        if self._press_position is None:
            return False
        rect = self.tree.visualItemRect(item)
        return self._press_position.x() < rect.left() + self.tree.indentation()

    def _on_context_menu(self, position: QPoint) -> None:
        item = self.tree.itemAt(position)
        menu = self.build_context_menu(item)
        menu.exec(self.tree.viewport().mapToGlobal(position))

    def build_context_menu(self, item: Optional[QTreeWidgetItem]) -> QMenu:
        """按项类型组装右键菜单；``item`` 为 ``None`` 表示点在空白处。

        单独拆出来是为了**能测**：``QMenu.exec()`` 会阻塞，测试里只构造、不弹出。
        """
        menu = QMenu(self)
        color = self._theme.color("gutter_fg")
        if item is None or not item.data(0, HOST_ID_ROLE):
            menu.addAction(make_icon("plus", color), "新增主机…").triggered.connect(
                self.newHostRequested.emit
            )
            menu.addAction(make_icon("download", color), "从 ~/.ssh/config 导入").triggered.connect(
                self.importConfigRequested.emit
            )
            return menu

        host_id = str(item.data(0, HOST_ID_ROLE))
        if item.data(0, KIND_ROLE) == WORKSPACE_KIND:
            path = str(item.data(0, WORKSPACE_ROLE) or "")
            menu.addAction("连接并打开该目录").triggered.connect(
                lambda: self.openWorkspaceRequested.emit(host_id, path)
            )
            menu.addSeparator()
        else:
            menu.addAction("连接").triggered.connect(lambda: self.connectRequested.emit(host_id))
            menu.addSeparator()
        menu.addAction(make_icon("host", color), "编辑…").triggered.connect(
            lambda: self.editHostRequested.emit(host_id)
        )
        menu.addAction(make_icon("trash", color), "删除").triggered.connect(
            lambda: self.deleteHostRequested.emit(host_id)
        )
        return menu

    # -- 供主窗口查询 ------------------------------------------------------
    def secret_needed_for(self, host: HostConfig) -> Optional[str]:
        """这台主机连接前是否必须先要凭据；要的话返回输入行的标题。"""
        if host.auth_method is AuthMethod.PASSWORD:
            return "密码"
        return None
