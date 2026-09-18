@echo off
rem =====================================================================
rem  RemoteCodeEditor - Windows 安装包（安装版）
rem  前置: dist\RemoteCodeEditor.exe 已存在（先跑 build_windows.bat）
rem  依赖: NSIS 3（winget install NSIS.NSIS，或从 https://nsis.sourceforge.io 安装）
rem  产物: dist\RemoteCodeEditor_<版本>_setup.exe
rem =====================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set APP_NAME=RemoteCodeEditor

echo [1/4] 检查免安装版可执行文件...
if not exist "dist\%APP_NAME%.exe" (
    echo [错误] 未找到 dist\%APP_NAME%.exe，请先执行 scripts\build_windows.bat。
    exit /b 1
)

echo [2/4] 查找 makensis...
set MAKENSIS=
where makensis >nul 2>nul && set MAKENSIS=makensis
if not defined MAKENSIS if exist "%ProgramFiles(x86)%\NSIS\makensis.exe" set MAKENSIS="%ProgramFiles(x86)%\NSIS\makensis.exe"
if not defined MAKENSIS if exist "%ProgramFiles%\NSIS\makensis.exe" set MAKENSIS="%ProgramFiles%\NSIS\makensis.exe"
if not defined MAKENSIS (
    echo [错误] 未找到 makensis。请先安装 NSIS:
    echo         winget install NSIS.NSIS
    echo         或到 https://nsis.sourceforge.io/Download 下载安装后重试。
    exit /b 1
)

echo [3/4] 读取版本号...
set APP_VERSION=
for /f "delims=" %%v in ('python -c "import pathlib,re; text=pathlib.Path('app/utils/paths.py').read_text(); print(re.search('APP_VERSION[^0-9]*([0-9][0-9.]*)', text).group(1))" 2^>nul') do set APP_VERSION=%%v
if not defined APP_VERSION set APP_VERSION=1.0.0

echo [4/4] 生成安装包（版本 %APP_VERSION%）...
%MAKENSIS% /DAPP_VERSION=%APP_VERSION% /DOUT_FILE=dist\%APP_NAME%_%APP_VERSION%_setup.exe "scripts\installer_windows.nsi"
if errorlevel 1 (
    echo [错误] 安装包生成失败，请检查上面的 NSIS 输出。
    exit /b 1
)

echo 完成: dist\%APP_NAME%_%APP_VERSION%_setup.exe
echo 提示: 安装后外观资源放在 %%APPDATA%%\%APP_NAME%\{themes,fonts,icon-themes}\ 下自行新增。

endlocal
exit /b 0
