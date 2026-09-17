"""主窗口：装配 UI 与后台任务。

本文件只做「编排」——所有网络、Git、文件逻辑都在 app/remote、app/git、
app/ui/remote_ops 中实现，主窗口负责在它们与控件之间转发数据。
"""

from __future__ import annotations

import logging
import posixpath
import time
from typing import Dict, List, Optional

from PySide6.QtCore import QSize, QTimer, Qt
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QDockWidget,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QSplitter,
    QStackedWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from app.cache.file_cache import FileCache
from app.config.hosts import HostStore
from app.config.settings import AppSettings, SettingsStore
from app.editor.document import Document
from app.editor.syntax import detect_language
from app.git.models import FileDiff
from app.remote.remote_fs import FileFingerprint, normalize_remote_path
from app.remote.session import RemoteSession
from app.ui import remote_ops
from app.ui.remote_ops import LoadedFile, SavedFile
from app.ui.settings_dialog import SettingsDialog
from app.ui.ssh_dialog import ConnectDialog
from app.ui.host_manager import HostManagerDialog
from app.ui.icons import make_icon
from app.ui.workspace_dialog import RemoteFolderPickerDialog
from app.ui.tasks import TaskRunner
from app.ui.theme import Theme, apply_theme, get_theme
from app.ui.widgets.activity_bar import ActivityBar, ActivityItem
from app.ui.widgets.editor_tabs import EditorTabs
from app.ui.widgets.file_tree import RemoteFileTree
from app.ui.widgets.log_view import LogView
from app.ui.widgets.scm_view import SourceControlView
from app.ui.widgets.search_bar import SearchBar
from app.ui.widgets.status_bar import StatusBar
from app.ui.widgets.welcome import WelcomeView
from app.utils.encoding import SELECTABLE_ENCODINGS, UnknownEncodingError
from app.utils.errors import ConfigError
from app.utils.paths import APP_NAME, APP_VERSION

logger = logging.getLogger(__name__)

GIT_REFRESH_DELAY_MS = 800

#: 目录列举结果的缓存有效期：远端 RTT 约 1 秒时一次列目录要 3~4 秒，
#: 结果在手边就不该再问一次（本地操作会主动失效，F5 强制刷新）
DIR_CACHE_TTL_SECONDS = 120.0
#: 展开一个目录后顺带预取的子目录数量（只预取、不写入控件；让下一次点击秒开）
PREFETCH_LIMIT = 3
#: 缓存目录数上限，防止长时间浏览后内存无限增长
DIR_CACHE_MAX_ENTRIES = 200

#: 活动栏条目：``files`` / ``source-control`` 切换侧边栏视图，其余是命令
ACTIVITY_ITEMS = (
    ActivityItem("files", "资源管理器", "files", checkable=True),
    ActivityItem("search", "查找（Ctrl+F）", "search"),
    ActivityItem("source-control", "源代码管理", "source-control", checkable=True),
    ActivityItem("host", "连接主机…", "host"),
    ActivityItem("open-folder", "打开远程文件夹…（Ctrl+O）", "folder"),
    ActivityItem("settings", "设置…（Ctrl+,）", "settings", at_bottom=True),
)


class MainWindow(QMainWindow):
    """RemoteCodeEditor 主窗口。"""

    def __init__(
        self,
        *,
        settings_store: Optional[SettingsStore] = None,
        host_store: Optional[HostStore] = None,
        cache: Optional[FileCache] = None,
    ) -> None:
        super().__init__()
        self.settings_store = settings_store or SettingsStore()
        self.host_store = host_store or HostStore()
        self.cache = cache or FileCache()
        self.settings: AppSettings = self.settings_store.load()
        self.theme: Theme = get_theme(self.settings.theme)

        self.runner = TaskRunner(self)
        self.session: Optional[RemoteSession] = None
        self.workspace = self.settings.remote_workspace or ""
        #: 连接后是否已经就「打不开工作目录」提醒过用户（避免反复弹窗）
        self._workspace_prompted = False

        self._git_timer = QTimer(self)
        self._git_timer.setSingleShot(True)
        self._git_timer.setInterval(GIT_REFRESH_DELAY_MS)
        self._git_timer.timeout.connect(self._refresh_git_for_current)

        self._auto_save_timer = QTimer(self)
        self._auto_save_timer.setSingleShot(True)
        self._auto_save_timer.timeout.connect(self._auto_save)

        self._encoding_override: Dict[str, str] = {}
        #: 正在异步列举的目录（去重：同一路径不重复发远端请求）
        self._pending_listings: set[str] = set()
        #: 目录列举结果缓存：{路径: (写入时间, 条目列表)}
        self._dir_cache: Dict[str, tuple[float, List]] = {}
        #: 正在后台预取的目录
        self._prefetching: set[str] = set()
        #: 资源管理器顶部的图标按钮：``[(QToolButton, 图标名), ...]``，换主题时重建图标
        self.explorer_buttons: List[tuple] = []
        #: 侧边栏视图名 -> QStackedWidget 下标
        self._side_views: Dict[str, int] = {}

        self.setWindowTitle(f"{APP_NAME} {APP_VERSION}")
        self.resize(1280, 820)

        self._build_ui()
        self._build_actions()
        self._build_menus()
        self._apply_settings_to_ui(first_time=True)
        self._update_status_connection(False)

    # ------------------------------------------------------------------
    # UI 构建
    # ------------------------------------------------------------------
    def _build_explorer_header(self) -> QWidget:
        """侧边栏顶部：当前文件夹名 + 常用操作图标（仿 VSCode 资源管理器）。"""
        header = QWidget(self)
        layout = QHBoxLayout(header)
        layout.setContentsMargins(4, 1, 4, 1)
        layout.setSpacing(1)
        layout.addWidget(self.explorer_title)
        layout.addStretch(1)
        for icon, tooltip, slot in (
            (
                "new-file",
                "在选中目录下新建文件",
                lambda: self._create_entry(self._new_entry_dir(), is_dir=False),
            ),
            (
                "new-folder",
                "在选中目录下新建文件夹",
                lambda: self._create_entry(self._new_entry_dir(), is_dir=True),
            ),
            ("refresh", "刷新工作目录（F5）", lambda: self._on_refresh_requested("")),
            ("collapse", "全部折叠", self.file_tree.collapseAll),
        ):
            button = QToolButton(header)
            button.setIcon(make_icon(icon, self.theme.color("gutter_fg")))
            button.setIconSize(QSize(16, 16))
            button.setToolTip(tooltip)
            button.setAutoRaise(True)
            button.clicked.connect(slot)
            layout.addWidget(button)
            self.explorer_buttons.append((button, icon))
        return header

    def _new_entry_dir(self) -> str:
        """新建文件 / 文件夹的目标目录：选中的目录，或当前工作目录。"""
        path = self.file_tree.current_path() or ""
        if path and self.file_tree.is_directory(path):
            return path
        if path:
            return posixpath.dirname(path)
        return self.workspace or ""

    def _build_ui(self) -> None:
        self.file_tree = RemoteFileTree(self, theme=self.theme)
        self.editor_tabs = EditorTabs(self.theme, self.settings, self)
        self.search_bar = SearchBar(self)

        # 活动栏（仿 VSCode 最左侧的一列图标）：切换侧边栏视图 / 触发常用命令
        self.activity_bar = ActivityBar(ACTIVITY_ITEMS, self.theme, self)
        self.activity_bar.itemTriggered.connect(self._on_activity_triggered)

        # 侧边栏视图 1：资源管理器——顶部是当前文件夹标题 + 常用操作图标，下面是文件树
        self.explorer_title = QLabel("资源管理器", self)
        self.explorer_title.setContentsMargins(10, 4, 4, 4)
        title_font = self.explorer_title.font()
        title_font.setPointSizeF(max(7.5, title_font.pointSizeF() - 1.5))
        self.explorer_title.setFont(title_font)
        self.explorer = QWidget(self)
        explorer_layout = QVBoxLayout(self.explorer)
        explorer_layout.setContentsMargins(0, 0, 0, 0)
        explorer_layout.setSpacing(0)
        explorer_layout.addWidget(self._build_explorer_header())
        explorer_layout.addWidget(self.file_tree, 1)

        # 还没打开文件夹时，侧边栏给一句提示（对齐 VSCode：空工作区不留一片空白）
        self.explorer_hint = QLabel(
            "尚未打开文件夹。\n\n连接主机后按 Ctrl+O 选择远端目录。", self
        )
        self.explorer_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.explorer_hint.setWordWrap(True)
        explorer_layout.addWidget(self.explorer_hint, 1)

        # 侧边栏视图 2：源代码管理——与文件树共用同一份 Git 快照，打开面板不发远端请求
        self.scm_view = SourceControlView(self.theme, self)
        self.side_panel = QStackedWidget(self)
        for key, view in (("files", self.explorer), ("source-control", self.scm_view)):
            self._side_views[key] = self.side_panel.addWidget(view)

        # 编辑区：「标签页」与「欢迎页」互斥显示（对齐 VSCode：空工作区就是一个 Welcome 标签）
        self.welcome = WelcomeView(self.theme, self)
        self.editor_stack = QStackedWidget(self)
        self.editor_stack.addWidget(self.editor_tabs)
        self.editor_stack.addWidget(self.welcome)

        editor_area = QWidget(self)
        editor_layout = QVBoxLayout(editor_area)
        editor_layout.setContentsMargins(0, 0, 0, 0)
        editor_layout.setSpacing(0)
        editor_layout.addWidget(self.search_bar)
        editor_layout.addWidget(self.editor_stack, 1)

        self.splitter = QSplitter(Qt.Orientation.Horizontal, self)
        self.splitter.addWidget(self.side_panel)
        self.splitter.addWidget(editor_area)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([280, 1000])

        central = QWidget(self)
        central_layout = QHBoxLayout(central)
        central_layout.setContentsMargins(0, 0, 0, 0)
        central_layout.setSpacing(0)
        central_layout.addWidget(self.activity_bar)
        central_layout.addWidget(self.splitter, 1)
        self.setCentralWidget(central)

        self.file_tree_dock = QDockWidget("Remote Files", self)
        self.file_tree_dock.setObjectName("file_tree_dock")
        self.file_tree_dock.setFeatures(
            QDockWidget.DockWidgetFeature.DockWidgetMovable
            | QDockWidget.DockWidgetFeature.DockWidgetClosable
        )
        self.log_view = LogView(self)
        self.log_dock = QDockWidget("日志", self)
        self.log_dock.setObjectName("log_dock")
        self.log_dock.setWidget(self.log_view)
        self.addDockWidget(Qt.DockWidgetArea.BottomDockWidgetArea, self.log_dock)
        self.log_dock.hide()

        self.status = StatusBar(self)
        self.setStatusBar(self.status)

        self.file_tree.fileActivated.connect(self.open_remote_file)
        self.file_tree.directoryExpandRequested.connect(self._load_directory)
        self.file_tree.refreshRequested.connect(self._on_refresh_requested)
        self.file_tree.createFileRequested.connect(lambda path: self._create_entry(path, is_dir=False))
        self.file_tree.createDirectoryRequested.connect(lambda path: self._create_entry(path, is_dir=True))
        self.file_tree.renameRequested.connect(self._rename_entry)
        self.file_tree.deleteRequested.connect(self._delete_entry)
        self.file_tree.propertiesRequested.connect(self._show_properties)
        self.file_tree.copyPathRequested.connect(self._copy_path)

        self.editor_tabs.documentActivated.connect(self._on_document_activated)
        self.editor_tabs.documentDirtyChanged.connect(self._on_document_dirty_changed)
        self.editor_tabs.closeDocumentRequested.connect(self._close_document)
        self.editor_tabs.cursorMoved.connect(self.status.set_cursor)
        self.editor_tabs.saveRequested.connect(self._save_document)

        self.search_bar.searchRequested.connect(self._on_search)
        self.search_bar.replaceRequested.connect(self._on_replace)
        self.search_bar.replaceAllRequested.connect(self._on_replace_all)

        self.scm_view.fileActivated.connect(self.open_remote_file)
        self.scm_view.refreshRequested.connect(self._refresh_tree_status)
        self.welcome.connectRequested.connect(self._on_connect)
        self.welcome.openFolderRequested.connect(self._on_open_folder)

        self.side_panel.setCurrentIndex(self._side_views["files"])
        self.activity_bar.set_view("files")
        self._update_explorer_state()
        self._update_editor_stack()

    def _update_explorer_state(self) -> None:
        """有工作目录就显示文件树，否则显示「尚未打开文件夹」的提示。"""
        has_workspace = bool(self.workspace)
        self.file_tree.setVisible(has_workspace)
        self.explorer_hint.setVisible(not has_workspace)

    # ------------------------------------------------------------------
    # 活动栏 / 侧边栏
    # ------------------------------------------------------------------
    def _on_activity_triggered(self, key: str, checked: bool) -> None:
        """活动栏点击：视图按钮切换（再点一次收起），其余按钮等价菜单命令。"""
        if key in self._side_views:
            self._show_side_view(key if checked else None)
        elif key == "search":
            self._show_search(False)
        elif key == "host":
            self._on_connect()
        elif key == "open-folder":
            self._on_open_folder()
        elif key == "settings":
            self._on_settings()

    def _show_side_view(self, key: Optional[str]) -> None:
        """切换侧边栏视图；``None`` 表示收起整列（VSCode 的 Ctrl+B）。"""
        if key is None or key not in self._side_views:
            self.side_panel.setVisible(False)
            self.activity_bar.set_view("")
            self.action_toggle_tree.setChecked(False)
            return
        self.side_panel.setVisible(True)
        self.side_panel.setCurrentIndex(self._side_views[key])
        self.activity_bar.set_view(key)
        self.action_toggle_tree.setChecked(key == "files")

    def _update_editor_stack(self) -> None:
        """没有打开的标签页时显示欢迎页（对齐 VSCode 的空标签页）。"""
        has_tabs = self.editor_tabs.count() > 0
        self.editor_stack.setCurrentWidget(self.editor_tabs if has_tabs else self.welcome)
        if not has_tabs:
            self.search_bar.setVisible(False)

    def _build_actions(self) -> None:
        def action(text: str, shortcut: Optional[str] = None, slot=None) -> QAction:
            item = QAction(text, self)
            if shortcut:
                item.setShortcut(QKeySequence(shortcut))
            if slot is not None:
                item.triggered.connect(slot)
            return item

        self.action_connect = action("连接主机…", "Ctrl+K", self._on_connect)
        self.action_open_folder = action("打开远程文件夹…", "Ctrl+O", self._on_open_folder)
        self.action_disconnect = action("断开连接", None, self._on_disconnect)
        self.action_hosts = action("主机管理…", None, self._on_manage_hosts)
        self.action_save = action("保存", "Ctrl+S", lambda: self._save_document(self._current_document()))
        self.action_save_all = action("全部保存", "Ctrl+Shift+S", lambda: self._save_all())
        self.action_close_tab = action("关闭标签", "Ctrl+W", self._close_current_tab)
        self.action_refresh_tree = action("刷新工作目录", "F5", lambda: self._refresh_workspace())
        self.action_refresh_git = action("刷新 Git 标记", "Shift+F5", self._refresh_git_for_current)
        self.action_settings = action("设置…", "Ctrl+,", self._on_settings)
        self.action_quit = action("退出", "Ctrl+Q", self.close)

        self.action_find = action("查找…", "Ctrl+F", lambda: self._show_search(False))
        self.action_replace = action("替换…", "Ctrl+H", lambda: self._show_search(True))
        self.action_goto = action("转到行…", "Ctrl+G", self._goto_line)
        self.action_undo = action("撤销", "Ctrl+Z", lambda: self._editor_call("undo"))
        self.action_redo = action("重做", "Ctrl+Y", lambda: self._editor_call("redo"))
        self.action_cut = action("剪切", "Ctrl+X", lambda: self._editor_call("cut"))
        self.action_copy = action("复制", "Ctrl+C", lambda: self._editor_call("copy"))
        self.action_paste = action("粘贴", "Ctrl+V", lambda: self._editor_call("paste"))
        self.action_select_all = action("全选", "Ctrl+A", lambda: self._editor_call("selectAll"))

        self.action_toggle_log = action("显示日志", None, self._toggle_log)
        self.action_toggle_log.setCheckable(True)
        self.action_toggle_tree = action("显示文件树", None, self._toggle_tree)
        self.action_toggle_tree.setCheckable(True)
        self.action_toggle_tree.setChecked(True)
        self.action_clear_cache = action("清空本地缓存", None, self._clear_cache)
        self.action_about = action("关于", None, self._show_about)

        self.action_disconnect.setEnabled(False)
        self.action_open_folder.setEnabled(False)
        self.action_save.setEnabled(False)
        self.action_save_all.setEnabled(False)

        # 工具栏 / 菜单与活动栏共用同一套自绘图标（换成纯文字会占掉一整行）
        self._action_icons: List[tuple] = [
            (self.action_connect, "host"),
            (self.action_open_folder, "folder"),
            (self.action_disconnect, "disconnect"),
            (self.action_save, "save"),
            (self.action_refresh_tree, "refresh"),
            (self.action_refresh_git, "history"),
            (self.action_find, "search"),
            (self.action_settings, "settings"),
        ]

    def _build_menus(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        file_menu.addAction(self.action_connect)
        file_menu.addAction(self.action_open_folder)
        file_menu.addAction(self.action_hosts)
        file_menu.addAction(self.action_disconnect)
        file_menu.addSeparator()
        file_menu.addAction(self.action_save)
        file_menu.addAction(self.action_save_all)
        file_menu.addAction(self.action_close_tab)
        file_menu.addSeparator()
        file_menu.addAction(self.action_refresh_tree)
        file_menu.addAction(self.action_refresh_git)
        file_menu.addSeparator()
        file_menu.addAction(self.action_settings)
        file_menu.addAction(self.action_quit)

        edit_menu = self.menuBar().addMenu("编辑")
        for item in (
            self.action_undo,
            self.action_redo,
            self.action_cut,
            self.action_copy,
            self.action_paste,
            self.action_select_all,
        ):
            edit_menu.addAction(item)
        edit_menu.addSeparator()
        edit_menu.addAction(self.action_find)
        edit_menu.addAction(self.action_replace)
        edit_menu.addAction(self.action_goto)

        view_menu = self.menuBar().addMenu("视图")
        view_menu.addAction(self.action_toggle_log)
        view_menu.addAction(self.action_toggle_tree)

        help_menu = self.menuBar().addMenu("帮助")
        help_menu.addAction(self.action_clear_cache)
        help_menu.addAction(self.action_about)

        toolbar = self.addToolBar("主工具栏")
        toolbar.setMovable(False)
        toolbar.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonIconOnly)
        toolbar.setIconSize(QSize(18, 18))
        toolbar.addAction(self.action_connect)
        toolbar.addAction(self.action_open_folder)
        toolbar.addAction(self.action_disconnect)
        toolbar.addSeparator()
        toolbar.addAction(self.action_save)
        toolbar.addAction(self.action_refresh_tree)
        toolbar.addAction(self.action_refresh_git)
        toolbar.addSeparator()
        toolbar.addAction(self.action_find)
        toolbar.addAction(self.action_settings)

    # ------------------------------------------------------------------
    # 设置 / 主题
    # ------------------------------------------------------------------
    def _apply_settings_to_ui(self, *, first_time: bool = False) -> None:
        apply_theme(QApplication.instance(), self.theme)
        self.editor_tabs.apply_theme(self.theme)
        self.file_tree.apply_theme(self.theme)
        self.activity_bar.apply_theme(self.theme)
        self.scm_view.apply_theme(self.theme)
        self.welcome.apply_theme(self.theme)
        icon_color = self.theme.color("gutter_fg")
        self.explorer_hint.setStyleSheet(f"color: {self.theme.gutter_fg};")
        for button, icon in self.explorer_buttons:
            button.setIcon(make_icon(icon, icon_color))
        for action, icon in self._action_icons:
            action.setIcon(make_icon(icon, icon_color))
        self.editor_tabs.apply_settings(self.settings)
        if first_time:
            self.log_view.setVisible(False)

    def _on_settings(self) -> None:
        dialog = SettingsDialog(self.settings, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        updated = dialog.result_settings()
        self.settings_store.save(updated)
        theme_changed = updated.theme != self.settings.theme
        self.settings = updated
        if theme_changed:
            self.theme = get_theme(updated.theme)
        self._apply_settings_to_ui()
        logger.info("设置已更新（主题=%s，字号=%s）", self.settings.theme, self.settings.font_size)
        self.status.set_save_status("设置已保存")

    def _toggle_log(self, checked: bool) -> None:
        self.log_dock.setVisible(checked)
        self.action_toggle_log.setChecked(checked)

    def _toggle_tree(self, checked: bool) -> None:
        self._show_side_view("files" if checked else None)

    def _clear_cache(self) -> None:
        confirm = QMessageBox.question(
            self,
            "清空缓存",
            "将删除本地缓存与最近文件记录（不会影响远程文件）。是否继续？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if confirm == QMessageBox.StandardButton.Yes:
            self.cache.clear()
            self.status.set_save_status("缓存已清空")

    def _show_about(self) -> None:
        QMessageBox.information(
            self,
            "关于",
            f"{APP_NAME} {APP_VERSION}\n\n"
            "轻量级 SSH 远程代码编辑器：本地 GUI + SSH/SFTP，远端零常驻服务。\n"
            "支持远程文件浏览、编辑、语法高亮与 Git 行级差异标记。",
        )

    # ------------------------------------------------------------------
    # 连接管理
    # ------------------------------------------------------------------
    def _on_manage_hosts(self) -> None:
        dialog = HostManagerDialog(self.host_store, self)
        dialog.exec()
        host = dialog.connect_host
        if host is not None:
            self._connect_to_host(host)

    def _on_connect(self) -> None:
        if self.session is not None and self.session.connected:
            confirm = QMessageBox.question(
                self,
                "重新连接",
                "当前已有连接，是否断开并连接其他主机？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if confirm != QMessageBox.StandardButton.Yes:
                return
            self._teardown_session()
        dialog = ConnectDialog(self.host_store, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        request = dialog.request()
        if request is None:
            return
        self._connect_to_host(request.host, password=request.password, passphrase=request.passphrase)

    def _connect_to_host(
        self,
        host,
        *,
        password: Optional[str] = None,
        passphrase: Optional[str] = None,
    ) -> None:
        from app.ui.ssh_dialog import ConnectRequest

        if password is None and passphrase is None:
            dialog = ConnectDialog(self.host_store, self)
            dialog.reload_hosts(select_id=host.id)
            if dialog.exec() != QDialog.DialogCode.Accepted:
                return
            request = dialog.request() or ConnectRequest(host=host)
            host, password, passphrase = request.host, request.password, request.passphrase

        session = RemoteSession(host, password=password, passphrase=passphrase, settings=self.settings)
        self.status.set_save_status(f"正在连接 {host.target}…")
        self.status.set_connection(False)
        self._set_busy(True)
        self.runner.submit(
            remote_ops.open_session,
            args=(session,),
            on_success=lambda state: self._on_connected(session, state),
            on_error=lambda message: self._on_connect_failed(message),
        )

    def _on_connected(self, session: RemoteSession, state) -> None:
        self._set_busy(False)
        self.session = session
        self._workspace_prompted = False
        self._update_status_connection(True)
        self.status.set_save_status("已连接")
        logger.info("已连接到 %s，工作目录 %s", session.host.target, session.workspace or "-")
        repo = session.repo_info()
        self.status.set_git(repo.label)
        if session.workspace_configured and session.workspace:
            # 这台主机之前记住过工作目录，直接打开
            self._open_workspace(session.workspace, persist=False)
            return
        # 首次连接：像 VSCode 一样先连接，再让用户选择要打开哪个文件夹
        self._prompt_open_folder()

    def _on_connect_failed(self, message: str) -> None:
        self._set_busy(False)
        self._teardown_session()
        QMessageBox.critical(self, "连接失败", message)
        self.status.set_save_status("连接失败")

    def _on_disconnect(self) -> None:
        if self.editor_tabs.dirty_documents():
            confirm = QMessageBox.question(
                self,
                "存在未保存文件",
                "仍有未保存的修改，断开后这些修改会丢失。是否继续？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if confirm != QMessageBox.StandardButton.Yes:
                return
        self._teardown_session()
        self.status.set_save_status("已断开连接")

    def _teardown_session(self) -> None:
        session = self.session
        self.session = None
        self._pending_listings.clear()
        self._prefetching.clear()
        self._dir_cache.clear()
        self.file_tree.set_status_snapshot(None)
        self.scm_view.set_snapshot(None)
        if session is not None:
            self.runner.submit(remote_ops.close_session, args=(session,))
        self._update_status_connection(False)

    def _update_status_connection(self, connected: bool) -> None:
        host = self.session.host.display_name if self.session else ""
        self.status.set_connection(connected, host)
        self.action_disconnect.setEnabled(connected)
        self.action_open_folder.setEnabled(connected)
        self.action_save.setEnabled(connected)
        self.action_save_all.setEnabled(connected)
        if not connected:
            self.status.set_folder("-")
            self.status.set_git("-")
        # 活动栏与欢迎页跟随连接状态：未连接时「打开文件夹」是不可用入口
        self.activity_bar.set_enabled("open-folder", connected)
        self.welcome.set_connected(connected)
        if not connected:
            self._update_editor_stack()

    # ------------------------------------------------------------------
    # 工作目录（连接之后再选择，对齐 VSCode 的「打开文件夹」）
    # ------------------------------------------------------------------
    def _on_open_folder(self) -> None:
        """手动切换工作目录（Ctrl+O）。"""
        session = self._require_session()
        if session is None:
            return
        self._workspace_prompted = False
        self._pick_folder(session)

    def _prompt_open_folder(self, *, reason: Optional[str] = None) -> None:
        """连接后（或记住的目录已失效时）询问要打开哪个远端文件夹。"""
        session = self.session
        if session is None:
            return
        # 同一连接周期内只自动提示一次，避免目录不可用时反复弹窗
        self._workspace_prompted = True
        if reason:
            QMessageBox.warning(self, "无法打开工作目录", reason)
        if self._pick_folder(session):
            return
        # 用户取消：回退到远端家目录（家目录未知时用 /），保证界面可用
        fallback = session.home or "/"
        self._open_workspace(fallback, persist=False)
        self.status.set_save_status("未选择工作目录，已回退到远端家目录")

    def _pick_folder(self, session: RemoteSession) -> bool:
        """弹出目录选择器，选中则切换工作目录并返回 ``True``。"""
        dialog = RemoteFolderPickerDialog(
            session,
            # 优先用当前会话的目录，避免刚连上新主机却定位到上一台主机的路径
            initial_path=session.workspace or self.workspace or session.home,
            runner=self.runner,
            parent=self,
        )
        if dialog.exec() != QDialog.DialogCode.Accepted or not dialog.chosen_path():
            return False
        self._open_workspace(dialog.chosen_path(), persist=True)
        return True

    def _open_workspace(self, path: str, *, persist: bool) -> None:
        """切换到远端工作目录；``persist=True`` 时写回该主机的配置。"""
        session = self.session
        if session is None:
            return
        text = (path or "").strip()
        # 已经是绝对路径时只做纯字符串规范化，避免 GUI 线程里再走一次 SSH
        resolved = normalize_remote_path(text) if text.startswith("/") else session.expand_path(text)
        self.workspace = resolved
        session.set_workspace(resolved)
        self.settings.remote_workspace = resolved
        self.settings_store.save(self.settings)
        if persist:
            host = session.host
            host.remote_workspace = resolved
            try:
                self.host_store.update(host)
            except ConfigError as exc:
                logger.warning("保存主机工作目录失败：%s", exc.message)
        self.status.set_folder(resolved)
        self.explorer_title.setText(posixpath.basename(resolved.rstrip("/")) or resolved)
        self.file_tree.set_root(resolved)
        self._update_explorer_state()
        self.scm_view.set_snapshot(None)
        self._dir_cache.clear()
        self._prefetching.clear()
        self._load_directory(resolved)
        self._refresh_repo_info()

    # ------------------------------------------------------------------
    # 文件树
    # ------------------------------------------------------------------
    def _require_session(self) -> Optional[RemoteSession]:
        if self.session is None or not self.session.connected:
            QMessageBox.information(self, "未连接", "请先连接远程主机")
            return None
        return self.session

    def _load_directory(self, path: str, *, force: bool = False) -> None:
        session = self._require_session()
        if session is None:
            return
        if not force:
            cached = self._cached_listing(path)
            if cached is not None:
                # 命中缓存（含后台预取的结果）：立刻上屏，不再花 3~4 秒等远端
                self.file_tree.set_children(path, cached)
                return
        if path in self._pending_listings:
            # 同一条目录已经在异步列举中：展开信号 + 打开工作目录会各请求一次，
            # 高延迟链路（RTT ~1s）下一次列目录就是 2~3 个 RTT，不能重复发。
            return
        self._pending_listings.add(path)
        self.file_tree.mark_loading(path)
        self.runner.submit(
            remote_ops.list_directory,
            args=(session, path),
            on_success=lambda result: self._on_directory_loaded(*result),
            on_error=lambda message: self._on_directory_failed(path, message),
        )

    def _on_directory_loaded(self, path: str, entries: List) -> None:
        self._pending_listings.discard(path)
        self._remember_listing(path, entries)
        self.file_tree.set_children(path, entries)
        self._prefetch_children(entries)

    # -- 目录缓存与预取 ----------------------------------------------------
    def _cached_listing(self, path: str) -> Optional[List]:
        entry = self._dir_cache.get(path)
        if entry is None:
            return None
        written_at, entries = entry
        if time.monotonic() - written_at > DIR_CACHE_TTL_SECONDS:
            self._dir_cache.pop(path, None)
            return None
        return entries

    def _remember_listing(self, path: str, entries: List) -> None:
        self._dir_cache[path] = (time.monotonic(), entries)
        if len(self._dir_cache) > DIR_CACHE_MAX_ENTRIES:
            oldest = sorted(self._dir_cache, key=lambda key: self._dir_cache[key][0])
            for stale in oldest[: len(self._dir_cache) - DIR_CACHE_MAX_ENTRIES]:
                self._dir_cache.pop(stale, None)

    def _invalidate_listing(self, path: str) -> None:
        """本地改动（新建 / 删除 / 重命名）后丢掉该路径及其子树的缓存。"""
        if not path:
            return
        prefix = path.rstrip("/") + "/"
        for key in [
            key for key in self._dir_cache if key == path or key.startswith(prefix)
        ]:
            self._dir_cache.pop(key, None)

    def _prefetch_children(self, entries: List) -> None:
        """展开目录后顺带预取几个子目录：高延迟链路上让下一次点击秒开。

        只在没有用户可见请求排队时进行，且最多 ``PREFETCH_LIMIT`` 个，
        避免后台流量把用户真正想看的东西挤在后面。
        """
        session = self.session
        if session is None or self._pending_listings:
            return
        targets = [entry.path for entry in entries if entry.is_dir][:PREFETCH_LIMIT]
        for path in targets:
            if (
                path in self._dir_cache
                or path in self._prefetching
                or path in self._pending_listings
            ):
                continue
            self._prefetching.add(path)
            self.runner.submit(
                remote_ops.list_directory,
                args=(session, path),
                on_success=lambda result: self._on_prefetch_done(*result),
                on_error=lambda _message, path=path: self._prefetching.discard(path),
            )

    def _on_prefetch_done(self, path: str, entries: List) -> None:
        self._prefetching.discard(path)
        self._remember_listing(path, entries)

    def _on_directory_failed(self, path: str, message: str) -> None:
        self._pending_listings.discard(path)
        self.file_tree.mark_failed(path, message)
        logger.warning("列目录失败 %s：%s", path, message)
        if path == self.workspace and not self._workspace_prompted:
            # 记住的工作目录已经不存在（被删除/改名）：让用户重新选一个
            self._workspace_prompted = True
            self._prompt_open_folder(reason=f"目录 {path} 无法打开：{message}")

    def _refresh_workspace(self) -> None:
        if self.session is None:
            return
        root = self.workspace or self.session.workspace or "/"
        # F5 是「我要看最新的」：清掉缓存与预取状态，强制回远端重新列举
        self._dir_cache.clear()
        self._prefetching.clear()
        self.file_tree.set_root(root)
        self._load_directory(root, force=True)
        self._refresh_repo_info()

    def _on_refresh_requested(self, path: str) -> None:
        target = path or self.workspace or (self.session.workspace if self.session else "")
        if target:
            self._invalidate_listing(target)
            self._load_directory(target, force=True)

    def _create_entry(self, directory: str, *, is_dir: bool) -> None:
        session = self._require_session()
        if session is None:
            return
        directory = directory or self.workspace or session.home or ""
        if not directory:
            QMessageBox.warning(self, "无目标目录", "请先打开一个远端工作目录")
            return
        title = "新建文件夹" if is_dir else "新建文件"
        name, ok = QInputDialog.getText(self, title, "名称：", QLineEdit.EchoMode.Normal, "")
        if not ok or not name.strip():
            return
        name = name.strip()
        if "/" in name:
            QMessageBox.warning(self, "名称无效", "名称中不能包含 “/”")
            return
        target = posixpath.join(directory, name)
        operation = remote_ops.create_directory if is_dir else remote_ops.create_file
        self.runner.submit(
            operation,
            args=(session, target),
            on_success=lambda _result: self._after_mutation(directory, f"已创建 {name}"),
            on_error=lambda message: self._on_operation_failed("新建失败", message),
        )

    def _rename_entry(self, path: str) -> None:
        session = self._require_session()
        if session is None:
            return
        current = posixpath.basename(path)
        name, ok = QInputDialog.getText(self, "重命名", "新名称：", QLineEdit.EchoMode.Normal, current)
        if not ok or not name.strip() or name.strip() == current:
            return
        target = posixpath.join(posixpath.dirname(path), name.strip())
        self.runner.submit(
            remote_ops.rename_path,
            args=(session, path, target),
            on_success=lambda _result: self._after_rename(path, target),
            on_error=lambda message: self._on_operation_failed("重命名失败", message),
        )

    def _after_rename(self, old_path: str, new_path: str) -> None:
        document = self.editor_tabs.document_for_path(old_path)
        if document is not None:
            document.remote_path = new_path
            document.language = detect_language(new_path)
            editor = self.editor_tabs.editor_for_path(old_path)
            if editor is not None:
                editor.set_language(document.language)
            self.editor_tabs.update_titles()
        self._after_mutation(posixpath.dirname(new_path), "重命名完成")

    def _delete_entry(self, path: str) -> None:
        session = self._require_session()
        if session is None:
            return
        confirm = QMessageBox.question(
            self,
            "删除",
            f"确定删除远程路径吗？\n{path}\n\n目录将被递归删除。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self.runner.submit(
            remote_ops.delete_path,
            args=(session, path),
            on_success=lambda _result: self._after_delete(path),
            on_error=lambda message: self._on_operation_failed("删除失败", message),
        )

    def _after_delete(self, path: str) -> None:
        if self.editor_tabs.index_of_path(path) >= 0:
            self.editor_tabs.close_path(path)
        self._invalidate_listing(path)
        self._forget_deleted_path(path)
        self._after_mutation(posixpath.dirname(path), "已删除")

    def _forget_deleted_path(self, path: str) -> None:
        """删除后本地更新 Git 快照；判断不了时退回一次远端刷新。"""
        snapshot = self.file_tree.status_snapshot()
        if snapshot is None or not snapshot.mark_removed(path):
            self._git_timer.start()
            return
        self.file_tree.refresh_status()
        self.scm_view.set_snapshot(snapshot)
        self.status.set_git(snapshot.label)

    def _after_mutation(self, directory: str, message: str) -> None:
        self.status.set_save_status(message)
        if directory:
            self._invalidate_listing(directory)
            self._load_directory(directory)

    def _on_operation_failed(self, title: str, message: str) -> None:
        QMessageBox.warning(self, title, message)
        self.status.set_save_status(title)

    def _show_properties(self, path: str) -> None:
        session = self._require_session()
        if session is None:
            return
        self.runner.submit(
            session.fs.stat,
            args=(path,),
            on_success=lambda entry: QMessageBox.information(
                self,
                "属性",
                f"路径: {entry.path}\n类型: {entry.kind_label}\n大小: {entry.size_label}\n"
                f"修改时间: {entry.mtime_label}\n权限: {entry.permission_label}",
            ),
            on_error=lambda message: self._on_operation_failed("无法获取属性", message),
        )

    def _copy_path(self, path: str) -> None:
        clipboard = QApplication.clipboard()
        if clipboard is not None:
            clipboard.setText(path)
            self.status.set_save_status("路径已复制")

    # ------------------------------------------------------------------
    # 打开 / 保存文件
    # ------------------------------------------------------------------
    def open_remote_file(self, path: str, *, encoding: Optional[str] = None) -> None:
        session = self._require_session()
        if session is None:
            return
        if self.editor_tabs.activate_path(path):
            return
        max_bytes = max(self.settings.max_file_size_mb, 1) * 1024 * 1024
        use_encoding = encoding or self._encoding_override.get(path)
        self.status.set_save_status(f"正在下载 {posixpath.basename(path)}…")
        self.runner.submit(
            remote_ops.load_file,
            args=(session, path),
            kwargs={"encoding": use_encoding, "max_bytes": max_bytes},
            on_success=self._on_file_loaded,
            on_error=lambda message, exc: self._on_file_failed(path, message, exc),
        )

    def _on_file_loaded(self, loaded: LoadedFile) -> None:
        document = Document(
            remote_path=loaded.path,
            host_id=self.session.host.id if self.session else "",
            text=loaded.text,
            saved_text=loaded.text,
            loaded_text=loaded.text,
            clean_at_open=self._clean_at_open(loaded.path),
            encoding=loaded.encoding,
            newline=loaded.newline,
            language=loaded.language,
            fingerprint=loaded.fingerprint,
        )
        tab = self.editor_tabs.add_document(document)
        tab.editor.go_to_line(document.cursor_line)
        self.cache.store(document.host_id, document.remote_path, loaded.text.encode("utf-8"))
        self.cache.add_recent(document.host_id, document.remote_path)
        self.status.set_save_status("已加载")
        logger.info("已打开 %s（%s，%s）", loaded.path, loaded.encoding, loaded.language)
        # 先让编辑器完成首次绘制，再拉取 Git diff，避免打开大文件时界面顿一下
        QTimer.singleShot(0, lambda: self._refresh_git(document))

    def _clean_at_open(self, path: str) -> bool:
        """打开时该文件是否相对 ``HEAD`` 干净（供「撤销修改后撤掉着色」判断）。"""
        snapshot = self.file_tree.status_snapshot()
        if snapshot is None:
            return False
        status = snapshot.status_for_diff(path)
        return status is not None and status.change_type is None

    def _on_file_failed(self, path: str, message: str, exc: Optional[BaseException] = None) -> None:
        if isinstance(exc, UnknownEncodingError):
            self._prompt_encoding(path)
            return
        QMessageBox.warning(self, "打开文件失败", f"{path}\n\n{message}")
        self.status.set_save_status("打开失败")

    def _prompt_encoding(self, path: str) -> None:
        """无法识别编码时，让用户手动选择（需求 5.11）。"""
        options = list(SELECTABLE_ENCODINGS)
        choice, ok = QInputDialog.getItem(
            self, "选择文件编码", f"无法自动识别 {posixpath.basename(path)} 的编码，请选择：",
            options, 0, False,
        )
        if not ok or not choice:
            self.status.set_save_status("已取消打开")
            return
        self._encoding_override[path] = choice
        self.open_remote_file(path, encoding=choice)

    def _current_document(self) -> Optional[Document]:
        return self.editor_tabs.current_document()

    def _save_document(self, document: Optional[Document], *, auto: bool = False) -> None:
        """保存文档；``auto=True`` 表示由自动保存触发（不弹任何模态框）。"""
        if document is None:
            return
        session = self._require_session()
        if session is None:
            return
        if document.read_only:
            if auto:
                self.status.set_save_status("只读文件，未自动保存")
            else:
                QMessageBox.information(self, "只读文件", "该文件为只读，未执行保存。")
            return
        text = self.editor_tabs.sync_text(document)
        # 冲突检测：远程文件在打开后被外部修改过
        self.runner.submit(
            session.fs.fingerprint,
            args=(document.remote_path,),
            on_success=lambda current: self._after_fingerprint(document, current, text, auto=auto),
            on_error=lambda message: self._on_operation_failed("保存前检查失败", message),
        )

    def _after_fingerprint(
        self,
        document: Document,
        current: Optional[FileFingerprint],
        text: str,
        *,
        auto: bool = False,
    ) -> None:
        if current is not None and document.fingerprint is not None and current.differs_from(
            document.fingerprint
        ):
            if auto:
                # 自动保存绝不打断输入：只提示，等用户自己决定
                logger.info("远端文件已被外部修改，跳过自动保存：%s", document.remote_path)
                self.status.set_save_status(
                    f"{document.display_name} 远端已变化，未自动保存（Ctrl+S 处理）"
                )
                return
            choice = self._ask_conflict(document)
            if choice == "cancel":
                self.status.set_save_status("已取消保存")
                return
            if choice == "reload":
                self._reload_document(document)
                return
            # overwrite：继续上传
        self._upload_document(document, text, auto=auto)

    def _ask_conflict(self, document: Document) -> str:
        """远程文件已被外部修改：让用户选择处理方式（需求 5.10）。"""
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("远程文件已被修改")
        box.setText(
            f"远程文件已发生变化：\n{document.remote_path}\n\n请选择处理方式（不会静默覆盖）。"
        )
        reload_button = box.addButton("重新加载远程", QMessageBox.ButtonRole.AcceptRole)
        overwrite_button = box.addButton("覆盖远程", QMessageBox.ButtonRole.DestructiveRole)
        cancel_button = box.addButton("取消", QMessageBox.ButtonRole.RejectRole)
        box.setDefaultButton(cancel_button)
        box.exec()
        clicked = box.clickedButton()
        if clicked is reload_button:
            return "reload"
        if clicked is overwrite_button:
            return "overwrite"
        return "cancel"

    def _reload_document(self, document: Document) -> None:
        session = self._require_session()
        if session is None:
            return
        self.editor_tabs.close_path(document.remote_path)
        self.open_remote_file(document.remote_path)

    def _upload_document(self, document: Document, text: str, *, auto: bool = False) -> None:
        session = self._require_session()
        if session is None:
            return
        self.status.set_save_status("自动保存中…" if auto else "正在上传…")
        self.runner.submit(
            remote_ops.save_file,
            args=(session, document.remote_path, text),
            kwargs={"encoding": document.encoding, "newline": document.newline},
            on_success=lambda saved: self._on_file_saved(document, text, saved, auto=auto),
            on_error=lambda message: self._on_save_failed(document, message, auto=auto),
        )

    def _on_file_saved(
        self, document: Document, text: str, saved: SavedFile, *, auto: bool = False
    ) -> None:
        document.mark_saved(text)
        document.fingerprint = saved.fingerprint
        editor = self.editor_tabs.editor_for_path(document.remote_path)
        if editor is not None:
            editor.document().setModified(False)
        self.editor_tabs.update_titles()
        self.status.set_save_status("已自动保存" if auto else "已保存")
        logger.info("已上传 %s（%d 字节，%s）", saved.path, saved.size, "自动" if auto else "手动")
        self._apply_saved_status(saved.path, clean=document.reverted)

    def _apply_saved_status(self, path: str, *, clean: bool = False) -> None:
        """保存后按本地知识更新 Git 标记，省掉一次 ``git status`` 往返。

        只有快照覆盖这个文件时才敢下结论；否则（文件在工作目录之外、或快照
        尚未建立）安排一次延迟刷新兜底。
        """
        snapshot = self.file_tree.status_snapshot()
        if snapshot is None or not snapshot.mark_saved(path, clean=clean):
            self._git_timer.start()
            return
        self.file_tree.refresh_status()
        self.scm_view.set_snapshot(snapshot)
        self.status.set_git(snapshot.label)

    def _on_save_failed(self, document: Document, message: str, *, auto: bool = False) -> None:
        if not auto:
            QMessageBox.critical(self, "保存失败", f"{document.remote_path}\n\n{message}")
        self.status.set_save_status("保存失败")

    def _save_all(self) -> None:
        for document in self.editor_tabs.dirty_documents():
            self._save_document(document)

    def _auto_save(self) -> None:
        if not self.settings.auto_save or self.session is None:
            return
        dirty = self.editor_tabs.dirty_documents()
        if dirty:
            logger.info("自动保存 %d 个文件", len(dirty))
            for document in dirty:
                self._save_document(document, auto=True)

    def _close_document(self, document: Document) -> None:
        index = self.editor_tabs.index_of_path(document.remote_path)
        if index < 0:
            return
        editor = self.editor_tabs.editor_for_path(document.remote_path)
        if editor is not None and editor.document().isModified():
            box = QMessageBox(self)
            box.setIcon(QMessageBox.Icon.Question)
            box.setWindowTitle("未保存的修改")
            box.setText(f"{document.display_name} 有未保存的修改，是否保存？")
            save_button = box.addButton("保存", QMessageBox.ButtonRole.AcceptRole)
            discard_button = box.addButton("不保存", QMessageBox.ButtonRole.DestructiveRole)
            box.addButton("取消", QMessageBox.ButtonRole.RejectRole)
            box.exec()
            clicked = box.clickedButton()
            if clicked is save_button:
                self._save_document(document)
                return
            if clicked is discard_button:
                self.editor_tabs.force_close(index)
                return
            return
        self.editor_tabs.force_close(index)

    def _close_current_tab(self) -> None:
        document = self._current_document()
        if document is not None:
            self._close_document(document)
        else:
            self.editor_tabs.force_close(self.editor_tabs.currentIndex())

    # ------------------------------------------------------------------
    # Git Diff
    # ------------------------------------------------------------------
    def _refresh_git(self, document: Optional[Document]) -> None:
        if document is None or self.session is None:
            return
        text = document.text
        # 复用文件树快照里的文件状态：状态干净且文件自快照以来未被改过时，
        # 连 `git diff` 都能省掉，打开未修改的文件几乎零远端开销
        snapshot = self.file_tree.status_snapshot()
        status = None
        if snapshot is not None:
            mtime = document.fingerprint.mtime if document.fingerprint else 0.0
            status = snapshot.status_for_diff(document.remote_path, mtime=mtime)
        self.runner.submit(
            remote_ops.load_git_diff,
            args=(self.session, document.remote_path, text),
            kwargs={"status": status},
            on_success=lambda diff: self._on_diff_loaded(document, diff),
            on_error=lambda message: self._on_diff_failed(document, message),
        )

    def _refresh_git_for_current(self) -> None:
        document = self._current_document()
        if document is None:
            return
        self.editor_tabs.sync_text(document)
        self._refresh_tree_status()
        self._refresh_git(document)

    def _refresh_repo_info(self) -> None:
        """识别工作目录所属仓库并刷新状态栏（同时刷新文件树着色）。"""
        self._refresh_tree_status()

    def _refresh_tree_status(self) -> None:
        """取整棵文件树的 Git 状态快照，用于着色 / 状态栏 / diff 复用。"""
        session = self.session
        if session is None:
            return
        self.runner.submit(
            remote_ops.load_tree_status,
            args=(session, self.workspace or session.workspace),
            on_success=self._on_tree_status_loaded,
            on_error=lambda _message: self.status.set_git("Git: unavailable"),
        )

    def _on_tree_status_loaded(self, status) -> None:
        self.file_tree.set_status_snapshot(status)
        self.scm_view.set_snapshot(status)
        self.status.set_git(status.label)

    def _on_diff_loaded(self, document: Document, diff: FileDiff) -> None:
        max_lines = None
        editor = self.editor_tabs.editor_for_path(document.remote_path)
        if editor is not None:
            max_lines = editor.blockCount()
        markers = {
            line: change
            for line, change in diff.markers.items()
            if max_lines is None or line <= max_lines
        }
        self.editor_tabs.set_markers(document, markers)
        stored = document.diff
        self.status.set_git(
            (self.session.repo_info().label if self.session else "Git"),
            f"+{len(stored.added_lines)} ~{len(stored.modified_lines)} -{len(stored.deleted_lines)}",
        )
        if diff.is_deleted_file:
            self.status.set_save_status("远程文件已删除")

    def _on_diff_failed(self, document: Document, message: str) -> None:
        logger.warning("获取 Git diff 失败 %s：%s", document.remote_path, message)
        self.status.set_git("Git: unavailable")

    # ------------------------------------------------------------------
    # 文档 / 编辑器事件
    # ------------------------------------------------------------------
    def _on_document_activated(self, document: Optional[Document]) -> None:
        self._update_editor_stack()
        if document is None:
            self.status.set_file("-")
            self.status.set_language("-")
            self.status.set_encoding("-")
            return
        self.status.set_file(document.display_name)
        self.status.set_language(document.language)
        self.status.set_encoding(document.encoding)
        self.status.set_save_status("已修改（未保存）" if document.dirty else "已保存")
        editor = self.editor_tabs.current_editor()
        if editor is not None:
            self.status.set_cursor(editor.current_line_number(), editor.current_column())
        selection = editor.textCursor().selectedText() if editor is not None else ""
        self.search_bar.set_selection_prefill(selection)

    def _on_document_dirty_changed(self, document: Document, dirty: bool) -> None:
        if document is self._current_document():
            self.status.set_save_status("已修改（未保存）" if dirty else "已保存")
        if dirty and self.settings.auto_save:
            self._auto_save_timer.start(max(self.settings.auto_save_delay_ms, 300))

    def _show_search(self, with_replace: bool) -> None:
        editor = self.editor_tabs.current_editor()
        if editor is None:
            return
        cursor = editor.textCursor()
        if cursor.hasSelection():
            self.search_bar.set_selection_prefill(cursor.selectedText().replace("\u2029", "\n"))
        self.search_bar.activate(with_replace=with_replace)

    def _on_search(self, pattern: str, forward: bool, case: bool, regex: bool) -> None:
        editor = self.editor_tabs.current_editor()
        if editor is None:
            return
        try:
            found = editor.find(pattern, forward=forward, case_sensitive=case, regex=regex)
        except ValueError as exc:
            self.search_bar.set_result(str(exc))
            return
        total = editor.count_matches(pattern, case_sensitive=case, regex=regex)
        self.search_bar.set_result(f"{total} 处" if found else "未找到")

    def _on_replace(self, pattern: str, replacement: str, case: bool, regex: bool) -> None:
        editor = self.editor_tabs.current_editor()
        if editor is None:
            return
        try:
            replaced = editor.replace_current(pattern, replacement, case_sensitive=case, regex=regex)
        except ValueError as exc:
            self.search_bar.set_result(str(exc))
            return
        self.search_bar.set_result("已替换" if replaced else "未找到")

    def _on_replace_all(self, pattern: str, replacement: str, case: bool, regex: bool) -> None:
        editor = self.editor_tabs.current_editor()
        if editor is None:
            return
        try:
            count = editor.replace_all(pattern, replacement, case_sensitive=case, regex=regex)
        except ValueError as exc:
            self.search_bar.set_result(str(exc))
            return
        self.search_bar.set_result(f"已替换 {count} 处")

    def _goto_line(self) -> None:
        editor = self.editor_tabs.current_editor()
        if editor is None:
            return
        line, ok = QInputDialog.getInt(
            self, "转到行", "行号：", editor.current_line_number(), 1, max(editor.blockCount(), 1)
        )
        if ok:
            editor.go_to_line(line)

    def _editor_call(self, method: str) -> None:
        editor = self.editor_tabs.current_editor()
        if editor is not None:
            getattr(editor, method)()

    # ------------------------------------------------------------------
    # 杂项
    # ------------------------------------------------------------------
    def _set_busy(self, busy: bool) -> None:
        self.action_connect.setEnabled(not busy)
        if busy:
            self.status.set_save_status("处理中…")

    def install_log_handler(self) -> None:
        """把日志接到日志面板（由 main.py 调用）。"""
        self.log_view.install_handler()

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        if not self._confirm_exit_with_unsaved():
            event.ignore()
            return
        session = self.session
        if session is not None:
            try:
                session.close()
            except Exception as exc:  # pragma: no cover - 退出时不再打扰用户
                logger.warning("关闭会话失败：%s", exc)
        self.runner.shutdown()
        super().closeEvent(event)

    def _confirm_exit_with_unsaved(self) -> bool:
        """退出前确认未保存文件；无未保存内容时直接返回 True。"""
        dirty = self.editor_tabs.dirty_documents()
        if not dirty:
            return True
        names = "、".join(document.display_name for document in dirty[:5])
        confirm = QMessageBox.question(
            self,
            "退出确认",
            f"以下文件有未保存的修改：\n{names}\n\n确定退出吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        return confirm == QMessageBox.StandardButton.Yes
