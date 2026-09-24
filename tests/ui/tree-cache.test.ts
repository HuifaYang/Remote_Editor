// 分册 4 T10.2：文件树懒加载 + 120 秒缓存 + 预取上限 + 去重
import { describe, expect, it, vi } from "vitest";
import { TreeCache } from "../../src/renderer/app/tree-cache";
import type { RemoteEntry } from "../../src/shared/types";

function dir(path: string): RemoteEntry {
  return { name: path.split("/").pop() ?? path, path, isDir: true, isSymlink: false, size: 0, mtime: 0, mode: 0o755 };
}

describe("T10.2 目录缓存", () => {
  it("test_first_expand_loads_then_cache_hits", async () => {
    // Given 一个目录 When 展开两次 Then 只发 1 次 listDir
    const list = vi.fn(async () => [dir("/ws/src")]);
    const cache = new TreeCache({ list, now: () => 1000 });
    await cache.load("/ws");
    await cache.load("/ws");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("test_ttl_expiry_reloads", async () => {
    let now = 0;
    const list = vi.fn(async () => [dir("/ws/src")]);
    const cache = new TreeCache({ list, ttlMs: 120_000, now: () => now });
    await cache.load("/ws");
    now = 119_999;
    await cache.load("/ws");
    expect(list).toHaveBeenCalledTimes(1);
    now = 120_001;
    await cache.load("/ws");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("test_inflight_requests_are_deduped", async () => {
    const list = vi.fn(() => new Promise<RemoteEntry[]>((r) => setTimeout(() => r([dir("/ws/src")]), 10)));
    const cache = new TreeCache({ list });
    await Promise.all([cache.load("/ws"), cache.load("/ws"), cache.load("/ws")]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("test_prefetch_is_capped_at_three_and_invalidate_clears", async () => {
    const list = vi.fn(async (p: string) => [dir(p)]);
    const cache = new TreeCache({ list, now: () => 0 });
    cache.prefetch([dir("/ws/a"), dir("/ws/b"), dir("/ws/c"), dir("/ws/d")]);
    await new Promise((r) => setTimeout(r, 5));
    expect(list).toHaveBeenCalledTimes(3);
    await cache.load("/ws/a");                 // 预取已缓存 → 0 次请求
    expect(list).toHaveBeenCalledTimes(3);
    cache.invalidate("/ws/a");
    await cache.load("/ws/a");                 // 失效后重发 1 次
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("test_cache_is_capped_at_200_entries", async () => {
    const list = vi.fn(async () => []);
    const cache = new TreeCache({ list, maxEntries: 200 });
    for (let i = 0; i < 210; i++) await cache.load(`/ws/${i}`);
    expect(cache.size()).toBe(200);
  });
});
