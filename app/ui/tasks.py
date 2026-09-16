"""异步任务执行框架。

需求 5.13：SSH 连接、SFTP 上下行、Git 查询、目录列表、文件解析
**一律不得阻塞 GUI 线程**。

实现：把可调用对象放入 :class:`QThreadPool`；结果经信号回到 GUI 线程。
回调桥对象在 GUI 线程创建，因此回调一定在 GUI 线程执行。
"""

from __future__ import annotations

import inspect
import logging
from typing import Any, Callable, Optional, Sequence

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, Slot

from app.utils.errors import describe_error

logger = logging.getLogger(__name__)


class TaskSignals(QObject):
    """工作线程 → GUI 线程的信号载体。"""

    finished = Signal(object)
    failed = Signal(str, object)  # 友好文案, 原始异常
    progress = Signal(int, int)


class CallbackBridge(QObject):
    """在 GUI 线程接收结果并调用用户回调。"""

    def __init__(
        self,
        on_success: Optional[Callable[[Any], None]] = None,
        on_error: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
        parent: Optional[QObject] = None,
    ) -> None:
        super().__init__(parent)
        self._on_success = on_success
        self._on_error = on_error
        self._on_progress = on_progress
        self._error_arity = _callable_arity(on_error)

    @Slot(object)
    def handle_finished(self, result: Any) -> None:
        if self._on_success is not None:
            self._on_success(result)

    @Slot(str, object)
    def handle_failed(self, message: str, exc: object) -> None:
        if self._on_error is None:
            logger.error("后台任务失败：%s (%s)", message, exc)
            return
        # 回调允许 ``(message)`` 或 ``(message, exception)`` 两种签名
        if self._error_arity >= 2:
            self._on_error(message, exc)
        else:
            self._on_error(message)

    @Slot(int, int)
    def handle_progress(self, done: int, total: int) -> None:
        if self._on_progress is not None:
            self._on_progress(done, total)


def _callable_arity(func: Optional[Callable[..., Any]]) -> int:
    """返回可调用对象可接受的位置参数个数（用于兼容 1/2 参数回调）。"""
    if func is None:
        return 0
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):  # pragma: no cover - 内建函数
        return 1
    count = 0
    for parameter in signature.parameters.values():
        if parameter.kind in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        ):
            count += 1
        elif parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            return 99
    return count


class Worker(QRunnable):
    """执行一个可调用对象。"""

    def __init__(self, func: Callable[..., Any], args: Sequence[Any], kwargs: dict[str, Any]) -> None:
        super().__init__()
        self._func = func
        self._args = tuple(args)
        self._kwargs = dict(kwargs)
        self.signals = TaskSignals()
        self.bridge: Optional[CallbackBridge] = None
        self.setAutoDelete(True)

    @Slot()
    def run(self) -> None:  # pragma: no cover - 线程内执行
        try:
            result = self._func(*self._args, **self._kwargs)
        except Exception as exc:
            message = describe_error(exc)
            logger.warning("任务异常：%s | %s", message, exc)
            self.signals.failed.emit(message, exc)
            return
        self.signals.finished.emit(result)


class TaskRunner(QObject):
    """统一的任务提交入口。"""

    def __init__(self, parent: Optional[QObject] = None, *, max_threads: int = 4) -> None:
        super().__init__(parent)
        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(max(1, max_threads))
        self._pending: list[Worker] = []

    @property
    def active_count(self) -> int:
        return self._pool.activeThreadCount()

    def submit(
        self,
        func: Callable[..., Any],
        *,
        args: Sequence[Any] = (),
        kwargs: Optional[dict[str, Any]] = None,
        on_success: Optional[Callable[[Any], None]] = None,
        on_error: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> Worker:
        """提交任务；``on_success`` / ``on_error`` 在 GUI 线程执行。"""
        worker = Worker(func, args, kwargs or {})
        bridge = CallbackBridge(on_success, on_error, on_progress, parent=self)
        worker.bridge = bridge
        worker.signals.finished.connect(bridge.handle_finished)
        worker.signals.finished.connect(lambda _result, w=worker: self._release(w))
        worker.signals.failed.connect(bridge.handle_failed)
        worker.signals.failed.connect(lambda _m, _e, w=worker: self._release(w))
        worker.signals.progress.connect(bridge.handle_progress)
        self._pending.append(worker)
        self._pool.start(worker)
        return worker

    def _release(self, worker: Worker) -> None:  # pragma: no cover - 由回调触发
        try:
            self._pending.remove(worker)
        except ValueError:
            pass

    def shutdown(self, *, wait: bool = False) -> None:
        """退出时调用：等待或放弃正在执行的任务。"""
        if wait:
            self._pool.waitForDone(3000)
        else:
            self._pool.clear()
