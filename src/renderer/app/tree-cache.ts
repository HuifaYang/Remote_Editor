// 目录列举缓存（总纲 §7：TTL 120 秒、上限 200 条、同一条目录在飞行中只发一次、预取 ≤3 个子目录）
import type { RemoteEntry } from "../../shared/types.js";

export interface TreeCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxPrefetch?: number;
  now?: () => number;
  list: (path: string) => Promise<RemoteEntry[]>;
}

interface CacheEntry {
  at: number;
  entries: RemoteEntry[];
}

export class TreeCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxPrefetch: number;
  private readonly now: () => number;
  private readonly list: (path: string) => Promise<RemoteEntry[]>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<RemoteEntry[]>>();

  constructor(opts: TreeCacheOptions) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.maxEntries = opts.maxEntries ?? 200;
    this.maxPrefetch = opts.maxPrefetch ?? 3;
    this.now = opts.now ?? (() => Date.now());
    this.list = opts.list;
  }

  /** 缓存命中 0 次请求；否则 1 次请求（并发同路径共享同一个 Promise） */
  async load(path: string): Promise<RemoteEntry[]> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.entries;
    const running = this.inflight.get(path);
    if (running) return running;
    const task = this.list(path)
      .then((entries) => {
        this.store(path, entries);
        return entries;
      })
      .finally(() => {
        this.inflight.delete(path);
      });
    this.inflight.set(path, task);
    return task;
  }

  /** 新建 / 删除 / 重命名 / 切换工作目录 / F5 之后必须失效（§7） */
  invalidate(path?: string): void {
    if (path === undefined) this.cache.clear();
    else this.cache.delete(path);
  }

  /** 目录前缀失效（重命名 / 删除整棵子树用） */
  invalidateTree(path: string): void {
    const prefix = path.replace(/\/+$/, "") + "/";
    for (const key of [...this.cache.keys()]) {
      if (key === path || key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** 后台预取最多 3 个子目录（只预取一层，低优先级） */
  prefetch(entries: RemoteEntry[], limit = this.maxPrefetch): void {
    const dirs = entries.filter((e) => e.isDir).slice(0, limit);
    for (const dir of dirs) {
      if (this.cache.has(dir.path)) continue;
      void this.load(dir.path).catch(() => { /* 预取失败无所谓，展开时再报 */ });
    }
  }

  size(): number {
    return this.cache.size;
  }

  private store(path: string, entries: RemoteEntry[]): void {
    this.cache.set(path, { at: this.now(), entries });
    // 上限 200 条：超了删最旧的（Map 迭代顺序 = 插入顺序）
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
