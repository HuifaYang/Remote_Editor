# 开发日志

按日期倒序记录**当天做了什么、为什么这么做、验证结果与遗留事项**。
需求基线见 [requirements.md](requirements.md)，实现说明见 [design.md](design.md)。

---

## 2026-09-20

主题：**界面「去粗糙感」、真正可用的 Markdown 预览、源代码管理能提交**。

用户连续反馈「界面有股复古感 / 不像 VSCode 那么现代 / 图标应该比字大 / 预览字体和
代码不一致 / 为什么启动没变化」。逐条定位后发现都不是「观感问题」，而是有具体成因的
技术债，这轮全部按根因修掉。

### 1. 界面显旧的三件事（对照 VSCode 截图逐项比出来的）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 图标粗糙、没精神 | `icons.py` 是 QPainter 手画的 16px 线条，粗细不匀、视觉不居中 | 换成 VSCode 官方 **Codicons SVG**（`assets/ui-icons/`，CC-BY 4.0）：SVG 里的 `currentColor` 在渲染前替换成主题色，走 PySide6 自带的 `QtSvg`，**不新增依赖**；没有对应 SVG 的图标仍回退手画 |
| 没有清晰边界、一片糊 | GitHub Dark 的 `border` 只有 `#21262d`，分隔线按 18% 混前景色仍是几乎不可见的暗灰 | 混合比提到 34% 并加**亮度下限**；活动栏改用 `editor_bg`（与编辑区同深），侧边栏 `panel_bg` 更深一档，形成 VSCode 的明度阶梯 |
| 文字发毛、偏单薄 | 没开字体抗锯齿 / hinting | `ui_font()` 显式 `PreferAntialias | PreferQuality` + `PreferFullHinting` |

### 2. `Ctrl±` 变成「整个界面」缩放（之前只放大文字）

`Ctrl+=` / `Ctrl+-` 的语义早就定为全局缩放，但实现只把系数折进了 `font-size` ——
图标、间距、活动栏宽度、标题栏高度全是写死像素，所以放大后「字大了、框没大」。

新增 `ui_metric_scale(zoom, font_size) = 缩放 × (字号 ÷ 基准字号)`，QSS 的
`px()` 与各组件的固定尺寸（活动栏 / 标题栏 / 文件树 / 主机树）全部按它换算。

### 3. 界面字号与代码字号统一

之前界面写死 10pt、编辑器用设置里的 `font_size`（默认 12），两者天生差 2pt；
用户要求「改成一致大小」。现在界面字号也取 `font_size`：
`apply_theme(ui_font_size=...)` 决定 QSS 的 `font-size`，`apply_ui_font` 的兜底字体
同样跟随（`main.py` 里把 settings 加载提到设置字体之前）。

顺带修掉两处**同源问题**：
- **图标比例**：图标只跟缩放、不跟字号，字号调大后图标反而显小 → 图标 / 间距现在
  跟 `ui_metric_scale` 走（活动栏图标基准 18 → 24px，按钮 36 → 44，栏宽 44 → 52）；
- **Markdown 预览字号**：预览文档的默认字体不会跟着 QSS 变，一直停在建控件时的
  应用字体上 → 现在由 `EditorTabs.apply_settings` 把「设置字号 × 缩放」下发到预览，
  两边严格同源。

### 4. 悬停动画统一

QSS 不支持 `transition`，`QToolButton` 又默认不产生 hover 进入 / 离开事件，且 style
会在 hover 时自己画一块瞬时高亮盖住自绘底色。新增
`FadeButton`（`QVariantAnimation` 对底色 alpha 做 300ms 淡入淡出，**完全自绘**背景与
图标），三个窗口按钮统一成同一种柔和灰底（关闭按钮不再单独变红），与 VSCode 一致。

### 5. 面板分隔条可视化

`QSplitter::handle` 从 1px 细线改成 6px 热区 + 默认只画中央 1px、悬停 / 拖动时整条
淡成 accent 高亮（「这里能拖」的提示），用 `border` 画线以免改宽度导致布局抖动。

### 6. 设置对话框去掉系统标题栏

改成无边框 + 自绘标题栏（可拖动），`QGroupBox` 的横线框换成 VSCode 设置页那种
「弱化加粗小标题 + 内容」。圆角 / 描边只作用于 `objectName=frameless_dialog`，
不影响仍带系统边框的消息框。

### 7. 点击 gutter 查看「与上一版差异」（仿 VSCode peek）

- `diff_parser` 在解析 hunk 时把丢弃掉的 `+` / `-` 行文本记进新增的
  `FileDiff.hunks`（`HunkDetail`）——**不增加任何远端请求**，用的还是那一次 `git diff`；
- 行号槽加点击检测（`LineNumberArea.mousePressEvent` → `changePeekRequested(line)`）；
- 新增 `PeekDiffView` 浮层：红底旧文本、绿底新文本，定位在点击行下方，Esc /
  切标签 / 关闭按钮收起。

### 8. Markdown 渲染 + 编辑

`.md` 标签页内是「编辑器 | 预览」可拖动分屏，`Ctrl+Shift+V` 或「视图 → 切换
Markdown 预览」开关；预览用 Qt 原生 `QTextDocument.setMarkdown`（**零新依赖**），
颜色随主题注入，编辑后 300ms 节流刷新，打开 .md 时状态栏给一句快捷键提示。

这中间修掉两个真 bug（用户报的「markdown 渲染没做好」「字体差别那么大」）：

1. **预览是 0 宽**：`QSplitter` 不会在隐藏的子控件重新显示时分配尺寸，直接
   `setVisible(True)` 后预览停在 0 宽，看起来像「没渲染」。切换时显式平分宽度；
2. **预览字号不同源**：见 §3。

另外 `Ctrl+Shift+V` 与终端粘贴重名：Qt 会先把按键以 `ShortcutOverride` 发给焦点控件，
所以给终端画布加了 `event()` 处理，把 `Ctrl+Shift+C/V` 抢回来，否则终端里粘贴会变成
开 Markdown 预览。

### 9. 源代码管理面板重做 + 真正能提交

按 VSCode 的结构重排：提交信息框 + 主色「提交」按钮（回车亦可提交，有信息且有更改时
才可点）、「更改」分组标题带数量与折叠、每行是**两列**（文件名 + 弱化的父目录，状态
字母在最右端对齐）—— 之前整行是一长串相对路径，右侧被截断后看不出是哪个文件。

提交走新增的 `GitClient.commit_all()`：`git add -A` + `git commit -m`（信息经
`shlex.quote` 转义，空白信息直接拒绝），成功后清空输入框并刷新快照与当前文件 diff。
打开面板依然**零远端请求**（照旧复用文件树那份 `TreeStatus`）。

顺带修掉一个隐藏 bug：`badge.py` 里写的是 `super().subElementRect(...)`，而
`QStyledItemDelegate` 上**没有**这个方法 —— 异常被 Qt 吞掉，等于「给徽标预留宽度」
从上一轮起就是死代码。现在改成 `text_rect()` 并向 `QStyle` 取矩形。

### 10. 状态栏重构与中文化

左区（连接 / 当前文件 / 分支与变更）与右区（保存状态 / 编码 / 语言 / 行列号）分区，
空值自动隐藏（不再出现一排 `-`），各项 hover 有底色；`Ln 1, Col 1` → **行 1，列 1**，
`Disconnected/Connected` → **未连接 / 已连接**。

### 11. 验证

```
QT_QPA_PLATFORM=offscreen python -m pytest -q    # 521 passed, 27 skipped
python -m pyflakes app tests                     # clean
```

关键回归用例都验证过「把修复去掉就会失败」：Codicons 回退、`ui_metric_scale`、
预览字号同源、预览宽度、`commit_all` 的暂存顺序与转义、终端 `ShortcutOverride`。

### 12. 遗留 / 下一步

- 暂存区（逐个暂存 / 取消暂存）仍未做，当前是「全部暂存后提交」；
- 预览里的相对路径图片不会加载（文件在远端，需要按需经 SFTP 取图）；
- Qt 的 Markdown 不支持任务列表复选框（`- [x]`），`**加粗**` 紧邻中日韩标点的写法
  按 CommonMark 规则不会解析（GitHub 亦同）；
- `Ctrl+B` 收起侧边栏仍只由活动栏按钮触发；
- 插件机制（design.md §7）仍为后续方向。

---

## 2026-09-18

主题：**修掉「有改动的文件名花屏」，并把外观资源做成自带 + 可切换**。

### 1. 「文件名乱码」不是字体问题，是文字被画了两遍

用户反馈：**只要是有改动的（被着色的）文件名就糊成一团**，怀疑用了本机没装的字体。
离屏复现（同一棵文件树、同一套主题）后确认：**未着色行正常，只有带徽标的行花**。

真因在 `widgets/badge.py` 的委托里：

1. 委托先 `opt.text = ""` 再调基类绘制，想让基类**只画背景**，文件名由自己手画；
2. 但样式表（`apply_theme` 会设 QSS）下基类走的是 `QStyleSheetStyle`，它**不看 `opt.text`**，
   会按索引数据自己再画一遍文件名；
3. 于是同一个文件名被画了两次，两遍的字距 / 起点略有差异，叠加就是「笔画错位的花屏」。

**修法**：让基类**独占**文字绘制，委托只把文字可用宽度收窄到徽标左侧
（覆写 `subElementRect(SE_ItemViewItemText)`），再补画徽标。这样一箭双雕 ——
既没有两遍绘制，长文件名打省略号、选中态配色也回到了基类（与未着色行完全一致）。

**回归测试**（`tests/test_file_tree.py::test_badged_filename_is_drawn_only_once`）不比颜色
（着色行与未着色行颜色本来就不同），而是把两行的**笔画掩码**逐像素对比：着色不该让文件名
多画一遍或挪位置。已在旧代码上确认该用例会失败（`badged ink: 477` vs `clean ink: 382`），
修复后两者完全一致。

### 2. 自带外观资源：字体 / 主题 / 文件图标主题

用户要求「内置字体、主题、文件图标主题，不依赖外部，主题要能像 VSCode 那样切换，
可以去找开源主题」。设计取向是**直接吃 VSCode 的资源格式**，这样 GitHub Dark、
Material Icon Theme 等现成文件可以直接用。

| 新增 | 位置 | 要点 |
| --- | --- | --- |
| 内置字体 | `app/ui/fonts.py` + `assets/fonts/` | 启动时注册目录里的 `ttf/otf/ttc/otc`；等宽字体优先选内置的（JetBrains Mono → Cascadia → Fira Code …），没有才回退系统字体 |
| 主题加载 | `app/ui/theme.py` | 解析 VSCode 主题 JSON（`colors` + `tokenColors`）映射到既有 `Theme` 字段；缺字段按背景亮度沿用内置深色 / 浅色；`#rrggbbaa` 按编辑器底色合成（Qt 的 8 位写法是 `#aarrggbb`，不换算会把 alpha 当红色） |
| 文件图标主题 | `app/ui/icon_theme.py` + `assets/icon-themes/` | VSCode 图标主题规范：文件名 → 最长扩展名 → 默认图标；文件夹支持展开 / 收起两态；SVG 用 PySide6 自带的 `QtSvg` 渲染（**不新增依赖**）；主题 JSON 与 `icons` 分开的 `dist/` 布局也能找到图标 |
| 切换入口 | 设置对话框「外观」组 + 「视图 → 主题」子菜单 | 即时生效并写回配置（新增设置项 `icon_theme`）；`_apply_settings_to_ui()` 一处分发到编辑器 / 文件树 / 活动栏 / SCM / 欢迎页 |

**三条底线都做成了回退路径**：字体目录不存在或文件损坏 → 系统字体；主题 JSON 坏掉 / 不是主题
→ 跳过该文件；图标主题缺失或某类型没定义 → 该项回退系统图标。**资源全缺也照常启动。**

顺带修掉一个真会崩的隐患：`QFontDatabase.addApplicationFont` 与 `QPixmap` 在没有
`QApplication` 时调用会让 Qt 直接 abort，两个模块都加了 `QGuiApplication.instance() is None`
的提前返回。

### 3. 验证

```
QT_QPA_PLATFORM=offscreen python -m pytest -q    # 357 passed, 24 skipped
python -m pyflakes app tests                     # clean
```

另做了一次离屏端到端：临时造一份 GitHub Dark 风格的主题 JSON、一份 Material 风格的图标主题
（SVG）、拿系统里的 DejaVu Sans Mono 当「随程序分发的字体」，真实主窗口 + 真实文件树的渲染
结果逐张核对 —— 主题底色 `#0d1117` 生效、`.c/.py/.md` 各用自己的图标、文件夹图标正常、
着色行文字不再花屏。

### 4. Ctrl+= / Ctrl+- / Ctrl+0 缩放字号

> 后续更新：用户指出「快捷键调整字体大小是全局，不止代码」，当天已改成**全局缩放**
> （见下方 §8）；`settings.zoom_level`（0.7~2.0）取代了原来直接改 `font_size` 的做法，
> 编辑器字号 = 设置里的字号 × 缩放。

用户要求「像 VSCode 那样用 Ctrl+- 改字号」。做法是**复用设置里已有的「字号」**（不新增第二份
状态）：`_zoom_font(±1)` / `_reset_font_size()` 只改 `settings.font_size`，然后照旧走
`_apply_settings_to_ui()` 这一处分发 —— 打开的所有标签页、行号槽宽度、缩进宽度都会跟着更新，
并写回配置（下次启动保持一致）。

- 边界与设置对话框共用 `FONT_SIZE_MIN/MAX/DEFAULT`（8 / 32 / 12）三个常量，避免两处不一致；
- 已到边界时只弹一句状态栏提示，**不重复写盘、不重复重排**；
- `Ctrl+=` 在不少键盘布局上要按 Shift，因此额外绑了 `Ctrl++`（缩小的 `Ctrl+_` 同理）；
- 入口在「视图 → 缩放字号」三个菜单项，快捷键是 `WindowShortcut`，焦点在编辑器里也能用
  （这正是测试里要 `setActiveWindow` 的原因）。

### 5. 资源入库

用户下载后放入仓库根的 `file/`，装机时发现**三个包里只有两个能直接用**：

- `JetBrainsMono-2.304.zip` → 取 5 个静态 TTF（Regular / Bold / Italic / BoldItalic / Medium）
  + `OFL.txt` / `AUTHORS.txt` 进 `assets/fonts/`；
- `github-vscode-theme-6.3.5.zip` **是源码包**，里面只有 `src/*.js`（主题 JSON 是 Node 构建产物，
  没有 `themes/`），用不了。改用本机已安装扩展
  `~/.vscode/extensions/github.github-vscode-theme-6.3.5/themes/*.json`（同版本 6.3.5），
  9 套主题全部入库，并把提示写进 `assets/themes/README.md`，免得下次又下错；
- `material-icon-theme-5.38.1.vsix` → 取 `dist/material-icons.json` + `icons/`（1251 个 SVG）
  + `package.json` + `LICENSE.txt` 进 `assets/icon-themes/material/`，保持上游 `dist/` 布局。

装机过程中修了一处**加载器的短板**：`_find_theme_json` 原来只在主题目录根部找 JSON，
而上游（Material、以及不少图标主题）会把 JSON 放在 `dist/` 里打包 —— 于是补上「下探一级
子目录」，并加了用例 `test_finds_theme_json_in_a_subdirectory`。显示名也做了兜底：JSON 里没有
`name` 时读上游 `package.json` 的 `displayName`，否则下拉框里只会显示目录名「material」。

入库后 `assets/` 约 7.2 MB（图标 5.6 MB / 字体 1.4 MB / 主题 184 KB），
打包脚本本来就 `--add-data assets`，不需要额外改动。

### 6. 遗留 / 下一步

- 图标主题只覆盖资源管理器；活动栏 / 工具栏仍是自绘线条图标（刻意保留，避免与主题强绑定）；
- 尚未做「主题跟随系统深浅色」，也未做图标主题的实时预览；
- 默认主题仍是内置的「深色」，没有把 GitHub Dark 设为默认（用户现有配置也未被改动）。

### 7. 外观打磨：把 Fusion 的原生控件全部接管（用户反馈「整个页面还是复古」）

内置主题与图标换完之后，用户仍觉得「整个页面有一种很复古的感觉」。离屏截图逐项比对后，
复古感来自**样式表没覆盖到的 Qt 原生控件**，以及**界面字号**：

- `QScrollBar` / `QComboBox::down-arrow` / `QSpinBox::up-button` / `QCheckBox::indicator`
  / `QGroupBox::frame` 全是 Fusion 自己画的：立体边框、三角箭头、凸起的微调按钮 —— 深色
  主题下最扎眼；编辑器右侧那条滚动条尤其像 2005 年的软件；
- 内置「深色」沿用的是 VSCode **旧版 Dark+**：`#3c3c3c` 的菜单条 + `#007acc` 的亮蓝状态栏，
  这两个色本身就是「复古」的同义词；
- 界面字体是 Qt 默认的 9pt，比 VSCode 的 13px 小一圈，整体显得拥挤陈旧。

处理：

1. **接管原生控件**：`apply_theme` 的 QSS 补齐滚动条（12px 无箭头、滑块半透明）、下拉 /
   微调箭头、勾选框与单选钮（强调色方块 + 白色对勾）、无边框的 GroupBox（改成
   「分隔线 + 小节标题」）、进度条、`QMenu` 圆角 + 悬停圆角、分隔线悬停高亮等；
2. **勾 / 箭头图标运行时生成**：QSS 只能引用图片，所以 `theme.py` 按当前主题色生成
   `check-*.svg` / `arrow-*.svg` 到临时目录（`glyph_dir()`），颜色仍只来自主题；
   目录不可写时退化成 "none"（纯色块），样式表依旧合法；
3. **内置深色 / 浅色换成 VSCode「Dark Modern / Light Modern」**：外壳中性灰、状态栏不再
   是亮蓝、选中态用现代蓝 `#0078d4`；浅色主题的浅灰选中底配深色文字（`selection_fg`）；
4. **界面字号 10pt**：`apply_ui_font(app)` 在**启动阶段、任何控件创建之前**调用一次；
5. 顺手清掉了几处违反「颜色只能来自 theme.py」的硬编码：连接 / 主机管理 / 工作目录选择
   三个弹窗里的 `color: gray` 与 `#c0392b`，改成 `muted` / `severity="error"` 属性选择器，
   由主题 QSS 下发颜色（`refresh_style()` 负责动态属性重刷）；设置弹窗补了外边距与行距。

**踩到的坑（已写进 design.md §4.15）**：`QApplication.setFont()` 如果发生在**已有控件之后**，
本机 Qt/PySide 会在后续任意一次 `setStyleSheet()` 上段错误（`test_file_tree.py` 的徽标渲染
用例能稳定复现，`pytest tests/test_file_tree.py tests/test_main_window.py` 必崩）。
所以界面字体只在启动阶段设一次，`apply_theme` 只管调色板与样式表；标题那种相对字号
（父字体 +8 / −1.5）也继续用 `setFont` 算，字体用磅值而不是像素值。

验证：`357 passed, 24 skipped`（当时；新增 `tests/test_theme_style.py` 6 例）、`pyflakes` clean；
离屏逐张核对了深色 / 浅色 / GitHub Dark 三套主题下的主窗口、设置弹窗、连接弹窗与主机管理弹窗。

### 8. 打包形态与资源替换位置（用户补充需求）

用户提了两条：**①「编译出来运行时候需要在哪里替换需要明确」**，**②「目前编译的是免安装版，
再编译一个安装版本」**。

问题在于 `--onefile`：`assets/` 在运行期被解压到 `sys._MEIPASS` 临时目录，用户改不了，
改了下次启动也会被覆盖。做法不是改打包方式（那会牺牲「目标机零依赖、单文件交付」），
而是把资源分成「随程序分发」与「用户自己加」两层，后者落在 `config_dir()` 下：

```
<配置目录>/themes/        配色主题 JSON
<配置目录>/fonts/         字体
<配置目录>/icon-themes/   文件图标主题（每主题一个子目录）
```

三个路径其实早就在扫（§2 的 `external_theme_dirs()` / `icon_theme_dirs()` / `user_font_dir()`），
缺的是**让用户知道**：

* 新增 `app/ui/resources.py` 收口这三个目录 + `ensure_user_resource_dirs()` + `open_resource_dir()`；
* 设置对话框「外观」组加一行「资源目录」：显示路径（过长中间省略，完整路径在 Tooltip）、
  右边「打开」按钮会自动建好三个子目录并交给系统文件管理器；
* 保存设置时重建「视图 → 主题」子菜单（`_populate_theme_menu()`），**新放的主题不用重启**就能选；
* 文档新增 [packaging.md](packaging.md)：两种交付形态、各平台配置目录、放什么文件、
  同名不覆盖内置、自查清单；README 的「打包」一节与快捷键表（`Ctrl+=/-/0` 由「字号」改为「全局缩放」）同步更新。

安装版：

* Linux —— `scripts/build_linux.sh` 现在一次出 AppImage + `.deb`，deb 组装单独放在
  `scripts/build_deb.sh`（可脱离 AppImage 跑）。包内布局 `/usr/bin/remote-code-editor`
  （启动壳）+ `/usr/lib/remote-code-editor/RemoteCodeEditor`（真身）+ 桌面项 / hicolor 图标 /
  AppStream 元数据 / copyright；`Depends:` 只声明 Qt 需要的系统库，`Recommends: openssh-client, git`，
  `postinst` 里带 `command -v` 守卫地刷新 desktop / icon 缓存。用 `SKIP_DEB=1` / `SKIP_APPIMAGE=1` 可只打一种。
* Windows —— 新增 `scripts/installer_windows.nsi`（NSIS 3：开始菜单 + 桌面快捷方式 +
  「应用和功能」卸载项 + 完成页提示资源目录）与 `scripts/build_windows_installer.bat`；
  `build_windows.bat` 末尾会在**装了 NSIS 时**自动调它，没装就跳过并打印 `winget install NSIS.NSIS`，
  免安装版不受影响。
* 两个平台的版本号都从 `app/utils/paths.py::APP_VERSION` 读，避免多份版本号漂移。

### 9. 验证与遗留（打包这条线）

```
bash -n scripts/build_linux.sh scripts/build_deb.sh          # shell 语法
bash scripts/build_deb.sh                                    # 用假可执行文件先跑通布局
SKIP_APPIMAGE=1 bash scripts/build_linux.sh                  # 真打包：PyInstaller + deb（约 1 分钟）
dpkg-deb -I / -c dist/RemoteCodeEditor_1.0.0_amd64.deb        # 校验 control 与包内布局
QT_QPA_PLATFORM=offscreen python -m pytest tests/test_user_resources.py -q   # 6 passed
```

**实测结果**（本机装了 PyInstaller 6.21，所以走了完整链路）：

* `dist/RemoteCodeEditor_1.0.0_amd64.deb` 74 MB，包内文件属主 root、`control` / 桌面项 /
  hicolor 图标 / metainfo / copyright 齐全，启动壳与真身分开放；
* 把 deb 解包后直接跑里面的单文件可执行程序，能正常启动（日志显示载入内置字体 + 「已启动」）；
* 用 `XDG_CONFIG_HOME` 指到临时目录、往里放一个 DejaVu 字体，**打包产物确实把它注册进来了**
  （日志 `已载入字体: DejaVu Sans Mono（DejaVuSansMono.ttf）`）—— 这条是「打包后还能替换资源」
  的端到端证据（配色主题 / 图标主题走同一套 `config_dir()` 扫描，另有单测兜底）。

两点没能验证：AppImage 需要 `appimagetool`（本机没有、沙箱无网络，脚本会保留 AppDir 并打印手动
打包命令）；NSIS 安装包需要 Windows + makensis，当前只有脚本、**没有实测**。

### 10. 顺手修掉一个「跑了就崩」的老问题：全量测试段错误

打包这条线收尾时按惯例跑全量测试，结果**整个 pytest 进程 `Segmentation fault`**，
崩在 `test_main_window.py` 的窗口 fixture 里（`apply_theme` → `app.setStyleSheet()`）。
单独跑每个文件都过，只有组合起来才崩 —— 和 §4.15 记的那个「字体踩坑」现象很像，
所以先按老结论排查，**结果不是**。

定位过程（在 /tmp 里复制一份仓库做实验，因为 `.git` 是只读的、没法 stash）：

1. 复制一份当前工作区，用单测组合 `pytest tests/test_file_tree.py tests/test_main_window.py`
   稳定复现崩溃，且**去掉本次新增的东西照样崩** → 确认不是新改动引入的；
2. 二分到 `test_file_tree.py::test_badged_filename_is_drawn_only_once` 就是触发者：
   它的 `themed_app` fixture 在收尾时把 `QApplication` 的样式表**恢复成空串**；
3. 把恢复值从 `""` 换成任意一条非空规则，崩溃立刻消失。

**结论**：本机 Qt/PySide 在「把 QApplication 样式表清空」之后，**下一次**
`setStyleSheet()` 会段错误（真实崩溃点在下一个用例建主窗口时，所以看起来像「字体问题」，
其实是测试 fixture 的收尾动作埋的雷）。

**修法**（`tests/conftest.py`）：把「带主题的 QApplication」提成全局 fixture `themed_app`，
收尾统一走 `previous or NEUTRAL_STYLESHEET`（`NEUTRAL_STYLESHEET = "QWidget { }"`），
`test_file_tree.py` / `test_theme_style.py` 两处重复的 fixture 删掉、改用这一个。
`design.md §4.15` 与 `AGENTS.md §6` 同步更正了这段「已知坑」的表述。

修完之后：**363 passed, 24 skipped, 1 warning**（那条 warning 是
`QApplication.setActiveWindow` 的 deprecated 提示，已知可接受），全量测试稳定跑绿。
（这台机器上崩溃是**必现**的，与本日新增代码无关；之前记的「357 passed」应该是在
还没加入 `themed_app` 那个 fixture 的状态下跑出来的，此处以现在的稳定结果为准。）

### 11. 自绘标题栏（干掉系统标题栏）与「重复按钮」的清理

用户提了三条界面问题：① 不要系统标题栏，自己画（参考 VSCode）；④ 大量重复的操作按钮意义何在；
⑤ 点「连接」为什么弹窗在正中间。这一节是 ①④，⑤ 见 §12。

**自绘标题栏**（`app/ui/widgets/title_bar.py`）：

- 主窗口 `setWindowFlag(FramelessWindowHint)`，标题栏里放**菜单栏 + 标题文本 + 三个窗口按钮**
  （最小化 / 最大化 / 关闭，图标自绘，关闭按钮 hover 用主题的 `syntax_error`，对齐 VSCode）；
- 无边框窗口失去系统的「拖动 / 缩放 / 双击最大化」，所以这三件事自己做：
  标题栏空白处拖动移动窗口、双击切换最大化；`WindowResizeFilter` 装在 **QApplication** 上
  （不是标题栏上），鼠标停在编辑器 / 滚动条 / 状态栏上时也能拖边缘缩放；
- 窗口标题 = `文件 - 工作目录 - RemoteCodeEditor 1.0.0`，在连接状态 / 工作目录 / 标签页切换时刷新。

**踩到的坑（值得记）**：在标题栏里 `new QMenuBar()` 也「看起来能用」，但 Qt 下次调用
`QMainWindow.menuBar()` 时会**另建一个**菜单栏并把菜单 widget 顶掉，于是菜单整块消失。
正确做法是让 `QMainWindow.menuBar()` 把**它自己那一个**建出来，交给标题栏收养，
再 `setMenuWidget(self.title_bar)`；而且 `setMenuWidget()` 会把原菜单栏隐藏，
搬完必须**显式 `menu_bar.show()`**。另外 `QMainWindow.menuBar()` 不是虚函数，
C++ 内部不会走 Python 的覆写，所以主窗口另外覆写了一个 `menuBar()` 供 Python 侧（含测试）取用。
`tests/test_title_bar.py` 用「同一个对象 + 父控件」把这条约定钉住了。

**清理重复按钮**：删掉 `addToolBar("主工具栏")` 整块（活动栏 + 菜单已有同一批命令，
工具栏只是把同样的图标又摆了一遍），同时删掉一个没人用的 QDockWidget ——
它不属于任何 dock 区域时会变成浮在窗口左上角的浮动控件，正好盖住自绘标题栏的菜单
（表现为菜单里凭空多出一个「Remote… ✕」）。测试从「工具栏有图标」改成
「没有重复工具栏，但命令仍然可达」（`test_no_duplicate_toolbar_and_commands_stay_reachable`）。

### 12. 连接入口：居中弹窗 → 侧边栏「远程资源管理器」

用户反馈「点连接按钮为什么弹窗在中间？不能像 VSCode 那样吗」。VSCode 的 Remote-SSH
是把主机列表放在**侧边栏的 Remote Explorer** 里，单击即连。于是：

- 新增 `widgets/hosts_view.py`：主机列表（`SSH` 分组）+ 每台主机的**历史工作目录**（子项），
  单击主机 = 连接，单击历史目录 = 连接并直接打开该目录（历史由
  `HostConfig.remember_workspace()` 维护，去重、限量 8 条、随主机配置落盘）；
- 面板头部只有「新增主机」「从 ~/.ssh/config 导入」「全部折叠」三个图标按钮 ——
  编辑 / 删除进右键菜单（用户反馈过按钮重复，能进菜单的就别摆按钮）；
- **凭据输入行做在面板底部**（不是居中对话框）：填完回车即连，提交后立即清空、不留明文；
  私钥被口令保护时也走同一行（`PASSPHRASE_REQUIRED_MESSAGE` 是判定依据，不靠猜字符串）；
- 活动栏的「连接」图标从「命令」改成「视图」（`ActivityItem(checkable=True)`），
  没有主机时直接进新增表单，不会再出现「先弹一个列表、再弹一个表单」的两段式。

**修掉一个「点箭头会误连」的坑**：原来的展开箭头热区判断读的是 `QCursor.pos()`（全局光标位置），
程序化触发 / 离屏测试时完全不可信，于是两个用例失败。改成用 `eventFilter` 记下
**视口里的真实按下位置**，再和 `visualItemRect()` + 缩进量比较；测试也从「伪造 `itemClicked`
+ monkeypatch `cursor`」改成**真发一次鼠标事件**，顺带补了「点主机名仍然要连接」的对照用例。

### 13. 终端：自绘网格 + GPU 渲染 + 远端 PTY

用户要求「需要终端，且要有强渲染能力、GPU 渲染，参考 wezterm 或开源终端」。
约束是不新增第三方依赖、远端零常驻服务，所以方案是：**自己写一个够用的终端内核 + 渲染**，
网络走 sshd 自带的 shell 通道（远端什么都不用装）。

| 分层 | 位置 | 要点 |
| --- | --- | --- |
| 屏幕模型 | `app/terminal/screen.py` | VT100/xterm 子集：光标定位 / 擦除 / 插入删除行 / 滚动区域 / SGR（加粗暗淡斜体下划线反显、16·256 色、真彩）/ 备用屏幕（vim、less）/ 光标显隐 / 自动换行 / OSC 丢弃 / DSR 应答；宽字符（CJK）占两格，组合字符并到前一格；回滚区默认 5000 行 |
| 按键映射 | `app/terminal/keys.py` | 纯函数：光标键 / 功能键 / Ctrl 组合 / Alt 前缀 / 应用光标模式（DECCKM 用 SS3）、Shift+Tab；Qt 键名到内部键名的表 |
| 通道 | `app/remote/shell_channel.py` | `transport.open_session()` + `get_pty()` + `invoke_shell()`；读取线程做**增量 UTF-8 解码**（多字节字符被 TCP 分片切开也不会花），`resize_pty()` 通知远端 SIGWINCH，`recv` 超时只用来周期性检查退出标志 |
| 画布 | `app/ui/widgets/terminal_canvas.py` | 有真实窗口系统时用 `QOpenGLWidget`（GPU 合成），离屏 / 无 GL 平台自动退回 `QWidget`，**两条路径共用同一份绘制代码**；相邻同色格子合并成一段文本一次 `drawText`、背景合并成一次 `fillRect`，宽字符单独绘制保证列对齐 |
| 面板 | `widgets/terminal_view.py` + `widgets/terminal_panel.py` | 底部面板（对齐 VSCode 的 Panel），多页签 + 新建 / 终止 / 收起；关闭按钮与编辑器标签同一个自绘图标；读取线程经信号切回 GUI 线程喂给屏幕模型，**控件自己不碰网络** |

终端面板放在编辑区下方的**竖直 QSplitter** 里，而不是 `QDockWidget` —— 无边框窗口里
dock 会浮到左上角盖住自绘标题栏（同一个坑在文件树 dock 上已经踩过）。快捷键对齐 VSCode：
`Ctrl+`` / `Ctrl+J` 开关面板、`Ctrl+Shift+`` 新建终端；`Shift+PgUp/PgDn` 翻页，
`Ctrl+Shift+C/V` 复制粘贴，有选区时 `Ctrl+C` 走复制、没有才发 `SIGINT`。
终端字号跟随**编辑器字号 × 全局缩放**（用户强调「Ctrl+=/- 是全局的」）。

顺手修掉一个绘制 bug：文本 run 里原来会把空格当成「没有字形」跳过，导致同一行后面的字符
整体左移（终端里空格是**占位**的）。现在空格进字符串、只把前导空格折算成 x 偏移，
`tests/test_terminal_view.py` 用「第 3 列必须有笔画、第 2 列（空格）几乎没笔画」把它锁住。

### 14. 验证与遗留（本段）

```
QT_QPA_PLATFORM=offscreen python -m pytest -q    # 488 passed, 27 skipped, 2 warnings
python -m pyflakes app tests                     # clean
QT_QPA_PLATFORM=offscreen python main.py         # 启动正常
```

终端这一条线还补了**真实链路**验证：`tests/test_ssh_end_to_end.py` 里的测试服务端加了
「`check_channel_shell_request` 起一个带 PTY 的真实 bash 并双向转发」，
于是新增的 3 个用例（写命令读回显、窗口大小变更真的送到远端、关闭后写入被忽略）
能在真实 paramiko SSH 服务端上跑一遍。沙箱里 socket 被禁所以它们是「跳过」，
本轮用一次授权在沙箱外跑全过（27 passed）—— 顺手发现并修掉一个真问题：
连接在底层被关掉时 paramiko 抛的是 `EOFError`（**不是** `OSError` 子类），
原来的 `write()` / `recv` 只抓 `OSError`，会让异常冒到 GUI 线程。

另用离屏渲染逐张核对了：自绘标题栏 + 菜单、暗 / 亮两套主题下的终端（提示符着色、
`ls` 彩色输出、反显 / 下划线 / 256 色 / 真彩、中文列对齐）、终端面板在编辑区下方的边界。

遗留：

- 终端**没有**做鼠标上报（vim 里不能用鼠标点），也没有做 DEC 字符集重映射与
  `htop` 会用到的部分高级序列 —— 按「远端跑 bash / vim / top 够用」的标准做的子集；
- GPU 路径在**本机离屏环境无法实测**（离屏平台没有 OpenGL 上下文，自动走软渲染），
  真实桌面上的表现需要在有显示器的机器上再看一眼；
- Git 账号登录 / 上游仓库对比仍然不做（远端只经 SSH 可达，与「密码不落盘」冲突）。

### 15. 交付与收尾

- 重新打了**安装版**：`SKIP_APPIMAGE=1 bash scripts/build_linux.sh` →
  `dist/RemoteCodeEditor_1.0.0_amd64.deb`（本机没有 `appimagetool`、沙箱也没网络，
  AppImage 那一步跳过，AppDir 已组装好在 `build/RemoteCodeEditor.AppDir`，
  联网后直接 `bash scripts/build_linux.sh` 即可补出 AppImage）；打完后起了一次产物
  （`QT_QPA_PLATFORM=offscreen ./dist/RemoteCodeEditor`）确认能正常启动。
- 两个打包脚本都补了 `--hidden-import PySide6.QtOpenGLWidgets / PySide6.QtOpenGL`：
  终端有 try/except 兜底，但显式声明更稳（冻结后的产物里确实带上了 `libQt6OpenGL`）。
- `.gitignore` 两处：`*.spec`（PyInstaller 每次重新生成）与 `file/`（外观资源的上游
  zip / vsix，`assets/` 里已经是解好的成品 + 许可文件，不重复入库）。
- 本轮改动已提交并推送到 `origin/main`（`git@github.com:HuifaYang/Remote_Editor.git`）。

---


## 2026-09-17

主题：**在高延迟链路上把 SSH 远程编辑做顺，并把界面外壳对齐 VSCode**。

### 1. 定位「慢」的真正原因：网络往返，不是语言

用户实测（板卡经 WiFi）反馈「列目录 3~4 秒、加载文件很久」，一度考虑用 C++/Qt 或
Rust + egui/Tauri 重写。日志分析结论：单次远端往返约 0.85~1.0 秒，一次 SFTP 列目录
需要 `open` + `readdir`×2 + `close` ≈ 3~4 个往返 —— **换语言改不了往返次数**，
因此方案定为「少发请求 + 重叠等待」，不做重写。

| 手段 | 位置 | 效果 |
| --- | --- | --- |
| 目录列举请求去重 | `MainWindow._pending_listings` | 展开根节点与打开工作目录各请求一次 → 合成一次（日志里省掉 2.9 秒） |
| 根节点标记已加载 | `RemoteFileTree.set_root()` | `setExpanded(True)` 不再触发第二次列举 |
| 目录结果缓存（TTL 120s，上限 200） | `MainWindow._dir_cache` | 命中即上屏；新建/删除/重命名/切换目录/`F5` 显式失效 |
| 后台预取子目录（最多 3 个） | `MainWindow._prefetch_children` | 「点开子目录」变成秒开 |
| 拆分 `sftp_lock` 与命令锁 | `app/remote/ssh_client.py` | SFTP 与 exec 通道不再互相排队 |
| `compress=True` | `app/remote/ssh_client.py` | 文本传输体积下降 |

### 2. Git 往返预算：打开干净文件 **0** 个远端 Git 命令

- `GitClient.repo_info()` 合并 `git rev-parse`（原本要跑 3 次命令）；
- 新增 `tree_status(scope=工作目录)` 快照，同时供文件树着色、状态栏、单文件 diff 复用；
- `TreeStatus.status_for_diff()`：`git status` 未列出的路径即「未变更」，连远端进程都不必启动；
  用 `fetched_at` 与文件 mtime 兜住快照过期的情况；
- 保存 / 删除后按本地知识更新（`mark_saved` / `mark_removed` / `mark_clean` + `_recompute_dirs`），
  不再「写一个文件扫一次全仓库」。
- 预算表（`tests/test_git_client.py` 断言）：打开工作目录 2 条命令、打开未修改文件 0 条、
  已修改文件 1 条 `git diff`、保存/删除 0 条。

### 3. 修掉用户报的两个实际 bug

- **撤销修改后文件树仍然发黄**：只按「是否保存过」判断变更，看不出「改回原样」。
  新增 `Document.loaded_text` / `clean_at_open` / `reverted`，保存时用 `mark_saved(path, clean=)`
  决定是标变更还是撤回标记。
- **必须手动保存太麻烦**：自动保存改为**默认开启**（`SETTINGS_VERSION = 2` + 迁移），
  停手 1.5 秒上传，且自动保存路径上**不弹模态对话框**（远端被外部改动时只提示，不打断输入）。
- 顺带修掉连接弹窗里密码栏被按钮挤没的问题（弹窗最小宽度 460，密码框独立成行 ≥240px）。

### 4. 界面外壳对齐 VSCode（用户明确要求「照 VSCode 做」）

| 改动 | 位置 |
| --- | --- |
| 单列文件树：只有文件名，22px 紧凑行，目录在前按名排序，大小/时间/权限挪进 Tooltip | `widgets/file_tree.py` |
| 顶部只放图标按钮（新建文件/新建文件夹/刷新/折叠），避免文字挤掉文件夹名 | `main_window.py::_build_explorer_header` |
| 变更徽标改为**画出来的图形**（圆角填色块 + 字母，固定在行右端，长文件名也挤不掉，字母黑白按底色亮度自动选） | `widgets/badge.py` |
| 自绘 16px 单色线条图标（无图标字体、无 SVG 资源，颜色随主题重建，附 2 倍图） | `icons.py` |
| 活动栏（资源管理器/查找/源代码管理/连接/打开文件夹/设置）、互斥切换、再点收起 | `widgets/activity_bar.py` |
| 欢迎页：没有打开的标签页时占据编辑区；未连接只给「连接主机」，**「打开远程文件夹」连接后才可用** | `widgets/welcome.py` |
| 源代码管理面板：列出与仓库不同的文件（相对仓库根路径 + 徽标），点开即编辑，**打开面板零远端请求** | `widgets/scm_view.py` |
| 顶部工具栏 `ToolButtonIconOnly`；标签页关闭按钮换成自绘灰叉（Qt 默认图形在深色主题下是红块） | `main_window.py` / `widgets/editor_tabs.py` |
| 主题补齐 VSCode 风格字段与统一 QSS；侧边栏、工具栏、状态栏、列表配色收敛到 `theme.py` | `theme.py` |
| 状态栏 `Git: Git: main` 重复前缀 | `widgets/status_bar.py` |

### 5. 决策记录（明确**不做**的事）

- **不重写为 C++/Qt 或 Rust/Tauri**：瓶颈是往返次数与链路时延，与语言无关。
- **不做 Git 账号登录 / 上游仓库对比**：远端只经 SSH 可达，对比基准就是远端工作区自身的
  `HEAD`/索引（即 VSCode SCM 视图在有本地仓库时的内容）。要拉上游需远端 https 地址 + 凭据存储，
  与「密码不落盘、远端零常驻服务」的约束冲突。需要最新状态时用 `Shift+F5` 刷新。
- **插件机制本版本不实现**：仅把会话、任务、文件树、编辑器、主题保持解耦（只经信号与
  `remote_ops` 交互），方向记录在 design.md §7。

### 6. 文档

README 原本混着「项目介绍」和「项目需求」，拆成三份并按职责分层：

- `README.md`：项目介绍、功能一览、典型流程、快捷键、打包；
- `docs/requirements.md`：V1.0 需求基线（沿用原始章节编号，代码注释里的「需求 §5.10」可直接对应）；
- `docs/design.md`：架构、选型论证、关键实现（含新增的 §4.13 界面外壳）、测试策略与已知限制。

### 7. 验证

```
QT_QPA_PLATFORM=offscreen python -m pytest -q    # 315 passed, 24 skipped
python -m pyflakes app tests                     # clean
QT_QPA_PLATFORM=offscreen python main.py         # 启动正常
```

另用离屏渲染（暗/亮两套主题）逐张核对了欢迎页、资源管理器、源代码管理面板、
长文件名 + 徽标对齐的视觉效果；连接弹窗在 13pt / 16pt 字号下均无裁剪。

### 8. 遗留 / 下一步

- `Control+B` 式的侧边栏收起目前只由活动栏按钮触发，尚未绑定快捷键；
- 源代码管理面板尚未做「按目录分组 / 暂存区」这类完整 SCM 能力（当前只做状态展示与跳转）；
- 插件机制（design.md §7）仍为后续方向。

### 9. 流程约定：约束可经用户同意破限

requirements.md §1 与 AGENTS.md §2 的约束是**默认基线**，不是绝对禁令。用户明确同意时可以破限
（临时引入依赖、临时放宽某条硬性要求等），但需：动手前说明破的是哪一条及原因 → 影响限制在
最小范围并注明 → 事后确认保留还是回退，并记入本日志。

同日的实践案例（未写入代码，仅环境侧）：GitHub 推送最初用会话里的 PAT，`github.com:443`
TLS 被中断后改为 SSH —— 生成 `~/.ssh/id_ed25519_github` 专用密钥、在 `~/.ssh/config` 追加
`Host github.com`（带 `IdentitiesOnly yes`，避免本机 7 把密钥触发 too many authentication
failures），并把 `origin` 切到 `git@github.com:HuifaYang/Remote_Editor.git`。PAT 方案已废弃，
建议在 GitHub 上吊销那两枚 token。
