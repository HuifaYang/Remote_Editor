// 影子缓存管理：活跃保护、TTL、总容量 LRU。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { ShadowCacheManager } = require("../../ide/extensions/sshfs/src/cache.js") as {
  ShadowCacheManager: new (opts: Record<string, unknown>) => {
    markActive(hash: string, metadata?: Record<string, unknown>): void;
    markInactive(hash: string): void;
    cleanup(): Promise<{ removed: Array<{ hash: string }> }>;
    stats(): Promise<{ count: number; totalBytes: number }>;
  };
};

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rce-cache-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seed(hash: string, bytes: number): void {
  fs.mkdirSync(path.join(root, "mirror", hash), { recursive: true });
  fs.mkdirSync(path.join(root, "lsp", hash), { recursive: true });
  fs.writeFileSync(path.join(root, "mirror", hash, "src.c"), "x".repeat(bytes));
}

describe("ShadowCacheManager", () => {
  it("不会清理活跃项目", async () => {
    seed("active", 1024);
    const now = Date.now();
    const cache = new ShadowCacheManager({
      rootDir: root,
      now: () => now,
      config: () => ({ maxSizeMB: 0.0001, maxProjectMB: 0, ttlDays: 0 }),
      log: () => {},
    });
    cache.markActive("active", { authority: "u@h:22", remoteRoot: "/ws" });
    const result = await cache.cleanup();
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(root, "mirror", "active"))).toBe(true);
  });

  it("清理过期且非活跃的项目", async () => {
    seed("old", 16);
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const cache = new ShadowCacheManager({
      rootDir: root,
      now: () => Date.now(),
      config: () => ({ maxSizeMB: 1024, maxProjectMB: 1024, ttlDays: 1 }),
      log: () => {},
    });
    cache.markInactive("old");
    const meta = JSON.parse(fs.readFileSync(path.join(root, "meta", "old.json"), "utf8"));
    meta.lastAccess = old;
    fs.writeFileSync(path.join(root, "meta", "old.json"), JSON.stringify(meta));
    const result = await cache.cleanup();
    expect(result.removed.map((r) => r.hash)).toContain("old");
    expect(fs.existsSync(path.join(root, "mirror", "old"))).toBe(false);
  });

  it("总容量超限时按 LRU 清理非活跃项目", async () => {
    seed("old", 1024 * 1024);
    seed("new", 1024 * 1024);
    const now = Date.now();
    const cache = new ShadowCacheManager({
      rootDir: root,
      now: () => now,
      config: () => ({ maxSizeMB: 1.8, maxProjectMB: 10, ttlDays: 0 }),
      log: () => {},
    });
    cache.markInactive("old");
    fs.writeFileSync(path.join(root, "meta", "old.json"), JSON.stringify({ version: 1, lastAccess: now - 10000 }));
    cache.markInactive("new");
    fs.writeFileSync(path.join(root, "meta", "new.json"), JSON.stringify({ version: 1, lastAccess: now }));
    const result = await cache.cleanup();
    expect(result.removed[0]?.hash).toBe("old");
    expect(fs.existsSync(path.join(root, "mirror", "new"))).toBe(true);
  });
});
