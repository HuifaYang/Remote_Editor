---

## 2026-09-24（晚）· UI 现代化重构：组件基座 + 主机/欢迎页/设置/菜单/空态

### 修复与重构

- **设计 token**：补齐按钮、输入、焦点、禁用、浮层、阴影、状态色、开关等深/浅双主题变量；
  `components.css` 不再出现硬编码颜色，阴影也全部走 token。
- **UI 基座**：新增统一按钮、图标按钮、输入框、选择框、开关、表单字段、加载态、空态和上下文菜单；
  通用对话框补齐 overlay、焦点陷阱、Esc、初始焦点与 Tab 循环。
- **图标体系**：新增 terminal/plug/edit/chevron/arrow/discard/key/info/warning/folder-opened/list-tree 等 SVG；
  主机连接入口从含义不清的 `remote` 图标改为 `plug`，空态大图标修复为可见。
- **远程主机**：改为 SSH 分组树 + 已连接横幅 + 断开按钮 + 历史工作目录 + 底部固定操作区；
  新增主机从连续 prompt 改为完整表单（显示名/地址/端口/用户/认证方式/私钥/默认目录/保存并连接）。
- **欢迎页**：改为 VS Code 风格左对齐起始页，包含连接状态、主/次按钮、最近主机和快捷键卡片。
- **设置**：改为分组卡片 + 统一输入/开关 + 帮助文本 + sticky 按钮；`lspTransport=disabled` 现在能落盘并在 LSP 层生效。
- **主菜单**：从超长单列列表改为“左侧分组 + 右侧命令”双层菜单；快捷键右对齐，支持方向键、Home/End、Esc。
- **空态与反馈**：Explorer/搜索/SCM/终端/主机页统一补未连接、空数据、加载、失败和重试入口；终端未连接时不再创建 xterm。
- **上下文菜单**：资源管理器、标签页、SCM 统一接入可键盘导航、视口防溢出的菜单组件。
- **状态栏 / 标签页 / 终端**：状态栏可点击项改为按钮语义；标签页补图标、固定 `+`、拖拽排序；终端工具条改统一图标并在无终端时禁用“终止”。

### 验证

- `npm run lint` 0 告警
- `npm run typecheck` 0 错误
- `npm test` 170 passed / 5 skipped（33 个测试文件）
- 集成测试沙箱外 5/5 通过
- 打包版 CDP 实测并截图：欢迎页、双层菜单、主机页、主机表单、搜索、SCM、设置、终端空态、浅色主题、960×600 小窗口均通过

---

## 2026-09-24 · 修复主界面布局与四个关键交互问题

### 修复

- 启动布局改为资源管理器侧边栏默认展开，活动栏点击逻辑保持“点当前视图才收起”；
- 欢迎页补齐规格 U6 的 `连接主机…`、`打开远程文件夹…` 和三行快捷键，并接入连接状态；
- 资源管理器空态补齐 `打开远程文件夹…`，未连接时禁用并提示 `请先连接主机`；
- 标题栏菜单按钮恢复为 32×32；菜单限宽、限高、可滚动，按窗口高度自适应；
- 搜索视图改为“查询输入行 + 选项行”，修复窄侧栏横向溢出与按钮拥挤；
- 修复远程主机页切换后空白：`HostsView` 先同步渲染空态/操作，再异步刷新主机列表；
- 视图改用独立子容器，避免异步旧视图覆盖当前侧边栏。

### 验证

- `npm run lint` 0 告警
- `npm run typecheck` 0 错误
- `npm test` 161 passed / 5 skipped（27 个测试文件；沙箱内跳过集成用例）
- 集成测试在沙箱外 5/5 通过
- 打包版 CDP 实测：默认侧栏、菜单滚动、搜索无横向溢出、主机页按钮均正常
- 已重新生成 AppImage 与 deb（2026-09-24 11:57 / 11:58）

---

## 2026-09-23（晚）· 修复打包版“界面显示但无法点击”

### 根因

- `activity-bar.ts` 点击按钮时先写了 `uiStore.set({ sidebarView: next })`，再回调 `onViewChange`。
- 主进程 `switchView` 里判断 `uiStore.get().sidebarView === view`，把它误判成“点击当前视图”，于是立刻收起侧边栏。
- 用户点击任何活动栏按钮后侧边栏马上被收起，表现为“只能看，什么都点不了”。

### 修复

- 移除 `activity-bar.ts` 里的重复 `uiStore.set`，只把 `next` 交给主逻辑；主逻辑负责更新状态。
- 新增 `tests/ui/activity-bar.test.ts`：首次点击打开视图、再次点击收起，防止回归。
- 用 CDP 实测打包版：资源管理器/搜索/源代码管理/远程主机/设置都能点击，标题栏菜单可展开。

### 验证

- `npm run lint` 0 告警
- `npm run typecheck` 0 错误
- `npm test` 158 passed / 5 skipped
- 集成测试 5/5 通过

---

## 2026-09-23（续）· 规格对账后的第一轮整改

### 修正内容

- 主窗口最小尺寸改为 960×600；窗口位置/尺寸/最大化状态落盘与恢复；
- 标题栏菜单升级为 U10 完整结构（文件/编辑/查看/终端/帮助）；
- 快捷键补齐并新增快捷键触发测试；
- `components.css` 移除硬编码颜色，`LANE_COLORS` 改为 tokens 变量；
- 终端 IPC 数据按 ≥16ms / 4KB 合帧发送；
- 保存链路去掉多余 stat，回到 2 次 SFTP 预算；
- 打开文件后写本地镜像副本，补齐 D3.2；
- LSP 接入设置项 `cppServer` / `pythonServer`；
- 设置项 `useSpaces` / `autoSave` 生效；
- SCM：默认提交改为只提交已暂存，新增“提交所有更改”、无暂存确认框、组头刷新、提交图两行 + 引用徽章 + 相对时间；
- Git API：`remotes` 返回 fetch/push 地址，新增 remove/set-url/tag/create/delete/branch/merge/clone branch 支持与统一名称校验；
- Explorer Tooltip/属性/加载失败重试补齐；
- IPC 复用 hosts/settings 实例，避免重复读盘。

### 验证

- `npm run lint` 0 告警
- `npm run typecheck` 0 错误
- `npm test` 152 passed / 5 skipped（23 个文件）
- 集成测试 5/5 通过

### 第二轮整改

- Git API：stash 拆成 list/save/pop/drop，`remotes` 返回 fetch/push 地址，标签/分支管理、克隆 branch 支持、名称校验补齐；
- 仓库管理对话框升级为 G4.3 四分组（宽 520、高 560，点开分组才拉数据）；
- 搜索视图补齐清除/刷新按钮，新增分组/点击跳行测试；
- 侧边栏与底部面板可拖分隔条接入（200~480px / 80~70%）；
- README / shortcuts 完成度声明按实际进度校正；
- 新增镜像同步命令预算测试。

### 验证（第二轮）

- `npm run lint` 0 告警
- `npm run typecheck` 0 错误
- `npm test` 156 passed / 5 skipped（24 个文件）
- 集成测试 5/5 通过

### 仍未完成

- 首次镜像同步的 1 条命令预算仍未达标（详见 §5.3.1）。

# 开发日志（V2）

按日期倒序记录 V2 的工作内容、验证结果与遗留事项。
规格见同目录 `spec-v2*.md`。

---

## 2026-09-23（夜）· M4 收尾 + M5 + M6：全部功能实现并逐项验证

### 1. M5 Git 与搜索

- `shared/git-status.ts`：新增 `TreeStatus.markStaged()`（暂存/取消暂存**本地更新快照**，不重扫仓库）与
  `splitStatus()`（一份快照拆成「暂存的更改 / 更改」，未跟踪与 `MM` 双态都覆盖）。
- `session/git.ts`：新增 `stage / stageAll / unstage / unstageAll / discard / clean / stash / tags /
  remotes / addRemote / fetch / clone / init`，每条都是 1 条命令、路径一律 `shellQuote`；
  `unstageAll` 在首个提交前 `git restore --staged` 失败时退化为 `git reset -q`。
- IPC/Preload 补齐 `api:git.*`（fileDiff/commit/branches/switchBranch/logGraph/stage/stageAll/discard/
  stash/tags/remotes/addRemote/fetch/clone/init）。
- 渲染层：`views/scm-view.ts`（提交区 + 绿色拆分按钮 + 暂存/更改分组 + 逐文件 ＋/−、丢弃二次确认 +
  分支菜单 + 懒加载提交图 + 仓库管理对话框）、`views/search-view.ts`（Aa / .* 开关、按文件分组、
  命中片段高亮、点击跳行）、编辑器 gutter 行级差异（干净文件 0 条 git，已修改 1 条 diff）。

### 2. M6 终端 / 设置 / 对话框 / 打包

- `session/terminal.ts`（SSH shell + PTY）+ `api:terminal.*` + `event:terminal-data|closed`；
  终端里敲过命令即把镜像标记为可能过期（`event:progress` → 状态栏提示）。
- `views/terminal-panel.ts`：xterm.js 多标签、fit、字号随编辑器字号；**踩坑**：xterm 的 UMD 会抢
  AMD `define`，必须排在 Monaco loader 之前，否则报 “Can only have one anonymous define call”。
- `views/dialogs/settings-dialog.ts` + `api:settings.get/update`：外观 / 编辑器 / 文件 / SSH / 语言服务
  五组设置，确定后即时应用（主题、字号、缩放、缩进、换行、行号、当前行、自动保存延迟）。
- 打包：`electron-builder.yml` 补 `maintainer`（deb 必需），AppImage + deb 现在都能出；
  内置 clangd 经 `extraResources` 进入包内。

### 3. 验证（逐项，全部实跑）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 静态检查 | `npm run lint` / `npm run typecheck` | 0 告警 / 0 错误 |
| 单元 + UI 测试 | `npm test` | **150 passed / 5 skipped**（21 个文件） |
| 集成（沙箱外实跑） | `npx vitest run tests/integration` | **5/5 passed** —— SSH 连接→列目录→读→原子写、Git、搜索、镜像 tar 解包 + manifest 差集、假 LSP 全链路 |
| 真实语言服务 | `node scripts/verify-lsp.mjs --verbose` | **6/6 passed** —— clangd 18.1.3 对真实 C++ 工程给出补全（moveForward/speed）、F12 跳到 `robot.hpp` 第 4 行、诊断 `Expected ';' after return statement`、诊断→Monaco marker、Hover |
| 离屏 UI | `npx electron scripts/shots.mjs` | 欢迎页 / 设置对话框 / 终端面板 / 搜索面板 / 资源管理器 五张截图（`/tmp/rce-shots/`），`SMOKE: monaco ready`，无渲染进程报错 |
| 打包 | `npm run build` | `release/RemoteCodeEditor-2.0.0-alpha.0.AppImage`（286 MB）、`release/remote-code-editor_2.0.0-alpha.0_amd64.deb`（228 MB）；解包检查包内 `resources/clangd/clangd` 可执行且版本正确 |
| 启动 | AppImage 离屏运行 20s | 常驻无崩溃（超时结束） |

**集成测试抓到的真 bug**：`SSHConnection.execStream().wait()` 有竞态 —— 命令很快结束时 `close`
先于 `wait()` 发生，导致 Promise 永远不 resolve，镜像同步在真实环境会挂死。修法：把退出结果缓存在
`exitResult`，`wait()` 若已有结果直接返回。已补回归用例 `tests/unit/exec-stream.test.ts`。

另外修掉的两个渲染层真问题：preload 事件白名单漏 `window-state`（界面起不来）、
欢迎页被 Monaco 容器盖住（空态不显示）。

### 4. 仍未验证 / 已知限制

- **真机（RK3566 等）没连过**：本轮所有远端行为都用进程内 ssh2 假服务端 + 真实临时文件系统验证，
  真实网络时延（1 秒 RTT）下的体感与超时策略需要在真板上走一遍。
- 「板子上」语言服务模式（`settings.lspTransport = remote`）只做了传输层单测，没有真板验证。
- 终端、提交图、分支切换在无真实仓库的环境下只验证了渲染与命令拼装 + 集成测试里的基础回显。

---

## 2026-09-23（晚）· M4 后半：DOM 视图接上

### 1. 视图

| 文件 | 内容 |
| --- | --- |
| `views/explorer.ts` | 单列树：懒加载（`TreeCache`）、展开态记忆、目录预取 ≤3、变更色 + 行右端字母徽标、Tooltip（路径/类型/大小/时间）、右键菜单（新建文件/文件夹、重命名、删除并二次确认、刷新、复制路径）、顶栏新建/刷新按钮、空态 |
| `views/editor-area.ts` | 标签条（脏点 `●`/`✕`、中键关闭、右键：关闭/关闭其它/关闭右侧/全部保存）+ 每文件一个 Monaco model（关闭时 `dispose()`）、光标行列上报、输入后 1.5s 自动保存（延迟待 M6 设置接管）、保存前**比对远端指纹**，变了弹「重新加载远程 / 覆盖远程 / 取消」冲突框 |
| `views/hosts-view.ts` | 主机行（连接 ⚡ / 编辑 / 删除）+ 历史工作目录（点击即连并打开）+ `+ 新增` + 从 `~/.ssh/config` 导入；**底部凭据行**（密码 / 私钥口令，回车即连，不弹居中对话框），由 `event:auth-required` 驱动 |
| `app/dialog.ts` | 无边框对话框（提示 / 确认 / 单行输入 / 多选一），全部自绘，禁止原生 `alert/confirm` |
| `app/shortcuts.ts` | 快捷键表 + `matchShortcut` 纯函数 + `installShortcuts`（keydown，输入框里的 Tab 不拦） |
| `app/status-bar.ts` | 按 U1 重写：连接 / 文件名 / Git / 保存状态 / 编码 / 语言 / 行列 + 「镜像可能过期，按 F5 同步」弱化提示，空项隐藏 |
| `app/main.ts` | 外壳组装：活动栏切视图、侧栏三视图、编辑区（欢迎页 → 标签页）、状态栏、快捷键、会话事件（连接状态 / 镜像进度 / 诊断）、`openFolder`（1 次 listDir + 2 次 git）与 `openFile`（1 次 SFTP 读 → 模型 → LSP track） |
| `styles/components.css` | 上列视图的 QSS（颜色全部取自 `tokens.css`，无硬编码色） |

已接通的链路：**连接（凭据行）→ 打开远程文件夹（文件树）→ 打开文件（标签页 + Monaco）→ 改（脏点 + 自动保存）→ 存（远端原子写 + 镜像副本 + 快照本地更新）**；补全/跳转/悬浮/诊断经 M3 的 `LspBridge` 挂在每个 model 上。

### 2. 验证

```
npm run lint        # 0 告警
npm run typecheck   # 0 错误
npm test            # 134 passed, 5 skipped（18 个文件）
```

### 3. 遗留

- 快捷键只接了文件/编辑/视图相关的一组；`Ctrl+F/H/G`、`Ctrl+Space` 还是空实现（Monaco 自带动作待 M5/M6 挂上），
  `shortcutTable` 的单测还没写。
- 编辑区暂未做标签拖动排序的鼠标实现（`TabsModel.move` 已就绪）、树行未做 600ms 延迟 Tooltip、状态栏的连接/分支点击菜单待 M5。
- 自动保存延迟目前写死 1.5s，等 M6 设置对话框接 `settings.autoSaveDelayMs`。
- **真机手测仍未跑**（沙箱起不了 Electron）：M3 的补全弹窗 / F12 / 波浪线要在带显示的环境里过一遍。


### 4. 补记（同日稍晚，按用户要求核对目录体系）

用户要求「仔细看目录体系，不要乱搞」，于是对照总纲 §3 的树逐项核对，做了 3 处归位/补齐：

- `renderer/app/activity-bar.ts` → **`renderer/views/activity-bar.ts`**，`renderer/app/status-bar.ts` → **`renderer/views/status-bar.ts`**（§3 把这两个视图列在 `views/` 下）
- `renderer/app/dialog.ts` → **`renderer/views/dialogs/index.ts`**（§3 规定无边框对话框放 `views/dialogs/`）
- 补 **`docs/shortcuts.md`**（§3 要求 docs 下有对外快捷键表）

留在原地、但**不在 §3 树里**的新增文件（都有明确理由，未再挪动）：

| 文件 | 为什么必须新增 |
| --- | --- |
| `src/main/config/{settings,hosts,ssh-config}.ts` | D1 要求 `settings.json` / `hosts.json` 落盘 + §8.4/§8.5 的 `~/.ssh` 集成，§3 未规定归属目录 |
| `src/main/session/session-manager.ts` | 一次连接的能力集合与生命周期，§3 只列了各能力模块本身 |
| `src/main/mirror/tar.ts` | 纯 Node tar.gz 解包（沙箱里 spawn tar 被拦，且不想依赖工作机 tar） |
| `src/shared/lsp-map.ts` | LSP → Monaco 映射需要主/渲染共用且可单测 |
| `src/renderer/app/{tree-cache,tabs}.ts` | 目录缓存与标签页模型，纯逻辑，便于 `tests/ui` 覆盖 |

另外修掉两个真 bug：

1. **preload 事件白名单漏了 `window-state`** → 渲染进程启动即抛「未授权的事件通道」，整个外壳没渲染出来（截图为空）。
2. **欢迎页被 Monaco 容器盖住**：现在无标签时隐藏编辑器容器、显示欢迎页，开标签反向切换。

顺手做了「直接用」的入口：`scripts/start.sh`（编译 + 拷资源 + 启动，容器里自动退让到 xvfb）。
离屏截图验证（xvfb + `ELECTRON_DISABLE_SANDBOX=1`）已通过：欢迎页 / 活动栏 / 状态栏正常，`SMOKE: monaco ready`。

---

## 2026-09-23（下午）· M4 前半：会话层 + 配置 + 渲染层纯模型

### 1. 主进程

| 文件 | 内容 |
| --- | --- |
| `src/main/config/settings.ts` | D1.2 settings.json：**逐字段范围校验**（越界/类型错回默认）、坏 JSON 不崩、`SettingsStore.get/update` |
| `src/main/config/hosts.ts` | D1.1 hosts.json：`HostRecord.workspaces`（历史目录去重、最新在前、上限 10）、`assertNoCredentials` 递归断言（§8.3）、坏文件容错、`touch()` 记使用 |
| `src/main/config/ssh-config.ts` | §8.4/§8.5：`listLocalKeys`（认私钥文件头、跳过 `*.pub`/`known_hosts`/子目录/>1MB、`.pub` 注释优先、`bcrypt|ENCRYPTED` 判加密）+ `importSshConfig`（Include ≤4 层就地展开、去重、忽略通配 Host 与 Match 块） |
| `src/main/session/session-manager.ts` | 规格未覆盖处新增：一次连接的能力集合（SSHConnection / RemoteFs / GitRemote / SearchRemote / MirrorManager / LspManager）+ `connect / disconnect / openFolder / syncMirror / ensureLsp / readFile / saveFile / create / rename / remove / treeStatus`；认证失败按错误码回 `auth-required`（密码 / 口令两种） |
| `src/main/ipc.ts` · `src/preload/index.ts` · `src/renderer/api.d.ts` | **通道名按分册 3 D2 修正**：请求 `api:host.*` / `api:fs.*` / `api:mirror.sync` / `api:git.*` / `api:search.find` / `api:lsp.*`，事件 `event:connection-state|auth-required|mirror-progress|mirror-done|diagnostics`；M3 期间的 `mirror:*`/`lsp:*`/`diagnostics` 旧名已全部替换（窗口控制仍在 `window:*`，D2 未定义） |

性能与语义要点：

- **打开工作目录 = 2 条 git（rev-parse + status）+ 1 次 listDir**；镜像同步**不**放在开目录里，
  留到 F5 或首次补全（`ensureLsp` 发现镜像工作目录不匹配时自动补一次同步）。
- **保存 = 2 次 SFTP + 0 条 git**：写完远端后同步写镜像本地副本（`applyLocalSave`），
  再对 Git 快照做 `markSaved`（本地更新，不重扫仓库）。
- 断开 / 退出统一 `stopAll()` + `conn.close()`，避免语言服务僵尸进程。

### 2. 渲染层（纯模型先行）

| 文件 | 内容 |
| --- | --- |
| `src/renderer/app/tree-cache.ts` | 目录缓存：TTL 120s、上限 200 条、**同路径在飞行中只发一次**（Promise 去重）、后台预取 ≤3 个子目录、`invalidate` / `invalidateTree`（新建 / 删除 / 重命名 / 切换目录 / F5 用） |
| `src/renderer/app/tabs.ts` | 标签页模型：打开/激活/关闭、关闭其它/右侧、脏标记、指纹更新、拖动排序 |
| `tests/ui/tree-cache.test.ts` · `tests/ui/tabs.test.ts` | 9 个用例：首次展开 1 次请求、TTL 边界（119999 命中 / 120001 过期）、并发去重、预取上限 3、缓存上限 200、失效重取；标签页增删/脏点/关闭策略/排序 |

### 3. 验证

```
npm run lint        # 0 告警
npm run typecheck   # 0 错误
npm test            # 134 passed, 5 skipped（18 个文件）
```

### 4. 遗留（M4 未完成的部分）

- **DOM 视图还没写**：`views/explorer.ts`（树 + 徽标 + Tooltip + 右键全套）、`views/editor-area.ts`
  （标签条 + Monaco model 生命周期 + 自动保存/冲突提示）、`views/hosts-view.ts`（主机树 + 底部凭据行）、
  无边框对话框、快捷键表——纯模型与 IPC 已就绪，接上即用。
- 因此 M3 的真机手测（补全弹窗 / F12 / 波浪线）仍等这层视图接完再一起走。

---

## 2026-09-23 · V1 删除 → V2 升为仓库根 → M3 环境镜像 + LSP 主体完成

### 0. 仓库整理

- V1（Python + PySide6）整体删除，**包括未提交的第四轮反馈修复**；历史仍在 git 里，
  删除前快照留了 `/tmp/remote-editor-v1-backup-20260923.tar.gz`（含未提交改动，/tmp 可能被清）。
- V2 从 `remote-code-editor-v2/` 提到**仓库根**（用户要求「目录不要套壳」），规格与开发日志
  随之落到 `docs/spec-v2*.md` / `docs/devlog.md`；`AGENTS.md` 重写为 V2 版（V1 的 pytest / PySide6
  约束作废）；`.gitignore` 合并为 V2 版。
- 整理完先跑了一遍基线：`npm run lint` / `npm run typecheck` / `npm test`（77 passed, 3 skipped）全绿。

### 1. 环境镜像（总纲 §5.3；分册 1 A8 / A8b / A9）

| 文件 | 内容 |
| --- | --- |
| `src/main/mirror/manifest.ts` | manifest schema + `parseFindListing`（`%p %s %T@` 从右切，文件名含空格也对）/ `diffManifest`（changed / removed）/ 容错 `parseManifest` / 路径换算 `mirrorRelativePath`（工作目录内按相对尾巴，sysroot 映射到 `_sysroot/<去根斜杠>`） |
| `src/main/mirror/manager.ts` | `MirrorManager`：tar 能力探测（GNU / busybox 都认，缺失抛 `unsupported`）、全量同步、**F5 时间戳增量**（`date +%s` 与文件清单同一条命令走 stderr，tar 走 stdout，往返仍是 1 条）、manifest 差集落盘与 `removed` 本地删除、全量解包先 `.staging` 再原子替换（`_sysroot` / `_pyenv` / `compile_commands.json` 跨替换保留）、`localPathOf` / `remotePathOf`、`applyLocalSave` 保存后同步镜像 |
| `src/main/mirror/tar.ts` | **纯 Node 的 tar.gz 解包**（ustar + GNU LongLink + PAX，支持目录/符号链接/硬链接，带 tar-slip 防护） |
| `src/main/lsp/clangd-config.ts` | `compile_commands.json` 收集 + 合并 + 重写（A9）：`directory`/`file` 前缀重写、`-I`/`-isystem`/`-iquote` **三分规则**（镜像源码 / `_sysroot` / 丢弃）、`args` 与 `command` 两种形态都处理、找不到时写 `compile_flags.txt` 兜底 |
| `src/main/session/connection.ts` | 新增 `execStream()`（stdout 交给 `pipeline` 边收边写，stderr 累积成清单文本） |

决策 / 规格未覆盖处：

- **解包不用本机 tar 命令**：沙箱里 spawn `tar` 直接被拦，而且 Windows 上本来就得指望 bsdtar；
  改为纯 Node 实现（不新增依赖），失败信息仍归 `mirror`。
- A9 第三条「两者都不属于 → 整条删除」只有在 sysroot 集合明确后才成立：实现里先用**一条 exec**
  探测候选头文件目录是否存在（`[ -d ... ]`），只有**远端真实存在**的目录进 sysroot 集合，
  不存在的（工作机 ROS / 私有工具链路径）才走丢弃分支并记日志。
- sysroot 目录集合变化时自动退化为全量（新目录里的老文件用增量拉不到）；sysroot / Python 环境
  失败只记 warn，不阻断源码镜像。

### 2. 语言服务（总纲 §5.5；分册 1 T8 / T9b）

| 文件 | 内容 |
| --- | --- |
| `src/main/lsp/client.ts` | 自研 JSON-RPC 分帧（半包 / 粘包 / `Content-Length` 按字节）、`initialize → initialized` 握手、`completion`/`definition`/`hover`/`didOpen`/`didChange`(全文)/`didSave`/`didClose`、服务端主动请求（`workspace/configuration` → `[]`）应答、请求超时、退出时 reject 挂起请求 |
| `src/shared/lsp-map.ts` | LSP → Monaco 纯映射：CompletionItemKind 表、Snippet→InsertAsSnippet、Location→**扁平 IRange**、Severity→MarkerSeverity |
| `src/main/lsp/manager.ts` | `LspManager`：惰性启动 / `stopAll`（SIGTERM → 2 秒 SIGKILL）/ 诊断订阅；**两种传输** = 本机 `spawn`（内置 clangd → PATH → 降级）与板子上 `execStream`（唯一例外）；clangd 固定参数 + `--target=<三方组>`（取不到回退 `aarch64-linux-gnu` 并记 warn）；pylsp 走 `PYTHONPATH=<镜像>/_pyenv`；参数/根变化时自动重启 |
| `src/main/ipc.ts` | `setActiveSession()` + `mirror:sync`（进度经 `mirror-progress` 回渲染进程）、`lsp:ensure/completion/definition/hover` 与 `lsp:open/changed/save/close`；诊断转 `diagnostics` 事件 |
| `src/preload/index.ts` · `src/renderer/api.d.ts` | `window.api.mirror.sync()` / `window.api.lsp.*`（**规格 §5.8 只列了 4 个 lsp 方法，open/save/close/ensure 是按 §5.5.2 客户端接口补的**） |
| `src/renderer/editor/lsp-bridge.ts` | Monaco 补全 / 跳转 / 悬浮 provider + 诊断 `setModelMarkers(owner="lsp")`；语言服务不可用时静默降级为词补全；关标签清标记 + `didClose` |

### 3. 测试与验证

```
npm run lint        # 0 告警
npm run typecheck   # 0 错误
npm test            # 116 passed, 5 skipped（15 个文件）
```

新增用例：`tests/unit/mirror.test.ts`（25）、`tests/unit/lsp-client.test.ts`（10）、
`tests/unit/lsp-transports.test.ts`（5）、`tests/integration/mirror-sync.test.ts`、
`tests/integration/lsp-roundtrip.test.ts`、`tests/fixtures/tar-writer.ts`、
`tests/fixtures/fake-lsp.mjs`。

沙箱跳过说明：镜像 / SSH 集成用例需要监听 127.0.0.1（EPERM），LSP 集成用例需要 spawn node 子进程
（同样被拦），因此 5 个 skip 都是环境限制；**Electron 冒烟在这个沙箱里起不来**
（`sandbox_host_linux.cc: FATAL ... shutdown: 不允许的操作`，`ELECTRON_DISABLE_SANDBOX=1` + `xvfb-run` 也一样），
所以本轮没有截图验证，M4 合流时在带显示的环境补跑 `npm run smoke`；另有 `fake-ssh-server` 的 exec 应答扩展成支持 Buffer，
镜像集成用例要回放二进制 tar 流。**没有**为了跑通用例去放宽断言。

### 4. 遗留 / 下一步

- **内置 clangd 二进制还没入库**（`resources/clangd/{linux,win,mac}/` 仍是占位 `.gitkeep`）：
  发布前按 README 放官方二进制 + Apache-2.0 许可；启动顺序已经从内置 → PATH 打通并有单测。
- **M3 的 UI 手测验收（补全弹窗 / F12 / 红色波浪线 / 板子上 `ps` 无 clangd）还没有真机跑过**：
  窗口目前只有 M1 的示例文档，等 M4 的连接入口 + 文件树 + 标签页打开真实文件后再走一遍；
  规格 §12 允许「先用最小 UI 提前验证」，但本机没有可连的板卡与内置二进制，只能留到 M4 合流时手测。
- M4 需要补的接线：连接成功时创建 `MirrorManager` + `LspManager` 并调 `setActiveSession()`，
  断开时 `stopLanguageServers()`；打开文件时 `bridge.track(model)`，保存后 `bridge.saved(model)`。

---

## 2026-09-22 · V2 重构启动：M1 工程骨架完成

用户拍板整体换栈重写（Electron + TypeScript + Monaco），规格书 `docs/spec-v2*.md`（总纲 + 5 分册）
评审后补齐了三个决策空白（clangd 随包分发、F5 增量同步算法 A8b、tar 能力探测）并修掉 A9 的
`-I` 重写自相矛盾（外部路径一律隔离，防止串工作机本机环境）；macOS 出包暂缓（用户无需求）。

项目直接落在仓库根（2026-09-23 去掉 `remote-code-editor-v2/` 套壳），**M1 工程骨架完成并验收**：

- 目录结构 / tsconfig references 分层 / eslint 8（eslintrc）/ vitest 全部就位；
  `npm run lint` 0 告警、`npm test` 8 绿、`npm run typecheck` 0 错误。
- Electron 窗口：`frame:false` + 自绘标题栏（≡ 菜单 / 拖动 / 双击最大化 / ─ □ ✕）+
  边缘 8px 缩放热区（渲染进程热区 → IPC → 主进程 setBounds）；安全配置按总纲 §8.1 全上
  （sandbox + contextIsolation，preload 只暴露 `window.api`）。
- Monaco 走 AMD loader 直读 `node_modules/min/vs`（不引打包器），深色/浅色双主题色值
  运行时读 CSS 变量（tokens.css 保持唯一颜色来源），示例 C++ 代码可编辑、小地图正常。
- 打包：`npm run build:dir` 出 `release/linux-unpacked` 并实测能启动（日志落
  `~/.config/RemoteCodeEditor/logs/`）；CI workflow（Windows/Linux matrix）已写，
  AppImage/deb/nsis 的完整出包留到 CI 验证（本机网络下 GitHub 发布页下载超时）。

踩坑记录：

- npm 12 默认拦截依赖安装脚本，要 `npm install-scripts approve electron esbuild ssh2`
  （cpu-features 是 ssh2 的可选加速项，deny 即可，ssh2 没它照跑）。
- electron-builder 与 npm 的 Electron 缓存目录布局不一致：把
  `~/.cache/electron/<hash>/electron-v33.4.11-linux-x64.zip` 复制到 `~/.cache/electron/` 根即可复用。
- builder 默认会对原生依赖跑 node-gyp 重建，`npmRebuild: false` 关掉（无必装原生模块）。
- **CSS 变量里的相对 `url()` 在 Chromium 中解析基准不可靠**（实测解析到 dist/ 下导致图标全灭）：
  Codicons 一律 `new URL(..., document.baseURI)` 转绝对地址再写入变量。
- 容器里跑 Electron 冒烟：`ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a <electron二进制> --no-sandbox`，
  冒烟脚本 `scripts/smoke.mjs`（截图 + Monaco/preload 探针）。

下一步：M2 远端层（connection / remote-fs / git / search + shared 纯函数 + 假 SSH 集成测试）。

## 2026-09-22（晚）· V2 M2 远端层完成

仓库根新增：

- **shared 纯函数**：`paths.ts`（A1 规范化 + shellQuote）、`git-status.ts`（A2 porcelain 解析 /
  A3 目录继承色优先级 / A4 markSaved-markRemoved-markClean 本地更新 / A5 符号链接 keyFor
  撞车不猜）、`diff-parser.ts`（A6 替换块逐行配对：配上的 + 行算 modified、多出的算 added、
  删除行恒画红）、`graph.ts`（A7 泳道布局：并线保留最左、不左移）。
- **主进程远端层**：`connection.ts`（认证顺序：显式私钥 > 上层密码 > 默认名私钥逐个试 > 抛 auth；
  错误归类 auth/timeout/network/host-key；known_hosts 首次信任并记录；SFTP 串行队列；
  exec 支持 cwd=cd 引用拼接）、`remote-fs.ts`（原子写 .rce-tmp + rename + 失败清理、
  32MB 上限、UTF-8/BOM 识别、CRLF 检测归一、符号链接 stat、删目录走 `rm -rf` 省往返）、
  `git.ts`（treeStatus=2 条命令、干净/未跟踪文件 diff=0 条、commitAll、push 无上游自动 -u、
  sync=pull→push、checkout 不用 switch、logGraph 一条命令 + 本地泳道布局）、
  `search.ts`（一条 grep、-e 保护、退出码 1 = 空结果、500 条截断）。
- **测试**：单测 77 个全绿（沙箱）；集成测试（进程内 ssh2 Server + 真实临时目录支撑 SFTP）
  在沙箱里因禁 socket 自动跳过，沙箱外实测 3/3 通过：连接→列目录→读→原子写全链路、
  错误密码归类 auth、git status + grep 罐装输出解析。

踩坑：

- ssh2 服务端删除文件的事件叫 `REMOVE` 不叫 `UNLINK`（协议 SSH_FXP_REMOVE）。
- ssh2 不认 node:crypto 导出的 PKCS8 PEM 主机密钥，要用 `utils.generateKeyPairSync`。
- ssh2 的 ConnectConfig 类型不允许 `agent: false`，恒不设该字段即恒不走 ssh-agent。

下一步：M3 环境镜像 + LSP（tar 单流、manifest、sysroot、compile_commands 重写、clangd/pylsp）。
