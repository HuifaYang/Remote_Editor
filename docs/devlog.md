---

## 2026-10-12（续 4）· 文档收敛：旧规格对齐到 ui-parity 新路线

背景：UI 路线自 10-10 转向后 `ui-parity.md` 已是 UI 唯一基准，但 `AGENTS.md`、总纲 §6/§12、
分册 2 仍停在 09-24 的老口径，新会话读记忆文件会走错路。本轮纯文档对齐，**不动代码**。

- `AGENTS.md`：必读清单加 `ui-parity.md`；「里程碑顺序执行 M3→M6」改为四阶段路线
  （阶段一/二已完成、阶段三移植 CodeOSS、阶段四本地 IDE），写入「除 SSH 外不自制 UI」原则。
- `docs/spec-v2.md`：文档头加「路线变更」横幅（M1–M6 已完成、UI 归 ui-parity、四阶段路线）；
  §6 UI 规格加「整体已被 ui-parity.md 取代」横幅；§12 里程碑改标题并补 §12.1 后续路线表；
  §14 遗留问题第 1 条（输出页签）标注已由 S07 解决。
- `docs/spec-v2-ui.md`：头部加取代声明 + 逐条「已作废条目」表（`≡` 菜单、标题栏 32→30、
  活动栏 44→48、侧栏 260→300、状态栏 24→22、标签行 32→35、居中模态→toast、
  设置对话框→设置工作台页、主菜单→横向菜单栏）；U1/U6/U8/U9/U10 各加节级 ⚠️ 标注。
- 口径：分册 2 的**功能职责与中文文案仍有效**，仅结构与交互被取代；快捷键表与
  `tokens.css` 唯一色源不变。`spec-v2-algorithms/data/git-repo/tests` 四个分册不受影响。

未跑测试（纯文档改动）。

---

## 2026-10-12（续 3）· 阶段二收官：E08 面包屑符号段（LSP documentSymbol）

- **LSP 链路补 documentSymbol**：`LspClient.documentSymbol(uri)`；`initialize.capabilities.
  documentSymbol.hierarchicalDocumentSymbolSupport=true`；归一化 `normalizeDocumentSymbols`
  同时吃层级 `DocumentSymbol`（range/selectionRange）与扁平 `SymbolInformation`
  （location.range，selectionRange 回落 range），缺 name/range 的脏数据丢弃。
  `LspDocumentSymbol` 进 shared/types。
- **IPC/preload/api**：`api:lsp.documentSymbol` → `window.api.lsp.documentSymbol`
  （main/ipc.ts、preload/index.ts、renderer/api.d.ts 三处同步）。
- **面包屑符号段**（`views/breadcrumbs.ts`，对准 CodeOSS DocumentSymbolBreadcrumbsSource）：
  路径段之后追加符号链（类 → 方法…）；`symbolChain()` 取包含光标的最内层符号链
  （LSP 0-based，含行/列边界判定），最内层符号高亮、此时文件名段不再高亮；随光标 150ms
  防抖只重算符号链（不重新请求）；点符号段列同级符号（`siblingsOf` 按引用或 name+range
  识别）并跳转到 selectionRange。
- **EditorArea 接线**：符号按文件缓存（symbolsByPath）；激活时 `loadSymbols`；内容变更
  `invalidateSymbols`（300ms 防抖重取，对齐 outline 内容变更重建）；关标签随
  `disposeModel` 清缓存；请求返回时已切走则丢弃。
- **已知偏差**：codicons 目录无 symbol-kind 图标（symbol-method/class 等），符号段为纯文本，
  不新增资源文件。
- 测试：lsp-client +1（documentSymbol 请求法 + 层级/扁平归一化 + 脏数据丢弃）；面包屑 +3
  （符号链取最内层、随光标渲染与换文件清空、点选列同级并跳转）；**42 文件 244 全绿**，
  lint/typecheck 0。

**阶段二至此全部销号**（E01–E15 中除 E12 分屏 —— 该表属阶段三）。

---

## 2026-10-12（续 2）· 阶段二第三批：面包屑 + 输出通道 + 状态栏尾项

- **E08 面包屑（路径段）**：`views/breadcrumbs.ts`，编辑器顶部 22px 路径段条（chevron 分隔，
  当前文件段高亮）；点目录段 = 快速输入列该目录子项、点文件名段 = 列同级文件（对齐 VSCode
  揭示选择器，1 次 listDir）；面包屑可见时编辑器 inset 下移 22px（纯 CSS 兄弟选择器）。
  符号段需 LSP `textDocument/documentSymbol`，登记为尾项。
- **S07 输出通道下拉**：`outputStore` 拆 远程任务 / 语言服务 两通道（各 500 行上限）；
  LSP 生命周期日志新链路 `LspManager.onLog → session lspLog → event:lsp-log → appendLspLog`；
  输出视图顶部 sticky 下拉切换，切通道整页重绘。
- **N04 尾项**：状态栏语言项 → 语言选择器菜单（EDITOR_LANGUAGES，当前项 ✓ 标记，
  `EditorArea.setLanguage` 即时切 Monaco model 语言）；行列项 → 转到行。两项无图标纯文本
  （对齐 VSCode），无打开文件时隐藏。
- **E06 标签溢出**：确认现有样式已满足（max-width 200px 收缩 + 省略号 + 横向滚动，不换行），销号。
- 测试：面包屑 3、输出通道 1、状态栏语言/行列 1；**42 文件 240 全绿**，lint/typecheck 0。
- 截图自查：输出通道下拉（远程任务）+ 空态提示正常。

**阶段二至此只剩**：E08 面包屑符号段（需先给 LSP 客户端补 documentSymbol）、E12 分屏（§3 表属阶段三）。
（E08 符号段已于本日"续 3"补完。）

---

## 2026-10-12（续）· 阶段二第二批：标签预览/固定 + 问题面板 + chord + 快速输入模式前缀

用户拍板：**除 SSH 功能外，一切以照抄 CodeOSS 为准，不再自制 UI**。本批全部按源码/默认键位移植：

### 修正

- **命令中心点击**：上一轮误接成命令面板。读 `commandCenterControl.ts` 确认点击触发
  `workbench.action.quickOpenWithModes` = **快速打开（Ctrl+P）**，已改回并改测试。

### 新增

- **E03/E04 标签预览/固定**：`TabsModel.openPreview()` 原位替换预览标签（不进已关闭栈，
  VSCode 行为）、`pin()`；编辑即钉住（onDidChangeContent → pin）、双击标签钉住、
  右键 固定/取消预览；预览标签斜体；被替换标签释放 model（bridge.release + dispose）。
  顺带修掉 `open()` 重复注册 onDidChangeContent 的旧问题。
- **S08 问题面板 + N05 状态栏计数**：底部面板新增「问题」页签（问题/终端/输出，顺序对齐 VSCode）；
  `groupProblems()` 纯函数按文件分组、行号排序；点击行打开文件并跳转；
  状态栏 ⊗ 错误数 / ⚠ 警告数（着色，无问题隐藏），点击切到问题页签。
- **K14 chord**：`chordTable()`（Ctrl+K Ctrl+T 主题 / Ctrl+K Ctrl+S 快捷键一览 / Ctrl+K S 全部保存），
  3 秒超时、未命中取消、顶部中央按键提示（对齐 VSCode keypress hint）。
- **N07 快速输入模式前缀**：`quick-input` 支持 ">" / ":" 前缀（provider 自行筛选，组件不做 fuzzy，
  对齐 VSCode quick access）+ `value` 预填；Ctrl+P 输入 `>` 过滤命令、`:` 转到行（超界钳制 +
  行内容预览）；Ctrl+G 预填 ":" 进入转到行（替换掉 Monaco standalone 里无效的 gotoLine 命令）。
- **S06 尾项**：面板右侧 最大化/还原（盖住编辑区，`editor-column.panel-maximized`）+ 关闭按钮。

### 验证

- `npm run lint` 0 / `npm run typecheck` 0 / **`npm test` 41 文件 235 全绿**
  （新增 tabs 预览 4、problems 聚合 2、chord 3、面板问题页签/最大化 2、状态栏计数 2、模式前缀 2）
- 截图自查（xvfb）：问题页签空态、面板最大化按钮、chord 提示、Ctrl+K Ctrl+T 主题选择器均正常
- `docs/shortcuts.md` 重写为当前实际键位（含预览标签说明）

### 阶段二余项

E08 面包屑（路径段可先做，符号段需 LSP documentSymbol）、E06 标签溢出、N04 尾项、S07 输出通道下拉；
E12 分屏按 §3 表归阶段三。

---

## 2026-10-12 · 断点收尾 + 阶段二通知三件套（E15/S12 验收，N01/N02/N03 完成）

接 10-10（续 5）的断点继续，全部销号：

### 1. 断点修复（E15 设置页 / S12 命令中心 / N01 toast 的测试与接线）

- `title-menu.test.ts` 旧 `.title` 断言改 `.command-center-label`，补命令中心点击用例；
- 新增 `tests/ui/notifications.test.ts`（toast 出现/关闭/严重级别图标/堆叠上限，10 用例）；
- `settings-page.test.ts` 两处失败是页面没挂到 `document.body`（测试自身问题）；
- `quick-input.test.ts` 两处失败是没等 150ms 关闭动画（CodeOSS quick-input-close 原值）；
- scm/hosts/explorer 三视图的 `showMessage`（信息类 + 错误类）全部换右下角 `notify`；
  搜索视图的错误本就走视图内状态行，不改。
- 命令中心点击行为修正：VSCode 点命令中心进的是**命令面板**，原来接了快速打开
  （未连接时只弹 toast），改为 `commandPalette ?? quickOpen` 并补两条用例。

### 2. 截图自查抓到的真 bug

- **设置页一打开就显示「没有找到匹配的设置。」**：`no-results-message` 初始没加 `hidden`，
  happy-dom 只断言了输入后的状态所以没暴露。修复 + 补初始态断言。
- **通知中心定位错误**：原来按点击坐标 `clientX/Y` 停靠，程序化 click（坐标为 0）直接飞出视口；
  改为按铃铛元素 `getBoundingClientRect()` 定位并做视口钳制。

### 3. 阶段二：通知三件套（N01/N02/N03）

- **N01 通知 toast**：已在 10-10 移植（notifications.css 原值），本轮补齐其余视图切换与测试。
- **N02 通知进度**：`notifyProgress()` 句柄（update/done/error/close）+ 进度条 + 取消按钮；
  主进程 `MirrorManager.cancel()` 关闭当前 SSH 流并在阶段边界置中止位，同步以
  「镜像同步已取消」收尾（取消不会退化成全量重传）；`api:mirror.cancel` 经 IPC/preload 打通；
  F5 / 命令面板「同步镜像」共用 `syncMirrorWithProgress()`，进度经 `event:mirror-progress`
  的 done/total 推进度条。
- **N03 通知中心**：通知入历史（上限 50）、状态栏铃铛未读徽标（99+ 封顶）、点击弹出聚合面板
  （严重级别图标 + 标题 + 正文 + 相对时间 + 清除全部），Esc/外点关闭，打开即已读；
  新增 `bell.svg` 图标（16px 网格，与既有 Codicons 同风格）。
- 测试：notifications（13：进度/历史/中心/Esc/退订）+ mirror 取消用例（挂起流 + 不重传断言）+
  panel-output 铃铛徽标 2 用例；**40 文件 221 全绿**，lint/typecheck 0。
- 截图自查（xvfb + Electron，`/tmp/rce-shots/`）：欢迎页（含铃铛）、toast + 徽标、
  通知中心（深/浅）、命令中心展开、设置页（初始态/搜索过滤/浅色）均正常。

### 4. 下一步（阶段二余项）

S08 问题面板、E08 面包屑、E03/E04 标签预览/固定、E12 分屏、K14 chord、N04 尾项、
S06/S07 尾项、N07 快速输入复用到重命名/转到行。

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
| 打包 | `npm run build` | `release/织码 WeaveCode-2.0.0-alpha.0.AppImage`（286 MB）、`release/remote-code-editor_2.0.0-alpha.0_amd64.deb`（228 MB）；解包检查包内 `resources/clangd/clangd` 可执行且版本正确 |
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
  `~/.config/织码 WeaveCode/logs/`）；CI workflow（Windows/Linux matrix）已写，
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
## 2026-10-10 · UI 战略转向：以 CodeOSS 为唯一基准的对齐工程

背景：自研外壳被评价"与 VSCode 差距大"，此前靠用户逐点反馈修改，无收敛机制。决定转向
**清单驱动的复刻工程**：CodeOSS 源码与默认键位为 UI 唯一规格，建立
`docs/ui-parity.md` 总清单（键位 15 项 / 外壳 10 项 / 编辑器 14 项 / 通知状态栏 8 项），
分 5 波推进（W1 键位与快捷入口 → W2 外壳 → W3 编辑器区 → W4 通知 → W5 打磨）。

同日推翻原 spec-v2-ui.md 的三项有意偏离（登记于 ui-parity §0，随波次修订原规格）：

- ≡ 单按钮双层菜单 → 横向菜单栏（悬停切换、Alt 助记键、check 项）
- 居中模态 showMessage/confirm → 右下角通知 toast 体系
- 设置对话框 → 设置编辑器（占编辑区、即时生效）

保留偏离：远端目录选择器（OS 原生选择器无法访问远端 FS）、无扩展系统。

当日已完成的铺垫工作（未按清单编号，计入 W1/W3 前置修复）：

- 源代码管理列表与提交图文字重叠（flex 收缩 + nowrap 缺失）修复，活动栏图标居中。
- SSH 配置导入重复：改为按 Host 别名去重就地更新，顺带清理完全重复项并合并工作目录历史。
- 测试基线：37 文件 184 用例全绿。

下一步：W1 —— Ctrl+P 快速打开、Ctrl+Shift+P 命令面板、Ctrl+Shift+E/G、
Ctrl+PageUp/Down、Ctrl+Shift+T、Ctrl+Shift+S 语义修正、标签右键菜单分隔线、
关闭脏标签与保存冲突对话框补三选项。

## 2026-10-10（续）· W1 键位与快捷入口完成

按 ui-parity.md 清单推进 W1，全部销号：

- **快速输入组件** `views/quick-input.ts`：顶部居中浮层，子序列 fuzzy 匹配（连续/前缀加分、
  间隔扣分）+ 命中字符高亮、↑↓/回车/Esc、外点关闭、竞态保护。Ctrl+P 文件快速打开与
  Ctrl+Shift+P 命令面板共用。
- **命令注册表** `app/commands.ts`：27 条命令（文件/查看/终端/远程/首选项/帮助），
  命令面板数据源，与菜单共用动作闭包。
- **K01 Ctrl+P**：新增主进程 `listFiles`（1 条 find，不用 -printf 保持 BusyBox 兼容，
  排除 .git，上限 2000）→ IPC `api:fs.listFiles`，本地过滤零额外往返。
- **K04/K05**：TabsModel 增加已关闭栈（上限 20，跳过已重开项）；Ctrl+PageDown/PageUp
  切标签、Ctrl+Shift+T 重开。
- **K07 语义修正**：Ctrl+Shift+S 改为另存为（promptDialog 输入远端路径），全部保存移到
  菜单无键位（chord Ctrl+K S 属 W5）。
- **E07**：openContextMenu 支持 separator 项；标签右键菜单分组 + 关闭全部/复制路径。
- **E10/E11**：关闭脏标签与保存冲突对话框补齐三选项（取消可中止）。
- 测试：quick-input（fuzzy/命令表/浮层交互）6 用例 + tabs 栈 2 用例 + 分隔线 1 用例 +
  快捷键表更新；**38 文件 190 通过 / 3 跳过（沙箱限制）**，lint/typecheck 0。

下一步：W2 外壳结构 —— 横向菜单栏（悬停切换/Alt 助记键/check 项）、窗口标题随文件更新、
活动栏徽章、底部面板 输出 页签、侧栏视图常驻化。

## 2026-10-10（续 2）· 波次重排：既有组件差异清零优先

反馈："改得太突兀，原本没有的东西突然跳出来；应该先把和 VSCode 不一样的都改掉"。
采纳：ui-parity.md 波次重排 —— **先清零既有组件差异，再新增缺失组件**（原则写入清单 §5）。
新增类部件（toast/问题面板/面包屑/预览标签）全部后移到阶段二。

阶段一首批落地：

- **S01 横向菜单栏**：废除 ≡ 双层页签菜单，改 文件/编辑/查看/转到/终端/帮助 横向常驻；
  点击展开、已展开时悬停即切换（VSCode 行为）、←→ 切分组、↑↓ 循环、Esc/外点关闭；
  "转到"分组新增 转到文件（Ctrl+P）；"查看"顶部加 命令面板入口。
- **S02 动态窗口标题**：`[●] 文件名 - 工作目录名 - 主机名 - 织码 WeaveCode`，
  AppState 增 currentFile 切片，关最后一个标签自动清空。
- **尺寸 token 对齐 VSCode**：标题栏 32→30、状态栏 24→22、活动栏 44→48（图标 22→24）、
  侧栏默认 260→300、编辑器/终端页签条 32→35、活动标签顶部 1px 强调线。
- 测试：title-menu 重写（5 用例：分组结构/悬停切换/键盘导航/动态标题）；**38 文件 195 全绿**。

下一步（阶段一余项）：S03 活动栏徽章 → S06/S07 面板页签与输出通道 → S04 侧栏视图常驻化 →
N04 状态栏点击弹菜单 → E09 脏标记圆点。

## 2026-10-10（续 3）· 阶段一主体完成（外壳结构性差异清零）

按 ui-parity.md 阶段一推进，销号 6 项：

- **S03 活动栏徽章**：AppState 增 gitChanges（ScmView.setStatus / openFolder / 断连三处
  同步），源代码管理图标右下角显示未提交更改数角标（accent 底、0 时隐藏）。
- **S04 侧栏视图常驻化**：每视图固定槽位 + 实例只建一次，切换仅显隐；explorer 快照机制
  移除（常驻后无此需要）；断连时统一清空工作目录/Git 面板。
- **S06/S07 面板页签**：底部面板改为 终端/输出 两页签（35px 页签条、active 底线强调）；
  输出视图等宽字体、时间戳、贴底自动滚动、上限 500 行（outputStore.appendOutput）；
  终端专用按钮（新建/终止）在输出页签下隐藏。
- **N04 状态栏菜单**：连接/文件/Git 三个可点项改为弹上下文菜单（打开远程文件夹、
  断开连接、刷新 Git、打开面板等），未连接项禁用。
- **E09 脏标记**：标签脏标记改圆点替换关闭钮，悬停标签显示 ✕（对齐 VSCode）。
- 测试：panel-output.test（徽章/页签切换/输出渲染与 500 行上限/状态栏坐标回调）+
  activity-bar 徽章用例；**39 文件 199 全绿**，lint/typecheck 0。

阶段一余项：S05 其余视图头部动作行、S08 问题面板（属新增，可随阶段二）、
S09/S10 分隔条双击重置与布局记忆、对话框样式细节。

## 2026-10-10（续 4）· 阶段一收官

要求"不要半成品"，把阶段一全部尾项做完：

- **S05 侧栏头部动作行 + ⋯ 溢出菜单**：四视图齐备 —— 搜索（重新搜索）、
  SCM（刷新 + 仓库管理）、主机（新增主机 + 导入配置）、资源管理器（⋯：新建文件/文件夹、
  打开远程文件夹、折叠全部）；SearchView.rerun / HostsView.addHost / importSshConfig /
  Explorer.collapseAll 转公开。
- **S03 齿轮管理菜单**：活动栏齿轮从直开设置改为弹出菜单（命令面板/设置/快捷键一览），
  对齐 VSCode；onViewChange("settings") 保留兼容。
- **S09 分隔条双击重置**：侧栏回 300px、面板回 240px，重置后触发 resize 让 xterm refit。
- **S10 布局记忆**：localStorage（rce.layout.v1）记 侧栏视图/可见/宽度 + 面板可见/高度；
  视图切换、拖拽松手、双击重置、切侧栏、beforeunload 五个时机保存，启动校验范围后恢复。
- 测试：齿轮菜单 2 用例、折叠全部 1 用例；**39 文件 202 全绿**，lint/typecheck 0。

阶段一至此全部销号。下一步进入阶段二（新增组件）：通知 toast（N01-N03）先行，
随后问题面板（S08）、面包屑（E08）、标签预览/固定（E03/E04）。

## 2026-10-10（续 5）· 方针再修正 + 阶段二开工 + 断点记录

用户验收结论：改动"画皮不画骨"——设置仍是突兀模态框、命令面板凭空弹出，
因为 VSCode 里它们"有东西承接"（命令中心 / 工作台页面）。方针修正为：
**直接克隆开源真身（CodeOSS，MIT），照源码移植结构，自己截图看效果**。

已完成基准采集：

- CodeOSS 源码已浅克隆至 **/home/yon/vscode-src**（414M，明天直接读）。
- 本机 /usr/share/code 的工作台 CSS 也可提取真实值（quick-input / notifications 已提）。

今日已落地的结构改动（阶段二开工，未验收，明早先跑测试修完）：

- **E15 设置工作台页**：EditorArea 增加工作台页面宿主（openPage/activate/close，
  页面与文件标签同级、可关闭）；新建 views/settings-page.ts（结构移植 settingsEditor2：
  头部搜索 30px + 200px 目录 + 行布局 12px/14px/18px + is-configured 修改指示条 +
  即时生效无确定按钮）；openSettings 改为打开 "settings://" 标签；删除 settings-dialog.ts。
- **S12 命令中心**：标题栏中央常驻入口（移植 titlebarpart.css：高 22 / 宽 38vw≤600 /
  1px 边框 / 圆角 4 / 搜索图标 14px），点击进快速打开；动态窗口标题并入其中。
- **N01 通知停靠**：views/notifications.ts（移植 notifications.css：右下角贴状态栏、
  480px、滑入 translate3d(100%,0,0)→0 .3s、堆叠上限 5）；main.ts 信息类 showMessage 全部
  换 notify；确认/选择/输入类仍走 dialogs。
- **快速输入锚定**：top=标题栏+6px（命令中心正下方）、宽 600、行高 22、行圆角 3、
  开/关动画 250ms/150ms（quickInput.css 原值）。
- CSS 已加：命令中心 / 快速输入动画 / 通知停靠 / 设置编辑器 / .editor-page-host。

**断点（明天第一步）**：

1. tests/ui/title-menu.test.ts 仍断言旧 `.title`（命令中心化后必挂）——改为断言
   `.command-center-label` 并补命令中心点击用例。
2. 新增 tests/ui/notifications.test.ts（toast 出现/关闭/严重级别图标）。
3. 全量 lint/typecheck/test 跑绿；smoke 截图自查设置页/命令中心/通知的实际观感并迭代。
4. dialogs/index 的 showMessage 在其余视图（scm/hosts/search）的信息类用法逐步换 notify。

**明日方向（用户拍板）**：

1. **阶段三：全面移植 CodeOSS 布局与操作**（不是逐个部件，而是整套）：
   参照源 ~/vscode-src ——
   - workbench 布局：src/vs/workbench/browser/parts/*（titlebar/ Menus/ activitybar/ sidebar/ panel/ statusbar）
   - 标签页行为：src/vs/workbench/browser/parts/editor/*（预览态/固定/分屏/拖拽跨组）
   - 树控件交互：src/vs/base/browser/ui/tree + list（键盘流、多选、双击语义）
   - 命令与键位体系：src/vs/platform/actions + keybinding（chord、when 子句的简化版）
   逐文件读结构 → 移植 → 截图自查。
2. **本地 IDE 功能**（新增需求）：除了远程编辑，应用本身也能作为本地 IDE——
   打开本地文件夹、本地文件树/标签/保存、本地 Git、本地终端（shell 而非 ssh），
   复用同一套工作台外壳；镜像/LSP 仅远程路径需要。明天先出设计再动代码。

---

## 2026-10-12（下午）：路线变更 —— 放弃自研外壳，fork CodeOSS 拿壳 + 自己的 SSH 替掉 Remote-SSH

**用户拍板**：不再逐个部件模仿 VSCode，直接拿 CodeOSS 当底座，把 Remote-SSH 换成我们自己的 SSH 层。
自研外壳（`src/renderer` 6.7k 行）降为备选，新主线在 `ide/`。

**已完成**：

1. **`ide/` 新主线**：上游 CodeOSS 浅克隆（`ide/vscode`，gitignore）+ `ide/extensions/sshfs`（我们的扩展）
   + `ide/tools/`（构建/验证脚本）。目录与流程见 `ide/README.md`。
2. **Q1（能不能当远端文件系统）**：7/7 通过 —— 见 `ide/README.md` 旧记录；暴露的 3 个适配点
   （错误码对齐 `FileSystemError`、读写要字节保真、mtime 秒→毫秒）已全部落地。
3. **Q2（能不能构建分发）**：装依赖 → 编译 → 开发版 → 打包独立程序 → 改品牌，全链路通。
4. **扩展重做**（`ide/extensions/sshfs/src/`）：`session / fs-provider / terminal / search / scm / extension`
   六个模块，esbuild 打成 818KB 单文件，同步成内置扩展 `ide/vscode/extensions/rce-remote`。
   新增能力：轮询式文件监听（自写快照对比，吞掉自己造成的变更）、SSH PTY 集成终端（含默认 profile）、
   远端搜索（proposed API `fileSearchProvider`/`textSearchProvider`，复用 `SearchRemote` 的 grep）、
   远端 SCM（复用 `GitRemote` + `splitStatus`，含 quick diff、暂存/取消暂存/放弃/提交）。
5. **端到端验证**：`bash ide/tools/run-e2e.sh` → CodeOSS 开发版打开 `sshfs://` 工作区，**8/8 通过**
   （开文件 / 远端终端 / 默认 profile / grep / findFiles / SCM 状态 / 搜索视图 / SCM 视图），
   报告 `ide/tools/tmp/e2e-report.json`，截图 `ide/tools/shots/e2e-*.png`。
6. **评估结论落地**：`docs/ssh-vs-remotessh.md` —— "我们的 SSH 能不能替代 Remote-SSH"逐项差异清单
   （机制证据、影响面、处置、当前状态、待做）。
7. **仓库侧根因修**：`AppErrorCode` 增加 `not-found` 并透传 `sftpCode`
   （`src/shared/{types,errors}.ts`、`src/main/session/remote-fs.ts#classifySftpError`，配 4 个用例）；
   `.eslintrc.cjs` 忽略 `ide/`（上游源码不纳入本仓库 lint）。
8. **去 Copilot / 改品牌**的连带修补全部收敛进 `ide/tools/apply-branding.mjs`（幂等）。
   实测踩出来的 6 个坑（onboarding 顶层 assert、defaultAccount 空解引用、gulpfile 坏补丁、npm
   compile-copilot、Electron 二进制改名、扩展目录抢 scheme）都写在 `docs/ssh-vs-remotessh.md` §3。

**关键判断（写进 `docs/ssh-vs-remotessh.md`）**：

- Remote-SSH 的本质是**目标机上有个扩展宿主**；我们的硬约束（零部署/零常驻）不允许，
  所以**架构上不可能"完美"替代**，只能"功能等价"：`sshfs://` 虚拟工作区 + 本地扩展宿主 +
  自补终端/搜索/SCM/监听/语言服务镜像。
- 虚拟工作区的扩展影响面实测很小：93 个内置扩展里只有 7 个声明 `virtualWorkspaces: false`
  （grunt/gulp/jake/两个 debug 辅助/php/tunnel-forwarding），全都不影响我们的场景。
- 真正需要自己补的是"必须有个远端进程才能干"的活：终端、git、搜索、任务、调试。
  终端/搜索/git 已完成；任务待做；调试与端口转发明确不支持。

**下一步**：语言服务接线（镜像 + clangd/pylsp → VSCode provider）→ 任务改写到远端 → SCM 补全
（历史图/分支/stash/push/pull）→ 连接管理正式化（hosts.json / ssh config / 私钥）→ 打包发布。

**门禁**：`npm run lint` 0 告警、`npm run typecheck` 0 错误、`npm test` 243 通过（43 文件）。

---

## 2026-10-12（傍晚，续）语言服务接线 + 虚拟工作区启动竞态

**主线进展：语言服务接通（嵌入式场景价值最高的一块）**

- 新增 `ide/extensions/sshfs/src/lsp.js`（+ `electron-stub.js` 给 esbuild 做 `electron` 别名桩）：
  一个远端工作目录 ↔ 一份镜像 + 一套 `LspManager`；把 `Definition/Hover/DocumentSymbol/Completion`
  provider 与 `DiagnosticCollection` 接到 `{scheme: sshfs}` 上，URI 在 `sshfs://` ⇄ 镜像 `file:` 之间双向翻译。
- 踩坑：VSCode 里 `.c` 的 languageId 是 **`c`** 不是 `cpp`（内置 cpp 扩展贡献的），`documentSelector`
  少写一条就一个 provider 都调不到（症状：跳转永远返回空，但直连 clangd 拿得到）。
- 镜像层被 E2E 逼出 **5 个真 bug**（此前"看着能跑、其实从没跑通"）：分段命令拼出空段 / `fi 1>&2` 语法错误、
  `__FILE__` 分段表头不对、`tar --version` 与 `sys.path` 污染 stdout 把 gzip 流搞坏、sysroot 探测要多一条命令、
  增量同步把全量收好的 `compile_commands.json` 覆盖成 `compile_flags.txt` 兜底。
  详见 `docs/ssh-vs-remotessh.md` §5.2（含回归用例 `tests/unit/mirror.test.ts` T5.8）。
- 端到端补 4 步：镜像+compile_commands 重写、远端 `.vscode/settings.json` 生效、
  跳转/悬浮/符号/补全（先用假 clangd 直连、再走 `vscode.execute*Provider`，分开定位）、诊断。

**工具链修正：E2E 假阴性**

`run-e2e.sh` 原来是"起窗口 → `sleep 110` → 杀"，而 E2E 内部预算 240s：**进程被杀在步骤中间**，
被取消的 promise 抛 `Canceled: Canceled`，看起来像功能坏了。改成**轮询等报告文件出现**再收尾；
另外给 `udd-oss` 写死 `window.restoreWindows: none`，避免上一轮的窗口状态（旧端口工作区）把这一轮带偏。

**新发现并已修的启动竞态（最重要的一条）**

症状：`sshfs://` 窗口里**第一次补全永远 Loading**（本地 `file://` 窗口正常）。
定位链（全部有实测证据，见 `docs/ssh-vs-remotessh.md` §5.4）：断点进 `provideSuggestionItems`
→ 卡在 `await snippetCompletions` → `SnippetsService._joinSnippets()` 里有一个**永不落地**的工作项
（`updateWorkspaceSnippets` → `_initWorkspaceFolderSnippets` 的 `fileService.exists(<ws>/.vscode)`）；
我们 provider 侧**从没收到**这条请求，但在活着的窗口里直接调 `IFileService.exists()` 42ms 就返回 true
→ 根因是**窗口恢复阶段（provider 尚未注册时）发出的请求在上游既不失败也不重试**。

处置三处（缺一不可）：① `activate()` 里 **先注册 provider 再连 SSH**；② `SessionManager.expect()/whenReady()`
让早期请求**等会话就绪**（上限 15s，顺带把"远端 `.vscode/settings.json` 不生效"一起修了）；
③ 上游 `snippetsService.ts` 的存在性探测加 5s 上限，由 `apply-branding.mjs`「虚拟工作区补丁」幂等写入。

**门禁**：`npm run lint` 0 告警、`npm run typecheck` 0 错误、`npm test` **251 通过**（43 个文件，无跳过）。
另验证：`activationEvents` 里的 `*` 不会污染普通本地窗口（本地文件夹窗口跑一遍，我们的扩展零报错、零副作用）。
**端到端**：`bash ide/tools/run-e2e.sh` → **12/12 通过**（补全 4 项、远端 settings 生效、诊断 1 条）。

---

## 2026-10-12（夜）任务改到远端：`.vscode/tasks.json` 能在板子上跑了

**症状**：远端工程有 `.vscode/tasks.json`，但"运行任务"里**空**（`fetchTasks()` 返回空数组），`runTask` 静默无动作。

**根因（上游有意为之）**：`abstractTaskService.registerSupportedExecutions()` 里，**虚拟工作区**会把
`shellExecutionSupported`/`processExecutionSupported` 置 false（"本机 shell 跑不了远端路径"的合理防御），
于是 `_jsonTasksSupported === false` → tasks.json 的任务被整批丢掉。Remote-SSH 不受影响是因为它
有**远端扩展宿主**，任务系统本身就在远端。

**走过的弯路（记下来免得再走）**：先试过打上游补丁放行（加一个 `rce.remoteTaskExecutionsSupported`
上下文键，改 `isVirtual` 与 `_jsonTasksSupported`）。实测任务能起来，但**cwd 是错的**——工作台会把远端路径
`resources.toLocalResource(...)` 成本地路径，任务终端（我们的远端 PTY）又拿不到 cwd。`make` 这类任务 cwd 错了
等于白跑。**上游补丁已还原**。

**最终做法**：自己提供 `TaskProvider`（`ide/extensions/sshfs/src/tasks.js`，类型 `rce-remote`）：
读 `workspace.getConfiguration('tasks', folder.uri)`（工作台已替我们解析好带注释的 JSON）→ 按远端语境展开
`${workspaceFolder}` 等变量、算远端 cwd → `CustomExecution` + `Pseudoterminal`，命令走
`SSHConnection.execStream(`cd <远端 cwd> && ...`)`，输出实时进终端、结束码回给任务系统。

**验证**：E2E 新增第 12 步（假靶机 `.vscode/tasks.json` 的 `rce-probe`）→ **13/13 通过**：结束码 0、
任务里的 `pwd` 落在远端工作区 `/ws`、远端写出的 `task-ran.txt` 能从 `sshfs://` 读回。

**补一个小坑（E2E 抓到的）**：扩展必须在 `package.json` 里 `contributes.taskDefinitions` 注册任务类型
（`rce-remote`，required = `label`）。否则 `TaskDefinition.createTaskIdentifier` 走"类型未注册"的兜底分支
（用整个 definition 当 identifier），按 label 触发任务时匹配不上 → **静默退化成打开任务列表**，
headless 下看起来就是"没反应"。注册后「运行任务」列表与按 label 触发都正常。

**没做**：`dependsOn`、`problemMatcher`（编译错误进 Problems）、`isBackground`、任务交互输入。

**约束补充（用户明确）**：目标机"零部署/零常驻"放宽为**"允许极少量必需且轻量"**的远端支撑——
但必须有明确的体积/内存/CPU 预算，绝不允许 VS Code Server 那种几百兆常驻进程。当前实现仍**没有任何**
远端常驻服务（任务走一次 `ssh exec`），这条放宽留作将来按需评估。

---

## 2026-10-12（夜，收尾）"看整个应用"的入口 + 一个被冒烟照出来的真 bug

- 新增 `ide/tools/run-app.sh`：一条命令起**整个应用**（CodeOSS 外壳 + 内置远端扩展）。有 `DISPLAY` 直接开窗口，
  没有就自动 xvfb 冒烟并截图；支持 `run-app.sh user@host[:port] [远端目录]` 连真板子（`RCE_PASS` 给密码，
  不给就进窗口后用「连接到远程主机」连）。用户数据/扩展目录都落在 `ide/tools/` 内。
- 冒烟顺手照出一个**真 bug**：我们的文件监听事件把字段写成 `resource`，而 `vscode.FileChangeEvent` 要的是 **`uri`**
  → 上游 `extHostFileSystem.js` 读 `value.uri.scheme` 直接抛 `Cannot read properties of undefined (reading 'scheme')`，
  **等于整个 watch 通道没接上**（编辑器"磁盘已修改"、工作区配置重载、SCM 自动刷新都会失灵）。
  修法：`fs-provider.js#diffToEvents` 三处 `resource` → `uri`；验证：同一冒烟 + E2E 日志里该报错 **3 → 0**。
  （教训：这个字段我们自己的代码从不读，所以只有"真跑一会儿、有远端变更"才会暴露。）

---

## 进度快照（2026-10-12 19:17）

> 一句话：**`ide/` 主线已经是一个"能日常用的远程 IDE"**——CodeOSS 外壳 + 我们自己的 SSH 层，
> 端到端 13/13 通过；目标机上**没有任何常驻服务**（全部按需 `ssh`/`sftp`）。

**现在能用的能力**（都有实测证据，明细见 `docs/ssh-vs-remotessh.md` §2 与 §4）

| 能力 | 状态 | 实现/证据 |
|---|---|---|
| 远端文件系统（字节保真、原子写、错误分类、轮询监听） | ✅ | `ide/extensions/sshfs/src/fs-provider.js`；E2E 第 1 步 + Q1 自检 |
| 集成终端（远端 PTY，默认 profile） | ✅ | `terminal.js`；E2E 第 2–3 步 |
| 搜索（全文 `grep` + `findFiles`，proposed API） | ✅ | `search.js`；E2E 第 4–5、8 步 |
| 远端工作区配置（`.vscode/settings.json` 生效） | ✅ | E2E 第 6 步（`editor.tabSize=7`） |
| 源代码管理（远端 git：状态/暂存/提交/放弃 + quick diff） | ✅ | `scm.js`；E2E 第 7、9 步 |
| 语言服务（镜像 + 本机 clangd/pylsp：跳转·悬浮·符号·补全·诊断） | ✅ | `lsp.js`；E2E 第 10–11、13 步 |
| 任务（远端 `tasks.json` 在板子上跑，cwd 也在远端） | ✅ | `tasks.js`（类型 `rce-remote`）；E2E 第 12 步 |
| 看整个应用 | ✅ | `bash ide/tools/run-app.sh`（假靶机或真板子，直接开窗口） |

**门禁**：`npm run lint` 0 告警 / `npm run typecheck` 0 错误 / `npm test` **251 通过**（43 文件）。
**端到端**：`bash ide/tools/run-e2e.sh` → **13/13**（报告 `ide/tools/tmp/e2e-report.json`，截图 `ide/tools/shots/e2e-*.png`）。

**本轮修掉的坑（都有"症状 → 根因 → 处置 → 验证"记录）**

1. 镜像同步 5 个真 bug（分段命令拼错、`__FILE__` 分段表头、stdout 污染 gzip、sysroot 探测多一条命令、增量覆盖 compile_commands）——§5.2。
2. E2E 假阴性：脚本固定 `sleep 110` 杀窗口 vs E2E 预算 240s → 改成**轮询等报告**；并写死 `window.restoreWindows: none` 防旧窗口状态带偏。
3. **补全永远 "Loading…"**：窗口恢复阶段的文件请求在上游"不落地"→ snippet 初始化卡死。三处处置：provider 先注册再连、早期请求等会话就绪、上游 `exists()` 加 5s 上限——§5.4。
4. 任务被上游整批丢掉（虚拟工作区禁 shell 任务）→ 自带 `TaskProvider`；另外记了"类型必须注册 `taskDefinitions`，否则按 label 触发会静默失败"——§5.5。
5. 文件监听事件字段名写错（`resource` 应为 `uri`）→ 整条 watch 通道等于没接上——§5.6。

**上游（`ide/vscode`）现状**：由 `ide/tools/apply-branding.mjs` **幂等**维护的补丁包括
`nls.ts` / `bootstrap-esm.ts` 的中文语言包开发版放行、`snippetsService.ts#_existsBounded` 虚拟工作区健壮性，
以及 `build/lib/electron.ts` 的 `RCE_ELECTRON_ARCHIVE` 本地 Electron 打包 resolver；升级上游后重跑即可。
任务那两个试验性补丁已还原（§5.5 有取舍记录）。

**约束变更（用户 2026-10-12）**：目标机"零部署/零常驻"放宽为**"允许极少量必需且轻量"**的远端支撑，
但必须有明确的体积/内存/CPU 预算，绝不允许 VS Code Server 那种几百兆常驻进程。
**当前实现仍然没有任何远端常驻服务**（任务/搜索/git/终端都是一次性连接），这条放宽留作将来按需评估。

**下一步（按优先级）**

1. 任务补齐：`dependsOn`、`problemMatcher`（编译错误进 Problems）、`isBackground`/长期任务、任务交互输入。
2. SCM 补全：历史图 / 分支切换 / stash / push / pull（`GitRemote` 已有方法，接 UI 即可）。
3. 递归 watch 与搜索增强：尊重 `.gitignore`、`includes/excludes/wordMatch`、大仓库性能。
4. 连接管理正式化：`hosts.json` 主机列表、`~/.ssh/config` 解析、私钥选择、重连后的会话恢复。
5. 打包发布：`npm run gulp vscode-linux-x64` + 装机脚本（proposed API 白名单已由 `apply-branding.mjs` 写入 `product.json`）。
6. 收尾噪声：启动期 `ENOPRO` 日志、去 Copilot 遗留的两条 `ERR`；调试/端口转发明确写"不支持"。

---

## 2026-10-13：任务系统补齐（dependsOn / problemMatcher / isBackground）

**范围**：`ide/extensions/sshfs/src/tasks.js`、`ide/extensions/sshfs/src/extension.js`、E2E 靶机任务夹具与单测；
不改上游补丁，任务仍在工作机扩展宿主里发 `SSHConnection.execStream` 到板子上执行。

**为什么不能直接交给 Extension API**：

- `vscode.Task` DTO 不会把 `dependsOn` 传进上游 `configurationProperties`，只把字段塞进 `definition` 任务系统看不到，
  所以依赖图在扩展里执行前校验并顺序/并行执行；
- 上游 `problemMatcher` 最终用 `URI.file()` 建 marker，`sshfs://` 虚拟工作区会落到 `file://`，
  所以常用 matcher 由扩展自己解析，诊断写 `DiagnosticCollection` 到真实 `sshfs://` URI。

**已落地**：

1. `dependsOn` / `dependsOrder`：支持字符串、对象 `{ label }`，顺序/并行都支持；缺失依赖与循环在执行前报错，
   E2E 证明循环任务没有产生远端副作用。
2. `problemMatcher`：支持 `$msCompile`、`$gcc`、`$clang`、`$tsc` / `$tsc-watch` 与常用单行内联 `pattern`；
   E2E 校验 `sshfs://` Problems 诊断（source=`rce-remote-task`）。
3. `isBackground`：交给任务系统维持长任务；E2E 先确认任务没有立刻结束，再通过远端停止标记让它正常退出（code 0）。
4. 任务生命周期日志 + 循环执行前校验；新增 `tests/unit/tasks.test.ts` 6 条纯函数用例。

**验证**：

- `npm run lint`：0 告警
- `npm run typecheck`：0 错误
- `npm test`：**257 通过（44 文件）**
- `bash ide/tools/run-e2e.sh`：**17/17 通过**（报告 `ide/tools/tmp/e2e-report.json`，截图 `ide/tools/shots/e2e-*.png`）

**仍未做**：任务交互输入、多行内联 problem pattern、`tasks.json` 变更热更新；这些不影响当前已验的远端任务链路。

**下一步（覆盖上一快照）**：SCM 历史/分支/stash/pull/push → 搜索与递归 watch 增强 → 连接管理正式化 → 打包发布 → 启动噪声收尾。


---

## 2026-10-13：内置官方简体中文语言包

**目标**：不装扩展、不联网、不碰 `$HOME`，正式程序启动即为简体中文；只开一个窗口。

**根因与处置**：

- 语言包不能只丢进扩展目录：主进程在扩展扫描前就解析 `languagepacks.json`，首次启动会回退英文。
  `ide/tools/ensure-language-pack.mjs` 现在直接预置该文件，并读取当前 `vscode/package.json` 版本，从
  `microsoft/vscode-loc` 对应分支下载同版本 `zh-hans` 包（当前 1.142.0）。
- 源码开发版的 `out` 没有 NLS 索引，`localize()` 拿字符串 key 时不会查语言包。正式运行改为
  `out-vscode` + `--nls` 构建；`nls.ts` / `bootstrap-esm.ts` 也由品牌脚本放开开发版回退。
- 旧工作区、Agents 会话和共享状态会在单实例锁之前恢复，出现多个窗口。`run-app.sh` 每次使用独立的
  `udd-app` 用户目录与 `--shared-data-dir`，并直接以一个进程打开 `sshfs://` 工作区。
- `npm run gulp vscode-linux-x64` 原先会重新从 GitHub 取 Electron。打包支持
  `RCE_ELECTRON_ARCHIVE=<本机 electron zip>`，校验仍使用上游 checksum 文件。
- 去掉 Copilot 后 onboarding 仍会生成透明遮罩并访问缺失的 `defaultChatAgent`，症状是窗口能拖动但
  内容区点不动。品牌脚本给 onboarding 提供安全空配置，启动器再加 `--skip-welcome`，不再显示遮罩。

**产物**：`ide/VSCode-linux-x64/remote-code-editor`；入口仍是 `bash ide/tools/run-app.sh`。
中文包装在 `resources/app/extensions/language-pack-zh-hans`，不向远端部署任何文件。

---

## 2026-10-13：远程连接资源面板改为 VS Code 原生 Remote Explorer

**用户要求**：远程连接资源板块必须和 VS Code 一样，不得自制 UI；必须有“新建远程”的 `+` 按钮。

**处置**：

- 删除自制的活动栏容器 `viewsContainers.activitybar`，不再使用自绘的 `rce.remote.explorer`。
- 通过官方 `contribViewsRemote` 贡献点接入 CodeOSS 内置 `Remote Explorer` 容器，在 `remoteTargets`
  原生 TreeView 中提供 `SSH` 分组、`~/.ssh/config` 主机、当前内存会话与最近目录。
- `+`（新建远程）、齿轮（打开 SSH 配置文件）、刷新、主机/最近目录的在当前窗口/新窗口连接等操作
  全部通过 `view/title` 与 `view/item/context` 菜单贡献，渲染和交互由 CodeOSS 完成。
- `product.json` 正式包 proposed API 白名单增加 `contribViewsRemote`；`build-extension.mjs` 同步到
  已解包的 `VSCode-linux-x64`，避免正式包看不到入口。

**验证**：真实窗口 `ide/tools/shots`/`/tmp/rce-remote-explorer-crop.png` 中可见「远程资源管理器 / 远程(隧道/SSH)」、
`SSH` 分组的 `+`/齿轮、已配置主机和已连接主机；当前会话的最近目录 `ws /ws` 可展开。

**断开后仍显示“已连接”的根因与修复**：断开时会移除 `sshfs://` 工作区，工作台因此重建扩展宿主；
`run-app.sh` 留下的 `RCE_SPIKE_*` 环境变量在新宿主里又被当成首次连接条件，于是立刻自动重连。
现在 `rce.disconnect` 会先写入 `rce.envAutoConnect.suppressed`，下一次宿主重启不会再使用旧环境变量连接；
CodeOSS 自带的“关闭远程连接”也通过 `deactivate()` 补写抑制标记。
隔离 Xvfb 实测：第一次宿主 `已连接`，断开后第二个宿主只启动扩展、不再连接，窗口回到“无打开的文件夹”。

---

## 2026-10-13：按 VS Code 逻辑收敛远程连接交互

**修掉的问题**：

1. 已连接主机在 Remote Explorer 里重复：活动会话原先只按 `spec.host === host.hostName` 匹配，`Host` 别名写成 `user@host` 或配置没有 `HostName` 时会追加第二行。现在统一按 `user@host:port`、别名、HostName 三路匹配，已有配置项只标记“已连接”，不再追加。
2. 连接步骤过多：点击主机行现在直接连接；`~/.ssh/config` 的 `IdentityFile`、`User`、`Port`、`PreferredAuthentications` 会先用，只有认证确实要求时才弹一次密码/私钥口令。不再先问主机、用户名、密码、目录四轮。
3. 工作区选择：连上后使用 VS Code 原生 QuickPick；目录可逐级点，另有“输入路径…”可直接填远端绝对路径，底部“打开此文件夹”确认。
4. 大目录语言服务卡“同步中”：自动镜像前先执行轻量 `find | wc -l`，现在同步只镜像源码文件，默认 `rce.lsp.maxFiles=20000`；普通项目/大 home 会自动完成，只有极端源文件数量才暂停并显示“未同步（N 源文件）”。
5. 重复的“断开连接 / 关闭工作区”：删掉自定义 `statusBar/remoteIndicator` 菜单，只保留 CodeOSS 原生“关闭远程连接”；`rce.disconnect` 也从命令面板隐藏。
6. 新窗口：`sshfs://user@host:port/path` 的窗口会按 authority 查 `~/.ssh/config` 和默认私钥重连，确实需要认证才弹一次，不再打开后一直取不到会话。

**验证**：正式包启动正常；假靶机 8 文件项目镜像仍能完成（8 文件 / 664ms），说明闸门没有影响小项目；14k 文件的 home 只会把可识别的源码/编译数据库送进镜像，不再无限“同步中”。

**补充**：CodeOSS 对 `sshfs://` 走 `virtualWorkspace` 分支，原生菜单标题是“关闭远程工作区”；如果只改文案而不改命令，它只切本地窗口，扩展宿主里的 SessionManager 仍保留连接，Remote Explorer 会继续显示“已连接”。现在 `apply-branding.mjs` 把该分支的 id 改成 `rce.disconnect`，由扩展先清会话、清工作区、刷新 Remote Explorer；`ensure-language-pack.mjs` 同时把显示名统一成“关闭远程连接”。

**第二轮：大目录语言服务与工作区名称**

- 镜像 tar 原先会同步整个工作区；`/home/sunrise` 有 14056 个文件。现在 `MirrorManager` 的同步命令只取语言服务真正需要的 C/C++/Python 源文件、头文件、`compile_commands.json`、构建/环境配置；日志、缓存、扩展目录、二进制不会再进镜像。自动闸门的计数也使用同一套过滤。
- `rce.lsp.maxFiles` 默认提高到 20000；普通 home/项目的源码数量会自动同步，不再要求用户先手动点一次。
- `vscode.workspace.updateWorkspaceFolders` 建立的单文件夹 transient workspace 在上游名称是“无标题（工作区）”。现在单文件夹时 `Workspace.name` 回退为文件夹名，标题栏和 Explorer 根节点显示真实目录名。

**第三轮：语言服务单位从工作区改成项目**

- 新增设计基准 `docs/lsp-mirror-design.md`：镜像只服务于本地 clangd/pylsp，单位是源码项目，不是工作区/home。
- 第一次语言服务请求时，从当前文档目录向上找 `compile_commands.json` / `CMakeLists.txt` / `.git` / Python 项目标记；命中最近目录作为项目根，没有标记就只镜像当前文件目录。
- 手工“重新同步”也改成只同步当前项目，不再在未打开源码时退回镜像整个工作区。

**多连接状态机修复**：

- 已有工作区时再连接新主机，不再用 `updateWorkspaceFolders` 原地替换 remote folder；替换会重建扩展宿主并丢掉内存里的 SessionManager。现在一律新开窗口，新窗口按 `sshfs://authority` 重新建立会话。
- 断开连接时，除了清 SessionManager 和 sshfs folder，还会显式执行 core `workbench.action.remote.close`，让左下角 remote indicator 与工作区一起清空，解决“断开后仍显示 Le@...”的残影。
- 用户明确要求切换主机不要新开窗口：已改成“旧连接存在时先关闭旧会话，再 `vscode.openFolder` 在当前窗口切到新 URI”；新宿主按新 authority 重连。
- 终端 profile 注册 id 从错误的 `rce.remoteTerminal` 对齐为 `contributes.terminal.profiles.id = rceRemote`，修复 `No terminal profile provider registered for id "rceRemote"`。
- 语言服务项目镜像前先按同一套源码过滤计数；项目过大时自动降级为当前文件目录，不再要求用户点状态栏强制。源码 tar 传输增加 120s 上限和 4MB 粒度进度显示，避免无限“同步中”。
- 品牌补丁会修改 `workbench.desktop.main.js` 等内置文件，导致 CodeOSS integrity service 拿旧 checksum 报“织码 WeaveCode 安装似乎损坏”。`build-extension.mjs` 现在按 `product.json.checksums`（路径相对 `resources/app/out/`）重算 SHA-256，启动不再出现假损坏告警。
- 工作区打开不再使用 `updateWorkspaceFolders` 建无标题多根工作区；统一 `vscode.openFolder` 打开正式单目录工作区，并默认关闭 `window.confirmSaveUntitledWorkspace`，不再弹“是否保存工作区配置”。
- 语言服务状态栏文案从内部代号 `RCE 语言服务` 改成 `本机语言服务`，明确它是工作机上的 clangd/pylsp 桥，不是远端常驻服务。
- 工作区打开不再预同步；每个项目自己的 manifest、镜像目录和 LSP 进程按需创建、缓存、复用。
- 假靶机 E2E 仍通过：`17/17`，跳转/悬浮/符号/补全/诊断全通；镜像从 8 个文件降到 3 个源文件。

## 2026-10-13 晚：CodeOSS 主线接管仓库

本轮按新的产品路线完成三件事：

1. **旧 V2 自绘外壳退出主线**
   `src/renderer/`、`src/preload/`、旧 Electron 入口、旧 UI 测试和旧打包配置已删除。保留
   `src/main/**` 与 `src/shared/**` 作为 CodeOSS 扩展复用的 SSH/SFTP/Git/搜索/终端/镜像/LSP 核心。
   旧 V2 规格移到 `docs/legacy/`。

2. **CodeOSS 上游固定为子模块**
   `ide/vscode` 现在是 `microsoft/vscode` 的 git submodule，固定到
   `959031245ebb1fe077e0d512e1397c0ae82006e4`。仓库不再提交 6.6G 的本地克隆、`node_modules`、
   `out*`、`VSCode-linux-x64` 等构建产物；新增 `npm run codeoss:bootstrap`。
   根 `README.md`、`AGENTS.md` 和 `ide/README.md` 已按新目录结构重写。

3. **本机语言服务方案继续落地**
   - 新增 `ide/extensions/sshfs/src/cache.js`：项目级影子缓存，支持总容量、单项目容量、TTL、
     LRU、活跃项目保护、异常退出 staging/tar 清理；
   - 新增设置：`rce.cache.maxSizeMB`、`rce.cache.maxProjectMB`、`rce.cache.ttlDays`、
     `rce.cache.cleanupOnDisconnect`；新增命令“清理本机语言服务缓存”；
   - LSP 能力从补全/跳转/悬浮/符号/诊断扩展到声明、类型定义、实现、引用、重命名、签名帮助、
     文档高亮、Code Action、文档/范围格式化和折叠；
   - Copilot 不再被产品配置主动关闭；保留上游 Copilot/Chat proposed API 白名单，新增
     `ide/tools/install-vsix.sh` 安装官方 VSIX。本仓库不提交专有 VSIX。

验证：

- `npm run lint`：通过；
- `npm run typecheck`：通过；
- `npm test`：147/147 通过（新增影子缓存 3 条）；
- CodeOSS 重新编译并打包：通过；
- `bash ide/tools/run-e2e.sh`：17/17 通过，报告 `ide/tools/tmp/e2e-report.json`，
  截图 `ide/tools/shots/e2e-190619.png`。

当前剩余的真实外部验证是：在你的 VS Code/Copilot 账号下安装官方 VSIX，确认 Copilot 补全在
`sshfs://` 虚拟工作区和真实项目里可用。如果该 VSIX 不支持虚拟工作区，下一步才需要切换到
“本地影子工作区 + 保存回写”模式。

## 2026-10-13 晚：品牌与产品图标

- 项目命名：**织码 WeaveCode**，含义是“把远端、源码、语言服务和 AI 补全织在一起”。
- 新增品牌资产：`resources/brand/weavecode-mark.svg`、明暗字标、1024/512/256 PNG、Windows ICO、
  macOS ICNS；根 `resources/icon.png` / `icon.ico` 也已替换。
- 新增 `ide/tools/generate-brand-assets.py`，可重复生成全部品牌资产。
- `apply-branding.mjs` 会把图标同步到 CodeOSS 的 Linux / Windows / macOS / Server / favicon 路径。
- 可见品牌名统一为“织码 WeaveCode”，内部 extension ID 继续保留
  `remote-code-editor.rce-remote`，避免破坏已有 proposed API 和配置兼容性。
- CodeOSS 已按新 applicationName `weavecode` 重新编译、打包并通过 xvfb 冒烟。
