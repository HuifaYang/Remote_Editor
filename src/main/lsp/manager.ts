// 语言服务生命周期（总纲 §5.5）：clangd / pylsp **在工作机上跑**，指向本地镜像；
// 「板子上」模式是 §0 第 4 条的唯一例外（只按需拉起用户自己装好的服务，连接断即退出）。
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../../shared/errors.js";
import type { LspDiagnosticEvent, LspTransportMode } from "../../shared/types.js";
import { log } from "../log.js";
import type { MirrorManager } from "../mirror/manager.js";
import type { SSHConnection } from "../session/connection.js";
import { LspClient, type LspTransport } from "./client.js";

export type LspLanguage = "cpp" | "python";

/** §5.5.1：clangd 参数固定，别加戏 */
export const CLANGD_ARGS = ["--background-index", "--completion-style=detailed", "--header-insertion=never", "--malloc-trim", "-j=2"];

export interface LspManagerDeps {
  /** 设置项 settings.lspTransport，默认本机 */
  transportMode?: (language: LspLanguage) => LspTransportMode;
  /** 板子上模式要用连接；未连接时抛错 */
  connection?: () => SSHConnection | null;
  /** 内置 clangd 目录（开发期 = 仓库 resources，打包后 = process.resourcesPath） */
  resourcesDir?: () => string | null;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  existsFn?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  /** 设置项：C++ / Python 服务器路径（U9；默认值由调用方传入） */
  serverPaths?: () => ({ cpp: string; python: string });
}

interface Started {
  client: LspClient;
  mode: LspTransportMode;
  root: string;
}

export class LspManager {
  private readonly started = new Map<LspLanguage, Started>();
  private readonly diagnosticsListeners = new Set<(e: LspDiagnosticEvent) => void>();

  constructor(
    private readonly mirror: MirrorManager,
    private readonly userData: string,
    private readonly deps: LspManagerDeps = {},
  ) {}

  /** 惰性启动（§5.5 签名）；同一个语言复用同一份客户端，模式或根变了就重启 */
  async ensure(language: LspLanguage, workspaceRoot?: string): Promise<LspClient> {
    const mode = this.deps.transportMode?.(language) ?? "local";
    if (mode === "disabled") {
      await this.disposeOne(language);
      throw new AppError("lsp", "语言服务已关闭");
    }
    const root = mode === "remote" ? workspaceRoot ?? this.mirror.root : this.mirror.root;
    const existing = this.started.get(language);
    if (existing && existing.client.alive && existing.mode === mode && existing.root === root) {
      return existing.client;
    }
    if (existing) await this.disposeOne(language);

    const transport = mode === "remote"
      ? await this.startRemote(language, root)
      : await this.startLocal(language, root);
    const client = new LspClient(transport, {
      rootUri: toUri(root),
      clientName: "RemoteCodeEditor",
      diagnostics: (e) => { for (const cb of this.diagnosticsListeners) cb(e); },
    });
    await client.start();
    this.started.set(language, { client, mode, root });
    log("info", `语言服务已启动：${language}（${mode}，root=${root}）`);
    return client;
  }

  /** 诊断订阅（publishDiagnostics → 渲染进程 setModelMarkers） */
  diagnostics(cb: (e: LspDiagnosticEvent) => void): () => void {
    this.diagnosticsListeners.add(cb);
    return () => { this.diagnosticsListeners.delete(cb); };
  }

  /** 断开连接 / 退出应用时调用；SIGTERM → 2 秒后 SIGKILL */
  async stopAll(): Promise<void> {
    for (const language of [...this.started.keys()]) await this.disposeOne(language);
  }

  private async disposeOne(language: LspLanguage): Promise<void> {
    const started = this.started.get(language);
    if (!started) return;
    this.started.delete(language);
    try {
      await started.client.dispose();
    } catch (err) {
      log("warn", `关闭语言服务失败：${String(err)}`);
    }
  }

  // ---- 本机模式（默认）----

  private async startLocal(language: LspLanguage, root: string): Promise<LspTransport> {
    if (language === "cpp") {
      const configured = this.deps.serverPaths?.().cpp ?? "";
      const exe = configured ? configured : this.clangdExecutable();
      const args = [...CLANGD_ARGS, `--target=${this.mirror.targetTriplet}`];
      const child = await this.spawnLocal(exe, args, {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      log("info", `clangd 启动：${exe} ${args.join(" ")}`);
      return localTransport(child);
    }
    const configuredPython = this.deps.serverPaths?.().python ?? "";
    const exe = configuredPython ? configuredPython.split(/\s+/)[0] ?? "python3" : this.deps.platform === "win32" || process.platform === "win32" ? "py" : "python3";
    const pyArgs = configuredPython ? configuredPython.split(/\s+/).slice(1) : ["-m", "pylsp"];
    const pyenv = path.join(root, "_pyenv");
    fs.mkdirSync(path.join(this.userData, "lsp"), { recursive: true });   // 预留语言服务日志目录
    const env = { ...process.env, PYTHONPATH: fs.existsSync(pyenv) ? pyenv : process.env.PYTHONPATH };
    const child = await this.spawnLocal(exe, pyArgs, {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    log("info", `pylsp 启动：${exe} ${pyArgs.join(" ")}（PYTHONPATH=${env.PYTHONPATH ?? ""}）`);
    return localTransport(child);
  }

  private spawnLocal(cmd: string, args: string[], opts: SpawnOptions): Promise<ChildProcess> {
    const spawnFn = this.deps.spawnFn ?? spawn;
    return new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnFn(cmd, args, opts);
      } catch (err) {
        reject(this.startError(cmd, err));
        return;
      }
      let settled = false;
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        reject(this.startError(cmd, err));
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        resolve(child);
      });
    });
  }

  private startError(cmd: string, err: unknown): AppError {
    const hint = cmd.includes("clangd")
      ? "clangd 未找到：请把内置二进制放到 resources/clangd/<平台>/，或安装到 PATH"
      : "pylsp 未安装：pip install python-lsp-server";
    return new AppError("lsp", `语言服务启动失败：${cmd}`, `${hint}（${String(err)}）`);
  }

  /** 启动顺序 = 内置 clangd → PATH 里的 clangd（§5.5 第 0 条） */
  clangdExecutable(): string {
    const exists = this.deps.existsFn ?? fs.existsSync;
    for (const candidate of this.clangdCandidates()) {
      if (exists(candidate)) return candidate;
    }
    return "clangd";
  }

  /** 内置 clangd 候选路径：打包（extraResources 拍平）与开发期（按平台子目录）两种布局 */
  clangdCandidates(): string[] {
    const platform = this.deps.platform ?? process.platform;
    const name = platform === "win32" ? "clangd.exe" : "clangd";
    const out: string[] = [];
    const explicit = this.deps.resourcesDir?.();
    if (explicit) out.push(path.join(explicit, "clangd", name));
    const platformDir = platform === "win32" ? "win" : platform === "darwin" ? "mac" : "linux";
    out.push(path.join(__dirname, "..", "..", "..", "..", "resources", "clangd", platformDir, name));
    const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) out.push(path.join(resourcesPath, "clangd", name));
    return out;
  }

  // ---- 板子上模式（唯一例外）----

  private async startRemote(language: LspLanguage, remoteRoot: string): Promise<LspTransport> {
    const conn = this.deps.connection?.() ?? null;
    if (!conn) throw new AppError("lsp", "未连接主机，无法在板子上启动语言服务");
    const command = language === "cpp"
      ? `clangd ${CLANGD_ARGS.join(" ")} --target=${this.mirror.targetTriplet}`
      : "python3 -m pylsp";
    const handle = await conn.execStream(command, { cwd: remoteRoot, timeoutMs: 0 });
    log("info", `板子上启动语言服务：${command}（cwd=${remoteRoot}）`);
    return remoteTransport(handle);
  }
}

/** 本机子进程传输 */
export function localTransport(child: ChildProcess): LspTransport {
  const exited: Array<(code?: number) => void> = [];
  child.once("exit", (code) => { for (const cb of exited) cb(code ?? undefined); });
  return {
    send: (data) => { child.stdin?.write(data); },
    onData: (cb) => { child.stdout?.on("data", cb); },
    onExit: (cb) => { exited.push(cb); },
    kill: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    }),
  };
}

/** SSH exec 流传输（板子上模式） */
export function remoteTransport(handle: {
  stdout: NodeJS.ReadWriteStream;
  close(): void;
}): LspTransport {
  const dataCbs: Array<(chunk: Buffer) => void> = [];
  const exitCbs: Array<() => void> = [];
  handle.stdout.on("data", (chunk: Buffer) => { for (const cb of dataCbs) cb(chunk); });
  handle.stdout.on("close", () => { for (const cb of exitCbs) cb(); });
  return {
    send: (data) => { handle.stdout.write(data); },
    onData: (cb) => { dataCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    kill: () => {
      try { handle.close(); } catch { /* 已关闭 */ }
      return Promise.resolve();
    },
  };
}

function toUri(p: string): string {
  if (p.startsWith("file://")) return p;
  const normalized = p.startsWith("/") ? p : "/" + p.replace(/\\/g, "/");
  return "file://" + normalized.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}
