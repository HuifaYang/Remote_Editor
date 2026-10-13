#!/usr/bin/env bash
# 跑 CodeOSS 开发版（ide/vscode/out），在 xvfb 里起来并截一张图。
# 用户数据/扩展目录都落在 ide/tools/ 内，不碰 $HOME。
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
OSS="$TOOLS/../vscode"
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"

mkdir -p "$TOOLS/udd-oss" "$TOOLS/ext-oss" "$TOOLS/shots"
node "$TOOLS/ensure-language-pack.mjs"
SHOT="$TOOLS/shots/oss-$(date +%H%M%S).png"
WAIT="${WAIT:-25}"

cd "$OSS"
xvfb-run -a -s "-screen 0 1600x1000x24" bash -c '
  set -e
  # 本项目的开发终端本身跑在某个 VSCode 扩展宿主里，环境里会带这些变量，会污染被启动的 Electron
  # （典型症状：ELECTRON_RUN_AS_NODE=1 让 CodeOSS 以纯 Node 启动，报 "electron 不提供导出 Menu"）
  for v in ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE VSCODE_ESM_ENTRYPOINT \
           VSCODE_IPC_HOOK VSCODE_PID VSCODE_CWD VSCODE_CLI VSCODE_HANDLES_UNCAUGHT_ERRORS \
           VSCODE_NLS_CONFIG VSCODE_CODE_CACHE_PATH VSCODE_CRASH_REPORTER_PROCESS_TYPE \
           CODEX_INTERNAL_ORIGINATOR_OVERRIDE; do unset "$v" 2>/dev/null || true; done
  export ELECTRON_DISABLE_SANDBOX=1
  # 跳过 preLaunch：否则它还会去下市场内置扩展（冒烟不需要），Electron 二进制已单独下好
  export VSCODE_SKIP_PRELAUNCH=1
  ./scripts/code.sh --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --locale=zh-cn --user-data-dir="'"$TOOLS"'/udd-oss" --extensions-dir="'"$TOOLS"'/ext-oss" \
    > "'"$TOOLS"'/tmp-oss.log" 2>&1 &
  APP=$!
  sleep '"$WAIT"'
  ffmpeg -loglevel error -f x11grab -video_size 1600x1000 -i "$DISPLAY" -frames:v 1 -y "'"$SHOT"'" || echo "(截图失败)"
  kill $APP 2>/dev/null || true
  wait $APP 2>/dev/null || true
'

echo "截图：$SHOT"
ls -la "$SHOT" 2>/dev/null || true
echo "=== 启动日志尾部 ==="; tail -15 "$TOOLS/tmp-oss.log" || true
