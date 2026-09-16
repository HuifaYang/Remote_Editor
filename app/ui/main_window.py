"""主窗口：装配 UI 与后台任务。

本文件只做「编排」——所有网络、Git、文件逻辑都在 app/remote、app/git、
app/ui/remote_ops 中实现，主窗口负责在它们与控件之间转发数据。
"""

from __future__ import annotations

import logging
import posixpath
from typing import Dict, List, Optional

from PySide6.QtCore import QTimer, Qt
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QDockWidget,
    QInputDialog,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from app.cache.file_cache import FileCache
from app.config.hosts import HostStore
from app.config.settings import AppSettings, SettingsStore
from app.editor.document import Document
from app.editor.syntax import detect_language
from app.git.models import FileDiff
from app.remote.remote_fs import FileFingerprint
from app.remote.session import RemoteSession
from app.ui import remote_ops
from app.ui.remote_ops import LoadedFile, SavedFile
from app.ui.settings_dialog import SettingsDialog
from app.ui.ssh_dialog import ConnectDialog
from app.ui.host_manager import HostManagerDialog
from app.ui.tasks import TaskRunner
from app.ui.theme import Theme, apply_theme, get_theme
from app.ui.widgets.editor_tabs import EditorTabs
from app.ui.widgets.file_tree import RemoteFileTree
from app.ui.widgets.log_view import LogView
from app.ui.widgets.search_bar import SearchBar
from app.ui.widgets.status_bar import StatusBar
from app.utils.encoding import SELECTABLE_ENCODINGS, UnknownEncodingError
from app.utils.paths import APP_NAME, APP_VERSION

logger = logging.getLogger(__name__)

GIT_REFRESH_DELAY_MS = 800


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

        self._git_timer = QTimer(self)
        self._git_timer.setSingleShot(True)
        self._git_timer.setInterval(GIT_REFRESH_DELAY_MS)
        self._git_timer.timeout.connect(self._refresh_git_for_current)

        self._auto_save_timer = QTimer(self)
        self._auto_save_timer.setSingleShot(True)
        self._auto_save_timer.timeout.connect(self._auto_save)

        self._encoding_override: Dict[str, str] = {}

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
    def _build_ui(self) -> None:
        self.file_tree = RemoteFileTree(self)
        self.editor_tabs = EditorTabs(self.theme, self.settings, self)
        self.search_bar = SearchBar(self)

        right = QWidget(self)
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)
        right_layout.addWidget(self.search_bar)
        right_layout.addWidget(self.editor_tabs, 1)

        self.splitter = QSplitter(Qt.Orientation.Horizontal, self)
        self.splitter.addWidget(self.file_tree)
        self.splitter.addWidget(right)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([280, 1000])
        self.setCentralWidget(self.splitter)

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

    def _build_actions(self) -> None:
        def action(text: str, shortcut: Optional[str] = None, slot=None) -> QAction:
            item = QAction(text, self)
            if shortcut:
                item.setShortcut(QKeySequence(shortcut))
            if slot is not None:
                item.triggered.connect(slot)
            return item

        self.action_connect = action("连接主机…", "Ctrl+K", self._on_connect)
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
        self.action_save.setEnabled(False)
        self.action_save_all.setEnabled(False)

    def _build_menus(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        file_menu.addAction(self.action_connect)
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
        toolbar.addAction(self.action_connect)
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
        self.file_tree.setVisible(checked)

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
        workspace = session.workspace or "/"
        self.workspace = workspace
        self.settings.remote_workspace = workspace
        self.settings_store.save(self.settings)
        self._update_status_connection(True)
        self.status.set_save_status("已连接")
        logger.info("已连接到 %s，工作目录 %s", session.host.target, workspace)
        repo = session.repo_info()
        self.status.set_git(repo.label)
        self.file_tree.set_root(workspace)
        self._load_directory(workspace)

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
        if session is not None:
            self.runner.submit(remote_ops.close_session, args=(session,))
        self._update_status_connection(False)

    def _update_status_connection(self, connected: bool) -> None:
        host = self.session.host.display_name if self.session else ""
        self.status.set_connection(connected, host)
        self.action_disconnect.setEnabled(connected)
        self.action_save.setEnabled(connected)
        self.action_save_all.setEnabled(connected)
        if not connected:
            self.status.set_git("-")

    # ------------------------------------------------------------------
    # 文件树
    # ------------------------------------------------------------------
    def _require_session(self) -> Optional[RemoteSession]:
        if self.session is None or not self.session.connected:
            QMessageBox.information(self, "未连接", "请先连接远程主机")
            return None
        return self.session

    def _load_directory(self, path: str) -> None:
        session = self._require_session()
        if session is None:
            return
        self.file_tree.mark_loading(path)
        self.runner.submit(
            remote_ops.list_directory,
            args=(session, path),
            on_success=lambda result: self._on_directory_loaded(*result),
            on_error=lambda message: self._on_directory_failed(path, message),
        )

    def _on_directory_loaded(self, path: str, entries: List) -> None:
        self.file_tree.set_children(path, entries)

    def _on_directory_failed(self, path: str, message: str) -> None:
        self.file_tree.mark_failed(path, message)
        logger.warning("列目录失败 %s：%s", path, message)

    def _refresh_workspace(self) -> None:
        if self.session is None:
            return
        root = self.workspace or self.session.workspace or "/"
        self.file_tree.set_root(root)
        self._load_directory(root)
        self._refresh_repo_info()

    def _on_refresh_requested(self, path: str) -> None:
        target = path or self.workspace or (self.session.workspace if self.session else "")
        if target:
            self._load_directory(target)

    def _create_entry(self, directory: str, *, is_dir: bool) -> None:
        session = self._require_session()
        if session is None:
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
        self._after_mutation(posixpath.dirname(path), "已删除")

    def _after_mutation(self, directory: str, message: str) -> None:
        self.status.set_save_status(message)
        if directory:
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
        self._refresh_git(document)

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

    def _save_document(self, document: Optional[Document]) -> None:
        if document is None:
            return
        session = self._require_session()
        if session is None:
            return
        if document.read_only:
            QMessageBox.information(self, "只读文件", "该文件为只读，未执行保存。")
            return
        text = self.editor_tabs.sync_text(document)
        # 冲突检测：远程文件在打开后被外部修改过
        self.runner.submit(
            session.fs.fingerprint,
            args=(document.remote_path,),
            on_success=lambda current: self._after_fingerprint(document, current, text),
            on_error=lambda message: self._on_operation_failed("保存前检查失败", message),
        )

    def _after_fingerprint(
        self, document: Document, current: Optional[FileFingerprint], text: str
    ) -> None:
        if current is not None and document.fingerprint is not None and current.differs_from(
            document.fingerprint
        ):
            choice = self._ask_conflict(document)
            if choice == "cancel":
                self.status.set_save_status("已取消保存")
                return
            if choice == "reload":
                self._reload_document(document)
                return
            # overwrite：继续上传
        self._upload_document(document, text)

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

    def _upload_document(self, document: Document, text: str) -> None:
        session = self._require_session()
        if session is None:
            return
        self.status.set_save_status("正在上传…")
        self.runner.submit(
            remote_ops.save_file,
            args=(session, document.remote_path, text),
            kwargs={"encoding": document.encoding, "newline": document.newline},
            on_success=lambda saved: self._on_file_saved(document, text, saved),
            on_error=lambda message: self._on_save_failed(document, message),
        )

    def _on_file_saved(self, document: Document, text: str, saved: SavedFile) -> None:
        document.mark_saved(text)
        document.fingerprint = saved.fingerprint
        editor = self.editor_tabs.editor_for_path(document.remote_path)
        if editor is not None:
            editor.document().setModified(False)
        self.editor_tabs.update_titles()
        self.status.set_save_status("已保存")
        logger.info("已上传 %s（%d 字节）", saved.path, saved.size)
        self._git_timer.start()

    def _on_save_failed(self, document: Document, message: str) -> None:
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
                self._save_document(document)

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
        self.runner.submit(
            remote_ops.load_git_diff,
            args=(self.session, document.remote_path, text),
            on_success=lambda diff: self._on_diff_loaded(document, diff),
            on_error=lambda message: self._on_diff_failed(document, message),
        )

    def _refresh_git_for_current(self) -> None:
        document = self._current_document()
        if document is None:
            return
        self.editor_tabs.sync_text(document)
        self._refresh_repo_info()
        self._refresh_git(document)

    def _refresh_repo_info(self) -> None:
        session = self.session
        if session is None:
            return
        self.runner.submit(
            remote_ops.load_repo_info,
            args=(session,),
            on_success=lambda repo: self.status.set_git(repo.label),
            on_error=lambda _message: self.status.set_git("Git: unavailable"),
        )

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
