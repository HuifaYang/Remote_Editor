// 会话层：authority ↔ SSHConnection，只在内存里持有。密码 / 私钥口令绝不落盘、不进日志（总纲 §6.1）。
//
// 复用仓库根 dist/ 里的编译产物（改 src/ 后先 npm run compile；打包时由 esbuild 捆进单文件）。
"use strict";

const { SSHConnection } = require("../../../../dist/main/main/session/connection.js");
const { RemoteFs } = require("../../../../dist/main/main/session/remote-fs.js");
const { GitRemote } = require("../../../../dist/main/main/session/git.js");
const { SearchRemote } = require("../../../../dist/main/main/session/search.js");
const { TerminalChannel } = require("../../../../dist/main/main/session/terminal.js");

/** URI authority：`user@host:port`（凭据不进 authority，避免出现在标题/日志/最近打开里） */
function authorityOf(spec) {
  return `${spec.username}@${spec.host}:${spec.port}`;
}

/** 环境变量里的连接参数（自检 / 开发工具用；正式版走 rce.connect 命令的手工输入） */
function specFromEnv(env = process.env) {
  if (!env.RCE_SPIKE_HOST) return null;
  return {
    host: env.RCE_SPIKE_HOST,
    port: Number(env.RCE_SPIKE_PORT || 22),
    username: env.RCE_SPIKE_USER || "root",
    password: env.RCE_SPIKE_PASS || undefined,
    privateKeyPath: env.RCE_SPIKE_KEY || undefined,
    passphrase: env.RCE_SPIKE_PASSPHRASE || undefined,
    timeoutMs: 10000,
    keepaliveMs: 15000,
    strictHostKey: env.RCE_SPIKE_STRICT_HOST_KEY === "1",
    knownHostsPath: env.RCE_SPIKE_KNOWN_HOSTS || "/dev/null",
    sshDir: env.RCE_SPIKE_SSH_DIR || "/nonexistent",
    workspace: env.RCE_SPIKE_WORKSPACE || "/ws",
  };
}

/** 一个已建立的会话：连接 + 四个远端能力门面（FS / Git / 搜索 / 终端） */
class RemoteSession {
  constructor(spec, conn, log, onUnexpectedClose) {
    this.spec = spec;
    this.conn = conn;
    this.log = log;
    this.authority = authorityOf(spec);
    this.fs = new RemoteFs(conn);
    this.git = new GitRemote(conn);
    this.search = new SearchRemote(conn);
    this.disposed = false;
    // 网络抖动 / 板子重启 / IDE 休眠都会让 SSH 悄悄断掉。主动 dispose 不算意外；
    // 意外断开必须上报，否则远端工作区还挂着、所有文件请求都报「没有会话」。
    if (typeof conn.onClose === "function") {
      conn.onClose(() => {
        if (!this.disposed) onUnexpectedClose?.(this.authority);
      });
    }
  }

  /** 新建一个 SSH 交互终端通道（每块终端一个，关闭标签必须 close，见 §13 坑 6） */
  openTerminal(cols, rows) {
    const ch = new TerminalChannel(this.conn);
    return ch.open(cols, rows).then(() => ch);
  }

  async dispose() {
    this.disposed = true;   // 先置位：close 触发的 onClose 回调不再当「意外断开」处理
    try {
      await this.conn.close();
    } catch (err) {
      this.log(`关闭连接失败：${err && err.message}`);
    }
  }
}

class SessionManager {
  constructor(log, hooks = {}) {
    this.log = log;
    this.hooks = hooks;                     // { onUnexpectedClose?: (authority) => void }
    this.byAuthority = new Map();
    this.pendingByAuthority = new Map();   // authority → 正在连接中的 promise
  }

  get(authority) {
    return this.byAuthority.get(authority);
  }

  /** 登记"这个 authority 马上要连"。
   *  为什么要提前登记：工作台在**窗口恢复阶段**就会来读工作区里的 `.vscode/*.json`、问 `.vscode` 在不在，
   *  那时 SSH 还没连上。这些请求要么等（这里登记的 promise），要么立刻失败——而一旦失败，工作台的
   *  配置服务就**不会重读**（症状：远端 `.vscode/settings.json` 不生效），snippet 服务的工作项也会卡住
   *  （连带补全一直 "Loading…"）。见 docs/ssh-vs-remotessh.md §5.4。 */
  expect(spec) {
    const authority = authorityOf(spec);
    if (this.byAuthority.has(authority) || this.pendingByAuthority.has(authority)) return;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => { /* 等它的人各自兜错，这里只是别让 Node 报未处理拒绝 */ });
    this.pendingByAuthority.set(authority, { promise, resolve, reject });
  }

  /** 等会话就绪：已有会话直接给；正在连就等（有上限）；压根没有就 undefined（调用方自己抛 Unavailable） */
  async whenReady(authority, timeoutMs = 15000) {
    const existing = this.byAuthority.get(authority);
    if (existing) return existing;
    const pending = this.pendingByAuthority.get(authority);
    if (!pending) return undefined;
    return await Promise.race([
      pending.promise.catch(() => undefined),
      new Promise((res) => setTimeout(() => res(undefined), Math.max(0, timeoutMs))),
    ]);
  }

  /** 按 authority 取会话；没有就现建（凭据来自内存里的 spec，重启窗口后需要重新连接） */
  async ensure(spec) {
    const authority = authorityOf(spec);
    const existing = this.byAuthority.get(authority);
    if (existing) return existing;
    // 同一 authority 的并发请求必须共用一次连接。否则工作台启动时文件系统/SCM/任务同时来问，
    // 会并发建多条 SSH，既浪费握手，也会让“连接中/失败/成功”状态来回跳。
    const inFlight = this.pendingByAuthority.get(authority);
    if (inFlight) return await inFlight.promise;
    this.expect(spec);                       // 先挂位子，让这期间来的文件请求能等我们
    const pending = this.pendingByAuthority.get(authority);
    const conn = new SSHConnection({
      host: spec.host,
      port: spec.port,
      username: spec.username,
      password: spec.password,
      privateKeyPath: spec.privateKeyPath,
      passphrase: spec.passphrase,
      timeoutMs: spec.timeoutMs ?? 10000,
      keepaliveMs: spec.keepaliveMs ?? 15000,
      strictHostKey: spec.strictHostKey !== false,
      knownHostsPath: spec.knownHostsPath,
      sshDir: spec.sshDir,
    });
    try {
      this.hooks.onConnecting?.(authority);
      await conn.connect();
      const session = new RemoteSession(
        { ...spec, port: spec.port },
        conn,
        this.log,
        (auth) => this.hooks.onUnexpectedClose?.(auth),
      );
      this.byAuthority.set(authority, session);
      this.log(`已连接 ${authority}`);
      if (pending) pending.resolve(session);
      this.hooks.onConnected?.(authority);
      return session;
    } catch (err) {
      if (pending) pending.reject(err);
      this.hooks.onConnectionFailed?.(authority, err);
      throw err;
    } finally {
      this.pendingByAuthority.delete(authority);
    }
  }

  /** 客户端连接失败时把 AppError 的中文文案带出来（认证/超时/主机公钥都有对应码） */
  async openOrThrow(spec) {
    try {
      return await this.ensure(spec);
    } catch (err) {
      const text = err && err.message ? err.message : String(err);
      throw new Error(`连接 ${spec.host}:${spec.port} 失败：${text}`);
    }
  }

  async closeAll() {
    // 先标记全部为主动关闭：close 触发的 onClose 回调不再当「意外断开」，避免自动重连抢跑
    for (const s of this.byAuthority.values()) s.disposed = true;
    const active = [...this.byAuthority.values()];
    const pending = [...this.pendingByAuthority.values()];
    // 先把内存状态清掉：UI 的「断开」必须立刻生效，不能被 SSH close 的等待拖住。
    this.byAuthority.clear();
    this.pendingByAuthority.clear();
    for (const p of pending) p.reject(new Error("已断开远程连接"));
    await Promise.allSettled(active.map((s) => s.dispose()));
  }
}

module.exports = { SessionManager, RemoteSession, authorityOf, specFromEnv };
