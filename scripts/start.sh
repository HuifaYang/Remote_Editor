#!/usr/bin/env bash
# 一键启动（开发模式）：编译 TS → 拷贝静态资源 → 启动 Electron
# 用法：./scripts/start.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/3] 编译 TypeScript…"
npm run compile --silent
echo "[2/3] 拷贝静态资源…"
node scripts/copy-assets.mjs
echo "[3/3] 启动 RemoteCodeEditor…"

# 容器 / 无显示环境自动退让到 xvfb（有显示器的机器走普通分支）
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  exec env ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx electron . --no-sandbox "$@"
fi
exec npx electron . "$@"
