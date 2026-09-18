# 打包与资源替换

面向**要发布 / 要改外观的人**：怎么打出免安装版与安装版，以及装好之后
「主题 / 字体 / 文件图标主题」到底放在哪里才能生效。

日常开发命令见 [../README.md](../README.md)；为什么这么设计见 [design.md](design.md) §4.14 与 §4.16。

---

## 1. 两种交付形态

| 形态 | 平台 | 构建命令 | 产物 | 特点 |
| --- | --- | --- | --- | --- |
| **免安装版** | Ubuntu 22.04+ | `bash scripts/build_linux.sh` | `dist/RemoteCodeEditor.AppImage` | 单个文件，`chmod +x` 后双击即用，不写系统目录 |
| **免安装版** | Windows 10/11 | `scripts\build_windows.bat` | `dist\RemoteCodeEditor.exe` | 单文件、无控制台，不需要装 Python |
| **安装版** | Ubuntu 22.04+ | 同上（脚本自动带出）<br>或单独 `bash scripts/build_deb.sh` | `dist/RemoteCodeEditor_<版本>_<架构>.deb` | `sudo apt install ./xxx.deb`，进应用菜单，卸载走 `apt remove` |
| **安装版** | Windows 10/11 | `scripts\build_windows_installer.bat` | `dist\RemoteCodeEditor_<版本>_setup.exe` | NSIS 安装向导，写开始菜单 / 桌面快捷方式 / 「应用和功能」卸载项 |
| 源码运行 | 全平台 | `python main.py` | —— | 开发用 |

两个平台的可执行文件都是 **PyInstaller `--onefile`**：Python 解释器、PySide6（Qt）
与 `assets/` 里的字体 / 主题 / 图标主题全部打进一个文件，所以**目标机器不用装任何东西**。

### Linux

```bash
bash scripts/build_linux.sh          # 免安装版 + 安装版一起出，产物都在 dist/
SKIP_APPIMAGE=1 bash scripts/build_linux.sh   # 只要 .deb（不下载 appimagetool）
SKIP_DEB=1 bash scripts/build_linux.sh        # 只要 AppImage

# 已经用 PyInstaller 打好 dist/RemoteCodeEditor 时，可以只补一个 .deb：
bash scripts/build_deb.sh
```

`.deb` 的目录布局：

```
/usr/bin/remote-code-editor                          # 启动命令（包一层 shell，路径稳定）
/usr/lib/remote-code-editor/RemoteCodeEditor         # 真正的可执行文件
/usr/share/applications/remote-code-editor.desktop   # 应用菜单项
/usr/share/icons/hicolor/256x256/apps/remote-code-editor.png
/usr/share/metainfo/remote-code-editor.appdata.xml
/usr/share/doc/remote-code-editor/copyright          # 含 MIT 许可证全文
```

`Depends:` 里只声明 Qt 需要的系统库（`libxcb-*`、`libxkbcommon-x11-0`、`libgl1` …），
`Recommends:` 是 `openssh-client` 与 `git` —— 前者是 SSH 连接的**硬需求**，
`apt install ./xxx.deb` 会自动带上依赖，不需要用户自己判断缺什么。

### Windows

```bat
scripts\build_windows.bat             :: 免安装版；若装了 NSIS 会顺带出安装包
scripts\build_windows_installer.bat   :: 只出安装包（需要先有 dist\RemoteCodeEditor.exe）
```

安装包用 NSIS 3 打；本仓库**不含 NSIS 二进制**，需要先装一次：

```bat
winget install NSIS.NSIS
```

脚本会自动在 `PATH` 与 `%ProgramFiles(x86)%\NSIS\` 下找 `makensis`；找不到就只跳过安装包，
免安装版照常产出并给出提示。

---

## 2. 资源替换位置（打包之后也能改）

程序自带的字体 / 主题 / 图标主题在安装目录里（`--onefile` 运行时甚至被解压到临时目录），
**不要去改它们**。要换外观，把文件放进**用户配置目录**：

| 资源 | 放到 | 放什么 |
| --- | --- | --- |
| 配色主题 | `<配置目录>/themes/` | VSCode 主题 `*.json`（GitHub Dark、One Dark Pro 等直接下原文件即可） |
| 字体 | `<配置目录>/fonts/` | `.ttf` / `.otf` / `.ttc` / `.otc` |
| 文件图标主题 | `<配置目录>/icon-themes/<主题名>/` | 一套 VSCode 文件图标主题（含它的 `icons/` 目录与 JSON） |

`<配置目录>` 在各平台的位置（由 `app/utils/paths.py::config_dir()` 决定）：

| 平台 | 路径 |
| --- | --- |
| Linux | `~/.config/remote-code-editor/` |
| Windows | `%APPDATA%\RemoteCodeEditor\` |
| macOS | `~/Library/Application Support/RemoteCodeEditor/` |

**不用记路径**：菜单「视图 → 设置 → 外观 → 资源目录」里直接显示了这个目录，
点右边的「打开」会**自动建好 `themes/`、`fonts/`、`icon-themes/` 三个子目录**并交给
系统文件管理器。把文件拖进去，再重开一次设置对话框（会重扫目录）就能在下拉框里选中，
配色主题还会同步出现在「视图 → 主题」子菜单里。

几个必须知道的规则：

* **用户目录用来「新增」，不覆盖内置同名资源**：内置 `dark` / `light` 与随包的
  GitHub 主题、Material 图标主题、JetBrains Mono 字体始终在，同名的新文件会被忽略。
  想覆盖内置效果，取个新名字即可。
* **主题名取文件名**（如 `github-dark.json` → `github-dark`），显示名取 JSON 里的 `name`；
  所以文件名别重复。
* **字体只是注册进 Qt，还要在「外观 → 字体」里填字体族名**（等宽字体，例如
  `Fira Code`）。等宽字体用于编辑器与日志视图，界面字体仍按内置偏好顺序挑选。
* **资源文件放错 / 损坏不会导致启动失败**：字体坏了跳过、主题 JSON 坏了忽略、
  图标主题缺文件回退到内置图标。

---

## 3. 打包前后的自查清单

```bash
QT_QPA_PLATFORM=offscreen python -m pytest -q      # 全量测试（基线 488 passed, 27 skipped）
python -m pyflakes app tests                        # 静态检查，必须 clean
```

打出产物后至少确认这几条：

- 在一台**没装 Python / 没装 PySide6** 的机器上双击能起来，界面字体与源码运行时一致；
- 「视图 → 设置 → 外观」里主题 / 文件图标 / 字体三个下拉都有内容，切换后立刻生效；
- 往 `<配置目录>/themes/` 丢一个主题 JSON，重开设置对话框能看到它；
- `.deb` / `setup.exe` 安装后能从应用菜单启动，卸载后残留只剩用户配置目录；
- 版本号变更时，`app/utils/paths.py::APP_VERSION` 是唯一来源（两个安装包脚本都从它读取）；
- ``Ctrl+` `` 打开终端，能连上板卡跑 `ls` / `htop`（终端走 sshd 的 shell 通道，远端不用装任何东西）。

打包相关的一条注意：终端用 `PySide6.QtOpenGLWidgets` 做 GPU 渲染，两个打包脚本都显式加了
`--hidden-import PySide6.QtOpenGLWidgets --hidden-import PySide6.QtOpenGL`
（导入写了 try/except 兜底，但显式声明更稳）。若目标机器没有可用的 OpenGL，
程序会**自动退回软渲染**，不会起不来；也可以用环境变量 `REMOTE_EDITOR_NO_GPU=1` 强制软渲染。
