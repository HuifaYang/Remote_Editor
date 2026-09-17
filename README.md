# RemoteCodeEditor

轻量级跨平台 SSH 远程代码编辑器，用于替代 VSCode Remote-SSH，
专门适配**嵌入式弱性能 ARM Linux 板卡**（RK3566 / RK3588 / 香橙派等）开发场景。

- **本地重计算、远程零负载**：GUI 渲染、代码编辑、语法高亮、Git Diff 解析、文件缓存全部在本地 PC 完成。
- **远端零常驻服务**：板卡只需原生 `sshd`、`sftp`、`git` 与标准 Linux 文件系统，不部署任何 Agent / LSP / Node.js 服务。
- **免环境运行**：Windows `RemoteCodeEditor.exe` + Ubuntu `RemoteCodeEditor.AppImage`，双击即用，无需 Python 环境。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| SSH 主机管理 | 可视化新增 / 编辑 / 删除 / 快速连接；密码不落盘；私钥下拉框直接列出本机 `~/.ssh` 可用私钥；可一键导入 `~/.ssh/config` 中的主机 |
| 界面布局 | 仿 VSCode：最左活动栏（图标切换资源管理器 / 源代码管理，Ctrl+B 式收起）、侧边栏、标签页编辑区；未连接或未打开文件时显示欢迎页，「打开远程文件夹」仅在连接后可用 |
| 远程文件树 | 仿 VSCode 单列（只有文件名，不会被大小 / 时间挤成 `command_handl…`）、22px 紧凑行、目录在前按名排序、行右端绘制变更徽标；顶栏为纯图标按钮（新建文件 / 新建文件夹 / 刷新 / 折叠）；目录懒加载、右键新建 / 删除 / 重命名 / 刷新 / 属性 / 复制路径；大小与时间在 Tooltip |
| 文件树 Git 着色 | VSCode 式：未变更不着色，新增绿 / 修改黄 / 删除红，目录按子树内最高优先级变更着色；撤销回原样并保存后标记自动撤掉 |
| 源代码管理面板 | 活动栏的 SCM 视图列出与远端仓库不同的文件（相对仓库根路径 + 变更徽标），**打开面板不发任何远端请求**（复用文件树已有的 Git 快照），点文件名直接打开，右上角刷新等价 `Shift+F5` |
| 工作目录 | 连接成功后再选择要打开的远端文件夹（VSCode 式；`Ctrl+O` 随时切换），选择结果按主机记住，下次自动打开 |
| 编辑与保存 | 多标签、行号、当前行高亮、自动缩进、Tab/空格适配、撤销重做、搜索替换（支持正则）、未保存标记；**默认开启自动保存**（停手 1.5s 自动上传，可在设置里关闭或调延迟） |
| 文件同步 | 本地编辑、`Ctrl+S` 经 SFTP 上传；上传采用临时文件 + 原子重命名，避免中断损坏远端源码 |
| Git 行级标记 | Gutter 彩色标记相对 `HEAD` 的新增 / 修改 / 删除行；非仓库时状态栏提示 |
| 打开速度 | 一次限定工作目录范围的 `git status` 快照同时供文件树着色与单文件 diff 复用：打开未修改的文件 **0 个远端 Git 命令**，已修改的文件只跑 1 次 `git diff`，保存 / 删除后按本地知识更新标记、不再重扫仓库；目录列举去重 + 120 秒缓存 + 后台预取子目录，高延迟链路下展开目录不再每次等 3~4 秒 |
| 编码兼容 | UTF-8 / UTF-8 BOM / ASCII 自动识别，识别失败时弹窗手动选择，保存沿用原编码与 BOM |
| 冲突保护 | 远端文件被外部修改时弹窗三选一（重新加载 / 覆盖 / 取消），绝不静默覆盖 |
| 全程不卡顿 | 连接、列目录、上下行、Git 查询、文件解析全部异步执行，UI 线程只做渲染 |

## 典型流程

1. 启动客户端 → 欢迎页点击「连接主机…」（活动栏的图标也是同一入口），选择或新增板卡 SSH 连接
2. 连接成功后点「打开远程文件夹…」，在远端选择要打开的文件夹（默认定位家目录，记住后下次自动打开）
3. 浏览远程目录树，打开源码文件并全本地编辑（零网络请求）
4. `Ctrl+S` 保存，经 SFTP 上传覆盖远端文件
5. 编辑器左侧 Gutter 实时显示相对 `HEAD` 的新增 / 修改 / 删除行标记

## 快速开始

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python main.py            # 或 python -m app.main
```

要求 Python 3.9+。Linux 上需要 Qt 运行期依赖（Ubuntu 桌面版通常已自带 `libxcb-cursor0` 等）。

### 打包

| 平台 | 命令 | 产物 |
| --- | --- | --- |
| Windows 10/11 | `scripts\build_windows.bat` | `dist\RemoteCodeEditor.exe`（单文件、无控制台、内嵌图标） |
| Ubuntu 22.04+ | `bash scripts/build_linux.sh` | `dist/RemoteCodeEditor.AppImage` |

Windows 脚本会先校验 Python 版本、按需安装打包依赖、清理旧产物、生成图标，再调用 PyInstaller。
Linux 脚本先打单文件，再组装 `AppDir`（含 `.desktop`、图标、AppStream 元数据、`AppRun`）并调用
`appimagetool`；本机没有 `appimagetool` 时会自动下载到 `tools/`，下载失败则保留已就绪的 `AppDir`
并打印手动打包命令，不中断流程。两个脚本都通过 `--paths .` 保证 `app` 包可导入，
并排除未使用的 Qt 模块（WebEngine / Qml / Quick / Multimedia / Sql / 3D 等）与 PyQt、tkinter、numpy，
以控制体积。

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

## 项目结构

```
remote-code-editor/
├── main.py                     # 打包入口（转发到 app.main）
├── app/
│   ├── main.py                 # 程序入口：QApplication / 主题 / 主窗口
│   ├── ui/                     # 界面组件（主窗口、连接与主机管理、工作目录选择、设置）
│   ├── editor/                 # 编辑器核心、语法高亮、Git 标记渲染
│   ├── remote/                 # SSH / SFTP / 远程文件系统 / 会话
│   ├── git/                    # Git 命令、Diff 解析与行级标记
│   ├── config/                 # 设置与主机列表持久化
│   ├── cache/                  # 本地缓存
│   └── utils/                  # 日志脱敏、异常、路径、编码、~/.ssh 扫描
├── docs/                       # 需求基线 / 设计说明 / 开发日志
├── AGENTS.md                   # 项目记忆（协作 agent 与新人上手指引）
├── tests/                      # 单元测试 + 真实 SSH/SFTP 端到端测试
├── scripts/                    # 跨平台打包脚本与图标生成
├── requirements.txt / pyproject.toml / LICENSE
```

各模块职责与实际文件清单见设计文档的目录结构一节。

## 文档

- [docs/requirements.md](docs/requirements.md) —— 需求基线：硬性约束、功能边界、功能需求、打包交付、代码质量、验收标准。
- [docs/design.md](docs/design.md) —— 设计说明：技术选型论证、架构分层、关键实现、测试策略、已知限制。
- [docs/devlog.md](docs/devlog.md) —— 开发日志：按日期记录当天做了什么、为什么这么做、验证结果与遗留事项。
- [AGENTS.md](AGENTS.md) —— 项目记忆：常用命令、硬性约束、架构地图、性能不变量与当前状态（供协作 agent / 新同学快速上手）。

代码注释中的「需求 §5.10」「需求 §5.13」等编号指向需求基线文档。

## 许可证

MIT，见 `LICENSE`。
