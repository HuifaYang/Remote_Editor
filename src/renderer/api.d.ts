// 渲染进程可用的 window.api 形状 —— 与 src/preload/index.ts 保持一致（总纲 §5.8 / 分册 3 D2）
import type {
  BranchInfo, Fingerprint, GitDiff, GitTreeStatus, GraphRow, HostConfig, LspCompletionItem, LspDiagnosticEvent,
  LspLocation, MirrorProgress, MirrorResult, RemoteEntry, SearchMatch, SecretInput,
} from "../shared/types.js";

export interface HostRecord extends HostConfig {
  workspaces: string[];      // 历史工作目录，最多 10 条，最新在前
}

export interface WindowApi {
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    resizeDrag(edge: string, dx: number, dy: number): void;
  };
  app: { version(): Promise<string> };
  host: {
    list(): Promise<HostRecord[]>;
    save(host: HostRecord): Promise<void>;
    remove(id: string): Promise<void>;
    connect(id: string, secret?: SecretInput): Promise<{ workspace: string }>;
    disconnect(): Promise<void>;
    listLocalKeys(): Promise<Array<{ path: string; label: string; encrypted: boolean }>>;
    importSshConfig(): Promise<Array<{ name: string; host: string; port: number; username: string; identityFile?: string }>>;
  };
  fs: {
    listDir(path: string): Promise<RemoteEntry[]>;
    readFile(path: string): Promise<{ text: string; encoding: string; newline: string; fingerprint: Fingerprint }>;
    saveFile(path: string, text: string, opts?: { encoding?: string; newline?: string }): Promise<Fingerprint>;
    create(path: string, isDir: boolean): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    remove(p: string): Promise<void>;
    stat(p: string): Promise<RemoteEntry | null>;
    openFolder(workspace: string): Promise<{ workspace: string; status: GitTreeStatus | null; entries: RemoteEntry[] }>;
  };
  mirror: { sync(): Promise<MirrorResult> };
  settings: {
    get(): Promise<Record<string, unknown>>;
    update(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  git: {
    treeStatus(directory: string): Promise<GitTreeStatus>;
    refresh(): Promise<GitTreeStatus>;
    fileDiff(path: string, content?: string): Promise<GitDiff>;
    commit(message: string, opts?: { amend?: boolean; push?: boolean; sync?: boolean }): Promise<string>;
    branches(): Promise<BranchInfo[]>;
    switchBranch(name: string): Promise<string>;
    logGraph(limit?: number): Promise<GraphRow[]>;
    setStaged(paths: string[], staged: boolean): Promise<GitTreeStatus>;
    setStagedAll(staged: boolean): Promise<GitTreeStatus>;
    discard(paths: string[], untracked: boolean): Promise<GitTreeStatus>;
    stashList(): Promise<Array<{ index: number; message: string; date: string }>>;
    stashSave(message: string): Promise<void>;
    stashPop(index?: number): Promise<void>;
    stashDrop(index: number): Promise<void>;
    tags(): Promise<Array<{ name: string; hash: string; message: string; date: string }>>;
    createTag(name: string, message: string): Promise<void>;
    deleteTag(name: string): Promise<void>;
    createBranch(name: string, checkout: boolean): Promise<void>;
    deleteBranch(name: string): Promise<void>;
    mergeBranch(name: string): Promise<string>;
    remotes(): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>>;
    addRemote(name: string, url: string): Promise<void>;
    removeRemote(name: string): Promise<void>;
    setRemoteUrl(name: string, url: string): Promise<void>;
    fetch(): Promise<string>;
    clone(url: string, dir: string): Promise<string>;
    init(dir: string): Promise<string>;
  };
  terminal: {
    create(id: string, cols: number, rows: number): Promise<void>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    close(id: string): void;
  };
  search: { find(pattern: string, opts: { caseSensitive: boolean; regex: boolean }): Promise<SearchMatch[]> };
  lsp: {
    ensure(uri: string): Promise<{ mode: string }>;
    completion(uri: string, line: number, character: number): Promise<LspCompletionItem[]>;
    definition(uri: string, line: number, character: number): Promise<LspLocation[]>;
    hover(uri: string, line: number, character: number): Promise<string | null>;
    open(uri: string, text: string, version: number): void;
    changed(uri: string, text: string, version: number): void;
    save(uri: string, text: string): void;
    close(uri: string): void;
  };
  on(channel: "window-state", cb: (p: { maximized: boolean }) => void): () => void;
  on(channel: "event:connection-state", cb: (p: { connected: boolean; message?: string }) => void): () => void;
  on(channel: "event:auth-required", cb: (p: { hostId: string; kind: "password" | "passphrase" }) => void): () => void;
  on(channel: "event:mirror-progress", cb: (p: MirrorProgress) => void): () => void;
  on(channel: "event:mirror-done", cb: (p: MirrorResult) => void): () => void;
  on(channel: "event:terminal-data", cb: (p: { id: string; data: string }) => void): () => void;
  on(channel: "event:terminal-closed", cb: (p: { id: string; code?: number }) => void): () => void;
  on(channel: "event:progress", cb: (p: { key: string; text: string; done: boolean }) => void): () => void;
  on(channel: "event:diagnostics", cb: (p: LspDiagnosticEvent) => void): () => void;
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
}

declare global {
  interface Window {
    api: WindowApi;
  }
}
