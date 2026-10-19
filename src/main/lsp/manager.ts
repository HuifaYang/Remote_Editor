// 语言服务生命周期：remote 模式通过 SSH exec 按需拉起远端标准 LSP；
// local 模式保留为离线兼容路径，指向本地源码镜像。
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../../shared/errors.js";
import type { LspDiagnosticEvent, LspTransportMode } from "../../shared/types.js";
import { log } from "../log.js";
import type { MirrorManager } from "../mirror/manager.js";
import type { SSHConnection } from "../session/connection.js";
import { LspClient, type LspTransport } from "./client.js";
import { DEFAULT_CLANGD_ARGS, type LanguageServerDefinition } from "./server-config.js";

/** 语言服务实例的稳定 ID。默认是 cpp/python，用户配置的任意 LSP 也可以是 go/rust/... */
export type LspLanguage = string;

export const CLANGD_ARGS = DEFAULT_CLANGD_ARGS;

/** 从扩展配置传入的启动描述；远端只按需执行，不部署任何常驻组件。 */
export type LspLaunchConfig = Pick<LanguageServerDefinition,
  "id" | "command" | "args" | "env" | "initializationOptions">;

export interface LspManagerDeps {
  /** 设置项 settings.lspTransport，默认远端 */
  transportMode?: (language: LspLanguage) => LspTransportMode;
  /** remote 模式要用连接；未连接时抛错 */
  connection?: () => SSHConnection | null;
  /** 内置 clangd 目录（开发期 = 仓库 resources，打包后 = process.resourcesPath） */
  resourcesDir?: () => string | null;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  existsFn?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  /** 设置项：C++ / Python 服务器路径（U9；默认值由调用方传入） */
  serverPaths?: () => ({ cpp: string; python: string });
  /** 输出面板 LSP 日志通道（ui-parity S07）：启动/停止/失败等生命周期事件 */
  onLog?: (line: string) => void;
  /** mount 模式下 cwd 是只读 SSHFS，禁止向项目目录写 .clangd。 */
  writeClangdConfig?: boolean;
}

interface Started {
  client: LspClient;
  mode: LspTransportMode;
  root: string;
  cwd: string;
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
  /** 启动单飞：同一语言的并发 ensure 共享同一个 promise（以前每个请求各 spawn 一个 clangd） */
  private starting = new Map<LspLanguage, Promise<LspClient>>();

  async ensure(language: LspLanguage, workspaceRoot?: string, launch?: LspLaunchConfig, cwdOverride?: string): Promise<LspClient> {
    const mode = this.deps.transportMode?.(language) ?? "local";
    if (mode === "disabled") {
      await this.disposeOne(language);
      throw new AppError("lsp", "语言服务已关闭");
    }
    const root = mode === "remote" || mode === "mount"
      ? workspaceRoot ?? this.mirror.root
      : this.mirror.root;
    const cwd = cwdOverride ?? root;
    const existing = this.started.get(language);
    if (existing && existing.client.alive && existing.mode === mode && existing.root === root && existing.cwd === cwd) {
      return existing.client;
    }
    const inflight = this.starting.get(language);
    if (inflight) return inflight;
    const task = (async () => {
      if (existing) await this.disposeOne(language);
      const transport = mode === "remote"
        ? await this.startRemote(language, root, launch)
        : await this.startLocal(language, root, launch, cwd);
      const client = new LspClient(transport, {
        rootUri: toUri(root),
        clientName: "RemoteCodeEditor",
        initializationOptions: launch?.initializationOptions,
        diagnostics: (e) => { for (const cb of this.diagnosticsListeners) cb(e); },
        onLog: (line) => this.emitLog(`[${language}] ${line}`),
      });
      await client.start();
      this.started.set(language, { client, mode, root, cwd });
      this.emitLog(`语言服务已启动：${language}（${mode}，root=${root}，cwd=${cwd}）`);
      return client;
    })().finally(() => { this.starting.delete(language); });
    this.starting.set(language, task);
    return task;
  }

  /** 双写：主进程日志文件 + 输出面板 LSP 通道（ui-parity S07） */
  private emitLog(message: string): void {
    log("info", message);
    this.deps.onLog?.(message);
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
      this.emitLog(`关闭语言服务失败：${String(err)}`);
    }
  }

  // ---- 本机模式（默认）----

  private async startLocal(language: LspLanguage, root: string, launch?: LspLaunchConfig, cwd = root): Promise<LspTransport> {
    if (language === "cpp") {
      const configured = this.deps.serverPaths?.().cpp ?? "";
      const exe = configured ? configured : this.clangdExecutable();
      // 注意：--target 是 **编译器** 参数，不是 clangd 命令行参数——clangd 18 收到会直接
      // 「Unknown command line argument」退出（已在本机复现）。交叉编译目标改由镜像根的
      // .clangd 配置注入（CompileFlags.Add），见 writeClangdTargetConfig。
      const args = launch?.args?.length ? [...launch.args] : [...CLANGD_ARGS];
      this.assertExecutable(exe, cwd);
      if (this.deps.writeClangdConfig !== false) this.writeClangdTargetConfig(root);
      const child = await this.spawnLocal(exe, args, {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.emitLog(`clangd 启动：${exe} ${args.join(" ")}`);
      return localTransport(child, (line) => this.emitLog(`[clangd] ${line}`));
    }
    if (language !== "python" && launch?.command) {
      this.assertExecutable(launch.command, cwd);
      const child = await this.spawnLocal(launch.command, [...launch.args], {
        cwd,
        env: { ...process.env, ...launch.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.emitLog(`${language} 语言服务启动：${launch.command} ${launch.args.join(" ")}`);
      return localTransport(child, (line) => this.emitLog(`[${language}] ${line}`));
    }
    const configuredPython = this.deps.serverPaths?.().python ?? "";
    const exe = configuredPython ? configuredPython.split(/\s+/)[0] ?? "python3" : this.deps.platform === "win32" || process.platform === "win32" ? "py" : "python3";
    const pyArgs = configuredPython ? configuredPython.split(/\s+/).slice(1) : ["-m", "pylsp"];
    const pyenv = path.join(root, "_pyenv");
    const bundledPython = this.bundledPythonPath();
    fs.mkdirSync(path.join(this.userData, "lsp"), { recursive: true });   // 预留语言服务日志目录
    const pythonPaths = [
      fs.existsSync(pyenv) ? pyenv : null,
      bundledPython,
      process.env.PYTHONPATH || null,
    ].filter((item): item is string => !!item);
    const env = { ...process.env, PYTHONPATH: pythonPaths.join(path.delimiter) };
    this.assertExecutable(exe, cwd);
    const child = await this.spawnLocal(exe, pyArgs, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.emitLog(`pylsp 启动：${exe} ${pyArgs.join(" ")}（内置=${bundledPython ?? "否"}）`);
    return localTransport(child, (line) => this.emitLog(`[pylsp] ${line}`));
  }

  /** 打包后语言服务资源在扩展 resources/python-lsp；开发期从 dist 向上也能找到仓库同名目录。 */
  private bundledPythonPath(): string | null {
    let base = __dirname;
    for (let i = 0; i < 7; i++) {
      const candidate = path.join(base, "resources", "python-lsp");
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(base);
      if (parent === base) break;
      base = parent;
    }
    return null;
  }

  private spawnLocal(cmd: string, args: string[], opts: SpawnOptions): Promise<ChildProcess> {
    const spawnFn = this.deps.spawnFn ?? spawn;
    return new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnFn(cmd, args, opts);
      } catch (err) {
        reject(this.startError(cmd, err, String(opts.cwd ?? "")));
        return;
      }
      let settled = false;
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        reject(this.startError(cmd, err, String(opts.cwd ?? "")));
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        resolve(child);
      });
    });
  }

  private assertExecutable(exe: string, cwd: string): void {
    // 测试会注入 spawnFn 和虚拟路径，不触碰真实文件系统；生产路径必须做启动前检查。
    if (this.deps.spawnFn) return;
    if (exe.includes(path.sep)) {
      try {
        fs.accessSync(exe, fs.constants.X_OK);
      } catch (err) {
        throw new AppError("lsp", `语言服务不可执行：${exe}`, String(err));
      }
    }
    try {
      fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
    } catch (err) {
      throw new AppError("lsp", `语言服务工作目录不可访问：${cwd}`, String(err));
    }
  }

  private startError(cmd: string, err: unknown, cwd = ""): AppError {
    const hint = cmd.includes("clangd")
      ? "clangd 未找到：请把内置二进制放到 resources/clangd/<平台>/，或安装到 PATH"
      : "pylsp 未安装：pip install python-lsp-server";
    // 真实错误进 message：以前只留「启动失败：clangd」，ENOENT/EACCES 这类关键信息全丢了
    return new AppError("lsp", `语言服务启动失败：${cmd}（cwd=${cwd || "?"}，${String(err)}）`, hint);
  }

  /** 交叉编译目标注入：clangd 命令行**不接受** --target（实测 clangd 18 直接退出），
   *  正确姿势是镜像根的 .clangd 配置 CompileFlags.Add。只在没有用户自定义 .clangd 时写
   *  （带生成标记；已有则尊重用户的，不覆盖）。 */
  private writeClangdTargetConfig(root: string): void {
    const file = path.join(root, ".clangd");
    const marker = "# generated by weavecode";
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      /* 不存在才写 */
    }
    if (content && !content.includes(marker)) return;   // 用户自己的配置，不动
    const body = [
      marker,
      "CompileFlags:",
      `  Add: [--target=${this.mirror.targetTriplet}]`,
      "",
    ].join("\n");
    if (content === body) return;                        // 内容一致不重写（避免 mtime 抖动）
    try {
      fs.writeFileSync(file, body, "utf8");
      this.emitLog(`已写入 ${file}（--target=${this.mirror.targetTriplet}，经 CompileFlags 注入）`);
    } catch (err) {
      this.emitLog(`写 .clangd 失败：${String(err)}`);
    }
  }

  /** 启动顺序 = 内置 clangd → PATH 里的 clangd（§5.5 第 0 条） */
  clangdExecutable(): string {
    const exists = this.deps.existsFn ?? fs.existsSync;
    for (const candidate of this.clangdCandidates()) {
      if (exists(candidate)) return candidate;
    }
    return "clangd";
  }

  /** 内置 clangd 候选路径。
   *  打包布局：扩展 bundle 在 <扩展>/out/extension.js，clangd 在 <扩展>/resources/clangd/<平台>/ ——
   *  从 __dirname 上 1 级就到；开发布局层级更深。布局不能写死（曾写死 4 级，打包后解析到
   *  /usr/share/weavecode/resources/resources/... 这种不存在的路径，导致所有机器上 C++ 语言服务失效），
   *  所以从 __dirname 逐级向上探测，第一个存在的命中。 */
  clangdCandidates(): string[] {
    const platform = this.deps.platform ?? process.platform;
    const name = platform === "win32" ? "clangd.exe" : "clangd";
    const out: string[] = [];
    const explicit = this.deps.resourcesDir?.();
    if (explicit) out.push(path.join(explicit, "clangd", name));
    const platformDir = platform === "win32" ? "win" : platform === "darwin" ? "mac" : "linux";
    let base = __dirname;
    for (let i = 0; i < 7; i++) {
      out.push(path.join(base, "resources", "clangd", platformDir, name));
      const parent = path.dirname(base);
      if (parent === base) break;
      base = parent;
    }
    const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) out.push(path.join(resourcesPath, "clangd", name));
    return out;
  }

  // ---- 远端标准 LSP 模式（默认）----

  private async startRemote(language: LspLanguage, remoteRoot: string, launch?: LspLaunchConfig): Promise<LspTransport> {
    const conn = this.deps.connection?.() ?? null;
    if (!conn) throw new AppError("lsp", "未连接主机，无法启动远端语言服务");
    const spec: LspLaunchConfig = launch ?? (language === "cpp"
      ? { id: "cpp", command: "clangd", args: [...CLANGD_ARGS], env: {} }
      : { id: "python", command: "python3", args: ["-m", "pylsp"], env: {} });
    await this.checkRemoteExecutable(conn, spec.command);
    const command = buildRemoteCommand(spec);
    const handle = await conn.execStream(command, { cwd: remoteRoot, timeoutMs: 0 });
    this.emitLog(`远端启动语言服务：${command}（cwd=${remoteRoot}）`);
    return remoteTransport(handle, (line) => this.emitLog(`[${language}] ${line}`));
  }

  /** 启动前给出「未安装」的明确错误，而不是等 JSON-RPC 初始化超时。 */
  private async checkRemoteExecutable(conn: SSHConnection, command: string): Promise<void> {
    if (typeof conn.exec !== "function") return;
    const probe = command.includes("/")
      ? `test -x ${shellQuote(command)}`
      : `command -v ${shellQuote(command)} >/dev/null 2>&1`;
    const result = await conn.exec(probe, { timeoutMs: 8000 });
    if (result.code !== 0) {
      throw new AppError("lsp", `远端未找到语言服务器：${command}`, "请确认命令已安装并在 SSH 非交互 PATH 中可访问");
    }
  }
}

/** 本机子进程传输 */
export function localTransport(child: ChildProcess, onStderr?: (line: string) => void): LspTransport {
  const exited: Array<(code?: number) => void> = [];
  // 子进程的 stderr 以前直接丢弃：clangd 一死只剩「语言服务已退出」，死因全靠猜。
  // 现在逐行回传给调用方进日志（启动失败的第一现场就在这里）。
  let errBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errBuf += chunk.toString();
    let idx;
    while ((idx = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, idx).trim();
      errBuf = errBuf.slice(idx + 1);
      if (line) onStderr?.(line);
    }
  });
  child.once("exit", (code) => {
    const rest = errBuf.trim();
    if (rest) onStderr?.(rest);
    for (const cb of exited) cb(code ?? undefined);
  });
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

/** SSH exec 双向流传输（远端标准 LSP） */
export function remoteTransport(handle: {
  stdout: NodeJS.ReadWriteStream;
  stderr?: NodeJS.ReadableStream;
  close(): void;
}, onStderr?: (line: string) => void): LspTransport {
  const dataCbs: Array<(chunk: Buffer) => void> = [];
  const exitCbs: Array<() => void> = [];
  handle.stdout.on("data", (chunk: Buffer) => { for (const cb of dataCbs) cb(chunk); });
  handle.stdout.on("close", () => { for (const cb of exitCbs) cb(); });
  let errBuf = "";
  handle.stderr?.on("data", (chunk: Buffer) => {
    errBuf += chunk.toString();
    let idx;
    while ((idx = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, idx).trim();
      errBuf = errBuf.slice(idx + 1);
      if (line) onStderr?.(line);
    }
  });
  handle.stderr?.on("close", () => {
    const line = errBuf.trim();
    if (line) onStderr?.(line);
  });
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

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/** env 前缀 + 可执行文件 + 参数，全部按 shell token 安全引用。 */
export function buildRemoteCommand(spec: LspLaunchConfig): string {
  const env = Object.entries(spec.env ?? {})
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return [...env, shellQuote(spec.command), ...spec.args.map(shellQuote)].join(" ");
}

function toUri(p: string): string {
  if (p.startsWith("file://")) return p;
  const normalized = p.startsWith("/") ? p : "/" + p.replace(/\\/g, "/");
  return "file://" + normalized.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}
