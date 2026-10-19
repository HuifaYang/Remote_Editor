// 把远端编译数据库重写到本地只读 SSHFS 前缀，让本机 clangd 看到与远端一致的整棵文件系统。
// 这里不复制源码或系统头；所有路径都是按需读取的 SSHFS 视图。
import * as fs from "node:fs";
import * as path from "node:path";
import type { SSHConnection } from "../session/connection.js";
import {
  buildCmakeFlagsFindCommand,
  buildCompileCommandsFindCommand,
  parseCmakeFlags,
  splitCommandLine,
  type CompileCommandEntry,
} from "./clangd-config.js";
import { mountedRemotePath } from "./sshfs-mount.js";

export interface MountedWorkspaceOptions {
  conn: SSHConnection;
  remoteRoot: string;
  mountRoot: string;
  cacheDir: string;
  onLog?: (line: string) => void;
}

export interface MountedWorkspace {
  localRoot: string;
  compileCommandsDir: string;
  targetTriplet: string;
  systemIncludeDirs: string[];
  entryCount: number;
}

export async function prepareMountedWorkspace(opts: MountedWorkspaceOptions): Promise<MountedWorkspace> {
  const localRoot = mountedRemotePath(opts.mountRoot, opts.remoteRoot);
  const compileCommandsDir = path.join(opts.cacheDir, "compile");
  fs.mkdirSync(compileCommandsDir, { recursive: true });
  const targetTriplet = await detectTriplet(opts.conn);
  const systemIncludeDirs = await detectCxxIncludeDirs(opts.conn);
  const defaultCxxStandard = await detectDefaultCxxStandard(opts.conn);

  const files = await findFiles(opts.conn, buildCompileCommandsFindCommand(opts.remoteRoot));
  const entries: CompileCommandEntry[] = [];
  for (const file of files) {
    const local = mountedRemotePath(opts.mountRoot, file);
    try {
      const parsed = JSON.parse(await fs.promises.readFile(local, "utf8")) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (entry && typeof entry === "object") entries.push(entry as CompileCommandEntry);
      }
    } catch (err) {
      opts.onLog?.(`读取编译数据库失败 ${file}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (entries.length === 0) {
    entries.push(...await collectCmakeCompileCommands(opts, targetTriplet, defaultCxxStandard));
  }

  if (entries.length > 0) {
    const rewritten = entries.map((entry) => rewriteMountedCompileCommand(
      entry,
      opts.mountRoot,
      targetTriplet,
      systemIncludeDirs,
      defaultCxxStandard ?? undefined,
    ));
    fs.writeFileSync(path.join(compileCommandsDir, "compile_commands.json"), `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
    fs.rmSync(path.join(compileCommandsDir, "compile_flags.txt"), { force: true });
    opts.onLog?.(`已挂载编译数据库：${rewritten.length} 条，系统头 ${systemIncludeDirs.length} 个`);
    return { localRoot, compileCommandsDir, targetTriplet, systemIncludeDirs, entryCount: rewritten.length };
  }

  const fallbackFlags = await collectBestFallbackFlags(opts);
  const mountedFlags = rewriteMountedFlags(fallbackFlags, opts.mountRoot);
  // 不能对整行去重：多个 -isystem 后面各自必须跟一个目录，否则 clangd 会把目录当输入文件。
  const lines = [
    `--target=${targetTriplet}`,
    ...(defaultCxxStandard ? [`-std=${defaultCxxStandard}`] : []),
    ...mountedFlags,
    ...systemIncludeDirs.flatMap((dir) => ["-isystem", mountedRemotePath(opts.mountRoot, dir)]),
  ];
  fs.writeFileSync(path.join(compileCommandsDir, "compile_flags.txt"), `${lines.join("\n")}\n`, "utf8");
  fs.rmSync(path.join(compileCommandsDir, "compile_commands.json"), { force: true });
  opts.onLog?.(`远端没有可识别的源文件 target，已生成挂载 flags：${mountedFlags.length} 项，系统头 ${systemIncludeDirs.length} 个`);
  return { localRoot, compileCommandsDir, targetTriplet, systemIncludeDirs, entryCount: 0 };
}

export function rewriteMountedCompileCommand(
  entry: CompileCommandEntry,
  mountRoot: string,
  targetTriplet: string,
  systemIncludeDirs: string[],
  defaultCxxStandard?: string,
): CompileCommandEntry {
  const out: CompileCommandEntry = { ...entry };
  for (const key of ["directory", "file", "output"] as const) {
    if (typeof out[key] === "string") out[key] = mountedRemotePath(mountRoot, out[key] as string);
  }
  const extras = [`--target=${targetTriplet}`];
  if (defaultCxxStandard && !hasCxxStandard(out)) extras.push(`-std=${defaultCxxStandard}`);
  for (const dir of systemIncludeDirs) extras.push("-isystem", mountedRemotePath(mountRoot, dir));
  if (Array.isArray(out.arguments)) {
    out.arguments = [...out.arguments.map((token) => rewriteMountedToken(token, mountRoot)), ...extras];
  } else if (typeof out.command === "string") {
    out.command = [...splitCommandLine(out.command).map((token) => rewriteMountedToken(token, mountRoot)), ...extras]
      .map(shellQuote)
      .join(" ");
  }
  return out;
}

export function rewriteMountedFlags(tokens: string[], mountRoot: string): string[] {
  return tokens.map((token) => rewriteMountedToken(token, mountRoot));
}

function rewriteMountedToken(token: string, mountRoot: string): string {
  for (const prefix of ["-I", "-isystem", "-iquote"]) {
    if (token.startsWith(prefix) && token.length > prefix.length) {
      return prefix + mountedRemotePath(mountRoot, token.slice(prefix.length));
    }
  }
  if (token.startsWith("--sysroot=")) return `--sysroot=${mountedRemotePath(mountRoot, token.slice("--sysroot=".length))}`;
  if (token.startsWith("/")) return mountedRemotePath(mountRoot, token);
  return token;
}

async function findFiles(conn: SSHConnection, command: string): Promise<string[]> {
  const result = await conn.exec(command, { timeoutMs: 30000 });
  return [...new Set(result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/")))];
}

async function collectCmakeCompileCommands(
  opts: MountedWorkspaceOptions,
  targetTriplet: string,
  defaultCxxStandard: string | null,
): Promise<CompileCommandEntry[]> {
  const flagsFiles = (await findFiles(opts.conn, buildCmakeFlagsFindCommand(opts.remoteRoot)))
    // 同一个源文件可能出现在多个 target；优先普通业务 target，避免 rosidl 生成目标覆盖主程序 flags。
    .sort((a, b) => Number(a.includes("__rosidl_")) - Number(b.includes("__rosidl_")));
  const entries: CompileCommandEntry[] = [];
  const seen = new Set<string>();
  for (const flagsFile of flagsFiles) {
    const localFlags = mountedRemotePath(opts.mountRoot, flagsFile);
    let flagsText: string;
    let buildText: string;
    try {
      [flagsText, buildText] = await Promise.all([
        fs.promises.readFile(localFlags, "utf8"),
        fs.promises.readFile(path.join(path.dirname(localFlags), "build.make"), "utf8"),
      ]);
    } catch {
      continue;
    }
    const parsed = parseCmakeFlags(flagsText);
    if (parsed.args.length === 0) continue;
    const directory = path.posix.dirname(path.posix.dirname(path.posix.dirname(flagsFile)));
    for (const source of parseCmakeSources(buildText)) {
      if (seen.has(source)) continue;
      seen.add(source);
      const args = ["/usr/bin/c++", ...parsed.args];
      if (defaultCxxStandard && !args.some((arg) => arg.startsWith("-std="))) args.push(`-std=${defaultCxxStandard}`);
      args.push("-c", source);
      entries.push({ directory, file: source, arguments: args });
    }
  }
  if (entries.length > 0) opts.onLog?.(`从 CMake flags 生成 ${entries.length} 条逐文件编译命令（target=${targetTriplet}）`);
  return entries;
}

/** 从 CMake build.make 中提取目标依赖行里的 C/C++ 源文件。 */
export function parseCmakeSources(buildMake: string): string[] {
  const out: string[] = [];
  const logical = buildMake.replace(/\\\r?\n/g, " ");
  for (const line of logical.split(/\r?\n/)) {
    const match = /^CMakeFiles\/.+\.(?:c|cc|cpp|cxx|m|mm)\.o:\s+(\/[^\s]+)\s*$/.exec(line.trim());
    if (match?.[1]) out.push(match[1].replace(/\\ /g, " "));
  }
  return [...new Set(out)];
}

async function collectBestFallbackFlags(opts: MountedWorkspaceOptions): Promise<string[]> {
  const flagsFiles = (await findFiles(opts.conn, buildCmakeFlagsFindCommand(opts.remoteRoot)))
    .sort((a, b) => Number(a.includes("__rosidl_")) - Number(b.includes("__rosidl_")));
  for (const file of flagsFiles) {
    try {
      const text = await fs.promises.readFile(mountedRemotePath(opts.mountRoot, file), "utf8");
      const flags = parseCmakeFlags(text).args;
      if (flags.length > 0) return flags;
    } catch {
      // 换下一个 target
    }
  }
  return [];
}

async function detectTriplet(conn: SSHConnection): Promise<string> {
  for (const command of ["gcc -dumpmachine", "cc -dumpmachine", "clang -dumpmachine"]) {
    const result = await conn.exec(command, { timeoutMs: 8000 });
    const value = result.stdout.trim().split(/\s+/)[0];
    if (result.code === 0 && value) return value;
  }
  return "x86_64-linux-gnu";
}

async function detectDefaultCxxStandard(conn: SSHConnection): Promise<string | null> {
  const result = await conn.exec("g++ -dM -E -x c++ /dev/null | grep __cplusplus", { timeoutMs: 10000 });
  const value = Number.parseInt(String(result.stdout.trim().split(/\s+/).pop() || "").replace(/L$/, ""), 10);
  if (value >= 202302) return "gnu++23";
  if (value >= 202002) return "gnu++20";
  if (value >= 201703) return "gnu++17";
  if (value >= 201402) return "gnu++14";
  if (value >= 201103) return "gnu++11";
  return null;
}

function hasCxxStandard(entry: CompileCommandEntry): boolean {
  if (Array.isArray(entry.arguments)) return entry.arguments.some((arg) => arg.startsWith("-std="));
  return typeof entry.command === "string" && /(?:^|\s)-std=/.test(entry.command);
}

/** GCC 的 `-E -v` 会把目标 C++ 标准库/系统头路径输出到 stderr。 */
async function detectCxxIncludeDirs(conn: SSHConnection): Promise<string[]> {
  for (const command of [
    "g++ -E -x c++ - -v < /dev/null",
    "c++ -E -x c++ - -v < /dev/null",
    "clang++ -E -x c++ - -v < /dev/null",
  ]) {
    const result = await conn.exec(command, { timeoutMs: 12000 });
    const dirs = parseIncludeSearch(result.stderr);
    if (dirs.length) return dirs;
  }
  return [];
}

export function parseIncludeSearch(stderr: string): string[] {
  const lines = stderr.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("#include <...> search starts here:"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.includes("End of search list.")) break;
    const value = line.trim().replace(/\s+\(framework directory\)$/, "");
    if (value.startsWith("/")) out.push(value);
  }
  return [...new Set(out)];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
