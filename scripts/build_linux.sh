#!/usr/bin/env bash
# =====================================================================
#  RemoteCodeEditor - Ubuntu 打包脚本（PyInstaller + AppImage）
#  依赖: python3-dev / python3-venv、PyInstaller、appimagetool（可自动下载）
#  产物: dist/RemoteCodeEditor.AppImage（可选 .deb 见脚本末尾提示）
#  适配: Ubuntu 22.04+
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="RemoteCodeEditor"
APP_ID="remote-code-editor"
ENTRY="main.py"
ARCH="$(uname -m)"
APPDIR="build/${APP_NAME}.AppDir"

case "${ARCH}" in
    x86_64|amd64) APPIMAGE_ARCH="x86_64" ;;
    aarch64|arm64) APPIMAGE_ARCH="aarch64" ;;
    armv7l) APPIMAGE_ARCH="armhf" ;;
    *) APPIMAGE_ARCH="${ARCH}" ;;
esac

echo "[1/6] 检查 Python 环境..."
command -v python3 >/dev/null 2>&1 || { echo "[错误] 未找到 python3。"; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)' \
    || { echo "[错误] 需要 Python 3.9 或更高版本。"; exit 1; }

VERSION="$(python3 -c 'import re,pathlib;print(re.search(r"APP_VERSION\s*=\s*\"([^\"]+)\"", pathlib.Path("app/utils/paths.py").read_text()).group(1))')"

echo "[2/6] 检查打包依赖..."
if ! python3 -c 'import PyInstaller' >/dev/null 2>&1; then
    echo "[提示] 未安装 PyInstaller，正在安装打包依赖..."
    python3 -m pip install --user -r requirements.txt
fi

echo "[3/6] 清理旧构建产物..."
rm -rf build/"${APP_NAME}" dist "${APPDIR}" "${APP_NAME}.spec"

echo "[4/6] 生成图标并打包可执行文件..."
python3 scripts/make_icon.py

python3 -m PyInstaller \
    --noconfirm \
    --clean \
    --onefile \
    --windowed \
    --name "${APP_NAME}" \
    --icon "assets/icon.png" \
    --add-data "assets:assets" \
    --paths . \
    --hidden-import paramiko \
    --hidden-import pygments.lexers \
    --exclude-module PyQt5 \
    --exclude-module PyQt6 \
    --exclude-module PySide2 \
    --exclude-module tkinter \
    --exclude-module numpy \
    --exclude-module scipy \
    --exclude-module pandas \
    --exclude-module matplotlib \
    --exclude-module PySide6.QtNetwork \
    --exclude-module PySide6.QtQml \
    --exclude-module PySide6.QtQuick \
    --exclude-module PySide6.QtQuick3D \
    --exclude-module PySide6.QtMultimedia \
    --exclude-module PySide6.QtMultimediaWidgets \
    --exclude-module PySide6.QtWebEngineCore \
    --exclude-module PySide6.QtWebEngineWidgets \
    --exclude-module PySide6.QtWebEngineQuick \
    --exclude-module PySide6.QtWebChannel \
    --exclude-module PySide6.QtWebSockets \
    --exclude-module PySide6.Qt3DCore \
    --exclude-module PySide6.QtCharts \
    --exclude-module PySide6.QtDataVisualization \
    --exclude-module PySide6.QtSql \
    --exclude-module PySide6.QtTest \
    --exclude-module PySide6.QtDesigner \
    --exclude-module PySide6.QtHelp \
    --exclude-module PySide6.QtBluetooth \
    --exclude-module PySide6.QtNfc \
    --exclude-module PySide6.QtPositioning \
    --exclude-module PySide6.QtLocation \
    --exclude-module PySide6.QtSensors \
    --exclude-module PySide6.QtSerialPort \
    --exclude-module PySide6.QtTextToSpeech \
    "${ENTRY}"

test -x "dist/${APP_NAME}" || { echo "[错误] 未生成 dist/${APP_NAME}"; exit 1; }

echo "[5/6] 组装 AppDir..."
mkdir -p "${APPDIR}/usr/bin" "${APPDIR}/usr/share/applications" \
         "${APPDIR}/usr/share/icons/hicolor/256x256/apps" "${APPDIR}/usr/share/metainfo"
install -m 0755 "dist/${APP_NAME}" "${APPDIR}/usr/bin/${APP_NAME}"
install -m 0644 "assets/icon.png" "${APPDIR}/usr/share/icons/hicolor/256x256/apps/${APP_ID}.png"
install -m 0644 "assets/icon.png" "${APPDIR}/${APP_ID}.png"
install -m 0644 "assets/icon.png" "${APPDIR}/.DirIcon"

cat > "${APPDIR}/AppRun" <<'APPRUN'
#!/usr/bin/env bash
set -e
HERE="$(dirname "$(readlink -f "${0}")")"
exec "${HERE}/usr/bin/RemoteCodeEditor" "$@"
APPRUN
chmod +x "${APPDIR}/AppRun"

cat > "${APPDIR}/${APP_ID}.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=RemoteCodeEditor
Name[zh_CN]=远程代码编辑器
Comment=轻量级跨平台 SSH 远程代码编辑器
Exec=RemoteCodeEditor
Icon=${APP_ID}
Categories=Development;IDE;Utility;
Terminal=false
StartupWMClass=RemoteCodeEditor
DESKTOP
cp "${APPDIR}/${APP_ID}.desktop" "${APPDIR}/usr/share/applications/${APP_ID}.desktop"

cat > "${APPDIR}/usr/share/metainfo/${APP_ID}.appdata.xml" <<METAINFO
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${APP_ID}</id>
  <name>RemoteCodeEditor</name>
  <summary>轻量级跨平台 SSH 远程代码编辑器</summary>
  <metadata_license>MIT</metadata_license>
  <project_license>MIT</project_license>
  <description>
    <p>本地 GUI + SSH/SFTP，远端零常驻服务，支持 Git 行级差异标记。</p>
  </description>
  <launchable type="desktop-id">${APP_ID}.desktop</launchable>
  <releases><release version="${VERSION}"/></releases>
</component>
METAINFO

echo "[6/6] 生成 AppImage..."
APPIMAGETOOL="$(command -v appimagetool || true)"
if [ -z "${APPIMAGETOOL}" ] && [ -x "${ROOT_DIR}/tools/appimagetool-${APPIMAGE_ARCH}.AppImage" ]; then
    APPIMAGETOOL="${ROOT_DIR}/tools/appimagetool-${APPIMAGE_ARCH}.AppImage"
fi
if [ -z "${APPIMAGETOOL}" ]; then
    echo "[提示] 未找到 appimagetool，尝试下载到 tools/ …"
    mkdir -p tools
    URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${APPIMAGE_ARCH}.AppImage"
    if command -v curl >/dev/null 2>&1 && curl -fL --retry 2 -o "tools/appimagetool-${APPIMAGE_ARCH}.AppImage" "${URL}"; then
        chmod +x "tools/appimagetool-${APPIMAGE_ARCH}.AppImage"
        APPIMAGETOOL="${ROOT_DIR}/tools/appimagetool-${APPIMAGE_ARCH}.AppImage"
    else
        echo "[警告] appimagetool 下载失败（可能无网络）。"
        echo "        可手动下载后放到 tools/ 目录，或 sudo apt install appimagetool。"
        echo "        AppDir 已就绪: ${APPDIR}"
        echo "        手动打包: ARCH=${APPIMAGE_ARCH} appimagetool ${APPDIR} dist/${APP_NAME}.AppImage"
        exit 0
    fi
fi

mkdir -p dist
ARCH="${APPIMAGE_ARCH}" "${APPIMAGETOOL}" --no-appstream "${APPDIR}" "dist/${APP_NAME}.AppImage"
chmod +x "dist/${APP_NAME}.AppImage"

echo
echo "完成: dist/${APP_NAME}.AppImage"
echo "验证: 在 Ubuntu 22.04+ 上 chmod +x 后双击或 ./dist/${APP_NAME}.AppImage"
echo "可选 .deb: 可用 linuxdeploy / deb 打包工具基于 ${APPDIR} 生成，或 fpm -s dir -t deb -n ${APP_ID} -v ${VERSION} -C ${APPDIR} ."
