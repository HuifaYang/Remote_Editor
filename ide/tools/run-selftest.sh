#!/usr/bin/env bash
# Q1 验证：让**已安装的 VSCode** 通过我们自己的 SSH 层读/写远端文件。
# 全程只落在工作目录内：扩展在 ide/extensions/sshfs，假服务端靶机与运行产物在 ide/tools/。
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TOOLS/../.." && pwd)"
EXT="$ROOT/ide/extensions/sshfs"
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"

mkdir -p "$TOOLS/build" "$TOOLS/tmp" "$TOOLS/udd" "$TOOLS/ext"
export TMPDIR="$TOOLS/tmp"
PORT_FILE="$TOOLS/tmp/port.txt"
REPORT="$TOOLS/tmp/report.json"
rm -f "$PORT_FILE" "$REPORT"

echo "== 1/4 编译假 SSH 服务端（tests/integration/fake-ssh-server.ts → ide/tools/build）"
# 单文件编译没带项目 tsconfig，会报几个类型错（tsc 默认仍产出 JS），这里只要 JS 能跑
(cd "$ROOT" && npx tsc tests/integration/fake-ssh-server.ts \
  --outDir "$TOOLS/build" --module commonjs --target ES2022 \
  --moduleResolution node --esModuleInterop --skipLibCheck --types node) \
  || echo "(tsc 有类型报错，已忽略)"
[ -f "$TOOLS/build/fake-ssh-server.js" ] || { echo "编译产物缺失"; exit 1; }

echo "== 2/4 起假服务端"
node "$TOOLS/fake-sshd.js" "$PORT_FILE" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -f "$PORT_FILE" ] && break; sleep 0.1; done
[ -f "$PORT_FILE" ] || { echo "假服务端起不来"; exit 1; }
PORT="$(cat "$PORT_FILE")"

echo "== 3/4 起 VSCode 扩展开发宿主（自检模式，跑完自动退出）"
export RCE_SPIKE_HOST=127.0.0.1 RCE_SPIKE_PORT="$PORT" RCE_SPIKE_USER=u RCE_SPIKE_PASS=test
export RCE_SPIKE_SELFTEST=1 RCE_SPIKE_REPORT="$REPORT"
export RCE_SPIKE_KNOWN_HOSTS="$TOOLS/tmp/known_hosts" RCE_SPIKE_SSH_DIR="$TOOLS/tmp/empty-ssh"
export RCE_SPIKE_TRACE="$TOOLS/tmp/trace.log"
export ELECTRON_DISABLE_SANDBOX=1
LOG="$TOOLS/tmp/code.log"
timeout 180 xvfb-run -a /usr/bin/code \
  --extensionDevelopmentPath="$EXT" \
  --user-data-dir="$TOOLS/udd" --extensions-dir="$TOOLS/ext" \
  --disable-gpu --no-sandbox --disable-dev-shm-usage --disable-telemetry \
  --skip-welcome --skip-release-notes \
  --verbose > "$LOG" 2>&1 || echo "(宿主退出码 $? —— 自检模式会主动 quit，非 0 属正常)"

echo "（宿主输出尾部）"; tail -30 "$LOG" || true

echo "== 4/4 结果"
if [ -f "$REPORT" ]; then cat "$REPORT"; else
  echo "没有报告文件：扩展没被激活或宿主启动失败"
  ls -la "$TOOLS/udd/logs" 2>/dev/null || true
  exit 1
fi
