# RemoteCodeEditor —— 设计说明（V1.0）

本文档写给改代码的人：讲清**分层、选型、关键实现与测试策略**。
需求基线（必须做成什么样）见 [requirements.md](requirements.md)；使用方式与打包命令见 [../README.md](../README.md)。

---

## 1. 架构

### 1.1 链路

```
本地 PC                                             远程 ARM 板卡
┌───────────────────────────────────────┐          ┌────────────────────────┐
│ UI 层                                  │          │ 原生 sshd / sftp       │
│  主窗口 / 主机管理 / 文件树 / 编辑器    │          │ 原生 git               │
│  状态栏 / 设置 / 日志 Dock              │          │ 标准 Linux 文件系统     │
├───────────────────────────────────────┤  SSH/    │                        │
│ 异步层 QThreadPool + TaskRunner        │  SFTP    │ 无本项目常驻进程        │
├───────────────────────────────────────┤ ═══════> │ 仅短时 git 命令 / 传输  │
│ 能力层 SSH/SFTP · Git 解析 · 缓存 · 编码 │          │                        │
├───────────────────────────────────────┤          │                        │
│ 工具层 日志脱敏 · 配置 · 异常 · 路径     │          │                        │
└───────────────────────────────────────┘          └────────────────────────┘
```

### 1.2 分层职责

| 层 | 职责 | 约束 |
| --- | --- | --- |
| UI 层 | 控件装配、交互、展示 | 只做编排，不内联网络 / Git / 文件逻辑 |
| 异步层 | 把阻塞调用搬到子线程，结果回主线程 | UI 线程永不执行网络 / IO |
| 能力层 | SSH/SFTP、Git 解析、缓存、编码、文件模型 | 独立可测，与 Qt 控件解耦 |
| 工具层 | 日志、配置、异常、路径 | 跨平台适配集中在此，业务代码禁止硬编码绝对路径 |

能力层不依赖 Qt，是刻意的：将来若要把 GUI 换成其他技术栈（见 §2.2），这一层可以原样复用。

---

## 2. 技术选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 语言 | Python 3.9+ | 跨平台一致、生态完善、打包链路成熟 |
| GUI | PySide6 / Qt6 | 官方绑定；文件树/多标签/Dock/右键菜单组件齐全；高 DPI 与多平台字体支持好 |
| 编辑器控件 | `QPlainTextEdit` + 自绘 Gutter | 见 §4.1，避免引入 QScintilla 等额外依赖，便于自绘 Git 标记 |
| SSH/SFTP | paramiko | 纯 Python，不依赖系统 `ssh` 命令，满足 H4；兼容 2.9 与 3.x |
| 语法高亮 | Pygments | 词法覆盖 C/C++/Python/Bash/YAML/JSON/XML/Markdown/CMake，新增语言只加表项 |
| 打包 | PyInstaller + appimagetool | `--onefile` 免环境运行；AppImage 适配 Ubuntu 22.04+ |

选型优先级遵循 [requirements.md](requirements.md) §4.3：稳定性 → 开发效率 → 跨平台兼容性 → 性能 → 扩展性 → 技术新颖度。

### 2.1 方案对照

| 方案 | 优势 | 在本项目中的代价（否决原因） |
| --- | --- | --- |
| **Python 3 + PySide6（采用）** | `paramiko` + `Pygments` 直接覆盖 SSH/SFTP 与语法高亮两大难点；文件树/多标签/Dock/无边框自绘 Gutter 都是 Qt 现成能力 | 运行时体积与冷启动不如编译语言；对 1280×820 的 GUI 应用而言可接受 |
| Rust + egui | 单文件二进制、内存安全、启动快 | egui 是**立即模式绘制库**，没有现成的树控件/多标签/托盘/文件对话框，编辑器与 Gutter 需从零自绘；SSH 侧需 `russh`/`ssh2`，成熟度与文档成本高于 paramiko；项目周期内收益为负 |
| Rust + Tauri | Web 前端生态、产物小 | 本质是 WebView 应用：需要前端工程链，编辑器要引入 Monaco/CodeMirror，与需求 H1「纯桌面 GUI、非 Web」不符，且本地内存占用更高 |
| C++ + Qt | 性能最好、产物可控 | 需要自行维护 CMake/vcpkg/conan 构建与 CI，SSH/SFTP 要接 `libssh2`，语法高亮要接 KSyntaxHighlighting 或自研；内存管理的调试成本远高于收益 |

### 2.2 结论

本项目的瓶颈在**远程链路（SSH/SFTP 往返）与用户体验**，不在本地计算。
Python 让「SSH + 高亮 + GUI」三个难点各自有一个成熟库，能在最短时间内把编辑器做稳。
若后续确实需要更小的分发体积或更快的启动速度，可保持 `app/remote`、`app/git` 等能力层不变，
只替换 GUI 实现。

---

## 3. 目录结构

```
remote-code-editor/
├── main.py                      # 打包入口（转发到 app.main）
├── app/
│   ├── main.py                  # 程序入口：QApplication / 主题 / 主窗口
│   ├── ui/                      # 所有界面组件
│   │   ├── main_window.py       # 编排层
│   │   ├── ssh_dialog.py        # 连接弹窗 + 私钥列表（读本机 ~/.ssh）
│   │   ├── workspace_dialog.py  # 远端文件夹选择器（Ctrl+O）
│   │   ├── host_manager.py      # 主机管理面板（含 ~/.ssh/config 导入）
│   │   ├── settings_dialog.py   # 设置面板
│   │   ├── theme.py             # 主题与配色（唯一颜色来源）
│   │   ├── tasks.py             # QThreadPool 异步任务运行器
│   │   ├── remote_ops.py        # GUI ↔ 远程能力的粘合层
│   │   ├── icons.py             # QPainter 现画的单色线条图标（无外部资源）
│   │   └── widgets/             # 活动栏 / 欢迎页 / 文件树 / 源代码管理 / 徽标 / 多标签 / 搜索栏 / 状态栏 / 日志
│   ├── editor/                  # 编辑器核心、高亮、Git 标记渲染
│   │   ├── editor.py            # CodeEditor（行号 + Gutter + 搜索替换）
│   │   ├── syntax.py            # Pygments 高亮与语言识别
│   │   ├── git_decorations.py   # Gutter 彩色标记绘制
│   │   └── document.py          # 文档模型（脏状态、编码、指纹）
│   ├── remote/                  # SSH / SFTP / 远程文件系统
│   │   ├── ssh_client.py        # paramiko 封装
│   │   ├── sftp_client.py       # 目录列表 / 上传下载 / 原子写
│   │   ├── remote_fs.py         # 文件系统门面 + 指纹 + 路径规范化
│   │   └── session.py           # 连接会话、家目录与仓库信息缓存
│   ├── git/                     # Git 解析、Diff 处理
│   │   ├── models.py            # ChangeType / LineMarker / FileDiff
│   │   ├── diff_parser.py       # unified diff → 行级标记（纯函数）
│   │   └── git_client.py        # 远程 git 命令执行与状态查询
│   ├── config/                  # 配置管理（设置 + 主机列表）
│   ├── cache/                   # 本地缓存（内容缓存 + 最近文件）
│   └── utils/                   # 日志脱敏 / 异常 / 路径 / 编码 / ssh_keys
├── docs/                        # 需求与设计文档
├── tests/                       # 单元测试 + 真实 SSH/SFTP 端到端测试
├── scripts/                     # 跨平台打包脚本 + 图标生成
├── requirements.txt
├── pyproject.toml
└── LICENSE
```

---

## 4. 关键实现说明

### 4.1 编辑器组件选型

选用 **`QPlainTextEdit` + 自绘行号/Gutter 区域**，而非 `QTextEdit` 或 QScintilla：

- `QPlainTextEdit` 针对纯文本优化，MB 级文件滚动/编辑性能显著优于 `QTextEdit`；
- 行号与 Git 标记共用同一 Gutter 区域，用 `QPainter` 直接绘制色条与三角标记，完全可控且无额外依赖；
- 搜索替换基于 `QRegularExpression` + `QTextDocument.find()`，支持大小写敏感与正则；
- 高亮用 `QSyntaxHighlighter`（Pygments 词法驱动），并设 1.5M 字符上限保护超大文件。

### 4.2 SSH / SFTP 设计

- `SSHClient` 持有 paramiko 的 `SSHClient`/`SFTPClient`，对上层只暴露本项目异常类型
  （`SSHAuthenticationError` / `SSHTimeoutError` / `SSHConnectionError` 等），UI 无需认识 paramiko；
- 支持密码与私钥两种认证；私钥解析兼容 paramiko 3.x 的 `PKey.from_path()` 与 2.9 的类型逐个尝试；
- 主机密钥校验默认开启（`RejectPolicy`），设置项可显式放开供内网调试；
- SFTP 上传采用**临时文件 + 原子重命名**（`.rce-upload-*` → 目标文件），避免传输中断损坏远端源码；
- 远程路径用 `posixpath` 拼接，本地路径一律 `pathlib`（满足需求 §6.3）；
- **两把锁而不是一把**：命令通道用 `_lock`，SFTP 通道用独立的 `sftp_lock`。paramiko 的
  `SFTPClient` 与 `Channel` 各自非线程安全，但两者之间没有共享状态——分开加锁后，
  一次几秒的 `git status` 不会再把「打开文件」「列目录」的 SFTP 请求堵在它后面；
  已缓存的 SFTP 会话走无锁快路径，只有首次建会话才拿锁。
- **开启 zlib 压缩**（`SSHClient.connect(compress=True)`，协商 `zlib@openssh.com`）：
  源码文本压缩率通常在 3～5 倍，链路是 RTT 瓶颈时直接把传输时间按比例削掉（延迟生效，
  不消耗额外本地 CPU 之外的成本）。
- **上传 / 下载都是流水线**：读用 `handle.prefetch()` 预取后续数据块，写用
  `set_pipelined(True)`；文件元信息在已打开的句柄上 `fstat` 取得，省掉一次 `stat` 往返。

### 4.3 工作目录：先连接、后选择

对齐 VSCode 的使用习惯，工作目录不再要求连接前填写：

- `RemoteSession.connect()` 只解析家目录（一次 `$HOME` 查询并缓存），不假设用户想打开哪个目录；
- 连接成功后主窗口弹出远端文件夹选择器（`app/ui/workspace_dialog.py`）：默认定位家目录、
  只列目录、双击进入、可返回上级、可直接输入路径，列举走 `TaskRunner` 不阻塞 GUI；
- 选中结果写入该主机的 `remote_workspace`，下次连接自动打开；`Ctrl+O` 可随时切换；
- 已记住的目录若已不存在（被删除/改名），列目录失败时会再次提示选择，并回退家目录保证界面可用；
- **`~` 与相对路径统一展开**：`normalize_remote_path()`（`app/remote/remote_fs.py`）把 `~`、`~/x`、
  相对路径按远端家目录展开为绝对路径后再交给 SFTP —— SFTP 不会像交互式 shell 那样展开 `~`，
  这是历史上 `~/ros2_ws/src/` 报 ENOENT 的根因。

### 4.4 本机 `~/.ssh` 集成

`app/utils/ssh_keys.py` 提供两个只读能力，失败一律降级为「忽略该条目」，不向 UI 抛异常：

- `list_private_keys()`：按**文件头**识别 `~/.ssh` 下的私钥（跳过 `known_hosts*`、`*.pub`、
  `authorized_keys`、子目录与超尺寸文件），解析类型、是否带口令、`.pub` 注释，并按
  `id_ed25519 → id_ecdsa → id_rsa → id_dsa → 其他` 排序；连接对话框用它填充下拉框，
  未显式配置私钥时 `RemoteSession` 也会回退到本机默认私钥；
- `parse_ssh_config()` / `load_ssh_config_hosts()`：解析 `~/.ssh/config` 的
  `Host/HostName/Port/User/IdentityFile`，支持 `Include`（限 4 层、去重），忽略通配 Host 与
  `Match` 段落；主机管理面板用它实现「从 ~/.ssh/config 导入」。

### 4.5 Git 行级差异标记规则

解析对象为 `git --no-pager -c color.ui=false diff` 输出的 unified diff（纯函数、无 IO、可单测）。
标记以**当前工作区文件行号**为基准：

| Diff 块形态 | 标记结果 |
| --- | --- |
| 纯新增（`+M`） | 该 M 行标记 `ADDED`（绿色） |
| 纯删除（`-N`） | 被删行已不存在：在其**后续行**标记 `DELETED`（红色）；删除发生在文件末尾时标在最后一行；文件被清空或新文件为空时标在第 1 行 |
| 替换（`-N +M`） | 前 `min(N, M)` 行标记 `MODIFIED`（黄/橙）；`M > N` 的多出行标 `ADDED`；`N > M` 的多出行在其后续行标 `DELETED` |
| 新文件 | 整文件 `ADDED` |
| 二进制文件 | 不产生行标记，仅置 `is_binary` 标志 |
| 无变更 | 无标记 |

同一行命中多类标记时按优先级合并：`DELETED` > `ADDED` > `MODIFIED`。
配色统一来自 `app/ui/theme.py`（`DecorationStyle`），可随主题切换，禁止硬编码。

### 4.6 Git 刷新策略与状态快照

| 时机 | 行为 |
| --- | --- |
| 打开 / 切换工作目录 | 取一次**工作目录子树的**状态快照：1 次合并的 `rev-parse --show-toplevel --abbrev-ref HEAD` + 1 次 `git status --porcelain -- <工作目录>` |
| 打开文件（已提交、未修改） | 快照直接判定「未变更」→ **0 个远端 Git 命令** |
| 打开文件（已修改 / 未跟踪） | 只跑 1 次 `git diff`（旧实现是 `status` + `diff` 两次） |
| 编辑过程中 | 只更新本地脏状态，**不请求远端** |
| 保存之后 | 按本地知识就地更新快照（`TreeStatus.mark_saved()`），**不再跑 `git status`**；快照覆盖不到该文件时才退回 800ms 防抖刷新 |
| 删除之后 | 同上（`TreeStatus.mark_removed()`）；本地判断不了（干净文件 / 被忽略的产物）时才防抖刷新 |
| 手动 | `Shift+F5` 强制刷新当前文件标记与快照，`F5` 刷新工作目录 |

仓库识别：打开远程目录时执行一次 `rev-parse`；非仓库时状态栏显示 `Git: Not a repository`，
仓库则显示 `Git: <分支> · N 处变更`。

**每次交互的远端往返预算**（`tests/test_git_client.py` 用假 SSH 服务逐条断言，防止回退）：

| 交互 | 远端 Git 命令数 |
| --- | --- |
| 打开工作目录 | 2 |
| 打开未修改的文件 | 0 |
| 打开已修改的文件 | 1 |
| 打开未跟踪的新文件 | 0（快照已折叠上报未跟踪目录） |
| 保存 / 删除（快照覆盖内） | 0 |

**两个「不要误报」的守卫**：

* `TreeStatus.complete` / `FileStatus.known`：`git status` 失败时快照标记为「不完整」，
  此时「没列出」绝不等于「未变更」，单文件 diff 仍会老老实实发起远端查询；
* `TreeStatus.status_for_diff(path, mtime=)`：文件修改时间晚于快照生成时间时同样不信任
  「未变更」结论。

**状态快照（`app.git.git_client.TreeStatus`）** 把 `git status --porcelain` 的结果一次性
整理成「绝对路径 → 变更类型」的映射，同时服务于三件事，从而避免「每打开一个文件都重跑
`git status`」：

1. **文件树着色**（§4.11）：`ChangeType` → 主题里的 `marker_added` / `marker_modified` /
   `marker_deleted`，目录按子树内最高优先级变更着色（`DELETED > ADDED > MODIFIED`）；
   未变更不着色，与 VSCode 资源管理器一致。
2. **单文件 diff 复用**：`TreeStatus.status_for_diff()` 能直接给出该文件的状态；
   `git status` 未列出的路径即「未变更」——此时工作区、索引与 HEAD 三者一致，
   `git diff HEAD` 必为空，于是连远端进程都不必启动。
3. **状态栏统计**：`TreeStatus.label` 给出分支与变更总数。
4. **本地更新**：`mark_saved()` / `mark_removed()` / `mark_clean()` 在保存 / 删除 / 撤销回原样后
   直接改快照（`_recompute_dirs()` 重算目录颜色，纯本地、无 IO），避免「写一个文件扫一次全仓库」。
   其中「撤销回原样」由 `Document.reverted` 判定（打开时干净 + 文本回到打开时的内容），
   修正了「撤销修改后文件树仍然是黄色」的 bug —— 只看保存动作而不看内容，是判断不出这一点的。

快照记录生成时间（`fetched_at`）；打开文件时若文件 mtime 晚于该时间戳，说明快照之后远端
文件被改过，「未变更」结论不再可信，此时退回实时 `git status` 查询。这样既保住了
「打开未修改文件零远端 Git 开销」的收益，又不会因为快照过期而漏掉行级标记。

### 4.7 异步与不卡顿

`TaskRunner` 基于 `QThreadPool` + `QRunnable`，每个任务携带成功/失败回调，
回调通过信号切回 GUI 线程后才执行。因此 SSH 连接、目录列举、SFTP 上传下载、远程 Git 命令、
文件解析全部异步，主线程只做渲染；`tests/test_main_window.py` 有专门用例断言网络请求期间 UI 仍可响应。

### 4.8 文件冲突处理

打开文件时记录 `FileFingerprint`（mtime + size）。保存前重新取一次指纹，
若远端文件被外部改动则弹窗，且只提供三个选项：

1. **重新加载远程文件**（丢弃本地改动）
2. **覆盖远程文件**（以本地为准，需用户显式确认）
3. **取消保存**

绝不静默覆盖远端文件。

**自动保存**默认开启（停止输入 1500ms 后自动上传，可在设置里关闭并调整延迟）。自动保存
**不弹任何模态框**：遇到只读文件或「远端已变化」时跳过本次上传，只在状态栏提示
`远端已变化，未自动保存（Ctrl+S 处理）`，把冲突决策权留给用户显式按下 `Ctrl+S`。
老配置（没有 `settings_version` 或版本 < 2）在加载时迁移为「开启自动保存」，
用户显式关掉的配置不会被重新打开（见 `tests/test_config.py`）。

### 4.9 编码兼容

默认支持 UTF-8、UTF-8 BOM、ASCII（自动识别）。检测失败抛 `UnknownEncodingError`，
弹窗让用户从 `SELECTABLE_ENCODINGS` 中手动选择；保存时沿用打开时的编码，BOM 按原样保留。

### 4.10 日志与安全

- 日志写入跨平台数据目录 `logs/`（Windows `%LOCALAPPDATA%`，Linux `$XDG_CACHE_HOME`），带轮转；
- 所有密码、私钥口令在进入日志前经 `SecretRedactor` 替换为 `***`；
- 主机配置持久化时**剔除密码字段**，连接时临时输入；私钥仅存路径、不存内容。

### 4.11 远程文件树：仿 VSCode 的单列布局与状态着色

早期版本用「名称 + 大小 + 修改时间」三列，窄面板下会出现最尴尬的结果：名称被截断成
`command_handl…`，而不重要的元信息却完整占满整行。现在**直接对齐 VSCode 的资源管理器**：

| 元素 | 规则 |
| --- | --- |
| 列 | 只有一列文件名（`setColumnCount(1)` + 隐藏表头），名称永远占满整个面板宽度 |
| 行高 | 固定 22px（`ROW_HEIGHT`），`setUniformRowHeights(True)`，大目录下列表布局不做逐行测量 |
| 排序 | 目录在前，其余按名称（不区分大小写）排序 —— SFTP 的 `readdir` 原始顺序不泄漏到界面 |
| 徽标 | 行右端绘制变更字母 `U`/`A`/`M`/`D`/`R`/`!`（目录不加，与 VSCode 的徽标规则一致） |
| 次要信息 | 大小 / 修改时间 / 权限 / 完整路径放 Tooltip，不再挤占名称 |
| 顶栏 | 当前文件夹名 + 四个纯图标按钮（新建文件 / 新建文件夹 / 刷新 / 全部折叠），含义放 Tooltip；文字会挤掉文件夹名 |

状态着色规则：未变更不着色（保持调色板默认前景色），新增 / 修改 / 删除分别取
`theme.marker_added` / `marker_modified` / `marker_deleted`；目录与仓库根取其子树内的
最高优先级变更。颜色只在 `app/ui/theme.py` 定义，主题切换后由
`RemoteFileTree.apply_theme()` 重新着色。目录是懒加载的，因此展开时新列出的子节点会直接
套用当前快照（`set_status_snapshot` 保存快照，`_make_item` 逐项应用）。

字体与边框同样收敛到主题里：22px 以内的紧凑行、无边框、悬停 `#2a2d2e`、选中 `#094771`，
与应用整体的 VSCode Dark+ 风格一致（`theme.apply_theme()` 的统一 QSS）。

变更徽标由 `app/ui/widgets/badge.py::BadgeDelegate` 在行右端绘制：一个填色的圆角方块加
粗体字母，位置固定在行的右端，因此文件名再长也挤不掉它，滚动时所有徽标排成一条竖线；
字母颜色按背景亮度自动取黑 / 白（黄底上用深色字，绿底 / 红底上用白字）。文字与图标由
Delegate 自己排版，超长名称在其中间省略（`ElideMiddle`），不会钻到徽标下面。

### 4.12 高延迟链路下的目录浏览：去重、缓存与预取

实测（板卡经 WiFi 接入）单次远端往返约 1 秒，而一次 SFTP 列目录需要 `open` + `readdir`
两次 + `close` ≈ 3~4 个往返，也就是**展开一个目录要等 3~4 秒**。语言或客户端换实现都改不了
往返次数，所以这里只做「少发请求」和「重叠等待」：

| 手段 | 说明 |
| --- | --- |
| 请求去重 | `_pending_listings` 记录在途路径：`set_root()` 的展开信号与打开工作目录会各请求一次，去重后只发一次（用户日志里省掉 2.9 秒） |
| 根节点不重复触发 | `set_root()` 直接把根标成「已请求」，`setExpanded(True)` 不再产生第二次列举 |
| 目录缓存 | `_dir_cache[path] = (时间, 条目)`，TTL 120 秒；命中即上屏，不再等远端。新建 / 删除 / 重命名、切换工作目录、`F5` 都会失效对应条目 |
| 后台预取 | 列出某目录后，顺带（最多 3 个、且当前无用户请求排队时）预取它的子目录进缓存，让「点开子目录」变成秒开 |
| 缓存上限 | 最多 200 条，超出按写入时间淘汰，长时间浏览不会无限增长内存 |

这些优化对本地回环连接是「无感加速」，对高延迟链路是数量级的体感差别；正确性上，所有
本地改动都会显式失效缓存，`F5` 永远走远端真实列举。

### 4.13 界面外壳：仿 VSCode 的活动栏 / 欢迎页 / 源代码管理

窗口骨架按 VSCode 的四段式排布，组件各自独立、只通过信号交互，便于后续接入插件机制（§7）：

| 区域 | 组件 | 行为 |
| --- | --- | --- |
| 最左侧活动栏 | `app/ui/widgets/activity_bar.py` | 一列 44px 宽的图标：资源管理器 / 查找 / 源代码管理 / 连接主机 / 打开文件夹 / 设置（贴底）。`files`、`source-control` 是互斥的视图按钮（`checkable`），再点一次收起侧边栏；`_show_side_view()` 统一切换 |
| 侧边栏 | `QStackedWidget` 包住 `RemoteFileTree` 与 `SourceControlView` | 视图名到下标只在一处登记（`_side_views`），加视图不必改布局代码；`视图 → 显示文件树` 菜单项复用同一条路径 |
| 编辑区 | `QStackedWidget` 包住 `EditorTabs` 与 `WelcomeView` | 没有打开的标签页就显示欢迎页，并隐藏查找栏（对齐 VSCode 的空标签页） |
| 图标 | `app/ui/icons.py` | 用 `QPainter` 现画 16px 单色线条图标（host / folder / files / source-control / search / save / refresh / collapse / new-file / new-folder / settings / history / close），不引入图标字体与 SVG 资源：打包不需额外 Qt 模块、没有第三方图标集的许可问题、颜色跟随主题即时重建（未激活灰、激活亮，且同时提供 2 倍图供高 DPI）。顶部工具栏设为 `ToolButtonIconOnly`（文字仍在 QAction 上，供菜单与读屏使用）；标签页关闭按钮也换成自绘的灰叉 —— Qt 默认图形在深色主题下是个红块，和整体风格不搭 |

**「打开远程文件夹」只在该出现的时候出现**：`WelcomeView.set_connected()` 在未连接时隐藏
「连接主机…」之外的入口并禁用「打开远程文件夹…」，活动栏的同名按钮同步禁用；连接成功后
才解锁。这与 VSCode 的「先连接、再打开文件夹」一致，也避免了用户在空窗口里找一个还不存在
的目录。

**源代码管理面板不额外要数据**：`app/ui/widgets/scm_view.py` 渲染的是文件树已经在用的那一份
`TreeStatus` 快照（`TreeStatus.changes()` 给出 `(绝对路径, 变更类型, 字母)`），因此**打开面板
零远端请求**；文件按相对仓库根的路径列出（和 VSCode 的 SCM 列表一致），行右端同样用
`BadgeDelegate` 画徽标；快照在快照刷新、保存、删除、断开连接时同步更新，需要最新状态时点
面板右上角的刷新（等价 `Shift+F5`）。

> 关于「登录 Git 账号显示与仓库的差异」：本项目的远端只经 SSH 可达，编辑器对比的基准就是
> 远端工作区自身的 `HEAD` / 索引（`git status` + `git diff HEAD`），也就是 VSCode 的 SCM 视图
> 在有本地仓库时展示的内容，因此**不需要也不应该**引入账号体系 —— 那要求远端仓库有 https
> 远端地址 + 凭据存储，与「密码不落盘、远端零常驻服务」的约束直接冲突。需要与上游分支
> 对比时，用「刷新 Git 标记（`Shift+F5`）」拉到最新状态即可。

---

## 5. 测试策略与覆盖

```bash
python3 -m pytest tests/ -q                      # 全量
python3 -m pytest tests/test_diff_parser.py -q   # 仅 Git Diff 规则
```

`tests/test_editor_widget.py` 与 `test_main_window.py` 使用 Qt offscreen 平台，无需显示器。
`tests/test_ssh_end_to_end.py` 会在进程内启动真实 paramiko SSH/SFTP 服务与真实 git 仓库，
跑完整链路（连接 → 列目录 → 打开 → 编辑 → 保存 → 远端文件更新 → 标记刷新）；
若环境不允许监听本地端口，则自动跳过。

覆盖范围：

- **Git Diff 12 类核心场景**（需求 §9）：纯新增、纯修改、纯删除、新增+修改、修改+删除、
  全混合变更、文件头变更、文件尾变更、连续多行变更、空文件、新文件、无变更文件；
  另加二进制文件、多文件 diff、`\ No newline at end of file` 等边界。
- SSH/SFTP：连接参数、认证失败、目录列举、上传下载、原子写、异常映射。
- 编辑器：行号、标记像素颜色、搜索/替换（含正则）、自动缩进、脏状态。
- 主窗口：打开/保存/冲突三选项、Git 刷新、主题切换、网络期间 UI 不冻结。
- 界面外壳（`test_activity_bar.py` / `test_welcome.py` / `test_scm_view.py` / `test_icons.py` /
  `test_file_tree.py`）：活动栏信号与互斥选中、图标全部能画出非空像素（含 2 倍图）、
  欢迎页按连接状态切换入口、SCM 面板列出相对仓库根的路径与徽标颜色、空态、切面板不发远端请求。
- 配置与编码：主机配置不落密码、设置读写原子性、BOM 与未知编码处理。
- 工作目录与 `~/.ssh`：远端路径 `~`/相对路径展开、连接后选目录（含目录失效后重新选择、
  选择结果写回主机配置）、`~/.ssh` 私钥识别与 `~/.ssh/config` 导入。

---

## 6. 已知限制

- V1.0 不支持 LSP、调试、终端、插件（见 [requirements.md](requirements.md) §1.4 功能边界）。
- 密码不落盘：每次连接需临时输入；后续版本可对接系统钥匙串。
- 单文件默认上限 32MB（设置项可调），超大文件保证可打开，不保证高亮。
- `~/.ssh/config` 导入只识别 `Host/HostName/Port/User/IdentityFile`，`ProxyJump`、`ProxyCommand`
  与 `Match` 段落不生效（导入后仍是直连；含通配符的 Host 段落会被忽略）。
- 私钥认证不会调用 `ssh-agent`，连接时也不会自动套用 `~/.ssh/config` 里的 `IdentityFile`
  （可用导入功能把该配置带入主机列表）；私钥口令需在连接时输入，仅存内存。
- 工作目录选择器只列出目录（不显示文件），也不支持在远端新建文件夹。

---

## 7. 后续规划（尚未实现）

**插件机制**：当前版本把 SSH/SFTP 能力做成框架（会话、任务、文件树、编辑器、主题各自解耦，
彼此只通过信号与 `remote_ops` 编排层交互），后续计划在此基础上引入插件机制：新功能
（如串口终端、ROS 工具链、远程运行/调试）以插件形式加载，而不是继续往主窗口堆代码。
V1.0 不实现该机制，此处仅记录方向，避免后续架构改动偏离。
