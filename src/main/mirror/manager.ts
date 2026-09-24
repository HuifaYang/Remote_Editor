// 环境镜像（总纲 §5.3；增量算法见分册 1 A8b，compile_commands 见 A9）
// 核心约束：首次同步 = 1 条 SSH 命令 + tar 单流，禁止逐文件 SFTP；增量用远端时钟，禁止用工作机时钟。
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError } from "../../shared/errors.js";
import { normalizeRemotePath, shellQuote } from "../../shared/paths.js";
import type { MirrorEntry, MirrorProgress, MirrorResult } from "../../shared/types.js";
import { log } from "../log.js";
import { buildCompileCommandsFindCommand, buildDirExistsCommand, collectFromParsedData, type CompileCollection } from "../lsp/clangd-config.js";
import type { SSHConnection } from "../session/connection.js";
import {
  createManifest, diffManifest, mirrorRelativePath, parseFindListing, parseManifest,
  serializeManifest, toEntryMap, type MirrorManifest,
} from "./manifest.js";
import { extractTarGz } from "./tar.js";

/** 排除规则（§5.3.2，必须排除） */
export const MIRROR_EXCLUDE_PATHS = ["./build/*", "./install/*", "./log/*", "./.git/*", "./.cache/*", "*/__pycache__/*"];
export const MIRROR_EXCLUDE_NAMES = ["*.pyc"];

/** 全量同步时跨镜像替换保留的辅助目录/文件（源码之外的部分） */
const AUX_NAMES = ["_sysroot", "_pyenv", "compile_commands.json", "compile_flags.txt", "manifest.json"];

function excludeArgs(): string {
  return [
    ...MIRROR_EXCLUDE_PATHS.map((p) => `-not -path '${p}'`),
    ...MIRROR_EXCLUDE_NAMES.map((n) => `-not -name '${n}'`),
  ].join(" ");
}

/** 文件清单命令（A8b：清单走 stderr，别混进 gzip 流） */
export function buildListingCommand(): string {
  return `find . -type f ${excludeArgs()} -printf '%p %s %T@\\n' 1>&2`;
}

/** 分段头（同一条复合命令里把不同用途的输出区隔开） */
const SECTION = "__RCE_SECTION__";
export function buildCapabilitiesCommand(): string {
  return `${SECTION}__CAP__ 1>&2; tar --version 2>&1 || true; gcc -dumpmachine 2>/dev/null || true; gcc -print-file-name=include 2>/dev/null || true`;
}
export function buildCompileFindSection(workspace: string): string {
  return `${SECTION}__FIND__ 1>&2; ${buildCompileCommandsFindCommand(workspace)} 1>&2`;
}
export function buildCompileDumpSection(findOutput: string): string {
  const files = findOutput.split("\n").map((l) => l.trim()).filter(Boolean);
  if (files.length === 0) return "";
  return files.map((f) => `${SECTION}__FILE__ ${shellQuote(f)} 1>&2; cat ${shellQuote(f)} 1>&2`).join("; ");
}
export function buildProbeSection(dirs: string[]): string {
  if (dirs.length === 0) return "";
  return `${SECTION}__PROBE__ 1>&2; ${buildDirExistsCommand(dirs)} 1>&2`;
}
export function buildPythonSysPathSection(): string {
  return `${SECTION}__PYPATH__ 1>&2; python3 -c "import sys,json;print(json.dumps(sys.path))" 2>/dev/null || true`;
}

/** 全量同步：1 条命令；能力探测 + compile_commands find + 文件 dump + 目录探测 + sys.path 都塞进 stderr 分段 */
export function buildFullSyncCommand(workspace: string): string {
  return `cd ${shellQuote(workspace)} && { date +%s 1>&2; ${buildCapabilitiesCommand()}; find . -type f ${excludeArgs()} -print0 | tar --null -czf - -T - && ${buildListingCommand()}; ${buildCompileFindSection(workspace)}; ${buildCompileDumpSection("")}; ${buildProbeSection([])}; ${buildPythonSysPathSection()}; }`;
}

/** 增量同步（A8b，源码与 sysroot 通用）：仍是 1 条命令；增量场景保留原有格式 */
export function buildIncrementalSyncCommand(workspace: string, sinceEpoch: number): string {
  return `cd ${shellQuote(workspace)} && { date +%s 1>&2; find . -type f -newermt '@${Math.floor(sinceEpoch)}' ${excludeArgs()} -print0 | tar --null -czf - -T - && ${buildListingCommand()}; }`;
}

/** sysroot：只留头文件（排除 *.a / *.so*），保留原绝对路径层级（提取到 _sysroot/ 下） */
export function buildSysrootTarCommand(dirs: string[], sinceEpoch = 0): string {
  const rel = [...new Set(dirs)].map((d) => d.replace(/^\/+/, "").replace(/\/+$/, "")).filter(Boolean).sort();
  if (rel.length === 0) return "";
  const list = rel.map((d) => shellQuote(d)).join(" ");
  if (sinceEpoch > 0) {
    return `cd / && find ${list} -type f -newermt '@${Math.floor(sinceEpoch)}' -not -name '*.a' -not -name '*.so*' -print0 | tar --null -czf - -T -`;
  }
  return `cd / && tar czf - --exclude='*.a' --exclude='*.so*' ${list}`;
}

/** Python 环境：只拉纯 Python 部分（*.so / *.pyd 是 aarch64 的，工作机加载不了） */
export function buildPythonEnvTarCommand(dirs: string[]): string {
  const rel = [...new Set(dirs)].map((d) => d.replace(/^\/+/, "").replace(/\/+$/, "")).filter(Boolean).sort();
  if (rel.length === 0) return "";
  return `cd / && tar czf - --exclude='*.so' --exclude='*.pyd' ${rel.map((d) => shellQuote(d)).join(" ")}`;
}

/** `_pyenv/sitecustomize.py`：把镜像里的 site-packages prepend 进 sys.path（§5.3.7） */
export function buildSiteCustomize(remoteDirs: string[]): string {
  const rel = remoteDirs.map((d) => d.replace(/^\/+/, ""));
  return [
    "# 由 RemoteCodeEditor 生成：镜像内的 Python 环境路径（不落任何远端状态）",
    "import os, sys",
    "__base__ = os.path.dirname(os.path.abspath(__file__))",
    `__dirs__ = ${JSON.stringify(rel, null, 4)}`,
    "for __rel in __dirs__:",
    "    __p = os.path.join(__base__, *__rel.split('/'))",
    "    if os.path.isdir(__p) and __p not in sys.path:",
    "        sys.path.insert(0, __p)",
    "del __rel, __p",
    "",
  ].join("\n");
}

export interface MirrorOptions {
  /** 规格未覆盖：测试注入解压实现；生产用纯 Node 解包（不依赖工作机 tar） */
  extractTarGz?: (tarPath: string, destDir: string) => Promise<void>;
}

export class MirrorManager {
  private workspace = "";
  private syncedAt = 0;
  private entries = new Map<string, MirrorEntry>();
  private sysrootRoots: string[] = [];
  private lastSysrootRoots: string[] | null = null;
  private gccIncludeDir = "";
  private triplet = "";
  private tarChecked = false;
  private compile: CompileCollection | null = null;
  private lastSections: { cap?: string; find?: string; fileTexts?: Record<string, string>; probe?: string; pyPath?: string; listing?: string } | null = null;

  constructor(
    private readonly conn: SSHConnection,
    private readonly mirrorRoot: string,
    private readonly opts: MirrorOptions = {},
  ) {}

  /** 镜像清单（相对镜像根） */
  manifest(): Map<string, MirrorEntry> {
    return new Map(this.entries);
  }

  /** 当前镜像对应的远端工作目录（空串 = 还没同步过） */
  get workspaceRoot(): string {
    return this.workspace;
  }

  /** 镜像根（语言服务 cwd / rootUri 用） */
  get root(): string {
    return this.mirrorRoot;
  }

  /** clangd 必须带 --target（§5.3.10），否则 #ifdef __aarch64__ 走错分支 */
  get targetTriplet(): string {
    return this.triplet || "aarch64-linux-gnu";
  }

  get sysrootPrefix(): string {
    return path.join(this.mirrorRoot, "_sysroot");
  }

  get compileInfo(): CompileCollection | null {
    return this.compile;
  }

  /** §5.3.4：远端绝对路径 → 本地镜像路径（按相对层级换算，禁止字符串替换 hack） */
  localPathOf(remotePath: string): string {
    const rel = mirrorRelativePath(this.workspace, normalizeRemotePath(remotePath, "/"), this.sysrootRoots);
    if (rel === null) throw new AppError("invalid-input", "路径不在镜像范围内", remotePath);
    return rel === "" ? this.mirrorRoot : path.join(this.mirrorRoot, ...rel.split("/"));
  }

  remotePathOf(localPath: string): string {
    const rel = path.relative(this.mirrorRoot, localPath).split(path.sep).join("/");
    if (rel.startsWith("_sysroot/")) return "/" + rel.slice("_sysroot/".length);
    if (rel === "" ) return this.workspace;
    const ws = this.workspace.replace(/\/+$/, "");
    return `${ws}/${rel}`;
  }

  /** 打开远端路径对应的本地镜像文件（LSP 用；_sysroot 例外返回 null） */
  mirrorFileOf(remotePath: string): string | null {
    try {
      return this.localPathOf(remotePath);
    } catch {
      return null;
    }
  }

  /**
   * 同步镜像（§5.3.1 / A8b）：源码 tar 单流 + 清单差集 + compile_commands 重写 + sysroot + Python 环境。
   */
  async sync(workspace: string, onProgress?: (p: MirrorProgress) => void): Promise<MirrorResult> {
    const ws = normalizeRemotePath(workspace, "/");
    await this.ensureCapabilities();
    if (this.workspace && this.workspace !== ws) this.resetState();
    const sameWorkspace = this.workspace === ws;
    const since = sameWorkspace ? this.syncedAt : 0;
    const oldEntries = sameWorkspace ? new Map(this.entries) : new Map<string, MirrorEntry>();

    log("info", `镜像同步开始：${ws}（${since > 0 ? "增量" : "全量"}）`);
    onProgress?.({ done: 0, total: 5, current: since > 0 ? "增量同步源码…" : "全量同步源码…" });
    const source = await this.pullSource(ws, since);
    const nextEntries = parseFindListing(source.listing);
    const diff = diffManifest(oldEntries, nextEntries);
    for (const removed of diff.removed) this.removeLocal(removed);

    this.workspace = ws;
    this.syncedAt = source.syncedAt;
    this.entries = toEntryMap(nextEntries);
    this.writeManifest();

    const totalBytes = nextEntries.reduce((sum, e) => sum + e.size, 0);
    const baseResult: MirrorResult = {
      root: this.mirrorRoot,
      fileCount: nextEntries.length,
      totalBytes,
      changed: diff.changed.map((e) => e.path),
      removed: diff.removed,
    };
    onProgress?.({ done: 1, total: 5, current: `源码已同步（${nextEntries.length} 个文件）` });

    // compile_commands.json 收集与重写（A9）：从同一条复合命令的分段数据构建，0 额外往返
    try {
      this.compile = collectFromParsedData(ws, {
        findOutput: this.lastSections?.find ?? "",
        fileTexts: this.lastSections?.fileTexts ?? {},
        probeOutput: this.lastSections?.probe ?? "",
      }, {
        mirrorRoot: this.mirrorRoot,
        triplet: this.targetTriplet,
        gccIncludeDir: this.gccIncludeDir,
      });
      log("info", `compile_commands 来源 ${this.compile.sourceFiles.length} 个，条目 ${this.compile.entryCount} 个`);
    } catch (err) {
      log("warn", `compile_commands 收集失败：${String(err)}`);
      this.compile = null;
    }
    onProgress?.({ done: 2, total: 5, current: "已重写 compile_commands.json" });

    // 头文件 / sysroot（§5.3.8）：目录集合变了就全量，没变才走时间戳增量
    const dirs = this.compile?.sysrootRoots ?? [];
    this.sysrootRoots = dirs;
    if (dirs.length > 0) {
      const sameSet = this.lastSysrootRoots !== null && sameList(this.lastSysrootRoots, dirs);
      const sysrootSince = sameSet ? since : 0;
      try {
        await this.pullAux(buildSysrootTarCommand(dirs, sysrootSince), path.join(this.mirrorRoot, "_sysroot"), "头文件");
        this.lastSysrootRoots = [...dirs];
      } catch (err) {
        log("warn", `sysroot 同步失败（补全可能不完整）：${String(err)}`);
      }
    }
    onProgress?.({ done: 3, total: 5, current: `已同步头文件（${dirs.length} 个目录）` });

    try {
      await this.pullPythonEnv();
    } catch (err) {
      log("warn", `Python 环境同步失败（不用 Python 可忽略）：${String(err)}`);
    }
    onProgress?.({ done: 4, total: 5, current: "已同步 Python 环境" });
    onProgress?.({ done: 5, total: 5, current: "镜像就绪" });
    log("info", `镜像同步完成：${nextEntries.length} 个文件，变更 ${diff.changed.length}，删除 ${diff.removed.length}`);
    return baseResult;
  }

  /** 保存文件后同步写镜像副本（§5.3.5），并本地更新清单 */
  async applyLocalSave(remotePath: string, text: string, encoding: string, newline: string): Promise<void> {
    const local = this.localPathOf(remotePath);
    const normalized = text.replace(/\r\n/g, "\n");
    const body = newline === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
    let buf = Buffer.from(body, "utf8");
    if (encoding === "utf8-bom") buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, buf);
    const rel = mirrorRelativePath(this.workspace, normalizeRemotePath(remotePath, "/"), this.sysrootRoots);
    if (rel) {
      const st = fs.statSync(local);
      this.entries.set(rel, { path: rel, size: st.size, mtime: st.mtimeMs / 1000 });
      this.writeManifest();
    }
  }

  // ---- 内部实现 ----

  private resetState(): void {
    this.syncedAt = 0;
    this.entries = new Map();
    this.sysrootRoots = [];
    this.lastSysrootRoots = null;
    this.compile = null;
  }

  /** tar 能力探测 + target 三元组：优先用同一条复合命令里的分段数据（0 额外往返） */
  private async ensureCapabilities(): Promise<void> {
    if (this.lastSections?.cap) {
      this.applyCapabilitiesFromSections(this.lastSections.cap);
      return;
    }
    // 兜底（首次构建命令前没有 sections，理论不可达）：单独探测
    const r = await this.conn.exec("tar --version 2>&1 || echo __RCE_NO_TAR__");
    const out = `${r.stdout}${r.stderr}`;
    if (!/tar|busybox/i.test(out) || out.includes("__RCE_NO_TAR__")) {
      throw new AppError("unsupported", "远端缺少 tar 命令，无法同步环境镜像", out.trim());
    }
    this.tarChecked = true;
  }

  private applyCapabilitiesFromSections(cap: string): void {
    if (!this.tarChecked) {
      if (!/tar|busybox/i.test(cap)) {
        throw new AppError("unsupported", "远端缺少 tar 命令，无法同步环境镜像", cap.trim());
      }
      this.tarChecked = true;
    }
    if (!this.triplet) {
      const lines = cap.split("\n").map((l) => l.trim()).filter(Boolean);
      const triplet = lines.find((l) => /^\w+(-\w+)+$/.test(l)) ?? "";
      if (triplet) this.triplet = triplet;
      else {
        this.triplet = "aarch64-linux-gnu";
        log("warn", "远端取不到 gcc 三元组，回退 aarch64-linux-gnu");
      }
      const includeDir = lines.find((l) => l.startsWith("/")) ?? "";
      this.gccIncludeDir = includeDir.startsWith("/") ? includeDir : "";
    }
  }

  /** 拉源码 tar 流并解包；返回远端时间戳与文件清单 */
  private async pullSource(workspace: string, since: number): Promise<{ listing: string; syncedAt: number }> {
    const incremental = since > 0;
    const runOnce = async (useSince: number): Promise<{ listing: string; syncedAt: number }> => {
      const tarPath = `${this.mirrorRoot}.sync.tar.gz`;
      const staging = `${this.mirrorRoot}.staging`;
      fs.mkdirSync(path.dirname(this.mirrorRoot), { recursive: true });
      removeDir(staging);
      fs.mkdirSync(useSince > 0 ? this.mirrorRoot : staging, { recursive: true });

      const command = useSince > 0
        ? buildIncrementalSyncCommand(workspace, useSince)
        : buildFullSyncCommand(workspace);
      const handle = await this.conn.execStream(command, { timeoutMs: 0 });
      try {
        await pipeline(handle.stdout, fs.createWriteStream(tarPath));
        const { code, stderr } = await handle.wait();
        if (code !== 0) throw new AppError("mirror", "镜像同步命令失败", stderr.trim());
        const sections = parseSections(stderr);
        this.lastSections = sections;
        const { listing, syncedAt } = splitStderr(sections.listing ?? "");
        this.applyCapabilitiesFromSections(sections.cap ?? "");


        if (useSince > 0) {
          await this.extract(tarPath, this.mirrorRoot);
        } else {
          await this.extract(tarPath, staging);
          this.carryOverAux(staging);
          removeDir(this.mirrorRoot);
          fs.renameSync(staging, this.mirrorRoot);
        }
        return { listing, syncedAt };
      } finally {
        fs.rmSync(tarPath, { force: true });
        if (!fs.existsSync(this.mirrorRoot) && fs.existsSync(staging)) fs.renameSync(staging, this.mirrorRoot);
        else removeDir(staging);
      }
    };

    if (!incremental) return runOnce(0);
    try {
      return await runOnce(since);
    } catch (err) {
      log("warn", `增量同步失败，退化为全量重传：${String(err)}`);
      return runOnce(0);
    }
  }

  /** sysroot / Python 环境这类「一条 tar 命令 → 解到指定目录」的公共实现 */
  private async pullAux(command: string, destDir: string, what: string): Promise<void> {
    if (!command) return;
    const tarPath = `${destDir}.sync.tar.gz`;
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    const handle = await this.conn.execStream(command, { timeoutMs: 0 });
    try {
      await pipeline(handle.stdout, fs.createWriteStream(tarPath));
      const { code, stderr } = await handle.wait();
      if (code !== 0) throw new AppError("mirror", `${what}同步失败`, stderr.trim());
      fs.mkdirSync(destDir, { recursive: true });
      await this.extract(tarPath, destDir);
    } finally {
      fs.rmSync(tarPath, { force: true });
    }
  }

  private async pullPythonEnv(): Promise<void> {
    const r = await this.conn.exec(`python3 -c "import sys,json;print(json.dumps(sys.path))"`);
    if (r.code !== 0) {
      log("warn", "远端没有 python3，跳过 Python 环境同步");
      return;
    }
    let dirs: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.stdout.trim());
      if (Array.isArray(parsed)) dirs = parsed.filter((d): d is string => typeof d === "string" && d.startsWith("/"));
    } catch (err) {
      log("warn", `解析远端 sys.path 失败：${String(err)}`);
      return;
    }
    if (dirs.length === 0) return;
    await this.pullAux(buildPythonEnvTarCommand(dirs), path.join(this.mirrorRoot, "_pyenv"), "Python 环境");
    fs.writeFileSync(path.join(this.mirrorRoot, "_pyenv", "sitecustomize.py"), buildSiteCustomize(dirs), "utf8");
  }

  /** 全量解包时把源码之外的辅助目录带过镜像替换（否则每次 F5 都白拉 sysroot） */
  private carryOverAux(staging: string): void {
    for (const name of AUX_NAMES) {
      const from = path.join(this.mirrorRoot, name);
      const to = path.join(staging, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.renameSync(from, to);
      }
    }
  }

  private extract(tarPath: string, destDir: string): Promise<void> {
    return (this.opts.extractTarGz ?? extractTarGz)(tarPath, destDir);
  }

  private removeLocal(relPath: string): void {
    const abs = path.join(this.mirrorRoot, ...relPath.split("/"));
    fs.rmSync(abs, { force: true });
    let dir = path.dirname(abs);
    while (dir.startsWith(this.mirrorRoot) && dir !== this.mirrorRoot) {
      try {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  private writeManifest(): void {
    fs.mkdirSync(this.mirrorRoot, { recursive: true });
    const manifest: MirrorManifest = createManifest(this.workspace, this.syncedAt, [...this.entries.values()]);
    fs.writeFileSync(path.join(this.mirrorRoot, "manifest.json"), serializeManifest(manifest), "utf8");
  }

  /** 读取上次落盘的 manifest（重启后仍可增量），坏文件安全跳过 */
  loadPersistedManifest(workspace: string): void {
    const file = path.join(this.mirrorRoot, "manifest.json");
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    const manifest = parseManifest(raw);
    if (!manifest || manifest.workspace !== workspace) return;
    this.workspace = manifest.workspace;
    this.syncedAt = manifest.syncedAt;
    this.entries = toEntryMap(manifest.entries);
  }
}

/** 解析同一条复合命令里的分段输出 */
export function parseSections(stderr: string): { cap?: string; find?: string; fileTexts?: Record<string, string>; probe?: string; pyPath?: string; listing?: string } {
  const out: { cap?: string; find?: string; fileTexts?: Record<string, string>; probe?: string; pyPath?: string; listing?: string } = {};
  const firstSection = stderr.indexOf("__RCE_SECTION__");
  if (firstSection < 0) {
    out.listing = stderr;
    out.fileTexts = {};
    return out;
  }
  // 第一个分段头之前的都是 date +%s + 文件清单
  out.listing = stderr.slice(0, firstSection);
  out.fileTexts = {};
  // 从第一个分段头之后解析各分段
  const rest = stderr.slice(firstSection);
  const parts = rest.split("__RCE_SECTION__");
  for (const part of parts) {
    if (!part) continue;
    const firstLineEnd = part.indexOf("\n");
    const header = firstLineEnd < 0 ? part.trim() : part.slice(0, firstLineEnd).trim();
    const body = firstLineEnd < 0 ? "" : part.slice(firstLineEnd + 1);
    if (header.startsWith("__CAP__")) out.cap = body.trim();
    else if (header.startsWith("__FIND__")) out.find = body;
    else if (header.startsWith("__FILE__ ")) {
      const quoted = header.slice("__FILE__ ".length).trim();
      const file = quoted.startsWith("'") && quoted.endsWith("'") ? quoted.slice(1, -1) : quoted;
      out.fileTexts[file] = body;
    }
    else if (header.startsWith("__PROBE__")) out.probe = body.trim();
    else if (header.startsWith("__PYPATH__")) out.pyPath = body.trim();
  }
  return out;
}

/** stderr 首行是远端 `date +%s`，其余是文件清单（A8b） */
export function splitStderr(stderr: string): { syncedAt: number; listing: string } {
  const lines = stderr.split("\n");
  const epochIdx = lines.findIndex((l) => /^\d{9,}$/.test(l.trim()));
  if (epochIdx < 0) {
    return { syncedAt: Math.floor(Date.now() / 1000), listing: stderr };
  }
  const syncedAt = Number(lines[epochIdx].trim());
  const listing = lines.filter((_l, i) => i !== epochIdx).join("\n");
  return { syncedAt, listing };
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
