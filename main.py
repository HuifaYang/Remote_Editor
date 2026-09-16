"""RemoteCodeEditor 顶层入口（供 PyInstaller 与直接运行使用）。

开发时::

    python main.py
    python -m app.main

打包时::

    pyinstaller --paths . main.py

真正的启动逻辑位于 :mod:`app.main`，本文件只做转发，保证
``--paths .`` 打包方式下 ``app`` 包可被正确导入。
"""

from __future__ import annotations

from app.main import main

if __name__ == "__main__":
    raise SystemExit(main())
