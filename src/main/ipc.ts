// 所有 ipcMain.handle / on 的唯一注册点（总纲 §3 + 分册 3 D2 通道命名：api:<域>.<动作> / event:<名>）
// M1 窗口控制 → M3 镜像同步 + 语言服务 → M4 主机 / 文件 / 编辑全链路
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import { AppError, toAppError } from "../shared/errors.js";
import type { HostConfig, SecretInput } from "../shared/types.js";
import { HostStore, type HostRecord } from "./config/hosts.js";
import { SettingsStore } from "./config/settings.js";
import { importSshConfig, listLocalKeys } from "./config/ssh-config.js";
import { languageIdOf } from "./lsp/client.js";
import type { LspLanguage } from "./lsp/manager.js";
import { log } from "./log.js";
import { SessionManager } from "./session/session-manager.js";

/** 边缘缩放：渲染进程 8px 热区拖拽 → 按方向调整窗口 bounds（总纲 §13 坑 12） */
function applyResizeDrag(win: BrowserWindow, edge: string, dx: number, dy: number): void {
  const b = win.getBounds();
  const [minW, minH] = win.getMinimumSize();
  let { x, y, width, height } = b;
  if (edge.includes("right")) width = Math.max(minW, width + dx);
  if (edge.includes("bottom")) height = Math.max(minH, height + dy);
  if (edge.includes("left")) {
    const newW = Math.max(minW, width - dx);
    x += width - newW;
    width = newW;
  }
  if (edge.includes("top")) {
    const newH = Math.max(minH, height - dy);
    y += height - newH;
    height = newH;
  }
  win.setBounds({ x, y, width, height });
}

let session: SessionManager | null = null;
let windowGetter: (() => BrowserWindow | null) | null = null;
let hostStore: HostStore | null = null;
let settingsStore: SettingsStore | null = null;

/** 启动时建会话（index.ts 在 app.whenReady 后调用） */
export function initSession(opts?: { sshDir?: string }): SessionManager {
  const userData = app.getPath("userData");
  hostStore = new HostStore(path.join(userData, "hosts.json"));
  settingsStore = new SettingsStore(path.join(userData, "settings.json"));
  const hosts = hostStore;
  const settings = settingsStore;
  const send = (channel: string, payload: unknown): void => {
    windowGetter?.()?.webContents.send(channel, payload);
  };
  session = new SessionManager({
    hosts,
    settings,
    userData,
    sshDir: opts?.sshDir,
    onEvent: {
      connectionState: (p) => send("event:connection-state", p),
      authRequired: (p) => send("event:auth-required", p),
      mirrorProgress: (p) => send("event:mirror-progress", p),
      mirrorDone: (p) => send("event:mirror-done", p),
      diagnostics: (p) => send("event:diagnostics", p),
      terminalData: (p) => send("event:terminal-data", p),
      terminalClosed: (p) => send("event:terminal-closed", p),
      progress: (p) => send("event:progress", p),
    },
  });
  return session;
}

export function currentSession(): SessionManager {
  if (!session) throw new AppError("unknown", "会话尚未初始化");
  return session;
}

/** 退出前收口：语言服务与 SSH 都要关（§5.5.1 不许留僵尸进程） */
export async function shutdownSession(): Promise<void> {
  await session?.disconnect().catch(() => { /* 退出路径不抛错 */ });
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  windowGetter = getWindow;

  // ---- 窗口控制（M1，不在分册 3 D2 表格内，保持既有命名） ----
  ipcMain.on("window:minimize", () => getWindow()?.minimize());
  ipcMain.on("window:toggle-maximize", () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.on("window:close", () => getWindow()?.close());
  ipcMain.handle("window:is-maximized", () => getWindow()?.isMaximized() ?? false);
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.on("window:resize-drag", (_event, args: { edge: string; dx: number; dy: number }) => {
    const win = getWindow();
    if (!win || win.isMaximized()) return;
    applyResizeDrag(win, args.edge, args.dx, args.dy);
  });

  /** 保存窗口状态到 settings.json 的 window 字段（规格未覆盖：close/resize/maximize 都要记录） */
  const saveWindow = (win: BrowserWindow): void => {
    const bounds = win.getBounds();
    new SettingsStore(path.join(app.getPath("userData"), "settings.json")).update({
      window: {
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        maximized: win.isMaximized(),
      },
    });
  };

  // ---- 主机（D2.1） ----

  ipcMain.handle("api:host.list", async () => hostStore?.list() ?? []);

  ipcMain.handle("api:host.save", async (_event, host: HostRecord) => {
    hostStore?.save(host);
  });

  ipcMain.handle("api:host.remove", async (_event, id: string) => {
    hostStore?.remove(id);
  });

  ipcMain.handle("api:host.connect", async (_event, args: { id: string; secret?: SecretInput }) => {
    try {
      return await currentSession().connect(args.id, args.secret);
    } catch (err) {
      throw toAppError(err, "ssh");
    }
  });

  ipcMain.handle("api:host.disconnect", async () => {
    await currentSession().disconnect();
  });

  ipcMain.handle("api:host.listLocalKeys", async () => listLocalKeys());
  ipcMain.handle("api:host.importSshConfig", async () => importSshConfig());

  // ---- 文件（D2.2） ----

  ipcMain.handle("api:fs.listDir", async (_event, p: string) => currentSession().listDir(p));
  ipcMain.handle("api:fs.readFile", async (_event, p: string) => currentSession().readFile(p));
  ipcMain.handle("api:fs.saveFile", async (_event, args: { path: string; text: string; opts?: { encoding?: "utf8" | "utf8-bom"; newline?: "lf" | "crlf" } }) =>
    currentSession().saveFile(args.path, args.text, args.opts));
  ipcMain.handle("api:fs.create", async (_event, args: { path: string; isDir: boolean }) => currentSession().create(args.path, args.isDir));
  ipcMain.handle("api:fs.rename", async (_event, args: { from: string; to: string }) => currentSession().rename(args.from, args.to));
  ipcMain.handle("api:fs.remove", async (_event, p: string) => currentSession().remove(p));
  ipcMain.handle("api:fs.stat", async (_event, p: string) => currentSession().stat(p));
  ipcMain.handle("api:fs.openFolder", async (_event, workspace: string) => currentSession().openFolder(workspace));

  // ---- 镜像 / Git / 搜索（D2.3；Git 与搜索的完整面板在 M5） ----

  ipcMain.handle("api:mirror.sync", async () => {
    try {
      return await currentSession().syncMirror();
    } catch (err) {
      throw toAppError(err, "mirror");
    }
  });

  ipcMain.handle("api:git.treeStatus", async (_event, directory: string) => currentSession().treeStatus(directory));
  ipcMain.handle("api:git.fileDiff", async (_event, args: { path: string; content?: string }) => currentSession().fileDiff(args.path, args.content));
  ipcMain.handle("api:git.commit", async (_event, args: { message: string; opts?: { amend?: boolean; push?: boolean; sync?: boolean } }) =>
    currentSession().gitCommit(args.message, args.opts));
  ipcMain.handle("api:git.branches", async () => currentSession().gitBranches());
  ipcMain.handle("api:git.switchBranch", async (_event, args: { name: string }) => currentSession().gitSwitchBranch(args.name));
  ipcMain.handle("api:git.logGraph", async (_event, args?: { limit?: number }) => currentSession().gitLogGraph(args?.limit ?? 200));
  ipcMain.handle("api:git.stage", async (_event, args: { paths: string[]; staged: boolean }) => currentSession().gitSetStaged(args.paths, args.staged));
  ipcMain.handle("api:git.stageAll", async (_event, args: { staged: boolean }) => currentSession().gitSetStagedAll(args.staged));
  ipcMain.handle("api:git.discard", async (_event, args: { paths: string[]; untracked: boolean }) => currentSession().gitDiscard(args.paths, args.untracked));
  ipcMain.handle("api:git.stashList", async () => currentSession().gitStashList());
  ipcMain.handle("api:git.stashSave", async (_event, args: { message: string }) => currentSession().gitStashSave(args.message));
  ipcMain.handle("api:git.stashPop", async (_event, args?: { index?: number }) => currentSession().gitStashPop(args?.index));
  ipcMain.handle("api:git.stashDrop", async (_event, args: { index: number }) => currentSession().gitStashDrop(args.index));
  ipcMain.handle("api:git.tags", async () => currentSession().gitTags());
  ipcMain.handle("api:git.createTag", async (_event, args: { name: string; message: string }) => currentSession().gitCreateTag(args.name, args.message));
  ipcMain.handle("api:git.deleteTag", async (_event, args: { name: string }) => currentSession().gitDeleteTag(args.name));
  ipcMain.handle("api:git.createBranch", async (_event, args: { name: string; checkout: boolean }) => currentSession().gitCreateBranch(args.name, { checkout: args.checkout }));
  ipcMain.handle("api:git.deleteBranch", async (_event, args: { name: string }) => currentSession().gitDeleteBranch(args.name));
  ipcMain.handle("api:git.mergeBranch", async (_event, args: { name: string }) => currentSession().gitMergeBranch(args.name));
  ipcMain.handle("api:git.remotes", async () => currentSession().gitRemotes());
  ipcMain.handle("api:git.addRemote", async (_event, args: { name: string; url: string }) => currentSession().gitAddRemote(args.name, args.url));
  ipcMain.handle("api:git.removeRemote", async (_event, args: { name: string }) => currentSession().gitRemoveRemote(args.name));
  ipcMain.handle("api:git.setRemoteUrl", async (_event, args: { name: string; url: string }) => currentSession().gitSetRemoteUrl(args.name, args.url));
  ipcMain.handle("api:git.fetch", async () => currentSession().gitFetch());
  ipcMain.handle("api:git.clone", async (_event, args: { url: string; dir: string }) => currentSession().gitClone(args.url, args.dir));
  ipcMain.handle("api:git.init", async (_event, args: { dir: string }) => currentSession().gitInit(args.dir));
  ipcMain.handle("api:git.refresh", async () => currentSession().treeStatus());
  ipcMain.handle("api:search.find", async (_event, args: { pattern: string; opts: { caseSensitive: boolean; regex: boolean } }) =>
    currentSession().search(args.pattern, args.opts));

  // ---- 语言服务（D2.3 + §5.5.2 需要的 open/save/close/ensure） ----

  ipcMain.handle("api:lsp.ensure", async (_event, args: { uri: string }) => {
    const language = requireLanguage(args.uri);
    await currentSession().ensureLsp(language);
    return { mode: "local" };
  });

  ipcMain.handle("api:lsp.completion", async (_event, args: { uri: string; line: number; character: number }) =>
    (await clientFor(args.uri)).completion(args.uri, args.line, args.character));
  ipcMain.handle("api:lsp.definition", async (_event, args: { uri: string; line: number; character: number }) =>
    (await clientFor(args.uri)).definition(args.uri, args.line, args.character));
  ipcMain.handle("api:lsp.hover", async (_event, args: { uri: string; line: number; character: number }) =>
    (await clientFor(args.uri)).hover(args.uri, args.line, args.character));

  ipcMain.on("api:lsp.changed", (_event, args: { uri: string; text: string; version: number }) => {
    void clientFor(args.uri).then((c) => c.didChange(args.uri, args.text, args.version)).catch(() => { /* 未就绪静默 */ });
  });
  ipcMain.on("api:lsp.open", (_event, args: { uri: string; text: string; version: number }) => {
    void clientFor(args.uri).then((c) => c.didOpen(args.uri, args.text, args.version)).catch(() => {});
  });
  ipcMain.on("api:lsp.save", (_event, args: { uri: string; text: string }) => {
    void clientFor(args.uri).then((c) => c.didSave(args.uri, args.text)).catch(() => {});
  });
  ipcMain.on("api:lsp.close", (_event, args: { uri: string }) => {
    void clientFor(args.uri).then((c) => c.didClose(args.uri)).catch(() => {});
  });

  // ---- 设置（分册 2 U9；M6）----

  ipcMain.handle("api:settings.get", async () => settingsStore?.get() ?? null);

  ipcMain.handle("api:settings.update", async (_event, patch: Record<string, unknown>) => settingsStore?.update(patch as never) ?? null);

  // ---- 终端（D2.3 / D2.4）----

  ipcMain.handle("api:terminal.create", async (_event, args: { id: string; cols: number; rows: number }) =>
    currentSession().createTerminal(args.id, args.cols, args.rows));
  ipcMain.on("api:terminal.write", (_event, args: { id: string; data: string }) => currentSession().writeTerminal(args.id, args.data));
  ipcMain.on("api:terminal.resize", (_event, args: { id: string; cols: number; rows: number }) => currentSession().resizeTerminal(args.id, args.cols, args.rows));
  ipcMain.on("api:terminal.close", (_event, args: { id: string }) => currentSession().closeTerminal(args.id));

  const win = getWindow();
  if (win) {
    win.on("resize", () => saveWindow(win));
    win.on("close", () => saveWindow(win));
  }
  log("info", "IPC 注册完成");
}

async function clientFor(uri: string): Promise<import("./lsp/client.js").LspClient> {
  const language = requireLanguage(uri);
  const client = await currentSession().ensureLsp(language);
  return client as import("./lsp/client.js").LspClient;
}

function requireLanguage(uri: string): LspLanguage {
  const language = languageIdOf(uri);
  if (language === "cpp" || language === "python") return language;
  throw new AppError("lsp", "该文件类型没有语言服务");
}

/** 兼容旧签名：M3 期间 ipc.ts 里导出的 setActiveSession，M4 起由 SessionManager 接管 */
export type { HostConfig };
