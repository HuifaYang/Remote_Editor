# AGENTS.md ——织码 WeaveCode 项目记忆

## 一句话路线

织码 WeaveCode 以 **CodeOSS 为工作台底座**，用我们自己的 SSH/SFTP 层替代 VS Code Remote-SSH。
目标机零部署、零常驻 VS Code Server，也**不要求目标机安装语言服务器**。代码智能模式下，
开发机标准 LSP 通过只读 SSHFS 惰性读取远端整棵文件系统；目标机只需要 sshd/sftp。
浏览模式不启动语言服务；不复制源码/sysroot，也不用“全局 flags 猜测”替代远端编译数据库。

旧 V2（Electron + Monaco 自绘外壳）已停止维护，规格文档归档在 `docs/legacy/`。不要再把 V2
的 renderer、preload 或自绘 UI 方案混回主线。

## 必读

- 根 `README.md`：目录、构建、运行、Copilot、语言服务。
- `ide/README.md`：CodeOSS 产品层和扩展构建。
- `docs/ssh-vs-remotessh.md`：与 Remote-SSH 的逐项差异和当前状态。
- `docs/lsp-mirror-design.md`：本机标准 LSP + 只读 SSHFS、双模式、路径映射；remote/local 仅兼容。
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
│       ├── lsp.js          # 本机标准 LSP + SSHFS 视图 + 双模式 + URI/path 映射
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
npm run build:deb                 # Linux amd64 可安装 deb + SHA-256
npm run verify:release            # lint/typecheck/test/E2E/deb 完整发行门禁
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
- 远端仍是唯一权威数据；remote 模式语言服务直接读远端源码和 `compile_commands.json`，不镜像。
- 默认语言服务流程：`sshfs://` 文档 ⇄ 只读 SSHFS 挂载视图 → 开发机标准 LSP。
  目标机不得被要求安装 clangd/pylsp/gopls；语言服务器由 IDE 在开发机管理。
- 任意语言通过 `rce.lsp.servers` 配置，不得再写死 cpp/python；C++ 内置 clangd，Python 内置 pylsp。
- 浏览模式不得自动启动 LSP、镜像或高频 Git 轮询；切到代码智能才按当前文件优先启动。
- `remote`（目标机已有 LSP）和 `local`（旧镜像）只是兼容路径，不得作为默认架构。
- SSHFS 挂载必须只读、可卸载；凭据只通过子进程 stdin，禁止写命令行、日志或磁盘。
- 远端软链接路径必须通过 `pwd -P` 建立别名，服务端返回真实路径时要折回工作区 URI。
- GitHub Copilot 使用官方 VSIX，不把专有扩展直接打包进仓库；保留上游 Copilot/Chat 所需的
  proposed API 白名单。
- UI 文案与代码注释用中文；提交信息也用中文。
- 不主动 `git commit` / 建分支，除非用户明确要求；改动求最小外科式。
