# 我们的 SSH 能不能替代 Remote-SSH：差异清单与处置

> 状态：基准文档（2026-10-12 起）。路线是 **fork CodeOSS 拿外壳 + 用我们自己的 SSH 层替掉 Remote-SSH**
> （见 `ide/README.md`）。本文回答一个问题：**替得掉吗？哪些地方会被影响？怎么解决？**
> 每一项的"结论"都必须有源码或实测证据，不许纸面推演；没验完的明确标 `未验证`。

## 0. 一句话结论

**架构上不可能"完美"替代，但功能上可以等价替代 —— 前提是把 Remote-SSH 白拿的那 5 件事自己补上。**

- Remote-SSH 的本质不是"能读写远端文件"，而是**在目标机上跑了一个扩展宿主（`~/.vscode-server`）**：
  扩展、终端、git、任务、调试器全都在远端进程里执行，路径天然是远端路径。
- 我们的硬约束是**目标机零部署、零常驻服务**（AGENTS.md），所以**不能**照搬这条路 ——
  这正是它节省的地方，也是它代价的来源：凡是"必须有个远端进程才能干"的活，都得我们自己补。
- 我们采用的等价形态：**`sshfs://` 虚拟工作区 + 本地扩展宿主 + 自补远端能力**（终端 / 搜索 / SCM /
  文件监听 / 本机标准 LSP + 只读 SSHFS）。
- 代价集中在两处，都已定位并有对策：
  1. **虚拟工作区语义**带来的扩展启用与"本地/远端"判断差异（影响面比想象小，见 §2.2）；
  2. 一批**内置扩展默认会去操作本机**（终端、git、搜索、任务、调试），必须显式替换。
  语言服务不再要求目标机安装，也不再走源码镜像：开发机 LSP 通过只读 SSHFS 惰性读取远端整棵文件系统。

## 1. 机制差异（源码证据）

| 事实 | 证据 |
|---|---|
| `file:` 与 `vscode-remote:` 之外的一切 scheme 都被判为**虚拟工作区** | `ide/vscode/src/vs/platform/workspace/common/virtualWorkspace.ts`：`isVirtualResource = scheme !== file && scheme !== vscode-remote` |
| 虚拟工作区里，声明 `capabilities.virtualWorkspaces: false` 的扩展**被禁用** | `.../extensionManagement/browser/extensionEnablementService.ts` `_isDisabledByVirtualWorkspace()`；默认值见 `extensionManifestPropertiesService.getExtensionVirtualWorkspaceSupportType()`（缺省 = 支持，只有显式 `false` 才禁） |
| Remote-SSH 的工作区**不是**虚拟工作区 → 它拿的是"和工作机一样"的语义 | 同上，`vscode-remote` 被特判排除 |
| 内置搜索只为 `file:` 注册 provider，虚拟 scheme 不注册就搜不到东西 | `.../services/search/browser/searchService.ts:45` 只 `registerSearchResultProvider(Schemas.file, ...)` |
| 内置终端在虚拟工作区里会**开本机 shell**，还打印一行提示 | `.../contrib/terminal/browser/terminalService.ts` `_evaluateLocalCwd()`：`"This shell is open to a local {0}folder, NOT to the virtual folder"` |
| 扩展注册的终端 profile 想被当成默认，必须同时 `contributes.terminal.profiles` + `configurationDefaults` | `terminalProfileService.ts`（contributed profiles 按 `title` 进 `availableProfiles`，`getDefaultProfile()` 按 `profileName` 匹配）；实测见 §4 |
| 搜索 provider（`registerFileSearchProvider` / `registerTextSearchProvider`）是 **proposed API** | `src/vscode-dts/vscode.proposed.fileSearchProvider.d.ts` / `...textSearchProvider.d.ts`；出源码运行时全放开，**打包后必须写进 `product.json#extensionEnabledApiProposals`**（`extensionsProposedApi.ts`，`isBuilt` 时白名单生效） |
| 内置 git 扩展在虚拟工作区里仍然"支持"，但它只会跑**本机** `git` | `extensions/git/package.json` → `capabilities.virtualWorkspaces: true`；代码里没有远端分支，`git rev-parse` 用的是工作区路径的 `fsPath` |

## 2. 逐项差异与处置

图例：**✅ 已解决（本仓库/本扩展已实现且有实测）** ／ **🟡 可解，待做** ／ **🔴 不可解，只能改写预期**

### 2.1 文件系统

| 项 | Remote-SSH | 我们 | 结论 |
|---|---|---|---|
| 读写远端文件 | 远端扩展宿主直接用 node fs | `sshfs://` FileSystemProvider → 我们的 SFTP 层 | ✅ 已解决（Q1 7/7 + E2E） |
| 字节保真 | 天然 | 必须**绕开** `RemoteFs.readFile/saveFile`（它们按文本解码/换行归一化），直接走原始 SFTP 流 | ✅ 已解决（`ide/extensions/sshfs/src/fs-provider.js` 的 `readBytes/writeBytes`，写出还是原子写 temp+rename） |
| 错误分类 | node errno | 必须映射成 `vscode.FileSystemError`：`createDirectory` 会先 `stat`，**只把 `FileNotFound` 当正常** | ✅ 已解决（根因修在 `src/shared/errors.ts` 新增 `not-found` 码 + `sftpCode` 透传，`src/main/session/remote-fs.ts#classifySftpError`；provider 侧据此映射 NotFound/NoPermissions/FileExists） |
| mtime 单位 | ms | ssh2 给的是**秒**，要 ×1000 | ✅ 已解决 |
| 符号链接 | 透传 | SFTP `lstat` → `FileType.SymbolicLink` | ✅ 已解决 |
| 性能预算（0 次交互式往返） | — | 目录列表/读写各 1 次 SFTP 往返 | ✅ 已解决（复用既有 `SSHConnection.sftpRun` 串行队列） |

### 2.2 扩展启用（虚拟工作区语义）

实测（`ide/vscode/extensions/*/package.json` 全量扫描）：**93 个内置扩展里只有 7 个声明 `virtualWorkspaces: false`**，
它们在 `sshfs://` 工作区里会被禁用：

| 被禁用的内置扩展 | 对我们的影响 | 处置 |
|---|---|---|
| `grunt` / `gulp` / `jake`（任务运行器） | 无（嵌入式工程不用） | 🔴 预期内，不管 |
| `debug-auto-launch` / `debug-server-ready` | 只是调试辅助 | 🔴 预期内 |
| `php-language-features` | 无（不做 PHP） | 🔴 预期内 |
| `tunnel-forwarding` | 无（我们不做隧道） | 🔴 预期内 |

其余全部保留：`git` / `git-base` / `search-result` / `markdown-language-features` / `html|css|json-language-features` /
`emmet` / `merge-conflict` / `references-view` / `notebook-renderers` …（`typescript-language-features` 是
`{"supported":"limited"}`，虚拟工作区下可用，走 `workspace.fs`）。

**结论：扩展启用的影响面比预想小得多，不需要给用户"扩展会被大面积禁用"的预期。**
⚠️ 第三方扩展若声明 `virtualWorkspaces: false`（很多老扩展如此）会被禁用 —— 这是 VSCode 对"虚拟工作区"的既定语义，
和我们无关；要规避只能在我们的扩展里做白名单，**不建议**。

### 2.3 扩展宿主位置（最本质的差异）

| 项 | Remote-SSH | 我们 |
|---|---|---|
| 扩展跑在哪 | 目标机（`~/.vscode-server`，约 250MB，Node 常驻） | **工作机** |
| 用 node `fs` 直接读 `uri.fsPath` 的扩展 | 能工作（因为 ext host 在远端） | **不工作**（路径是远端的，本机不存在）→ 必须走 `workspace.fs` |
| 目标机是否被改动 | 是（装 server） | **否**（只有一个 sshd/sftp） |

**这是不可解的架构差异**：要让"跑在远端的扩展"存在，就必须在目标机放一个进程。
我们的取舍是保住"零部署"；代价是**不能直接吃 Remote-SSH 生态里那些只会用 node fs 的远端类扩展**。

> 退路（仅当某类工作必须"远端原生执行"时考虑，例如必须用板子上的交叉工具链跑远端任务）：
> 把工作**降到命令级**——用 SSH `exec` 跑远端命令，把输出拉回来渲染。我们的终端/搜索/SCM 都是这么做的。
> 真需要完整远端扩展宿主时，只能放宽硬约束，另行评估（不在当前路线内）。

### 2.4 集成终端

| 项 | 影响 | 处置 |
|---|---|---|
| 默认行为 | 🔴 内置终端在虚拟工作区开**本机** shell（cwd 还指向远端路径，等于在错的地方开了个本地 shell） | ✅ 已解决：扩展提供 `TerminalProfileProvider`（`src/terminal.js`，PTY 走 `TerminalChannel` → SSH `shell`），并用 `contributes.terminal.profiles` + `configurationDefaults.terminal.integrated.defaultProfile.linux = "织码 WeaveCode"` 把它设为默认；实测 `当前终端=[织码 WeaveCode]`，终端里真的是远端 bash（截图 `ide/tools/shots/e2e-*.png`） |
| 断开重连 | 终端会一起死 | 🟡 待做：终端项做"重启会话" |
| 远端环境变量/`$PATH` | 由 sshd 决定，和我们无关 | ✅ |

### 2.5 全局搜索

| 项 | 影响 | 处置 |
|---|---|---|
| `Ctrl+Shift+F` / `Ctrl+P` | 🔴 不注册 provider 就是**永远搜不到**（见 §1 证据） | ✅ 已解决：用 proposed API 注册 `fileSearchProvider`（`Ctrl+P`/`findFiles`）与 `textSearchProvider`（`Ctrl+Shift+F`）；实测 `findFiles("**/main.c") → /ws/src/main.c`，文本搜索命中远端 README 第 3 行 |
| 搜索实现 | Remote-SSH 用远端 ripgrep | 我们复用 `src/main/session/search.ts` 的**一条 grep 命令**（结果上限 500，往返 1 次）；`fileSearchProvider` 用一条 `find` 拿清单 + 内存缓存（15s TTL） |
| `includes`/`excludes`/`isWordMatch`/多行 | 原生支持 | 🟡 待做：目前忽略这几个过滤条件（已在代码注释里标明） |
| 大仓库性能 | 远端 ripgrep 全速 | 🟡 待做：`find` 全量清单对超大仓库偏重；后续换成"按需 + 目录缓存 + 尊重 `.gitignore`" |

### 2.6 源代码管理（Git）

| 项 | 影响 | 处置 |
|---|---|---|
| 内置 git 扩展 | 🔴 在虚拟工作区里它**不报错但也找不到仓库**（跑本机 `git`，工作区路径本机不存在）→ SCM 面板空白 | ✅ 已解决：扩展自己 `scm.createSourceControl()` 供面板，复用 `src/main/session/git.ts`（`GitRemote`）与 `src/shared/git-status.ts`（`splitStatus`）；实测 SCM 面板显示 `main` 分支 + 2 处更改（`C src/main.c`、`≡ src/new-file.txt`） |
| 行内差异（quick diff） | — | ✅ 已解决：`quickDiffProvider` + `rce-git:` 虚拟文档（内容 = 远端 `git show HEAD:<rel>`） |
| 暂存/取消暂存/放弃/提交 | — | ✅ 已解决：`git add/restore --staged/restore/clean` + `acceptInputCommand` 提交（放弃先弹模态确认） |
| 历史图、提交变更、右键操作 | 内置 git 原生 Source Control Graph | ✅ 已解决：`scmHistoryProvider` 喂远端 `git log` / `diff`，图表和连线由 CodeOSS 渲染；查看提交变更、检出提交、撤销提交、硬重置、复制提交 ID 均已接通 |
| 分支切换、暂存全部、提交修改/提交并推送 | 内置 git 全都有 | ✅ 已解决：标题栏/资源组/大按钮菜单走原生贡献点；修复 merge 提交 `diff-tree` 默认为空、多根工作区参数传递和历史 ref 短名不匹配 |
| stash、pull/fetch | 内置 git 全都有 | 🟡 待做：`GitRemote` 已有 `stash*/sync` 方法，尚未接 UI |
| 合并冲突编辑器 | `merge-conflict` 扩展可用 | 🟡 未验证 |

### 2.7 任务（tasks）/ 调试 / 端口转发

| 项 | Remote-SSH | 我们 | 结论 |
|---|---|---|---|
| `.vscode/tasks.json` | 在远端执行（远端扩展宿主里的任务系统） | ✅ 已解决：自己提供 `TaskProvider`（`ide/extensions/sshfs/src/tasks.js`），把 `shell` 任务改写成 `SSHConnection.execStream`，**cwd/env/`${workspaceFolder}` 都在远端语境里解析**；`dependsOn` / `dependsOrder` / `isBackground` 与常用 `problemMatcher` 也已接通（§5.5） |
| 调试（launch.json） | 远端起 debug adapter | 本机起 adapter，路径对不上；`debug-auto-launch`/`debug-server-ready` 还被虚拟工作区禁用 | 🔴 当前不支持：要支持就得自己做 adapter 桥（`DebugAdapterDescriptorFactory` + `ssh exec` 起远端 adapter，如 gdbserver）。已列入待做，但不在近期 |
| 端口转发 | 内置 | 无 | 🔴 不支持（嵌入式场景一般也不需要） |
| `.vscode/settings.json` 之类的工作区配置 | 读写远端 | ✅ 走我们的 provider 读写远端 —— 启动早期工作台（在 provider 注册之前）会去探 `.vscode/*.json`，刷出 `ENOPRO: No file system provider found` 日志；**关键是这些请求现在会等会话就绪**（§5.4），配置本身会生效，日志纯属噪声（实测不同窗口 1~47 条，待做） | ✅ 可用 |

### 2.8 文件监听（外部改动）

| 项 | Remote-SSH | 我们 |
|---|---|---|
| 机制 | 远端扩展宿主的 inotify/parcel watcher | **轮询**（SFTP 没有 inotify，远端又不许常驻服务） |
| 目录级 | 实时 | ✅ 已解决：`watch()` 每 3s 一次 `readdir`（带 size/mtime），能发现改名/改内容；自己写过的目录会立刻重读快照，避免"磁盘文件已被修改"误报（事件字段名的坑见 §5.6） |
| 整树级（git/TS 扩展要的 recursive watch） | 实时 | 🟡 一条 `find` 拿全树名字（8s 一次），只能发现**增删**，发现不了"只改内容"；大仓库要再优化（尊重 `.gitignore`、按需递归） |
| 监听数量上限 | 无 | 上限 200 个目录，超了就不再轮询（宁可少刷新，也不打爆板子） |
| 预设轮询参数 | — | `rce.watch.pollMs`（默认 3000ms） |

### 2.9 语言服务（补全 / 跳转 / 悬浮 / 诊断）

设计基准见 **[lsp-mirror-design.md](lsp-mirror-design.md)**：本机标准 LSP 按需读取只读
SSHFS 视图，目标机零语言服务，浏览模式零进程。

| 项 | Remote-SSH | 我们 |
|---|---|---|
| 谁在跑 | 远端扩展宿主里的语言服务器 | **开发机标准 LSP**；目标机只提供 sftp，不安装语言服务器，也不部署 VS Code Server |
| 镜像与路径重写 | 不需要 | ✅ 只读 SSHFS 挂载远端 `/`，源码和系统头按需读取；远端编译数据库重写到挂载前缀，URI 再映射回 `sshfs://` |
| 接进 CodeOSS | 远端服务器天然用远端路径 | ✅ `DefinitionProvider` / `HoverProvider` / `DocumentSymbolProvider` / `CompletionItemProvider` 等注册在 `{scheme: sshfs}`，支持补全、诊断、跳转、引用、重命名、签名、代码操作、格式化和折叠 |
| 诊断 | 远端服务器直接推给编辑器 | ✅ 已解决：`publishDiagnostics` → `vscode.languages.createDiagnosticCollection`（固定 owner，等同 `setModelMarkers`，不自己画波浪线） |
| 生命周期 | 跟着远端 ext host | ✅ 浏览模式不启动；代码智能模式按需启动；切回浏览先热保留，超时退出；关标签只发 `didClose` |
| 语言匹配 | 天然（远端 languageId） | ✅ 通用注册表优先 languageId，扩展名兜底；`.c` 与 `cpp` 都映射到 clangd；任意语言通过 `rce.lsp.servers` 注册 |
| JS/TS/JSON/HTML/CSS | 远端跑 | 🟡 上游内置语言功能在虚拟工作区走 `workspace.fs`，可提供语法/基础编辑；需要完整 tsserver 时按 `rce.lsp.servers` 配置标准 LSP |
| 资源占用 | 远端 ext host + 服务器 | 浏览 0 个 LSP；智能模式在**开发机**启动，RK3566 只承担 SFTP 读取。clangd 默认 `-j=1`，索引留在内存 |

**实测（`ide/tools/run-e2e.sh`，假 SSH + 真只读 SSHFS + 本机假 LSP）**：
浏览模式冷启动，切代码智能后 `定义→sshfs://…/ws/src/util.c`、悬浮 1 条、符号 1 个、补全 4 项、
诊断 1 条。另有本地假 SSH + 真子进程假 LSP 的集成测试覆盖 SSH exec 双向 JSON-RPC。

**配套命令与配置**：浏览/代码智能模式命令、`rce.lsp.restart`、`rce.lsp.configure`；
`rce.lsp.mode` / `autoPromoteOnEdit` / `warmRetentionMinutes` / `servers` / `cppPath` / `pythonPath`。
开发机需要 `sshfs`（deb 自动依赖）。`transport=remote` 仅用于目标机本来就有 LSP 的场景，
`transport=local` 仅用于旧镜像兼容。状态栏会显示浏览、热保留、挂载、启动中、就绪或失败。

### 2.10 凭据与安全

| 项 | Remote-SSH | 我们 |
|---|---|---|
| 密码存放 | 系统钥匙串 | ✅ 只在内存里的会话表（`src/session.js`），**不落盘、不进日志**；URI authority 只放 `user@host:port`，不带凭据 |
| 重启窗口后 | 重新连接（有 Remote-SSH 的连接缓存） | 🟡 待做：目前重启窗口后需要重新执行「连接到远程主机」（这是"只存内存"的直接代价，属于有意取舍） |
| 主机公钥校验 | 有 | ✅ `SSHConnection` 已有 `strictHostKey` + `known_hosts`；交互式连接默认开 |

### 2.11 界面指示

| 项 | Remote-SSH | 我们 |
|---|---|---|
| 左下角远程指示 | "Open a Remote Window" + 绿色远程标记 | ✅ 使用 CodeOSS 原生 `statusBar/remoteIndicator`；未连接显示「连接到远程主机…」，已连接显示「断开远程连接 / 新建远程终端」 |
| 远程资源管理器 | 内置 `Remote Explorer` 容器：`SSH` 分组、`+` 新建远程、齿轮打开 `~/.ssh/config`、主机/最近目录的原生内联操作 | ✅ 不自制容器：扩展通过 `views.remote` + `remoteTargets` 注册原生 TreeView，界面、图标、标题栏/右键/悬停菜单全由 CodeOSS 渲染；主机行直接连接，配置里的 IdentityFile/User/Port 先用，认证确有需要才弹密码，连上后用原生 QuickPick 逐级选目录或输入路径 |
| 标题栏/状态栏的远端感 | 有 | 🟡 待做：可把远端主机名加进窗口标题（VSCode 原生 `remoteName` 对我们为空） |

### 2.12 AI 补全与聊天（GitHub Copilot）

| 项 | Remote-SSH | 我们 |
|---|---|---|
| 扩展来源 | 官方 Marketplace 一键装 | ✅ 官方 VSIX 手动装（`ide/tools/install-vsix.sh`），仓库不提交专有扩展；Open VSX 上没有这两个包 |
| 登录 | 内置 GitHub 认证 | ✅ 走 CodeOSS 自带 `vscode.github-authentication`；需要网络能到 `github.com`（中国大陆建议 `RCE_PROXY=http://127.0.0.1:7890`） |
| 行内补全 | 远端/本地扩展宿主 | ✅ 本地扩宿主跑，补全请求直达 GitHub API；源码仍然只在 `sshfs://` 虚拟工作区里，编辑器读写照旧走 SFTP |
| Chat | 同上 | ✅ 登录后可用 |
| proposed API | 微软产品内置白名单 | ✅ `run-app.sh` 用官方 `--enable-proposed-api GitHub.copilot --enable-proposed-api GitHub.copilot-chat` 放行（copilot-chat 0.48.1 声明了 63 个） |
| 中文品牌名 | 不涉及 | ⚠️ 坑：`vscode.env.appName` 会进 `User-Agent`，非 Latin-1 会让请求在本地构造阶段就抛 `Cannot convert argument to a ByteString`。已由 `apply-branding.mjs`「十一」把交给扩展的 `appName` / 市场 UA 固定为 ASCII，界面显示名仍是中文 |
| Copilot CLI / agent 会话 | 远端跑 | 🔴 暂不可用：打包产物缺 `node-pty` 原生模块（不影响行内补全与聊天） |

## 3. 品牌与 CodeOSS 集成补丁（都是实测踩出来的）

这几条和 SSH 无关，但**不做就起不来**，都集中在 `ide/tools/apply-branding.mjs`（幂等，升级上游后重跑）：

| 症状 | 根因 | 处置 |
|---|---|---|
| 窗口能拖动但内容区点不动，日志 `workbench.contrib.startupPageRunner ... reading default` | 不内置上游 Copilot 源码时，onboarding/defaultAccount 仍会访问缺失的 provider；透明 modal 覆盖在工作台上吃掉点击 | `apply-branding.mjs` 给 onboarding / defaultAccount 加安全分支；`run-app.sh` 使用 `--skip-welcome`。这不影响通过 VSIX 安装官方外部 Copilot |
| 账号服务起不来 | `accounts/browser/defaultAccount.ts#toDefaultAccountConfig()` 在缺省聊天代理时会解引用失败 | 脚本加空配置分支；保留上游现有 proposed API 白名单，外部 Copilot 仍可安装 |
| `npm run compile` 报 `ERR_INVALID_TYPESCRIPT_SYNTAX` | 早期把 `prepareCopilotRipgrepShimTask(...)` 替换成 `void platform;`，而它处在**数组字面量**里 → 语法错误 | 脚本改成"整行替换为注释"（并能修复已经被写坏的文件） |
| `npm run compile` 退出 254 | `package.json` 的 `compile`/`watch` 里挂着 `compile-copilot`/`watch-copilot`，而 `extensions/copilot` 已被删 | 脚本摘掉这两个任务 |
| 开发版起不来：`.build/electron/remote-code-editor: 没有那个文件或目录` | `scripts/code.sh` 按 `product.applicationName` 找 Electron 二进制，改名后和已下好的 `code-oss` 对不上 | 脚本补一条相对软链（省一次 220MB 下载） |
| 扩展报 `a provider for the scheme 'sshfs' is already registered` | 早期产物目录 `extensions/sshfs` 和现在的 `extensions/rce-remote` 抢同一个 scheme | `build-extension.mjs` 每次构建顺手清掉旧目录 |
| 源码开发版菜单/欢迎页/设置全英文 | `nls.ts` 和 `bootstrap-esm.ts` 都有 `VSCODE_DEV` 硬回退；同时开发版 `out` 缺少 NLS 索引表 | `apply-branding.mjs`「六/七」幂等补丁 + `ensure-language-pack.mjs` 安装同版本官方包并预置 `languagepacks.json` |
| `npm run gulp vscode-linux-x64` 在 `package-linux-x64` 阶段 `TypeError: fetch failed` | `@vscode/gulp-electron` 每次打包都重新访问 GitHub 取 Electron，即使本机已有同 SHA256 缓存 | `build/lib/electron.ts` 支持 `RCE_ELECTRON_ARCHIVE` 本地压缩包 resolver；校验仍走 `build/checksums/electron.txt` |

## 4. 当前状态与复现

**一句话现状（2026-10-15）**：`ide/` 主线已能日常用——文件系统 / 终端 / 搜索 / SCM / 远端工作区配置 / 语言服务 /
任务（含依赖、Problems、后台任务）全部接通，端到端 **17/17**，目标机**无任何常驻服务**；语言服务已扩到引用、重命名、签名帮助、代码操作、格式化和折叠，影子缓存已有 LRU/TTL/容量管理。上游补丁由 `ide/tools/apply-branding.mjs` 幂等维护；全局进度快照见 `docs/devlog.md` 末尾。

**已跑通（2026-10-12）：**

```bash
# 端到端：CodeOSS 开发版打开 sshfs:// 远端工作区，跑文件/终端/搜索/SCM，写报告 + 截图
bash ide/tools/run-e2e.sh
```

最近一次结果 **17/17 通过**（报告落在 `ide/tools/tmp/e2e-report.json`，截图 `ide/tools/shots/e2e-*.png`）：

| 步骤 | 结果 |
|---|---|
| 打开远端 `README.md` | ✅ 4 行，语言 = markdown |
| 远端集成终端（SSH PTY） | ✅ 已发送 `ls`/`git` 命令，终端里真的是远端 bash |
| 终端默认 profile | ✅ `defaultProfile.linux=织码 WeaveCode`，新建终端名 = `织码 WeaveCode` |
| 远端全文搜索（grep） | ✅ 命中远端 `README.md:3` |
| 远端文件搜索（proposed API） | ✅ `findFiles("**/main.c") → /ws/src/main.c` |
| 远端 `.vscode/settings.json` 生效 | ✅ `editor.tabSize=7`（Remote-SSH 对等的关键一条：工作区配置真的从远端读） |
| SCM 状态（远端 git + 历史图） | ✅ `0 暂存 / 2 更改；3 refs / 5 提交 / 1 个变更文件`，面板显示 `main` 分支 |
| 打开搜索视图 | ✅ |
| 切到源代码管理视图 | ✅ |
| 语言服务：镜像同步 + `compile_commands.json` 重写 | ✅ 按项目懒加载；假靶机 3 个源文件 / `entries=1`，`directory` 已是镜像前缀 |
| 语言服务：跳转/悬浮/符号/补全 | ✅ `定义→…/ws/util.c`；悬浮 1 条；符号 1 个；补全 4 项 |
| 语言服务：诊断 | ✅ 1 条（severity=1，source=rce-fake-clangd） |
| 任务：远端 `tasks.json` 在板子上跑 | ✅ 结束码 0、远端 cwd 落在 `/ws`、远端写出 `task-ran.txt` |
| 任务：`dependsOn` 顺序 | ✅ `prep → dependent`，依赖失败会阻断主任务 |
| 任务：依赖循环 | ✅ 执行前报错，未产生远端副作用 |
| 任务：`problemMatcher` | ✅ `$msCompile` → `sshfs://` Problems 1 条（source=`rce-remote-task`） |
| 任务：`isBackground` | ✅ 启动后保持运行，停止标记写入后 code 0 退出 |

**待做（按优先级）：**

1. **SCM 补全**：stash / pull / fetch（历史图、提交变更、分支切换、提交修改和提交并推送已完成）。
2. 搜索增强：`includes/excludes/wordMatch`、大仓库性能。
3. **镜像同步的增量路径**：目前全量同步会重建 `compile_commands`/sysroot，增量沿用上一次的结果
   （已修：增量不再把全量收好的 `compile_commands.json` 覆盖成 `compile_flags.txt` 兜底）；
   递归 watch 还只能发现增删，改内容发现不了。
4. 连接管理正式化：主机列表（`src/main/config/hosts.ts` 的 `hosts.json`）、`~/.ssh/config` 解析、私钥选择。
5. **打包发布**：Linux amd64 deb 已由 `npm run build:deb` 一键打通（产物在 `ide/dist/`，带 SHA-256
   与包内容清单）；仍需补签名、apt 仓库/升级通道和真实机器安装回归。Windows/macOS 尚未纳入本轮。
   打包链会同步写入 `extensionEnabledApiProposals`，否则 proposed API 在正式版会被拒。
6. 消除启动期 `ENOPRO` 噪声：§5.4 已处置「请求会等会话就绪」这一半（功能不受影响），日志本身还在（provider 注册前的探测），待做。
7. **Copilot CLI / agent 会话**：打包产物缺 `node-pty` 原生模块（`Unable to find node-pty binaries`），
   行内补全与聊天不受影响；要用 agent 会话时再补（需要匹配 Electron ABI 的 prebuild）。
8. 调试 / 端口转发：明确不支持，写进产品说明。

## 5. 踩坑与注意（都是实测踩出来的，改动相关代码前先看）

### 5.1 启动期 `ENOPRO` 噪声（§2.7 那一条）

窗口一打开、我们的 FileSystemProvider 还没注册时，工作台就会去读工作区的
`.vscode/settings.json` / `tasks.json` / `launch.json` / `mcp.json`、`.github/`、`.claude/` 等位置，
于是刷出一片 `CodeExpectedError: ENOPRO: No file system provider found for resource 'sshfs://…'`。
**provider 注册完成后会自愈（功能不受影响）**，纯粹是日志噪声；要彻底消掉得让会话/Provider 在
窗口恢复阶段就能挂起响应，属于待做项。

**顺带一条（与 SSH 无关）**：普通本地窗口里可能还有 `No default agent contributed` 或
`Unable to create workbench contribution 'workbench.contrib.startupPageRunner'`。它们来自“不内置 Copilot
源码”的兼容分支（§3），功能不受影响，也不代表外部 GitHub Copilot VSIX 被禁用。

### 5.2 镜像同步命令：五个真 bug（`src/main/mirror/manager.ts`）

这一块"看着能跑、其实从没跑通"，是接语言服务时被 E2E 逐个逼出来的：

| 症状 | 根因 | 处置 |
|---|---|---|
| 整条命令 `bash` 语法错误 | `buildCompileFindSection` 返回多行、又用 `1>&2` 接在 `fi` 后面 → 拼出 `; ;` 空分段与 `fi 1>&2` | 抽 `sectionHeader()`（真的 `printf '%s\n' … 1>&2`）+ 出口处 `parts.filter()` 去掉空分段 |
| 分段表头内容错乱 | `__FILE__` 分段把标记当命令名，靠 "command not found" 往 stderr 打，带参数时表头不对 | 新增 `buildCompileDumpShellSection()`：`printf … \| while IFS= read -r …; do …; done` |
| tar 解包尾部垃圾 / 同步失败 | `tar --version`、`sys.path` 打到了 **stdout**，混进 tar 的 gzip 流 | 改成 `} 1>&2`、`2>/dev/null 1>&2` |
| 首次同步要猜系统头目录 | sysroot 探测原本是第二条命令 | 新增 `buildProbeAutoSection()`：远端 shell 里就地算候选 + `[ -d ]` 探测，**首次同步仍是 1 条命令**（总纲 §7 预算） |
| 一次增量同步后补全/跳转全废 | 增量命令只带 tar + 清单、没有分段，但代码仍无条件重建 → 把全量收好的 `compile_commands.json` 覆盖成 `compile_flags.txt` 兜底 | `sync(workspace, onProgress, {full})`；只有全量才重建 compile/sysroot（`lastSections` 也只在全量时刷新），增量沿用；回归用例 `tests/unit/mirror.test.ts` T5.8 |

### 5.3 端到端脚本不要和 E2E 预算赛跑

`run-e2e.sh` 原来是"起 CodeOSS → `sleep WAIT` → 截图 → `kill`"。WAIT 默认 110s，而扩展里的 E2E
预算 240s，于是**进程被杀在步骤中间**：被取消的 promise 抛 `Canceled: Canceled`，
报告里出现"语言服务：跳转/悬浮/符号/补全 → Canceled"这种**假阴性**（误导了很久）。
现在改成**轮询等报告文件出现**再截图收尾。以后新增 E2E 步骤要同步注意：单步内部超时之和不能超过脚本上限。

### 5.4 虚拟工作区 + 窗口恢复：补全为什么一直 "Loading…"（已修）

**症状**：`sshfs://` 窗口里**第一次**补全（`Ctrl+空格`，或 `vscode.executeCompletionItemProvider`）会卡住——建议窗口
一直显示 "Loading…"、API 调用 15s 超时；而同一个 dev 版在**本地 `file://` 窗口**里同样的调用秒回。重启窗口有一定概率正常。

**定位过程（可复现）**：

1. 挂扩展宿主的 `--inspect` 端口（dev 版自带）实测：命令 20s 不返回；换成 `.txt` / untitled / 本地文档**同样超时**
   → 与语言、与我们的 provider 都无关。
2. 渲染进程给 `suggest.js` 打行断点：`provideSuggestionItems` 走到 `await snippetCompletions` 就再也不前进，
   上一层是 `SnippetsService.getSnippets()` → `_joinSnippets()` → `await Promise.all(this._pendingWork)`。
3. 在 `_joinSnippets` 断点处抓实例：`_pendingWork.size === 1` 且该项**永不落地**；手动再跑一次
   `_initWorkspaceSnippets()` 却能正常 resolve。
4. 在（gitignore 的）编译产物里给 `_trackPendingWork` 临时加日志：#1（构造项，等 `LifecyclePhase.Restored`）**立刻 resolve**，
   **#2（`updateWorkspaceSnippets` → `_initWorkspaceFolderSnippets`）从不落地**。
5. 我们 provider 侧的文件操作跟踪（`RCE_SPIKE_TRACE=1`）显示：**到达我们这层的每一次调用都有完成/失败**，
   而那条 `exists(<工作区>/.vscode)` **压根没到我们这层** → 卡在渲染进程的文件服务里。
6. 在活着的窗口里直接调 `IFileService.exists('sshfs://…/ws/.vscode')`：**42ms 返回 true**
   → 文件服务本身没问题，出问题的是**窗口恢复阶段那条更早的请求**（那时 provider 还没注册）。

**根因**：工作台在**窗口恢复阶段**（`Restored` 之前）就会去探工作区里的 `.vscode`、`.vscode/*.json`。我们是**虚拟工作区**
（`sshfs://`，没有 remote authority），工作台不会"等远端连接就绪"再恢复，而这批请求在"provider 尚未注册"的窗口里
**不会落地**（既不失败也不重试）。上游 snippet 服务把它记成待完成的工作项并 `await`，于是 `getSnippets()` 永不返回
→ **补全一直 Loading**。Remote-SSH 不受影响，是因为它的窗口带 remote authority：工作台**先解析 authority、远端文件系统就绪后才恢复工作区**。

**处置（三处，缺一不可）**：

| 改动 | 位置 | 作用 |
|---|---|---|
| ① 先注册 provider，再连 SSH | `ide/extensions/sshfs/src/extension.js` `activate()` | 恢复阶段的请求至少在 provider 这层有落点，不会"消失" |
| ② 早期请求**等会话就绪**（上限 15s） | `session.js` 的 `expect()/whenReady()` + `fs-provider.js` 的 `requireSession()` | 不是立刻失败：远端 `.vscode/settings.json` 能生效（一旦判定"读不到"，工作台就不再重读），`exists()` 也能等到真值 |
| ③ 上游 snippet 初始化的存在性探测加上限（5s） | `snippetsService.ts#_existsBounded`，由 `ide/tools/apply-branding.mjs`「五、虚拟工作区补丁」幂等写入 | 万一仍有请求不落地，最多丢一次"工作区 snippet"，不会再拖死补全 |

**验证**：`bash ide/tools/run-e2e.sh` → **12/12 通过**（补全 4 项、远端 `.vscode/settings.json` 生效、诊断 1 条）；
同版本本地 `file://` 窗口对照实验正常。

**还没做**：更彻底的做法是走 remote authority（像 Remote-SSH 那样让工作台**先解析连接再恢复工作区**），
但那会把扩展宿主挪到远端，和"目标机零部署"冲突；当前这三处是零部署约束下的等价处置。启动期仍有若干 `ENOPRO`
日志（§5.1），属噪声。

### 5.5 任务（`tasks.json`）：上游为什么不给我们跑，我们怎么补的

**症状**：远端工程里明明有 `.vscode/tasks.json`，"运行任务"里**一个任务都没有**（`vscode.tasks.fetchTasks()` 返回空数组），
`workbench.action.tasks.runTask` 也是静默无动作。

**根因（上游有意为之，不是 bug）**：`abstractTaskService.registerSupportedExecutions()` 里

```ts
const isVirtual = !!VirtualWorkspaceContext.getValue(this._contextKeyService);
if (shell !== undefined) { shellContext.set(shell && !isVirtual); }
if (process !== undefined) { processContext.set(process && !isVirtual); }
```

**虚拟工作区**里 shell/process 任务一律被置为"不支持"（因为默认执行它们的终端是**本机** shell，远端路径在本机不存在），
于是 `_jsonTasksSupported === false` → `tasks.json` 里的任务被整批丢掉（`set.tasks = []`）。
Remote-SSH 没这个问题，因为它有**远端扩展宿主**，任务系统本身就跑在远端（§2.3）。

**处置：自己提供 `TaskProvider`**（`ide/extensions/sshfs/src/tasks.js`，类型 `rce-remote`）：

| 环节 | 做法 |
|---|---|
| 读任务定义 | `workspace.getConfiguration('tasks', folder.uri).get('tasks')` —— 工作台已经把远端的 `tasks.json` 解析成配置（含注释也吃得下），我们不用自己解析 JSONC |
| 变量 | `${workspaceFolder}` / `${workspaceFolderBasename}` / `${userHome}` 由我们按**远端路径**展开（工作台不会替 `CustomExecution` 的任务展开变量） |
| cwd | 默认远端工作区根；`options.cwd` 给了相对路径就相对工作区根 —— 这是"改到远端跑"最关键的一条（内置任务终端拿不到 cwd） |
| 执行 | `SSHConnection.execStream(`cd <远端 cwd> && <命令>`)`，stdout/stderr 实时流进 `Pseudoterminal`，结束码回给任务系统 |
| 分组/展示 | `group`（build/test/clean）与 `presentationOptions`（echo/reveal/共享面板） |
| 依赖 | `dependsOn` / `dependsOrder` 在扩展里执行；Extension API 的 Task DTO 不携带上游 `configurationProperties.dependsOn`，直接放 definition 不生效。执行前做缺失/循环校验 |
| Problems | `problemMatcher` 自己解析并写 `DiagnosticCollection`，因为上游最终建的是 `file://` marker；当前支持 `$msCompile`、`$gcc`、`$clang`、`$tsc`/`$tsc-watch` 和常用单行内联 pattern |
| 后台 | `isBackground: true` 交给任务系统维持长任务，PTY 退出时回结束码 |

实测（E2E 第 12 步）：假靶机的 `rce-probe` 任务在**板子上**执行，结束码 0，任务里的 `pwd` 落在远端工作区 `/ws`，
远端写出的 `task-ran.txt` 能从 `sshfs://` 读回来。

**一个必踩的坑**：任务类型必须在 `package.json` 的 `contributes.taskDefinitions` 里注册（我们注册了
`rce-remote`，required 字段 `label`）。否则 `TaskDefinition.createTaskIdentifier()` 走
"类型没注册 → 用**整个 definition** 生成 identifier" 的兜底分支，任务系统按
`workbench.action.tasks.runTask { type, label }` 解析时对不上 → **静默退化成打开任务列表**（headless 下看起来就是"没反应"）。
注册之后按 label 触发与"运行任务"列表选择都正常（E2E 里两条路都验了）。

**还没做**：往任务里交互输入（要交互就用集成终端）、多行内联 problem pattern；
也没有跟随 `tasks.json` 变更的热更新（重开任务列表即可）。

> 顺带记一条设计取舍：我们先试过"打个上游补丁，让虚拟工作区里放行 shell 任务"（把 `isVirtual` 改成认一个扩展上下文键），
> 结果**不可行**——那样任务会落到本机 shell（cwd 是本地路径），或者在远端 PTY 里跑但 **cwd 是错**的，
> 对 `make` 这类依赖工作目录的任务是坏的。所以最终走"自己的 provider + 自己控制 cwd"，上游补丁已还原。

### 5.6 文件监听事件：字段名写错，整个 watch 通道等于没接上

**症状**：上游日志刷 `TypeError: Cannot read properties of undefined (reading 'scheme')`，栈顶在
`extHostFileSystem.js`（`value.uri.scheme`），触发点是我们扩展的 `onDidChangeFile.fire(...)`。
后果不只是报错：**所有 watch 消费者都拿不到变更**（编辑器"文件已在磁盘上修改"、工作区配置重载、SCM 自动刷新都失灵）。

**根因**：我们构造的事件对象把字段写成了 `resource`，而 `vscode.FileChangeEvent` 规定的是 **`uri`**
（`ide/extensions/sshfs/src/fs-provider.js` 的 `diffToEvents()`）。我们自己的代码从没读过这个字段，所以一直没暴露；
`run-app.sh` 冒烟（真窗口跑一会儿、有远端变更）才把它照出来。

**处置**：`resource` → `uri`（三处）。验证：同一条冒烟路径 + E2E 日志里该报错从 3 条降到 **0 条**。
