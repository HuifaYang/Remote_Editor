; =====================================================================
;  RemoteCodeEditor - Windows 安装包脚本（NSIS 3）
;  前置: dist\RemoteCodeEditor.exe 已由 build_windows.bat 打好
;  用法: makensis /DAPP_VERSION=1.0.0 /DOUT_FILE=dist\RemoteCodeEditor_1.0.0_setup.exe scripts\installer_windows.nsi
;        一般不用手敲，直接跑 scripts\build_windows_installer.bat
;
;  安装形态与 VSCode 一致：装到 %ProgramFiles%\RemoteCodeEditor，写开始菜单 +
;  桌面快捷方式 + 「应用和功能」里的卸载项。**外观资源仍然可以自己替换**，
;  路径是 %APPDATA%\RemoteCodeEditor\ 下的 themes / fonts / icon-themes（见 docs/packaging.md）。
; =====================================================================

!include "MUI2.nsh"
!include "FileFunc.nsh"

Unicode true
SetCompressor /SOLID lzma

!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "dist\RemoteCodeEditor_setup.exe"
!endif

!define APP_NAME "RemoteCodeEditor"
!define APP_DISPLAY_NAME "RemoteCodeEditor"
!define APP_PUBLISHER "RemoteCodeEditor"
!define APP_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCodeEditor"
!define APP_EXE "RemoteCodeEditor.exe"

Name "${APP_DISPLAY_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "${APP_REG_KEY}" "InstallLocation"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "${APP_DISPLAY_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "轻量级跨平台 SSH 远程代码编辑器"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "MIT License"

!define MUI_ICON "assets\icon.ico"
!define MUI_UNICON "assets\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 RemoteCodeEditor"
!define MUI_FINISHPAGE_TEXT "RemoteCodeEditor 已安装完成。$\r$\n$\r$\n外观资源可以自行替换：把 VSCode 主题 JSON 放到 %APPDATA%\RemoteCodeEditor\themes\，字体放到 fonts\，文件图标主题放到 icon-themes\（详见 docs/packaging.md）。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "RemoteCodeEditor" SecMain
    SetOutPath "$INSTDIR"
    File "dist\${APP_EXE}"

    CreateDirectory "$SMPROGRAMS\${APP_NAME}"
    CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_DISPLAY_NAME}.lnk" "$INSTDIR\${APP_EXE}"
    CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 RemoteCodeEditor.lnk" "$INSTDIR\Uninstall.exe"
    CreateShortCut "$DESKTOP\${APP_DISPLAY_NAME}.lnk" "$INSTDIR\${APP_EXE}"

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    WriteRegStr HKLM "${APP_REG_KEY}" "DisplayName" "${APP_DISPLAY_NAME}"
    WriteRegStr HKLM "${APP_REG_KEY}" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKLM "${APP_REG_KEY}" "Publisher" "${APP_PUBLISHER}"
    WriteRegStr HKLM "${APP_REG_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
    WriteRegStr HKLM "${APP_REG_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKLM "${APP_REG_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    WriteRegStr HKLM "${APP_REG_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegDWORD HKLM "${APP_REG_KEY}" "NoModify" 1
    WriteRegDWORD HKLM "${APP_REG_KEY}" "NoRepair" 1

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKLM "${APP_REG_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
    Delete "$INSTDIR\${APP_EXE}"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir "$INSTDIR"

    Delete "$DESKTOP\${APP_DISPLAY_NAME}.lnk"
    Delete "$SMPROGRAMS\${APP_NAME}\${APP_DISPLAY_NAME}.lnk"
    Delete "$SMPROGRAMS\${APP_NAME}\卸载 RemoteCodeEditor.lnk"
    RMDir "$SMPROGRAMS\${APP_NAME}"

    DeleteRegKey HKLM "${APP_REG_KEY}"
SectionEnd
