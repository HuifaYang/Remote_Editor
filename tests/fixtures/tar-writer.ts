// 测试用 tar.gz 生成器（纯 JS）：沙箱里 spawn 本机 tar 会被拦，镜像用例改用它造数据
import * as zlib from "node:zlib";

const BLOCK = 512;

export interface TarFile {
  path: string;
  content?: string;
  type?: "file" | "dir" | "symlink";
  link?: string;
}

/** 生成 ustar 包；超过 100 字节的路径按 GNU LongLink(L) 处理（与远端 GNU tar 行为一致） */
export function makeTarGz(files: TarFile[]): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files) {
    const type = f.type ?? "file";
    const body = type === "file" ? Buffer.from(f.content ?? "", "utf8") : Buffer.alloc(0);
    if (Buffer.byteLength(f.path, "utf8") > 100) {
      const longBody = Buffer.from(f.path + "\0", "utf8");
      chunks.push(header("././@LongLink", longBody.length, "L", ""));
      chunks.push(longBody, pad(longBody.length));
    }
    const typeFlag = type === "dir" ? "5" : type === "symlink" ? "2" : "0";
    chunks.push(header(f.path.slice(0, 99), body.length, typeFlag, f.link ?? ""));
    if (body.length > 0) chunks.push(body, pad(body.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function pad(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

function header(name: string, size: number, typeFlag: string, link: string): Buffer {
  const b = Buffer.alloc(BLOCK);
  writeStr(b, 0, 100, name);
  writeOctal(b, 100, 8, 0o644);
  writeOctal(b, 108, 8, 0);
  writeOctal(b, 116, 8, 0);
  writeOctal(b, 124, 12, size);
  writeOctal(b, 136, 12, 1700000000);
  b.fill(0x20, 148, 156);          // 校验和字段先填空格
  b[156] = typeFlag.charCodeAt(0);
  writeStr(b, 157, 100, link);
  writeStr(b, 257, 6, "ustar");
  b.write("00", 263, 2, "ascii");
  writeStr(b, 265, 32, "root");
  writeStr(b, 297, 32, "root");
  let sum = 0;
  for (const v of b) sum += v;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return b;
}

function writeStr(b: Buffer, offset: number, length: number, value: string): void {
  const src = Buffer.from(value, "utf8").subarray(0, length - 1);
  src.copy(b, offset);
  b[offset + src.length] = 0;
}

function writeOctal(b: Buffer, offset: number, length: number, value: number): void {
  b.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  b[offset + length - 1] = 0;
}
