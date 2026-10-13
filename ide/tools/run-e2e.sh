#!/usr/bin/env bash
# 端到端验证：在 CodeOSS 开发版里打开 sshfs:// 远端工作区，跑一遍文件/终端/搜索/SCM，
# 写 JSON 报告 + 截图。假靶机的 exec 与 shell 都是真的在跑（见 fake-sshd.js）。
#
# 需要：X（xvfb）、本地监听端口 —— 沙箱外跑。
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TOOLS/../.." && pwd)"
OSS="$TOOLS/../vscode"
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"

mkdir -p "$TOOLS/build" "$TOOLS/tmp" "$TOOLS/udd-oss" "$TOOLS/ext-e2e" "$TOOLS/shots"
node "$TOOLS/ensure-language-pack.mjs"
export TMPDIR="$TOOLS/tmp"
# 别让上一轮遗留的窗口状态（可能是旧端口的工作区）把这一轮带偏：
# window.restoreWindows=none 让每次都是"只开命令行给的那个文件夹"。
mkdir -p "$TOOLS/udd-oss/User"
printf '{\n  "window.restoreWindows": "none"\n}\n' > "$TOOLS/udd-oss/User/settings.json"
PORT_FILE="$TOOLS/tmp/port-e2e.txt"
REPORT="$TOOLS/tmp/e2e-report.json"
LOG="$TOOLS/tmp/e2e-oss.log"
SHOT="$TOOLS/shots/e2e-$(date +%H%M%S).png"
WAIT="${WAIT:-240}"
rm -f "$PORT_FILE" "$REPORT"

echo "== 1/5 编译假 SSH 服务端"
(cd "$ROOT" && npx tsc tests/integration/fake-ssh-server.ts \
  --outDir "$TOOLS/build" --module commonjs --target ES2022 \
  --moduleResolution node --esModuleInterop --skipLibCheck --types node) \
  || echo "(tsc 有类型报错，已忽略)"
[ -f "$TOOLS/build/fake-ssh-server.js" ] || { echo "编译产物缺失"; exit 1; }

echo "== 2/5 打包我们的扩展（含 SSH 层）"
(cd "$ROOT" && node ide/tools/build-extension.mjs) > "$TOOLS/tmp/build-ext.log" 2>&1 || { cat "$TOOLS/tmp/build-ext.log"; exit 1; }

echo "== 3/5 起假靶机（真 exec / 真 shell）"
node "$TOOLS/fake-sshd.js" "$PORT_FILE" > "$TOOLS/tmp/fake-sshd.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 80); do [ -f "$PORT_FILE" ] && break; sleep 0.1; done
[ -f "$PORT_FILE" ] || { echo "假靶机起不来"; cat "$TOOLS/tmp/fake-sshd.log"; exit 1; }
PORT="$(cat "$PORT_FILE")"
echo "   靶机端口 $PORT"

echo "== 4/5 起 CodeOSS 开发版并打开 sshfs:// 工作区（等待 ${WAIT}s）"
cd "$OSS"
xvfb-run -a -s "-screen 0 1600x1000x24" bash -c '
  set -e
  for v in ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE VSCODE_ESM_ENTRYPOINT \
           VSCODE_IPC_HOOK VSCODE_PID VSCODE_CWD VSCODE_CLI VSCODE_HANDLES_UNCAUGHT_ERRORS \
           VSCODE_NLS_CONFIG VSCODE_CODE_CACHE_PATH VSCODE_CRASH_REPORTER_PROCESS_TYPE \
           CODEX_INTERNAL_ORIGINATOR_OVERRIDE; do unset "$v" 2>/dev/null || true; done
  export ELECTRON_DISABLE_SANDBOX=1 VSCODE_SKIP_PRELAUNCH=1
  export RCE_SPIKE_HOST=127.0.0.1 RCE_SPIKE_PORT="'"$PORT"'" RCE_SPIKE_USER=u RCE_SPIKE_PASS=test
  export RCE_SPIKE_WORKSPACE=/ws RCE_SPIKE_E2E=1 RCE_SPIKE_REPORT="'"$REPORT"'"
  # 语言服务：用假 clangd（ide/tools/fake-lsp.js）—— 语言服务桥这条链路必须真的跑起来才算验过

  export RCE_SPIKE_KNOWN_HOSTS="'"$TOOLS"'/tmp/known_hosts" RCE_SPIKE_SSH_DIR="'"$TOOLS"'/tmp/empty-ssh"
  export RCE_SPIKE_LSP_CPP="'"$TOOLS"'/fake-lsp.js"
  ./scripts/code.sh --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --locale=zh-cn --user-data-dir="'"$TOOLS"'/udd-oss" --extensions-dir="'"$TOOLS"'/ext-e2e" \
    --folder-uri="sshfs://u@127.0.0.1:'"$PORT"'/ws" \
    > "'"$LOG"'" 2>&1 &
  APP=$!
  # 等扩展把报告写出来再收尾：E2E 内部预算 240s，固定的 sleep 会和它赛跑，
  # 跑输了（进程被杀在步骤中间）会报 Canceled / 假阴性 —— 见 docs/devlog.md。
  for _ in $(seq 1 '"$WAIT"'); do [ -f "'"$REPORT"'" ] && break; sleep 1; done
  sleep 3
  ffmpeg -loglevel error -f x11grab -video_size 1600x1000 -i "$DISPLAY" -frames:v 1 -y "'"$SHOT"'" || echo "(截图失败)"
  kill $APP 2>/dev/null || true
  wait $APP 2>/dev/null || true
'

echo "== 5/5 结果"
echo "截图：$SHOT"
if [ -f "$REPORT" ]; then cat "$REPORT"; else echo "没有报告：扩展没激活或连接失败"; fi
echo "=== 扩展日志（织码 WeaveCode 通道不进 stdout，这里看异常）==="
grep -iE "rce-|sshfs|error|fail" "$LOG" | tail -20 || true
