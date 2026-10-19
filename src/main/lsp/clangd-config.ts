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
  remoteAliases?: string[];  // 同一工作目录的软链接/真实路径（CMake 常输出 readlink -f 后的路径）
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
  // ROS2/colcon 等「源码与构建分离」布局把 compile_commands.json 放在源码树的兄弟构建目录
  // （~/ros2_ws/src/<pkg> → ~/ros2_ws/build/<pkg>）。只搜项目内会永远找不到，clangd 失去编译数据库。
  // 候选集保持有界：项目 build / 项目内 maxdepth 4 / 上层 build/<包名> / 上层 build maxdepth 2。
  const lines = [
    "{",
    `  if [ -d ${shellQuote(`${ws}/build`)} ]; then`,
    `    find ${shellQuote(`${ws}/build`)} -type f -name compile_commands.json;`,
    "  else",
    `    find ${shellQuote(ws)} -maxdepth 4 -type f -name compile_commands.json;`,
    "  fi;",
  ];
  // colcon 布局：项目是 <base>/src/<pkg>，构建产物在 <base>/build/<pkg>（祖父目录的兄弟）。
  // 只有路径足够深时才追加外层搜索，避免 /ws 这类短路径拼出 //build。
  const parts = ws.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const pkgName = parts[parts.length - 1];
    const base = "/" + parts.slice(0, -2).join("/");
    const outerBuild = `${base}/build`;
    const outerPkg = `${outerBuild}/${pkgName}`;
    lines.push(
      `  if [ -d ${shellQuote(outerPkg)} ]; then`,
      `    find ${shellQuote(outerPkg)} -type f -name compile_commands.json;`,
      `  elif [ -d ${shellQuote(outerBuild)} ]; then`,
      `    find ${shellQuote(outerBuild)} -maxdepth 2 -type f -name compile_commands.json;`,
      "  fi;",
    );
  }
  lines.push("} 2>/dev/null");
  return lines.join("\n");
}

/** 没有 compile_commands.json 时的 CMake 兜底：找同一构建目录里的 flags.make。
 *  colcon 默认 CMAKE_EXPORT_COMPILE_COMMANDS=OFF，但每个 target 的 flags.make 一定包含
 *  实际使用的 include / define / 标准参数。 */
export function buildCmakeFlagsFindCommand(workspace: string): string {
  const ws = workspace.replace(/\/+$/, "") || "/";
  const lines = [
    "{",
    `  if [ -d ${shellQuote(`${ws}/build`)} ]; then`,
    `    find ${shellQuote(`${ws}/build`)} -type f -path '*/CMakeFiles/*.dir/flags.make';`,
    "  else",
    `    find ${shellQuote(ws)} -maxdepth 5 -type f -path '*/CMakeFiles/*.dir/flags.make';`,
    "  fi;",
  ];
  const parts = ws.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const pkgName = parts[parts.length - 1];
    const base = "/" + parts.slice(0, -2).join("/");
    const outerPkg = `${base}/build/${pkgName}`;
    lines.push(
      `  if [ -d ${shellQuote(outerPkg)} ]; then`,
      `    find ${shellQuote(outerPkg)} -type f -path '*/CMakeFiles/*.dir/flags.make';`,
      "  fi;",
    );
  }
  lines.push("} 2>/dev/null");
  return lines.join("\n");
}

/** 头文件目录存在性探测（一条 exec）：只保留远端真实存在的目录 */
export function buildDirExistsCommand(dirs: string[]): string {
  const body = dirs.map((d) => `[ -d ${shellQuote(d)} ] && printf '%s\\n' ${shellQuote(d)}`).join("; ");
  return `${body}; true`;
}

/** 退化兜底（§5.3.6 / A9.3）：找不到 compile_commands.json 时给 clangd 的 compile_flags.txt */
export function buildCompileFlagsTxt(localPrefix: string, sysrootDirs?: string[], extraFlags: string[] = []): string {
  const p = localPrefix.replace(/[\\/]+$/, "");
  const lines: string[] = [];
  const add = (flag: string) => { if (!lines.includes(flag)) lines.push(flag); };
  if (!extraFlags.some((flag) => flag.startsWith("-std="))) add("-std=c++17");
  add(`-I${path.join(p, "include")}`);
  add(`-I${p}`);
  // 没有 compile_commands 时 clangd 读的是 compile_flags.txt：必须把镜像里的系统头目录也写成
  // -isystem，否则交叉编译下找不到目标架构的 C++ 标准库（std::* 全红）。
  for (const dir of sysrootDirs ?? []) {
    const rel = dir.replace(/^\/+/, "");
    if (!rel) continue;
    add(`-isystem${path.join(p, "_sysroot", ...rel.split("/"))}`);
  }
  // CMake flags.make 里已有的 -I/-isystem/-D/-std 等参数已经重写成镜像路径，最后并入兜底文件。
  for (const flag of extraFlags) if (flag) add(flag);
  return lines.join("\n") + "\n";
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

function distinctPrefixes(remotePrefix: string, aliases: string[] = []): string[] {
  return [...new Set([remotePrefix, ...aliases].map((p) => p.replace(/\/+$/, "")).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

/** 远端路径前缀替换（A9.1：只替换开头，不匹配的原样保留）。软链接别名优先匹配最长前缀。 */
export function rewriteRemotePrefix(value: string, remotePrefix: string, localPrefix: string, aliases: string[] = []): string {
  for (const remote of distinctPrefixes(remotePrefix, aliases)) {
    if (value === remote || value.startsWith(remote + "/")) {
      const rest = value.slice(remote.length).replace(/^\/+/, "");
      return rest ? path.join(localPrefix, ...rest.split("/")) : localPrefix;
    }
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
  if (distinctPrefixes(ctx.remotePrefix, ctx.remoteAliases).some((prefix) => isUnder(includePath, prefix))) {
    return { value: rewriteRemotePrefix(includePath, ctx.remotePrefix, ctx.localPrefix, ctx.remoteAliases), kind: "workspace" };
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
    out.push(bare.startsWith("/") ? shellQuote(rewriteRemotePrefix(bare, ctx.remotePrefix, ctx.localPrefix, ctx.remoteAliases)) : token);
  }
  return out;
}

/** 单条 compile command 的重写；args / command / 路径字段都覆盖（A9.1 + A9.4） */
export function rewriteCompileCommand(entry: CompileCommandEntry, ctx: CompileRewriteContext): RewriteResult {
  const dropped: string[] = [];
  const next: CompileCommandEntry = { ...entry };
  for (const key of ["directory", "file", "output"] as const) {
    const value = next[key];
    if (typeof value === "string") next[key] = rewriteRemotePrefix(value, ctx.remotePrefix, ctx.localPrefix, ctx.remoteAliases);
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
  return collectIncludeDirsFromFlags(tokens);
}

/** 从一串编译参数里抽出绝对 include 目录（flags.make 兜底同样复用）。 */
export function collectIncludeDirsFromFlags(tokens: string[]): string[] {
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

export interface CmakeFlags {
  includes: string[];
  defines: string[];
  flags: string[];
  args: string[];
}

/** flags.make 是 Makefile 片段：把 `-isystem /x` 统一成 `-isystem/x`，便于逐行写入 compile_flags。 */
function joinIncludeFlagPairs(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const bare = unquote(tokens[i]);
    const exact = INCLUDE_FLAGS.find((flag) => bare === flag);
    if (exact && tokens[i + 1] !== undefined) {
      out.push(exact + unquote(tokens[i + 1]));
      i++;
    } else {
      out.push(bare);
    }
  }
  return out;
}

function unescapeMakeToken(token: string): string {
  return token.replace(/\\(["'\\])/g, "$1");
}

/** 解析 CMake 生成的 flags.make。只取 CXX_*；值里的反斜杠续行先合并。 */
export function parseCmakeFlags(text: string): CmakeFlags {
  const logical = text.replace(/\\\r?\n/g, " ");
  const includes: string[] = [];
  const defines: string[] = [];
  const flags: string[] = [];
  for (const line of logical.split(/\r?\n/)) {
    const match = /^\s*(CXX_INCLUDES|CXX_DEFINES|CXX_FLAGS)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const tokens = splitCommandLine(match[2]).map(unquote).map(unescapeMakeToken);
    if (match[1] === "CXX_INCLUDES") includes.push(...joinIncludeFlagPairs(tokens));
    else if (match[1] === "CXX_DEFINES") defines.push(...tokens);
    else flags.push(...tokens);
  }
  return {
    includes,
    defines: [...new Set(defines)],
    flags: [...new Set(flags)],
    args: [...includes, ...new Set([...defines, ...flags])],
  };
}

/** 把 flags.make 参数重写到本地镜像；未知的绝对头目录映射到 _sysroot。 */
export function rewriteCompileFlags(tokens: string[], ctx: CompileRewriteContext): { flags: string[]; dropped: string[] } {
  const flags: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const bare = unquote(token);
    const exact = INCLUDE_FLAGS.find((f) => bare === f);
    if (exact) {
      const next = tokens[i + 1];
      if (next === undefined) { flags.push(token); continue; }
      const cls = classifyIncludePath(unquote(next), ctx);
      if (cls.value === null) dropped.push(unquote(next));
      else flags.push(exact + cls.value);
      i++;
      continue;
    }
    const joined = INCLUDE_FLAGS.find((f) => bare.startsWith(f) && bare.length > f.length);
    if (joined) {
      const cls = classifyIncludePath(bare.slice(joined.length), ctx);
      if (cls.value === null) dropped.push(bare.slice(joined.length));
      else flags.push(joined + cls.value);
      continue;
    }
    flags.push(bare);
  }
  return { flags, dropped };
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
  opts: {
    mirrorRoot: string;
    triplet: string;
    gccIncludeDir?: string;
    systemIncludeDirs?: string[];
    remoteAliases?: string[];
    fallbackFlags?: string[];
  },
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
    if (!distinctPrefixes(ws, opts.remoteAliases).some((prefix) => isUnder(d, prefix))) candidates.add(d);
  }
  for (const d of collectIncludeDirsFromFlags(opts.fallbackFlags ?? [])) {
    if (!distinctPrefixes(ws, opts.remoteAliases).some((prefix) => isUnder(d, prefix))) candidates.add(d);
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
  // 目标架构的 C++ 标准库 / 系统头目录（来自 __CAP__ 段，远端已存在性校验）：
  // 这些不走 probe 过滤（probe 依赖 compile_commands，没有编译数据库时是空的）。
  // 少了它们，交叉编译下 std/uint8_t/chrono 全部报未定义。
  for (const d of opts.systemIncludeDirs ?? []) {
    if (d.startsWith("/") && !sysrootRoots.includes(d)) sysrootRoots.push(d);
  }
  sysrootRoots = [...new Set(sysrootRoots)].sort();

  const ctx: CompileRewriteContext = {
    remotePrefix: ws,
    remoteAliases: opts.remoteAliases,
    localPrefix: opts.mirrorRoot,
    sysrootRoots,
    localSysrootPrefix: path.join(opts.mirrorRoot, "_sysroot"),
  };
  const merged = mergeCompileCommands(parsed, ctx);
  const droppedIncludes = [...new Set(merged.dropped)];
  const fallback = rewriteCompileFlags(opts.fallbackFlags ?? [], ctx);
  droppedIncludes.push(...fallback.dropped.filter((d) => !droppedIncludes.includes(d)));
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
  fs.writeFileSync(compileFlagsPath, buildCompileFlagsTxt(opts.mirrorRoot, sysrootRoots, fallback.flags), "utf8");
  return {
    kind: "compile_flags", outputPath: compileFlagsPath, entryCount: 0,
    sourceFiles: files, sysrootRoots, droppedIncludes, warnings,
  };
}

/**
 * 独立收集（§5.3.6）：1 条 find + 逐个小文件 SFTP + 1 条目录存在性探测。
 * 仅用于非「同一条复合命令」场景（如测试或手动收集）。
 */
export async function collectCmakeFlagsFallback(
  conn: SSHConnection,
  workspace: string,
  opts: {
    mirrorRoot: string;
    triplet: string;
    gccIncludeDir?: string;
    systemIncludeDirs?: string[];
    remoteAliases?: string[];
  },
): Promise<CompileCollection> {
  const ws = workspace.replace(/\/+$/, "") || "/";
  const result = await conn.exec(buildCmakeFlagsFindCommand(ws));
  const files = [...new Set(result.stdout.split("\n").map((l) => l.trim()).filter(Boolean))].sort();
  const fallbackFlags: string[] = [];
  for (const file of files) {
    const parsed = parseCmakeFlags(await readRemoteText(conn, file));
    fallbackFlags.push(...parsed.args);
  }
  const uniqueFlags = [...new Set(fallbackFlags)];
  const candidates = new Set<string>();
  for (const d of collectIncludeDirsFromFlags(uniqueFlags)) {
    if (!distinctPrefixes(ws, opts.remoteAliases).some((prefix) => isUnder(d, prefix))) candidates.add(d);
  }
  candidates.add("/usr/include");
  candidates.add(`/usr/include/${opts.triplet}`);
  if (opts.gccIncludeDir) candidates.add(opts.gccIncludeDir);
  let probeOutput = "";
  const candidateList = [...candidates].sort();
  if (candidateList.length > 0) {
    const probe = await conn.exec(buildDirExistsCommand(candidateList));
    if (probe.code === 0) probeOutput = probe.stdout;
  }
  const collected = collectFromParsedData(ws, { findOutput: "", fileTexts: {}, probeOutput }, {
    ...opts,
    fallbackFlags: uniqueFlags,
  });
  collected.sourceFiles = files;
  return collected;
}

export async function collectCompileCommands(
  conn: SSHConnection,
  workspace: string,
  opts: {
    mirrorRoot: string;
    triplet: string;
    gccIncludeDir?: string;
    systemIncludeDirs?: string[];
    remoteAliases?: string[];
  },
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
  if (parsed.every((file) => file.entries.length === 0)) {
    return collectCmakeFlagsFallback(conn, ws, opts);
  }
  for (const f of parsed) for (const e of f.entries) for (const d of collectIncludeDirs(e)) {
    if (!distinctPrefixes(ws, opts.remoteAliases).some((prefix) => isUnder(d, prefix))) candidates.add(d);
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
