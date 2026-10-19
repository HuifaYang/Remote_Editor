// 假 SSH 服务端（总纲 §10.2）：进程内 ssh2 Server，SFTP 由真实临时目录支撑，exec 返回罐装输出
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { Server, type SFTPStream, type SFTPStatusCode } from "ssh2";
import { utils } from "ssh2";

const { STATUS_CODE } = utils.sftp;

// SFTPv3 OPEN flags
const FXF = { READ: 0x1, WRITE: 0x2, APPEND: 0x4, CREAT: 0x8, TRUNC: 0x10, EXCL: 0x20 };

type Handle =
  | { kind: "file"; fd: number }
  | { kind: "dir"; path: string; sent: boolean };

/** exec 罐装应答：匹配子串/正则 → {code, stdout, stderr}；未命中 → code 0 空输出
 *  stdout 可以是 Buffer —— 镜像同步用例要回放二进制 tar 流 */
export type ExecRule = [RegExp, { code: number; stdout: string | Buffer; stderr: string }];

function toFsFlags(flags: number): string {
  if (flags & FXF.WRITE) {
    if (flags & FXF.APPEND) return flags & FXF.EXCL ? "ax" : "a";
    if (flags & FXF.EXCL) return "wx";
    return "w";
  }
  return "r";
}

function toAttrs(st: fs.Stats): { mode: number; uid: number; gid: number; size: number; atime: number; mtime: number } {
  return { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

class FakeSftp {
  private handles = new Map<string, Handle>();
  private nextId = 1;

  constructor(private readonly sftp: SFTPStream, private readonly root: string) {
    sftp.on("OPEN", (reqid, filename, flags) => this.onOpen(reqid, filename, flags));
    sftp.on("READ", (reqid, handle, offset, length) => this.onRead(reqid, handle, offset, length));
    sftp.on("WRITE", (reqid, handle, offset, data) => this.onWrite(reqid, handle, offset, data));
    sftp.on("CLOSE", (reqid, handle) => this.onClose(reqid, handle));
    sftp.on("OPENDIR", (reqid, p) => this.onOpenDir(reqid, p));
    sftp.on("READDIR", (reqid, handle) => this.onReadDir(reqid, handle));
    sftp.on("LSTAT", (reqid, p) => this.onStat(reqid, p, true));
    sftp.on("STAT", (reqid, p) => this.onStat(reqid, p, false));
    sftp.on("RENAME", (reqid, oldPath, newPath) => this.wrap(reqid, () => fs.renameSync(this.real(oldPath), this.real(newPath))));
    sftp.on("REMOVE", (reqid, p) => this.wrap(reqid, () => fs.unlinkSync(this.real(p))));
    sftp.on("MKDIR", (reqid, p) => this.wrap(reqid, () => fs.mkdirSync(this.real(p))));
    sftp.on("RMDIR", (reqid, p) => this.wrap(reqid, () => fs.rmdirSync(this.real(p))));
  }

  /** 客户端路径 → 临时目录内的真实路径（防逃逸） */
  private real(p: string): string {
    const rel = p.replace(/^\/+/, "");
    const resolved = path.join(this.root, rel);
    if (!resolved.startsWith(this.root)) throw new Error("路径逃逸");
    return resolved;
  }

  private status(reqid: number, code: SFTPStatusCode): void {
    this.sftp.status(reqid, code);
  }

  private wrap(reqid: number, fn: () => void): void {
    try {
      fn();
      this.status(reqid, STATUS_CODE.OK);
    } catch {
      this.status(reqid, STATUS_CODE.FAILURE);
    }
  }

  private alloc(h: Handle): Buffer {
    const id = Buffer.from(String(this.nextId++).padStart(4, "0"));
    this.handles.set(id.toString(), h);
    return id;
  }

  private onOpen(reqid: number, filename: string, flags: number): void {
    try {
      const fd = fs.openSync(this.real(filename), toFsFlags(flags));
      this.sftp.handle(reqid, this.alloc({ kind: "file", fd }));
    } catch {
      this.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  }

  private onRead(reqid: number, handle: Buffer, offset: number, length: number): void {
    const h = this.handles.get(handle.toString());
    if (!h || h.kind !== "file") {
      this.status(reqid, STATUS_CODE.FAILURE);
      return;
    }
    const buf = Buffer.alloc(length);
    const n = fs.readSync(h.fd, buf, 0, length, offset);
    if (n === 0) this.status(reqid, STATUS_CODE.EOF);
    else this.sftp.data(reqid, buf.subarray(0, n));
  }

  private onWrite(reqid: number, handle: Buffer, offset: number, data: Buffer): void {
    const h = this.handles.get(handle.toString());
    if (!h || h.kind !== "file") {
      this.status(reqid, STATUS_CODE.FAILURE);
      return;
    }
    fs.writeSync(h.fd, data, 0, data.length, offset);
    this.status(reqid, STATUS_CODE.OK);
  }

  private onClose(reqid: number, handle: Buffer): void {
    const h = this.handles.get(handle.toString());
    if (h) {
      if (h.kind === "file") fs.closeSync(h.fd);
      this.handles.delete(handle.toString());
    }
    this.status(reqid, STATUS_CODE.OK);
  }

  private onOpenDir(reqid: number, p: string): void {
    try {
      const real = this.real(p);
      if (!fs.statSync(real).isDirectory()) throw new Error("不是目录");
      this.sftp.handle(reqid, this.alloc({ kind: "dir", path: real, sent: false }));
    } catch {
      this.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  }

  private onReadDir(reqid: number, handle: Buffer): void {
    const h = this.handles.get(handle.toString());
    if (!h || h.kind !== "dir") {
      this.status(reqid, STATUS_CODE.FAILURE);
      return;
    }
    if (h.sent) {
      this.status(reqid, STATUS_CODE.EOF);
      return;
    }
    h.sent = true;
    const names = fs.readdirSync(h.path).map((name) => {
      const st = fs.lstatSync(path.join(h.kind === "dir" ? h.path : "", name));
      return { filename: name, longname: name, attrs: toAttrs(st) };
    });
    this.sftp.name(reqid, names);
  }

  private onStat(reqid: number, p: string, lstat: boolean): void {
    try {
      const st = lstat ? fs.lstatSync(this.real(p)) : fs.statSync(this.real(p));
      this.sftp.attrs(reqid, toAttrs(st));
    } catch {
      this.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  }
}

export interface FakeServer {
  port: number;
  root: string;
  close(): Promise<void>;
}

/** 真机行为开关（默认全关，保持既有用例的“罐装”语义）：
 *  · realExec —— exec 没命中罐装规则时，把远端路径重写成临时根后**真的执行**（终端/搜索/git 的端到端验证用）
 *  · realShell —— 支持 shell/pty 请求，用 `script` 起一个真 pty 里的 bash（集成终端的端到端验证用）
 *  · shellWrapper —— 真机命令外面再套一层可执行文件（argv 前缀），用来模拟“另一台机器”：
 *    端到端里用它把工作机的 /usr/include 盖成空目录（见 ide/tools/fake-target.sh），
 *    否则镜像同步会把工作机几百 MB 的系统头当成远端 sysroot 拉一遍。 */
export interface FakeServerOptions {
  realExec?: boolean;
  realShell?: boolean;
  shellWrapper?: string;
}

/** 起假服务端：密码 u/test；execRules 匹配前先剥 `cd '...' && ` 前缀 */
export function startFakeServer(execRules: ExecRule[], opts: FakeServerOptions = {}): Promise<FakeServer> {
  // ssh2 自家工具生成 OpenSSH 格式主机密钥（node:crypto 的 PKCS8 PEM 它不认）
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os_tmp()), "rce-fake-ssh-"));

  /** 远端绝对路径 → 临时根里的真实路径（与 SFTP 的 real() 同一套映射，只处理带引号/前有空格的形态） */
  const rewrite = (command: string): string =>
    command
      .replace(/'\/ws/g, `'${root}/ws`)
      .replace(/(^|\s)\/ws(?=\/|\s|$)/g, `$1${root}/ws`);

  /**
   * 反向映射：exec 的**输出**里出现的临时根路径要还原成远端虚拟路径。
   * 不还原的话 `git rev-parse --show-toplevel` 会把 `/tmp/rce-fake-ssh-xxx/ws` 吐给客户端，
   * 客户端按自己的 `/ws` 前缀算相对路径就会算错（表现为暂存/提交失败）。
   */
  const unrewrite = (text: string): string => text.split(`${root}/ws`).join('/ws');

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "u" && ctx.password === "test") ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const cmd = info.command.replace(/^cd '[^']*' && /, "");
          let reply = { code: 0, stdout: "", stderr: "" };
          let matched = false;
          for (const [pattern, r] of execRules) {
            if (pattern.test(cmd)) {
              reply = r;
              matched = true;
              break;
            }
          }
          if (!matched && opts.realExec) {
            const argv = ["/bin/bash", "-c", rewrite(info.command)];
            const child = opts.shellWrapper
              ? spawn(opts.shellWrapper, argv, { cwd: root, env: process.env })
              : spawn(argv[0], argv.slice(1), { cwd: root, env: process.env });
            // exec 通道是全双工的：普通命令不写 stdin 不受影响，远端 LSP 则靠它收发 JSON-RPC。
            stream.on("data", (chunk: Buffer) => { child.stdin?.write(chunk); });
            stream.on("close", () => { child.stdin?.end(); });
            /*
             * 只有 rev-parse 会吐绝对路径（--show-toplevel），也只有它需要反向映射。
             * 不能对所有命令做字符串替换：镜像同步走的是 tar.gz 二进制流，
             * 二进制里出现同样的字节串就会被改坏（症状：解压镜像失败 incorrect header check）。
             */
            const shouldUnrewrite = /rev-parse|pwd -P/.test(info.command);
            child.stdout.on("data", (d: Buffer) =>
              stream.write(shouldUnrewrite ? unrewrite(d.toString()) : d));
            child.stderr.on("data", (d: Buffer) =>
              stream.stderr.write(shouldUnrewrite ? unrewrite(d.toString()) : d));
            child.on("close", (code: number | null) => {
              stream.exit(code ?? 0);
              stream.end();
            });
            return;
          }
          if (reply.stdout) stream.write(reply.stdout);
          if (reply.stderr) stream.stderr.write(reply.stderr);
          stream.exit(reply.code);
          stream.end();
        });
        if (opts.realShell) {
          session.on("pty", (acceptPty: () => void) => { acceptPty(); });
          session.on("window-change", () => { /* 尺寸变化忽略：验证用的假靶机不需要真的 resize */ });
          session.on("shell", (acceptShell: () => NodeJS.ReadWriteStream) => {
            const stream = acceptShell() as unknown as {
              write(d: string | Buffer): void;
              stderr: { write(d: string | Buffer): void };
              exit(code: number): void;
              end(): void;
              on(ev: string, cb: (d?: Buffer) => void): void;
            };
            // script(1) 能不带 node-pty 就造出真 pty，bash 因此有提示符、有回显
            const shellArgv = ["script", "-q", "-f", "-c", "/bin/bash", "/dev/null"];
            const shellOpts: SpawnOptions = {
              cwd: root,
              env: { ...process.env, TERM: "xterm-256color" },
              stdio: ["pipe", "pipe", "pipe"],
            };
            const child = opts.shellWrapper
              ? spawn(opts.shellWrapper, shellArgv, shellOpts)
              : spawn(shellArgv[0], shellArgv.slice(1), shellOpts);
            const childIn = child.stdin;
            const childOut = child.stdout;
            const childErr = child.stderr;
            if (!childIn || !childOut || !childErr) throw new Error("假靶机：pty 子进程缺少管道");
            stream.on("data", (d?: Buffer) => { if (d) childIn.write(d); });
            childOut.on("data", (d: Buffer) => stream.write(d));
            childErr.on("data", (d: Buffer) => stream.stderr.write(d));
            child.on("close", (code: number | null) => {
              stream.exit(code ?? 0);
              stream.end();
            });
          });
        }
        session.on("sftp", (acceptSftp) => {
          new FakeSftp(acceptSftp(), root);
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({
          port: addr.port,
          root,
          close: () => new Promise<void>((res) => server.close(() => res())),
        });
      } else {
        reject(new Error("监听失败"));
      }
    });
  });
}

function os_tmp(): string {
  return process.env.TMPDIR || "/tmp";
}
