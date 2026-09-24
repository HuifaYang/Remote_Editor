# 分册 3 · 数据与 IPC 规格（配置文件 schema、逐条时序）

> 对应 `src/main/ipc.ts`、`src/preload/index.ts`、`userData/` 下的持久化文件。
> 所有 IPC 通道名、事件名、载荷形状**以此为准**，禁止另起名字。

---

## D1 持久化文件（都放 `app.getPath("userData")`，即系统用户配置目录）

### D1.1 `hosts.json` — 主机列表（**禁止含任何凭据**）

```json
{
  "version": 1,
  "hosts": [
    {
      "id": "8f3a…uuid",
      "name": "Robot-3566",
      "host": "192.168.1.100",
      "port": 22,
      "username": "root",
      "authMethod": "password",
      "privateKeyPath": "",
      "workspace": "/home/le/ros2_ws/src",
      "workspaces": ["/home/le/ros2_ws/src", "/home/le/other"],
      "lastUsedAt": 1730000000
    }
  ]
}
```
- 保存前**必须断言**：对象里不存在 `password` / `passphrase` / `secret` 任意键（测试覆盖）。
- `workspaces` = 历史工作目录（最多 10 条，最新在前）。

### D1.2 `settings.json` — 应用设置

```json
{
  "version": 1,
  "theme": "dark",                 // dark | light
  "uiFontFamily": "",              // 空 = 系统
  "fontSize": 12,                  // 8~32
  "zoomLevel": 1.0,                // 0.7~2.0
  "tabSize": 4,                    // 1~16
  "useSpaces": true,
  "wordWrap": false,
  "showLineNumbers": true,
  "highlightCurrentLine": true,
  "autoSave": true,
  "autoSaveDelayMs": 1500,         // 500~30000
  "maxFileSizeMb": 32,             // 1~512
  "sshTimeoutSeconds": 15,         // 3~300
  "sshKeepaliveSeconds": 30,       // 0~300
  "sshStrictHostKey": false,
  "lspEnabled": true,
  "lspTransport": "local",         // local=工作机镜像（默认） | remote=板子上（备用，需用户自行装好服务器） | disabled=关闭
  "cppServer": "clangd",
  "pythonServer": "python3 -m pylsp",
  "window": { "x": 0, "y": 0, "width": 1280, "height": 800, "maximized": false }
}
```
- 读取时逐字段校验范围，非法值回默认（**禁止**整份读失败就崩）。

### D1.3 `known_hosts` — 主机公钥记录（`ssh2` 格式，每行 `host keytype base64`）
### D1.4 `logs/app-YYYYMMDD.log` — 按天滚动，保留 7 天
### D1.5 镜像目录 `mirror/<hostId>/<sha1(workspace)[0..12]>/`
- `manifest.json`（schema 见分册 1 A8）
- `compile_commands.json` 或 `compile_flags.txt`（见 A9）
- 解压出的源码树（与远端相对路径一致）
- `.staging/`（同步时的临时解压目录，同步完成原子替换）

---

## D2 IPC 协议（渲染进程 `window.api` ⇄ 主进程）

通道命名规则：请求 = `invoke("api:<域>.<动作>")`，事件 = `send("event:<名>")`。
下表「请求」列即 `ipcRenderer.invoke` 的 channel 与参数。

### D2.1 主机

| 请求 | 参数 | 返回 | 错误 |
| --- | --- | --- | --- |
| `api:host.list` | — | `HostConfig[]` | — |
| `api:host.save` | `HostConfig` | `void` | `invalid-input` |
| `api:host.remove` | `id` | `void` | — |
| `api:host.connect` | `id`, `SecretInput?` | `{ workspace: string }` | `auth` / `auth-passphrase-required` / `timeout` / `network` / `host-key` |
| `api:host.disconnect` | — | `void` | — |
| `api:host.listLocalKeys` | — | `{path,label,encrypted}[]` | — |

### D2.2 文件

| 请求 | 参数 | 返回 | 错误 |
| --- | --- | --- | --- |
| `api:fs.listDir` | `path` | `RemoteEntry[]` | `sftp` |
| `api:fs.readFile` | `path` | `{text,encoding,newline,fingerprint}` | `invalid-input`（超 32MB/编码无法识别） |
| `api:fs.saveFile` | `path, text, {encoding?,newline?}` | `Fingerprint` | `sftp` |
| `api:fs.create` | `path, isDir` | `void` | `sftp` |
| `api:fs.rename` | `from, to` | `void` | `sftp` |
| `api:fs.remove` | `path` | `void` | `sftp` |
| `api:fs.stat` | `path` | `RemoteEntry \| null` | — |

### D2.3 镜像 / Git / 搜索 / LSP / 终端

| 请求 | 参数 | 返回 | 错误 |
| --- | --- | --- | --- |
| `api:mirror.sync` | — | `MirrorResult` | `mirror` |
| `api:git.treeStatus` | `directory` | `GitTreeStatus` | `git` |
| `api:git.fileDiff` | `path` | `GitDiff` | `git` |
| `api:git.commit` | `message, {amend?,push?,sync?}` | `string` | `git` |
| `api:git.branches` | — | `BranchInfo[]` | `git` |
| `api:git.switchBranch` | `name` | `string` | `git` / `invalid-input` |
| `api:git.logGraph` | `limit?` | `GraphRow[]` | `git` |
| `api:git.refresh` | — | `GitTreeStatus` | `git` |
| `api:search.find` | `pattern, {caseSensitive,regex}` | `SearchMatch[]` | `ssh` |
| `api:lsp.completion` | `uri, line, character` | `CompletionItem[]` | `lsp` |
| `api:lsp.definition` | `uri, line, character` | `Location[]` | `lsp` |
| `api:lsp.hover` | `uri, line, character` | `string \| null` | `lsp` |
| `api:lsp.changed` | `uri, text, version` | `void`（单向通知） | — |
| `api:terminal.create` | `id, cols, rows` | `void` | `ssh` |
| `api:terminal.write` | `id, data` | `void` | — |
| `api:terminal.resize` | `id, cols, rows` | `void` | — |
| `api:terminal.close` | `id` | `void` | — |

### D2.4 事件（主进程 → 渲染进程，`on(channel, cb)` 订阅，返回退订函数）

| 事件 | 载荷 | 触发时机 |
| --- | --- | --- |
| `event:connection-state` | `{ connected: boolean, message?: string }` | 连接成功/断开/掉线 |
| `event:auth-required` | `{ hostId: string, kind: "password" \| "passphrase" }` | 认证失败需要用户输入 |
| `event:mirror-progress` | `{ done: number, total: number, current: string }` | tar 解压过程中（每 200ms 节流） |
| `event:mirror-done` | `MirrorResult` | 镜像同步完成（含 changed/removed） |
| `event:diagnostics` | `{ uri: string, diagnostics: Diagnostic[] }` | LSP publishDiagnostics |
| `event:terminal-data` | `{ id: string, data: string }`（base64） | 终端输出（**批量合并到一帧，≥16ms 或 4KB 合并**） |
| `event:terminal-closed` | `{ id: string, code?: number }` | 远端 shell 退出 |
| `event:progress` | `{ key: string, text: string, done: boolean }` | 长任务状态栏提示 |

---

## D3 关键时序（逐条画出来，实现者照抄）

### D3.1 连接（含密码回退）
```
渲染            主进程                       ssh2
 │ host.connect(id) │                           │
 ├─────────────────►│ conn.connect()           │
 │                  ├──────────────────────────►│ 试默认名私钥
 │                  │◄──────────────────────────┤ 失败(code:auth)
 │◄─ event:auth-required(kind=password) ───────┤
 │ 出密码输入行     │                           │
 │ host.connect(id,{password})                  │
 ├─────────────────►│ conn.connect()           │
 │                  ├──────────────────────────►│ 密码认证
 │                  │◄──────────────────────────┤ ok
 │                  │ mirror.sync()  ← tar 单流 │
 │◄─ event:mirror-progress ────────────────────┤
 │◄─ event:mirror-done ────────────────────────┤
 │◄─ { workspace }  │                           │
```

### D3.2 打开文件（含跳行）
```
渲染                主进程
 │ fs.readFile(p)  │           → SFTP 读板子当前内容（1 次往返）
 ├────────────────►│           → 写镜像本地副本
 │◄── {text,fingerprint}
 │ Monaco 打开      │
 │ lsp.changed(uri,text,1) ──► │ → 本地 clangd didOpen（0 远端往返）
 │ （若带目标行）editor.revealLine(line)
```

### D3.3 保存
```
渲染                主进程
 │ fs.saveFile(p,text)
 ├────────────────►│  写镜像本地文件（原子）
 │                  │  SFTP 写 <p>.rce-tmp-xxx → rename 到 p（2 次往返）
 │                  │  更新 fingerprint + 本地更新 GitTreeStatus（0 条 git）
 │◄── Fingerprint   │
 │ 状态栏「已保存」  │
```

### D3.4 补全（0 远端往返）
```
渲染(Monaco)        主进程                 本地 clangd
 │ completion(uri,l,c)
 ├────────────────►│ textDocument/completion
 │                  ├─────────────────────►│
 │                  │◄─────────────────────┤ CompletionItem[]
 │◄── items ────────┤
```

### D3.5 全局搜索
```
渲染               主进程
 │ search.find(p,{…})
 ├───────────────►│ exec(grep …)  ← 1 条远端命令
 │◄── SearchMatch[]│
```

### D3.6 提交和推送 / 同步
```
渲染                主进程
 │ git.commit(msg,{push:true})
 ├────────────────►│ git add -A && git commit   ← 2 条
 │                  │ git push（无上游 → push -u origin <branch>）
 │◄── output        │ 之后：更新 TreeStatus（本地）+ 状态栏
```
