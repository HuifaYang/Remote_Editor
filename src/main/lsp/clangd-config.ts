// compile_commands.json 收集与重写（分册 1 A9，M3 最容易做错的坑）：
// 远端绝对路径必须重写成镜像本地路径；-I/-isystem/-iquote 走三分规则，工作机自带的
// ROS/工具链头文件一律丢弃，否则 clangd 会串到工作机环境、补全静默跑偏。
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError, toAppError } from "../../shared/errors.js";
import { shellQuote } from "../../shared/paths.js";
import { log } from "../log.js";
import type { SSHConnection } from "../session/connection.js";

export interface CompileCommandEntry {
  directory?: string;
  file?: string;
  command?: string;
  arguments?: string[];
  output?: string;
  [key: string]: unknown;
}

export interface CompileRewriteContext {
  remotePrefix: string;      // 远端工作目录（= compile_commands 里的绝对路径前缀）
  localPrefix: string;       // 本地镜像根（工作机的绝对路径）
  sysrootRoots: string[];    // 本次收集的远端头文件目录（工作目录外）
  localSysrootPrefix: string; // = <镜像>/_sysroot
}

export interface RewriteResult {
  entry: CompileCommandEntry;
  dropped: string[];         // 被丢弃的 -I 路径（记日志用）
}

export interface CompileCollection {
  kind: "compile_commands" | "compile_flags";
  outputPath: string;         // 写出的文件
  entryCount: number;
  sourceFiles: string[];      // 收集到的 compile_commands.json（字典序）
  sysrootRoots: string[];     // 需要同步的头文件目录（远端绝对路径）
  droppedIncludes: string[];
  warnings: string[];
}

/** find 收集命令（§5.3.6：一条 exec，禁止递归 SFTP 列目录） */
export function buildCompileCommandsFindCommand(workspace: string): string {
  const ws = workspace.replace(/\/+$/, "") || "/";
  const build = `${ws}/build`;
  return [
    `if [ -d ${shellQuote(build)} ]; then`,
    `  find ${shellQuote(build)} -type f -name compile_commands.json;`,
    "else",
    `  find ${shellQuote(ws)} -maxdepth 4 -type f -name compile_commands.json;`,
    "fi",
  ].join("\n");
}

/** 头文件目录存在性探测（一条 exec）：只保留远端真实存在的目录 */
export function buildDirExistsCommand(dirs: string[]): string {
  const body = dirs.map((d) => `[ -d ${shellQuote(d)} ] && printf '%s\\n' ${shellQuote(d)}`).join("; ");
  return `${body}; true`;
}

/** 退化兜底（§5.3.6 / A9.3）：找不到 compile_commands.json 时给 clangd 的 compile_flags.txt */
export function buildCompileFlagsTxt(localPrefix: string): string {
  const p = localPrefix.replace(/[\\/]+$/, "");
  return ["-std=c++17", `-I${path.join(p, "include")}`, `-I${p}`, ""].join("\n");
}

/** 命令行切词：保留引号原样（只做识别与替换，重置时不重新解释） */
export function splitCommandLine(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function unquote(token: string): string {
  if (token.length >= 2 && (token.startsWith("'") || token.startsWith('"'))) {
    const q = token[0];
    if (token.endsWith(q)) return token.slice(1, -1);
  }
  return token;
}

/** 远端路径前缀替换（A9.1：只替换开头，不匹配的原样保留） */
export function rewriteRemotePrefix(value: string, remotePrefix: string, localPrefix: string): string {
  const remote = remotePrefix.replace(/\/+$/, "");
  if (remote && (value === remote || value.startsWith(remote + "/"))) {
    const rest = value.slice(remote.length).replace(/^\/+/, "");
    return rest ? path.join(localPrefix, ...rest.split("/")) : localPrefix;
  }
  return value;
}

function isUnder(p: string, root: string): boolean {
  const r = root.replace(/\/+$/, "") || "/";
  if (r === "/") return p.startsWith("/");
  return p === r || p.startsWith(r + "/");
}

/** 三分规则（A9.4）：镜像源码 / _sysroot / 丢弃 */
export function classifyIncludePath(includePath: string, ctx: CompileRewriteContext): { value: string | null; kind: "workspace" | "sysroot" | "relative" | "drop" } {
  if (!includePath.startsWith("/")) return { value: includePath, kind: "relative" };   // 相对路径相对 directory，directory 已重写
  if (isUnder(includePath, ctx.remotePrefix)) {
    return { value: rewriteRemotePrefix(includePath, ctx.remotePrefix, ctx.localPrefix), kind: "workspace" };
  }
  for (const root of ctx.sysrootRoots) {
    if (isUnder(includePath, root)) {
      const rel = includePath.replace(/^\/+/, "");
      return { value: path.join(ctx.localSysrootPrefix, ...rel.split("/")), kind: "sysroot" };
    }
  }
  return { value: null, kind: "drop" };
}

const INCLUDE_FLAGS = ["-I", "-isystem", "-iquote"];

function rewriteTokens(tokens: string[], ctx: CompileRewriteContext, dropped: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const bare = unquote(token);
    const exact = INCLUDE_FLAGS.find((f) => bare === f);
    if (exact) {
      const next = tokens[i + 1];
      if (next === undefined) { out.push(token); continue; }
      const cls = classifyIncludePath(unquote(next), ctx);
      if (cls.value === null) {
        dropped.push(unquote(next));
        i++;                       // 连同值一起删除
        continue;
      }
      out.push(token, shellQuote(cls.value));
      i++;
      continue;
    }
    const joined = INCLUDE_FLAGS.find((f) => bare.startsWith(f) && bare.length > f.length);
    if (joined) {
      const flag = joined;
      const rest = bare.slice(flag.length);
      const cls = classifyIncludePath(rest, ctx);
      if (cls.value === null) {
        dropped.push(rest);
        continue;
      }
      out.push(flag + shellQuote(cls.value));
      continue;
    }
    out.push(bare.startsWith("/") ? shellQuote(rewriteRemotePrefix(bare, ctx.remotePrefix, ctx.localPrefix)) : token);
  }
  return out;
}

/** 单条 compile command 的重写；args / command / 路径字段都覆盖（A9.1 + A9.4） */
export function rewriteCompileCommand(entry: CompileCommandEntry, ctx: CompileRewriteContext): RewriteResult {
  const dropped: string[] = [];
  const next: CompileCommandEntry = { ...entry };
  for (const key of ["directory", "file", "output"] as const) {
    const value = next[key];
    if (typeof value === "string") next[key] = rewriteRemotePrefix(value, ctx.remotePrefix, ctx.localPrefix);
  }
  if (Array.isArray(next.arguments)) {
    next.arguments = rewriteTokens(next.arguments, ctx, dropped);
  }
  if (typeof next.command === "string") {
    next.command = rewriteTokens(splitCommandLine(next.command), ctx, dropped).join(" ");
  }
  return { entry: next, dropped };
}

/** 合并多个 compile_commands.json（A9.2：按文件路径字典序，文件内保持原序） */
export function mergeCompileCommands(
  files: Array<{ path: string; entries: CompileCommandEntry[] }>,
  ctx: CompileRewriteContext,
): { entries: CompileCommandEntry[]; dropped: string[] } {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries: CompileCommandEntry[] = [];
  const dropped: string[] = [];
  for (const file of sorted) {
    for (const entry of file.entries) {
      const r = rewriteCompileCommand(entry, ctx);
      entries.push(r.entry);
      dropped.push(...r.dropped);
    }
  }
  return { entries, dropped };
}

/** 从 command / arguments 里抽出 -I/-isystem/-iquote 目录（用于 sysroot 收集） */
export function collectIncludeDirs(entry: CompileCommandEntry): string[] {
  const tokens = Array.isArray(entry.arguments) ? entry.arguments : typeof entry.command === "string" ? splitCommandLine(entry.command) : [];
  const dirs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const bare = unquote(tokens[i]);
    const exact = INCLUDE_FLAGS.find((f) => bare === f);
    if (exact && tokens[i + 1] !== undefined) {
      dirs.push(unquote(tokens[i + 1]));
      i++;
      continue;
    }
    const joined = INCLUDE_FLAGS.find((f) => bare.startsWith(f) && bare.length > f.length);
    if (joined) dirs.push(bare.slice(joined.length));
  }
  return dirs.filter((d) => d.startsWith("/"));
}

async function readRemoteText(conn: SSHConnection, p: string, maxBytes = 16 * 1024 * 1024): Promise<string> {
  return conn.sftpRun(async (sftp) => new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = sftp.createReadStream(p);
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new AppError("invalid-input", "compile_commands.json 过大", p));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", (err: Error) => reject(toAppError(err, "sftp")));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  }));
}

function parseCompileCommands(text: string, file: string, warnings: string[]): CompileCommandEntry[] {
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) {
      warnings.push(`compile_commands.json 不是数组，已跳过: ${file}`);
      return [];
    }
    return data.filter((e): e is CompileCommandEntry => typeof e === "object" && e !== null);
  } catch (err) {
    warnings.push(`compile_commands.json 解析失败，已跳过: ${file}（${String(err)}）`);
    return [];
  }
}

/** 从「同一条复合命令」已解析的分段数据构建收集结果（§5.3.1：首次同步 1 条 exec） */
export function collectFromParsedData(
  workspace: string,
  data: { findOutput: string; fileTexts: Record<string, string>; probeOutput: string },
  opts: { mirrorRoot: string; triplet: string; gccIncludeDir?: string },
): CompileCollection {
  const ws = workspace.replace(/\/+$/, "") || "/";
  const warnings: string[] = [];
  const files = [...new Set(data.findOutput.split("\n").map((l) => l.trim()).filter(Boolean))].sort();
  const parsed: Array<{ path: string; entries: CompileCommandEntry[] }> = [];
  for (const file of files) {
    const text = data.fileTexts[file] ?? "";
    parsed.push({ path: file, entries: parseCompileCommands(text, file, warnings) });
  }

  // sysroot 收集集合 = compile_commands 里的绝对 -I 目录 + 默认系统头目录，且远端真实存在
  const candidates = new Set<string>();
  for (const f of parsed) for (const e of f.entries) for (const d of collectIncludeDirs(e)) {
    if (!isUnder(d, ws)) candidates.add(d);
  }
  candidates.add("/usr/include");
  candidates.add(`/usr/include/${opts.triplet}`);
  if (opts.gccIncludeDir) candidates.add(opts.gccIncludeDir);
  const candidateList = [...candidates].sort();
  let sysrootRoots = candidateList;
  if (candidateList.length > 0) {
    const alive = new Set(data.probeOutput.split("\n").map((l) => l.trim()).filter(Boolean));
    sysrootRoots = candidateList.filter((d) => alive.has(d));
  }

  const ctx: CompileRewriteContext = {
    remotePrefix: ws,
    localPrefix: opts.mirrorRoot,
    sysrootRoots,
    localSysrootPrefix: path.join(opts.mirrorRoot, "_sysroot"),
  };
  const merged = mergeCompileCommands(parsed, ctx);
  const droppedIncludes = [...new Set(merged.dropped)];
  for (const d of droppedIncludes) log("warn", `已丢弃本机不可映射的 -I: ${d}`);
  for (const w of warnings) log("warn", w);

  fs.mkdirSync(opts.mirrorRoot, { recursive: true });
  const compileCommandsPath = path.join(opts.mirrorRoot, "compile_commands.json");
  const compileFlagsPath = path.join(opts.mirrorRoot, "compile_flags.txt");
  if (merged.entries.length > 0) {
    fs.rmSync(compileFlagsPath, { force: true });
    fs.writeFileSync(compileCommandsPath, JSON.stringify(merged.entries, null, 2) + "\n", "utf8");
    return {
      kind: "compile_commands", outputPath: compileCommandsPath, entryCount: merged.entries.length,
      sourceFiles: files, sysrootRoots, droppedIncludes, warnings,
    };
  }
  fs.rmSync(compileCommandsPath, { force: true });
  fs.writeFileSync(compileFlagsPath, buildCompileFlagsTxt(opts.mirrorRoot), "utf8");
  return {
    kind: "compile_flags", outputPath: compileFlagsPath, entryCount: 0,
    sourceFiles: files, sysrootRoots, droppedIncludes, warnings,
  };
}

/**
 * 独立收集（§5.3.6）：1 条 find + 逐个小文件 SFTP + 1 条目录存在性探测。
 * 仅用于非「同一条复合命令」场景（如测试或手动收集）。
 */
export async function collectCompileCommands(
  conn: SSHConnection,
  workspace: string,
  opts: { mirrorRoot: string; triplet: string; gccIncludeDir?: string },
): Promise<CompileCollection> {
  const ws = workspace.replace(/\/+$/, "") || "/";
  const warnings: string[] = [];
  const result = await conn.exec(buildCompileCommandsFindCommand(ws));
  const files = [...new Set(result.stdout.split("\n").map((l) => l.trim()).filter(Boolean))].sort();
  const fileTexts: Record<string, string> = {};
  for (const file of files) {
    fileTexts[file] = await readRemoteText(conn, file);
  }
  // 探测目录（独立调用需要额外一次 exec）
  const candidates = new Set<string>();
  const parsed: Array<{ path: string; entries: CompileCommandEntry[] }> = [];
  for (const file of files) {
    parsed.push({ path: file, entries: parseCompileCommands(fileTexts[file] ?? "", file, warnings) });
  }
  for (const f of parsed) for (const e of f.entries) for (const d of collectIncludeDirs(e)) {
    if (!isUnder(d, ws)) candidates.add(d);
  }
  candidates.add("/usr/include");
  candidates.add(`/usr/include/${opts.triplet}`);
  if (opts.gccIncludeDir) candidates.add(opts.gccIncludeDir);
  const candidateList = [...candidates].sort();
  let probeOutput = "";
  if (candidateList.length > 0) {
    const probe = await conn.exec(buildDirExistsCommand(candidateList));
    if (probe.code === 0) probeOutput = probe.stdout;
  }
  return collectFromParsedData(workspace, { findOutput: result.stdout, fileTexts, probeOutput }, opts);
}
