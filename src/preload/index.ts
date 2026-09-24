// 渲染进程唯一入口（总纲 §5.8 / 分册 3 D2）：contextBridge 只暴露 window.api，禁止整体暴露 ipcRenderer
import { contextBridge, ipcRenderer } from "electron";
import type {
  BranchInfo, Fingerprint, GitDiff, GitTreeStatus, GraphRow, HostConfig, LspCompletionItem, LspLocation,
  MirrorResult, RemoteEntry, SearchMatch, SecretInput,
} from "../shared/types.js";

/** 允许订阅的事件通道白名单（分册 3 D2.4） */
const ALLOWED_EVENTS = new Set([
  "window-state",              // M1 自绘标题栏的最大化状态（不在 D2.4 表格内，保留旧名）
  "event:connection-state",
  "event:auth-required",
  "event:mirror-progress",
  "event:mirror-done",
  "event:diagnostics",
  "event:terminal-data",
  "event:terminal-closed",
  "event:progress",
]);

export interface HostRecord extends HostConfig {
  workspaces: string[];
}

const api = {
  window: {
    minimize: (): void => ipcRenderer.send("window:minimize"),
    toggleMaximize: (): void => ipcRenderer.send("window:toggle-maximize"),
    close: (): void => ipcRenderer.send("window:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
    resizeDrag: (edge: string, dx: number, dy: number): void =>
      ipcRenderer.send("window:resize-drag", { edge, dx, dy }),
  },
  app: {
    version: (): Promise<string> => ipcRenderer.invoke("app:version"),
  },
  host: {
    list: (): Promise<HostRecord[]> => ipcRenderer.invoke("api:host.list"),
    save: (host: HostRecord): Promise<void> => ipcRenderer.invoke("api:host.save", host),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("api:host.remove", id),
    connect: (id: string, secret?: SecretInput): Promise<{ workspace: string }> =>
      ipcRenderer.invoke("api:host.connect", { id, secret }),
    disconnect: (): Promise<void> => ipcRenderer.invoke("api:host.disconnect"),
    listLocalKeys: (): Promise<Array<{ path: string; label: string; encrypted: boolean }>> =>
      ipcRenderer.invoke("api:host.listLocalKeys"),
    importSshConfig: (): Promise<Array<{ name: string; host: string; port: number; username: string; identityFile?: string }>> =>
      ipcRenderer.invoke("api:host.importSshConfig"),
  },
  fs: {
    listDir: (path: string): Promise<RemoteEntry[]> => ipcRenderer.invoke("api:fs.listDir", path),
    readFile: (path: string): Promise<{ text: string; encoding: string; newline: string; fingerprint: Fingerprint }> =>
      ipcRenderer.invoke("api:fs.readFile", path),
    saveFile: (path: string, text: string, opts?: { encoding?: string; newline?: string }): Promise<Fingerprint> =>
      ipcRenderer.invoke("api:fs.saveFile", { path, text, opts }),
    create: (path: string, isDir: boolean): Promise<void> => ipcRenderer.invoke("api:fs.create", { path, isDir }),
    rename: (from: string, to: string): Promise<void> => ipcRenderer.invoke("api:fs.rename", { from, to }),
    remove: (p: string): Promise<void> => ipcRenderer.invoke("api:fs.remove", p),
    stat: (p: string): Promise<RemoteEntry | null> => ipcRenderer.invoke("api:fs.stat", p),
    openFolder: (workspace: string): Promise<{ workspace: string; status: GitTreeStatus | null; entries: RemoteEntry[] }> =>
      ipcRenderer.invoke("api:fs.openFolder", workspace),
  },
  mirror: {
    sync: (): Promise<MirrorResult> => ipcRenderer.invoke("api:mirror.sync"),
  },
  settings: {
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("api:settings.get"),
    update: (patch: Record<string, unknown>): Promise<Record<string, unknown>> => ipcRenderer.invoke("api:settings.update", patch),
  },
  git: {
    treeStatus: (directory: string): Promise<GitTreeStatus> => ipcRenderer.invoke("api:git.treeStatus", directory),
    refresh: (): Promise<GitTreeStatus> => ipcRenderer.invoke("api:git.refresh"),
    fileDiff: (path: string, content?: string): Promise<GitDiff> => ipcRenderer.invoke("api:git.fileDiff", { path, content }),
    commit: (message: string, opts?: { amend?: boolean; push?: boolean; sync?: boolean }): Promise<string> =>
      ipcRenderer.invoke("api:git.commit", { message, opts }),
    branches: (): Promise<BranchInfo[]> => ipcRenderer.invoke("api:git.branches"),
    switchBranch: (name: string): Promise<string> => ipcRenderer.invoke("api:git.switchBranch", { name }),
    logGraph: (limit?: number): Promise<GraphRow[]> => ipcRenderer.invoke("api:git.logGraph", { limit }),
    setStaged: (paths: string[], staged: boolean): Promise<GitTreeStatus> => ipcRenderer.invoke("api:git.stage", { paths, staged }),
    setStagedAll: (staged: boolean): Promise<GitTreeStatus> => ipcRenderer.invoke("api:git.stageAll", { staged }),
    discard: (paths: string[], untracked: boolean): Promise<GitTreeStatus> => ipcRenderer.invoke("api:git.discard", { paths, untracked }),
    stashList: (): Promise<Array<{ index: number; message: string; date: string }>> => ipcRenderer.invoke("api:git.stashList"),
    stashSave: (message: string): Promise<void> => ipcRenderer.invoke("api:git.stashSave", { message }),
    stashPop: (index?: number): Promise<void> => ipcRenderer.invoke("api:git.stashPop", { index }),
    stashDrop: (index: number): Promise<void> => ipcRenderer.invoke("api:git.stashDrop", { index }),
    tags: (): Promise<Array<{ name: string; hash: string; message: string; date: string }>> => ipcRenderer.invoke("api:git.tags"),
    createTag: (name: string, message: string): Promise<void> => ipcRenderer.invoke("api:git.createTag", { name, message }),
    deleteTag: (name: string): Promise<void> => ipcRenderer.invoke("api:git.deleteTag", { name }),
    createBranch: (name: string, checkout: boolean): Promise<void> => ipcRenderer.invoke("api:git.createBranch", { name, checkout }),
    deleteBranch: (name: string): Promise<void> => ipcRenderer.invoke("api:git.deleteBranch", { name }),
    mergeBranch: (name: string): Promise<string> => ipcRenderer.invoke("api:git.mergeBranch", { name }),
    remotes: (): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> => ipcRenderer.invoke("api:git.remotes"),
    addRemote: (name: string, url: string): Promise<void> => ipcRenderer.invoke("api:git.addRemote", { name, url }),
    removeRemote: (name: string): Promise<void> => ipcRenderer.invoke("api:git.removeRemote", { name }),
    setRemoteUrl: (name: string, url: string): Promise<void> => ipcRenderer.invoke("api:git.setRemoteUrl", { name, url }),
    fetch: (): Promise<string> => ipcRenderer.invoke("api:git.fetch"),
    clone: (url: string, dir: string): Promise<string> => ipcRenderer.invoke("api:git.clone", { url, dir }),
    init: (dir: string): Promise<string> => ipcRenderer.invoke("api:git.init", { dir }),
  },
  search: {
    find: (pattern: string, opts: { caseSensitive: boolean; regex: boolean }): Promise<SearchMatch[]> =>
      ipcRenderer.invoke("api:search.find", { pattern, opts }),
  },
  lsp: {
    ensure: (uri: string): Promise<{ mode: string }> => ipcRenderer.invoke("api:lsp.ensure", { uri }),
    completion: (uri: string, line: number, character: number): Promise<LspCompletionItem[]> =>
      ipcRenderer.invoke("api:lsp.completion", { uri, line, character }),
    definition: (uri: string, line: number, character: number): Promise<LspLocation[]> =>
      ipcRenderer.invoke("api:lsp.definition", { uri, line, character }),
    hover: (uri: string, line: number, character: number): Promise<string | null> =>
      ipcRenderer.invoke("api:lsp.hover", { uri, line, character }),
    open: (uri: string, text: string, version: number): void => ipcRenderer.send("api:lsp.open", { uri, text, version }),
    changed: (uri: string, text: string, version: number): void => ipcRenderer.send("api:lsp.changed", { uri, text, version }),
    save: (uri: string, text: string): void => ipcRenderer.send("api:lsp.save", { uri, text }),
    close: (uri: string): void => ipcRenderer.send("api:lsp.close", { uri }),
  },
  terminal: {
    create: (id: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke("api:terminal.create", { id, cols, rows }),
    write: (id: string, data: string): void => ipcRenderer.send("api:terminal.write", { id, data }),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send("api:terminal.resize", { id, cols, rows }),
    close: (id: string): void => ipcRenderer.send("api:terminal.close", { id }),
  },
  /** 事件订阅，返回退订函数（分册 3 D2.4） */
  on(channel: string, cb: (...args: unknown[]) => void): () => void {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`未授权的事件通道: ${channel}`);
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
};

contextBridge.exposeInMainWorld("api", api);

export type PreloadApi = typeof api;
