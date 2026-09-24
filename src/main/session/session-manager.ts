// 会话管理（规格未覆盖处：总纲 §3 目录里没有单独的会话文件，M4 的连接入口需要它）
// 职责：持有一次连接的 SSHConnection + 各能力模块，串起「连接 → 开目录 → 开文件 → 存」全链路。
import { createHash } from "node:crypto";
import * as path from "node:path";
import { AppError } from "../../shared/errors.js";
import type {
  BranchInfo, Fingerprint, GitDiff, GitTreeStatus, GraphRow, HostConfig, MirrorResult, RemoteEntry, SearchMatch,
} from "../../shared/types.js";
import type { HostStore } from "../config/hosts.js";
import type { SettingsStore } from "../config/settings.js";
import { LspManager, type LspLanguage } from "../lsp/manager.js";
import { MirrorManager } from "../mirror/manager.js";
import { log } from "../log.js";
import { SSHConnection } from "./connection.js";
import { GitRemote } from "./git.js";
import { RemoteFs } from "./remote-fs.js";
import { SearchRemote } from "./search.js";
import { TerminalChannel } from "./terminal.js";

export interface SessionEvents {
  connectionState?: (payload: { connected: boolean; message?: string }) => void;
  authRequired?: (payload: { hostId: string; kind: "password" | "passphrase" }) => void;
  mirrorProgress?: (payload: { done: number; total: number; current: string }) => void;
  mirrorDone?: (payload: MirrorResult) => void;
  diagnostics?: (payload: unknown) => void;
  terminalData?: (payload: { id: string; data: string }) => void;
  terminalClosed?: (payload: { id: string; code?: number }) => void;
  progress?: (payload: { key: string; text: string; done: boolean }) => void;
}

export interface SessionDeps {
  hosts: HostStore;
  settings: SettingsStore;
  userData: string;
  sshDir?: string;
  onEvent?: SessionEvents;
}

export class SessionManager {
  private conn: SSHConnection | null = null;
  private fsApi: RemoteFs | null = null;
  private gitApi: GitRemote | null = null;
  private searchApi: SearchRemote | null = null;
  private mirrorApi: MirrorManager | null = null;
  private lspApi: LspManager | null = null;
  private host: HostConfig | null = null;
  private readonly terminals = new Map<string, TerminalChannel>();
  workspace = "";
  /** 挂起的密码/口令请求：认证失败时记住当前主机，等渲染进程回填后再连 */
  private pending: { hostId: string; kind: "password" | "passphrase" } | null = null;

  constructor(private readonly deps: SessionDeps) {}

  get connected(): boolean {
    return this.conn !== null;
  }

  get currentHost(): HostConfig | null {
    return this.host;
  }

  /** 认证待回填（渲染进程据 event:auth-required 决定显示密码行还是口令行） */
  get pendingAuth(): { hostId: string; kind: "password" | "passphrase" } | null {
    return this.pending;
  }

  get mirror(): MirrorManager | null {
    return this.mirrorApi;
  }

  get lsp(): LspManager | null {
    return this.lspApi;
  }

  /** 连接（§5.1 认证顺序 + D3.1）：失败时按错误码抛给渲染进程要密码/口令 */
  async connect(hostId: string, secret?: { password?: string; passphrase?: string }): Promise<{ workspace: string }> {
    const host = this.deps.hosts.list().find((h) => h.id === hostId);
    if (!host) throw new AppError("invalid-input", "主机不存在", hostId);
    await this.disconnect(false);
    const settings = this.deps.settings.get();
    const conn = new SSHConnection({
      host: host.host,
      port: host.port,
      username: host.username,
      password: secret?.password,
      passphrase: secret?.passphrase,
      privateKeyPath: host.authMethod === "key" ? host.privateKeyPath : undefined,
      timeoutMs: settings.sshTimeoutSeconds * 1000,
      keepaliveMs: settings.sshKeepaliveSeconds * 1000,
      strictHostKey: settings.sshStrictHostKey,
      knownHostsPath: path.join(this.deps.userData, "known_hosts"),
      sshDir: this.deps.sshDir,
    });
    try {
      await conn.connect();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "auth-passphrase-required") {
        this.pending = { hostId, kind: "passphrase" };
        this.deps.onEvent?.authRequired?.({ hostId, kind: "passphrase" });
      } else if (code === "auth" && host.authMethod === "password") {
        this.pending = { hostId, kind: "password" };
        this.deps.onEvent?.authRequired?.({ hostId, kind: "password" });
      }
      throw err;
    }
    this.pending = null;
    this.conn = conn;
    this.host = host;
    this.fsApi = new RemoteFs(conn);
    this.gitApi = new GitRemote(conn);
    this.searchApi = new SearchRemote(conn);
    this.mirrorApi = new MirrorManager(conn, this.mirrorRootFor(host, host.workspace ?? ""));
    this.lspApi = new LspManager(this.mirrorApi, this.deps.userData, {
      transportMode: () => this.deps.settings.get().lspTransport,
      connection: () => this.conn,
      serverPaths: () => ({
        cpp: this.deps.settings.get().cppServer,
        python: this.deps.settings.get().pythonServer,
      }),
    });
    if (this.deps.settings.get().lspEnabled) {
      this.lspApi.diagnostics((e) => this.deps.onEvent?.diagnostics?.(e));
    }
    this.host.lastUsedAt = Math.floor(Date.now() / 1000);
    this.deps.hosts.touch(hostId, host.workspace);
    this.deps.onEvent?.connectionState?.({ connected: true, message: host.name });
    log("info", `已连接 ${host.name}（${host.username}@${host.host}:${host.port}）`);
    return { workspace: host.workspace ?? "" };
  }

  // ---- M6：终端（每标签一个 SSH shell 通道，关闭标签必须 kill）----

  async createTerminal(id: string, cols: number, rows: number): Promise<void> {
    if (!this.conn) throw new AppError("ssh", "未连接主机");
    if (this.terminals.has(id)) return;
    const term = new TerminalChannel(this.conn);
    term.onData((chunk) => {
      this.deps.onEvent?.terminalData?.({ id, data: chunk.toString("base64") });
    });
    term.onClose((code) => {
      this.terminals.delete(id);
      this.deps.onEvent?.terminalClosed?.({ id, code });
    });
    await term.open(cols, rows);
    this.terminals.set(id, term);
  }

  writeTerminal(id: string, data: string): void {
    const term = this.terminals.get(id);
    if (!term) return;
    // 终端里改过文件 → 镜像可能过期（分册 2 U7）
    this.deps.onEvent?.progress?.({ key: "mirror-stale", text: "镜像可能过期，按 F5 同步", done: true });
    term.write(data);
  }

  resizeTerminal(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.resize(cols, rows);
  }

  closeTerminal(id: string): void {
    this.terminals.get(id)?.close();
    this.terminals.delete(id);
  }

  /** 断开：先收语言服务与终端，再关 SSH（§5.5.1 禁止僵尸进程） */
  async disconnect(notify = true): Promise<void> {
    for (const id of [...this.terminals.keys()]) this.closeTerminal(id);
    if (this.lspApi) await this.lspApi.stopAll().catch(() => { /* 关不掉也要继续 */ });
    if (this.conn) await this.conn.close().catch(() => { /* 同上 */ });
    this.conn = null;
    this.fsApi = null;
    this.gitApi = null;
    this.searchApi = null;
    this.mirrorApi = null;
    this.lspApi = null;
    this.host = null;
    if (notify) this.deps.onEvent?.connectionState?.({ connected: false });
  }

  /** 打开工作目录（§7 预算：2 条 git + 1 次 list_dir；镜像同步留到 F5 / 首次补全） */
  async openFolder(workspace: string): Promise<{ workspace: string; status: GitTreeStatus | null; entries: RemoteEntry[] }> {
    const fsApi = this.requireFs();
    const git = this.requireGit();
    this.workspace = workspace;
    this.deps.hosts.touch(this.host?.id ?? "", workspace);
    const entries = await fsApi.listDir(workspace);
    let status: GitTreeStatus | null = null;
    try {
      status = await git.treeStatus(workspace);
    } catch (err) {
      log("info", `工作目录不是 Git 仓库（${String(err)}）`);
    }
    return { workspace, status, entries };
  }

  /** 镜像同步（F5 / 首次补全前调用；D3.1 首次同步也在连接后走这里） */
  async syncMirror(): Promise<MirrorResult> {
    const mirror = this.requireMirror();
    if (!this.workspace) throw new AppError("invalid-input", "请先打开远程文件夹");
    const result = await mirror.sync(this.workspace, (p) => this.deps.onEvent?.mirrorProgress?.(p));
    this.deps.onEvent?.mirrorDone?.(result);
    return result;
  }

  /** 语言服务：首次调用前确保镜像是最新的（补全基于镜像，不基于远端） */
  async ensureLsp(language: LspLanguage): Promise<unknown> {
    const lsp = this.lspApi;
    if (!lsp || !this.deps.settings.get().lspEnabled) throw new AppError("lsp", "语言服务已关闭");
    if (this.mirrorApi && this.mirrorApi.workspaceRoot !== this.workspace) {
      await this.syncMirror().catch((err) => log("warn", `镜像同步失败，补全可能不完整：${String(err)}`));
    }
    return lsp.ensure(language, this.workspace);
  }

  // ---- 文件操作（渲染进程只经这些方法，禁止直接碰 SSH） ----

  async listDir(p: string): Promise<RemoteEntry[]> {
    return this.requireFs().listDir(p);
  }

  async stat(p: string): Promise<RemoteEntry | null> {
    const fsApi = this.requireFs();
    return (await fsApi.fingerprint(p)) ? fsApi.stat(p) : null;
  }

  async readFile(p: string): Promise<{ text: string; encoding: "utf8" | "utf8-bom" | "binary"; newline: "lf" | "crlf"; fingerprint: Fingerprint }> {
    const file = await this.requireFs().readFile(p, this.deps.settings.get().maxFileSizeMb * 1024 * 1024);
    // 打开后写本地镜像副本（D3.2：LSP 0 远端往返，但 LSP 必须基于当前文件）
    if (this.mirrorApi && this.mirrorApi.workspaceRoot === this.workspace) {
      await this.mirrorApi.applyLocalSave(p, file.text, file.encoding, file.newline).catch((err) => {
        log("warn", `镜像本地副本写入失败：${String(err)}`);
      });
    }
    return file;
  }

  async saveFile(p: string, text: string, opts?: { encoding?: "utf8" | "utf8-bom"; newline?: "lf" | "crlf" }): Promise<Fingerprint> {
    const fp = await this.requireFs().saveFile(p, text, opts);
    // 保存后：镜像同步写本地（0 远端）+ 快照本地更新（0 条 git），见 D3.3
    if (this.mirrorApi && this.mirrorApi.workspaceRoot === this.workspace) {
      await this.mirrorApi.applyLocalSave(p, text, opts?.encoding ?? "utf8", opts?.newline ?? "lf").catch((err) => {
        log("warn", `镜像本地副本写入失败：${String(err)}`);
      });
    }
    const tree = this.gitApi?.treeFor(this.workspace);
    tree?.markSaved(p, false);
    return fp;
  }

  async create(p: string, isDir: boolean): Promise<void> {
    const fsApi = this.requireFs();
    if (isDir) await fsApi.createDir(p);
    else await fsApi.createFile(p);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.requireFs().rename(from, to);
  }

  async remove(p: string): Promise<void> {
    await this.requireFs().remove(p);
    this.gitApi?.treeFor(this.workspace)?.markRemoved(p);
  }

  /** 全局搜索（M5 面板用；打开面板本身不发请求，回车才调） */
  async search(pattern: string, opts: { caseSensitive: boolean; regex: boolean }): Promise<SearchMatch[]> {
    if (!this.searchApi) throw new AppError("ssh", "未连接主机");
    return this.searchApi.search(this.workspace, pattern, opts);
  }

  async treeStatus(directory?: string): Promise<GitTreeStatus> {
    return this.requireGit().treeStatus(directory ?? this.workspace);
  }

  // ---- M5：SCM（暂存 / 提交 / 分支 / 提交图）+ 仓库管理 ----

  async fileDiff(relPath: string, content?: string): Promise<GitDiff> {
    const git = this.requireGit();
    const status = git.treeFor(this.workspace)?.toSnapshot();
    const abs = relPath.startsWith("/") ? relPath : `${this.workspace.replace(/\/+$/, "")}/${relPath}`;
    const st = status?.files[abs];
    return git.fileDiff(this.workspace, relPath, content, st);
  }

  async gitCommit(message: string, opts?: { amend?: boolean; push?: boolean; sync?: boolean; all?: boolean }): Promise<string> {
    const git = this.requireGit();
    const out = opts?.all
      ? await git.commitAll(this.workspace, message, { amend: opts?.amend })
      : await git.commitStaged(this.workspace, message, { amend: opts?.amend });
    if (opts?.push || opts?.sync) await git.push(this.workspace).catch(() => { /* 已在上游 */ });
    return out;
  }

  async gitBranches(): Promise<BranchInfo[]> {
    return this.requireGit().branches(this.workspace);
  }

  async gitSwitchBranch(name: string): Promise<string> {
    const out = await this.requireGit().switchBranch(this.workspace, name);
    await this.treeStatus().catch(() => { /* 刷新失败下次再说 */ });
    return out;
  }

  async gitLogGraph(limit = 200): Promise<GraphRow[]> {
    return this.requireGit().logGraph(this.workspace, limit);
  }

  /** 暂存 / 取消暂存（逐文件）+ 本地快照更新，返回新快照 */
  async gitSetStaged(paths: string[], staged: boolean): Promise<GitTreeStatus> {
    const git = this.requireGit();
    if (staged) await git.stage(this.workspace, paths);
    else await git.unstage(this.workspace, paths);
    return git.treeStatus(this.workspace);
  }

  async gitSetStagedAll(staged: boolean): Promise<GitTreeStatus> {
    const git = this.requireGit();
    if (staged) await git.stageAll(this.workspace);
    else await git.unstageAll(this.workspace);
    return git.treeStatus(this.workspace);
  }

  /** 丢弃修改：跟踪文件走 restore，未跟踪文件走 clean（UI 必须二次确认） */
  async gitDiscard(paths: string[], untracked: boolean): Promise<GitTreeStatus> {
    const git = this.requireGit();
    if (untracked) await git.clean(this.workspace, paths);
    else await git.discard(this.workspace, paths);
    return git.treeStatus(this.workspace);
  }

  async gitStashList(): Promise<Array<{ index: number; message: string; date: string }>> {
    return this.requireGit().stashList(this.workspace);
  }

  async gitStashSave(message: string): Promise<void> {
    await this.requireGit().stashSave(this.workspace, message);
  }

  async gitStashPop(index?: number): Promise<void> {
    await this.requireGit().stashPop(this.workspace, index);
  }

  async gitStashDrop(index: number): Promise<void> {
    await this.requireGit().stashDrop(this.workspace, index);
  }

  async gitTags(): Promise<Array<{ name: string; hash: string; message: string; date: string }>> {
    return this.requireGit().tags(this.workspace);
  }

  async gitCreateTag(name: string, message: string): Promise<void> {
    await this.requireGit().createTag(this.workspace, name, message);
  }

  async gitDeleteTag(name: string): Promise<void> {
    await this.requireGit().deleteTag(this.workspace, name);
  }

  async gitCreateBranch(name: string, opts?: { checkout?: boolean }): Promise<void> {
    await this.requireGit().createBranch(this.workspace, name, opts);
  }

  async gitDeleteBranch(name: string): Promise<void> {
    await this.requireGit().deleteBranch(this.workspace, name);
  }

  async gitMergeBranch(name: string): Promise<string> {
    return this.requireGit().mergeBranch(this.workspace, name);
  }

  async gitRemotes(): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
    return this.requireGit().remotes(this.workspace);
  }

  async gitAddRemote(name: string, url: string): Promise<void> {
    await this.requireGit().addRemote(this.workspace, name, url);
  }

  async gitRemoveRemote(name: string): Promise<void> {
    await this.requireGit().removeRemote(this.workspace, name);
  }

  async gitSetRemoteUrl(name: string, url: string): Promise<void> {
    await this.requireGit().setRemoteUrl(this.workspace, name, url);
  }

  async gitFetch(): Promise<string> {
    return this.requireGit().fetch(this.workspace);
  }

  async gitClone(url: string, targetDir: string): Promise<string> {
    return this.requireGit().clone(url, targetDir);
  }

  async gitInit(directory: string): Promise<string> {
    const out = await this.requireGit().init(directory);
    await this.treeStatus(directory).catch(() => { /* 初始化后可能还没提交 */ });
    return out;
  }

  private mirrorRootFor(host: HostConfig, workspace: string): string {
    const hash = sha1Hex(workspace).slice(0, 12);
    return path.join(this.deps.userData, "mirror", host.id, hash);
  }

  private requireFs(): RemoteFs {
    if (!this.fsApi) throw new AppError("ssh", "未连接主机");
    return this.fsApi;
  }

  private requireGit(): GitRemote {
    if (!this.gitApi) throw new AppError("ssh", "未连接主机");
    return this.gitApi;
  }

  private requireMirror(): MirrorManager {
    if (!this.mirrorApi) throw new AppError("ssh", "未连接主机");
    if (this.mirrorApi.workspaceRoot !== this.workspace) {
      this.mirrorApi = new MirrorManager(this.conn as SSHConnection, this.mirrorRootFor(this.host as HostConfig, this.workspace));
    }
    return this.mirrorApi;
  }
}

/** 规格未覆盖：镜像目录用 sha1(workspace)[0..12]（分册 3 D1.5） */
function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}
