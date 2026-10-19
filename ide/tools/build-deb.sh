#!/usr/bin/env bash
# 一键构建可安装的 WeaveCode Linux amd64 deb。
# 产物：ide/dist/weavecode_<version>_amd64.deb + SHA-256 + 包内容清单。
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TOOLS/../.." && pwd)"
OSS="$TOOLS/../vscode"
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
export TMPDIR="$TOOLS/tmp"
mkdir -p "$TMPDIR"

if ! command -v node >/dev/null 2>&1; then
  echo "缺少 Node.js 24：$HOME/.nvm/versions/node/v24.18.0/bin" >&2
  exit 1
fi
if [ ! -x "$OSS/node_modules/.bin/gulp" ]; then
  echo "CodeOSS 依赖未安装。先执行：cd ide/vscode && npm_config_userconfig=../tools/empty-npmrc npm install" >&2
  exit 1
fi
if ! command -v dpkg-deb >/dev/null 2>&1 || ! command -v fakeroot >/dev/null 2>&1; then
  echo "缺少 dpkg-deb 或 fakeroot，无法生成 deb。" >&2
  exit 1
fi
if ! command -v strip >/dev/null 2>&1; then
  echo "缺少 strip（binutils），无法精简内置语言服务。" >&2
  exit 1
fi

# CodeOSS 打包会向 GitHub 取 Electron。发行构建必须允许使用本机官方缓存，
# 否则网络抖动会直接让产物构建失败。
if [ -z "${RCE_ELECTRON_ARCHIVE:-}" ]; then
  ELECTRON_VERSION="$(sed -n 's/^target="\([^"]*\)"/\1/p' "$OSS/.npmrc" | head -n1)"
  if [ -n "$ELECTRON_VERSION" ]; then
    for candidate in "$HOME/.cache/electron/electron-v${ELECTRON_VERSION}-linux-x64.zip" "$HOME"/.cache/electron/*/electron-v"${ELECTRON_VERSION}"-linux-x64.zip; do
      if [ -f "$candidate" ]; then
        export RCE_ELECTRON_ARCHIVE="$candidate"
        break
      fi
    done
  fi
fi
if [ -z "${RCE_ELECTRON_ARCHIVE:-}" ] || [ ! -f "$RCE_ELECTRON_ARCHIVE" ]; then
  echo "找不到 Electron 发行包。请预先下载后设置 RCE_ELECTRON_ARCHIVE=/path/to/electron-v<version>-linux-x64.zip" >&2
  exit 1
fi
echo "Electron 本地包：$RCE_ELECTRON_ARCHIVE"

echo "== 1/7 应用品牌与发行模板 =="
node "$TOOLS/apply-branding.mjs"

echo "== 2/7 编译共享核心并打包内置扩展 =="
node "$TOOLS/build-extension.mjs"

echo "== 3/7 编译 CodeOSS =="
(cd "$OSS" && npm run compile)

echo "== 4/7 打包 Linux x64 工作台 =="
(cd "$OSS" && npm run gulp vscode-linux-x64)

# gulp 打包会从 extensions/rce-remote 复制内置扩展；再同步一次可确保刚生成的包内扩展一致。
echo "== 5/7 同步已打包工作台中的内置扩展 =="
node "$TOOLS/build-extension.mjs" >/dev/null

# 内置 clangd 注入打包暂存目录：C++ 语言服务的硬前提。扩展按
# <扩展out>/../../../../resources/clangd/linux/clangd 找它，正好落在这里；
# 不打进包的话 PATH 没有 clangd 的机器上 C++ 补全/诊断整体不可用。
# 必须在 build-extension.mjs **之后**：那个脚本会整目录删除重建扩展，先放会被清掉。
CLANGD_SRC="$ROOT/resources/clangd/linux/clangd"
if [ -f "$CLANGD_SRC" ]; then
  CLANGD_DEST_DIR="$OSS/../VSCode-linux-x64/resources/app/extensions/rce-remote/resources/clangd/linux"
  mkdir -p "$CLANGD_DEST_DIR"
  cp -f "$CLANGD_SRC" "$CLANGD_DEST_DIR/clangd"
  chmod +x "$CLANGD_DEST_DIR/clangd"
  strip --strip-unneeded "$CLANGD_DEST_DIR/clangd"
  echo "已注入内置 clangd：$CLANGD_DEST_DIR/clangd ($(du -h "$CLANGD_DEST_DIR/clangd" | cut -f1))"
else
  echo "警告：找不到 $CLANGD_SRC，deb 将不含内置 clangd（C++ 语言服务依赖 PATH 里的 clangd）" >&2
fi

# CodeOSS 开发构建保留大量 .map；正式安装包和官方 VS Code 一样必须去掉。
# 这些文件不参与运行，却会让安装体积增加数百 MB。
PACKAGED_APP="$OSS/../VSCode-linux-x64/resources/app"
MAP_COUNT="$(find "$PACKAGED_APP" -type f -name '*.map' | wc -l)"
find "$PACKAGED_APP" -type f -name '*.map' -delete
echo "已移除 source map：$MAP_COUNT 个；正式 app 体积 $(du -sh "$PACKAGED_APP" | cut -f1)"

echo "== 6/7 生成 deb =="
(cd "$OSS" && npm run gulp vscode-linux-x64-prepare-deb)
(cd "$OSS" && npm run gulp vscode-linux-x64-build-deb)

echo "== 7/7 收集产物并校验 =="
DEB_DIR="$OSS/.build/linux/deb/amd64/deb"
DEB="$(find "$DEB_DIR" -maxdepth 1 -type f -name '*.deb' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)"
if [ -z "${DEB:-}" ] || [ ! -f "$DEB" ]; then
  echo "没有在 $DEB_DIR 找到 deb 产物" >&2
  exit 1
fi

PKG="$(dpkg-deb -f "$DEB" Package)"
VERSION="$(dpkg-deb -f "$DEB" Version)"
ARCH="$(dpkg-deb -f "$DEB" Architecture)"
DIST="$ROOT/ide/dist"
mkdir -p "$DIST"
GALLERY_KIND="${RCE_EXTENSION_GALLERY:-openvsx}"
if [ -n "${RCE_EXTENSION_GALLERY_JSON:-}" ]; then
  GALLERY_KIND="custom"
fi
FLAVOR=""
if [ "$GALLERY_KIND" = "microsoft" ]; then
  FLAVOR="-ms-marketplace"
elif [ "$GALLERY_KIND" = "custom" ]; then
  FLAVOR="-custom-marketplace"
fi
OUT="$DIST/${PKG}_${VERSION}_${ARCH}${FLAVOR}.deb"
cp "$DEB" "$OUT"
dpkg-deb --info "$OUT" > "$OUT.info"
dpkg-deb --contents "$OUT" > "$OUT.contents"
(cd "$DIST" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")

# 发行产物必须真的能执行内置语言库；只检查文件存在会漏掉漏注入/权限/动态链接器问题。
VERIFY_DIR="$(mktemp -d "$TMPDIR/verify-deb-XXXXXX")"
trap 'rm -rf "$VERIFY_DIR"' EXIT
dpkg-deb -x "$OUT" "$VERIFY_DIR"
PACKAGED_CLANGD="$VERIFY_DIR/usr/share/$PKG/resources/app/extensions/rce-remote/resources/clangd/linux/clangd"
PACKAGED_PYLSP="$VERIFY_DIR/usr/share/$PKG/resources/app/extensions/rce-remote/resources/python-lsp/pylsp/__init__.py"
if [ ! -x "$PACKAGED_CLANGD" ]; then
  echo "deb 内缺少可执行 clangd：$PACKAGED_CLANGD" >&2
  exit 1
fi
if [ ! -f "$PACKAGED_PYLSP" ]; then
  echo "deb 内缺少内置 Python 语言库：$PACKAGED_PYLSP" >&2
  exit 1
fi
"$PACKAGED_CLANGD" --version >/dev/null
if find "$PACKAGED_APP" -type f -name '*.map' | grep -q .; then
  echo "deb 内仍残留 source map" >&2
  exit 1
fi
INSTALLED_KB="$(dpkg-deb -f "$OUT" Installed-Size)"
if [ "${INSTALLED_KB:-0}" -gt 1150000 ]; then
  echo "deb 安装体积异常：${INSTALLED_KB} KB（门禁上限 1150000 KB）" >&2
  exit 1
fi

if ! dpkg-deb -f "$OUT" Depends | tr ',' '\n' | sed 's/^ *//' | grep -qx 'sshfs'; then
  echo "deb 缺少开发机 sshfs 依赖" >&2
  exit 1
fi

EXPECTED_VERSION="$(node -p "require('$ROOT/package.json').version")"
DEB_BASE_VERSION="${VERSION%-[0-9]*}"   # 只去掉末尾的构建号（如 -1792057692），保留 alpha 等预发布段
if [ "$DEB_BASE_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "产品版本不一致：package.json=$EXPECTED_VERSION，deb 包版本=$VERSION" >&2
  exit 1
fi

# Copilot Chat 等官方扩展按 engines.vscode 判断宿主兼容性；应用内运行时版本使用
# 上游 CodeOSS 基线（productVersionOverride），deb 包版本仍保持 WeaveCode 版本。
OVERRIDE_VERSION="$(
  dpkg-deb --fsys-tarfile "$OUT" \
    | tar -xOf - "./usr/share/${PKG}/resources/app/product.json" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).productVersionOverride||""))'
)"
if [ -z "${OVERRIDE_VERSION:-}" ]; then
  echo "deb 内缺少 productVersionOverride，官方扩展可能因版本 3.0.0-alpha.0 被拒" >&2
  exit 1
fi

if dpkg-deb --fsys-tarfile "$OUT" | tar -xOf - "./usr/share/${PKG}/resources/app/product.json" | grep -q '"tunnelApplicationName"'; then
  echo "deb 内仍带 tunnelApplicationName，但产品不提供 tunnel" >&2
  exit 1
fi

# 只有新包全部校验通过后才清理历史发行产物，构建失败时保留上一版可回退包。
# 同一产品的旧 deb 及元数据没有继续保留价值，避免 ide/dist 每构建一次就多几百 MB。
OUT_NAME="$(basename "$OUT")"
find "$DIST" -maxdepth 1 -type f \
  \( -name "${PKG}_*.deb" \
     -o -name "${PKG}_*.deb.info" \
     -o -name "${PKG}_*.deb.contents" \
     -o -name "${PKG}_*.deb.sha256" \) \
  ! -name "$OUT_NAME" \
  ! -name "$OUT_NAME.info" \
  ! -name "$OUT_NAME.contents" \
  ! -name "$OUT_NAME.sha256" \
  -delete

echo "deb 已生成：$OUT"
echo "元数据：$OUT.info"
echo "内容清单：$OUT.contents"
echo "校验文件：$OUT.sha256"
