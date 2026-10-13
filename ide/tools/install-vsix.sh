#!/usr/bin/env bash
# 把官方 VSIX 安装到开发版的扩展目录。不会把 VSIX 提交进仓库。
#
# 用法：
#   bash ide/tools/install-vsix.sh /path/to/GitHub.copilot.vsix
#   bash ide/tools/install-vsix.sh /path/to/xxx.vsix /custom/extensions-dir
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
VSIX="${1:?用法: bash ide/tools/install-vsix.sh <file.vsix> [extensions-dir]}"
DEST="${2:-$TOOLS/ext-oss}"
[ -f "$VSIX" ] || { echo "找不到 VSIX：$VSIX" >&2; exit 1; }
mkdir -p "$DEST"

APP_CLI="$TOOLS/../VSCode-linux-x64/bin/weavecode"
if [ -x "$APP_CLI" ] && [ "${RCE_VSIX_MANUAL:-0}" != "1" ]; then
  # 优先走 CodeOSS 自己的 CLI：它会正确更新 extensions.json，不会再把手装目录标成 obsolete。
  for v in ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE VSCODE_ESM_ENTRYPOINT \
           VSCODE_IPC_HOOK VSCODE_PID VSCODE_CWD VSCODE_CLI VSCODE_HANDLES_UNCAUGHT_ERRORS \
           VSCODE_NLS_CONFIG VSCODE_CODE_CACHE_PATH VSCODE_CRASH_REPORTER_PROCESS_TYPE \
           VSCODE_DEV CODEX_INTERNAL_ORIGINATOR_OVERRIDE; do unset "$v" 2>/dev/null || true; done
  export ELECTRON_DISABLE_SANDBOX=1
  "$APP_CLI" --install-extension "$VSIX" --extensions-dir "$DEST" \
    --user-data-dir "$TOOLS/udd-vsix" --no-sandbox
  echo "重启 织码 WeaveCode 后生效。Copilot 仍需要在你自己的账号里登录授权。"
  exit 0
fi


python3 - "$VSIX" "$DEST" <<'PY'
import json, os, pathlib, shutil, sys, tempfile, zipfile

vsix = pathlib.Path(sys.argv[1]).resolve()
dest = pathlib.Path(sys.argv[2]).resolve()
with tempfile.TemporaryDirectory(prefix="rce-vsix-") as tmp:
    tmpdir = pathlib.Path(tmp)
    with zipfile.ZipFile(vsix) as z:
        z.extractall(tmpdir)
    ext = tmpdir / "extension"
    pkg = json.loads((ext / "package.json").read_text(encoding="utf-8"))
    publisher = pkg.get("publisher") or "unknown"
    name = pkg.get("name") or "extension"
    version = pkg.get("version") or "0.0.0"
    target = dest / f"{str(publisher).lower()}.{str(name).lower()}-{version}"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(ext, target)
    print(f"已安装 {publisher}.{name}@{version}")
    print(f"目录：{target}")
PY

echo "重启 织码 WeaveCode 后生效。Copilot 仍需要在你自己的账号里登录授权。"
