# RemoteCodeEditor V2 · 完整实现规格书（总纲）

> **本文档是规格书，不是建议书。** 交给实现者逐条照做。
>
> ## 分册索引（**5 份都要读，缺一份就是漏规格**）
>
> | 文件 | 内容 | 什么时候读 |
> | --- | --- | --- |
> | **本文件**（`docs/spec-v2.md`） | 全局约定、架构决策、目录结构、依赖清单、模块接口签名、性能预算、安全、里程碑 | 开工前通读一遍，之后当索引 |
> | `docs/spec-v2-algorithms.md` | **10 个纯函数算法**的伪代码 + 输入输出样例（路径规范化、porcelain 解析、目录继承色、路径换算、diff 解析、提交图泳道、manifest、compile_commands 重写…） | 实现 `src/shared/` 与 mirror 时逐字照做，样例原样进测试 |
> | `docs/spec-v2-ui.md` | **每个视图的状态、全部中文文案、尺寸、交互、对话框表、菜单表** | 实现 `src/renderer/` 时逐字照做（文案不得改写） |
> | `docs/spec-v2-data.md` | 配置文件 JSON schema、**IPC 通道逐条定义**、6 条关键时序图 | 实现 IPC 与持久化时逐字照做 |
> | `docs/spec-v2-tests.md` | **逐条测试用例**（Given/When/Then）+ 手动验收清单 | 每写完一个模块就补齐对应用例，缺测试 = 未完成 |
> | `docs/spec-v2-git-repo.md` | **Git 仓库管理**（暂存区逐文件操作、远程地址/stash/标签/分支管理、克隆/初始化）—— 部分覆盖 U4 | 实现 SCM 与 Git 仓库级操作时逐字照做 |
> 实现者遇到本文档没写到的问题时，按 §0 的规则处理，**不要自作主张改架构、加依赖、换方案**。
> 本文档里的「必须 / 禁止 / 不要做」是硬性要求，违反即返工。

---

## 0. 给实现者的硬性约定（先读这一节）

1. **本文档优先级最高**。与任何外部资料、个人习惯冲突时，以本文档为准。
2. **禁止事项**（违反任意一条即返工）：
   - 禁止引入本文档 §4 允许清单之外的任何依赖（包括「顺便装一个工具库」）。
   - 禁止在渲染进程（浏览器上下文）里直接访问 Node.js / 文件系统 / 网络。
   - 禁止把密码、私钥口令写入磁盘、日志、配置文件（只允许存在于内存变量里）。
   - 禁止在板子（远端）上安装/部署/启动任何常驻进程或服务。板子只允许被动响应 SSH 命令与 SFTP 读写。
   - 禁止逐文件 SFTP 拉取大批量文件（见 §5.3，必须用 tar 单流）。
   - 禁止自己手写编辑器组件（补全弹窗、语法高亮、诊断绘制）——一律用 Monaco。
   - 禁止把二进制产物提交进 git 仓库（安装包走 Release）。
3. **遇到规格没覆盖的问题**：选「改动最小、不动架构」的做法实现，并在代码注释里写 `// 规格未覆盖：` 说明判断依据；在文档末尾的「遗留问题」追加一条。**不要停下来问**。
4. **代码注释、UI 文案、提交信息一律中文**。
5. **每个里程碑完成的定义** = 对应验收清单全过 + 测试全绿 + `npm run lint` 无告警。不满足不算完成。

---

## 1. 背景、目标与非目标

### 1.1 背景

用户在**低性能嵌入式 ARM 板卡**（RK3566 / RK3588 / 香橙派等，典型 2~4GB 内存，四核 A55）上开发 ROS / C++ / Python 代码。工作机是 Windows / Linux / macOS 三平台都有的开发电脑，通过 SSH 连板子。

板子的硬约束（**这是整个架构的出发点，不可动摇**）：

- 板子上**不能装任何东西**、**不能跑任何服务**：0 内存占用、0 CPU 占用、0 常驻进程。板子上只允许本来就在跑的 `sshd`。
- 板子与工作机之间的链路可能是 **WiFi、单次往返 1 秒**的高延迟链路。
- 工作机要求**跨平台桌面程序**（Windows / Linux；macOS 保留能力、暂缓出包，见 §1.4），**不用浏览器**（Electron 打包的桌面程序是允许的，它有自己的窗口与任务栏图标）。
- 用户长期使用 VSCode，要求编辑器体验（补全、诊断、高亮、多光标、小地图）接近 VSCode。
- 用户明确要求：**不用现成的编辑器产品**（VSCode、Zed、code-server 之类都不用），要在开源组件之上**自研外壳、按需定制**。

### 1.2 核心架构决策（已定案，实现者不得更改）

| 决策 | 内容 | 理由 |
| --- | --- | --- |
| D1 | **Electron + TypeScript** | 自带 Chromium，Monaco 与中文输入法在三平台表现一致（跨平台硬需求） |
| D2 | **编辑器 = Monaco**（VSCode 的编辑器组件，MIT） | 补全/诊断/高亮/多光标/小地图直接获得 VSCode 水准，禁止手写 |
| D3 | **外壳自研**（活动栏/文件树/SCM/搜索/终端/标签页/状态栏） | 按用户习惯定制 |
| D4 | **语言服务器（LSP）跑在工作机上，对着本地「环境镜像」**（源码 + **头文件/sysroot** + Python site-packages + compile_commands） | 板子 0 占用 0 安装；补全延迟 = 本地毫秒级；**环境必须完整**，否则 ROS 头解析失败、补全静默失效（D4 的成立前提，见 §5.3） |
| D5 | **环境镜像**：首次连接 tar 压缩单流拉「源码 + 头文件 + site-packages」，保存时增量上传 | 高延迟链路下唯一可行的批量同步；**只同步源码是错的**（补全会在 ROS/系统头处失效） |
| D6 | **Git / 搜索 / 终端** 走 SSH（板子上执行 `git`/`grep`，SSH shell 通道） | 板子零部署 |
| D7 | 远端层（SSH/SFTP/Git/镜像/LSP）在 **Electron 主进程**，渲染进程只发 IPC | 安全隔离 + 不阻塞 UI |

**为什么是重写而不是改造旧代码**（2026-09 用户拍板，记录备查）：旧 PySide6 界面用户不满意、
不打算保留；曾评估过「PySide6 + QWebEngine 嵌 Monaco」的渐进路线，被否 —— QtWebEngine 的
中文输入法与渲染质量不如 Chromium 原生，且 Python 壳 + JS 编辑器双语言维护割裂。旧代码库的
价值只剩行为规格（porcelain 解析、往返预算、认证顺序等），已全部抄入本文档与各分册。

### 1.3 目标（可验收）

1. 连接 SSH 主机 → 打开远程工作目录 → 编辑 → 保存，全程可用。
2. C++ / Python 文件的**代码补全、跳转定义、悬浮提示、错误诊断**（LSP，本地计算）。
3. VSCode 式外壳：活动栏、侧边栏（文件树 / 搜索 / SCM / 主机）、标签页编辑区、底部终端面板、状态栏。
4. Git：状态着色、行级差异、提交（含 amend）、推送、同步、分支列表与切换、提交图。
   **Git 仓库管理**（分册 5）：暂存区逐文件操作、远程地址管理、stash、标签、分支新建/删除/合并、克隆/初始化。
5. 安装包：Windows `.exe`（安装版 + 便携版）、Linux `.AppImage` + `.deb`。目标机**零依赖**。
   （macOS 暂缓出包，见 §1.4；electron-builder 配置保留，CI 不出 macOS 产物。）
6. 板子侧：**只读写文件与执行命令，0 进程常驻、0 内存占用**。

### 1.4 非目标（明确不做，实现者不要做）

- 不做网页版 / 远程服务端（board 上不部署任何东西）。
- 不做插件系统。
- 不做多人协作 / 实时协同。
- 不做调试器（DAP）。
- 不做 LSP 之外的 AI 补全。
- 不复用旧 Python 代码库的运行时代码（旧代码只作行为规格参考，见 §5 各节的「行为参照」）。
- **macOS 暂不维护**（用户当前无需求）：`electron-builder.yml` 里保留 `dmg` 配置但 CI 不出包；
  自绘标题栏不必做 macOS 红绿灯适配，后续要做时补。
- v1 有、v2 **暂不移植**的功能（需要时单独立项再加，实现者不要顺手做）：
  Markdown 预览、gutter 点击查看与上一版差异的浮层、文件图标主题与用户可替换资源目录
  （v2 只保留深浅两套 tokens + Codicons）。

---

## 2. 总体架构

### 2.1 进程模型

```
┌────────────────────────── Electron 主进程（Node.js） ──────────────────────────┐
│                                                                              │
│  SessionManager ── ssh2 ──────────────────────────────► 板子 sshd（只被动响应）│
│      │  ├─ RemoteFs（SFTP：列目录 / 读 / 原子写 / 删除 / 重命名 / 指纹）      │
│      │  ├─ GitRemote（ssh exec：git status/diff/commit/push/branch/log）      │
│      │  ├─ SearchRemote（ssh exec：一条 grep）                               │
│      │  └─ TerminalChannel（ssh exec shell + pty）                           │
│      │                                                                       │
│  MirrorManager ── tar 单流（ssh exec）──► 本地源码镜像目录                    │
│      │                                                                       │
│  LspManager ── 本地 spawn ──► clangd / pylsp（工作机进程，指向镜像目录）      │
│                                                                              │
│  IPC 桥（invoke / send，见 §5.8 完整 API 表）                                 │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ contextBridge（preload）
┌──────────────────────────────────▼───────────────────────────────────────────┐
│                        渲染进程（Chromium，无 Node 权限）                      │
│  外壳（自研 TS）：活动栏 / 侧边栏 / 标签页 / 底部面板 / 状态栏 / 主题          │
│  编辑器：Monaco（多标签，每标签一个 model）                                    │
│  终端：xterm.js（渲染层，数据来自 TerminalChannel）                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键数据流

**连接**
1. 渲染进程点「连接」→ IPC `host.connect(hostConfig, secret?)`。
2. 主进程 `SessionManager.connect()`：`ssh2.Client.connect()`；
   - 认证顺序（**必须按此顺序**）：主机显式配置了私钥 → 只用该私钥；否则若本机 `~/.ssh` 存在**默认名**私钥（`id_ed25519` / `id_ecdsa` / `id_rsa` / `id_dsa`）→ 先试这些（`tryKeyboard=false, agent:false`），全部被拒 → 通过 IPC 请求用户输入密码后重连；本机没有默认名私钥 → 直接请求密码。
   - **禁止**调用 ssh-agent（`agent` 字段恒为 `false`）。
3. 连接成功 → `MirrorManager.sync()`（tar 单流拉源码，见 §5.3）→ 返回镜像就绪事件。

**打开文件**
1. 渲染进程点文件树节点 → IPC `fs.readFile(path)`（SFTP 读板子上的**当前内容**）。
2. 内容写入镜像对应位置（保持镜像与板子一致）。
3. Monaco 打开该文件 → LspManager 感知新文件 → 本地 clangd/pylsp 按需解析。

**编辑与补全**
1. Monaco 内输入 → LSP 客户端（主进程内）把请求转发给本地 clangd/pylsp。
2. **补全请求 0 次远端往返**（全部在本地镜像上算）。
3. 补全结果回渲染进程 → Monaco 原生补全弹窗展示。

**保存**
1. `Ctrl+S` → Monaco 内容 → IPC `fs.saveFile(path, content)`。
2. 主进程：写镜像本地文件（原子写）→ SFTP 原子写板子（临时文件 + rename，见 §5.2）。
3. 成功后更新指纹 → 通知渲染进程更新标签状态与 Git 标记。

**Git 状态**
1. 主进程 `GitRemote.status()` 一条 `git status --porcelain -uall` → 快照对象。
2. 文件树着色、SCM 列表、状态栏、行级差异**共用这一份快照**（禁止各处各查一次）。

---

## 3. 目录结构（必须照此组织）

```
<仓库根>（V2 即根目录，无套壳）
├── package.json
├── package-lock.json
├── tsconfig.json                 # 根配置（references 分层）
├── .eslintrc.cjs
├── electron-builder.yml
├── .github/workflows/release.yml
├── README.md
├── docs/
│   ├── spec-v2.md                # 本文档
│   └── shortcuts.md              # 快捷键表（对外文档）
├── resources/
│   ├── icon.png / icon.ico / icon.icns
│   └── codicons/                 # 图标 SVG（MIT，VSCode Codicons）
├── src/
│   ├── shared/                   # 主进程与渲染进程共用的纯类型与纯函数（无副作用）
│   │   ├── types.ts              # 全部跨进程数据结构（见 §5.8）
│   │   ├── paths.ts              # 远端路径规范化纯函数
│   │   ├── git-status.ts         # porcelain 解析、TreeStatus 快照算法（纯函数）
│   │   ├── diff-parser.ts        # git diff 解析为行级标记（纯函数）
│   │   ├── graph.ts              # 提交图泳道布局（纯函数）
│   │   └── errors.ts             # 错误码与用户文案映射
│   ├── main/                     # Electron 主进程
│   │   ├── index.ts              # 入口：窗口创建、生命周期
│   │   ├── ipc.ts                # 所有 ipcMain.handle / on 注册（唯一注册点）
│   │   ├── session/
│   │   │   ├── connection.ts     # SSH 连接管理（认证顺序见 §5.1）
│   │   │   ├── remote-fs.ts      # SFTP 封装
│   │   │   ├── git.ts            # 远端 git 命令
│   │   │   ├── search.ts         # 远端 grep
│   │   │   └── terminal.ts       # SSH shell 通道
│   │   ├── mirror/
│   │   │   ├── manager.ts        # 镜像同步（tar 单流）
│   │   │   └── manifest.ts       # 文件清单与指纹比对
│   │   ├── lsp/
│   │   │   ├── manager.ts        # 语言服务器生命周期（spawn / 停止）
│   │   │   ├── client.ts         # JSON-RPC over stdio 客户端
│   │   │   └── clangd-config.ts  # compile_commands.json 收集与重写
│   │   ├── window.ts             # BrowserWindow 创建与安全配置
│   │   └── log.ts                # 日志（脱敏，落 userData/logs）
│   ├── preload/
│   │   └── index.ts              # contextBridge.exposeInMainWorld('api', ...)
│   └── renderer/
│       ├── index.html
│       ├── styles/
│       │   ├── tokens.css        # 颜色 / 间距 / 字号变量（唯一颜色来源）
│       │   ├── shell.css         # 外壳布局
│       │   └── components.css    # 控件样式
│       ├── app/
│       │   ├── main.ts           # 渲染进程入口
│       │   ├── store.ts          # 极简状态管理（订阅式，不引库）
│       │   └── shortcuts.ts      # 快捷键表（见 §6.5）
│       ├── views/
│       │   ├── activity-bar.ts   # 活动栏
│       │   ├── explorer.ts       # 文件树（懒加载）
│       │   ├── search-view.ts    # 全局搜索
│       │   ├── scm-view.ts       # 源代码管理（含提交图）
│       │   ├── hosts-view.ts     # 远程主机管理
│       │   ├── editor-area.ts    # 标签页 + Monaco 容器
│       │   ├── terminal-panel.ts # 底部终端（xterm.js）
│       │   ├── status-bar.ts
│       │   └── dialogs/          # 无边框对话框（连接表单 / 设置 / 提示框）
│       └── editor/
│           ├── monaco-setup.ts   # Monaco 加载与主题注册
│           └── lsp-bridge.ts     # Monaco 语言功能 ⇄ LSP 协议适配
└── tests/
    ├── unit/                     # shared 纯函数 + main 各模块（mock ssh2）
    ├── integration/              # 假 SSH 服务端端到端（见 §10）
    └── ui/                       # 渲染层逻辑（vitest + happy-dom）
```

---

## 4. 技术栈与依赖（允许清单，超出即违规）

| 类别 | 依赖 | 版本要求 | 用途 |
| --- | --- | --- | --- |
| 运行时 | `electron` | ^33 | 桌面壳 |
| 运行时 | `monaco-editor` | ^0.52 | 编辑器（VSCode 的编辑器组件） |
| 运行时 | `xterm` + `xterm-addon-fit` | ^5 | 终端渲染（MIT） |
| 运行时 | `ssh2` | ^1.16 | SSH / SFTP / shell 通道 |
| 构建 | `typescript` | ^5.6 | 编译 |
| 构建 | `electron-builder` | ^25 | 三平台打包 |
| 测试 | `vitest` | ^2 | 单元 / 集成测试 |
| 测试 | `@vitest/coverage-v8` | ^2 | 覆盖率（可选但推荐） |
| Lint | `eslint` + `@typescript-eslint/*` | 对应 TS5 | 代码规范 |

> 类型与测试辅助（构建期，不进安装包，2026-09 补充进允许清单）：
> `@types/node`、`@types/ssh2`（ssh2 官方不带类型）、`happy-dom`（tests/ui 的 DOM 环境，§3 已提及）。

**禁止**：任何 UI 组件库、任何状态管理库（自己写 §5.9.3 的 store）、任何 SSH 之外的网络库、任何打包器（webpack/vite 一律不用 —— 用 `tsc` 直接编译，Monaco 走它的 AMD loader，见 §12 坑清单）。

**目标机零依赖**：以上全部打进安装包（Electron 自带 Chromium + Node 运行时）。

---

## 5. 模块规格（逐个模块：职责、接口、行为、边界）

> 本节的 TypeScript 签名是**契约**：实现者必须原样实现，不得改名、不得改参数顺序。
> 所有异步函数失败时**必须**抛 `AppError`（`src/shared/errors.ts`），不得抛裸 Error。

### 5.0 共用类型（`src/shared/types.ts`，主/渲染进程都 import 这个文件）

```ts
// 一切跨进程传输的结构都在这里定义；禁止在别处定义重复类型

export interface HostConfig {
  id: string;                    // uuid
  name: string;                  // 显示名，如 "Robot-3566"
  host: string;                  // IP 或域名
  port: number;                  // 默认 22
  username: string;              // 默认 "root"
  authMethod: "password" | "key";
  privateKeyPath?: string;       // authMethod=key 时必填
  workspace?: string;            // 远端工作目录，可空
  lastUsedAt?: number;
}

export interface SecretInput {    // 只存在于内存，绝不落盘、绝不进日志
  password?: string;
  passphrase?: string;
}

export interface RemoteEntry {
  name: string;
  path: string;                  // 远端绝对路径
  isDir: boolean;
  isSymlink: boolean;
  size: number;                  // 目录为 0
  mtime: number;                 // epoch 秒
  mode: number;
}

export interface Fingerprint { path: string; size: number; mtime: number }

export interface GitFileStatus {
  path: string;                  // 仓库内相对路径
  indexStatus: string;           // porcelain 第 1 列
  worktreeStatus: string;        // porcelain 第 2 列
  letter: "U" | "A" | "M" | "D" | "R" | "!" | "";
  change: "added" | "modified" | "deleted" | null;
}

export interface GitTreeStatus {
  root: string;                  // 仓库根（远端绝对路径）
  branch: string;
  scope: string;                 // 扫描范围（= 工作目录）
  files: Record<string, GitFileStatus>;   // key = 远端绝对路径
  dirs: Record<string, "added" | "modified" | "deleted">; // 目录继承色（key=远端绝对路径）
  untrackedDirs: string[];
  fetchedAt: number;
  complete: boolean;
  label: string;                 // "Git: main · 34 处变更"
}

export interface GitDiff {
  addedLines: number[]; modifiedLines: number[]; deletedLines: number[];
  hunks: Array<{ startLine: number; removed: string[]; added: string[] }>;
  isDeletedFile: boolean;
}

export interface BranchInfo { name: string; current: boolean; remote: boolean; upstream: string; detached: boolean }

export interface CommitInfo { hash: string; parents: string[]; author: string; date: string; subject: string; refs: string[] }

export interface GraphRow { commit: CommitInfo; lane: number; topLanes: number[]; bottomLanes: number[]; parentLanes: number[]; laneCount: number }

export interface SearchMatch { path: string; line: number; text: string }

export interface MirrorEntry { path: string; size: number; mtime: number }
export interface MirrorResult { root: string; fileCount: number; totalBytes: number; changed: string[]; removed: string[] }

export type AppErrorCode =
  | "auth" | "auth-passphrase-required" | "timeout" | "network"
  | "host-key" | "ssh" | "sftp" | "git" | "mirror" | "lsp" | "invalid-input" | "unknown";
export interface AppErrorShape { code: AppErrorCode; message: string; detail?: string }
```

### 5.1 `src/main/session/connection.ts` — SSH 连接管理

**职责**：一条可复用的 SSH 连接（含按需 SFTP 子系统、shell 通道、exec 通道）。

```ts
export interface ConnectionOptions {
  host: string; port: number; username: string;
  password?: string; privateKeyPath?: string; passphrase?: string;
  timeoutMs: number;             // 默认 15000
  keepaliveMs: number;           // 默认 30000，0 = 关闭
  strictHostKey: boolean;        // 默认 false（首次自动接受并记 known_hosts）
  knownHostsPath?: string;       // 默认 userData/known_hosts
}

export class SSHConnection {
  constructor(options: ConnectionOptions)
  connect(): Promise<void>       // 失败抛 AppError(code: auth|timeout|network|host-key)
  get connected(): boolean
  sftp(): Promise<SFTPWrapper>   // 懒创建，复用同一实例
  exec(command: string, opts?: { timeoutMs?: number; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>
  shell(opts: { term: string; cols: number; rows: number }): Promise<ShellChannel>
  close(): Promise<void>
  reconnect(): Promise<void>     // close + connect，供 ensureConnected 内部用
  ensureConnected(): Promise<void>  // 断线自动重连一次
}

export interface ShellChannel {
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  onData(cb: (chunk: Buffer) => void): void
  onClose(cb: () => void): void
  close(): void
}
```

**必须遵守的行为**：

1. **认证顺序**（错误的顺序会导致「必须输密码」的回归，这条有过事故）：
   ```
   if (options.privateKeyPath)          → 只用该私钥（等价 OpenSSH IdentitiesOnly）
   else if (本机 ~/.ssh 存在默认名私钥)  → 先试默认名私钥，全部被拒 → 抛 code:"auth"
   else                                 → 抛 code:"auth"（让上层直接要密码）
   ```
   - 默认名私钥 = 文件名 ∈ {`id_ed25519`,`id_ecdsa`,`id_rsa`,`id_dsa`}；**自定义名私钥（如 `id_ed25519_github`）不参与自动尝试**。
   - `agent` 恒 `false`（不调用 ssh-agent）。
2. **认证类失败必须归类为 `code:"auth"`**，包括 ssh2 抛的 `All configured authentication methods failed` 与 `No supported authentication methods available`；上层据此弹密码输入行，**禁止**弹「连接失败」错误框（留死胡同是严重 bug）。
3. 私钥口令（passphrase）缺失时抛 `code:"auth-passphrase-required"`。
4. `exec()` 必须支持 `cwd`（实现方式：`cd <quoted> && <command>`）。
5. SFTP 实例**非线程安全**：所有 SFTP 操作经内部队列串行化（`async-mutex` 风格自实现，不引库）。
6. 所有发往远端的字符串参数**必须**经 `shellQuote()` 处理（`src/shared/paths.ts` 提供），禁止裸拼接。

### 5.2 `src/main/session/remote-fs.ts` — 远端文件系统

```ts
export class RemoteFs {
  constructor(conn: SSHConnection)
  listDir(path: string): Promise<RemoteEntry[]>        // 目录在前、按名排序（不区分大小写）
  stat(path: string): Promise<RemoteEntry>
  readFile(path: string, maxBytes?: number): Promise<{ text: string; encoding: "utf8"|"utf8-bom"|"binary"; newline: "lf"|"crlf"; fingerprint: Fingerprint }>
  saveFile(path: string, text: string, opts?: { encoding?: string; newline?: "lf"|"crlf" }): Promise<Fingerprint>
  createFile(path: string): Promise<void>
  createDir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>                  // 文件或目录（递归）
  fingerprint(path: string): Promise<Fingerprint | null>  // null = 文件不存在
  exists(path: string): Promise<boolean>
}
```

**必须遵守的行为**：

1. **原子写**：`saveFile` = 写 `<path>.rce-tmp-<随机>` → `rename` 覆盖目标。失败时清理临时文件。
2. 单文件读取上限默认 **32MB**（可设置 1~512MB）；超限抛 `code:"invalid-input"` 并提示「文件过大」。
3. 编码：UTF-8 / UTF-8 BOM 自动识别；无法解码时抛 `code:"invalid-input"`（上层弹编码选择框）。保存沿用打开时的编码与换行符。
4. `listDir` 跳过 `.` 与 `..`；符号链接要 `stat` 判断指向目录还是文件。
5. 路径一律经 `normalizeRemotePath()`（处理 `~`、尾斜杠、`.`/`..`），禁止字符串直拼。

### 5.3 `src/main/mirror/manager.ts` — 环境镜像（**性能关键，逐字照做**）

**职责**：把远端工作目录的源码镜像到本地，供 LSP 与本地搜索使用。

```ts
export class MirrorManager {
  constructor(conn: SSHConnection, mirrorRoot: string)   // mirrorRoot = userData/mirror/<hostId>/<hash(workspace)>
  sync(workspace: string, onProgress?: (p: { done: number; total: number; current: string }) => void): Promise<MirrorResult>
  localPathOf(remotePath: string): string               // 远端绝对路径 → 镜像本地路径
  remotePathOf(localPath: string): string
  applyLocalSave(remotePath: string, text: string, encoding: string, newline: string): Promise<void>  // 保存后同步镜像
  manifest(): Map<string, MirrorEntry>
}
```

**必须遵守的行为**：

1. **同步 = 一条 SSH 命令 + tar 单流**，**禁止**逐文件 SFTP 拉取（1 秒 RTT 下逐文件拉几千个文件会跑几分钟到几十分钟）：
   ```
   exec("cd <workspace> && tar czf - --exclude=./build --exclude=./install --exclude=./log
                  --exclude=./.git --exclude=./.cache --exclude='*.pyc' .", { timeoutMs: 0 })
   ```
   stdout 流式写入本地 `mirror.tar.gz`（**边收边写，禁止全量缓冲进内存**），然后解压到镜像目录（先解压到 `.staging` 再原子替换）。
   **tar 能力探测**：首次同步前先跑一条 `tar --version`（1 次往返），输出含 `GNU tar` 或 busybox 均可；
   若 tar 完全不可用（极小定制根文件系统），抛 `code:"unsupported"`，文案 `远端缺少 tar 命令，无法同步环境镜像`。
2. 排除规则（**必须排除**）：`build/`、`install/`、`log/`、`.git/`、`.cache/`、`*.pyc`、`__pycache__/`。
   **但头文件与 Python site-packages 必须同步**（见下方第 7/8 条），否则补全在 ROS/系统代码处静默失效 —— 这是本方案成立的前提。
3. 同步完成后生成 **manifest**（每个文件的 `path/size/mtime`，存 `manifest.json`）。`sync()` 返回的 `changed` / `removed` = 与上次 manifest 的差集（供渲染进程决定哪些已打开文档要重载）。
4. `localPathOf` 必须做**相对工作目录的换算**（远端与本地根不同，禁止字符串替换 hack）。
5. 保存文件时同步写镜像本地副本（保持镜像与板子一致）。
6. **compile_commands.json 处理**（clangd 能不能补全全看这条，漏了等于功能没做）：
   - 收集用**一条 exec 命令**（禁止递归 SFTP 列目录，往返算进预算）：
     `find <workspace>/build -name compile_commands.json`（找不到 `build/` 时退化为在 `<workspace>` 下找，深度限 4）；
     命中的文件很小，逐个 SFTP 拉（通常 1~3 个，可接受）；
   - 把所有条目**合并成镜像根的 `compile_commands.json`**：数组直接拼接，`directory` 与 `file` 字段里的远端路径前缀**重写为本地镜像路径**；
   - 找不到任何 compile_commands.json 时，生成镜像根 `compile_flags.txt` 兜底（内容：`-std=c++17`、`-I<镜像>/include`、`-I<镜像>`），并在设置页提示用户「建议在板子上用 colcon 生成 compile_commands.json 以获得完整补全」。
7. Python 环境部分：执行 `python3 -c "import sys,json;print(json.dumps(sys.path))"` 取 `sys.path`，把存在的目录 tar 进镜像 `_pyenv/`（保留原路径层级，**排除 `*.so`/`*.pyd`** —— aarch64 的 C 扩展在工作机上加载不了，留着只会让 jedi 报错），并生成 `_pyenv/sitecustomize.py` 把这些路径 prepend 进 `sys.path`；pylsp 启动时 `PYTHONPATH=<镜像>/_pyenv`。
8. **环境部分（头文件 / sysroot）** `collectSysroot()`，`sync()` 后执行：从 compile_commands 收集全部 `-I`/`-isystem`/`-iquote` 目录，并追加 `/usr/include`、`/usr/include/<triplet>`、`/usr/lib/gcc/<arch>-linux-gnu/<ver>/include`（`triplet` 取远端 `gcc -dumpmachine`）；一条 tar 命令压缩单流拉到镜像 `_sysroot/`，**只留头文件**（排除 `*.a`/`*.so*`）。量级：磁盘 0.5~1GB、压缩传输 100~200MB。
9. **增量同步（F5）**：源码部分与 sysroot 部分都走「时间戳增量」，算法见分册 `spec-v2-algorithms.md` A8b ——
   一条 `find -newer <上次同步标记> | tar -T -` 单流拉变更文件，`removed` 集合由新旧 manifest 差集得出后在本地删除；
   **禁止**为了增量退化成逐文件 SFTP。往返预算不变：仍是 1 条命令。
10. **target 三元组**：clangd 启动必须带 `--target=<triplet>`，否则 PC 端 clangd 用宿主三元组、`#ifdef __aarch64__` 分支走错。

### 5.4 `src/main/session/git.ts` — 远端 Git

```ts
export class GitRemote {
  constructor(conn: SSHConnection)
  repoInfo(directory: string): Promise<{ isRepository: boolean; root: string; branch: string }>
  treeStatus(directory: string): Promise<GitTreeStatus>       // 1 次 rev-parse + 1 次 status
  fileDiff(directory: string, relPath: string, content?: string, status?: GitFileStatus): Promise<GitDiff>
  commitAll(directory: string, message: string, opts?: { amend?: boolean }): Promise<string>
  push(directory: string): Promise<string>                    // 无上游自动 push -u origin <branch>
  sync(directory: string): Promise<string>                    // pull（无策略退 --rebase）→ push
  branches(directory: string): Promise<BranchInfo[]>
  switchBranch(directory: string, name: string): Promise<string>   // git checkout
  logGraph(directory: string, limit?: number): Promise<CommitInfo[]>  // 默认 200
}
```

**必须遵守的行为**（行为参照旧代码 `app/git/`，测试语义照搬）：

1. `treeStatus` 的往返预算 = **2 条命令**（合并 rev-parse 与 status），多一条即返工。
2. **打开工未修改的文件 = 0 条 git 命令**（用快照判断「未变更」），修改过的文件 = 1 条 `git diff`；保存/删除后**本地更新快照**（`markSaved/markRemoved/markClean`），禁止重新扫仓库。
3. porcelain 解析要处理：rename（`old -> new` 取新路径）、引号转义路径、未跟踪目录折叠（`?? dir/`）、目录继承色向上传播到仓库根。
4. `commitAll` = `git add -A` + `git commit -m <quote(message)>`；`amend` 时信息为空则 `--amend --no-edit`。
5. `push` 无上游分支时自动 `git push -u origin <current-branch>`。
6. `switchBranch` 用 `git checkout`（不是 `switch`，板子 git 可能很老）；分支名以 `-` 开头或为空 → 抛 `code:"invalid-input"`。
7. `logGraph` 一条 `git log --all --date-order --max-count=N`，解析后调 `shared/graph.ts` 的 `layout()` 算泳道（纯函数）。
8. 所有命令经 `exec()` 执行且 `cwd=仓库根`；命令参数一律 `shellQuote`。

### 5.5 `src/main/lsp/*` — 语言服务器（**在工作机上跑，指向镜像**）

```ts
// manager.ts
export class LspManager {
  constructor(mirror: MirrorManager, userData: string)
  ensure(language: "cpp"|"python", workspaceRoot: string): Promise<LspClient>  // 惰性启动
  stopAll(): Promise<void>                                    // 断开连接 / 退出时调用
  diagnostics(cb: (params: PublishDiagnosticsParams) => void): void
}
// client.ts — 标准 LSP 3.17 客户端子集
export class LspClient {
  completion(file: string, line: number, character: number): Promise<CompletionItem[]>
  definition(file: string, line: number, character: number): Promise<Location[]>
  hover(file: string, line: number, character: number): Promise<string | null>
  didOpen(file: string, text: string, version: number): void
  didChange(file: string, text: string, version: number): void
  didSave(file: string, text: string): void
  didClose(file: string): void
}
```

**必须遵守的行为**：

0. **语言服务器从哪来（工作机侧，装完即用的前提）**：
   - **clangd 随包分发**：各平台官方 release 二进制放 `resources/clangd/<platform>/`，
     electron-builder 经 `extraResources` 带进安装包；启动顺序 = 内置 clangd → `PATH` 里的 clangd → 降级。
   - **pylsp 不打包**（依赖用户 Python 环境）：启动顺序 = `python3 -m pylsp` → `py -m pylsp`（Windows）→ 降级，
     降级时状态栏提示的安装命令 = `pip install python-lsp-server`。
   - 「板子上」模式（`settings.lspTransport === "remote"`）是 §0 第 4 条禁止事项的**唯一例外**：
     经 SSH exec 按需拉起用户**自己事先装好**的 clangd/pylsp（我们不部署任何东西、非常驻、连接断即退出）；
     该模式下 T11 验收的「板子上 ps 看不到 clangd/pylsp」不成立（活动会话期间会有进程），其余模式仍必须满足。
1. 启动命令（**固定这些参数，见 §1.1 板子约束与 §7 性能预算**）：
   - C++：`clangd --background-index --completion-style=detailed --header-insertion=never --malloc-trim -j=2`
   - Python：`pylsp`（`python -m pylsp`；找不到解释器时抛 `code:"lsp"` 并在设置页提示安装命令）
   - **cwd = 镜像目录**，`rootUri = file://<镜像目录>`。
   - **必须**在应用退出 / 断开连接时 `kill()`（SIGTERM，2 秒后 SIGKILL）。语言服务器只在工作机上活，不影响板子，但仍要避免僵尸进程。
2. 协议：LSP 3.17 的 `initialize / initialized / textDocument/* / workspace/*` 子集；JSON-RPC 分帧 = `Content-Length: N\r\n\r\n<json>`。**自己实现分帧**（不引库）。
3. Monaco 适配（`lsp-bridge.ts`）：把 Monaco 的 `CompletionItemProvider` / `DefinitionProvider` / `HoverProvider` 接到 LspClient；诊断经 `monaco.editor.setModelMarkers` 上屏（**禁止**自己画波浪线）。
4. 文档同步用 `didChange` 的**全文**模式（`TextDocumentSyncKind.Full`，简单可靠；性能上单文件毫秒级，可接受）。
5. 语言服务器找不到时：**功能降级但不崩溃** —— 补全退化为 Monaco 内置词补全，状态栏显示「语言服务未安装（点击查看安装方法）」。

### 5.6 `src/main/session/terminal.ts` — 终端

```ts
export class TerminalChannel {
  constructor(conn: SSHConnection)
  open(cols: number, rows: number): Promise<void>   // ssh exec shell + pty-req
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(cb: (chunk: Buffer) => void): void
  onClose(cb: (code?: number) => void): void
  close(): void
}
```

- 渲染端用 **xterm.js**（含 `fit` addon），数据经 IPC `terminal.data` 双向流式传输（**批量合并到一帧再发**，禁止逐字节发）。
- 多终端 = 多 `TerminalChannel` 实例（每标签一个），关闭标签必须 `close()`。

### 5.7 `src/main/session/search.ts` — 全局搜索

```ts
export class SearchRemote {
  constructor(conn: SSHConnection)
  search(workspace: string, pattern: string, opts: { caseSensitive: boolean; regex: boolean }): Promise<SearchMatch[]>
}
```

- 一条命令：`grep -r -n -I -m 200 <-E|-F> <-i?> --exclude-dir=.git --exclude-dir=build --exclude-dir=install --exclude-dir=log --exclude-dir=__pycache__ --exclude-dir=node_modules -e <quote(pattern)> -- <quote(workspace)>`
- grep 退出码 0=有匹配、1=无匹配（不算失败）、其它=抛 `code:"ssh"`。
- 结果上限 500 条；解析格式 `路径:行号:内容`（最多切 2 刀）。

### 5.8 Preload 桥 API（渲染进程唯一入口，`window.api`）

```ts
export interface Api {
  host: {
    list(): Promise<HostConfig[]>
    save(host: HostConfig): Promise<void>
    remove(id: string): Promise<void>
    connect(id: string, secret?: SecretInput): Promise<void>
    disconnect(): Promise<void>
    listLocalKeys(): Promise<Array<{ path: string; label: string; encrypted: boolean }>>
  }
  fs: {
    listDir(path: string): Promise<RemoteEntry[]>
    readFile(path: string): Promise<{ text: string; encoding: "utf8"|"utf8-bom"; newline: "lf"|"crlf"; fingerprint: Fingerprint }>
    saveFile(path: string, text: string, opts?: { encoding?: "utf8"|"utf8-bom"; newline?: "lf"|"crlf" }): Promise<Fingerprint>
    create(path: string, isDir: boolean): Promise<void>
    rename(from: string, to: string): Promise<void>
    remove(path: string): Promise<void>
    stat(path: string): Promise<RemoteEntry | null>
  }
  mirror: { sync(): Promise<MirrorResult> }
  git: {
    treeStatus(directory: string): Promise<GitTreeStatus>
    fileDiff(path: string): Promise<GitDiff>
    commit(message: string, opts?: { amend?: boolean; push?: boolean; sync?: boolean }): Promise<string>
    branches(): Promise<BranchInfo[]>
    switchBranch(name: string): Promise<string>
    logGraph(limit?: number): Promise<GraphRow[]>
    refresh(): Promise<GitTreeStatus>
  }
  search: { find(pattern: string, opts: { caseSensitive: boolean; regex: boolean }): Promise<SearchMatch[]> }
  lsp: {
    completion(uri: string, line: number, character: number): Promise<CompletionItem[]>
    definition(uri: string, line: number, character: number): Promise<Location[]>
    hover(uri: string, line: number, character: number): Promise<string | null>
    changed(uri: string, text: string, version: number): void
  }
  terminal: {
    create(id: string, cols: number, rows: number): Promise<void>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    close(id: string): void
  }
  on(channel: string, cb: (...args: any[]) => void): () => void   // 事件订阅，返回退订函数
  // 事件通道（主进程 → 渲染）：
  // "auth-required"    { kind: "password"|"passphrase", hostId: string }
  // "mirror-progress"  { done: number; total: number; current: string }
  // "mirror-done"      MirrorResult
  // "diagnostics"      { uri: string; diagnostics: Diagnostic[] }
  // "terminal-data"    { id: string; data: string }   // base64
  // "terminal-closed"  { id: string }
  // "connection-state" { connected: boolean; message?: string }
}
```

**必须遵守**：`preload/index.ts` 里 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；`exposeInMainWorld("api", ...)` 是**唯一**暴露点；渲染进程**禁止**直接 `require`/`import` 任何 Node 模块。

### 5.9 渲染进程架构

1. **`store.ts`（自研极简状态容器，禁止引库）**：
   ```ts
   createStore<T>(initial: T): { get(): T; set(patch: Partial<T>): void; subscribe(fn: () => void): () => void }
   ```
   状态切片：`session`（连接状态、主机、工作目录）、`explorer`（树节点缓存）、`git`（TreeStatus 快照）、`editor`（标签列表、活动标签、脏标记）、`scm`（变更列表、提交图）、`search`（结果）、`terminal`（终端列表）、`ui`（侧边栏可见视图、面板可见性、主题、缩放）。
2. **视图组件**（`views/*.ts`）：每个导出 `mount(container, store): void` 与 `refresh(): void`，内部用 DOM 操作，**禁止**引入组件框架。
3. **Monaco 容器**：每标签一个 `monaco.editor.createModel`（语言按扩展名映射：`.c/.h/.cc/.cpp/.cxx/.hpp/.hh/.hxx`→`cpp`，`.py/.pyw`→`python`，`.md`→`markdown`，其余→`plaintext`）；标签切换只换 model，不重建 editor（性能要求）。

---

## 6. UI 规格（逐区块，照此实现）

### 6.1 总体布局（像素级结构）

```
┌────────────────────────────────────────────────────────────────────────┐
│ 标题栏（自绘，无系统标题栏）：[≡ 菜单]  [标题 — RemoteCodeEditor]   ─ □ ✕ │  高 32px
├──┬─────────────────────────────────────────────────────────────────────┤
│A │ 侧边栏（宽 260px，可拖拽 200~480px）                                  │
│c ├─────────────────────────────────────────────────────────────────────┤
│t │ 编辑区：[标签页行，高 32px：图标+文件名+脏点+✕]                       │
│  │ ┌─────────────────────────────────────────────────────────────────┐ │
│B │ │ Monaco 编辑区（补全弹窗/诊断/小地图由 Monaco 自带）              │ │
│a │ │                                                                 │ │
│r │ └─────────────────────────────────────────────────────────────────┘ │
│  ├─────────────────────────────────────────────────────────────────────┤  可拖拽
│44│ 底部面板（默认隐藏，高 240px）：[终端][输出]  [+][trash][收起]        │  分隔条
│px│ ┌─────────────────────────────────────────────────────────────────┐ │
│  │ │ xterm.js 终端                                                   │ │
│  │ └─────────────────────────────────────────────────────────────────┘ │
├──┴─────────────────────────────────────────────────────────────────────┤
│ 状态栏（高 24px）：⚡已连接·Robot  文件名  Git: main +3  ...  utf-8 C++ │
└────────────────────────────────────────────────────────────────────────┘
```

- **没有系统标题栏**：`frame: false` + 自绘标题栏（菜单、标题、窗口按钮 `─ □ ✕`，拖动/双击最大化/边缘 8px 缩放）。
- 活动栏宽 44px：图标列 = 资源管理器 / 搜索 / 源代码管理 / 远程主机 / 分隔 / 设置。**点当前视图 = 收起侧边栏**（VSCode 行为）。
- 所有可拖分隔条热区 ≥ 6px，默认只画 1px 中线，悬停变强调色。

### 6.2 颜色与字体（唯一来源 `styles/tokens.css`，**禁止**在别处写死颜色）

```css
:root {
  --bg-window: #1f1f1f;   --bg-panel: #181818;   --bg-editor: #1f1f1f;
  --bg-input: #313131;    --bg-hover: #2a2d2e;   --bg-selected: #04395e;
  --fg: #cccccc;          --fg-muted: #8b8b8b;
  --border: #3c3c3c;      --divider: #454545;
  --accent: #0078d4;      --commit-green: #238636;  --commit-green-hover: #2ea043;
  --git-added: #3fb950;   --git-modified: #e3b341;  --git-deleted: #f85149;
}
```
- 主题切换（设置里）：至少内置「深色 / 浅色」两套 tokens；Monaco 主题同步注册两套（`defineTheme`）。
- 字体：界面 `system-ui`；编辑器与终端 `JetBrains Mono, Consolas, monospace`。
  **打包 JetBrains Mono 的 woff2**（`resources/fonts/`，几百 KB，OFL 许可，附许可文件）——
  Windows 机器大多没装 JetBrains Mono，不打包会静默退到 Consolas；加载失败再退系统等宽字体。
- 全局缩放 `Ctrl+= / Ctrl+- / Ctrl+0`（0.7~2.0，作用于整个窗口 zoomFactor + Monaco fontSize）。

### 6.3 各区块行为

**侧边栏·资源管理器**：单列文件名（22px 行高），目录在前按名排序，**文件名永不被挤掉**；文件类型图标 + 行右端**彩色状态字母**（U/A/M/D，无底色方块，颜色即变更色）；大小/时间/权限进 Tooltip；右键菜单 = 新建文件/新建文件夹/重命名/删除/刷新/复制路径/属性；顶栏 = 纯图标按钮（新建文件/新建文件夹/刷新/折叠全部）。

**侧边栏·搜索**：查询框 + `Aa`（区分大小写）+ `.*`（正则）开关；结果按文件分组（文件名加粗 + 计数 + 弱化目录），命中行 = 弱化行号 + 正文 + **命中片段高亮加粗**；点结果 → 打开文件并跳到命中行。打开面板**不产生远端请求**（回车才搜）。

**侧边栏·源代码管理**：
- 提交框 placeholder = `消息（Ctrl+Enter 在"<分支>"上提交）`；
- **绿色拆分提交按钮**：左 `✓ 提交`（带 Codicons check 图标），右下拉箭头 → 菜单四项：`提交(修改)`（amend，空信息时 `--no-edit`）、`提交和推送`、`提交和同步`、分隔、`提交并继续`（可选，不做也行）；
- 「更改」分组（可折叠，箭头在标题左侧、刷新按钮在右侧），行 = 类型图标 + **文件名（优先占宽）** + 弱化目录 + 行右端彩色字母；
- 底部「图表」分组（默认折叠，**展开才拉一次 git log**）：左侧泳道图（空心圆点，点中变实心 + 行高亮）、右侧提交标题 + 引用徽章 + 短哈希/作者/相对时间；
- 「更改」与「图表」之间是**可拖拽分隔条**；打开面板本身 0 远端请求。

**编辑区·标签页**：图标 + 文件名 + 脏点（未保存显示圆点）+ `✕`（悬停出现）；中键/`Ctrl+W` 关闭；拖动可排序；右键 = 关闭其它/关闭右侧/全部保存。

**底部面板·终端**：单行工具条 = `终端` 标题 + 页签条（选中页签下方 accent 细线）+ 右侧按钮（新建/终止/收起）；xterm.js 渲染；`Ctrl+\`` 开关、`Ctrl+Shift+\`` 新建。

**状态栏**（左→右）：`⚡ 已连接·<主机名>`｜当前文件名｜`Git: <分支> +3 ~2 -0`｜右侧：保存状态、编码、语言、`行 1，列 1`。**点 `Git: <分支>` 弹分支选择菜单**（本地分支可切、当前分支打勾、远程分支只展示）。

### 6.4 对话框

全部无边框（`frame: false`）+ 自绘标题栏（标题 + `✕`，可拖动）+ 圆角 8px + 1px 描边：
- 提示框：严重级别图标（错误红 / 警告黄 / 提示蓝，圆 + 字母）+ 文本 + 按钮行（确认按钮用 accent 实心）。
- 连接表单 / 设置 / 文件编码选择 / 重命名 / 转到行：同套外壳。
- **禁止**使用任何带系统标题栏的原生对话框（`alert`、系统文件框除外——文件选择可用系统框）。

### 6.5 快捷键（必须全部实现）

| 快捷键 | 功能 | 快捷键 | 功能 |
| --- | --- | --- | --- |
| `Ctrl+N` | 新建文件 | `Ctrl+O` | 打开远程文件夹 |
| `Ctrl+S` | 保存 | `Ctrl+Shift+S` | 全部保存 |
| `Ctrl+W` | 关闭标签 | `Ctrl+Tab` | 下一个标签 |
| `Ctrl+F` | 查找（当前文件，Monaco 自带） | `Ctrl+H` | 替换（当前文件） |
| `Ctrl+Shift+F` | 全局搜索 | `Ctrl+G` | 转到行 |
| `F12` | 跳转定义 | `Shift+F12` | 查找引用 |
| `Ctrl+Space` | 触发补全 | `F2` | 重命名符号（LSP） |
| `F5` | 刷新工作目录 + 镜像重同步 | `Shift+F5` | 刷新 Git 快照 |
| `Ctrl+B` | 收起/展开侧边栏 | `Ctrl+J` | 收起/展开底部面板 |
| ``Ctrl+` `` | 开关终端 | ``Ctrl+Shift+` `` | 新建终端 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 界面缩放 | `Ctrl+,` | 设置 |
| `Ctrl+Q` | 退出 | | |

---

## 7. 性能预算（**这是本项目的灵魂，逐条验收**）

高延迟链路（1 秒 RTT）下，以下操作的**远端往返次数上限**（超过即返工）：

| 操作 | 远端往返上限 | 说明 |
| --- | --- | --- |
| 连接 | 1 TCP + 认证 | 认证顺序见 §5.1 |
| 首次同步镜像 | **1 条命令**（tar 单流） | 禁止逐文件拉 |
| 刷新镜像（F5） | 1 条命令 | 同上 |
| 打开工作目录 | 2 条 git + 1 次 list_dir | rev-parse 合并调用 |
| 展开一个目录 | 1 次 SFTP list_dir | **有 120 秒缓存 + 预取 ≤3 个子目录**（缓存命中 0 次） |
| 打开未修改文件 | **0 条 git** | 用快照判定「未变更」 |
| 打开已修改文件 | 1 条 git diff | |
| 保存文件 | 2 次 SFTP（临时文件 + rename） | 保存后**本地更新快照**，0 条 git |
| 删除/重命名 | 1~2 次 SFTP | 之后本地更新快照 |
| Git 状态刷新 | 1 条 `git status` | 文件树/SCM/状态栏/差异共用一份快照 |
| 全局搜索 | 1 条 `grep` | |
| **代码补全 / 跳转 / 悬浮** | **0 次**（本地 LSP） | 这是新架构的核心收益 |
| 打开 SCM 面板 | **0 次** | 复用已有快照 |
| 展开「图表」 | 1 条 `git log` | 默认折叠 |

另外：**目录列举去重**（同一条目录在飞行中只发一次请求）+ **TTL 120 秒缓存（上限 200 条）** + **预取最多 3 个子目录**（后台、低优先级）。

---

## 8. 安全（硬性）

1. `BrowserWindow` 必须：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`、`allowRunningInsecureContent: false`、`preload` 只暴露 `window.api`。
2. 密码 / 私钥口令**只存内存**（主进程 `SecretInput` 变量），用完置 `undefined`；**禁止**写入配置、日志、崩溃转储。
3. 主机配置文件（`userData/hosts.json`）**禁止**含任何凭据字段（保存前断言，测试覆盖）。
4. 私钥识别：`~/.ssh` 下按文件头识别（跳过 `known_hosts*`、`*.pub`、`authorized_keys`、子目录、>1MB 文件）；解析类型、是否加密、`.pub` 注释。
5. `~/.ssh/config` 导入只识别 `Host/HostName/Port/User/IdentityFile`（含 `Include` ≤4 层、去重；忽略通配 Host 与 `Match`）。
6. 远端命令参数一律 `shellQuote()`；禁止字符串直拼命令。
7. 日志脱敏：密码、口令、私钥内容一律 `<已脱敏>`。

---

## 9. 错误处理与日志

1. 所有错误统一为 `AppError`（§5.0），渲染进程收到 `{ code, message, detail }` → 映射中文文案（`shared/errors.ts`）。
2. 认证失败（`code:"auth"`）**必须**走「侧边栏底部密码输入行」，**禁止**弹死胡同错误框；`auth-passphrase-required` 走口令输入行。
3. 自动保存失败**禁止**弹模态框（状态栏提示即可）；手动保存失败弹错误提示框。
4. 日志落 `userData/logs/app-YYYYMMDD.log`，按天滚动，保留 7 天；级别 INFO 起。

---

## 10. 测试要求（每条都要写，缺测试 = 未完成）

### 10.1 单元测试（`tests/unit/`，vitest）

| 文件 | 必须覆盖的用例 |
| --- | --- |
| `paths.test.ts` | `~` 展开、尾斜杠、`.`/`..` 折叠、相对路径转绝对 |
| `git-status.test.ts` | porcelain 解析（普通/重命名/引号路径/未跟踪目录折叠）、目录继承色传播、`markSaved/markRemoved/markClean` 本地更新、符号链接路径换算（工作目录与仓库根写法不同时按相对尾巴匹配，撞车不猜） |
| `diff-parser.test.ts` | hunk 解析、行号映射、新增/修改/删除标记、删除文件 |
| `graph.test.ts` | 提交图泳道：线性历史 1 泳道、两条分支顶端、合并两父、并线、空输入 |
| `mirror.test.ts` | tar 命令拼装（排除规则）、manifest 差集（changed/removed）、路径换算、compile_commands.json 收集与路径重写 |
| `search.test.ts` | 命令拼装（-E/-F/-i、`-e` 保护以 `-` 开头的关键字）、解析、无匹配（退出码 1）不算失败 |
| `connection.test.ts` | 认证顺序（显式私钥 > 默认名私钥 > 密码）、`No supported authentication methods` 归类 `auth`、超时归类 `timeout`、`exec` 的 cwd 与 shellQuote |
| `git.test.ts` | 往返次数预算（treeStatus=2 条、commitAll=add+commit、push 无上游自动 -u、sync=pull→push、branches 解析含 detached） |
| `lsp-client.test.ts` | JSON-RPC 分帧（半包/粘包）、initialize 握手、completion/definition/hover 报文转换 |

### 10.2 集成测试（`tests/integration/`）

- **假 SSH 服务端**（用 Node 的 `ssh2` 服务端 API 起本地进程内服务，监听 127.0.0.1 随机端口）：覆盖连接 → 列目录 → 读文件 → 保存（验证原子写 = 临时文件 + rename）→ Git 快照 → 搜索 → 终端回显。
- **镜像同步测试**：假服务端返回固定 tar 流 → 验证解压结果、manifest、changed/removed。
- **LSP 端到端**：用一个极小的假 LSP 服务器脚本（本仓库自带 `tests/fixtures/fake-lsp.mjs`，实现 initialize/completion/definition/hover）验证客户端全链路。

### 10.3 渲染层测试（`tests/ui/`）

- store 订阅/更新；文件树懒加载与缓存命中；标签页增删与脏标记；快捷键表触发；搜索结果分组与跳转行号计算。

### 10.4 验收命令

```bash
npm run lint        # 0 告警
npm test            # 全绿
npm run typecheck   # tsc --noEmit，0 错误
npm run build       # Windows / Linux 产物（CI 上跑；macOS 暂缓，见 §1.4）
```

---

## 11. 打包与分发

1. `electron-builder.yml`：
   - `appId`: `com.remote-code-editor`；`productName`: `RemoteCodeEditor`；
   - Windows：`nsis`（安装版）+ `portable`（便携版单 exe）；`icon: resources/icon.ico`；
   - Linux：`AppImage` + `deb`；`category: Development`；
   - macOS：`dmg` 配置**保留但 CI 不出包**（§1.4：当前无需求，恢复时只需把 CI matrix 加回来）；
   - `files`: `dist/**`、`resources/**`、`package.json`；`asar: true`；
   - `extraResources`: `resources/clangd/<platform>/` → `clangd/`（按构建平台各带各的，见 §5.5）。
2. `.github/workflows/release.yml`：
   - 触发：`push` tag `v*`；
   - matrix：`windows-latest` / `ubuntu-22.04`（macOS 暂缓），各自 `npm ci && npm run build && npx electron-builder --publish never`；
   - 产物上传到 GitHub Release（命名：`RemoteCodeEditor-<version>-<os>-<arch>.<ext>`）。
3. **二进制不进 git**；源码进 git、安装包进 Release。

---

## 12. 里程碑（顺序执行，每步验收后才进下一步）

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M1 工程骨架** | 目录结构、tsconfig/eslint、Electron 窗口（自绘标题栏、无系统边框）、Monaco 加载并显示示例代码、Windows/Linux 打包配置 + CI workflow | `npm run build` 出 Windows/Linux 包；装完能启动、Monaco 能编辑示例文本、窗口无系统标题栏 |
| **M2 远端层** | connection / remote-fs / git / search + `shared` 纯函数 + 全部单元测试 | §10.1 对应用例全绿；假 SSH 集成测试过；往返次数预算用例（打开干净文件 0 条 git 等）**必须**写成断言 |
| **M3 环境镜像 + LSP** | MirrorManager（tar 单流、manifest、**头文件/site-packages 环境部分**、compile_commands 收集重写、target 三元组）、LspManager + LspClient（**本机与板子上两种传输**）+ lsp-bridge、Monaco 补全/跳转/悬浮/诊断 | 打开 C++ 文件敲代码出补全弹窗；F12 跳定义；文件有错处出红色波浪线；**板子上 ps 看不到任何新进程** |
| **M4 外壳·文件与编辑** | 活动栏、文件树（懒加载+缓存+预取+右键全套）、标签页编辑区、保存/自动保存/冲突提示、状态栏 | 走完「连接→开目录→开文件→改→存」全链路；往返预算过 |
| **M5 外壳·Git 与搜索** | SCM（变更列表、绿色拆分提交按钮、提交图、分支菜单）、**暂存区分组 + 逐文件暂存/撤销**、**仓库管理对话框（远程/stash/标签/分支）+ 克隆/初始化**、搜索视图、行级差异与 gutter | 四条提交路径（提交/提交(修改)/提交和推送/提交和同步 + 提交所有更改）都通；分册 5 的 G7 用例全绿；图表按需加载；搜索点结果跳行 |
| **M6 收尾** | 终端（xterm.js）、设置（主题/字号/缩放/自动保存/语言服务开关）、无边框对话框全套、打包与 Release | §10.4 全过；Windows/Linux 安装包装完即用；README/快捷键文档齐 |

> 顺序说明：M2 完成后，**允许（并鼓励）先用最小 UI 提前验证 M3 核心链路**（tar 镜像 → clangd 补全跑通），
> 这是全方案价值最大、风险最高的一段，不等 M4 外壳齐了再验。

---

## 13. 实现者易踩的坑（逐条照做可避坑）

1. **Monaco 在 Electron 里不要用打包器**：`tsc` 编译后，`index.html` 用 `<script src="node_modules/monaco-editor/min/vs/loader.js">` + `require.config({ paths: { vs: "./node_modules/monaco-editor/min/vs" } })` 异步加载；`file://` 协议下这样可用。若必须用打包器，官方推荐 `esbuild`，但**本项目不引打包器**。
2. **xterm.js 的字体度量**：容器 resize 时调 `fitAddon.fit()`，并在窗口缩放/分隔条拖动后重新 fit，否则字符错位。
3. **ssh2 的 SFTP 不是并发安全**：所有 SFTP 调用过同一把串行锁。
4. **tar 流必须边收边写**：`conn.exec()` 的 stdout 是流，用 `pipeline(stream, createWriteStream(tarPath))`，禁止 `Buffer.concat` 全量收进内存。
5. **compile_commands.json 的 `directory`/`file` 是绝对远端路径**，合并时必须重写为本地镜像路径前缀，否则 clangd 全部找不到文件、补全静默失效（**这是最容易漏的坑，M3 验收必须包含它**）。
6. **JSON-RPC 分帧**：`Content-Length` 头按字节算（不是字符），中文内容必须 `Buffer.byteLength`；半包/粘包都要处理（测试覆盖）。
7. **Monaco 的 `setModelMarkers`** 要用固定 owner 字符串（如 `"lsp"`），换文件时先清空旧标记。
8. **Electron 的 `sandbox: true`** 与 `nodeIntegration: false` 同时开；`preload` 里**只**用 `contextBridge`，不要把 `ipcRenderer` 整个暴露出去（只暴露 §5.8 的 api 形状）。
9. **标签页 model 生命周期**：关标签必须 `model.dispose()`，否则内存泄漏。
10. **快捷键**用 `globalShortcut` 不合适（会抢全局），用渲染进程 `keydown` + `e.preventDefault()`，或主进程 `before-input-event`；焦点在输入框时保留系统行为（`Ctrl+C/V` 等）。
11. **密码字段**：`type="password"` 且禁止复制到日志；连接失败重试时不要把密码回显到输入框。
12. **窗口无系统标题栏**：`frame:false` 后 macOS 的红绿灯没了，自绘按钮要处理双击最大化、拖动、**边缘 8px 缩放**（在渲染进程透明热区实现，或主进程 `setBounds`）。

---

## 14. 遗留问题（实现者遇到规格未覆盖处，追加到此）

1. 底部面板的「输出」页签在布局图里有，但内容规格未定义（应用日志摘要？构建输出？）——实现前需补。
2. macOS 恢复出包时要补：红绿灯按钮适配、公证（不公证需在 README 写明右键打开）。
