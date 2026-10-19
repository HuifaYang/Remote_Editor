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
let attachFolders = () => {};   // activate 内赋值；自动重连成功后用它重新挂载 SCM/镜像预热
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

/** 原生 Remote Indicator 只认识 URI，不认识 SSH 是否真的连上；这里把真实会话状态同步给工作台。 */
function setRemoteConnectionState(state, detail = "") {
  void vscode.commands.executeCommand("setContext", "rce.remoteConnectionState", state);
  void vscode.commands.executeCommand("setContext", "rce.remoteConnectionMessage", detail);
}

/** 通用语言服务设置：默认按需在远端启动；任意标准 LSP 都通过 servers 表注册。 */
function lspConfig() {
  const cfg = vscode.workspace.getConfiguration("rce");
  const pick = (key) => cfg.get(`lsp.${key}`);
  return {
    enabled: pick("enabled") !== false,
    transport: pick("transport") || "mount",
    mode: pick("mode") || "browse",
    autoPromoteOnEdit: pick("autoPromoteOnEdit") !== false,
    warmRetentionMs: Number(pick("warmRetentionMinutes") ?? 5) * 60_000,
    servers: pick("servers") && typeof pick("servers") === "object" ? pick("servers") : {},
    sshfsPath: pick("sshfsPath") || "",
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

/** 会话意外断开后的自动重连：凭据从 ~/.ssh/config 的 identityFile 恢复（密码类无法恢复，提示手动）。
 *  指数退避重试；成功后重建语言服务通道并重新 attach SCM，让编辑器无缝继续工作。 */
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const reconnectingAuthorities = new Set();
async function autoReconnect(authority) {
  if (reconnectingAuthorities.has(authority)) return;
  reconnectingAuthorities.add(authority);
  try {
  const folder = (vscode.workspace.workspaceFolders || []).find((f) => f.uri.authority === authority);
  if (!folder) return;                 // 远端工作区已不在窗口里，无需重连
  const connection = connectionFromAuthority(authority);
  if (!connection) return;
  log(`检测到 ${authority} 连接中断，尝试自动重连…`);
  setRemoteConnectionState("reconnecting", `正在重连 ${authority}`);
  lspItem && (lspItem.text = "语言智能：连接中断，重连中…", lspItem.show());
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const configured = (await readSshHosts(vscode)).find((host) =>
        host.hostName === connection.host
        || host.label === connection.host
        || host.label === `${connection.username}@${connection.host}`
      );
      let identityFile = configured?.identityFile || "";
      if (identityFile.startsWith("~")) {
        identityFile = require("node:path").join(require("node:os").homedir(), identityFile.slice(1));
      }
      const session = await sessions.ensure({
        host: connection.host,
        port: connection.port,
        username: configured?.username || connection.username,
        privateKeyPath: identityFile || undefined,
        timeoutMs: 12000,
        keepaliveMs: 15000,
        strictHostKey: false,
      });
      log(`已自动重连 ${session.authority}`);
      // 重建依赖旧会话句柄的服务：LSP 通道里的 MirrorManager 持有死 conn，必须整体换新
      try {
        scm?.detachAll();
        lsp.dispose();
        lsp = createLanguageServices(vscode, lspDeps);
      } catch (err) {
        log(`重连后重建语言服务失败：${err && err.message}`);
      }
      attachFolders();
      setRemoteConnectionState("connected", `已连接 ${session.authority}`);
      lspItem && (lspItem.text = "语言智能：待机", lspItem.show());
      vscode.window.showInformationMessage(`已自动重连 ${session.authority}`);
      return;
    } catch (err) {
      lastErr = err;
      const delay = Math.min(30000, 2000 * 2 ** attempt);
      log(`自动重连第 ${attempt + 1} 次失败（${err && err.message}），${delay / 1000}s 后重试`);
      await sleepMs(delay);
    }
  }
  setRemoteConnectionState("failed", `自动重连 ${authority} 失败：${lastErr && lastErr.message}`);
  lspItem && (lspItem.text = "本机语言服务：连接已断开", lspItem.tooltip = `自动重连失败：${lastErr && lastErr.message}\n点击手动重连`, lspItem.show());
  vscode.window.showErrorMessage(`自动重连 ${authority} 失败：${lastErr && lastErr.message}`, "手动重连")
    .then((choice) => choice === "手动重连" && vscode.commands.executeCommand("rce.connect"));
  } finally {
    reconnectingAuthorities.delete(authority);
  }
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
    if (!entry.historyProvider) throw new Error("SCM 历史图 provider 没挂上（proposed API 被拦？）");
    const refs = await entry.historyProvider.provideHistoryItemRefs(undefined, undefined);
    if (!refs.some((ref) => ref.id === "refs/heads/main")) throw new Error("历史图没有 main 分支 ref");
    if (refs.some((ref) => !ref.icon)) throw new Error("历史图 ref 缺少 ThemeIcon，CodeOSS 会跳过 badge 渲染");
    const history = await entry.historyProvider.provideHistoryItems({ limit: 20, historyItemRefs: ["refs/heads/main"] }, undefined);
    if (history.length < 5) throw new Error(`历史图提交太少：${history.length}`);
    const allHistory = await entry.historyProvider.provideHistoryItems({
      limit: 100,
      historyItemRefs: refs.map((ref) => ref.revision).filter(Boolean),
    }, undefined);
    const missingRefs = refs.filter((ref) => !allHistory.some((item) =>
      item.id === ref.revision && (item.references || []).some((candidate) => candidate.id === ref.id)));
    if (missingRefs.length > 0) throw new Error(`历史图分支 badge 没挂上：${missingRefs.map((ref) => ref.name).join(", ")}`);
    const first = history.find((item) => item.parentIds.length > 0) || history[0];
    const changes = await entry.historyProvider.provideHistoryItemChanges(first.id, first.parentIds[0], undefined);
    if (changes.length === 0) throw new Error("历史提交没有文件变更");
    return `${entry.staged.resourceStates.length} 暂存 / ${entry.changes.resourceStates.length} 更改；`
      + `${refs.length} refs / ${history.length} 提交 / ${changes.length} 个变更文件 / badge 全部命中`;
  });

  await record("搜索视图命令（Ctrl+Shift+F 走我们的 provider）", async () => {
    await vscode.commands.executeCommand("workbench.action.findInFiles", { query: "hello", triggerSearch: true });
    return "已触发";
  });

  await record("显示 SCM 视图", async () => {
    await vscode.commands.executeCommand("workbench.view.scm");
    return "已切到源代码管理";
  });

  await record("语言服务：远程模式零镜像 + 通用 LSP 注册表", async () => {
    const before = lsp.stats();
    if (before.mode !== "browse" || before.projects.some((project) => project.live)) {
      throw new Error(`浏览模式不是冷启动：${JSON.stringify(before)}`);
    }
    await vscode.commands.executeCommand("rce.lsp.intelligentMode");
    const service = await lsp.syncMirror(folder.uri);
    if (!service) throw new Error("没有建立远端语言服务通道");
    const after = lsp.stats();
    if (after.transport !== "mount") throw new Error(`默认 transport 不是 mount：${after.transport}`);
    if (!after.servers.some((server) => server.id === "cpp") || !after.servers.some((server) => server.id === "python")) {
      throw new Error("默认通用 LSP 注册表缺少 cpp/python");
    }
    return `浏览模式冷启动；${after.servers.length} 个服务器定义；项目根=${service.remoteRoot}，语言服务本机运行，只读 SSHFS 不复制源码/sysroot`;
  });

  await record("语言服务：跳转/悬浮/符号/补全（本机 LSP + 只读 SSHFS）", async () => {
    const uri = vscode.Uri.joinPath(folder.uri, "src/main.c");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    const match = lsp.matchForDocument(doc);
    if (!match) throw new Error(`main.c 没匹配到语言服务器（languageId=${doc.languageId}）`);
    const service = lsp.serviceOfDocument(doc) || await lsp.syncMirror(folder.uri);
    if (!service) throw new Error("没有语言服务通道（会话/工作区没匹配上）");
    const pos = new vscode.Position(1, 4);

    // 先直连语言服务：把「LSP 往返」和「VSCode provider 解析」两件事分开验，坏了才定位得出来
    let direct = [];
    let directSymbols = [];
    for (let i = 0; i < 60; i++) {
      try {
        const ctx = await service.contextFor(doc, match);
        direct = ctx ? await ctx.client.definition(ctx.servicePath, 1, 4) : [];
        directSymbols = ctx ? await ctx.client.documentSymbol(ctx.servicePath) : [];
      } catch (err) {
        log(`直连语言服务失败：${err && err.message}`);
      }
      if (direct.length > 0 && directSymbols.length > 0) break;
      await sleep(500);
    }
    if (direct.length === 0) throw new Error("30s 内直连语言服务也拿不到定义（远端进程/JSON-RPC 有问题）");
    if (directSymbols.length === 0) throw new Error("30s 内直连语言服务拿不到文档符号");

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
    let symbols = [];
    for (let i = 0; i < 20 && symbols.length === 0; i++) {
      symbols = (await within(
        Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)),
        15000, "vscode.executeDocumentSymbolProvider",
      )) || [];
      if (symbols.length === 0) await sleep(250);
    }
    if (symbols.length === 0) throw new Error("文档符号 provider 返回空");
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
  channel = vscode.window.createOutputChannel("织码 WeaveCode");
  // SSH 意外断开（网络抖动 / 板子重启 / 休眠唤醒）时自动重连：
  // 远端工作区还挂在窗口里，不重连的话所有文件请求都会报「没有会话」且永远卡住。
  sessions = new SessionManager(log, {
    onConnecting: (authority) => setRemoteConnectionState("connecting", `正在连接 ${authority}`),
    onConnected: (authority) => {
      setRemoteConnectionState("connected", `已连接 ${authority}`);
      updateStatus();
    },
    onConnectionFailed: (authority, err) => {
      const state = reconnectingAuthorities.has(authority) ? "reconnecting" : "failed";
      setRemoteConnectionState(state, `${authority}：${err && err.message ? err.message : String(err)}`);
      updateStatus();
    },
    onUnexpectedClose: (authority) => {
      setRemoteConnectionState("reconnecting", `连接中断，正在重连 ${authority}`);
      updateStatus();
      void autoReconnect(authority);
    },
  });
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
  if (initialRemoteFolder) {
    if (sessions.get(initialRemoteFolder.uri.authority)) {
      setRemoteConnectionState("connected", `已连接 ${initialRemoteFolder.uri.authority}`);
    } else {
      setRemoteConnectionState("connecting", `正在恢复 ${initialRemoteFolder.uri.authority}`);
    }
  }
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
        // ~/.ssh/config 里 IdentityFile 常带 ~ 前缀，直接传给 ssh2 会读不到文件 → 认证失败。
        // 必须展开成绝对路径（这是窗口重载后「悄悄连不上」的头号原因）。
        let identityFile = configured?.identityFile || "";
        if (identityFile.startsWith("~")) {
          identityFile = require("node:path").join(require("node:os").homedir(), identityFile.slice(1));
        }
        try {
          const session = await ensureSessionWithPrompt({
            host: authority.host,
            username: configured?.username || authority.username,
            port: configured?.port || authority.port,
            identityFile,
            preferredAuthentications: configured?.preferredAuthentications,
          });
          if (session) session.spec.workspace = initialRemoteFolder.uri.path;
        } catch (err) {
          // 以前这里静默吞掉：窗口重载后远端工作区还在、会话没了、也不提示，用户只看到「一直加载」。
          log(`恢复远程连接失败 ${initialRemoteFolder.uri.authority}：${err && err.message}`);
          setRemoteConnectionState("failed", `恢复 ${initialRemoteFolder.uri.authority} 失败：${err && err.message}`);
          vscode.window.showErrorMessage(`恢复远程连接 ${initialRemoteFolder.uri.authority} 失败：${err && err.message}`, "重新连接")
            .then((choice) => choice === "重新连接" && vscode.commands.executeCommand("rce.connect"));
        }
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
    // 用**只读 FileSystemProvider** 而不是 TextDocumentContentProvider：Quick Diff 的
    // gutter / 概览标尺 / minimap 标记要靠它把「原始版本」当普通文件解析并同步给 diff worker。
    // 内置 git 扩展同样是给 git: 注册 FileSystemProvider（我们此前只注册文本内容提供器，
    // 结果资源管理器有着色、编辑器里却一个改动标记都没有）。
    vscode.workspace.registerFileSystemProvider(GIT_SCHEME, scm.createOriginalFileSystemProvider(), {
      isReadonly: true,
      isCaseSensitive: true,
    }),
  );

  // 6) 语言服务：标准 LSP 直连远端，浏览/代码智能双模式。远端无需部署常驻服务。
  lspItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  // 点击状态栏是「看进度 + 选操作」的入口，不是直接全量重同步（用户下意识一点就白拉一遍）
  lspItem.command = "rce.lsp.menu";
  context.subscriptions.push(
    lspItem,
    { dispose: () => lsp.dispose() },
  );
  // 本地缓存目录只放挂载点、编译视图和 local 兼容缓存；mount 模式不会复制源码或 sysroot。
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
  lspItem.text = lspConfig().mode === "intelligent" ? "语言智能：准备中…" : "浏览模式";
  lspDeps = {
    log,
    session: (uri) => sessionOf(uri),
    config: lspConfig,
    cache: shadowCache,
    storageDir,
    onLspState: (state) => {
      lspItem.text = state.message;
      lspItem.tooltip = state.detail || "";
      lspItem.command = "rce.lsp.menu";
      lspItem.show();
    },
    onMirrorProgress: (service, progress) => {
      lspItem.text = `语言服务（兼容镜像）：${progress.current || "同步中…"}`;
      lspItem.tooltip = `${service.title}\n${progress.current || "同步中…"}（${progress.done}/${progress.total}）`;
      lspItem.show();
    },
    onMirrorReady: (service, result) => {
      lspItem.text = `语言服务（兼容镜像）：就绪（${result.fileCount} 文件）`;
      lspItem.tooltip = `${service.title}\n镜像根：${service.mirrorRoot}\n点击重新同步`;
      lspItem.show();
    },
    onMirrorTooLarge: (service, err) => {
      lspItem.text = `语言服务（兼容镜像）：未同步（${err.mirrorFileCount} 文件）`;
      lspItem.tooltip = `${service.title}\n工作区文件数 ${err.mirrorFileCount}，超过自动镜像上限 ${err.mirrorMaxFiles}。\n建议打开具体项目子目录；点击本状态栏可强制同步。`;
      lspItem.show();
      if (!lspTooLargeWarned.has(service.title)) {
        lspTooLargeWarned.add(service.title);
        vscode.window.showWarningMessage(
          `已暂停自动镜像：${service.title} 包含 ${err.mirrorFileCount} 个文件，超过上限 ${err.mirrorMaxFiles}。请打开具体项目目录，或点击状态栏“语言服务”强制同步。`,
        );
      }
    },
    onMirrorError: (service, err) => {
      lspItem.text = "语言服务（兼容镜像）：同步失败";
      lspItem.tooltip = `${service.title}\n${err && err.message ? err.message : String(err)}\n点击重试`;
      lspItem.show();
    },
    onMountReady: (service, prepared) => {
      lspItem.text = `语言智能：已连接远端文件视图（${prepared.entryCount ? `${prepared.entryCount} 条编译命令` : "flags 兜底"}）`;
      lspItem.tooltip = `${service.title}\n只读 SSHFS：${service.mountRoot}\n目标：${prepared.targetTriplet}\n点击查看操作`;
      lspItem.show();
    },
  };
  lsp = createLanguageServices(vscode, lspDeps);
  lspItem.show();

  attachFolders = () => {
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
      // 只登记工作区；浏览模式保持零语言服务进程，切到代码智能后才按文件启动。
      if (!lsp.attach(folder.uri)) log(`语言服务：${folder.uri.authority} 还没有会话`);
    }
  };
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    updateStatus();
    attachFolders();
  }));

  // 命令
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const setLanguageMode = async (mode) => {
    await vscode.workspace.getConfiguration("rce").update("lsp.mode", mode, vscode.ConfigurationTarget.Global);
    lsp.setMode(mode);
    const detail = mode === "intelligent"
      ? "当前文件优先启动，语言服务在远端按需运行"
      : "语言服务进入热保留，超时后自动停止";
    vscode.window.setStatusBarMessage(`织码：${mode === "intelligent" ? "代码智能" : "浏览模式"} · ${detail}`, 3000);
  };
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("rce.lsp")) return;
    const runtimeKeys = [
      "enabled", "transport", "servers", "cppPath", "pythonPath", "maxFiles",
      "autoPromoteOnEdit", "warmRetentionMinutes",
    ];
    if (runtimeKeys.some((key) => event.affectsConfiguration(`rce.lsp.${key}`))) {
      void lsp.reload().catch((err) => log(`重载语言服务配置失败：${err && err.message}`));
      return;
    }
    // 只改模式时保留现有编辑器模型和语言进程，走平滑切换而不是重建扩展。
    if (event.affectsConfiguration("rce.lsp.mode")) lsp.setMode(lspConfig().mode);
  }));
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
    setRemoteConnectionState("disconnected", "已断开所有远程连接");
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
    lspItem.text = "语言服务：未连接";
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
  register("rce.lsp.browseMode", () => setLanguageMode("browse"));
  register("rce.lsp.intelligentMode", () => setLanguageMode("intelligent"));
  register("rce.lsp.toggleMode", () => setLanguageMode(lsp.currentMode() === "intelligent" ? "browse" : "intelligent"));
  register("rce.lsp.configure", () => vscode.commands.executeCommand("workbench.action.openSettings", "rce.lsp"));
  register("rce.lsp.menu", async () => {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
    const session = folder ? sessionOf(folder.uri) : undefined;
    const intelligent = lsp.currentMode() === "intelligent";
    const transport = lspConfig().transport;
    const items = [
      intelligent
        ? { label: "$(eye) 切换到浏览模式", detail: "停止新请求；现有语言服务先热保留，超时后退出", run: () => setLanguageMode("browse") }
        : { label: "$(symbol-method) 切换到代码智能", detail: "当前文件优先启动，保留光标、撤销历史和标签", run: () => setLanguageMode("intelligent") },
      { label: "$(settings-gear) 配置语言服务器…", detail: "任意标准 LSP；C++/Python 已内置默认项", run: () => vscode.commands.executeCommand("rce.lsp.configure") },
      { label: "$(output) 查看语言服务日志", run: () => channel.show() },
      ...(session ? [] : [{ label: "$(plug) 重新连接远程主机…", run: () => vscode.commands.executeCommand("rce.connect") }]),
      transport === "local"
        ? { label: "$(refresh) 重新同步兼容镜像（全量）", detail: "仅 local 兼容模式；remote 模式不需要", run: () => vscode.commands.executeCommand("rce.lsp.syncMirror") }
        : { label: "$(refresh) 重建语言服务文件视图", detail: "重新挂载远端并启动当前文件的语言服务", run: () => vscode.commands.executeCommand("rce.lsp.syncMirror") },
      { label: "$(sync) 重启语言服务", detail: "改了 compile_commands / 换了编译器时用", run: () => vscode.commands.executeCommand("rce.lsp.restart") },
    ];
    const picked = await vscode.window.showQuickPick(items.map((i) => ({ label: i.label, detail: i.detail })), {
      title: "织码语言服务",
      placeHolder: lspItem.tooltip || "",
    });
    if (!picked) return;
    const item = items.find((i) => i.label === picked.label);
    if (item) void item.run();
  });
  register("rce.lsp.syncMirror", async () => {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
    if (!folder) {
      vscode.window.showWarningMessage("当前窗口没有已连接的远端目录");
      return;
    }
    lspItem.text = lspConfig().transport === "local" ? "语言服务：同步兼容镜像…" : "语言智能：重建文件视图…";
    lspItem.show();
    try {
      const service = await lsp.syncMirror(folder.uri);
      if (lspConfig().transport === "local") {
        const info = service?.mirror?.manifest?.().size ?? 0;
        vscode.window.showInformationMessage(`兼容镜像已同步：${info} 个文件`);
      } else {
        vscode.window.showInformationMessage("语言服务文件视图已重建，当前文件优先启动");
      }
    } catch (err) {
      lspItem.text = "语言智能：启动失败";
      vscode.window.showErrorMessage(`语言服务操作失败：${err && err.message}`);
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
      vscode.window.showInformationMessage("语言服务已重启");
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
    .catch((err) => scmReport("暂存失败", err)));
  register("rce.scm.unstage", (arg) => scm.runOnResources(arg, (entry, paths) => entry.git.unstage(entry.root, paths))
    .catch((err) => scmReport("取消暂存失败", err)));
  register("rce.scm.stageAll", (arg) => scm.runOnResources(arg, (entry) => entry.git.stageAll(entry.root))
    .catch((err) => scmReport("暂存全部失败", err)));
  register("rce.scm.unstageAll", (arg) => scm.runOnResources(arg, (entry) => entry.git.unstageAll(entry.root))
    .catch((err) => scmReport("取消暂存全部失败", err)));
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
    }).catch((err) => scmReport("放弃更改失败", err));
  });
  /** SCM 操作失败：弹窗 + 写输出通道（带上 git 的 stderr，否则只剩一句“提交失败”没法排查） */
  function scmReport(label, err) {
    const detail = err && err.detail ? `\n${err.detail}` : "";
    const text = `${label}：${(err && err.message) || err}${detail}`;
    log(text);
    vscode.window.showErrorMessage(text);
  }

  // 菜单命令会按“菜单上下文 + 被点中的节点”依次传参：历史图右键实际收到
  // [SourceControl, SourceControlHistoryItem]，不能再假设首个参数就是目标。
  const flattenCommandArgs = (args) => (Array.isArray(args) ? args.flat(3) : [args]).filter(Boolean);

  // 命令参数可能是输入框字符串（acceptInputCommand）、SourceControl（标题栏/大按钮）、
  // SourceControlResourceGroup（组级菜单）或上述参数的组合。统一找出目标仓库。
  const scmTargetOf = (...args) => {
    const all = [...scm.entries.values()];
    for (const arg of flattenCommandArgs(args)) {
      if (arg && arg.rootUri) {
        const found = scm.entryOf(arg.rootUri);
        if (found) return found;
      }
      const direct = all.find((entry) => entry.sc === arg || entry.staged === arg || entry.changes === arg);
      if (direct) return direct;
    }
    return all[0];
  };

  register("rce.scm.commit", async (...args) => {
    // acceptInputCommand 传进来的是输入框字符串；scm/title 的 ✓ 按钮传进来的是 SourceControl（带 rootUri）。
    let message = flattenCommandArgs(args).find((arg) => typeof arg === "string");
    const target = scmTargetOf(...args);
    if (!target) return;
    if (!message) message = target.sc.inputBox.value;
    if (!message || !message.trim()) {
      vscode.window.showWarningMessage("提交信息不能为空");
      return;
    }
    if (target.staged.resourceStates.length === 0 && target.changes.resourceStates.length === 0) {
      vscode.window.showInformationMessage("没有可提交的更改");
      return;
    }
    try {
      // 和 VS Code 一致：暂存区是空的、但工作区有改动时，先全部暂存再提交
      if (target.staged.resourceStates.length === 0 && target.changes.resourceStates.length > 0) {
        await target.git.commitAll(target.root, message);
      } else {
        await target.git.commitStaged(target.root, message);
      }
      target.sc.inputBox.value = "";
      await scm.refreshAll();
    } catch (err) {
      scmReport("提交失败", err);
    }
  });

  // 图表里右键某条提交时，工作台通常传入 [SourceControl, SourceControlHistoryItem]。
  // 从末尾找真正的提交节点，避免把同样有 id 的 SourceControl 误当提交。
  const historyCommitOf = (...args) => {
    const flat = flattenCommandArgs(args);
    for (let i = flat.length - 1; i >= 0; i--) {
      const item = flat[i];
      if (item && typeof item.id === "string"
        && (Array.isArray(item.parentIds) || typeof item.subject === "string" || typeof item.message === "string")) {
        return item;
      }
    }
    return undefined;
  };

  register("rce.scm.copyCommitId", async (...args) => {
    const item = historyCommitOf(...args);
    if (!item) return;
    await vscode.env.clipboard.writeText(item.id);
    vscode.window.showInformationMessage(`已复制提交 ${item.displayId || item.id.slice(0, 7)}`);
  });

  register("rce.scm.checkoutCommit", async (...args) => {
    const item = historyCommitOf(...args);
    const target = scmTargetOf(...args);
    if (!item || !target || !target.root) return;
    const short = item.displayId || item.id.slice(0, 7);
    const pick = await vscode.window.showWarningMessage(
      `检出到提交 ${short}？会进入游离 HEAD 状态。`, { modal: true }, "检出",
    );
    if (pick !== "检出") return;
    try {
      await target.git.checkoutRev(target.root, item.id);
      await scm.refreshAll();
      vscode.window.showInformationMessage(`已检出 ${short}`);
    } catch (err) {
      scmReport("检出提交失败", err);
    }
  });

  register("rce.scm.revertCommit", async (...args) => {
    const item = historyCommitOf(...args);
    const target = scmTargetOf(...args);
    if (!item || !target || !target.root) return;
    const short = item.displayId || item.id.slice(0, 7);
    const pick = await vscode.window.showWarningMessage(
      `撤销提交 ${short}？会生成一条新的反向提交。`, { modal: true }, "撤销",
    );
    if (pick !== "撤销") return;
    try {
      await target.git.revert(target.root, item.id);
      await scm.refreshAll();
      vscode.window.showInformationMessage(`已撤销 ${short}`);
    } catch (err) {
      scmReport("撤销提交失败", err);
    }
  });

  register("rce.scm.resetCommit", async (...args) => {
    const item = historyCommitOf(...args);
    const target = scmTargetOf(...args);
    if (!item || !target || !target.root) return;
    const short = item.displayId || item.id.slice(0, 7);
    const pick = await vscode.window.showWarningMessage(
      `硬重置到 ${short}？这会丢弃该提交之后的所有提交和当前改动，无法恢复。`,
      { modal: true }, "硬重置",
    );
    if (pick !== "硬重置") return;
    try {
      await target.git.resetHard(target.root, item.id);
      await scm.refreshAll();
      vscode.window.showInformationMessage(`已重置到 ${short}`);
    } catch (err) {
      scmReport("重置失败", err);
    }
  });

  register("rce.scm.checkout", async (...args) => {
    const target = scmTargetOf(...args);
    if (!target || !target.root) return;
    let branches;
    try {
      branches = await target.git.branches(target.root);
    } catch (err) {
      scmReport("读取分支失败", err);
      return;
    }
    if (!branches.length) {
      vscode.window.showInformationMessage("没有可切换的分支");
      return;
    }
    const current = branches.find((b) => b.current);
    const pick = await vscode.window.showQuickPick(
      branches.map((b) => ({
        label: `${b.current ? "$(check)" : "$(git-branch)"} ${b.name}`,
        description: b.remote ? "远端分支" : (b.upstream ? `→ ${b.upstream}` : ""),
        detail: b.detached ? "游离 HEAD" : undefined,
        branch: b,
      })),
      { title: "切换分支", placeHolder: current ? `当前在 ${current.name}` : "选择要切换到的分支" },
    );
    if (!pick) return;
    const name = pick.branch.name;
    if (pick.branch.remote) {
      vscode.window.showInformationMessage("远端分支不能直接切换，请先在远端建本地分支");
      return;
    }
    if (current && name === current.name) return;
    try {
      await target.git.switchBranch(target.root, name);
      await scm.refreshAll();
      vscode.window.showInformationMessage(`已切换到 ${name}`);
    } catch (err) {
      scmReport("切换分支失败", err);
    }
  });

  register("rce.scm.commitAmend", async (...args) => {
    const target = scmTargetOf(...args);
    if (!target) return;
    const message = (target.sc.inputBox.value || "").trim();
    try {
      // 输入框为空时走 `git commit --amend --no-edit`，沿用上一条提交信息
      await target.git.commitStaged(target.root, message, { amend: true });
      target.sc.inputBox.value = "";
      await scm.refreshAll();
    } catch (err) {
      scmReport("提交（修改）失败", err);
    }
  });

  register("rce.scm.commitAndPush", async (...args) => {
    const target = scmTargetOf(...args);
    if (!target) return;
    const message = (target.sc.inputBox.value || "").trim();
    if (!message) {
      vscode.window.showWarningMessage("提交信息不能为空");
      return;
    }
    if (target.staged.resourceStates.length === 0 && target.changes.resourceStates.length === 0) {
      vscode.window.showInformationMessage("没有可提交的更改");
      return;
    }
    try {
      if (target.staged.resourceStates.length === 0 && target.changes.resourceStates.length > 0) {
        await target.git.commitAll(target.root, message);
      } else {
        await target.git.commitStaged(target.root, message);
      }
      target.sc.inputBox.value = "";
      await target.git.push(target.root);
      await scm.refreshAll();
      vscode.window.showInformationMessage("已提交并推送");
    } catch (err) {
      scmReport("提交和推送失败", err);
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
  // 兜底挂载：窗口重载后远端工作区文件夹在扩展激活**之前**就恢复了，
  // onDidChangeWorkspaceFolders 不会再触发——SCM attach / 镜像预热必须在这里主动做一遍。
  // 这是「git 面板永远空」的根因：以前只有环境变量连接路径会走到 attachFolders。
  // attachFolders 内部对每个 folder 幂等（entries.has 去重），重复调用无副作用。
  const anyRemoteFolder = (vscode.workspace.workspaceFolders || []).some((f) => f.uri.scheme === SCHEME);
  if (anyRemoteFolder && [...sessions.byAuthority.values()].length > 0) {
    attachFolders();
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
