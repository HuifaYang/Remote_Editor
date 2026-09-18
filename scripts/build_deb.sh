#!/usr/bin/env bash
# =====================================================================
#  RemoteCodeEditor - Ubuntu/Debian 安装版（.deb）
#  前置: dist/RemoteCodeEditor 已存在（scripts/build_linux.sh 的 [4/7] 步会产出）
#        只想做安装包时: 先 `python3 -m PyInstaller ...` 或整跑一次 build_linux.sh
#  依赖: dpkg-deb（Debian/Ubuntu 自带）
#  产物: dist/RemoteCodeEditor_<版本>_<架构>.deb
#  安装: sudo apt install ./dist/RemoteCodeEditor_<版本>_<架构>.deb
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="RemoteCodeEditor"
APP_ID="remote-code-editor"
DEB_ROOT="build/deb"
BINARY="${BINARY:-dist/${APP_NAME}}"

ARCH="$(uname -m)"
case "${ARCH}" in
    x86_64|amd64) DEB_ARCH="amd64" ;;
    aarch64|arm64) DEB_ARCH="arm64" ;;
    armv7l) DEB_ARCH="armhf" ;;
    *) DEB_ARCH="${ARCH}" ;;
esac

command -v dpkg-deb >/dev/null 2>&1 || {
    echo "[错误] 未找到 dpkg-deb（非 Debian 系系统）。请在 Debian/Ubuntu 上打 .deb，"
    echo "        或改用免安装的 AppImage: bash scripts/build_linux.sh"
    exit 1
}

[ -x "${BINARY}" ] || {
    echo "[错误] 找不到可执行文件 ${BINARY}。"
    echo "        先跑 bash scripts/build_linux.sh（会完成 PyInstaller 打包并顺带生成 deb），"
    echo "        或设置 BINARY=<已打好的单文件可执行程序> 再执行本脚本。"
    exit 1
}

VERSION="$(python3 -c 'import re,pathlib;print(re.search(r"APP_VERSION\s*=\s*\"([^\"]+)\"", pathlib.Path("app/utils/paths.py").read_text()).group(1))')"

echo "[1/3] 准备 deb 目录布局（${DEB_ARCH}, v${VERSION}）..."
rm -rf "${DEB_ROOT}"
mkdir -p "${DEB_ROOT}/DEBIAN" \
         "${DEB_ROOT}/usr/bin" \
         "${DEB_ROOT}/usr/lib/${APP_ID}" \
         "${DEB_ROOT}/usr/share/applications" \
         "${DEB_ROOT}/usr/share/icons/hicolor/256x256/apps" \
         "${DEB_ROOT}/usr/share/metainfo" \
         "${DEB_ROOT}/usr/share/doc/${APP_ID}"

# 可执行文件进 /usr/lib，/usr/bin 只放一个稳定的启动命令（包名即命令名）
install -m 0755 "${BINARY}" "${DEB_ROOT}/usr/lib/${APP_ID}/${APP_NAME}"
install -m 0644 "assets/icon.png" \
    "${DEB_ROOT}/usr/share/icons/hicolor/256x256/apps/${APP_ID}.png"

cat > "${DEB_ROOT}/usr/bin/${APP_ID}" <<LAUNCHER
#!/bin/sh
# RemoteCodeEditor 启动器（真正的可执行文件在 /usr/lib/${APP_ID}/）
exec "/usr/lib/${APP_ID}/${APP_NAME}" "\$@"
LAUNCHER
chmod 0755 "${DEB_ROOT}/usr/bin/${APP_ID}"

cat > "${DEB_ROOT}/usr/share/applications/${APP_ID}.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=RemoteCodeEditor
Name[zh_CN]=远程代码编辑器
Comment=轻量级跨平台 SSH 远程代码编辑器
Exec=${APP_ID} %F
TryExec=${APP_ID}
Icon=${APP_ID}
Categories=Development;IDE;Utility;
Terminal=false
StartupWMClass=RemoteCodeEditor
DESKTOP
chmod 0644 "${DEB_ROOT}/usr/share/applications/${APP_ID}.desktop"

cat > "${DEB_ROOT}/usr/share/metainfo/${APP_ID}.appdata.xml" <<METAINFO
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
chmod 0644 "${DEB_ROOT}/usr/share/metainfo/${APP_ID}.appdata.xml"

if [ -f LICENSE ]; then
    {
        echo "${APP_NAME} ${VERSION}"
        echo
        echo "本地 GUI + SSH/SFTP 的远程代码编辑器（MIT 许可）。"
        echo
        echo "程序自带字体 / 配色主题 / 文件图标主题；用户也可以把资源放到"
        echo "  ~/.config/${APP_ID}/{themes,fonts,icon-themes}/"
        echo "自行新增（详见 docs/packaging.md）。"
        echo
        echo "本包内嵌 MIT 许可证全文如下："
        echo
        cat LICENSE
    } > "${DEB_ROOT}/usr/share/doc/${APP_ID}/copyright"
    chmod 0644 "${DEB_ROOT}/usr/share/doc/${APP_ID}/copyright"
fi

# 依赖：PyInstaller 单文件里已经带齐 Python 与 Qt，这里只声明 Qt 需要的系统库
INSTALLED_SIZE="$(du -sk "${DEB_ROOT}" | cut -f1)"
cat > "${DEB_ROOT}/DEBIAN/control" <<CONTROL
Package: ${APP_ID}
Version: ${VERSION}
Architecture: ${DEB_ARCH}
Maintainer: RemoteCodeEditor <noreply@example.com>
Installed-Size: ${INSTALLED_SIZE}
Section: devel
Priority: optional
Depends: libc6 (>= 2.31), libgcc-s1, libglib2.0-0, libx11-6, libxcb1, libxcb-cursor0, libxcb-icccm4, libxcb-image0, libxcb-keysyms1, libxcb-randr0, libxcb-render-util0, libxcb-shape0, libxcb-xinerama0, libxcb-xkb1, libxkbcommon-x11-0, libgl1, libegl1, libfontconfig1, libdbus-1-3, libfreetype6, zlib1g
Recommends: openssh-client (>= 1:8.0), git
Description: 轻量级跨平台 SSH 远程代码编辑器
 本地 GUI + SSH/SFTP，远端零常驻服务，专门适配嵌入式 ARM 板卡与高延迟链路，
 支持 Git 行级差异标记、多标签编辑与内置终端。
 .
 外观（配色主题 / 字体 / 文件图标主题）随程序分发，也可以放在配置目录下自行新增。
CONTROL

cat > "${DEB_ROOT}/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -qtf /usr/share/icons/hicolor || true
fi
exit 0
POSTINST
chmod 0755 "${DEB_ROOT}/DEBIAN/postinst"

echo "[2/3] 打包 .deb..."
mkdir -p dist
DEB_FILE="dist/${APP_NAME}_${VERSION}_${DEB_ARCH}.deb"
# --root-owner-group 需要 dpkg 1.19+（Ubuntu 20.04+）；老版本退化为普通打包
if ! dpkg-deb --root-owner-group -Zxz --build "${DEB_ROOT}" "${DEB_FILE}" 2>/dev/null; then
    echo "[提示] dpkg-deb 不支持 --root-owner-group，改用普通打包（文件属主跟随当前用户）。"
    dpkg-deb -Zxz --build "${DEB_ROOT}" "${DEB_FILE}"
fi

echo "[3/3] 完成: ${DEB_FILE}"
echo "安装: sudo apt install ./${DEB_FILE}    （会自动装齐 Qt 运行期依赖）"
echo "启动: ${APP_ID}                        （或应用菜单里点「远程代码编辑器」）"
echo "卸载: sudo apt remove ${APP_ID}"
echo "资源: ~/.config/${APP_ID}/{themes,fonts,icon-themes}/ 可自行新增主题 / 字体 / 文件图标主题"
