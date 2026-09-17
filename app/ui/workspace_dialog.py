"""远程文件夹选择对话框：连接之后再决定「打开哪个目录」。

对齐 VSCode 的使用习惯——**先连接，再选文件夹**：

* 打开时默认定位到远端家目录（``$HOME``）；
* 只列出目录，双击进入，支持「上级目录」与直接输入路径（``~`` 可用）；
* 目录列举走 :class:`~app.ui.tasks.TaskRunner`，全程不阻塞 GUI；
* 取消不改变当前工作目录。
"""

from __future__ import annotations

from typing import List, Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QStyle,
    QVBoxLayout,
    QWidget,
)

from app.remote.session import RemoteSession
from app.remote.sftp_client import RemoteEntry
from app.ui import remote_ops
from app.ui.tasks import TaskRunner

PATH_ROLE = Qt.ItemDataRole.UserRole

_STATUS_STYLE = "color: gray;"
_ERROR_STYLE = "color: #c0392b;"


class RemoteFolderPickerDialog(QDialog):
    """浏览远端目录并选定工作目录。"""

    def __init__(
        self,
        session: RemoteSession,
        *,
        initial_path: str = "",
        runner: Optional[TaskRunner] = None,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("打开远程文件夹")
        self.setMinimumSize(520, 440)
        self._session = session
        self._runner = runner or TaskRunner(self)
        self._path = ""
        self._selected = ""
        self._request_seq = 0
        self._pending_accept = False

        intro = QLabel("选择远端工作目录，文件树与 Git 标记都以它为根。", self)
        intro.setWordWrap(True)

        self.path_edit = QLineEdit(self)
        self.path_edit.setPlaceholderText("~/ros2_ws/src 或 /home/user/project")
        self.path_edit.returnPressed.connect(lambda: self._navigate(self.path_edit.text()))
        self.up_button = QPushButton("上级目录", self)
        self.up_button.clicked.connect(self._go_up)
        self.go_button = QPushButton("转到", self)
        self.go_button.clicked.connect(lambda: self._navigate(self.path_edit.text()))

        path_row = QHBoxLayout()
        path_row.addWidget(self.path_edit, 1)
        path_row.addWidget(self.go_button)
        path_row.addWidget(self.up_button)

        self.list_widget = QListWidget(self)
        self.list_widget.itemDoubleClicked.connect(self._on_item_activated)
        self.list_widget.itemActivated.connect(self._on_item_activated)
        self.list_widget.itemSelectionChanged.connect(self._on_selection_changed)

        self.status_label = QLabel("", self)
        self.status_label.setWordWrap(True)
        self.status_label.setStyleSheet(_STATUS_STYLE)

        self.buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel, self
        )
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setText("打开文件夹")
        self.buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        self.buttons.accepted.connect(self.accept)
        self.buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(intro)
        layout.addLayout(path_row)
        layout.addWidget(self.list_widget, 1)
        layout.addWidget(self.status_label)
        layout.addWidget(self.buttons)

        valid = bool(initial_path.strip())
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(valid)
        self.start(initial_path)

    # -- 结果 --------------------------------------------------------------
    def start(self, initial_path: str = "") -> None:
        """从 ``initial_path`` 开始浏览；为空则先取远端家目录。"""
        text = (initial_path or "").strip()
        if text and text not in ("~",) and not text.startswith("~/"):
            self._navigate(text)
            return
        self._set_status("正在获取远端家目录…")
        self._runner.submit(
            remote_ops.remote_home,
            args=(self._session,),
            on_success=lambda home: self._navigate(text or home),
            on_error=self._on_home_failed,
        )

    def chosen_path(self) -> str:
        """用户确认的工作目录（已展开为绝对路径）。"""
        return self._selected or self._path

    # -- 交互 --------------------------------------------------------------
    def accept(self) -> None:  # noqa: D102 - 覆盖 QDialog.accept
        text = self.path_edit.text().strip()
        if text and text != self._path:
            item = self.list_widget.currentItem()
            in_list = item is not None and str(item.data(PATH_ROLE)) == text
            if not in_list:
                # 手动输入的路径先列举校验一次，成功后再真正关闭
                self._pending_accept = True
                self._navigate(text)
                return
        self._finish_accept()

    def _finish_accept(self) -> None:
        item = self.list_widget.currentItem()
        self._selected = str(item.data(PATH_ROLE)) if item is not None else self._path
        if not self._selected:
            return
        super().accept()

    def _go_up(self) -> None:
        if self._path:
            self._navigate(remote_ops.parent_of(self._path))

    def _on_item_activated(self, item: QListWidgetItem) -> None:
        self._navigate(str(item.data(PATH_ROLE)))

    def _on_selection_changed(self) -> None:
        item = self.list_widget.currentItem()
        if item is not None:
            self.path_edit.setText(str(item.data(PATH_ROLE)))

    # -- 异步列举 ----------------------------------------------------------
    def _navigate(self, path: str) -> None:
        target = (path or "").strip()
        if not target:
            return
        self._request_seq += 1
        seq = self._request_seq
        self._set_status(f"正在读取 {target} …")
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(True)

        def on_success(result) -> None:
            self._on_listed(seq, *result)

        def on_error(message: str) -> None:
            self._on_list_failed(seq, target, message)

        self._runner.submit(
            remote_ops.list_subdirectories,
            args=(self._session, target),
            on_success=on_success,
            on_error=on_error,
        )

    def _on_listed(self, seq: int, path: str, entries: List[RemoteEntry]) -> None:
        if seq != self._request_seq:
            return
        self._path = path
        self.path_edit.setText(path)
        self.list_widget.clear()
        for entry in sorted(entries, key=lambda item: item.name.lower()):
            item = QListWidgetItem(entry.name)
            item.setData(PATH_ROLE, entry.path)
            item.setToolTip(entry.path)
            item.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_DirIcon))
            self.list_widget.addItem(item)
        self.up_button.setEnabled(path not in ("/", ""))
        self._set_status(f"{path} —— 共 {len(entries)} 个子目录")
        if self._pending_accept:
            self._pending_accept = False
            self._finish_accept()

    def _on_list_failed(self, seq: int, path: str, message: str) -> None:
        if seq != self._request_seq:
            return
        self._pending_accept = False
        self.list_widget.clear()
        self._set_status(f"无法读取 {path}：{message}", error=True)

    def _on_home_failed(self, message: str) -> None:
        self._pending_accept = False
        self._set_status(f"无法获取远端家目录：{message}", error=True)

    def _set_status(self, text: str, *, error: bool = False) -> None:
        self.status_label.setStyleSheet(_ERROR_STYLE if error else _STATUS_STYLE)
        self.status_label.setText(text)
