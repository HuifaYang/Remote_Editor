"""设置对话框（主题 / 编辑器 / SSH / 文件）。"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QPoint, Qt
from PySide6.QtGui import QFontMetrics
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSpinBox,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from app.config.settings import FONT_SIZE_MAX, FONT_SIZE_MIN, AppSettings
from app.ui.icon_theme import available_icon_themes
from app.ui.icons import make_icon
from app.ui.resources import RESOURCE_HINT, open_resource_dir, resource_root
from app.ui.theme import available_themes, get_theme, reload_themes

#: 资源目录那一行的路径最多显示多宽（放不下就中间省略，完整路径在 Tooltip 里）
_RESOURCE_PATH_WIDTH = 280


class SettingsDialog(QDialog):
    """应用设置（无边框 + 自绘标题栏，与主窗口同一套外壳）。"""

    def __init__(self, settings: AppSettings, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        # 无边框：标题栏自己画，和主窗口一致；保留 Dialog 语义 + 模态
        self.setWindowFlags(
            Qt.WindowType.Dialog
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowSystemMenuHint
        )
        self.setModal(True)
        self.setObjectName("frameless_dialog")
        self.setWindowTitle("设置")
        self.setMinimumWidth(460)
        self._settings = settings
        self._drag_origin: Optional[QPoint] = None

        # 打开设置时重扫一遍主题目录：用户新放进来的主题文件立刻可选
        reload_themes()
        self.theme_combo = QComboBox(self)
        for theme in available_themes():
            self.theme_combo.addItem(theme.display_name, theme.name)
        index = self.theme_combo.findData(settings.theme)
        if index >= 0:
            self.theme_combo.setCurrentIndex(index)

        self.icon_theme_combo = QComboBox(self)
        self.icon_theme_combo.addItem("跟随系统", "")
        for icon_theme in available_icon_themes():
            self.icon_theme_combo.addItem(icon_theme.display_name, icon_theme.name)
        icon_index = self.icon_theme_combo.findData(settings.icon_theme)
        if icon_index >= 0:
            self.icon_theme_combo.setCurrentIndex(icon_index)

        self.font_family_edit = QLineEdit(settings.font_family, self)
        self.font_family_edit.setPlaceholderText("留空使用系统等宽字体")
        self.font_size_spin = QSpinBox(self)
        self.font_size_spin.setRange(FONT_SIZE_MIN, FONT_SIZE_MAX)
        self.font_size_spin.setValue(settings.font_size)
        self.tab_size_spin = QSpinBox(self)
        self.tab_size_spin.setRange(1, 16)
        self.tab_size_spin.setValue(settings.tab_size)
        self.use_spaces_box = QCheckBox("使用空格缩进", self)
        self.use_spaces_box.setChecked(settings.use_spaces)
        self.word_wrap_box = QCheckBox("自动换行", self)
        self.word_wrap_box.setChecked(settings.word_wrap)
        self.line_numbers_box = QCheckBox("显示行号", self)
        self.line_numbers_box.setChecked(settings.show_line_numbers)
        self.current_line_box = QCheckBox("高亮当前行", self)
        self.current_line_box.setChecked(settings.highlight_current_line)
        self.auto_save_box = QCheckBox("自动保存（停止输入后自动上传，推荐）", self)
        self.auto_save_box.setChecked(settings.auto_save)
        self.auto_save_spin = QSpinBox(self)
        self.auto_save_spin.setRange(500, 30000)
        self.auto_save_spin.setSingleStep(500)
        self.auto_save_spin.setSuffix(" ms")
        self.auto_save_spin.setValue(settings.auto_save_delay_ms)
        self.auto_save_spin.setEnabled(settings.auto_save)
        self.auto_save_box.toggled.connect(self.auto_save_spin.setEnabled)

        self.max_file_spin = QSpinBox(self)
        self.max_file_spin.setRange(1, 512)
        self.max_file_spin.setSuffix(" MB")
        self.max_file_spin.setValue(settings.max_file_size_mb)

        self.timeout_spin = QSpinBox(self)
        self.timeout_spin.setRange(3, 300)
        self.timeout_spin.setSuffix(" s")
        self.timeout_spin.setValue(settings.ssh_timeout_seconds)
        self.keepalive_spin = QSpinBox(self)
        self.keepalive_spin.setRange(0, 600)
        self.keepalive_spin.setSuffix(" s")
        self.keepalive_spin.setValue(settings.ssh_keepalive_seconds)
        self.strict_host_box = QCheckBox("严格校验 known_hosts", self)
        self.strict_host_box.setChecked(settings.ssh_strict_host_key)

        appearance_form = QFormLayout()
        appearance_form.addRow("主题", self.theme_combo)
        appearance_form.addRow("文件图标", self.icon_theme_combo)
        appearance_form.addRow("字体", self.font_family_edit)
        appearance_form.addRow("字号", self.font_size_spin)
        appearance_form.addRow("资源目录", self._build_resource_row())

        editor_form = QFormLayout()
        editor_form.addRow("缩进宽度", self.tab_size_spin)
        editor_form.addRow("", self.use_spaces_box)
        editor_form.addRow("", self.word_wrap_box)
        editor_form.addRow("", self.line_numbers_box)
        editor_form.addRow("", self.current_line_box)
        editor_form.addRow("", self.auto_save_box)
        editor_form.addRow("自动保存延迟", self.auto_save_spin)

        file_form = QFormLayout()
        file_form.addRow("最大打开文件", self.max_file_spin)

        ssh_form = QFormLayout()
        ssh_form.addRow("连接超时", self.timeout_spin)
        ssh_form.addRow("Keepalive", self.keepalive_spin)
        ssh_form.addRow("", self.strict_host_box)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel, self
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(self._build_title_bar())

        body = QWidget(self)
        body_layout = QVBoxLayout(body)
        body_layout.setContentsMargins(18, 6, 18, 14)
        body_layout.setSpacing(4)
        for title, form in (
            ("外观", appearance_form),
            ("编辑器", editor_form),
            ("文件", file_form),
            ("SSH", ssh_form),
        ):
            body_layout.addWidget(self._section_title(title))
            body_layout.addLayout(form)
            body_layout.addSpacing(10)
        body_layout.addWidget(buttons)
        layout.addWidget(body, 1)
        for form in (appearance_form, editor_form, file_form, ssh_form):
            form.setHorizontalSpacing(16)
            form.setVerticalSpacing(8)
            form.setContentsMargins(0, 0, 0, 0)

    # -- 自绘标题栏 ----------------------------------------------------------
    def _build_title_bar(self) -> QWidget:
        """标题栏：左侧「设置」标题，右侧关闭按钮；按住空白处可拖动（无边框窗口）。"""
        bar = QWidget(self)
        bar.setObjectName("dialog_title_bar")
        bar_layout = QHBoxLayout(bar)
        bar_layout.setContentsMargins(14, 0, 4, 0)
        bar_layout.setSpacing(0)

        title = QLabel("设置", bar)
        title.setObjectName("dialog_title_label")
        bar_layout.addWidget(title)
        bar_layout.addStretch(1)

        close = QToolButton(bar)
        close.setObjectName("window_close")
        close.setAutoRaise(True)
        close.setToolTip("关闭")
        close.setIcon(make_icon("close", self._title_icon_color()))
        close.setIconSize(close.iconSize())
        close.clicked.connect(self.reject)
        bar_layout.addWidget(close)
        return bar

    @staticmethod
    def _title_icon_color():
        """关闭按钮图标的颜色跟随当前主题。"""
        try:
            return get_theme("dark").color("status_fg")
        except Exception:  # pragma: no cover - 主题不可用时给个安全色
            from PySide6.QtGui import QColor

            return QColor("#cccccc")

    def _section_title(self, text: str) -> QLabel:
        """分组小标题：muted 加粗，替代原来 QGroupBox 的横线框（VSCode 设置页风格）。"""
        label = QLabel(text, self)
        label.setObjectName("settings_section_title")
        font = label.font()
        font.setBold(True)
        font.setPointSizeF(font.pointSizeF() + 0.5)
        label.setFont(font)
        label.setContentsMargins(0, 8, 0, 4)
        return label

    # -- 拖动（无边框窗口）--------------------------------------------------
    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        if event.button() == Qt.MouseButton.LeftButton:
            # 只在标题栏区域拖动（避免在表单里点选文字时误拖窗口）
            if event.position().y() <= 36:
                self._drag_origin = event.globalPosition().toPoint() - self.pos()
                event.accept()
                return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        if self._drag_origin is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_origin)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        self._drag_origin = None
        super().mouseReleaseEvent(event)

    # -- 用户资源目录 ------------------------------------------------------
    def _build_resource_row(self) -> QWidget:
        """「资源目录」一行：显示路径 + 一键打开（打包成安装版后仍可替换资源）。"""
        path = resource_root()
        self.resource_path_label = QLabel(self)
        self.resource_path_label.setProperty("muted", True)
        self.resource_path_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        metrics = QFontMetrics(self.resource_path_label.font())
        self.resource_path_label.setText(
            metrics.elidedText(str(path), Qt.TextElideMode.ElideMiddle, _RESOURCE_PATH_WIDTH)
        )
        self.resource_path_label.setToolTip(f"{path}\n{RESOURCE_HINT}")

        self.resource_dir_button = QPushButton("打开", self)
        self.resource_dir_button.setToolTip(RESOURCE_HINT)
        self.resource_dir_button.clicked.connect(self._on_open_resource_dir)

        row = QWidget(self)
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(8)
        row_layout.addWidget(self.resource_path_label, 1)
        row_layout.addWidget(self.resource_dir_button)
        return row

    def _on_open_resource_dir(self) -> None:
        """建好 themes / fonts / icon-themes 三个目录再交给系统文件管理器。"""
        if not open_resource_dir():
            self.resource_path_label.setToolTip(
                f"{resource_root()}\n无桌面环境，无法自动打开；请手动进入该目录。\n{RESOURCE_HINT}"
            )

    # -- 结果 --------------------------------------------------------------
    def result_settings(self) -> AppSettings:
        """返回用户修改后的设置副本。"""
        settings = AppSettings.from_dict(self._settings.to_dict())
        settings.theme = str(self.theme_combo.currentData())
        settings.icon_theme = str(self.icon_theme_combo.currentData())
        settings.font_family = self.font_family_edit.text().strip()
        settings.font_size = int(self.font_size_spin.value())
        settings.tab_size = int(self.tab_size_spin.value())
        settings.use_spaces = self.use_spaces_box.isChecked()
        settings.word_wrap = self.word_wrap_box.isChecked()
        settings.show_line_numbers = self.line_numbers_box.isChecked()
        settings.highlight_current_line = self.current_line_box.isChecked()
        settings.auto_save = self.auto_save_box.isChecked()
        settings.auto_save_delay_ms = int(self.auto_save_spin.value())
        settings.max_file_size_mb = int(self.max_file_spin.value())
        settings.ssh_timeout_seconds = int(self.timeout_spin.value())
        settings.ssh_keepalive_seconds = int(self.keepalive_spin.value())
        settings.ssh_strict_host_key = self.strict_host_box.isChecked()
        return settings
