@echo off
rem =====================================================================
rem  RemoteCodeEditor - Windows 打包脚本
rem  依赖: Python 3.9+ 与 PyInstaller (pip install -r requirements.txt)
rem  产物: dist\RemoteCodeEditor.exe (单文件、无控制台、免 Python 环境)
rem =====================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set APP_NAME=RemoteCodeEditor
set ENTRY=main.py

echo [1/5] 检查 Python 环境...
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 python，请先安装 Python 3.9+ 并加入 PATH。
    exit /b 1
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)"
if errorlevel 1 (
    echo [错误] 需要 Python 3.9 或更高版本。
    exit /b 1
)

echo [2/5] 检查打包依赖...
python -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
    echo [提示] 未安装 PyInstaller，正在安装打包依赖...
    python -m pip install -r requirements.txt || exit /b 1
)

echo [3/5] 清理旧构建产物...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist "%APP_NAME%.spec" del /q "%APP_NAME%.spec"

echo [4/5] 生成图标与开始打包...
python scripts\make_icon.py

python -m PyInstaller ^
    --noconfirm ^
    --clean ^
    --onefile ^
    --windowed ^
    --name "%APP_NAME%" ^
    --icon "assets\icon.ico" ^
    --add-data "assets;assets" ^
    --paths . ^
    --hidden-import paramiko ^
    --hidden-import pygments.lexers ^
    --exclude-module PyQt5 ^
    --exclude-module PyQt6 ^
    --exclude-module PySide2 ^
    --exclude-module tkinter ^
    --exclude-module numpy ^
    --exclude-module scipy ^
    --exclude-module pandas ^
    --exclude-module matplotlib ^
    --exclude-module PySide6.QtNetwork ^
    --exclude-module PySide6.QtQml ^
    --exclude-module PySide6.QtQuick ^
    --exclude-module PySide6.QtQuick3D ^
    --exclude-module PySide6.QtMultimedia ^
    --exclude-module PySide6.QtMultimediaWidgets ^
    --exclude-module PySide6.QtWebEngineCore ^
    --exclude-module PySide6.QtWebEngineWidgets ^
    --exclude-module PySide6.QtWebEngineQuick ^
    --exclude-module PySide6.QtWebChannel ^
    --exclude-module PySide6.QtWebSockets ^
    --exclude-module PySide6.Qt3DCore ^
    --exclude-module PySide6.QtCharts ^
    --exclude-module PySide6.QtDataVisualization ^
    --exclude-module PySide6.QtSql ^
    --exclude-module PySide6.QtTest ^
    --exclude-module PySide6.QtDesigner ^
    --exclude-module PySide6.QtHelp ^
    --exclude-module PySide6.QtBluetooth ^
    --exclude-module PySide6.QtNfc ^
    --exclude-module PySide6.QtPositioning ^
    --exclude-module PySide6.QtLocation ^
    --exclude-module PySide6.QtSensors ^
    --exclude-module PySide6.QtSerialPort ^
    --exclude-module PySide6.QtTextToSpeech ^
    "%ENTRY%"
if errorlevel 1 (
    echo [错误] 打包失败，请检查上面的 PyInstaller 输出。
    exit /b 1
)

echo [5/5] 完成。
if exist "dist\%APP_NAME%.exe" (
    echo 产物: dist\%APP_NAME%.exe
    echo 提示: 请在一台未安装 Python 的干净 Win10/Win11 机器上双击验证。
) else (
    echo [错误] 未找到 dist\%APP_NAME%.exe
    exit /b 1
)

endlocal
exit /b 0
