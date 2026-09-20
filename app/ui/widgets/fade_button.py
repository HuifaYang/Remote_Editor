"""带悬停淡入淡出动画的图标按钮。

QSS 不支持 ``transition``，默认 ``:hover`` 是瞬间换底色，看起来生硬。
这里改为：悬停进入 / 离开时用 ``QVariantAnimation`` 在 ~300ms 内对背景色的
**不透明度**做插值（底色固定、只淡 alpha，避免逐帧算混合色），手感对齐
VSCode 那种「柔和浮现」。

自绘背景 + 居中图标，不走 QSS 的 ``:hover`` —— 这样窗口按钮、工具栏、
状态栏可以共用同一套动画与圆角，保证整个应用的悬停手感统一。
"""

from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QEasingCurve, QVariantAnimation, Qt
from PySide6.QtGui import QColor, QIcon, QPainter, QPaintEvent
from PySide6.QtWidgets import QToolButton, QWidget

#: 悬停淡入 / 淡出时长（毫秒），对齐 VSCode 的手感
FADE_DURATION_MS = 300


class FadeButton(QToolButton):
    """背景色随悬停淡入淡出的图标按钮。

    :param hover_color: 悬停时的底色（只淡入它的 alpha，避免逐帧混色）。
    :param radius: 背景圆角；窗口按钮传 0（贴边直角），工具栏 / 状态栏传 4。
    """

    def __init__(
        self,
        hover_color: QColor,
        *,
        radius: float = 0.0,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self._hover_color = QColor(hover_color)
        self._radius = radius
        self._progress = 0.0  # 0 = 无底色，1 = 完整悬停底色

        self.setAutoRaise(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        # QToolButton 默认不产生 hover 进入 / 离开事件，enterEvent 不触发就等于
        # 没有淡入动画（看着就像「瞬间变色」）。必须显式打开。
        self.setAttribute(Qt.WidgetAttribute.WA_Hover, True)
        self.setMouseTracking(True)

        self._animation = QVariantAnimation(self)
        self._animation.setDuration(FADE_DURATION_MS)
        self._animation.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._animation.valueChanged.connect(self._on_animation_value)

    # -- 主题 --------------------------------------------------------------
    def set_hover_color(self, color: QColor) -> None:
        """换主题时更新悬停底色。"""
        self._hover_color = QColor(color)
        self.update()

    # -- 悬停动画 ------------------------------------------------------------
    def enterEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        self._animate_to(1.0)
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        self._animate_to(0.0)
        super().leaveEvent(event)

    def _animate_to(self, target: float) -> None:
        self._animation.stop()
        self._animation.setStartValue(self._progress)
        self._animation.setEndValue(target)
        self._animation.start()

    def _on_animation_value(self, value) -> None:
        self._progress = float(value)
        self.update()

    # -- 自绘 ----------------------------------------------------------------
    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802 - Qt 接口
        """完全自绘：先画淡入的底色，再居中画图标。

        **不调用 ``super().paintEvent()``** —— QToolButton 的 style 在 hover 时会
        自己画一块瞬时高亮背景，把动画底色盖住（这正是「看起来没动画、瞬间变红」
        的原因）。这里接管全部绘制，动画底色就是唯一的背景。
        """
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if self._progress > 0.0:
            color = QColor(self._hover_color)
            color.setAlphaF(self._hover_color.alphaF() * self._progress)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(color)
            rect = self.rect().adjusted(0, 0, -1, -1)
            if self._radius > 0:
                painter.drawRoundedRect(rect, self._radius, self._radius)
            else:
                painter.drawRect(rect)
        # 居中画图标（禁用态减半透明度）
        icon = self.icon()
        if not icon.isNull():
            size = self.iconSize()
            mode = (
                QIcon.Mode.Disabled
                if not self.isEnabled()
                else (QIcon.Mode.Active if self._progress > 0.5 else QIcon.Mode.Normal)
            )
            pixmap = icon.pixmap(size, mode)
            x = (self.width() - pixmap.width() / pixmap.devicePixelRatio()) / 2
            y = (self.height() - pixmap.height() / pixmap.devicePixelRatio()) / 2
            painter.drawPixmap(int(x), int(y), pixmap)
        painter.end()
