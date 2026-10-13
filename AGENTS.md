# AGENTS.md —— RemoteCodeEditor 项目记忆

## 一句话路线

RemoteCodeEditor 以 **CodeOSS 为工作台底座**，用我们自己的 SSH/SFTP 层替代 VS Code Remote-SSH。
目标机零部署、零常驻 VS Code Server；语言服务默认在开发机运行，指向按项目同步下来的源码影子缓存。

旧 V2（Electron + Monaco 自绘外壳）已停止维护，规格文档归档在 `docs/legacy/`。不要再把 V2
的 renderer、preload 或自绘 UI 方案混回主线。

## 必读

- 根 `README.md`：目录、构建、运行、Copilot、语言服务。
- `ide/README.md`：CodeOSS 产品层和扩展构建。
- `docs/ssh-vs-remotessh.md`：与 Remote-SSH 的逐项差异和当前状态。
- `docs/lsp-mirror-design.md`：本机语言服务、源码影子缓存、URI/路径翻译、缓存策略。
- `docs/devlog.md` 末尾：最新进度快照。

## 目录

```text
ide/
├── vscode/                 # 上游 CodeOSS git submodule（固定提交，不提交构建产物）
├── extensions/sshfs/       # 内置扩展唯一真源
│   └── src/
│       ├── extension.js    # 入口、连接状态、命令
│       ├── session.js      # SSH 会话，凭据只在内存
│       ├── fs-provider.js  # sshfs:// 文件系统
│       ├── terminal.js     # 远端终端
│       ├── search.js       # 远端搜索
│       ├── scm.js          # 远端 Git / Source Control
│       ├── lsp.js          # 本机语言服务桥 + URI/path 映射
│       ├── cache.js        # 影子缓存 LRU/TTL/总容量
│       └── tasks.js        # 远端任务
└── tools/                  # 构建、启动、E2E、补丁、VSIX 安装

src/
├── main/                   # 共享核心：SSH/SFTP/Git/搜索/终端/镜像/LSP
└── shared/                 # 跨模块类型与纯函数

tests/                      # 核心单元/集成测试
docs/                       # 当前设计文档；docs/legacy 为已归档 V2 规格
resources/                  # 图标与 clangd 资源说明
```

## 构建与验证

```bash
npm run codeoss:bootstrap       # 初始化 ide/vscode 子模块
node ide/tools/apply-branding.mjs
npm run compile
npm run build:extension
npm run lint
npm run typecheck
npm test
npm run e2e                     # 需要 X/xvfb 和本地监听端口
```

直接看软件：`bash ide/tools/run-app.sh`（假靶机）或
`bash ide/tools/run-app.sh user@host[:port] [远端目录]`（真板子）。

## 硬性约束

- 不自制 UI；编辑器、远程资源管理器、设置、通知等尽量使用 CodeOSS 原生能力。
- 目标机零常驻服务；远端只复用 sshd/sftp/git 和用户已有工具，不为本产品部署 VS Code Server。
- 密码、私钥口令只存内存，禁止落盘、进日志、进崩溃转储。
- 远端仍是权威数据；本机影子缓存只是语言服务输入，删除缓存不影响远端。
- 影子缓存必须有界：按项目隔离，支持 LRU/TTL/总容量/单项目容量，活跃项目和未同步项目不可自动删除。
- 语言服务流程：`sshfs://` 文档 ⇄ 本机影子路径 → 本机 clangd/pylsp；普通文件读写走 SFTP，
  源码同步走 SSH exec + tar 流，禁止逐文件 SFTP 预取。
- `compile_commands.json` 的远端绝对路径必须重写为本地影子前缀，否则 clangd 静默失效。
- GitHub Copilot 使用官方 VSIX，不把专有扩展直接打包进仓库；保留上游 Copilot/Chat 所需的
  proposed API 白名单。
- UI 文案与代码注释用中文；提交信息也用中文。
- 不主动 `git commit` / 建分支，除非用户明确要求；改动求最小外科式。
