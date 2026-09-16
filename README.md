# RemoteCodeEditor

轻量级跨平台 SSH 远程代码编辑器（V1.0），用于替代 VSCode Remote-SSH，
专门适配**嵌入式弱性能 ARM Linux 板卡**（RK3566 / RK3588 / 香橙派等）开发场景。

- **本地重计算、远程零负载**：GUI 渲染、语法高亮、Git Diff 解析、文件缓存全部在本地 PC 完成。
- **远端零常驻服务**：板卡只需原生 `sshd`、`sftp`、`git`，不部署任何 Agent / LSP / Node.js 服务。
- **交付形态**：Windows `RemoteCodeEditor.exe` + Ubuntu `RemoteCodeEditor.AppImage`，双击即用，无需 Python 环境。

---

## 1. 需求分析摘要

### 1.1 硬性约束（不可协商）

| 编号 | 约束 | 落地方式 |
| --- | --- | --- |
| H1 | 纯桌面 GUI 应用，非 Web / 插件 / 终端工具 | PySide6 (Qt6) 桌面程序 |
| H2 | Windows 与 Ubuntu 双平台，免环境运行 | PyInstaller `--onefile`；Linux 再封装 AppImage |
| H3 | 远端禁止常驻进程 | 仅通过 SSH 执行一次性 `git` 命令 + SFTP 传输 |
| H4 | 不依赖系统 OpenSSH 命令行 | paramiko 纯代码封装 SSH/SFTP |
| H5 | 密码禁止明文落盘/落日志 | 配置不持久化密码；日志统一 `SecretRedactor` 脱敏 |
| H6 | UI 全程不阻塞 | 所有网络/IO 走 `QThreadPool`，回调切回 GUI 线程 |

### 1.2 V1.0 功能边界（明确不做）

LSP 补全与语义分析、调试器、编译运行系统、Docker、终端集成、远程索引、插件系统、AI 助手。
V1.0 只聚焦：**远程浏览、编辑、保存、语法高亮、Git 行级差异标记**。

### 1.3 核心场景

1. 启动客户端 → 选择/新增板卡 SSH 连接
2. 连接成功后可视化浏览远程目录树
3. 打开源码文件，全本地编辑（零网络请求，无卡顿）
4. `Ctrl+S` 经 SFTP 上传覆盖远程文件（保存前做冲突检测）
5. 编辑器左侧 Gutter 实时显示相对 `HEAD` 的新增/修改/删除行标记

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

选型优先级遵循需求 §4.3：稳定性 → 开发效率 → 跨平台兼容性 → 性能 → 扩展性 → 技术新颖度。

---

## 3. 架构

### 3.1 链路

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

### 3.2 分层职责

| 层 | 职责 | 约束 |
| --- | --- | --- |
| UI 层 | 控件装配、用户交互、状态呈现 | 不做业务逻辑；`main_window.py` 只做编排 |
| 异步层 | 把阻塞调用搬到子线程，结果回主线程 | UI 线程永不执行网络/IO |
| 能力层 | SSH/SFTP、Git 解析、缓存、编码、文件模型 | 独立可测，与 Qt 控件解耦 |
| 工具层 | 日志、配置、异常、路径 | 跨平台适配集中在此，业务代码禁止硬编码绝对路径 |

### 3.3 目录结构

```
remote-code-editor/
├── main.py                     # 打包入口（转发到 app.main）
├── app/
│   ├── main.py                 # 程序入口：QApplication / 主题 / 主窗口
│   ├── ui/                     # 所有界面组件
│   │   ├── main_window.py      # 编排层
│   │   ├── ssh_dialog.py       # 连接弹窗
│   │   ├── host_manager.py     # 主机管理面板
│   │   ├── settings_dialog.py  # 设置面板
│   │   ├── theme.py            # 主题与配色（唯一颜色来源）
│   │   ├── tasks.py            # QThreadPool 异步任务运行器
│   │   ├── remote_ops.py       # GUI ↔ 远程能力的粘合层
│   │   └── widgets/            # 文件树 / 多标签 / 搜索栏 / 状态栏 / 日志
│   ├── editor/                 # 编辑器核心、高亮、Git 标记渲染
│   │   ├── editor.py           # CodeEditor（行号 + Gutter + 搜索替换）
│   │   ├── syntax.py           # Pygments 高亮与语言识别
│   │   ├── git_decorations.py  # Gutter 彩色标记绘制
│   │   └── document.py         # 文档模型（脏状态、编码、指纹）
│   ├── remote/                 # SSH / SFTP / 远程文件系统
│   │   ├── ssh_client.py       # paramiko 封装
│   │   ├── sftp_client.py      # 目录列表 / 上传下载 / 原子写
│   │   ├── remote_fs.py        # 文件系统门面 + 指纹冲突检测
│   │   └── session.py          # 连接会话与仓库信息缓存
│   ├── git/                    # Git 解析、Diff 处理
│   │   ├── models.py           # ChangeType / LineMarker / FileDiff
│   │   ├── diff_parser.py      # unified diff → 行级标记（纯函数）
│   │   └── git_client.py       # 远程 git 命令执行与状态查询
│   ├── config/                 # 配置管理（设置 + 主机列表）
│   ├── cache/                  # 本地缓存（内容缓存 + 最近文件）
│   └── utils/                  # 通用工具：日志脱敏 / 异常 / 路径 / 编码
├── tests/                      # 单元测试 + SSH 端到端测试
├── scripts/                    # 跨平台打包脚本 + 图标生成
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
  （`SSHAuthError` / `SSHTimeoutError` / `SSHConnectionError` 等），UI 无需认识 paramiko；
- 支持密码与私钥两种认证；私钥解析兼容 paramiko 3.x 的 `PKey.from_path()` 与 2.9 的类型逐个尝试；
- 主机密钥校验默认开启（`RejectPolicy`），设置项可显式放开供内网调试；
- SFTP 上传采用**临时文件 + 原子重命名**（`file.tmp` → `file`），避免传输中断损坏远端源码；
- 远程路径用 `posixpath` 拼接，本地路径一律 `pathlib`（满足需求 §6.3）。

### 4.3 Git 行级差异标记规则

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

### 4.4 Git 刷新策略

| 时机 | 行为 |
| --- | --- |
| 打开文件 | 一次性拉取 diff 并渲染初始标记 |
| 编辑过程中 | 只更新本地脏状态，**不请求远端** |
| 保存之后 | 延迟 800ms 防抖刷新（`GIT_REFRESH_DELAY_MS`） |
| 手动 | `Shift+F5` 强制刷新当前文件标记，`F5` 刷新工作目录 |

仓库识别：打开远程目录时执行一次 `rev-parse`；非仓库时状态栏显示 `Git: Not a repository`，
仓库则显示 `Git: <分支>` 与文件变更统计。

### 4.5 异步与不卡顿

`TaskRunner` 基于 `QThreadPool` + `QRunnable`，每个任务携带成功/失败回调，
回调通过信号切回 GUI 线程后才执行。因此 SSH 连接、目录列举、SFTP 上传下载、远程 Git 命令、
文件解析全部异步，主线程只做渲染；`tests/test_main_window.py` 有专门用例断言网络请求期间 UI 仍可响应。

### 4.6 文件冲突处理

打开文件时记录 `FileFingerprint`（mtime + size）。保存前重新取一次指纹，
若远端文件被外部改动则弹窗，且只提供三个选项：

1. **重新加载远程文件**（丢弃本地改动）
2. **覆盖远程文件**（以本地为准，需用户显式确认）
3. **取消保存**

绝不静默覆盖远端文件。

### 4.7 编码兼容

默认支持 UTF-8、UTF-8 BOM、ASCII（自动识别）。检测失败抛 `UnknownEncodingError`，
弹窗让用户从 `SELECTABLE_ENCODINGS` 中手动选择；保存时沿用打开时的编码，BOM 按原样保留。

### 4.8 日志与安全

- 日志写入跨平台数据目录 `logs/`（Windows `%LOCALAPPDATA%`，Linux `$XDG_CACHE_HOME`），带轮转；
- 所有密码、私钥口令在进入日志前经 `SecretRedactor` 替换为 `***`；
- 主机配置持久化时**剔除密码字段**，连接时临时输入；私钥仅存路径、不存内容。

---

## 5. 键盘快捷键

| 快捷键 | 功能 | 快捷键 | 功能 |
| --- | --- | --- | --- |
| `Ctrl+K` | 连接主机 | `Ctrl+F` | 查找 |
| `Ctrl+S` | 保存当前文件 | `Ctrl+H` | 替换 |
| `Ctrl+Shift+S` | 全部保存 | `F3` / `Shift+F3` | 查找下一个 / 上一个 |
| `Ctrl+W` | 关闭当前标签 | `Ctrl+G` | 转到行 |
| `Ctrl+,` | 设置 | `Ctrl+Q` | 退出 |
| `F5` | 刷新工作目录 | `Shift+F5` | 刷新 Git 标记 |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 | `Ctrl+X/C/V/A` | 剪切/复制/粘贴/全选 |
| `Esc` | 关闭搜索栏 | `Tab` / `Shift+Tab` | 缩进 / 反缩进 |

---

## 6. 运行与开发

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python main.py            # 或 python -m app.main
```

要求 Python 3.9+。Linux 上需要 Qt 运行期依赖（Ubuntu 桌面版通常已自带 `libxcb-cursor0` 等）。

---

## 7. 打包

### 7.1 Windows

```bat
scripts\build_windows.bat
```

产物 `dist\RemoteCodeEditor.exe`：单文件、无控制台、内嵌图标，干净 Win10/Win11 双击即用。
脚本会先校验 Python 版本、按需安装打包依赖、清理旧产物、生成图标，再调用 PyInstaller。

### 7.2 Ubuntu

```bash
bash scripts/build_linux.sh
```

产物 `dist/RemoteCodeEditor.AppImage`（适配 Ubuntu 22.04+）。脚本流程：
PyInstaller 单文件 → 组装 `AppDir`（含 `.desktop`、图标、AppStream 元数据、`AppRun`）
→ 调用 `appimagetool` 生成 AppImage。

若本机没有 `appimagetool`，脚本会自动下载到 `tools/`；下载失败时保留已就绪的 `AppDir`
并打印手动打包命令，不会中断流程。

`.deb`（可选）：基于生成的 `AppDir` 用 `fpm` 或 `linuxdeploy` 生成，命令见脚本末尾提示。

两个脚本都通过 `--paths .` 保证 `app` 包可导入，并排除未使用的 Qt 模块
（WebEngine / Qml / Quick / Multimedia / Sql / 3D 等）以及 PyQt、tkinter、numpy 等，
以控制体积、贴合「轻量级」定位。

---

## 8. 测试

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
- 配置与编码：主机配置不落密码、设置读写原子性、BOM 与未知编码处理。

---

## 9. 验收标准对照（需求 §11）

| # | 验收项 | 实现与验证 |
| --- | --- | --- |
| 1 | 远端零负载 | 仅使用原生 sshd/sftp/git；代码中无远端常驻组件，全部为一次性命令 |
| 2 | Windows 适配 | `scripts/build_windows.bat` 产出免环境单文件 exe |
| 3 | Ubuntu 适配 | `scripts/build_linux.sh` 产出 AppImage（22.04+） |
| 4 | 远程编辑可用 | 连接 → 浏览 → 编辑 → `Ctrl+S` 同步远端；端到端测试覆盖 |
| 5 | Git 标记精准 | `diff_parser` 纯函数 + 12 类强制用例 + Gutter 像素级颜色断言 |
| 6 | 弱设备适配 | 远端只出现短时 `git`/`sftp` 进程，无 Node/LSP/Agent |
| 7 | UI 不卡顿 | 全异步任务模型 + 主窗口「网络期间 UI 可响应」测试 |

---

## 10. 已知限制

- V1.0 不支持 LSP、调试、终端、插件（需求明确的功能边界）。
- 密码不落盘：每次连接需临时输入；后续版本可对接系统钥匙串。
- 单文件默认上限 32MB（设置项可调），超大文件保证可打开，不保证高亮。

## 11. 许可证

MIT，见 `LICENSE`。
