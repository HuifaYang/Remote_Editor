#!/usr/bin/env bash
# 起**整个应用**（带简体中文的 CodeOSS 外壳 + 我们内置的 SSH 远端扩展），用你自己的显示器开窗口。
#
# 用法：
#   bash ide/tools/run-app.sh                                  # 用假靶机：直接进远端工作区，随便点
#   bash ide/tools/run-app.sh root@192.168.1.50[:22] [/home/root/app]   # 连真板子（密码见 RCE_PASS）
#
# 说明：
#   · 界面走 out-vscode 的 NLS 中文索引包，不用未翻译的开发版 out
#   · 先让内置 SSH 扩展注册 sshfs provider，再打开远端工作区；只复用当前这一个窗口
#   · 没有 DISPLAY 时会自动套 xvfb（纯冒烟用；有桌面环境就直接开窗口）
#   · 用户数据/扩展目录落在 ide/tools/ 下，不碰 $HOME
#   · 真板子没给密码也没关系：窗口里 Ctrl+Shift+P →「连接到远程主机」再连
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TOOLS/../.." && pwd)"
OSS="$TOOLS/../vscode"
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
export TMPDIR="$TOOLS/tmp"
export TOOLS
mkdir -p "$TOOLS/build" "$TOOLS/tmp" "$TOOLS/ext-oss" "$TOOLS/shots"
APP="$TOOLS/../VSCode-linux-x64/weavecode"

# 同一时刻只允许一个本程序实例。默认不吵醒/覆盖已有窗口，也不抢焦点；
# 确实要强制重开时用 RCE_FORCE_RESTART=1。
if pgrep -f "$APP" >/dev/null 2>&1; then
  if [ "${RCE_FORCE_RESTART:-0}" = "1" ]; then
    echo "== 关闭上一次的 织码 WeaveCode 窗口 =="
    pkill -f "$APP" 2>/dev/null || true
    sleep 1
  else
    echo "织码 WeaveCode 已在运行；不重复开窗，也不会抢到最前面。"
    exit 0
  fi
fi

# 默认保留用户数据（Copilot 登录态、扩展启用状态、窗口之外的缓存），避免每次重启都要重新登录；
# 确实要“干净重来”时用 RCE_WIPE_USER_DATA=1。窗口恢复由下面的 settings.json 关掉，不会因此多开窗口。
if [ "${RCE_WIPE_USER_DATA:-0}" = "1" ]; then
  echo "== 清空用户数据（RCE_WIPE_USER_DATA=1）=="
  rm -rf "$TOOLS/udd-app"
fi
mkdir -p "$TOOLS/udd-app"
node "$TOOLS/ensure-language-pack.mjs"
mkdir -p "$TOOLS/udd-app/User"

# 代理：设 RCE_PROXY（例如 http://127.0.0.1:7890）后，CodeOSS 外壳与扩展的 HTTP 请求
# （GitHub 登录、Copilot 授权）都走该代理；SSH/SFTP 通道不受影响。
if [ -n "${RCE_PROXY:-}" ]; then
  export HTTP_PROXY="$RCE_PROXY" HTTPS_PROXY="$RCE_PROXY"
  export http_proxy="$RCE_PROXY" https_proxy="$RCE_PROXY"
  # 回环地址（假靶机、本机语言服务）一律直连，绕过代理
  export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost,::1}"
  export no_proxy="$NO_PROXY"
  TAIL_SETTINGS='  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "http.proxy": "'"$RCE_PROXY"'"'
else
  TAIL_SETTINGS='  "workbench.secondarySideBar.defaultVisibility": "hidden"'
fi

printf '%s\n' \
  '{' \
  '  "window.restoreWindows": "none",' \
  '  "window.confirmSaveUntitledWorkspace": false,' \
  "$TAIL_SETTINGS" \
  '}' > "$TOOLS/udd-app/User/settings.json"

TARGET="${1:-}"
REMOTE_DIR="${2:-/ws}"
PORT_FILE="$TOOLS/tmp/port-app-$$.txt"
SERVER_PID=""
APP_PID=""

cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ -z "$TARGET" ]; then
  echo "== 起假靶机（真 exec / 真 shell）=="
  node "$TOOLS/build/fake-ssh-server.js" >/dev/null 2>&1 || true
  node "$TOOLS/fake-sshd.js" "$PORT_FILE" > "$TOOLS/tmp/fake-sshd-app.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 80); do [ -f "$PORT_FILE" ] && break; sleep 0.1; done
  PORT="$(cat "$PORT_FILE")"
  HOST=127.0.0.1; USER_NAME=u; PASS=test; REMOTE_DIR=/ws
  echo "   靶机 127.0.0.1:$PORT（内容在 $TOOLS/tmp/rce-fake-ssh-*/ws）"
else
  USER_NAME="${TARGET%@*}"; HOSTPORT="${TARGET#*@}"
  HOST="${HOSTPORT%%:*}"; PORT="${HOSTPORT##*:}"; [ "$PORT" = "$HOST" ] && PORT=22
  PASS="${RCE_PASS:-}"
  echo "== 连真机 $USER_NAME@$HOST:$PORT → $REMOTE_DIR =="
fi

echo "== 打包我们的远端扩展（含 SSH 层）=="
node "$TOOLS/build-extension.mjs" > "$TOOLS/tmp/build-ext.log" 2>&1 || { cat "$TOOLS/tmp/build-ext.log"; exit 1; }

[ -x "$APP" ] || {
  echo "缺少正式程序：$APP"
  echo "先构建一次正式包（使用本机 Electron 缓存）："
  echo "  cd ide/vscode && RCE_ELECTRON_ARCHIVE=~/.cache/electron/<hash>/electron-v43.7.7-linux-x64.zip npm run gulp vscode-linux-x64"
  exit 1
}

# 从别的 VSCode/IDE 的终端里启动时，环境里带一堆 VSCODE_* / ELECTRON_RUN_AS_NODE 会让它以为自己是纯 Node。
for v in ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE VSCODE_ESM_ENTRYPOINT \
         VSCODE_IPC_HOOK VSCODE_PID VSCODE_CWD VSCODE_CLI VSCODE_HANDLES_UNCAUGHT_ERRORS \
         VSCODE_NLS_CONFIG VSCODE_CODE_CACHE_PATH VSCODE_CRASH_REPORTER_PROCESS_TYPE \
         VSCODE_DEV CODEX_INTERNAL_ORIGINATOR_OVERRIDE; do unset "$v" 2>/dev/null || true; done
export ELECTRON_DISABLE_SANDBOX=1 VSCODE_SKIP_PRELAUNCH=1
# 别让工作台把 Copilot Chat 当“内置聊天扩展”在首次启动时禁用：
# extensionEnablementService#ensureChatExtensionInitialDisabledState 会在 chat setup
# 未完成时主动禁用 product.json#defaultChatAgent.chatExtensionId。我们用的是外部官方
# VSIX，一禁就变成“扩展不可用 → 去市场装 → Open VSX 没有 → 找不到”的死循环。
export VSCODE_SKIP_BUILTIN_EXTENSIONS="GitHub.copilot-chat"
export RCE_SPIKE_HOST="$HOST" RCE_SPIKE_PORT="$PORT" RCE_SPIKE_USER="$USER_NAME" RCE_SPIKE_WORKSPACE="$REMOTE_DIR"
export RCE_SPIKE_KNOWN_HOSTS="$TOOLS/tmp/known_hosts" RCE_SPIKE_SSH_DIR="$TOOLS/tmp/empty-ssh"
[ -n "$PASS" ] && export RCE_SPIKE_PASS="$PASS"

# Copilot / Copilot Chat 是官方外部 VSIX；打包版默认会拦下它们声明的 proposed API，
# 扩展被禁用后聊天面板还会去市场反复找 GitHub.copilot-chat（Open VSX 上没有）。
# 用官方开关逐扩展放行（见 extensionsProposedApi.ts）。
COMMON=(--no-sandbox --disable-gpu --disable-dev-shm-usage --disable-layout-restore --skip-welcome --locale=zh-cn --user-data-dir="$TOOLS/udd-app" --shared-data-dir="$TOOLS/udd-app/shared" --extensions-dir="$TOOLS/ext-oss" --enable-proposed-api GitHub.copilot --enable-proposed-api GitHub.copilot-chat)
URL="sshfs://${USER_NAME}@${HOST}:${PORT}${REMOTE_DIR}"
# RCE_APP_XVFB=1 可以强制走下面的 xvfb 冒烟分支（没有桌面的机器 / 自动测试用）
if [ -n "${DISPLAY:-}" ] && [ -z "${RCE_APP_XVFB:-}" ]; then
  echo "== 开窗口：$URL（Ctrl-C 退出；只开这一个窗口）=="
  "$APP" "${COMMON[@]}" --folder-uri="$URL" > "$TOOLS/tmp/app-oss.log" 2>&1 &
  APP_PID=$!
  wait "$APP_PID"
  exit $?
fi

# 没有显示器（比如 CI / 容器）：套 xvfb 起一次、截图、退出，用来冒烟
SHOT="$TOOLS/shots/app-$(date +%H%M%S).png"
export RCE_APP_SHOT="$SHOT" RCE_APP_LOG="$TOOLS/tmp/app-oss.log" RCE_APP_WAIT="${WAIT:-45}"
export APP URL
printf -v COMMON_Q '%q ' "${COMMON[@]}"
export COMMON_Q
echo "== 没有 DISPLAY → xvfb 冒烟启动（看不到画面，${RCE_APP_WAIT}s 后截图退出）=="
xvfb-run -a -s "-screen 0 1600x1000x24" bash -c '
  set -e
  eval "\"$APP\" $COMMON_Q --folder-uri=\"$URL\"" > "$RCE_APP_LOG" 2>&1 &
  APP=$!
  sleep "$RCE_APP_WAIT"
  ffmpeg -loglevel error -f x11grab -video_size 1600x1000 -i "$DISPLAY" -frames:v 1 -y "$RCE_APP_SHOT" || echo "(截图失败)"
  kill $APP 2>/dev/null || true
  pkill -f "user-data-dir=$TOOLS/udd-app" 2>/dev/null || true
  wait $APP 2>/dev/null || true
'
echo "截图：$SHOT"
