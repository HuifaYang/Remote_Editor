# 通用多语言语言服务设计（本机 LSP + 只读 SSHFS）

> 状态：2026-10-17 起生效。本文是 `ide/extensions/sshfs/src/lsp.js`、
> `src/main/lsp/manager.ts`、`src/main/lsp/sshfs-mount.ts`、
> `src/main/lsp/mounted-workspace.ts` 与 `src/main/lsp/server-config.ts` 的设计基准。

## 1. 结论

织码不要求目标机安装 clangd、pylsp、gopls 或任何语言服务器。默认主链路：

```text
CodeOSS 编辑器 / sshfs:// 文档
        │
        ▼
只读 SSHFS：开发机看到远端整棵 `/`
        │
        ▼
开发机标准 LSP（内置 clangd / 内置 pylsp / 用户配置的任意 LSP）
```

SSHFS 是惰性文件视图，不是源码镜像：不预取项目、不复制 sysroot、不复制 Python 环境。
目标机只需要 `sshd` 和 `sftp`。浏览模式不挂载、不启动 LSP。

旧“本机 LSP + 源码影子镜像”只保留为 `transport=local` 兼容路径；“目标机已有 LSP”只保留为
`transport=remote` 兼容路径。两者都不是默认值。

## 2. 为什么不是远端 LSP

要求目标机预装语言服务器，会把最关键的准备工作重新推给用户，而且：

- ARM 板卡上未必有合适版本的 clangd/pylsp/gopls；
- 语言服务器与目标机内存竞争，2 GB RK3566 很容易被 clangd 索引拖垮；
- 不同语言的服务器安装方式不统一，无法做到“任意标准 LSP”。

因此默认把语言服务放在开发机，目标机只承担 SFTP 文件读取。

## 3. 只读 SSHFS 视图

开发和运行时依赖开发机的 `sshfs`；deb 包声明 `Depends: sshfs`。

挂载参数：

- 远端根 `/` 挂到 `<globalStorage>/mount/<hash>/root`；
- `ro`：语言服务不能修改远端文件；
- `cache=yes`、`kernel_cache`、`auto_cache`：减少重复 SFTP 往返；
- 15 秒 keepalive、断线重连；
- 密码/私钥口令只通过 sshfs 子进程 stdin 传入，不落盘、不进参数和日志；
- 浏览模式冷却或切换 local/remote 时执行 `fusermount3 -u`。

如果开发机没有 sshfs，状态栏和错误弹窗会明确提示安装，不会静默退回旧镜像。

## 4. C++/ROS 编译视图

远端 `compile_commands.json` 里的路径仍是目标机真实路径。开发机 clangd 需要看到相同目录树，
因此生成一个**本地编译视图**，但不复制文件：

```text
远端 /usr/include/...       → SSHFS /mnt/remote/usr/include/...
远端 /opt/ros/...           → SSHFS /mnt/remote/opt/ros/...
远端 /home/Le/ws/main.cpp   → SSHFS /mnt/remote/home/Le/ws/main.cpp
```

处理步骤：

1. 通过 SSH 执行远端 GCC/Clang 探测：`-dumpmachine` 得到目标 triple；
2. 通过远端 `g++ -E -x c++ - -v` 收集目标 C++ 标准库与系统头搜索目录；
3. 找到并读取远端 `compile_commands.json`；
4. 将 `directory`、`file`、`output` 和所有绝对 include/参数重写到 SSHFS 前缀；
5. 每条命令追加 `--target=<triplet>` 和目标系统 `-isystem`；
6. 编译数据库写到本地缓存目录，clangd 通过 `--compile-commands-dir` 使用它；
7. 如果没有编译数据库，读取 CMake `flags.make` 生成 `compile_flags.txt`。

clangd 使用 `--background-index=0 --pch-storage=memory`，避免向只读远端写索引或 PCH。
当前文件语义高亮、补全、诊断、跳转仍然正常；跨文件索引由已打开文件的动态索引提供。

## 5. URI 与路径

编辑器：

```text
sshfs://user@host:port/home/Le/ros2_ws/src/main.cpp
```

开发机 LSP：

```text
file:///home/.../globalStorage/.../mount/<hash>/root/home/Le/ros2_ws/src/main.cpp
```

映射规则：

- `sshfs://` 文档 → SSHFS 挂载路径；
- LSP 返回 `file:` 的挂载路径 → 去掉挂载前缀恢复远端绝对路径 → 生成 `sshfs://` URI；
- 外部系统头 `/usr/include/...` 同样映射回 `sshfs://`，用户可直接打开；
- 非 `file:` 虚拟 URI 若由其他扩展注册 scheme，则原样交给 VSCode。

## 6. 通用语言注册表

`rce.lsp.servers` 键是服务器 ID，支持字符串命令或完整描述：

```json
{
  "go": {
    "command": "gopls",
    "args": [],
    "languageIds": ["go"],
    "extensions": [".go"],
    "rootMarkers": ["go.mod", "go.work"]
  },
  "rust": {
    "command": "rust-analyzer",
    "args": [],
    "extensions": [".rs"],
    "rootMarkers": ["Cargo.toml"]
  }
}
```

这些命令在**开发机**执行，可直接使用开发机 PATH 或绝对路径。字段：

| 字段 | 含义 |
|---|---|
| `command` | 开发机可执行文件 |
| `args` | 参数数组，不拼裸字符串 |
| `languageIds` | VSCode languageId；缺省使用服务器 ID |
| `extensions` | languageId 未识别时的扩展名兜底 |
| `rootMarkers` | 项目根标记；支持精确名和 `*.suffix` |
| `env` | 仅此进程的环境变量 |
| `initializationOptions` | 原样传给 LSP `initialize` |
| `enabled` / `false` | 关闭服务器 |

内置：

- `cpp`：随 IDE 打包的 x64 clangd；
- `python`：随 IDE 打包的 `python-lsp-server`，使用开发机 `python3`，不要求系统预装 pylsp。

用户可覆盖 `cppPath` / `pythonPath` / `servers`。任意标准 LSP 都走同一协议，不写死语言。

## 7. 双模式生命周期

```text
浏览模式（冷：无 SSHFS、无 LSP）
  │ 手动切换 / 首次编辑自动提升
  ▼
代码智能：Warming
  │ 挂载只读 SSHFS → 生成编译视图 → initialize → didOpen 最新全文
  ▼
Ready
  │ 手动切回浏览
  ▼
浏览模式（热保留，默认 5 分钟）
  │ 超时 / 手动停止
  ▼
卸载 SSHFS，停止 LSP
```

- 切换不重启窗口、扩展、编辑器模型；标签、光标和撤销历史保留。
- 当前文件优先；挂载/初始化期间继续编辑，只发送最新全文。
- 连续输入按 50ms 合并；Provider 取消时发送 `$/cancelRequest`。
- 第一次编辑自动提升后，LSP ready 时自动触发一次建议框。
- 挂载并发生成时 Provider 做一次重试，避免 VSCode 第一次请求拿到空结果并缓存。

## 8. 资源口径

浏览模式：

- LSP / SSHFS 进程均为 0；
- 额外常驻内存约 10–30 MB；
- 空闲 CPU 约 0–1%。

代码智能：

- 语言服务消耗开发机内存：小型 C++ 150–500 MB，中型 ROS 项目 500 MB–1 GB；
- RK3566 只承担 SFTP 读取，不运行 clangd；
- C++ 默认 `-j=1`，SSHFS 视图下关闭后台索引写入；
- 热保留期间进程空闲，不会重新挂载或重建索引。

## 9. 兼容模式

- `remote`：目标机已安装语言服务器时，走 SSH exec 双向 LSP，不需要 SSHFS。
- `local`：旧的源码镜像 + sysroot 同步，保留用于离线排障，不是默认值。

两者与默认 mount 模式共用同一 LSP client、Provider、双模式、取消和路径映射。

## 10. 测试策略

不连接真实远程主机：

1. `mounted-workspace` 单测：编译数据库/系统头/绝对参数重写；
2. SSHFS 集成：本地假 SSH + 真 `sshfs`，验证只读挂载和按需读取；
3. 内置 pylsp 集成：不预装 pylsp 时 initialize + completion；
4. 通用 LSP 注册表单测：cpp/python、任意语言、languageId/扩展名匹配；
5. 本地假 SSH + 假 LSP：远端兼容模式双向 JSON-RPC；
6. CodeOSS E2E：浏览冷启动、只读 SSHFS、本机 LSP、定义/悬浮/符号/补全/诊断。

真机只由用户运行并反馈日志/截图；开发过程禁止主动连接远程主机。
