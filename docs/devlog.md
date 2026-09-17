# 开发日志

按日期倒序记录**当天做了什么、为什么这么做、验证结果与遗留事项**。
需求基线见 [requirements.md](requirements.md)，实现说明见 [design.md](design.md)。

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
