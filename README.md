# RemoteCodeEditor

轻量级跨平台 SSH 远程代码编辑器，用于替代 VSCode Remote-SSH，
专门适配**嵌入式弱性能 ARM Linux 板卡**（RK3566 / RK3588 / 香橙派等）开发场景。

- **本地重计算、远程零负载**：GUI 渲染、代码编辑、语法高亮、Git Diff 解析、文件缓存全部在本地 PC 完成。
- **远端零常驻服务**：板卡只需原生 `sshd`、`sftp`、`git` 与标准 Linux 文件系统，不部署任何 Agent / LSP / Node.js 服务。
- **免环境运行**：Windows `RemoteCodeEditor.exe` + Ubuntu `RemoteCodeEditor.AppImage`，双击即用，无需 Python 环境。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| SSH 主机管理 | 侧边栏「远程资源管理器」：主机列表 + 每台机器的历史工作目录，**单击主机即连**、点历史目录直接连上并打开；新增 / 编辑 / 删除 / 从 `~/.ssh/config` 导入；密码不落盘，凭据输入行就在面板底部（不弹居中对话框） |
| 界面布局 | 仿 VSCode：**自绘标题栏**（无系统标题栏，菜单 + 标题 + 窗口按钮都在里面，能拖动 / 双击最大化 / 拖边缘缩放）、最左活动栏（图标切换资源管理器 / 源代码管理 / 远程资源管理器，再点一次收起）、侧边栏、标签页编辑区、底部终端面板；未连接或未打开文件时显示欢迎页，「打开远程文件夹」仅在连接后可用 |
| 终端 | 底部面板多页签终端（对齐 VSCode Panel），``Ctrl+` `` / `Ctrl+J` 开关、``Ctrl+Shift+` `` 新建；连的是远端 sshd 自带的 shell 通道（**远端零常驻服务**），PTY 窗口大小随面板同步（`htop`、`vim` 能正常全屏重排）。渲染是自绘字符网格：有真实 GPU 环境走 `QOpenGLWidget` 合成，无 GL / 离屏时自动退回软渲染（两条路径共用同一份绘制代码）；支持 16 / 256 色与真彩、加粗 / 暗淡 / 斜体 / 下划线 / 反显、宽字符（中文）两格对齐、回滚 5000 行、选区复制粘贴 |
| 外观资源自带 | 随程序分发：**JetBrains Mono**（编辑器等宽）、**GitHub Dark / Light 全系 9 套配色**、**Material Icon Theme**（文件图标）；都从 `assets/` 加载，**不依赖目标机器装了什么**。想加自己的：把 VSCode 主题 / 图标主题 / 字体丢进「设置 → 外观 → 资源目录」（见[打包与资源替换](docs/packaging.md)），不用改代码。缺失 / 损坏 / 没定义都逐项回退，不影响运行 |
| 主题切换 | 「设置 → 外观 → 主题」或「视图 → 主题」即时切换并记住选择；颜色只来自 `app/ui/theme.py`，外部主题 JSON 会映射到同一套字段（`#rrggbbaa` 透明度按编辑器底色合成）；同一处可切换「文件图标」主题 |
| 现代控件外观 | Qt 原生（Fusion）的立体滚动条 / 三角箭头 / 凸起微调按钮 / 带描边 GroupBox 全部被主题 QSS 接管：扁平、无边框、紧凑，对齐 VSCode；界面字号统一 10pt，`Ctrl+=` / `Ctrl+-` / `Ctrl+0` 做全局缩放（界面与编辑器一起） |
| 远程文件树 | 仿 VSCode 单列（只有文件名，不会被大小 / 时间挤成 `command_handl…`）、22px 紧凑行、目录在前按名排序、行右端绘制变更徽标；顶栏为纯图标按钮（新建文件 / 新建文件夹 / 刷新 / 折叠）；目录懒加载、右键新建 / 删除 / 重命名 / 刷新 / 属性 / 复制路径；大小与时间在 Tooltip |
| 文件树 Git 着色 | VSCode 式：未变更不着色，新增绿 / 修改黄 / 删除红，目录按子树内最高优先级变更着色；撤销回原样并保存后标记自动撤掉 |
| 源代码管理面板 | 活动栏的 SCM 视图列出与远端仓库不同的文件（相对仓库根路径 + 变更徽标），**打开面板不发任何远端请求**（复用文件树已有的 Git 快照），点文件名直接打开，右上角刷新等价 `Shift+F5` |
| 工作目录 | 连接成功后再选择要打开的远端文件夹（VSCode 式；`Ctrl+O` 随时切换），选择结果按主机记住，下次自动打开 |
| 编辑与保存 | 多标签、行号、当前行高亮、自动缩进、Tab/空格适配、撤销重做、搜索替换（支持正则）、未保存标记；`Ctrl+=` / `Ctrl+-` / `Ctrl+0` 全局缩放（界面与编辑器一起，0.7~2.0 倍），编辑器基础字号在设置里调（8~32）；**默认开启自动保存**（停手 1.5s 自动上传，可在设置里关闭或调延迟） |
| 文件同步 | 本地编辑、`Ctrl+S` 经 SFTP 上传；上传采用临时文件 + 原子重命名，避免中断损坏远端源码 |
| Git 行级标记 | Gutter 彩色标记相对 `HEAD` 的新增 / 修改 / 删除行；非仓库时状态栏提示 |
| 打开速度 | 一次限定工作目录范围的 `git status` 快照同时供文件树着色与单文件 diff 复用：打开未修改的文件 **0 个远端 Git 命令**，已修改的文件只跑 1 次 `git diff`，保存 / 删除后按本地知识更新标记、不再重扫仓库；目录列举去重 + 120 秒缓存 + 后台预取子目录，高延迟链路下展开目录不再每次等 3~4 秒 |
| 编码兼容 | UTF-8 / UTF-8 BOM / ASCII 自动识别，识别失败时弹窗手动选择，保存沿用原编码与 BOM |
| 冲突保护 | 远端文件被外部修改时弹窗三选一（重新加载 / 覆盖 / 取消），绝不静默覆盖 |
| 全程不卡顿 | 连接、列目录、上下行、Git 查询、文件解析全部异步执行，UI 线程只做渲染 |

## 典型流程

1. 启动客户端 → 欢迎页点「连接主机」，或直接点活动栏的「远程资源管理器」，在侧边栏里**单击主机名即连**
   （也能新增主机 / 从 `~/.ssh/config` 导入；需要密码或私钥口令时，输入行就在面板底部）
2. 连接成功后点「打开远程文件夹…」，在远端选择要打开的文件夹（默认定位家目录，记住后下次自动打开；
   之后这台主机的历史目录会出现在侧边栏的展开项里，点一下 = 连上并打开）
3. 浏览远程目录树，打开源码文件并全本地编辑（零网络请求）
4. `Ctrl+S` 保存，经 SFTP 上传覆盖远端文件
5. 编辑器左侧 Gutter 实时显示相对 `HEAD` 的新增 / 修改 / 删除行标记
6. ``Ctrl+` `` 打开底部终端，直接在板卡上跑 `make -j4` / `htop` / `git log`（终端走 SSH shell 通道，远端不装任何东西）

## 快速开始

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python main.py            # 或 python -m app.main
```

要求 Python 3.9+。Linux 上需要 Qt 运行期依赖（Ubuntu 桌面版通常已自带 `libxcb-cursor0` 等）。

### 打包

每个平台都出**免安装版**与**安装版**两种产物：

| 平台 | 命令 | 免安装版 | 安装版 |
| --- | --- | --- | --- |
| Windows 10/11 | `scripts\build_windows.bat` | `dist\RemoteCodeEditor.exe`（单文件、无控制台、内嵌图标） | `dist\RemoteCodeEditor_<版本>_setup.exe`（装了 NSIS 时自动生成，也可单独跑 `scripts\build_windows_installer.bat`） |
| Ubuntu 22.04+ | `bash scripts/build_linux.sh` | `dist/RemoteCodeEditor.AppImage` | `dist/RemoteCodeEditor_<版本>_<架构>.deb`（`sudo apt install ./xxx.deb`，也可单独跑 `scripts/build_deb.sh`） |

Windows 脚本会先校验 Python 版本、按需安装打包依赖、清理旧产物、生成图标，再调用 PyInstaller。
Linux 脚本先打单文件，接着组装 `.deb`（`/usr/bin/remote-code-editor` + 桌面项 + 图标 +
AppStream 元数据 + 依赖声明），最后组装 `AppDir` 并调用 `appimagetool`；本机没有
`appimagetool` 时会自动下载到 `tools/`，下载失败则保留已就绪的 `AppDir` 并打印手动打包命令，
不中断流程（`.deb` 已经产出）。可用 `SKIP_DEB=1` / `SKIP_APPIMAGE=1` 只打其中一种。
两个平台脚本都通过 `--paths .` 保证 `app` 包可导入，并排除未使用的 Qt 模块
（WebEngine / Qml / Quick / Multimedia / Sql / 3D 等）与 PyQt、tkinter、numpy，以控制体积。

### 替换外观资源（打包后依然有效）

内置的字体 / 配色主题 / 文件图标主题跟着程序走；要**自己加**，把文件放进用户配置目录：

| 资源 | 位置 | 放什么 |
| --- | --- | --- |
| 配色主题 | `<配置目录>/themes/` | VSCode 主题 JSON（GitHub Dark 等原文件直接用） |
| 字体 | `<配置目录>/fonts/` | `.ttf` / `.otf` / `.ttc` / `.otc` |
| 文件图标主题 | `<配置目录>/icon-themes/<主题名>/` | 一套 VSCode 文件图标主题 |

`<配置目录>` 在 Linux 是 `~/.config/remote-code-editor/`，Windows 是
`%APPDATA%\RemoteCodeEditor\`。**不用记**：菜单「视图 → 设置 → 外观 → 资源目录」直接显示
这个路径，点「打开」会自动建好三个子目录并打开文件管理器。用户目录里的资源是**新增**，
不覆盖内置同名主题。细节与自查清单见 [docs/packaging.md](docs/packaging.md)。

## 键盘快捷键

| 快捷键 | 功能 | 快捷键 | 功能 |
| --- | --- | --- | --- |
| `Ctrl+K` | 连接主机 | `Ctrl+O` | 打开远程文件夹 |
| `Ctrl+F` | 查找 | `Ctrl+H` | 替换 |
| `Ctrl+S` | 保存当前文件 | `Ctrl+Shift+S` | 全部保存 |
| `F3` / `Shift+F3` | 查找下一个 / 上一个 | `Ctrl+G` | 转到行 |
| `Ctrl+W` | 关闭当前标签 | `Ctrl+,` | 设置 |
| `Ctrl+Q` | 退出 | `F5` | 刷新工作目录 |
| `Shift+F5` | 刷新 Git 标记 | `Esc` | 关闭搜索栏 |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 | `Ctrl+X/C/V/A` | 剪切 / 复制 / 粘贴 / 全选 |
| `Tab` / `Shift+Tab` | 缩进 / 反缩进 | | |
| `Ctrl+=` / `Ctrl+-` | 放大 / 缩小整个界面 | `Ctrl+0` | 重置界面缩放 |
| ``Ctrl+` `` / `Ctrl+J` | 开关终端面板 | ``Ctrl+Shift+` `` | 新建终端 |
| `Shift+PgUp` / `Shift+PgDn` | 终端翻页 | `Ctrl+Shift+C` / `Ctrl+Shift+V` | 终端复制 / 粘贴 |

## 项目结构

```
remote-code-editor/
├── main.py                     # 打包入口（转发到 app.main）
├── app/
│   ├── main.py                 # 程序入口：QApplication / 主题 / 主窗口
│   ├── ui/                     # 界面组件（主窗口、连接与主机管理、工作目录选择、设置）
│   │   ├── theme.py            # 唯一配色来源 + VSCode 主题 JSON 加载
│   │   ├── fonts.py            # 内置字体注册（assets/fonts）
│   │   ├── icon_theme.py       # 文件图标主题（assets/icon-themes，SVG/PNG）
│   │   ├── resources.py        # 用户可替换资源目录（打包后仍可新增主题/字体/图标）
│   │   ├── icons.py            # 工具栏自绘 16px 线条图标
│   │   └── widgets/            # 活动栏 / 文件树 / 源代码管理 / 主机列表 / 终端 / 自绘标题栏
│   ├── editor/                 # 编辑器核心、语法高亮、Git 标记渲染
│   ├── terminal/               # 终端内核：VT 屏幕模型（转义序列）与按键映射（纯 Python）
│   ├── remote/                 # SSH / SFTP / 远程文件系统 / 会话 / 交互式 shell 通道
│   ├── git/                    # Git 命令、Diff 解析与行级标记
│   ├── config/                 # 设置与主机列表持久化
│   ├── cache/                  # 本地缓存
│   └── utils/                  # 日志脱敏、异常、路径、编码、~/.ssh 扫描
├── docs/                       # 需求基线 / 设计说明 / 打包与资源替换 / 开发日志
├── assets/                     # 随程序分发的资源：图标、内置字体、主题、文件图标主题
│   ├── fonts/                  # 放入 .ttf/.otf 即自动注册（详见目录内 README）
│   ├── themes/                 # VSCode 格式配色主题 JSON
│   └── icon-themes/            # VSCode 格式文件图标主题（每个主题一个子目录）
├── AGENTS.md                   # 项目记忆（协作 agent 与新人上手指引）
├── tests/                      # 单元测试 + 真实 SSH/SFTP 端到端测试
├── scripts/                    # 跨平台打包脚本（AppImage / deb / exe / NSIS 安装包）与图标生成
├── requirements.txt / pyproject.toml / LICENSE
```

各模块职责与实际文件清单见设计文档的目录结构一节。

## 文档

- [docs/requirements.md](docs/requirements.md) —— 需求基线：硬性约束、功能边界、功能需求、打包交付、代码质量、验收标准。
- [docs/design.md](docs/design.md) —— 设计说明：技术选型论证、架构分层、关键实现、测试策略、已知限制。
- [docs/packaging.md](docs/packaging.md) —— 打包与资源替换：免安装版 / 安装版怎么打，主题 / 字体 / 文件图标主题放哪里。
- [docs/devlog.md](docs/devlog.md) —— 开发日志：按日期记录当天做了什么、为什么这么做、验证结果与遗留事项。
- [AGENTS.md](AGENTS.md) —— 项目记忆：常用命令、硬性约束、架构地图、性能不变量与当前状态（供协作 agent / 新同学快速上手）。

代码注释中的「需求 §5.10」「需求 §5.13」等编号指向需求基线文档。

## 许可证

MIT，见 `LICENSE`。
