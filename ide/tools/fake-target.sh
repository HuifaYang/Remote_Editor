#!/usr/bin/env bash
# 假靶机的「另一台机器」外壳：真命令外面套一层，让这台"假板子"和我们工作机长得不一样。
#
# 为什么需要：假靶机的 exec/shell 是**真的**在跑工作机上的 bash，于是镜像同步会把工作机的
#   /usr/include（本机 389MB）当成远端 sysroot 拉一遍 —— 端到端会因此慢到不可用。
# 做法：用私有挂载命名空间把系统头目录盖成 tmpfs，只放一个假 stdio.h
#   （👉 不是"跳过"这条链路：sysroot 依然会被镜像，只是内容可控，_sysroot/usr/include/stdio.h 还能验映射）。
#   python3 打个桩（退出码 1），跳过 Python 环境同步（本机 dist-packages 444MB，拉它没有验证价值）。
#
# 用法：fake-target.sh <cmd> [args...]（argv 原样透传，退出码透传）
set -euo pipefail

if [ "${RCE_FAKE_TARGET:-isolated}" = "plain" ]; then
  exec "$@"
fi

exec unshare -rm --propagation private bash -c '
  set -e
  for d in /usr/include /usr/local/include; do
    [ -d "$d" ] && mount -t tmpfs none "$d" 2>/dev/null || true
  done
  mkdir -p /usr/include /tmp/rce-fake-bin
  cat > /usr/include/stdio.h <<"HDR"
/* RCE 假靶机的系统头：只为了验证「远端 sysroot → 镜像 _sysroot → clangd -I」这条链路 */
int rce_fake_printf(const char *format, ...);
HDR
  printf "#!/bin/sh\nexit 1\n" > /tmp/rce-fake-bin/python3
  chmod +x /tmp/rce-fake-bin/python3
  export PATH="/tmp/rce-fake-bin:$PATH"
  exec "$@"
' bash "$@"
