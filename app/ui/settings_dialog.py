"""设置对话框（主题 / 编辑器 / SSH / 文件）。"""

from __future__ import annotations

from typing import Optional

from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGroupBox,
    QLineEdit,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from app.config.settings import AppSettings
from app.ui.theme import available_themes


class SettingsDialog(QDialog):
    """应用设置。"""

    def __init__(self, settings: AppSettings, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("设置")
        self.setMinimumWidth(420)
        self._settings = settings

        self.theme_combo = QComboBox(self)
        for theme in available_themes():
            self.theme_combo.addItem(theme.display_name, theme.name)
        index = self.theme_combo.findData(settings.theme)
        if index >= 0:
            self.theme_combo.setCurrentIndex(index)

        self.font_family_edit = QLineEdit(settings.font_family, self)
        self.font_family_edit.setPlaceholderText("留空使用系统等宽字体")
        self.font_size_spin = QSpinBox(self)
        self.font_size_spin.setRange(8, 32)
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

        appearance = QGroupBox("外观", self)
        appearance_form = QFormLayout(appearance)
        appearance_form.addRow("主题", self.theme_combo)
        appearance_form.addRow("字体", self.font_family_edit)
        appearance_form.addRow("字号", self.font_size_spin)

        editor_group = QGroupBox("编辑器", self)
        editor_form = QFormLayout(editor_group)
        editor_form.addRow("缩进宽度", self.tab_size_spin)
        editor_form.addRow("", self.use_spaces_box)
        editor_form.addRow("", self.word_wrap_box)
        editor_form.addRow("", self.line_numbers_box)
        editor_form.addRow("", self.current_line_box)
        editor_form.addRow("", self.auto_save_box)
        editor_form.addRow("自动保存延迟", self.auto_save_spin)

        file_group = QGroupBox("文件", self)
        file_form = QFormLayout(file_group)
        file_form.addRow("最大打开文件", self.max_file_spin)

        ssh_group = QGroupBox("SSH", self)
        ssh_form = QFormLayout(ssh_group)
        ssh_form.addRow("连接超时", self.timeout_spin)
        ssh_form.addRow("Keepalive", self.keepalive_spin)
        ssh_form.addRow("", self.strict_host_box)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel, self
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        for group in (appearance, editor_group, file_group, ssh_group):
            layout.addWidget(group)
        layout.addWidget(buttons)

    # -- 结果 --------------------------------------------------------------
    def result_settings(self) -> AppSettings:
        """返回用户修改后的设置副本。"""
        settings = AppSettings.from_dict(self._settings.to_dict())
        settings.theme = str(self.theme_combo.currentData())
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
