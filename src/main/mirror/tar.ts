// 纯 Node 的 tar.gz 解包（不引依赖、不依赖工作机有 tar 命令）
// 支持 ustar / GNU LongLink(L,K) / PAX 扩展头(x,g)、普通文件、目录、符号链接、硬链接；
// 路径一律限制在目标目录内（防 tar slip）。
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../../shared/errors.js";

const BLOCK = 512;

export async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    await pipeline(fs.createReadStream(tarPath), zlib.createGunzip(), new TarExtractSink(destDir));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("mirror", "解压镜像失败", err instanceof Error ? err.message : String(err));
  }
}

class TarExtractSink extends Writable {
  private buf: Buffer = Buffer.alloc(0);
  private nameOverride: string | null = null;
  private linkOverride: string | null = null;
  private zeroBlocks = 0;

  constructor(private readonly destDir: string) {
    super();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.drain();
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private drain(): void {
    while (this.buf.length >= BLOCK) {
      const header = this.buf.subarray(0, BLOCK);
      if (isZeroBlock(header)) {
        this.zeroBlocks++;
        this.buf = this.buf.subarray(BLOCK);
        if (this.zeroBlocks >= 2) {
          this.buf = Buffer.alloc(0);
          return;
        }
        continue;
      }
      this.zeroBlocks = 0;
      const size = parseNumeric(header.subarray(124, 136));
      const bodyLen = Math.ceil(size / BLOCK) * BLOCK;
      if (this.buf.length < BLOCK + bodyLen) return;   // 半包：等下一块
      const body = this.buf.subarray(BLOCK, BLOCK + size);
      const typeFlag = String.fromCharCode(header[156]) || "0";
      const prefix = readString(header, 345, 155);
      const shortName = this.nameOverride ?? readString(header, 0, 100);
      const name = prefix ? `${prefix}/${shortName}` : shortName;
      const linkname = this.linkOverride ?? readString(header, 157, 100);
      this.nameOverride = null;
      this.linkOverride = null;
      this.emitEntry(typeFlag, name, linkname, body);
      this.buf = this.buf.subarray(BLOCK + bodyLen);
    }
  }

  private emitEntry(typeFlag: string, name: string, linkname: string, body: Buffer): void {
    if (typeFlag === "L") {                    // GNU 长文件名
      this.nameOverride = body.toString("utf8").replace(/\0+$/, "");
      return;
    }
    if (typeFlag === "K") {                    // GNU 长链接名
      this.linkOverride = body.toString("utf8").replace(/\0+$/, "");
      return;
    }
    if (typeFlag === "x" || typeFlag === "g") { // PAX 扩展头
      for (const [key, value] of parsePax(body)) {
        if (key === "path") this.nameOverride = value;
        if (key === "linkpath") this.linkOverride = value;
      }
      return;
    }
    const target = this.resolve(name);
    if (target === null) return;
    if (typeFlag === "5" || name.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      return;
    }
    if (typeFlag === "2") {                    // 符号链接：镜像内原样保留链接
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { force: true });
      try {
        fs.symlinkSync(linkname, target);
      } catch {
        // 工作机不支持（Windows 无权限）→ 退化成空文件，不能让整次同步失败
        fs.writeFileSync(target, Buffer.alloc(0));
      }
      return;
    }
    if (typeFlag === "1") {                    // 硬链接：直接复制一份，镜像不比 inode
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const from = this.resolve(linkname);
      if (from && fs.existsSync(from)) fs.copyFileSync(from, target);
      else fs.writeFileSync(target, body);
      return;
    }
    if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "7") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      return;
    }
    // 设备节点 / FIFO 等一律跳过（镜像里没有意义）
  }

  /** 归一到目标目录内，越界返回 null（tar slip 防护） */
  private resolve(name: string): string | null {
    const rel = name.replace(/^\.\/+/, "").replace(/^\/+/, "");
    if (!rel) return null;
    const abs = path.resolve(this.destDir, rel);
    const root = path.resolve(this.destDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }
}

function isZeroBlock(b: Buffer): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

function readString(b: Buffer, offset: number, length: number): string {
  const slice = b.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8").trim();
}

/** tar 数值字段：八进制，或 GNU base-256（最高位为 1） */
function parseNumeric(b: Buffer): number {
  if (b.length > 0 && (b[0] & 0x80) !== 0) {
    let value = b[0] & 0x7f;
    for (let i = 1; i < b.length; i++) value = value * 256 + b[i];
    return value;
  }
  const text = b.toString("ascii").replace(/\0.*$/, "").trim();
  const value = parseInt(text, 8);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** PAX 记录格式：`<十进制长度> key=value\n` */
export function parsePax(body: Buffer): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const text = body.toString("utf8");
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space < 0) break;
    const len = Number(text.slice(i, space));
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, i + len - 1);   // 去掉结尾 \n
    const eq = record.indexOf("=");
    if (eq > 0) out.push([record.slice(0, eq), record.slice(eq + 1)]);
    i += len;
  }
  return out;
}
