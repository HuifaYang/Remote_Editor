// 假 SSH 服务端（总纲 §10.2）：进程内 ssh2 Server，SFTP 由真实临时目录支撑，exec 返回罐装输出
import * as fs from "node:fs";
import * as path from "node:path";
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

/** 起假服务端：密码 u/test；execRules 匹配前先剥 `cd '...' && ` 前缀 */
export function startFakeServer(execRules: ExecRule[]): Promise<FakeServer> {
  // ssh2 自家工具生成 OpenSSH 格式主机密钥（node:crypto 的 PKCS8 PEM 它不认）
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os_tmp()), "rce-fake-ssh-"));

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
          for (const [pattern, r] of execRules) {
            if (pattern.test(cmd)) {
              reply = r;
              break;
            }
          }
          if (reply.stdout) stream.write(reply.stdout);
          if (reply.stderr) stream.stderr.write(reply.stderr);
          stream.exit(reply.code);
          stream.end();
        });
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
