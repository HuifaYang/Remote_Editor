# ide —— CodeOSS 产品层

`ide/` 是 RemoteCodeEditor 的 CodeOSS 产品层：

```text
ide/
├── vscode/                 # 上游 CodeOSS git submodule（固定提交）
├── extensions/sshfs/       # 我们的内置扩展真源
│   ├── src/
│   │   ├── extension.js    # 扩展入口、连接状态、命令
│   │   ├── session.js      # SSH 会话（凭据只在内存）
│   │   ├── fs-provider.js  # sshfs:// 文件系统
│   │   ├── terminal.js     # 远端终端
│   │   ├── search.js       # 远端搜索
│   │   ├── scm.js          # 远端 Source Control
│   │   ├── lsp.js          # 本机语言服务桥
│   │   ├── cache.js        # 影子缓存 LRU/TTL/容量
│   │   └── tasks.js        # 远端任务
│   └── package.json
└── tools/                  # 构建、启动、E2E、VSIX 安装、上游补丁
```

## 上游 CodeOSS

`ide/vscode` 是 `microsoft/vscode` 的 git submodule，不包含在普通文件提交里，也不提交
`node_modules`、`out*`、`VSCode-linux-x64` 等构建产物。

```bash
npm run codeoss:bootstrap
node ide/tools/apply-branding.mjs
```

`apply-branding.mjs` 是唯一的品牌/集成补丁入口，幂等；升级上游后只需拉新子模块提交并重跑它。
它会：

- 写入 RemoteCodeEditor 品牌和 Open VSX 配置；
- 保留上游 Copilot / Chat 所需的 proposed API 白名单，并追加我们的 `rce-remote` 白名单；
- 移除不随本仓库发布的专有 Copilot 源码目录，避免打包缺失 SDK；
- 修复 Electron 本地缓存打包；
- 修复虚拟工作区 `.vscode` 探测和关闭远程连接。

官方 GitHub Copilot 不打包进本仓库；用下面的脚本安装用户自己的 VSIX：

```bash
bash ide/tools/install-vsix.sh /path/to/GitHub.copilot.vsix
```

## 构建

```bash
npm run compile                 # 编译共享核心
node ide/tools/build-extension.mjs
```

构建扩展时会把 `extensions/sshfs/src` 和仓库根 `src/main/**` 一起 esbuild 成单文件，
同步到 `ide/vscode/extensions/rce-remote` 与已解包的 `ide/VSCode-linux-x64`。

## 运行与验证

```bash
npm run run       # 假靶机 / 真板子入口，见根 README
npm run e2e       # 端到端 JSON 报告 + 截图
```

端到端验证必须真开 CodeOSS 工作区，不靠纸面推演。当前覆盖文件、终端、搜索、SCM、远端
`.vscode` 配置、任务、语言服务跳转/悬浮/符号/补全/诊断。
