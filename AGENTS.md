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
bash scripts/build_linux.sh                        # 打包：AppImage（免安装）+ .deb（安装版）
bash scripts/build_deb.sh                          # 只要 .deb（复用已打好的 dist/RemoteCodeEditor）
SKIP_DEB=1 bash scripts/build_linux.sh             # 只要 AppImage
# Windows: scripts\build_windows.bat（免安装 exe，装了 NSIS 会顺带出 setup.exe）
#          scripts\build_windows_installer.bat（只要安装包，需要 makensis）
```

基线：**521 passed, 27 skipped**（27 个 skip 是需要真实网络/端口的 SSH 端到端用例，
沙箱里 socket 被禁所以全跳过；在外面跑这 27 个是真的会用真实 paramiko 服务端验证）。
`tests/test_ssh_end_to_end.py` 会在进程内起真实 SSH/SFTP 服务，沙箱里通常监听不了端口而自动跳过 ——
**不要用 require_escalated 反复重试它**，会卡住。

## 2. 硬性约束（改代码前先看）

- **颜色只能来自 `app/ui/theme.py`**，UI 里禁止硬编码颜色（需求 §5.7.1）。
- **密码 / 私钥口令不落盘**，只存内存；主机配置里不写密码。
- **远端零常驻服务**：不得引入需要远端常驻进程的功能。
- UI 文案与代码注释用**中文**；提交信息也用中文。
- 不新增第三方依赖（当前只有 PySide6 / paramiko / Pygments）。
- 改动要配测试：新增行为加新用例，改行为改对应用例，不要削弱既有断言。

> **以上是默认约束，不是绝对禁令**：只要**用户明确允许**，可以按需破限（例如临时引入
> 某个依赖、为验证效果写一次性脚本、调整既有配色）。破限时要做三件事：
> ① 在动手前说清「破的是哪条、为什么不得不破」；② 尽量把影响限制在一处并写注释说明；
> ③ 事后再问用户是保留还是回退。**用户没点头时一律按默认约束执行。**

## 3. 架构地图

| 位置 | 职责 |
| --- | --- |
| `app/ui/main_window.py` | **编排层**：只在各组件与后台任务之间转发数据，不写网络 / Git / 文件逻辑 |
| `app/ui/remote_ops.py` | GUI ↔ 远程能力的粘合层（后台任务的统一入口） |
| `app/ui/tasks.py` | `TaskRunner`（QThreadPool），回调经信号切回 GUI 线程 |
| `app/ui/theme.py` | 唯一配色来源 + 统一 QSS，`apply_theme(app, theme)`；另负责加载 VSCode 格式的外部主题 JSON，以及启动时下发界面字号 `apply_ui_font(app)` |
| `app/ui/fonts.py` | 内置字体注册（`assets/fonts/`），等宽字体优先选内置的 |
| `app/ui/icon_theme.py` | 文件图标主题（`assets/icon-themes/`，VSCode 图标主题规范，SVG 走自带的 `QtSvg`） |
| `app/ui/resources.py` | **用户可替换资源目录**（`<配置目录>/{themes,fonts,icon-themes}`）+ `open_resource_dir()`；设置对话框「外观 → 资源目录」用 |
| `app/ui/icons.py` | 优先用 `assets/ui-icons/` 里的 **Codicons SVG**（VSCode 官方图标集，`currentColor` 换成主题色后交给 `QtSvg`），没有对应 SVG 时回退 `QPainter` 手画 |
| `app/ui/widgets/` | `fade_button`（悬停淡入淡出按钮）· `peek_diff`（gutter 点击弹出的差异浮层）· `markdown_preview`（Markdown 渲染）· `activity_bar`（活动栏）· `welcome`（起始页）· `file_tree`（文件树）· `scm_view`（源代码管理）· `badge`（变更徽标 Delegate）· `editor_tabs` · `search_bar` · `status_bar` · `log_view` · `hosts_view`（远程资源管理器）· `title_bar`（自绘标题栏 + 边缘缩放过滤器）· `terminal_canvas` / `terminal_view` / `terminal_panel`（终端） |
| `app/terminal/` | `screen`（VT100/xterm 子集的屏幕模型，纯 Python）· `keys`（按键 → 转义序列，纯函数） |
| `app/remote/` | `ssh_client`（会话 + 锁）· `sftp_client`（列目录 / 上下行 / 原子写）· `remote_fs`（门面 + 指纹 + 路径规范化）· `session` · `shell_channel`（交互式 shell + PTY，终端用） |
| `app/git/` | `git_client`（远端 git 命令 + `TreeStatus` 快照）· `diff_parser`（纯函数）· `models` |
| `app/editor/` | `editor`（CodeEditor：行号 / Gutter / 搜索替换）· `document`（文档模型）· `syntax` · `git_decorations` |
| `app/config/` | `settings`（含版本迁移）· `hosts`（不存密码） |
| `app/utils/` | `errors` · `paths` · `encoding` · `ssh_keys`（本机 `~/.ssh` 识别 / config 导入） |
| `assets/` | 随程序分发的资源：`ui-icons/`（Codicons，CC-BY 4.0）· `icon.png/.ico` · `fonts/`（内置字体）· `themes/`（VSCode 主题 JSON）· `icon-themes/`（VSCode 文件图标主题）；打包脚本已 `--add-data assets` |

打包后 `assets/` 在临时目录里改不了，所以外观资源**用户可放「配置目录」下新增**（详见
[docs/packaging.md](docs/packaging.md)）：`themes/` · `fonts/` · `icon-themes/`。
扫描顺序是「内置 → 用户」，**同名不覆盖内置**；设置 → 外观 → 「资源目录」可直接打开该目录。

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

- **没有系统标题栏**：`widgets/title_bar.py` 自绘（菜单栏 + 标题 + 窗口按钮），拖动 / 双击最大化 /
  边缘缩放都在那里实现。菜单栏必须是 `QMainWindow.menuBar()` 建出来的**那一个**（标题栏收养 +
  显式 `show()`），别自己 `new QMenuBar()`（会顶掉菜单）。**新面板不要用 `QDockWidget`** ——
  无边框窗口里游离 dock 会浮到左上角盖住菜单；贴边面板用布局或 `QSplitter`。
- 活动栏（44px 图标列）切换侧边栏视图，`files` / `source-control` / `hosts` 互斥，再点一次收起；
  视图注册在 `MainWindow._side_views`，加视图不用改布局代码。
- 终端面板在编辑区下方的竖直 `QSplitter` 里（`MainWindow.editor_column`），默认隐藏；
  `Ctrl+`` / `Ctrl+J` 开关、`Ctrl+Shift+`` 新建。终端字号 = 编辑器字号 × 全局缩放。
- 没有打开的标签页 → 编辑区显示欢迎页；未连接时「打开远程文件夹」不可用（先连接、再选目录）。
- 文件树只有一列文件名（大小 / 时间 / 权限在 Tooltip）；变更状态用**行右端画出来的徽标**
  （`widgets/badge.py`，字母黑白按底色亮度自动选），不要退回「名称后面拼字母」。
- 顶部工具栏 `ToolButtonIconOnly`，文字保留在 QAction 上供菜单与读屏使用。
- 图标新增一个名字即可：在 `app/ui/icons.py` 写 `_draw_xxx` 并注册到 `DRAWERS`，
  `tests/test_icons.py` 会自动覆盖「所有图标都画出了非空像素」。
- 资源管理器里的**文件 / 文件夹图标**来自「文件图标主题」（`icon_theme.py`），与上面那套自绘
  工具栏图标是两回事；换主题走设置对话框「外观 → 文件图标」或直接写 `settings.icon_theme`。
  主题缺失 / 某类型没定义都回退系统图标，**不要**让缺失主题变成启动错误。
- **控件外观（滚动条 / 下拉箭头 / 微调按钮 / 勾选框 / GroupBox …）统一在 `theme.py` 的 QSS 里
  接管**，不要在业务代码里为了样式写 `setStyleSheet`；提示文字用 `muted` /
  `severity="error"` 属性 + `refresh_style(widget)`，颜色仍然只来自主题。
- **不要在控件已经建好之后改 `QApplication` 字体，也不要把应用样式表清零**：本机 Qt/PySide
  会在**下一次** `setStyleSheet()` 上段错误（整进程 `Segmentation fault`）。
  界面字号只在启动阶段由 `apply_ui_font(app)` 设一次（`app/main.py`），且必须用磅值 ——
  徽标 / 小节标题按「父字体 ± 固定磅值」计算，父字体只有像素大小时会算崩；
  运行期缩放只改 QSS 的 `font-size`。测试里要「带主题的 QApplication」就用
  `tests/conftest.py` 的 `themed_app` fixture（收尾恢复成 `previous or NEUTRAL_STYLESHEET`，
  不要写 `app.setStyleSheet("")`）。
- 换主题的入口有两条：「设置 → 外观 → 主题」与「视图 → 主题」子菜单，两者都写回配置；
  `_apply_settings_to_ui()` 是唯一的分发点，新组件要在这里接上 `apply_theme`。
- **列表项里不要自己手画文字**（`badge.py` 曾因此让着色行文件名画两遍而花屏）：要么让基类画，
  要么用 `subElementRect` 收窄它的可用区，别清空 `option.text` 后另起一套排版。
- 字体 / 主题 / 图标主题都是**用户可下载放入**的资源，解析代码必须容错：坏 JSON、缺文件、
  目录不存在都要安全跳过。另外 `QFontDatabase` 与 `QPixmap` 在没有 `QApplication` 时会
  让 Qt abort，调用前要判空。

## 6. 测试约定

- Qt 测试统一用 `pytest-qt` 的 `qtbot`，跑测试必须带 `QT_QPA_PLATFORM=offscreen`。
- `tests/fakes.py` 提供 `FakeSession` / `FakeGitClient` / `DEFAULT_ROOT`；`session.git.status_lines`
  写 `{"src/main.c": " M"}` 这样的 porcelain 状态即可模拟 Git。
- `tests/test_main_window.py` 是集成层（fixture `wired` = 已连接的窗口），新 UI 行为优先在这里加用例。
- 用 `qtbot.waitUntil(lambda: ...)` 等异步结果，回调必须返回 `True/False/None`（返回其它值会报错）。
- 终端测试在离屏平台**只能覆盖软渲染路径**（`gpu_rendering_available()` 为 `False`），
  GPU 那条分支只断言「能选中 `GpuTerminalCanvas` 且与软渲染共用同一份绘制代码」。
- 终端绘制断言不比整幅截图（字体不同结果就不同），只断言「该有笔画的地方有笔画、该没有的地方没有」。
- 终端视图 / 面板不认识网络：测试用假通道（`start_reader` / `write` / `resize` / `close`）注入数据；
  集成测试 monkeypatch `app.ui.main_window.ShellChannel`，**不要**去连真 SSH。

## 7. 当前状态与遗留

- 已完成：连接弹窗布局与本机 `~/.ssh` 集成、Git 往返预算优化、目录缓存与预取、自动保存默认开启、
  「撤销回原样后标记仍发黄」修复、VSCode 式界面外壳（活动栏 / 欢迎页 / 源代码管理 / 徽标 / 图标）、
  「有改动的文件名花屏」修复、自带外观资源（内置字体 / VSCode 主题 JSON / 文件图标主题 + 切换入口）、
  全局缩放（`Ctrl+=/-/0`）、用户可替换资源目录（`app/ui/resources.py` + 设置里「资源目录」入口）、
  双形态打包（免安装 AppImage/exe + 安装版 .deb/NSIS）、**自绘标题栏**（`widgets/title_bar.py`）、
  连接入口改侧边栏**「远程资源管理器」**（`widgets/hosts_view.py`，主机 + 历史工作目录 + 底部凭据行）、
  **底部集成终端**（`app/terminal/` + `app/remote/shell_channel.py` + `widgets/terminal_*`，
  自绘字符网格、GPU / 软渲染双路径）、**界面现代化**（Codicons 图标 / 底色层次 / 字体抗锯齿 /
  悬停淡入淡出 / 真正的全局缩放 / 界面与代码字号统一）、**gutter 点击查看与上一版差异**、
  **Markdown 渲染预览**（`widgets/markdown_preview.py`）、**源代码管理可提交**
  （`GitClient.commit_all` = 全部暂存后提交）。
- 已知限制：不调用 `ssh-agent`；`~/.ssh/config` 只识别 `Host/HostName/Port/User/IdentityFile`；
  单文件默认上限 32MB；远端零服务；终端是「够用子集」（无鼠标上报 / DEC 字符集重映射），
  GPU 渲染路径在无显示器的环境没法实测（离屏平台自动走软渲染）。详见 design.md §6。
- 未做：`Ctrl+B` 快捷键收起侧边栏、SCM 的**暂存区**（当前只有「全部暂存后提交」）、
  Markdown 预览里的远端图片（相对路径的图片不会加载）、**插件机制**（方向见 design.md §7，
  本版本明确不实现）。
- `assets/` 已入库 JetBrains Mono（5 个 TTF）、GitHub Dark/Light 全系 9 套主题、
  Material Icon Theme（1251 个 SVG，保持上游 `dist/` 布局）：**换主题/字体/图标不要改代码**，
  按各目录的 README 放文件即可；新增资源记得带上许可文件。
- 明确不做：Git 账号登录 / 上游仓库对比（远端只经 SSH 可达，与「密码不落盘」冲突）；
  用 C++/Rust 重写。

## 8. 与用户协作的习惯

- 用户中文交流，回复要**简短**、先给结论；改动求**最小外科式**，别顺手重构无关代码。
- 遇到「慢 / 卡」先看日志里每条操作耗时，判断是往返次数问题还是本地问题，再动手。
- 不要主动 `git commit` / 建分支，除非用户明确要求。
