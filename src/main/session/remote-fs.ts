// 远端文件系统（总纲 §5.2）：SFTP 封装，原子写、编码识别、路径一律规范化
import * as path from "node:path";
import type { SFTPWrapper, FileEntryWithStats } from "ssh2";
import type { Stats } from "ssh2";
import { AppError, toAppError } from "../../shared/errors.js";
import { normalizeRemotePath, shellQuote } from "../../shared/paths.js";
import type { Fingerprint, RemoteEntry } from "../../shared/types.js";
import type { SSHConnection } from "./connection.js";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;   // §5.2.2：单文件默认上限 32MB
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ---- SFTPWrapper 回调 API 的 Promise 化（全部经 conn.sftpRun 串行） ----

function readdirAsync(sftp: SFTPWrapper, p: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list)));
  });
}
function statAsync(sftp: SFTPWrapper, p: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st)));
  });
}
function renameAsync(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
  });
}
function unlinkAsync(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(p, (err) => (err ? reject(err) : resolve()));
  });
}
function mkdirAsync(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(p, (err) => (err ? reject(err) : resolve()));
  });
}
function readAll(sftp: SFTPWrapper, p: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = sftp.createReadStream(p);
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new AppError("invalid-input", "文件过大", `${p} 超过 ${maxBytes} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
function writeAll(sftp: SFTPWrapper, p: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(p);
    stream.on("error", reject);
    stream.on("close", () => resolve());
    stream.end(data);
  });
}

export class RemoteFs {
  constructor(private readonly conn: SSHConnection) {}

  /** 列目录：目录在前、按名排序（不区分大小写）；跳过 . 与 ..；符号链接 stat 判定 */
  async listDir(dir: string): Promise<RemoteEntry[]> {
    const target = normalizeRemotePath(dir, "/");
    return this.conn.sftpRun(async (sftp) => {
      let list: FileEntryWithStats[];
      try {
        list = await readdirAsync(sftp, target);
      } catch (err) {
        throw toAppError(err, "sftp");
      }
      const entries: RemoteEntry[] = [];
      for (const item of list) {
        if (item.filename === "." || item.filename === "..") continue;
        const p = (target === "/" ? "" : target) + "/" + item.filename;
        const isSymlink = item.attrs.isSymbolicLink();
        let isDir = item.attrs.isDirectory();
        if (isSymlink) {
          try {
            isDir = (await statAsync(sftp, p)).isDirectory();
          } catch {
            isDir = false;   // 悬空符号链接按文件处理
          }
        }
        entries.push({
          name: item.filename,
          path: p,
          isDir,
          isSymlink,
          size: isDir ? 0 : item.attrs.size,
          mtime: item.attrs.mtime,
          mode: item.attrs.mode,
        });
      }
      entries.sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDir ? -1 : 1,
      );
      return entries;
    });
  }

  async stat(p: string): Promise<RemoteEntry> {
    const target = normalizeRemotePath(p, "/");
    return this.conn.sftpRun(async (sftp) => {
      try {
        const st = await statAsync(sftp, target);
        const isDir = st.isDirectory();
        return {
          name: path.posix.basename(target),
          path: target,
          isDir,
          isSymlink: st.isSymbolicLink(),
          size: isDir ? 0 : st.size,
          mtime: st.mtime,
          mode: st.mode,
        };
      } catch (err) {
        throw toAppError(err, "sftp");
      }
    });
  }

  /** 读文件：UTF-8/BOM 自动识别，无法解码抛 invalid-input（上层弹编码选择框） */
  async readFile(p: string, maxBytes: number = DEFAULT_MAX_BYTES): Promise<{
    text: string; encoding: "utf8" | "utf8-bom" | "binary"; newline: "lf" | "crlf"; fingerprint: Fingerprint;
  }> {
    const target = normalizeRemotePath(p, "/");
    return this.conn.sftpRun(async (sftp) => {
      let st: Stats;
      try {
        st = await statAsync(sftp, target);
      } catch (err) {
        throw toAppError(err, "sftp");
      }
      if (st.size > maxBytes) {
        throw new AppError("invalid-input", "文件过大", `${target}（${st.size} 字节，上限 ${maxBytes}）`);
      }
      let buf: Buffer;
      try {
        buf = await readAll(sftp, target, maxBytes);
      } catch (err) {
        throw toAppError(err, "sftp");
      }
      let encoding: "utf8" | "utf8-bom" = "utf8";
      if (buf.subarray(0, 3).equals(UTF8_BOM)) {
        encoding = "utf8-bom";
        buf = buf.subarray(3);
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        throw new AppError("invalid-input", "无法按 UTF-8 解码（可能是二进制文件）", target);
      }
      const newline: "lf" | "crlf" = text.includes("\r\n") ? "crlf" : "lf";
      if (newline === "crlf") text = text.replace(/\r\n/g, "\n");   // 编辑器内部统一 \n
      return { text, encoding, newline, fingerprint: { path: target, size: st.size, mtime: st.mtime } };
    });
  }

  /** 原子写（§5.2.1）：写临时文件 → rename 覆盖；失败清理临时文件 */
  async saveFile(p: string, text: string, opts?: { encoding?: "utf8" | "utf8-bom"; newline?: "lf" | "crlf" }): Promise<Fingerprint> {
    const target = normalizeRemotePath(p, "/");
    const normalized = text.replace(/\r\n/g, "\n");
    const body = (opts?.newline ?? "lf") === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
    let buf = Buffer.from(body, "utf8");
    if (opts?.encoding === "utf8-bom") buf = Buffer.concat([UTF8_BOM, buf]);
    const tmp = `${target}.rce-tmp-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    return this.conn.sftpRun(async (sftp) => {
      try {
        await writeAll(sftp, tmp, buf);
        await renameAsync(sftp, tmp, target);
      } catch (err) {
        await unlinkAsync(sftp, tmp).catch(() => { /* 清理失败不掩盖原始错误 */ });
        throw toAppError(err, "sftp");
      }
      try {
        const st = await statAsync(sftp, target);
        return { path: target, size: st.size, mtime: st.mtime };
      } catch (err) {
        throw toAppError(err, "sftp");
      }
    });
  }

  async createFile(p: string): Promise<void> {
    const target = normalizeRemotePath(p, "/");
    await this.conn.sftpRun(async (sftp) => {
      try {
        await writeAll(sftp, target, Buffer.alloc(0));
      } catch (err) {
        throw toAppError(err, "sftp");
      }
    });
  }

  async createDir(p: string): Promise<void> {
    const target = normalizeRemotePath(p, "/");
    await this.conn.sftpRun(async (sftp) => {
      try {
        await mkdirAsync(sftp, target);
      } catch (err) {
        throw toAppError(err, "sftp");
      }
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normalizeRemotePath(from, "/");
    const dst = normalizeRemotePath(to, "/");
    await this.conn.sftpRun(async (sftp) => {
      try {
        await renameAsync(sftp, src, dst);
      } catch (err) {
        throw toAppError(err, "sftp");
      }
    });
  }

  /** 删除文件或目录（目录经 exec `rm -rf` 递归，比 SFTP 递归遍历省往返） */
  async remove(p: string): Promise<void> {
    const target = normalizeRemotePath(p, "/");
    const entry = await this.stat(target);
    if (entry.isDir) {
      const r = await this.conn.exec(`rm -rf -- ${shellQuote(target)}`);
      if (r.code !== 0) throw new AppError("sftp", "删除目录失败", r.stderr.trim());
      return;
    }
    await this.conn.sftpRun(async (sftp) => {
      try {
        await unlinkAsync(sftp, target);
      } catch (err) {
        throw toAppError(err, "sftp");
      }
    });
  }

  /** 文件指纹；不存在返回 null */
  async fingerprint(p: string): Promise<Fingerprint | null> {
    const target = normalizeRemotePath(p, "/");
    return this.conn.sftpRun(async (sftp) => {
      try {
        const st = await statAsync(sftp, target);
        return { path: target, size: st.size, mtime: st.mtime };
      } catch {
        return null;
      }
    });
  }

  async exists(p: string): Promise<boolean> {
    return (await this.fingerprint(p)) !== null;
  }
}
