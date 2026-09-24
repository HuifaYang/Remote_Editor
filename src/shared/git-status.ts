// porcelain 解析 / 目录继承色传播 / 本地更新 / 路径换算（分册 1 · A2~A5）：纯函数 + 纯数据类
import type { GitFileStatus, GitTreeStatus } from "./types.js";
import { normalizeRemotePath, remoteDirname } from "./paths.js";

export type ChangeKind = "added" | "modified" | "deleted";

export interface ParsedStatus {
  files: Map<string, GitFileStatus>;   // key = 仓库内相对路径
  untrackedDirs: string[];             // 仓库内相对路径（去尾 /）
}

/** A2：解析 `git status --porcelain -uall` 的 stdout */
export function parsePorcelain(stdout: string): ParsedStatus {
  const files = new Map<string, GitFileStatus>();
  const untrackedDirs: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    let name = line.slice(3).trim();
    const arrow = name.indexOf(" -> ");
    if (arrow >= 0) name = name.slice(arrow + 4);           // rename 取新路径
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1);                             // 剥 git 引号（不做八进制反转义）
    }
    if (name.endsWith("/")) {                               // 未跟踪目录折叠
      untrackedDirs.push(name.slice(0, -1));
      continue;
    }
    const pair = indexStatus + worktreeStatus;
    let letter: GitFileStatus["letter"];
    let change: GitFileStatus["change"];
    // 顺序：冲突对（两侧同字母）→ 未跟踪 → 暂存新增 → rename → 删除 → 修改
    if (pair === "UU" || pair === "AA" || pair === "DD") { letter = "!"; change = "modified"; }
    else if (pair === "??") { letter = "U"; change = "added"; }
    else if (indexStatus === "A") { letter = "A"; change = "added"; }
    else if (indexStatus === "R") { letter = "R"; change = "modified"; }
    else if (indexStatus === "D" || worktreeStatus === "D") { letter = "D"; change = "deleted"; }
    else if (indexStatus === "M" || worktreeStatus === "M") { letter = "M"; change = "modified"; }
    else continue;                                          // 两列都空格或无法识别 → 不入 files
    files.set(name, { path: name, indexStatus, worktreeStatus, letter, change });
  }
  return { files, untrackedDirs };
}

/** A3：change 优先级 modified(3) > added(2) > deleted(1) */
const PRIORITY: Record<ChangeKind, number> = { deleted: 1, added: 2, modified: 3 };

export function mergeChange(a: ChangeKind | undefined, b: ChangeKind): ChangeKind {
  return a === undefined || PRIORITY[b] > PRIORITY[a] ? b : a;
}

/** A3：把文件的变更向上传播到每一级父目录，直到仓库根（含根） */
export function propagateInto(
  dirs: Map<string, ChangeKind>,
  absolutePath: string,
  change: ChangeKind,
  root: string,
): void {
  let parent = remoteDirname(absolutePath);
  while (parent === root || parent.startsWith(root + "/")) {
    dirs.set(parent, mergeChange(dirs.get(parent), change));
    if (parent === root) break;
    parent = remoteDirname(parent);
  }
}

/**
 * Git 状态快照（总纲 §2.2：文件树/SCM/状态栏/差异共用这一份）。
 * 键一律是「仓库根写法」的远端绝对路径；UI 路径经 keyFor 换算（A5）。
 */
export class TreeStatus {
  readonly root: string;
  readonly scope: string;
  readonly branch: string;
  readonly files = new Map<string, GitFileStatus>();   // key = 远端绝对路径
  readonly dirs = new Map<string, ChangeKind>();       // 目录继承色
  untrackedDirs: string[] = [];                        // 远端绝对路径
  fetchedAt = 0;
  complete = false;
  /** A4 的 _statuses[path]=clean：本地标记过「已知干净」的跟踪文件 */
  private readonly knownClean = new Set<string>();

  constructor(root: string, scope: string, branch: string) {
    this.root = root;
    this.scope = scope;
    this.branch = branch;
  }

  /** 从 porcelain 解析结果建快照（相对路径 → 仓库根写法绝对路径） */
  static fromParsed(root: string, scope: string, branch: string, parsed: ParsedStatus): TreeStatus {
    const tree = new TreeStatus(root, scope, branch);
    for (const [rel, st] of parsed.files) {
      tree.files.set(root + "/" + rel, { ...st });
    }
    tree.untrackedDirs = parsed.untrackedDirs.map((rel) => root + "/" + rel);
    tree.rebuildDirs();
    tree.fetchedAt = Date.now();
    tree.complete = true;
    return tree;
  }

  covers(path: string): boolean {
    return path === this.scope || path.startsWith(this.scope + "/");
  }

  /** A5：UI 路径 → 快照键（符号链接工作目录场景；撞车不猜） */
  keyFor(path: string): string {
    if (this.files.has(path) || this.dirs.has(path)) return path;
    const norm = normalizeRemotePath(path, "/");
    if (norm !== path && (this.files.has(norm) || this.dirs.has(norm))) return norm;
    let tail: string;
    if (path === this.scope) tail = "";
    else if (path.startsWith(this.scope + "/")) tail = path.slice(this.scope.length + 1);
    else return path;                                  // 不在 scope 下 → 不换算
    if (tail === "") return this.dirs.has(this.root) ? this.root : path;
    const suffix = "/" + tail;
    for (const map of [this.files, this.dirs] as const) {
      const hits: string[] = [];
      for (const key of map.keys()) if (key.endsWith(suffix)) hits.push(key);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return path;                // 多个命中 → 不猜
    }
    return path;                                       // 0 个命中 → 不猜
  }

  /** scope 写法 → 仓库根写法（mark* 存新键时统一口径） */
  private toRootKey(path: string): string {
    const key = this.keyFor(path);
    if (key === this.root || key.startsWith(this.root + "/")) return key;
    if (this.covers(key)) return this.root + key.slice(this.scope.length);
    return key;
  }

  /** A4.6：重建目录色 = 重新对 files + untrackedDirs 跑 A3 */
  rebuildDirs(): void {
    this.dirs.clear();
    for (const [p, st] of this.files) {
      if (st.change) propagateInto(this.dirs, p, st.change, this.root);
    }
    for (const d of this.untrackedDirs) propagateInto(this.dirs, d, "added", this.root);
  }

  /** A4.2/4.3：保存后本地更新；返回 false = 不在快照范围，调用方需重新拉快照 */
  markSaved(path: string, clean = true): boolean {
    if (!this.covers(path)) return false;
    if (clean) return this.markClean(path);
    const key = this.toRootKey(path);
    const st = this.files.get(key);
    if (!(st && st.change === "added")) {
      // 原先是未跟踪 → 保持 added/U；否则置 modified/M
      const rel = key.startsWith(this.root + "/") ? key.slice(this.root.length + 1) : key;
      this.files.set(key, { path: rel, indexStatus: " ", worktreeStatus: "M", letter: "M", change: "modified" });
    }
    this.knownClean.delete(key);
    this.rebuildDirs();
    return true;
  }

  /** A4.4：从变更里摘掉，记「已知干净」，重建目录色 */
  markClean(path: string): boolean {
    if (!this.covers(path)) return false;
    const key = this.toRootKey(path);
    this.files.delete(key);
    this.untrackedDirs = this.untrackedDirs.filter((d) => d !== key);
    this.knownClean.add(key);
    this.rebuildDirs();
    return true;
  }

  /** A4.5：删除后本地更新；完全没命中 → false（交给远端兜底） */
  markRemoved(path: string): boolean {
    if (!this.covers(path)) return false;
    const key = this.toRootKey(path);
    const st = this.files.get(key);
    if (st && (st.letter === "U" || st.change === "added")) {
      this.files.delete(key);                          // 未跟踪文件删掉 = 直接摘掉
      this.rebuildDirs();
      return true;
    }
    if (!st && this.untrackedDirs.some((d) => key === d || key.startsWith(d + "/"))) {
      this.rebuildDirs();                              // 未跟踪目录内的文件 → 摘掉（无单独条目）
      return true;
    }
    if (st || this.knownClean.has(key)) {
      // 跟踪文件 → 置 deleted/D
      const rel = key.startsWith(this.root + "/") ? key.slice(this.root.length + 1) : key;
      this.files.set(key, { path: rel, indexStatus: " ", worktreeStatus: "D", letter: "D", change: "deleted" });
      this.knownClean.delete(key);
      this.rebuildDirs();
      return true;
    }
    return false;
  }

  /**
   * M5：把文件在「暂存 / 未暂存」之间本地移动（暂存、取消暂存后不重扫仓库）。
   * 返回 false = 不在快照范围内，调用方需重新拉快照。
   */
  markStaged(path: string, staged = true): boolean {
    if (!this.covers(path)) return false;
    const key = this.toRootKey(path);
    const st = this.files.get(key);
    if (!st || !st.change) return false;
    const letter = st.indexStatus !== " " && st.indexStatus !== "?" ? st.indexStatus : st.worktreeStatus;
    const index = !staged ? " " : letter === "?" || letter === "U" ? "A" : letter;
    const worktree = staged ? " " : letter === "?" || letter === "U" ? "?" : letter;
    const rel = key.startsWith(this.root + "/") ? key.slice(this.root.length + 1) : key;
    this.files.set(key, {
      path: rel,
      indexStatus: index,
      worktreeStatus: worktree,
      letter: (index === "A" && worktree === "?" ? "U" : (staged ? index : worktree)) as GitFileStatus["letter"],
      change: st.change,
    });
    this.rebuildDirs();
    return true;
  }

  /** 拍快照（跨进程序列化用）；label 形如 `Git: main · 34 处变更` */
  toSnapshot(): GitTreeStatus {
    const n = this.files.size + this.untrackedDirs.length;
    return {
      root: this.root,
      branch: this.branch,
      scope: this.scope,
      files: Object.fromEntries(this.files),
      dirs: Object.fromEntries(this.dirs),
      untrackedDirs: [...this.untrackedDirs],
      fetchedAt: this.fetchedAt,
      complete: this.complete,
      label: n > 0 ? `Git: ${this.branch} · ${n} 处变更` : `Git: ${this.branch}`,
    };
  }
}

/** SCM 面板的行（M5 U4）：同一文件可同时出现在暂存区与工作区（MM） */
export interface ScmFileEntry {
  path: string;                       // 仓库内相对路径
  absPath: string;                    // 远端绝对路径（点开文件用）
  letter: GitFileStatus["letter"];
  change: GitFileStatus["change"];
  staged: boolean;
}

/** 把一份快照拆成「暂存的更改 / 更改」两组（纯函数，UI 与测试共用） */
export function splitStatus(status: GitTreeStatus): { staged: ScmFileEntry[]; unstaged: ScmFileEntry[] } {
  const staged: ScmFileEntry[] = [];
  const unstaged: ScmFileEntry[] = [];
  const root = status.root.replace(/\/+$/, "");
  for (const [abs, st] of Object.entries(status.files)) {
    const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
    const untracked = st.indexStatus === "?" || st.letter === "U";
    if (untracked) {
      unstaged.push({ path: rel, absPath: abs, letter: "U", change: "added", staged: false });
      continue;
    }
    const indexLetter = st.indexStatus.trim();
    if (indexLetter !== "") {
      staged.push({
        path: rel, absPath: abs,
        letter: (indexLetter === "R" ? "R" : indexLetter) as GitFileStatus["letter"],
        change: st.change, staged: true,
      });
    }
    const workLetter = st.worktreeStatus.trim();
    if (workLetter !== "") {
      unstaged.push({
        path: rel, absPath: abs,
        letter: workLetter as GitFileStatus["letter"],
        change: st.change, staged: false,
      });
    }
  }
  const byPath = (a: ScmFileEntry, b: ScmFileEntry): number => a.path.localeCompare(b.path);
  staged.sort(byPath);
  unstaged.sort(byPath);
  return { staged, unstaged };
}
