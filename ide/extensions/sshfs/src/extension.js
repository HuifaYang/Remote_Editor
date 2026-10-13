// 扩展入口：把「我们自己的 SSH 层」整体接成 VSCode 的远端能力。
//
// 一个 provider 服务所有 authority，所以四处注册都是全局的，具体连接按 URI 的 authority 查会话表。
"use strict";

const vscode = require("vscode");
const { createSshfsProvider, SCHEME } = require("./fs-provider.js");
const { SessionManager, specFromEnv, authorityOf } = require("./session.js");
const { createTerminalProfileProvider, SshPseudoterminal, REMOTE_PROFILE_NAME } = require("./terminal.js");
const { createSearchProviders } = require("./search.js");
const { createScmService, GIT_SCHEME } = require("./scm.js");
const { createLanguageServices } = require("./lsp.js");
const { createTaskProvider, TASK_TYPE: REMOTE_TASK_TYPE } = require("./tasks.js");
const { createRemoteExplorer, parseTarget, readSshHosts } = require("./remote-explorer.js");
const { ShadowCacheManager } = require("./cache.js");

// 开发/靶机启动参数只自动连接一次；用户断开后，扩展宿主重启也不得用旧环境变量偷偷重连。
const ENV_AUTOCONNECT_SUPPRESSED = "rce.envAutoConnect.suppressed";

let channel;
let lspItem;
let sessions;
let scm;
let lsp;
let lspDeps;
let remoteExplorer;
let shadowCache;
let extensionContext;
let envAutoConnected = false;
const lspTooLargeWarned = new Set();

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  if (channel) channel.appendLine(line);
}

/** 语言服务设置（§5.5）：默认在工作机跑；cppPath/pythonPath 留空就用内置 clangd / PATH 里的 */
function lspConfig() {
  const cfg = vscode.workspace.getConfiguration("rce");
  const pick = (key) => cfg.get(`lsp.${key}`);
  return {
    enabled: pick("enabled") !== false,
    transport: pick("transport") || "local",
    // 开发/自检：RCE_SPIKE_LSP_CPP 直接指到一个语言服务可执行文件（端到端里用的是假 clangd）
    cppPath: process.env.RCE_SPIKE_LSP_CPP || pick("cppPath") || "",
    pythonPath: process.env.RCE_SPIKE_LSP_PYTHON || pick("pythonPath") || "",
    maxFiles: Number(pick("maxFiles")) || 20000,
  };
}

/** 本机影子缓存设置：总容量、单项目容量、TTL 和断开时清理。 */
function cacheConfig() {
  const cfg = vscode.workspace.getConfiguration("rce");
  return {
    maxSizeMB: Number(cfg.get("cache.maxSizeMB")) || 10240,
    maxProjectMB: Number(cfg.get("cache.maxProjectMB")) || 5120,
    ttlDays: Number(cfg.get("cache.ttlDays")) || 30,
    cleanupOnDisconnect: cfg.get("cache.cleanupOnDisconnect") === true,
  };
}

/** 按 URI（或 authority 字符串）取会话 */
function sessionOf(x) {
  if (!x) return undefined;
  const authority = typeof x === "string" ? x : x.authority;
  return sessions.get(authority);
}

// ---------------------------------------------------------------------------
// 连接管理
// ---------------------------------------------------------------------------

function connectionFromAuthority(authority) {
  const value = String(authority || "");
  const at = value.lastIndexOf("@");
  const colon = value.lastIndexOf(":");
  if (at <= 0 || colon <= at) return undefined;
  return {
    username: value.slice(0, at),
    host: value.slice(at + 1, colon),
    port: Number(value.slice(colon + 1)) || 22,
  };
}

async function ensureSessionWithPrompt(initial) {
  const parsed = initial?.hostName || initial?.host ? undefined : parseTarget(
    await vscode.window.showInputBox({
      title: "连接到远程主机",
      prompt: "输入 user@host 或 user@host:port（留空用户名使用本机用户名）",
      placeHolder: "user@host",
      ignoreFocusOut: true,
    }),
  );
  const host = initial?.hostName || initial?.host || parsed?.host;
  if (!host) return undefined;
  const username = initial?.username || parsed?.username || process.env.USER || "root";
  const port = Number(initial?.port || parsed?.port || 22) || 22;
  let spec = {
    host,
    port,
    username,
    privateKeyPath: initial?.identityFile || initial?.privateKeyPath || undefined,
    timeoutMs: 12000,
    keepaliveMs: 15000,
    strictHostKey: false,
    knownHostsPath: undefined,
    sshDir: undefined,
  };

  if (String(initial?.preferredAuthentications || "").split(",").map((x) => x.trim()).includes("password")) {
    const password = await vscode.window.showInputBox({
      title: "SSH 密码",
      prompt: `连接到 ${username}@${host}:${port}（只保存在内存里，不落盘）`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return undefined;
    spec = { ...spec, password };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sessions.ensure(spec);
    } catch (err) {
      if (err?.code === "auth-passphrase-required") {
        const passphrase = await vscode.window.showInputBox({
          title: "私钥口令",
          prompt: `私钥需要口令：${spec.privateKeyPath || "默认私钥"}`,
          password: true,
          ignoreFocusOut: true,
        });
        if (!passphrase) throw err;
        spec = { ...spec, passphrase };
        continue;
      }
      if (err?.code === "auth") {
        const password = await vscode.window.showInputBox({
          title: "SSH 密码",
          prompt: `连接到 ${username}@${host}:${port}（只保存在内存里，不落盘）`,
          password: true,
          ignoreFocusOut: true,
        });
        if (!password) throw err;
        spec = { ...spec, password };
        continue;
      }
      throw err;
    }
  }
  throw new Error(`连接 ${host}:${port} 失败：认证重试次数过多`);
}

function parentRemotePath(remotePath) {
  const value = String(remotePath || "/").replace(/\/+$/, "");
  if (!value || value === "/") return "/";
  const index = value.lastIndexOf("/");
  return index <= 0 ? "/" : value.slice(0, index);
}

/** VS Code 原生 QuickPick：点目录逐级浏览，也可以直接输入绝对路径。 */
async function chooseRemoteFolder(session, initialPath) {
  let current = initialPath;
  if (!current) {
    current = await session.conn.exec('printf %s "$HOME"', { timeoutMs: 8000 })
      .then((r) => r.stdout.trim())
      .catch(() => "/");
  }
  if (!current || !current.startsWith("/")) current = "/";

  while (true) {
    let dirs = [];
    try {
      dirs = (await session.fs.listDir(current)).filter((entry) => entry.isDir);
    } catch (err) {
      vscode.window.showErrorMessage(`无法读取远端目录 ${current}：${err && err.message}`);
      current = parentRemotePath(current);
      continue;
    }

    const parent = parentRemotePath(current);
    const picks = [
      {
        label: "打开此文件夹",
        description: current,
        iconPath: new vscode.ThemeIcon("folder-opened"),
        action: "open",
      },
      {
        label: "输入路径…",
        description: "输入远端绝对路径",
        iconPath: new vscode.ThemeIcon("edit"),
        action: "input",
      },
      ...(current !== "/" ? [{
        label: "上一级",
        description: parent,
        iconPath: new vscode.ThemeIcon("arrow-up"),
        action: "up",
      }] : []),
      ...dirs.map((entry) => ({
        label: entry.name,
        description: entry.path,
        iconPath: new vscode.ThemeIcon("folder"),
        action: "folder",
        path: entry.path,
      })),
    ];
    const picked = await vscode.window.showQuickPick(picks, {
      title: "选择远程文件夹",
      placeHolder: current,
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.action === "open") return current;
    if (picked.action === "up") {
      current = parent;
      continue;
    }
    if (picked.action === "input") {
      const value = await vscode.window.showInputBox({
        title: "选择远程文件夹",
        prompt: "输入要打开的远端绝对路径",
        value: current,
        ignoreFocusOut: true,
      });
      if (!value) continue;
      current = value.trim();
      if (!current.startsWith("/")) current = `/${current}`;
      continue;
    }
    if (picked.action === "folder" && picked.path) current = picked.path;
  }
}

async function openRemoteFolder(session, host, remotePath, forceNewWindow) {
  session.spec.workspace = remotePath;
  const uri = vscode.Uri.from({ scheme: SCHEME, authority: session.authority, path: remotePath });
  await remoteExplorer?.recordFolder({
    host: host.label || host.hostName || host.host,
    authority: session.authority,
    folder: remotePath,
    name: remotePath,
  });
  // 不用 updateWorkspaceFolders：那会把远程目录塞进“无标题多根工作区”，
  // CodeOSS 随后会弹“是否保存工作区配置”。统一用 openFolder 打开正式单目录工作区。
  // 当前窗口切换时先释放内存会话，新扩展宿主按 sshfs://authority 自动重连。
  await sessions.closeAll().catch((err) => log(`打开工作区前关闭旧会话失败：${err && err.message}`));
  await vscode.commands.executeCommand("vscode.openFolder", uri, {
    forceNewWindow: !!forceNewWindow,
    forceReuseWindow: !forceNewWindow,
  });
}

async function pickAndConnect(initial, forceNewWindow = false) {
  const session = await ensureSessionWithPrompt(initial);
  if (!session) return undefined;
  const remotePath = await chooseRemoteFolder(session, initial?.workspace);
  if (!remotePath) return session;
  await openRemoteFolder(session, initial || { host: session.spec.host, label: session.spec.host }, remotePath, forceNewWindow);
  return session;
}

function updateStatus() {
  const list = [...(sessions?.byAuthority?.values?.() || [])];
  // 不自己再画一个「SSH: ...」状态项：CodeOSS 原生远程指示器已经在左下角，
  // 我们只更新 context key，让它的菜单显示「连接 / 断开 / 新建远程终端」。
  vscode.commands.executeCommand("setContext", "rce.connected", list.length > 0);
  remoteExplorer?.refresh();
}

// ---------------------------------------------------------------------------
// 自检（Q1 的回归脚本用：只走 VSCode 公开 API，跑完写报告退出）
// ---------------------------------------------------------------------------

async function selfTest() {
  const spec = specFromEnv();
  const session = sessions.get(authorityOf(spec));
  const steps = [];
  const record = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      steps.push({ name, ok: false, detail: `${err && err.name}: ${err && err.message}` });
    }
  };
  const decode = (bytes) => Buffer.from(bytes).toString("utf8");
  const base = vscode.Uri.from({ scheme: SCHEME, authority: session.authority, path: spec.workspace });
  const fsApi = vscode.workspace.fs;

  await record("readDirectory(base)", async () => {
    const entries = await fsApi.readDirectory(base);
    return entries.map(([n, t]) => `${n}:${t}`).sort().join(",");
  });
  await record("stat(README.md)", async () => {
    const st = await fsApi.stat(vscode.Uri.joinPath(base, "README.md"));
    return `type=${st.type} size=${st.size} mtime=${st.mtime}`;
  });
  await record("readFile(README.md)", async () => {
    const text = decode(await fsApi.readFile(vscode.Uri.joinPath(base, "README.md")));
    if (!text.includes("hello")) throw new Error(`内容不符：${JSON.stringify(text.slice(0, 40))}`);
    return `${text.length} 字符`;
  });
  await record("stat(不存在的文件) → FileNotFound", async () => {
    try {
      await fsApi.stat(vscode.Uri.joinPath(base, "definitely-not-here.txt"));
    } catch (err) {
      if (err && err.code === "FileNotFound") return "错误码正确";
      throw new Error(`错误码不对：${err && err.code} / ${err && err.message}`);
    }
    throw new Error("竟然没报错");
  });
  await record("writeFile(写回 utf8)", async () => {
    const body = "自检写回：中文 + 换行\n";
    await fsApi.writeFile(vscode.Uri.joinPath(base, "written.txt"), Buffer.from(body, "utf8"));
    const back = decode(await fsApi.readFile(vscode.Uri.joinPath(base, "written.txt")));
    if (back !== body) throw new Error("读回不一致");
    return "读写一致";
  });
  await record("createDirectory(newdir)", async () => {
    await fsApi.createDirectory(vscode.Uri.joinPath(base, "newdir"));
    const names = (await fsApi.readDirectory(base)).map(([n]) => n);
    if (!names.includes("newdir")) throw new Error("目录没建出来");
    return "已建";
  });
  await record("rename(newdir → renamed)", async () => {
    await fsApi.rename(vscode.Uri.joinPath(base, "newdir"), vscode.Uri.joinPath(base, "renamed"), { overwrite: false });
    const names = (await fsApi.readDirectory(base)).map(([n]) => n);
    if (!names.includes("renamed") || names.includes("newdir")) throw new Error("重命名结果不对");
    return "已改名";
  });
  await record("delete(written.txt)", async () => {
    await fsApi.delete(vscode.Uri.joinPath(base, "written.txt"));
    const names = (await fsApi.readDirectory(base)).map(([n]) => n);
    if (names.includes("written.txt")) throw new Error("没删掉");
    return "已删除";
  });

  const failed = steps.filter((s) => !s.ok);
  const report = { phase: "selftest", ok: failed.length === 0, steps };
  const file = process.env.RCE_SPIKE_REPORT;
  if (file) {
    require("node:fs").writeFileSync(file, JSON.stringify(report, null, 2));
  }
  log(`自检 ${steps.length - failed.length}/${steps.length} 通过`);
  await vscode.commands.executeCommand("workbench.action.quit");
}

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

/** 开发用端到端自检（RCE_SPIKE_E2E=1）：把 IDE 真的开起来、开文件、开终端、查 SCM，
 *  写一份 JSON 报告，并把窗口留着给截图用。 */
async function runE2E() {
  const findFolder = () => (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === SCHEME);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // --folder-uri 与 provider 注册之间有竞态：工作区可能晚一点才出现在扩展宿主里
  let folder = findFolder();
  for (let i = 0; !folder && i < 40; i++) {
    await sleep(500);
    folder = findFolder();
  }
  if (!folder) {
    const spec = specFromEnv();
    const s = sessions.get(authorityOf(spec));
    const uri = vscode.Uri.from({ scheme: SCHEME, authority: s.authority, path: spec.workspace });
    vscode.workspace.updateWorkspaceFolders(0, 0, { uri, name: `e2e${spec.workspace}` });
    for (let i = 0; !folder && i < 20; i++) {
      await sleep(500);
      folder = findFolder();
    }
  }
  if (!folder) throw new Error("没有 sshfs 工作区");
  const session = sessionOf(folder.uri);
  const steps = [];
  const record = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      steps.push({ name, ok: false, detail: `${err && err.name}: ${err && err.message}` });
    }
  };
  const readText = async (name) => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name))).toString("utf8");
  const waitFor = async (fn, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await fn();
        if (value) return value;
      } catch (err) {
        lastError = err;
      }
      await sleep(250);
    }
    throw new Error(`${label}超时${lastError ? `（最后错误：${lastError.message}）` : ""}`);
  };
  const runTask = async (name, timeoutMs = 40000) => {
    const tasks = await vscode.tasks.fetchTasks({ type: REMOTE_TASK_TYPE });
    const task = tasks.find((candidate) => candidate.name === name);
    if (!task) throw new Error(`没找到 ${name} 任务（拿到：${tasks.map((candidate) => candidate.name).join(",") || "空"}）`);
    let subscription;
    let timer;
    const finished = new Promise((resolve) => {
      subscription = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task.name !== name) return;
        clearTimeout(timer);
        resolve(event.exitCode);
      });
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    await vscode.tasks.executeTask(task);
    const code = await finished;
    clearTimeout(timer);
    try { subscription.dispose(); } catch { /* 已释放 */ }
    if (code === undefined) throw new Error(`${name} 在 ${timeoutMs}ms 内没结束`);
    return code;
  };

  await record("打开 README.md", async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "README.md"));
    await vscode.window.showTextDocument(doc, { preview: false });
    return `${doc.lineCount} 行，语言=${doc.languageId}`;
  });

  await record("远端集成终端（SSH PTY）", async () => {
    const term = vscode.window.createTerminal({
      name: REMOTE_PROFILE_NAME,
      pty: new SshPseudoterminal(vscode, session, log, REMOTE_PROFILE_NAME),
      isTransient: true,
    });
    term.show();
    term.sendText("ls -la; echo ---; git -C src rev-parse --is-inside-work-tree; git status --short");
    return "已发送 ls/git 命令";
  });

  await record("终端默认 profile 设置", async () => {
    const cfg = vscode.workspace.getConfiguration("terminal.integrated");
    // 这一步只是验证 defaultProfile 有没有指到我们，别让它把整个自检挂住（profile 解析可能一直不返回）
    const timeout = new Promise((resolve) => setTimeout(() => resolve("(超时)"), 8000));
    await Promise.race([vscode.commands.executeCommand("workbench.action.terminal.new"), timeout]);
    await sleep(2500);
    const names = vscode.window.terminals.map((t) => t.name);
    return `defaultProfile.linux=${cfg.get("defaultProfile.linux")}；当前终端=[${names.join(", ")}]`;
  });

  await record("远端全文搜索（grep）", async () => {
    const matches = await session.search.search(folder.uri.path, "hello", { caseSensitive: false, regex: false });
    return matches.map((m) => `${m.path}:${m.line}`).join(", ") || "无结果";
  });

  await record("远端文件搜索（findFiles 走我们的 fileSearchProvider）", async () => {
    const found = await vscode.workspace.findFiles("**/main.c", null, 20);
    return found.map((u) => u.path).join(", ") || "无结果";
  });

  await record("远端 .vscode/settings.json 是否生效（Remote-SSH 对等的关键一条）", async () => {
    const cfg = vscode.workspace.getConfiguration("editor", folder.uri);
    const tabSize = cfg.get("tabSize");
    if (tabSize !== 7) throw new Error(`远端设置的 editor.tabSize 没生效（拿到 ${tabSize}，期望 7）`);
    return `editor.tabSize=${tabSize}（来自远端 .vscode/settings.json）`;
  });

  await record("SCM 状态（远端 git）", async () => {
    await scm.attach(folder.uri);
    await scm.refreshAll();
    const entry = [...scm.entries.values()][0];
    if (!entry) throw new Error("SCM 没挂上（不是 git 仓库？）");
    return `${entry.staged.resourceStates.length} 暂存 / ${entry.changes.resourceStates.length} 更改`;
  });

  await record("搜索视图命令（Ctrl+Shift+F 走我们的 provider）", async () => {
    await vscode.commands.executeCommand("workbench.action.findInFiles", { query: "hello", triggerSearch: true });
    return "已触发";
  });

  await record("显示 SCM 视图", async () => {
    await vscode.commands.executeCommand("workbench.view.scm");
    return "已切到源代码管理";
  });

  await record("语言服务：镜像同步 + compile_commands 重写（§13 坑 2）", async () => {
    const service = await lsp.syncMirror(folder.uri);
    const fsMod = require("node:fs");
    const pathMod = require("node:path");
    const cc = pathMod.join(service.mirrorRoot, "compile_commands.json");
    let detail = "（镜像里没有 compile_commands.json，走的是 compile_flags.txt 兜底）";
    if (fsMod.existsSync(cc)) {
      const text = fsMod.readFileSync(cc, "utf8");
      const entries = JSON.parse(text);
      const first = Array.isArray(entries) ? entries[0] : undefined;
      if (!first) throw new Error("compile_commands.json 是空数组");
      if (!String(first.directory).startsWith(service.mirrorRoot)) {
        throw new Error(`远端绝对路径没重写成镜像前缀：${first.directory}`);
      }
      if (text.includes('"/ws/') || text.includes('"/ws"')) throw new Error("还残留远端绝对路径");
      detail = `entries=${entries.length}，directory=${first.directory}`;
    }
    return `${service.mirror.manifest().size} 个文件；${detail}`;
  });

  await record("语言服务：跳转/悬浮/符号/补全（镜像 + 假 clangd）", async () => {
    const uri = vscode.Uri.joinPath(folder.uri, "src/main.c");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    const service = lsp.serviceOfDocument(doc);
    if (!service) throw new Error("没有语言服务通道（会话/工作区没匹配上）");
    const pos = new vscode.Position(1, 4);

    // 先直连语言服务：把「LSP 往返」和「VSCode provider 解析」两件事分开验，坏了才定位得出来
    let direct = [];
    for (let i = 0; i < 60; i++) {
      try {
        const ctx = await service.contextFor(doc);
        direct = ctx ? await ctx.client.definition(ctx.mirrorPath, 1, 4) : [];
      } catch (err) {
        log(`直连语言服务失败：${err && err.message}`);
      }
      if (direct.length > 0) break;
      await sleep(500);
    }
    if (direct.length === 0) throw new Error("30s 内直连语言服务也拿不到定义（镜像/进程/JSON-RPC 有问题）");

    // 每步都加超时：卡住时必须能说出「卡在哪一条 executeCommand」，不能等窗口被杀才报 Canceled
    const within = (p, ms, label) => Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`超时 ${ms}ms：${label}`)), ms)),
    ]);

    let defs = [];
    for (let i = 0; i < 20; i++) {
      defs = (await within(
        Promise.resolve(vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, pos)),
        15000, "vscode.executeDefinitionProvider",
      )) || [];
      if (defs.length > 0) break;
      await sleep(500);
    }
    if (defs.length === 0) {
      throw new Error(`直连能拿到定义（${direct[0].uri}），但 vscode.executeDefinitionProvider 返回空 —— provider 注册/语言匹配有问题`);
    }
    const target = defs[0].uri;
    if (target.scheme !== SCHEME) throw new Error(`定义结果没翻回 sshfs://：${target.toString()}`);
    log(`E2E：定义 ${target.authority}${target.path}`);
    const hovers = (await within(
      Promise.resolve(vscode.commands.executeCommand("vscode.executeHoverProvider", uri, pos)),
      15000, "vscode.executeHoverProvider",
    )) || [];
    log(`E2E：悬浮 ${hovers.length} 条`);
    const symbols = (await within(
      Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)),
      15000, "vscode.executeDocumentSymbolProvider",
    )) || [];
    log(`E2E：符号 ${symbols.length} 个`);
    const completions = await within(
      Promise.resolve(vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, pos)),
      15000, "vscode.executeCompletionItemProvider",
    );
    const itemCount = completions && completions.items ? completions.items.length : 0;
    return `定义→${target.authority}${target.path}；悬浮 ${hovers.length} 条；符号 ${symbols.length} 个；补全 ${itemCount} 项`;
  });

  await record("任务：远端 tasks.json 的任务真的在板子上跑（cwd 也在远端）", async () => {
    const code = await runTask("rce-probe");
    if (code !== 0) throw new Error(`任务结束码 ${code}`);
    const ran = await readText("task-ran.txt");
    const pwd = (await readText("task-pwd.txt")).trim();
    if (!ran.includes("远端任务已跑")) throw new Error(`远端没写对 task-ran.txt：${JSON.stringify(ran)}`);
    // 靶机把远端 /ws 映射到宿主目录，pwd 因此是宿主路径；只要求它确实落在工作区（结尾是 /ws）
    if (!/(^|\/)ws$/.test(pwd)) throw new Error(`任务的 cwd 不在远端工作区：${pwd}`);
    const linesAfterFirst = ran.trim().split("\n").length;

    // 另一条路：任务系统自己按「类型 + label」解析（菜单/命令走的就是 `_runTaskCommand` → `resolveTask`）。
    // 需要 package.json 里 contributes.taskDefinitions 注册 `rce-remote`：类型没注册时上游只能用**整个 definition**
    // 生成 identifier，跟过滤条件对不上（症状：命令静默退化成打开任务列表）。
    let sub;
    let timer;
    const secondEnded = new Promise((resolve) => {
      sub = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task.name !== "rce-probe") return;
        clearTimeout(timer);
        resolve(event.exitCode);
      });
      timer = setTimeout(() => resolve(undefined), 45000);
    });
    await vscode.commands.executeCommand("workbench.action.tasks.runTask", { type: REMOTE_TASK_TYPE, label: "rce-probe" });
    const secondCode = await secondEnded;
    clearTimeout(timer);
    try { sub.dispose(); } catch { /* 已释放 */ }
    if (secondCode === undefined) throw new Error("按 label 触发（resolveTask 那条路）45s 内没结束");
    if (secondCode !== 0) throw new Error(`按 label 触发的任务结束码 ${secondCode}`);
    const linesAfterSecond = (await readText("task-ran.txt")).trim().split(/\r?\n/).length;
    if (linesAfterSecond <= linesAfterFirst) throw new Error(`按 label 触发后文件没更新：${linesAfterFirst} → ${linesAfterSecond}`);
    return `结束码 0；远端 pwd=${pwd}；任务跑了 2 次（fetchTasks+executeTask 与 runTask 按 label 各一次）`;
  });

  await record("任务：dependsOn 先跑依赖，再跑主任务", async () => {
    const code = await runTask("rce-dependent");
    if (code !== 0) throw new Error(`任务结束码 ${code}`);
    const lines = (await readText("task-dependency.txt")).trim().split(/\r?\n/);
    if (lines.length !== 2 || lines[0] !== "prep" || lines[1] !== "dependent") {
      throw new Error(`依赖执行顺序不对：${JSON.stringify(lines)}`);
    }
    return `顺序=${lines.join(" → ")}`;
  });

  await record("任务：dependsOn 循环在执行前被拒绝", async () => {
    const code = await runTask("rce-cycle-a", 30000);
    if (code === 0) throw new Error("循环依赖任务竟然执行成功");
    const names = await vscode.workspace.fs.readDirectory(folder.uri);
    const ran = names.some(([name]) => name === "task-cycle-a-ran.txt" || name === "task-cycle-b-ran.txt");
    if (ran) throw new Error("循环依赖在报错前已经产生了远端副作用");
    return `结束码 ${code}，依赖图校验先于远端执行`;
  });

  await record("任务：problemMatcher → sshfs:// Problems 诊断", async () => {
    const code = await runTask("rce-problem");
    if (code !== 0) throw new Error(`任务结束码 ${code}`);
    const uri = vscode.Uri.joinPath(folder.uri, "src/main.c");
    const diagnostics = await waitFor(() => {
      const found = vscode.languages.getDiagnostics(uri).filter((item) => String(item.message).includes("RCE matcher probe"));
      return found.length > 0 ? found : undefined;
    }, 5000, "任务诊断");
    return `${diagnostics.length} 条，source=${diagnostics[0].source}`;
  });

  await record("任务：isBackground 长期任务可启动、可停止", async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: REMOTE_TASK_TYPE });
    const task = tasks.find((candidate) => candidate.name === "rce-background");
    if (!task) throw new Error("没找到 rce-background 任务");
    let subscription;
    let timer;
    const finished = new Promise((resolve) => {
      subscription = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task.name !== "rce-background") return;
        clearTimeout(timer);
        resolve(event.exitCode);
      });
      timer = setTimeout(() => resolve(undefined), 30000);
    });
    await vscode.tasks.executeTask(task);
    await waitFor(async () => (await readText("task-background.txt")).includes("started"), 20000, "后台任务启动");
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, "task-background-stop"), Buffer.from("stop\n"));
    const code = await finished;
    clearTimeout(timer);
    try { subscription.dispose(); } catch { /* 已释放 */ }
    if (code === undefined) throw new Error("后台任务停止后 15s 内没结束");
    if (code !== 0) throw new Error(`后台任务结束码 ${code}`);
    const output = await readText("task-background.txt");
    if (!output.includes("started") || !output.includes("stopped")) throw new Error(`后台输出不完整：${JSON.stringify(output)}`);
    return "启动后保持运行，写停止标记后正常退出（code 0）";
  });

  await record("语言服务：诊断（didOpen → publishDiagnostics → DiagnosticCollection）", async () => {
    const uri = vscode.Uri.joinPath(folder.uri, "src/main.c");
    let diags = [];
    for (let i = 0; i < 40; i++) {
      diags = lsp.diagnosticsFor(uri);
      if (diags.length > 0) break;
      await sleep(500);
    }
    if (diags.length === 0) throw new Error("没收到诊断");
    return `${diags.length} 条，首条「${diags[0].message}」（severity=${diags[0].severity}，source=${diags[0].source}）`;
  });

  const report = { phase: "e2e", ok: steps.every((s) => s.ok), steps };
  const file = process.env.RCE_SPIKE_REPORT;
  if (file) require("node:fs").writeFileSync(file, JSON.stringify(report, null, 2));
  log(`端到端 ${steps.filter((s) => s.ok).length}/${steps.length} 通过`);
  // 调试用：跑完不退出，把窗口留着（`RCE_SPIKE_HOLD=1`，配合扩展宿主的 --inspect 端口现场排查）
  if (process.env.RCE_SPIKE_HOLD) await sleep(Number(process.env.RCE_SPIKE_HOLD) * 1000 || 900000);
}

async function activate(context) {
  extensionContext = context;
  channel = vscode.window.createOutputChannel("RemoteCodeEditor");
  sessions = new SessionManager(log);
  remoteExplorer = createRemoteExplorer(vscode, {
    context,
    getSessions: () => sessions,
    connect: (host, forceNewWindow) => pickAndConnect(host, forceNewWindow),
  });
  context.subscriptions.push(remoteExplorer);

  // 现场排查用：调试模式下把内部句柄挂到 globalThis，配合扩展宿主的 --inspect 端口
  // （扩展宿主跑在 NodeService 里，调试器里 `require('vscode')` 拿不到 API 对象）
  if (process.env.RCE_SPIKE_E2E === "1" || process.env.RCE_SPIKE_HOLD) {
    globalThis.__rce = {
      vscode,
      log,
      get sessions() { return sessions; },
      get lsp() { return lsp; },
      get scm() { return scm; },
      get folder() { return (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === SCHEME); },
    };
  }

  context.subscriptions.push(
    channel,
    { dispose: () => sessions.closeAll() },
  );

  // 1) 远端文件系统 —— **先注册，再连**（顺序不能反，见 docs/ssh-vs-remotessh.md §5.4）
  //    工作台在窗口恢复阶段就会来问工作区里的 `.vscode` 等路径；如果那时 sshfs 还没有 provider，
  //    那批文件请求可能永远不落地（上游的 snippet 初始化就卡在这儿 → 补全一直 "Loading…"）。
  //    先注册，拿不到会话时同步抛 Unavailable，请求至少能落地，不会拖着别人。
  const whenSession = (uri, timeoutMs) => sessions.whenReady(uri.authority, timeoutMs);
  const provider = createSshfsProvider(vscode, {
    log,
    sessionOf,
    whenSession,
    pollMs: vscode.workspace.getConfiguration("rce").get("watch.pollMs") ?? 3000,
  });
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    { dispose: () => provider.dispose() },
  );

  // 2) 开发/自检：环境变量给了连接参数就连上（此时 provider 已在，工作台早期的请求已经能落地）。
  //    但用户一旦点过“断开远程连接”，同一份用户数据下就永久抑制旧环境变量的自动重连；
  //    否则移除远端工作区会重建扩展宿主，下一轮 activate 又看到 RCE_SPIKE_* 并偷偷连回去。
  const envSpec = context.globalState.get(ENV_AUTOCONNECT_SUPPRESSED, false) ? null : specFromEnv();
  const initialRemoteFolder = (vscode.workspace.workspaceFolders || []).find((item) => item.uri.scheme === SCHEME);
  let envSession;
  if (initialRemoteFolder && !sessions.get(initialRemoteFolder.uri.authority)) {
    // 新窗口拿到的是 sshfs://user@host:port/path，没有旧窗口内存里的密码。
    // 环境变量只在它和目标 authority 完全一致时使用；否则会错误连到旧靶机。
    const envMatches = envSpec && authorityOf(envSpec) === initialRemoteFolder.uri.authority;
    if (envMatches) {
      log(`按环境变量连接 ${envSpec.host}:${envSpec.port} → ${envSpec.workspace}`);
      envSession = await sessions.openOrThrow(envSpec);
      envAutoConnected = true;
    } else {
      const authority = connectionFromAuthority(initialRemoteFolder.uri.authority);
      const configured = authority && (await readSshHosts(vscode)).find((host) =>
        host.hostName === authority.host
        || host.label === authority.host
        || host.label === `${authority.username}@${authority.host}`
      );
      if (authority) {
        const session = await ensureSessionWithPrompt({
          host: authority.host,
          username: configured?.username || authority.username,
          port: configured?.port || authority.port,
          identityFile: configured?.identityFile,
          preferredAuthentications: configured?.preferredAuthentications,
        });
        if (session) session.spec.workspace = initialRemoteFolder.uri.path;
      }
    }
  } else if (envSpec) {
    log(`按环境变量连接 ${envSpec.host}:${envSpec.port} → ${envSpec.workspace}`);
    envSession = await sessions.openOrThrow(envSpec);
    envAutoConnected = true;
  }

  // 2.5) 任务：`.vscode/tasks.json` 改到远端跑（上游虚拟工作区会整批丢掉这些任务，见 tasks.js 头注释）
  const taskDiagnostics = vscode.languages.createDiagnosticCollection("rce-remote-tasks");
  context.subscriptions.push(
    taskDiagnostics,
    vscode.tasks.registerTaskProvider(REMOTE_TASK_TYPE, createTaskProvider(vscode, { log, whenSession, diagnostics: taskDiagnostics })),
  );

  // 3) 集成终端（远端 shell）
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("rceRemote", createTerminalProfileProvider(vscode, {
      log,
      currentSession: () => {
        const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
        return folder ? sessionOf(folder.uri) : undefined;
      },
      workspaceFolderForCwd: () => vscode.workspace.workspaceFolders?.[0],
    })),
  );

  // 4) 搜索（proposed API：清单里声明 + product.json 放行，缺一个就注册不上，删掉不影响其它功能）
  try {
    const { fileSearchProvider, textSearchProvider } = createSearchProviders(vscode, { log, sessionFor: sessionOf });
    if (typeof vscode.workspace.registerFileSearchProvider === "function") {
      context.subscriptions.push(vscode.workspace.registerFileSearchProvider(SCHEME, fileSearchProvider));
    }
    if (typeof vscode.workspace.registerTextSearchProvider === "function") {
      context.subscriptions.push(vscode.workspace.registerTextSearchProvider(SCHEME, textSearchProvider));
    }
    log("远端搜索已注册");
  } catch (err) {
    log(`远端搜索注册失败（proposed API 未放行？）：${err && err.message}`);
  }

  // 5) SCM：Git 面板 + diff 左侧内容
  scm = createScmService(vscode, { log, sessionOf });
  context.subscriptions.push(
    { dispose: () => scm.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      provideTextDocumentContent: (uri) => scm.provideOriginalContent(uri),
    }),
  );

  // 6) 语言服务：本地镜像 + 工作机上的 clangd/pylsp（路线文档 §2.9；嵌入式场景价值最高的一块）
  lspItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  lspItem.command = "rce.lsp.syncMirror";
  context.subscriptions.push(
    lspItem,
    { dispose: () => lsp.dispose() },
  );
  // 镜像 / 语言服务的工作目录：globalStorage（每个窗口一份，卸载扩展时一起清）
  const storageDir = context.globalStorageUri
    ? context.globalStorageUri.fsPath
    : require("node:path").join(require("node:os").tmpdir(), "rce-extension-host");
  require("node:fs").mkdirSync(storageDir, { recursive: true });
  shadowCache = new ShadowCacheManager({
    rootDir: storageDir,
    config: cacheConfig,
    log,
  });
  // 启动后台清理，不阻塞工作台。清理只淘汰非活跃项目，当前打开的项目会被保护。
  void shadowCache.cleanup()
    .then((result) => {
      if (result.removed.length) log(`影子缓存清理完成：${result.removed.length} 个项目，${result.freedBytes} 字节`);
    })
    .catch((err) => log(`影子缓存清理失败：${err && err.message}`));
  lspItem.text = "本机语言服务：待机";
  lspDeps = {
    log,
    session: (uri) => sessionOf(uri),
    config: lspConfig,
    cache: shadowCache,
    storageDir,
    onMirrorProgress: (service, progress) => {
      lspItem.text = `本机语言服务：${progress.current || "同步中…"}`;
      lspItem.tooltip = `${service.title}\n${progress.current || "同步中…"}（${progress.done}/${progress.total}）`;
      lspItem.show();
    },
    onMirrorReady: (service, result) => {
      lspItem.text = `本机语言服务：镜像就绪（${result.fileCount} 文件）`;
      lspItem.tooltip = `${service.title}\n镜像根：${service.mirrorRoot}\n点击重新同步`;
      lspItem.show();
    },
    onMirrorTooLarge: (service, err) => {
      lspItem.text = `本机语言服务：未同步（${err.mirrorFileCount} 文件）`;
      lspItem.tooltip = `${service.title}\n工作区文件数 ${err.mirrorFileCount}，超过自动镜像上限 ${err.mirrorMaxFiles}。\n建议打开具体项目子目录；点击本状态栏可强制同步。`;
      lspItem.show();
      if (!lspTooLargeWarned.has(service.title)) {
        lspTooLargeWarned.add(service.title);
        vscode.window.showWarningMessage(
          `已暂停自动镜像：${service.title} 包含 ${err.mirrorFileCount} 个文件，超过上限 ${err.mirrorMaxFiles}。请打开具体项目目录，或点击状态栏“本机语言服务”强制同步。`,
        );
      }
    },
    onMirrorError: (service, err) => {
      lspItem.text = "本机语言服务：同步失败";
      lspItem.tooltip = `${service.title}\n${err && err.message ? err.message : String(err)}\n点击重试`;
      lspItem.show();
    },
  };
  lsp = createLanguageServices(vscode, lspDeps);
  lspItem.show();

  const attachFolders = () => {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (folder.uri.scheme !== SCHEME) continue;
      const session = sessionOf(folder.uri);
      if (session?.spec?.host) {
        remoteExplorer?.recordFolder({
          host: session.spec.host,
          authority: folder.uri.authority,
          folder: folder.uri.path,
          name: folder.name,
        });
      }
      scm.attach(folder.uri).catch((err) => log(`SCM 挂载失败：${err && err.message}`));
      // 镜像预热（惰性语言服务真正启动是在第一次需要补全/跳转/诊断时）
      if (!lsp.attach(folder.uri)) log(`语言服务：${folder.uri.authority} 还没有会话，暂不预热镜像`);
    }
  };
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    updateStatus();
    attachFolders();
  }));

  // 命令
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register("rce.connect", async () => {
    try {
      await pickAndConnect();
      updateStatus();
      attachFolders();
    } catch (err) {
      vscode.window.showErrorMessage(`连接失败：${err && err.message}`);
    }
  });
  register("rce.disconnect", async () => {
    // 必须在移除远端工作区前落盘：工作区移除会导致扩展宿主重启，晚写就来不及了。
    await context.globalState.update(ENV_AUTOCONNECT_SUPPRESSED, true);
    // context key 先落下：远程指示器菜单应立即从「断开」切回「连接」。
    vscode.commands.executeCommand("setContext", "rce.connected", false);
    const closing = sessions.closeAll();
    updateStatus();
    // CodeOSS 的远程指示器是按工作区 scheme/authority 画的；不移除 sshfs 文件夹，
    // 即使 SSH 已经断了，左下角仍会显示 u@host。断开就必须把远端虚拟工作区也关掉。
    const folders = [...(vscode.workspace.workspaceFolders || [])];
    const hadRemoteFolder = folders.some((folder) => folder.uri.scheme === SCHEME);
    for (let i = folders.length - 1; i >= 0; i--) {
      if (folders[i].uri.scheme === SCHEME) {
        vscode.workspace.updateWorkspaceFolders(i, 1);
      }
    }
    try {
      lsp.dispose();
      lsp = createLanguageServices(vscode, lspDeps);
    } catch (err) {
      log(`重建语言服务失败（会话已断开）：${err && err.message}`);
    }
    lspItem.text = "本机语言服务：未连接";
    if (cacheConfig().cleanupOnDisconnect) {
      void shadowCache?.cleanup().catch((err) => log(`断开时清理影子缓存失败：${err && err.message}`));
    }
    await closing.catch((err) => log(`关闭 SSH 会话失败：${err && err.message}`));
    updateStatus();
    vscode.window.showInformationMessage("已断开所有远程连接");
    // 仅移除 folder 有时会让 CodeOSS 的 remote indicator 留在旧 authority；显式走原生关闭，
    // 保证左下角状态和 workspace 一起清掉。命令是 core 动作，不会递归到本命令。
    if (hadRemoteFolder) {
      try {
        await vscode.commands.executeCommand("workbench.action.remote.close");
      } catch (err) {
        log(`关闭远程指示器失败：${err && err.message}`);
      }
    }
  });
  register("rce.showLog", () => channel.show());
  register("rce.lsp.syncMirror", async () => {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
    if (!folder) {
      vscode.window.showWarningMessage("当前窗口没有已连接的远端目录");
      return;
    }
    lspItem.text = "本机语言服务：镜像同步中…";
    lspItem.show();
    try {
      const service = await lsp.syncMirror(folder.uri);
      const info = service.mirror.manifest().size;
      vscode.window.showInformationMessage(`远端镜像已同步：${info} 个文件`);
    } catch (err) {
      lspItem.text = "本机语言服务：镜像同步失败";
      vscode.window.showErrorMessage(`镜像同步失败：${err && err.message}`);
    }
  });
  register("rce.cache.cleanup", async () => {
    if (!shadowCache) return;
    const before = await shadowCache.stats();
    const result = await shadowCache.cleanup();
    const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    vscode.window.showInformationMessage(
      `本机影子缓存：${before.count} 个项目 / ${mb(before.totalBytes)}；本次清理 ${result.removed.length} 个，释放 ${mb(result.freedBytes)}`,
    );
  });
  register("rce.lsp.restart", async () => {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
    if (!folder) {
      vscode.window.showWarningMessage("当前窗口没有已连接的远端目录");
      return;
    }
    try {
      await lsp.restart(folder.uri);
      vscode.window.showInformationMessage("语言服务已重启（下一次补全/跳转会按需拉起）");
    } catch (err) {
      vscode.window.showErrorMessage(`重启语言服务失败：${err && err.message}`);
    }
  });
  register("rce.newRemoteTerminal", () => {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
    if (!folder || !sessionOf(folder.uri)) {
      vscode.window.showWarningMessage("当前窗口没有已连接的远端目录");
      return;
    }
    return vscode.commands.executeCommand("workbench.action.terminal.newWithProfile", { profileName: REMOTE_PROFILE_NAME });
  });
  register("rce.scm.refresh", () => scm.refreshAll());
  register("rce.scm.stage", (arg) => scm.runOnResources(arg, (entry, paths) => entry.git.stage(entry.root, paths))
    .catch((err) => vscode.window.showErrorMessage(`暂存失败：${err && err.message}`)));
  register("rce.scm.unstage", (arg) => scm.runOnResources(arg, (entry, paths) => entry.git.unstage(entry.root, paths))
    .catch((err) => vscode.window.showErrorMessage(`取消暂存失败：${err && err.message}`)));
  register("rce.scm.discard", async (arg) => {
    const paths = scm.resolvePaths(arg);
    if (paths.length === 0) return;
    const pick = await vscode.window.showWarningMessage(
      `放弃 ${paths.length} 个文件的更改？内容无法恢复。`, { modal: true }, "放弃更改",
    );
    if (pick !== "放弃更改") return;
    await scm.runOnResources(arg, async (entry, rels) => {
      // 已跟踪的走 git restore，未跟踪的只能删掉（git clean -fd）
      const snapshot = await entry.git.treeStatus(entry.uri.path);
      const untracked = new Set(
        Object.values(snapshot.files)
          .filter((f) => f.letter === "U" || f.indexStatus === "?")
          .map((f) => f.path),
      );
      const tracked = rels.filter((r) => !untracked.has(r));
      const added = rels.filter((r) => untracked.has(r));
      if (tracked.length) await entry.git.discard(entry.root, tracked);
      if (added.length) await entry.git.clean(entry.root, added);
    }).catch((err) => vscode.window.showErrorMessage(`放弃更改失败：${err && err.message}`));
  });
  register("rce.scm.commit", async (arg) => {
    // acceptInputCommand 会把输入框内容作为第一个参数传进来；手动调用时取第一个 SourceControl 的输入框
    let message = typeof arg === "string" ? arg : undefined;
    const first = scm.entries.values().next().value;
    if (!first) return;
    if (!message) message = first.sc.inputBox.value;
    if (!message || !message.trim()) {
      vscode.window.showWarningMessage("提交信息不能为空");
      return;
    }
    try {
      await first.git.commitStaged(first.root, message);
      first.sc.inputBox.value = "";
      await scm.refreshAll();
    } catch (err) {
      vscode.window.showErrorMessage(`提交失败：${err && err.message}`);
    }
  });

  if (envSession) {
    updateStatus();
    attachFolders();
    if (process.env.RCE_SPIKE_SELFTEST) {
      await selfTest();
      return;
    }
    if (process.env.RCE_SPIKE_E2E === "1") {
      try {
        // 兜底：任何一步卡住也要把报告写出来，别让自检静默消失
        await Promise.race([
          runE2E(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("端到端整体超时（240s）")), 240000)),
        ]);
      } catch (err) {
        log(`端到端失败：${err && err.message}`);
        const file = process.env.RCE_SPIKE_REPORT;
        if (file) {
          require("node:fs").writeFileSync(file, JSON.stringify({ phase: "e2e", ok: false, error: String(err && err.message) }, null, 2));
        }
      }
    }
    if (process.env.RCE_SPIKE_OPEN === "1") {
      const uri = vscode.Uri.from({ scheme: SCHEME, authority: envSession.authority, path: envSpec.workspace });
      vscode.workspace.updateWorkspaceFolders(0, 0, { uri, name: `${envSession.authority}${envSpec.workspace}` });
    }
  }
  updateStatus();
}

async function deactivate() {
  // 用户也可能从 CodeOSS 自带的“关闭远程连接”退出，而不是走 rce.disconnect。
  // 只要这次宿主确实用过环境变量自动连接，且远端目录已经没了，就抑制下一次悄悄重连。
  try {
    const hasRemoteFolder = (vscode.workspace.workspaceFolders || []).some((folder) => folder.uri.scheme === SCHEME);
    if (envAutoConnected && !hasRemoteFolder) {
      await extensionContext?.globalState.update(ENV_AUTOCONNECT_SUPPRESSED, true);
    }
  } catch { /* 退出路径，尽力保存抑制标记 */ }
  try {
    lsp?.dispose();
  } catch { /* 退出路径，收不干净也无所谓 */ }
  if (cacheConfig().cleanupOnDisconnect) {
    try { await shadowCache?.cleanup(); } catch { /* 退出路径，尽力清理 */ }
  }
  await sessions?.closeAll();
}

module.exports = { activate, deactivate };
