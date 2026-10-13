# 语言服务镜像方案（RCE）

> 状态：2026-10-13 起生效。本文是 `ide/extensions/sshfs/src/lsp.js` 与
> `src/main/mirror/manager.ts` 的设计基准；实现与本文冲突时，先改实现，再同步本文。

## 1. 为什么必须镜像

CodeOSS 的 Remote-SSH 常规形态是：

```text
编辑器 UI ──远端扩展宿主──语言服务（远端）
```

我们的硬约束是**目标机零部署、零常驻服务**，扩展宿主只能在工作机，所以不能假设板子上有
clangd / pylsp。最终形态只能是：

```text
sshfs:// 文档 ──URI/文本翻译── 本机文件镜像 ──stdio JSON-RPC── 本机 clangd / pylsp
```

镜像不是“同步一个远程文件夹给用户看”，它只是语言服务的**输入缓存**。因此不能拿整个
`/home/<user>` 或整个工作区当单位；镜像单位必须是**一个源码项目**。

## 2. 设计目标

1. **自动**：用户打开源码并触发语言服务时自动准备，不要求先点“同步”。
2. **快**：首次只传语言服务需要的文件；后续只做增量。
3. **正确**：`compile_commands.json`、系统头、Python 环境仍然按现有算法重写/补齐。
4. **可解释**：状态栏和输出通道能说清当前是检查、同步、就绪、跳过还是失败。
5. **安全**：目标机不部署东西；凭据只存内存；镜像目录在用户数据目录。
6. **可恢复**：同步失败不阻塞编辑、搜索、终端、SCM；下一次语言服务请求可重试。

## 3. 基本单位：项目

语言服务服务对象从“工作区文件夹”改成“项目根”。

项目根识别从当前文档的目录开始，向上找以下标记，最多走到当前工作区根：

- C/C++：`compile_commands.json`、`compile_flags.txt`、`CMakeLists.txt`、`Makefile`、`.clangd`
- Python：`pyproject.toml`、`setup.py`、`setup.cfg`、`requirements.txt`、`Pipfile`
- 仓库边界：`.git`

命中标记的最近目录就是项目根。没有任何标记时：

- 不把工作区根当项目；
- 退回到**当前文件所在目录**作为项目根；
- 这样 `/home/sunrise` 下的普通文件不会拖下整个 home。

项目根按 `${authority}|${projectRoot}` 缓存。一个工作区可以有多个项目，每个项目有自己的
`MirrorManager`、manifest、LSP 进程和诊断集合。

## 4. 生命周期

```text
工作区打开
  │
  ├─ 不预同步（只显示“待机”）
  │
用户打开 .c/.cpp/.py 或触发补全/跳转/悬浮
  │
  ├─ 找项目根
  ├─ 检查项目源文件数（与 tar 使用同一套过滤）
  ├─ 单飞：同一个项目只允许一次同步
  ├─ 全量/增量 tar 流 → 本地镜像是原子替换
  ├─ 重写 compile_commands.json
  ├─ 同步 sysroot 头文件（仅编译数据库涉及的目录）
  ├─ 同步 Python 环境（仅纯 Python 文件）
  └─ 启动 clangd / pylsp（按语言，复用进程）
```

工作区打开只把状态栏设为“待机”。不再在 `attachFolders()` 里对整个工作区启动镜像。

## 5. 镜像内容与过滤

### 5.1 只镜像语言服务需要的文件

当前过滤集合：

- C/C++：`*.c`、`*.h`、`*.cc`、`*.cpp`、`*.cxx`、`*.hpp`、`*.hh`、`*.hxx`、`*.inl`、`*.inc`、
  `*.m`、`*.mm`、`*.S`、`*.s`、`*.asm`、`*.ld`、`*.lds`
- Python：`*.py`、`*.pyi`
- 项目配置：`compile_commands.json`、`compile_flags.txt`、`CMakeLists.txt`、`Makefile`、`Kbuild`、
  `Kconfig`、`pyproject.toml`、`setup.py`、`setup.cfg`、`requirements.txt`、`Pipfile`、`tox.ini`、`.clangd`

不进入镜像：日志、缓存、`.git`、`node_modules`、`__pycache__`、构建产物、扩展目录、二进制、
README 等非语言服务输入文件。

### 5.2 排除规则仍然是第一道闸门

`MIRROR_EXCLUDE_PATHS` / `MIRROR_EXCLUDE_NAMES` 先排除明显不该传输的内容；源码过滤是第二道。
两个过滤必须共用，否则“计数小、tar 大”或反过来。

### 5.3 编译数据库和系统头

- `compile_commands.json` 仍由现有 `clangd-config` 收集、合并、重写。
- `-I` / `-isystem` / `-iquote` 指向系统头时，才把对应目录同步到 `_sysroot`。
- 源码目录里的头文件直接随项目镜像；不再把整个 `/usr/include` 无条件打包。

### 5.4 Python

- 项目 `.py` / `.pyi` 随项目同步。
- `site-packages` 只取纯 Python 文件，排除 `.so` / `.pyd`；具体目录由远端 `sys.path` 决定。
- Python 服务只在第一次 Python 语言请求时启动。

## 6. 缓存与哈希

每个项目独立缓存：

```text
<globalStorage>/mirror/<sha1(authority + projectRoot)>
<globalStorage>/lsp/<sha1(authority + projectRoot)>
```

缓存中保留：

- `manifest.json`：远端相对路径、大小、mtime；用于增量判定和删除同步。
- 源码镜像。
- `_sysroot` / `_pyenv`（如果是全量同步）。
- `compile_commands.json` / `compile_flags.txt`。

切换项目或断线不删除缓存；断线只结束进程，缓存留给下次增量。

## 7. 自动闸门

在项目同步前执行一条轻量命令：

```sh
cd <projectRoot> && find . -type f <excludes> <source-filter> | wc -l
```

- 计数使用和 tar 完全相同的过滤。
- 默认上限：`rce.lsp.maxFiles = 20000` 个**源文件**。
- 未超过：自动同步。
- 超过：先自动降级为**当前文件所在目录**，不要求用户点“同步”。
- 只有当前文件目录本身也超过上限，才显示“未同步（N 源文件）”。

源码 tar 传输有 120 秒上限，并按 4MB 粒度向状态栏报告进度，避免无限“同步中”。

## 8. 进度、状态与失败

状态栏状态：

```text
本机语言服务：待机
本机语言服务：检查项目…
本机语言服务：全量同步项目…（1/5）
本机语言服务：传输源码 12MB…
本机语言服务：镜像就绪（N 文件）
本机语言服务：同步失败
本机语言服务：未同步（N 源文件）
```

输出通道记录：

- 项目根判定结果；
- 全量/增量；
- tar 解包、compile_commands、sysroot、Python 环境各阶段；
- 失败原因和耗时。

同步失败不会让编辑器卡住：provider 返回空结果，用户下一次请求可以重试；状态栏点击可强制同步。

## 9. 并发与取消

- 同一个项目：`ensureMirror()` 单飞，重复请求复用同一个 Promise。
- 不同项目：可以分别建立镜像；实际 tar 仍受 SSH 连接和 SFTP 串行队列约束。
- 强制同步：排队，不并发写同一个 staging 目录。
- 断开连接：停止语言服务进程，取消当前同步，清理 pending。
- 关闭文档：只发 `didClose`，不杀 LSP 进程。

## 10. 与 VS Code 的关系

我们不等价复制 Remote-SSH 的远端扩展宿主；我们只复制它的**用户体验**：

- 点主机直接连接；
- 需要认证时才提示；
- 打开工作区后由编辑器触发语言服务；
- 不要求用户手动同步、手动启动服务；
- 状态栏如实显示语言服务状态。

工作区标题、文件树、搜索、终端和 SCM 继续使用 CodeOSS 原生外壳。

## 11. 当前实现状态

已落地：

- `MirrorManager` 的 tar/清单只取语言服务源文件集合。
- `rce.lsp.maxFiles` 按源文件计数，默认 20000。
- `lsp.js` 改为按文档解析项目根并懒加载项目服务。
- 工作区打开不再预同步整个目录。
- 单文件夹 transient workspace 显示真实文件夹名，不再显示“无标题（工作区）”。
- 超大项目自动降级为当前文件目录；源码传输有 120 秒上限和进度显示。

下一步（按优先级）：

1. 远端 mtime 增量同步改为项目级后台刷新；
2. clangd/pylsp 进程按项目回收，避免多项目长期占用内存；
3. 在设置页提供项目镜像大小、最后一次同步时间和手动清理入口。

## 12. 传输通道与镜像缓存

### 12.1 源码镜像走的是 SSH exec + tar，不是逐文件 SFTP，也不是 scp

当前链路：

```text
ssh2 Client
  └─ execStream("cd <项目> && find <源码过滤> -print0 | tar --null -czf - -T -")
       stdout（tar.gz 字节流）
         └─ Node pipeline 直接写入本机 .sync.tar.gz
              └─ 本机解包到项目镜像目录
```

特点：

- 复用已经建立的 ssh2 连接，不重新认证、不额外开 SSH 会话；
- 一条远端命令完成过滤、打包、传输；
- 禁止逐文件 SFTP 往返；
- `compile_commands.json` 等清单走 stderr 分段，不污染 tar 的 stdout；
- sysroot / Python 环境也走同类 `execStream + tar`。

为什么不直接 scp：

- scp 是另一个命令/协议进程，通常需要二次连接或额外 multiplexing；对嵌入式板卡的 sshd/环境依赖更多；
- scp 不能像 `find + tar` 这样在远端就完成源码过滤和排除；
- 我们已经有 ssh2 连接和 stream 抽象，直接复用 exec 通道最少状态、最少认证风险；
- 逐文件 SFTP 才是数量级更差的方案，几百/几千文件会产生大量 round trip。

编辑器的普通读文件、写文件仍然走 SFTP；只有语言服务镜像走 tar stream。

### 12.2 镜像是缓存，不是权威数据

镜像保存在 CodeOSS 的扩展全局存储目录：

```text
<userData>/User/globalStorage/remote-code-editor.rce-remote/
  mirror/<sha1(authority + projectRoot)>/
  lsp/<sha1(authority + projectRoot)>/
```

开发启动器固定用户目录时，实际路径类似：

```text
ide/tools/udd-app/User/globalStorage/remote-code-editor.rce-remote/mirror/<hash>/
```

镜像生命周期：

- 断开连接不删除，下次打开项目可以走 manifest 增量；
- 关闭窗口不删除；
- 应用退出不删除；
- 只有完整同步时用 `.staging` 重建源码树，然后原子替换；
- `_sysroot` / `_pyenv` / `compile_commands.json` 在源码全量替换时会被保留并继续复用；
- 自动 TTL/大小清理由 `cache.js` 管理，见下文 §13；设置里可调容量和 TTL。

远端仍然是权威数据源。本机镜像只是 clangd / pylsp 的输入副本。

## 13. 影子缓存必须有界（2026-10-13 起）

`mirror/` 和 `lsp/` 是持久缓存，断线/关窗/退出都不删除，因此必须有清理策略。当前由
`ide/extensions/sshfs/src/cache.js` 管理：

- 每个项目由 `${authority}|${projectRoot}` 哈希隔离；
- 淘汰时源码镜像和 clangd/pylsp 索引作为一个整体删除；
- 活跃项目、脏项目、手动固定的项目不自动删；
- `rce.cache.ttlDays`：超过 N 天未使用允许清理；
- `rce.cache.maxProjectMB`：单项目超过上限且不活跃时清理；
- `rce.cache.maxSizeMB`：总容量超过上限时按 LRU 清理到 70% 低水位；
- `rce.cache.cleanupOnDisconnect`：断开时额外执行一次清理；
- 启动时后台清理上次异常退出留下的 `.staging` / `.sync.tar.gz`。

默认值：总容量 10 GB、单项目 5 GB、TTL 30 天。清理缓存只会导致下次重新增量同步和重新建索引，
不会影响远端源码。

## 14. Copilot 与语言服务的关系

语言服务和 Copilot 是两条独立链路：

- 语言服务负责诊断、跳转、引用、重命名、签名、代码操作、格式化等确定性的语言能力；
- Copilot 负责 AI 补全，输入来自当前编辑器文本和 VS Code 文件系统；
- Copilot 模型不跑在目标板，也不由本产品代理；
- 本仓库不打包 GitHub Copilot 的专有 VSIX，只保留 CodeOSS 的扩展/虚拟工作区能力；
- 用户可用 `ide/tools/install-vsix.sh` 安装自己的官方 Copilot VSIX。

如果 Copilot 扩展在 `sshfs://` 虚拟工作区中无法正常工作，再评估“本地影子工作区”模式；
那会涉及搜索、SCM、终端 cwd 和保存回写语义的整体切换，不能只改 LSP。
