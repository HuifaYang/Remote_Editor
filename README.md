# RemoteCodeEditor

RemoteCodeEditor 是一个面向嵌入式 ARM 板卡的远程 IDE。它不是重新画一个编辑器壳，而是以
**CodeOSS 为界面和工作台底座**，用我们自己的 SSH/SFTP 层替换 VS Code Remote-SSH，并在本机维护
源码影子缓存，让 clangd / pylsp / GitHub Copilot 这类本机能力可以直接工作。

目标机保持轻量：远端只用原生 `sshd` / `sftp` / `git` / 用户自己的工具链。语言服务默认跑在开发机，
指向按项目同步下来的源码影子目录；远端不常驻 VS Code Server。

## 目录结构

```text
.
├── ide/
│   ├── vscode/                 # 上游 CodeOSS 子模块（固定提交，不提交构建产物）
│   ├── extensions/sshfs/       # 我们唯一的 CodeOSS 扩展真源
│   │   ├── package.json        # 命令、菜单、配置、终端 profile、proposed API
│   │   └── src/
│   │       ├── extension.js    # 扩展入口 / 连接管理 / 状态和命令
│   │       ├── session.js      # SSH 会话（凭据只存内存）
│   │       ├── fs-provider.js  # sshfs:// 文件系统
│   │       ├── terminal.js     # 远端终端
│   │       ├── search.js       # 远端搜索
│   │       ├── scm.js          # 远端 Git / Source Control
│   │       ├── lsp.js          # 本机语言服务桥 + URI/path 映射
│   │       ├── cache.js        # 影子缓存 LRU/TTL/容量管理
│   │       └── tasks.js        # 远端任务
│   └── tools/                  # 构建、启动、端到端、VSIX 安装
├── src/
│   ├── main/                   # 共享核心：SSH/SFTP/Git/搜索/终端/镜像/LSP
│   └── shared/                 # 跨模块类型和纯函数
├── tests/                      # 核心单元 / 集成测试
├── docs/
│   ├── ssh-vs-remotessh.md     # 与 VS Code Remote-SSH 的差异和实现边界
│   ├── lsp-mirror-design.md    # 本机语言服务 / 影子缓存设计
│   └── legacy/                 # 已停止维护的 V2 自绘 UI 规格
└── resources/                  # 图标、语言服务资源说明
```

旧 V2（Electron + Monaco 自绘外壳）已经从主线删除。保留的 `src/` 只是 CodeOSS 扩展复用的
SSH/SFTP/Git/搜索/终端/镜像/LSP 核心，不再是独立应用程序。

## 快速开始

要求：Linux 开发机、Node.js 24（与 `ide/vscode/.nvmrc` 对齐）、`git`、`npm`。

```bash
# 1. 拉取固定版本的 CodeOSS 子模块
npm run codeoss:bootstrap

# 2. 安装本仓库核心依赖
npm install

# 3. 给上游 CodeOSS 打品牌补丁（幂等）
node ide/tools/apply-branding.mjs

# 4. 编译共享核心
npm run compile

# 5. 第一次还需要在上游目录安装依赖并构建 CodeOSS
cd ide/vscode
npm_config_userconfig=../tools/empty-npmrc npm install --no-audit --no-fund
npm run compile
npm run electron
npm run gulp vscode-linux-x64
cd ../..

# 6. 打包并同步我们的内置扩展
npm run build:extension
```

## 运行

```bash
# 假靶机：直接打开一个可点击的文件/终端/SCM 示例
npm run run

# 真板子
bash ide/tools/run-app.sh user@192.168.1.50:22 /home/root/app
```

密码只通过环境变量 `RCE_PASS` 传入，或者由窗口中的连接表单临时输入；不会写入
`hosts.json`、日志或崩溃转储。

## 语言服务

语言服务默认 `local`：

```text
sshfs://user@host:port/项目/src/main.c
        ⇅ URI/文本翻译
本机影子目录（只同步源码、头文件、构建配置）
        ⇅ stdio JSON-RPC
本机 clangd / pylsp
```

- 只拉源码、头文件、`compile_commands.json`、`CMakeLists.txt`、`Makefile` 等语言服务输入；
- 不拉 `node_modules`、`build/`、二进制、依赖库；
- 首次同步是一条 SSH `exec + tar` 流，不做逐文件 SFTP；
- 后续增量按 manifest 更新；
- 影子缓存按项目隔离，并受 `rce.cache.maxSizeMB`、`rce.cache.maxProjectMB`、
  `rce.cache.ttlDays` 和 LRU 管理，不会无限增长；
- 当前语言服务支持补全、诊断、跳转、声明/类型定义/实现、引用、重命名、悬浮、符号、
  签名帮助、代码操作、格式化和折叠。

如果上游没有 `clangd`，可以把对应平台的 clangd 放到 `resources/clangd/<平台>/`，或者在设置里
指定 `rce.lsp.cppPath`。

## GitHub Copilot

本仓库不内置 GitHub Copilot 的专有二进制/VSIX。你可以在自己的机器上使用官方 VSIX：

```bash
# 把 VS Code 里的 GitHub Copilot VSIX 安装到开发版扩展目录
bash ide/tools/install-vsix.sh /path/to/GitHub.copilot.vsix

# 然后重启 RemoteCodeEditor，在编辑器里登录 GitHub Copilot
```

说明：

- Copilot 是独立扩展，和本机 clangd 互不替代；
- 我们只负责让 CodeOSS 工作区和文件系统对它可用，不保存你的 Copilot 凭据；
- 是否允许把代码发送给 Copilot 由你的账号和策略决定；
- 如果使用 VS Code 官方安装目录，VSIX 通常可以在其扩展缓存中找到，或者从扩展市场手动下载。

## 校验

```bash
npm run lint
npm run typecheck
npm test
bash ide/tools/run-e2e.sh
```

`run-e2e.sh` 需要 X / xvfb 和本地监听端口，会在 CodeOSS 里打开 `sshfs://` 工作区，
验证文件、终端、搜索、SCM、远端配置、任务和本机语言服务链路，并输出 JSON 报告与截图。
