# AGENTS.md —— 项目记忆（新会话先读这一份）

RemoteCodeEditor **V2**：轻量级跨平台 SSH 远程代码编辑器，面向嵌入式 ARM 板卡（RK3566 / RK3588 /
香橙派等）。**本地 GUI + SSH/SFTP，目标机零部署、零常驻服务**（板卡只用原生 sshd / sftp / git）。
技术栈：Electron + TypeScript + Monaco + ssh2。

- 项目代码：仓库根目录（V2 即根，无套壳子目录）
- 规格（必须先读）：[docs/spec-v2.md](docs/spec-v2.md)（总纲）
  + 5 个分册 `spec-v2-algorithms.md` / `spec-v2-data.md` / `spec-v2-ui.md` / `spec-v2-git-repo.md` / `spec-v2-tests.md`
- 开发日志：[docs/devlog.md](docs/devlog.md)
- 命令（仓库根执行）：`npm run lint` / `npm test` / `npm run typecheck` / `npm start` / `npm run build:dir`

> V1（Python + PySide6）已于 2026-09-23 删除，历史在 git 里；`/tmp/remote-editor-v1-backup-20260923.tar.gz`
> 是删除时的快照（含未提交改动，/tmp 可能被清理）。

## 硬性约束（动手前先看总纲 §0）

- **里程碑顺序执行**：当前 M3（环境镜像 + LSP）→ M4 外壳·文件与编辑 → M5 Git/搜索 → M6 收尾。
  每个里程碑的验收 = 规格对应测试全绿 + `npm run lint` 0 告警 + `npm run typecheck` 0 错误。
- **依赖白名单**（总纲 §4）：electron / monaco-editor / xterm(+fit) / ssh2 / typescript / electron-builder /
  vitest / eslint 及少量类型与测试辅助。**不引打包器**（Monaco 走 AMD loader），不引任何 UI 库、状态库。
- **颜色只能来自 `src/renderer/styles/tokens.css`**（总纲 §6.2），其它地方禁止写死颜色。
- **密码 / 私钥口令只存内存**，禁止落盘、进日志、进崩溃转储；`hosts.json` 禁止有凭据字段。
- **目标机零常驻服务**：语言服务默认在工作机跑、指向本地镜像；`lspTransport === "remote"` 是唯一例外，
  且只按需拉起用户自己事先装好的 clangd/pylsp，不部署任何东西。
- **性能预算逐条验收**（总纲 §7）：首次镜像同步 1 条命令、代码补全/跳转/悬浮 0 次远端往返等。
- UI 文案与代码注释用**中文**；提交信息也用中文。
- 改动要配测试：新增行为加用例，改行为改对应用例，不削弱既有断言（§10 与分册 4 是全清单）。
- 不主动 `git commit` / 建分支，除非用户明确要求；改动求**最小外科式**，别顺手重构无关代码。

## 性能与易错点（总纲 §13）

- tar 流**边收边写**（`pipeline`），禁止 `Buffer.concat` 全量进内存。
- `compile_commands.json` 的绝对远端路径**必须重写**为本地镜像前缀，否则 clangd 静默失效。
- JSON-RPC 分帧 `Content-Length` 按**字节**算，半包/粘包都要处理。
- Monaco 诊断用 `monaco.editor.setModelMarkers`（固定 owner），禁止自己画波浪线。
- 关标签必须 `model.dispose()`；语言服务器退出/断连必须 `kill()`。
- ssh2 的 SFTP 不是并发安全，统一走 `SSHConnection.sftpRun` 串行队列。
