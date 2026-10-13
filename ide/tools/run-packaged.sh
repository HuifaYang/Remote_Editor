#!/usr/bin/env bash
# 跑打包出来的独立程序（ide/VSCode-linux-x64），在 xvfb 里起来并截一张图。
# 用户数据/扩展目录都落在 ide/tools/ 内，不碰 $HOME。
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
APP="$TOOLS/../VSCode-linux-x64/weavecode"
[ -x "$APP" ] || { echo "还没有打包产物：先跑 npm run gulp vscode-linux-x64"; exit 1; }

mkdir -p "$TOOLS/udd-pkg" "$TOOLS/ext-pkg" "$TOOLS/shots"
SHOT="$TOOLS/shots/packaged-$(date +%H%M%S).png"
WAIT="${WAIT:-25}"

xvfb-run -a -s "-screen 0 1600x1000x24" bash -c '
  set -e
  # 见 run-oss.sh 同款说明：开发终端跑在别的 VSCode 扩展宿主里，这些变量会污染被启动的 Electron
  for v in ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE VSCODE_ESM_ENTRYPOINT \
           VSCODE_IPC_HOOK VSCODE_PID VSCODE_CWD VSCODE_CLI VSCODE_HANDLES_UNCAUGHT_ERRORS \
           VSCODE_NLS_CONFIG VSCODE_CODE_CACHE_PATH VSCODE_CRASH_REPORTER_PROCESS_TYPE \
           CODEX_INTERNAL_ORIGINATOR_OVERRIDE; do unset "$v" 2>/dev/null || true; done
  export ELECTRON_DISABLE_SANDBOX=1
  "'"$APP"'" --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --locale=zh-cn --user-data-dir="'"$TOOLS"'/udd-pkg" --extensions-dir="'"$TOOLS"'/ext-pkg" \
    > "'"$TOOLS"'/tmp-pkg.log" 2>&1 &
  APP_PID=$!
  sleep '"$WAIT"'
  ffmpeg -loglevel error -f x11grab -video_size 1600x1000 -i "$DISPLAY" -frames:v 1 -y "'"$SHOT"'" || echo "(截图失败)"
  kill $APP_PID 2>/dev/null || true
  wait $APP_PID 2>/dev/null || true
'

echo "截图：$SHOT"
ls -la "$SHOT" 2>/dev/null || true
echo "=== 日志尾部 ==="; tail -8 "$TOOLS/tmp-pkg.log" || true
