// SSH 连接管理（总纲 §5.1）：一条可复用连接，认证顺序是事故高发区，注释不得删
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AppError, toAppError } from "../../shared/errors.js";
import { shellQuote } from "../../shared/paths.js";

export interface ConnectionOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  timeoutMs: number;             // 默认 15000
  keepaliveMs: number;           // 默认 30000，0 = 关闭
  strictHostKey: boolean;        // 默认 false（首次自动接受并记 known_hosts）
  knownHostsPath?: string;       // 默认 userData/known_hosts
  /** 规格未覆盖：测试注入用，默认 ~/.ssh；生产代码不要传 */
  sshDir?: string;
}

export interface ExecStreamHandle {
  /** SSH 通道的 stdout 读端（同时可写，作为远端进程 stdin） */
  stdout: ClientChannel;
  /** 等远端进程退出（close 之后才会 resolve） */
  wait(): Promise<{ code: number; stderr: string }>;
  close(): void;
}

export interface ShellChannel {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** 默认名私钥（§5.1：自定义名如 id_ed25519_github 不参与自动尝试） */
const DEFAULT_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

/** 列出本机默认名私钥（按优先级排序，只认文件） */
export function listDefaultKeys(sshDir = path.join(os.homedir(), ".ssh")): string[] {
  const out: string[] = [];
  for (const name of DEFAULT_KEY_NAMES) {
    const p = path.join(sshDir, name);
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      // 不存在/不可读 → 跳过
    }
  }
  return out;
}

/** ssh2 异常 → AppError 归类（§5.1.2：认证类失败必须归类 auth，禁止留死胡同） */
export function classifyConnectError(err: unknown): AppError {
  const msg = err instanceof Error ? err.message : String(err);
  const level = (err as { level?: string } | null)?.level;
  if (/Encrypted private (OpenSSH )?key detected|no passphrase given/i.test(msg)) {
    return new AppError("auth-passphrase-required", "该私钥有口令", msg);
  }
  if (/All configured authentication methods failed|No supported authentication methods available|Authentication failure/i.test(msg)) {
    return new AppError("auth", "认证失败", msg);
  }
  if (level === "client-timeout" || /timed out|timeout/i.test(msg)) {
    return new AppError("timeout", "连接超时", msg);
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(msg)) {
    return new AppError("network", "网络不可达", msg);
  }
  if (/host key|verification failed/i.test(msg)) {
    return new AppError("host-key", "主机公钥校验失败", msg);
  }
  return new AppError("ssh", "SSH 错误", msg);
}

export class SSHConnection {
  private client: Client | null = null;
  private sftpInstance: SFTPWrapper | null = null;
  /** SFTP 串行队列（§5.1.5：ssh2 的 SFTP 不是并发安全） */
  private sftpQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ConnectionOptions) {}

  get connected(): boolean {
    return this.client !== null;
  }

  /** 认证顺序（§5.1.1）：显式私钥 → 上层给的密码 → 默认名私钥逐个试 → 抛 auth 要密码 */
  async connect(): Promise<void> {
    const { privateKeyPath, password } = this.options;
    if (privateKeyPath) {
      await this.tryConnect({ privateKey: fs.readFileSync(privateKeyPath), passphrase: this.options.passphrase });
      return;
    }
    if (password !== undefined) {
      await this.tryConnect({ password });
      return;
    }
    const keys = listDefaultKeys(this.options.sshDir);
    if (keys.length === 0) {
      throw new AppError("auth", "认证失败：本机没有默认名私钥，需要输入密码");
    }
    let lastErr: AppError | null = null;
    for (const keyPath of keys) {
      try {
        await this.tryConnect({ privateKey: fs.readFileSync(keyPath), passphrase: this.options.passphrase });
        return;
      } catch (err) {
        const e = toAppError(err);
        if (e.code !== "auth") throw e;   // 口令缺失/超时/网络问题直接上抛，不换下一把钥匙
        lastErr = e;
      }
    }
    throw lastErr ?? new AppError("auth", "认证失败");
  }

  private tryConnect(auth: { password?: string; privateKey?: Buffer; passphrase?: string }): Promise<void> {
    const o = this.options;
    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) {
          client.end();
          reject(classifyConnectError(err));
        } else {
          this.client = client;
          resolve();
        }
      };
      client.once("ready", () => done());
      client.once("error", (err) => done(err));
      client.on("close", () => {
        if (!settled) done(new Error("connection closed before ready"));
        if (this.client === client) {
          this.client = null;
          this.sftpInstance = null;
        }
      });
      client.connect({
        host: o.host,
        port: o.port,
        username: o.username,
        ...auth,
        readyTimeout: o.timeoutMs,
        keepaliveInterval: o.keepaliveMs,
        keepaliveCountMax: 3,
        // §5.1.1：禁止调用 ssh-agent —— 不设置 agent 字段即恒不使用（ssh2 类型不允许显式 false）
        tryKeyboard: false,
        hostHash: "sha256",
        hostVerifier: (hashedKey: string) => this.verifyHostKey(hashedKey),
      });
    });
  }

  /** known_hosts：strict=false 首次自动接受并记录；strict=true 必须命中记录（D1.3） */
  private verifyHostKey(hashedKey: string): boolean {
    const file = this.options.knownHostsPath;
    const line = `${this.options.host}:${this.options.port} sha256 ${hashedKey}`;
    let known = "";
    if (file) {
      try { known = fs.readFileSync(file, "utf8"); } catch { /* 首次 */ }
    }
    const hit = known.split("\n").some((l) => l.trim() === line);
    if (hit) return true;
    if (this.options.strictHostKey) return false;   // ssh2 会抛 verification failed → 归类 host-key
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line + "\n", "utf8");
      } catch {
        // 记录失败不阻断连接
      }
    }
    return true;
  }

  /** 懒创建并复用 SFTP 实例 */
  sftp(): Promise<SFTPWrapper> {
    if (this.sftpInstance) return Promise.resolve(this.sftpInstance);
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new AppError("ssh", "未连接"));
        return;
      }
      this.client.sftp((err, sftp) => {
        if (err) reject(toAppError(err, "sftp"));
        else {
          this.sftpInstance = sftp;
          sftp.on("close", () => { this.sftpInstance = null; });
          resolve(sftp);
        }
      });
    });
  }

  /** 所有 SFTP 操作的唯一入口：经内部队列串行化（§5.1.5） */
  sftpRun<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const run = this.sftpQueue.then(() => this.sftp().then(fn));
    this.sftpQueue = run.catch(() => { /* 队列不断链 */ });
    return run;
  }

  /** 执行远端命令；退出码非 0 不算异常（grep 退出码 1 = 无匹配，由调用方判断） */
  exec(command: string, opts?: { timeoutMs?: number; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    const cmd = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command;
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new AppError("ssh", "未连接"));
        return;
      }
      this.client.exec(cmd, (err, stream) => {
        if (err) {
          reject(toAppError(err, "ssh"));
          return;
        }
        let stdout = "";
        let stderr = "";
        let timer: NodeJS.Timeout | undefined;
        if (opts?.timeoutMs) {
          timer = setTimeout(() => {
            stream.close();
            reject(new AppError("timeout", "命令执行超时", cmd));
          }, opts.timeoutMs);
        }
        stream.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
        stream.on("close", (code: number | null) => {
          if (timer) clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr });
        });
      });
    });
  }

  /**
   * 流式执行（§13 坑 4：镜像同步要边收边写，禁止全量缓冲）。
   * stdout 交给调用方 pipeline；stderr 累积成文本（镜像同步拿它传文件清单）。
   */
  execStream(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecStreamHandle> {
    const cmd = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command;
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new AppError("ssh", "未连接"));
        return;
      }
      this.client.exec(cmd, (err, stream) => {
        if (err) {
          reject(toAppError(err, "ssh"));
          return;
        }
        let stderr = "";
        // 竞态：短命命令可能在调用 wait() 之前就 close 了，所以结果要缓存下来
        let exitResult: { code: number; stderr: string } | null = null;
        let settle: ((v: { code: number; stderr: string }) => void) | null = null;
        let timer: NodeJS.Timeout | undefined;
        if (opts?.timeoutMs) {
          timer = setTimeout(() => {
            stream.close();
            stderr += "\n命令执行超时";
          }, opts.timeoutMs);
        }
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
        stream.on("error", (e: Error) => { stderr += String(e); });
        stream.on("close", (code: number | null) => {
          if (timer) clearTimeout(timer);
          exitResult = { code: code ?? 0, stderr };
          settle?.(exitResult);
        });
        resolve({
          stdout: stream,
          wait: () => exitResult
            ? Promise.resolve(exitResult)
            : new Promise<{ code: number; stderr: string }>((res) => { settle = res; }),
          close: () => stream.close(),
        });
      });
    });
  }

  /** 交互式 shell（PTY，终端用） */
  shell(opts: { term: string; cols: number; rows: number }): Promise<ShellChannel> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new AppError("ssh", "未连接"));
        return;
      }
      this.client.shell({ term: opts.term, cols: opts.cols, rows: opts.rows }, (err, channel: ClientChannel) => {
        if (err) {
          reject(toAppError(err, "ssh"));
          return;
        }
        const dataCbs: Array<(chunk: Buffer) => void> = [];
        const closeCbs: Array<() => void> = [];
        channel.on("data", (chunk: Buffer) => { for (const cb of dataCbs) cb(chunk); });
        channel.on("close", () => { for (const cb of closeCbs) cb(); });
        resolve({
          write: (data) => channel.write(data),
          resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
          onData: (cb) => { dataCbs.push(cb); },
          onClose: (cb) => { closeCbs.push(cb); },
          close: () => channel.close(),
        });
      });
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.sftpInstance = null;
    if (client) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        client.end();
        setTimeout(resolve, 2000).unref();   // 兜底：2 秒没关闭也返回
      });
    }
  }

  /** close + connect，供 ensureConnected 内部用 */
  async reconnect(): Promise<void> {
    await this.close();
    await this.connect();
  }

  /** 断线自动重连一次 */
  async ensureConnected(): Promise<void> {
    if (!this.connected) await this.reconnect();
  }
}
