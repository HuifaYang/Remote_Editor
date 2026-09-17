# AGENTS.md —— 项目记忆（新会话先读这一份）

RemoteCodeEditor：轻量级跨平台 SSH 远程代码编辑器，用于替代 VSCode Remote-SSH，专门适配
嵌入式 ARM 板卡（RK3566 / RK3588 / 香橙派等）。**本地 GUI + SSH/SFTP，远端零常驻服务**
（板卡只用原生 `sshd` / `sftp` / `git`，不部署 Agent / LSP / Node.js）。

技术栈：Python 3.9+ · PySide6 · paramiko · Pygments。

- 项目介绍 / 功能一览 / 快捷键：[README.md](README.md)
- 需求基线（必须做成什么样）：[docs/requirements.md](docs/requirements.md)
- 设计说明（怎么实现、为什么）：[docs/design.md](docs/design.md)
- 开发日志（按日期的工作记录）：[docs/devlog.md](docs/devlog.md)

---

## 1. 常用命令

```bash
QT_QPA_PLATFORM=offscreen python -m pytest -q      # 全量测试（无显示器必须带 offscreen）
python -m pyflakes app tests                       # 静态检查，必须保持 clean
QT_QPA_PLATFORM=offscreen python main.py           # 离屏启动
python3 -m pytest tests/test_main_window.py -q     # 只跑主窗口集成测试
bash scripts/build_linux.sh                        # 打包（另有 build_windows.bat）
```

基线：**315 passed, 24 skipped**（24 个 skip 是需要真实网络/端口的 SSH 端到端用例）。
`tests/test_ssh_end_to_end.py` 会在进程内起真实 SSH/SFTP 服务，沙箱里通常监听不了端口而自动跳过 ——
**不要用 require_escalated 反复重试它**，会卡住。

## 2. 硬性约束（改代码前先看）

- **颜色只能来自 `app/ui/theme.py`**，UI 里禁止硬编码颜色（需求 §5.7.1）。
- **密码 / 私钥口令不落盘**，只存内存；主机配置里不写密码。
- **远端零常驻服务**：不得引入需要远端常驻进程的功能。
- UI 文案与代码注释用**中文**；提交信息也用中文。
- 不新增第三方依赖（当前只有 PySide6 / paramiko / Pygments）。
- 改动要配测试：新增行为加新用例，改行为改对应用例，不要削弱既有断言。

## 3. 架构地图

| 位置 | 职责 |
| --- | --- |
| `app/ui/main_window.py` | **编排层**：只在各组件与后台任务之间转发数据，不写网络 / Git / 文件逻辑 |
| `app/ui/remote_ops.py` | GUI ↔ 远程能力的粘合层（后台任务的统一入口） |
| `app/ui/tasks.py` | `TaskRunner`（QThreadPool），回调经信号切回 GUI 线程 |
| `app/ui/theme.py` | 唯一配色来源 + 统一 QSS，`apply_theme(app, theme)` |
| `app/ui/icons.py` | `QPainter` 现画的 16px 单色线条图标（无图标字体 / SVG 资源，带 2 倍图） |
| `app/ui/widgets/` | `activity_bar`（活动栏）· `welcome`（起始页）· `file_tree`（文件树）· `scm_view`（源代码管理）· `badge`（变更徽标 Delegate）· `editor_tabs` · `search_bar` · `status_bar` · `log_view` |
| `app/remote/` | `ssh_client`（会话 + 锁）· `sftp_client`（列目录 / 上下行 / 原子写）· `remote_fs`（门面 + 指纹 + 路径规范化）· `session` |
| `app/git/` | `git_client`（远端 git 命令 + `TreeStatus` 快照）· `diff_parser`（纯函数）· `models` |
| `app/editor/` | `editor`（CodeEditor：行号 / Gutter / 搜索替换）· `document`（文档模型）· `syntax` · `git_decorations` |
| `app/config/` | `settings`（含版本迁移）· `hosts`（不存密码） |
| `app/utils/` | `errors` · `paths` · `encoding` · `ssh_keys`（本机 `~/.ssh` 识别 / config 导入） |

## 4. 性能不变量（本项目最容易踩的坑）

远端板卡经 WiFi 接入，**单次往返约 1 秒**，一次 SFTP 列目录 ≈ 3~4 个往返。改任何与远端交互的
代码前，先数清楚「这一改会多发几次请求」：

- 打开工作目录 = 2 条 git 命令；**打开未修改的文件 = 0 条**；已修改文件 = 1 条 `git diff`；
  保存 / 删除后 = 0 条（用 `TreeStatus.mark_saved/mark_removed/mark_clean` 本地更新）。
  这个预算由 `tests/test_git_client.py` 断言，别改坏。
- 列目录：`_pending_listings` 去重 → `_dir_cache`（TTL 120s，上限 200）→ `_prefetch_children`（最多 3 个）。
  **本地新建 / 删除 / 重命名 / 切换工作目录 / `F5` 都必须失效对应缓存**。
- 打开源代码管理面板**不允许**产生远端请求：它渲染的是文件树已有的那份 `TreeStatus` 快照。
- 语言不是瓶颈（Python 足够），**不要提议用 C++/Rust 重写**。

## 5. 界面约定（仿 VSCode）

- 活动栏（44px 图标列）切换侧边栏视图，`files` / `source-control` 互斥，再点一次收起；
  视图注册在 `MainWindow._side_views`，加视图不用改布局代码。
- 没有打开的标签页 → 编辑区显示欢迎页；未连接时「打开远程文件夹」不可用（先连接、再选目录）。
- 文件树只有一列文件名（大小 / 时间 / 权限在 Tooltip）；变更状态用**行右端画出来的徽标**
  （`widgets/badge.py`，字母黑白按底色亮度自动选），不要退回「名称后面拼字母」。
- 顶部工具栏 `ToolButtonIconOnly`，文字保留在 QAction 上供菜单与读屏使用。
- 图标新增一个名字即可：在 `app/ui/icons.py` 写 `_draw_xxx` 并注册到 `DRAWERS`，
  `tests/test_icons.py` 会自动覆盖「所有图标都画出了非空像素」。

## 6. 测试约定

- Qt 测试统一用 `pytest-qt` 的 `qtbot`，跑测试必须带 `QT_QPA_PLATFORM=offscreen`。
- `tests/fakes.py` 提供 `FakeSession` / `FakeGitClient` / `DEFAULT_ROOT`；`session.git.status_lines`
  写 `{"src/main.c": " M"}` 这样的 porcelain 状态即可模拟 Git。
- `tests/test_main_window.py` 是集成层（fixture `wired` = 已连接的窗口），新 UI 行为优先在这里加用例。
- 用 `qtbot.waitUntil(lambda: ...)` 等异步结果，回调必须返回 `True/False/None`（返回其它值会报错）。

## 7. 当前状态与遗留

- 已完成：连接弹窗布局与本机 `~/.ssh` 集成、Git 往返预算优化、目录缓存与预取、自动保存默认开启、
  「撤销回原样后标记仍发黄」修复、VSCode 式界面外壳（活动栏 / 欢迎页 / 源代码管理 / 徽标 / 图标）。
- 已知限制：不调用 `ssh-agent`；`~/.ssh/config` 只识别 `Host/HostName/Port/User/IdentityFile`；
  单文件默认上限 32MB；远端零服务。详见 design.md §6。
- 未做：`Ctrl+B` 快捷键收起侧边栏、SCM 的暂存区 / 分组、**插件机制**（方向见 design.md §7，本版本明确不实现）。
- 明确不做：Git 账号登录 / 上游仓库对比（远端只经 SSH 可达，与「密码不落盘」冲突）；
  用 C++/Rust 重写。

## 8. 与用户协作的习惯

- 用户中文交流，回复要**简短**、先给结论；改动求**最小外科式**，别顺手重构无关代码。
- 遇到「慢 / 卡」先看日志里每条操作耗时，判断是往返次数问题还是本地问题，再动手。
- 不要主动 `git commit` / 建分支，除非用户明确要求。
