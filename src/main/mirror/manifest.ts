// 镜像清单与差集（分册 1 A8）：纯函数、无 IO；manifest.json 存在镜像根
import type { MirrorEntry } from "../../shared/types.js";

export const MANIFEST_VERSION = 1;

export interface MirrorManifest {
  version: 1;
  workspace: string;      // 远端工作目录绝对路径
  syncedAt: number;       // 远端时钟 epoch 秒（A8b：禁止用工作机时钟）
  entries: MirrorEntry[]; // path 是相对镜像根的 posix 路径
}

export interface ManifestDiff {
  changed: MirrorEntry[];
  removed: string[];
}

/** 单行样例：`./src/a.cpp 123 1729990000.1234567890`（文件名可含空格 → 从右侧贪心取大小/时间） */
const LISTING_RE = /^(.*)\s+(\d+)\s+([\d.]+)$/;

/** 解析 `find -printf '%p %s %T@\n'` 输出；剥掉 `./` 前缀，只接受工作目录内相对路径 */
export function parseFindListing(text: string): MirrorEntry[] {
  const entries: MirrorEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) continue;
    const m = LISTING_RE.exec(line);
    if (!m) continue;
    let rel = m[1].trim();
    if (rel.startsWith("/")) continue;      // 越出工作目录的输出一律丢弃
    if (rel.startsWith("./")) rel = rel.slice(2);
    if (!rel || rel === "." || rel.endsWith("/")) continue;
    entries.push({ path: rel, size: Number(m[2]), mtime: Number(m[3]) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export function createManifest(workspace: string, syncedAt: number, entries: MirrorEntry[]): MirrorManifest {
  return { version: MANIFEST_VERSION, workspace, syncedAt, entries };
}

export function toEntryMap(entries: MirrorEntry[]): Map<string, MirrorEntry> {
  return new Map(entries.map((e) => [e.path, e]));
}

function sameFile(a: MirrorEntry, b: MirrorEntry): boolean {
  return a.size === b.size && a.mtime === b.mtime;
}

/** A8：changed = 新增或 size/mtime 变化；removed = 旧有新无 */
export function diffManifest(oldEntries: Map<string, MirrorEntry>, nextEntries: MirrorEntry[]): ManifestDiff {
  const changed: MirrorEntry[] = [];
  const nextPaths = new Set<string>();
  for (const entry of nextEntries) {
    nextPaths.add(entry.path);
    const old = oldEntries.get(entry.path);
    if (!old || !sameFile(old, entry)) changed.push(entry);
  }
  const removed: string[] = [];
  for (const path of oldEntries.keys()) {
    if (!nextPaths.has(path)) removed.push(path);
  }
  removed.sort();
  return { changed, removed };
}

export function serializeManifest(manifest: MirrorManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** 容错读取：坏 JSON / 版本不符 / 结构不对都返回 null（镜像重建，不炸） */
export function parseManifest(raw: string): MirrorManifest | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const m = data as Partial<MirrorManifest>;
  if (m.version !== MANIFEST_VERSION || typeof m.workspace !== "string" || typeof m.syncedAt !== "number") return null;
  if (!Array.isArray(m.entries)) return null;
  const entries: MirrorEntry[] = [];
  for (const item of m.entries) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Partial<MirrorEntry>;
    if (typeof e.path !== "string" || typeof e.size !== "number" || typeof e.mtime !== "number") continue;
    entries.push({ path: e.path, size: e.size, mtime: e.mtime });
  }
  return createManifest(m.workspace, m.syncedAt, entries);
}

/**
 * 远端绝对路径 → 镜像内相对镜像根的路径（§5.3.4：按相对层级换算，禁止字符串替换 hack）。
 * 工作目录内的路径按相对尾巴；sysroot 路径（工作目录外、已收集的头文件）映射到 `_sysroot/<去根斜杠>`。
 * 两者都不是 → null（调用方决定是否降级）。
 */
export function mirrorRelativePath(workspace: string, remotePath: string, sysrootRoots: string[] = []): string | null {
  const ws = workspace.replace(/\/+$/, "") || "/";
  const p = remotePath.replace(/\/+$/, "") || "/";
  if (ws !== "/" && (p === ws || p.startsWith(ws + "/"))) {
    const rel = p.slice(ws.length).replace(/^\/+/, "");
    return rel === "" ? "" : rel;
  }
  if (ws === "/" && p.startsWith("/")) return p.replace(/^\/+/, "");
  for (const root of sysrootRoots) {
    const r = root.replace(/\/+$/, "");
    if (!r || r === "/") continue;
    if (p === r || p.startsWith(r + "/")) return "_sysroot/" + p.replace(/^\/+/, "");
  }
  return null;
}
