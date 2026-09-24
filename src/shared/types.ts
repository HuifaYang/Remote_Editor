// 一切跨进程传输的结构都在这里定义（总纲 §5.0）；禁止在别处定义重复类型

export interface HostConfig {
  id: string;                    // uuid
  name: string;                  // 显示名，如 "Robot-3566"
  host: string;                  // IP 或域名
  port: number;                  // 默认 22
  username: string;              // 默认 "root"
  authMethod: "password" | "key";
  privateKeyPath?: string;       // authMethod=key 时必填
  workspace?: string;            // 远端工作目录，可空
  lastUsedAt?: number;
}

export interface SecretInput {    // 只存在于内存，绝不落盘、绝不进日志
  password?: string;
  passphrase?: string;
}

export interface RemoteEntry {
  name: string;
  path: string;                  // 远端绝对路径
  isDir: boolean;
  isSymlink: boolean;
  size: number;                  // 目录为 0
  mtime: number;                 // epoch 秒
  mode: number;
}

export interface Fingerprint { path: string; size: number; mtime: number }

export interface GitFileStatus {
  path: string;                  // 仓库内相对路径
  indexStatus: string;           // porcelain 第 1 列
  worktreeStatus: string;        // porcelain 第 2 列
  letter: "U" | "A" | "M" | "D" | "R" | "!" | "";
  change: "added" | "modified" | "deleted" | null;
}

export interface GitTreeStatus {
  root: string;                  // 仓库根（远端绝对路径）
  branch: string;
  scope: string;                 // 扫描范围（= 工作目录）
  files: Record<string, GitFileStatus>;   // key = 远端绝对路径
  dirs: Record<string, "added" | "modified" | "deleted">; // 目录继承色（key=远端绝对路径）
  untrackedDirs: string[];
  fetchedAt: number;
  complete: boolean;
  label: string;                 // "Git: main · 34 处变更"
}

export interface GitDiff {
  addedLines: number[]; modifiedLines: number[]; deletedLines: number[];
  hunks: Array<{ startLine: number; removed: string[]; added: string[] }>;
  isDeletedFile: boolean;
}

export interface BranchInfo { name: string; current: boolean; remote: boolean; upstream: string; detached: boolean }

export interface CommitInfo { hash: string; parents: string[]; author: string; date: string; subject: string; refs: string[] }

export interface GraphRow { commit: CommitInfo; lane: number; topLanes: number[]; bottomLanes: number[]; parentLanes: number[]; laneCount: number }

export interface SearchMatch { path: string; line: number; text: string }

export interface MirrorEntry { path: string; size: number; mtime: number }
export interface MirrorResult { root: string; fileCount: number; totalBytes: number; changed: string[]; removed: string[] }
export interface MirrorProgress { done: number; total: number; current: string }

/** LSP 子集（总纲 §5.5.2）：跨进程只传这些形状，Monaco 映射在 shared/lsp-map.ts 做 */
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}
export interface LspDiagnosticEvent { uri: string; diagnostics: LspDiagnostic[] }
export interface LspCompletionItem {
  label: string;
  kind?: number;                 // LSP CompletionItemKind（1~25）
  detail?: string;
  documentation?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;      // 1=PlainText 2=Snippet
  sortText?: string;
  filterText?: string;
}
export interface LspCompletionList { items: LspCompletionItem[]; isIncomplete: boolean }

/** 语言服务位置（U9）：默认本机；板子上是唯一远端例外；disabled=完全关闭 */
export type LspTransportMode = "local" | "remote" | "disabled";

export type AppErrorCode =
  | "auth" | "auth-passphrase-required" | "timeout" | "network"
  | "host-key" | "ssh" | "sftp" | "git" | "mirror" | "lsp" | "invalid-input" | "unsupported" | "unknown";
export interface AppErrorShape { code: AppErrorCode; message: string; detail?: string }
