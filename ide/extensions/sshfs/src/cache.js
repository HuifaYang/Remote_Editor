// 本机影子缓存管理（语言服务的源码镜像 + clangd/pylsp 索引）。
//
// 设计目标：
//   · 目录按“远端 authority + 项目根”隔离，删除时源码和索引一起删；
//   · 活跃项目 / 未完成同步的项目绝不自动删；
//   · 总容量、单项目容量、TTL 三道闸门，超限按 LRU 淘汰；
//   · 清理只碰本文件认得的缓存目录，不动用户源码和远端权威数据。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_SIZE_MB = 10 * 1024;
const DEFAULT_MAX_PROJECT_MB = 5 * 1024;
const DEFAULT_TTL_DAYS = 30;
const STALE_TEMP_MS = 60 * 60 * 1000;

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function dirSize(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        // 清理和并发同步可能让文件刚好消失，忽略即可。
      }
    }
  }
  return total;
}

function rmDir(dir) {
  let size = 0;
  try {
    if (fs.existsSync(dir)) size = dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 删除失败留给下次清理，不阻塞语言服务。
  }
  return size;
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * ShadowCacheManager 不直接管理 MirrorManager 的生命周期，只负责：
 *   touch(hash, metadata) 记录最近使用；
 *   markActive/markInactive 标记当前进程正在使用的项目；
 *   cleanup() 执行 TTL/LRU/容量清理。
 */
class ShadowCacheManager {
  constructor(opts) {
    this.rootDir = opts.rootDir;
    this.mirrorRoot = path.join(this.rootDir, "mirror");
    this.lspRoot = path.join(this.rootDir, "lsp");
    this.metaRoot = path.join(this.rootDir, "meta");
    this.config = opts.config || (() => ({}));
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    this.active = new Set();
    this._cleanupPromise = null;
    fs.mkdirSync(this.mirrorRoot, { recursive: true });
    fs.mkdirSync(this.lspRoot, { recursive: true });
    fs.mkdirSync(this.metaRoot, { recursive: true });
  }

  _metaFile(hash) {
    return path.join(this.metaRoot, `${hash}.json`);
  }

  _projectDirs(hash) {
    return {
      mirror: path.join(this.mirrorRoot, hash),
      lsp: path.join(this.lspRoot, hash),
      staging: path.join(this.mirrorRoot, `${hash}.staging`),
      tar: path.join(this.mirrorRoot, `${hash}.sync.tar.gz`),
    };
  }

  _readMeta(hash) {
    const dirs = this._projectDirs(hash);
    const meta = readJson(this._metaFile(hash)) || {};
    const fallback = Math.max(mtimeMs(dirs.mirror), mtimeMs(dirs.lsp));
    return {
      hash,
      lastAccess: safeNumber(meta.lastAccess, fallback || this.now()),
      authority: typeof meta.authority === "string" ? meta.authority : "",
      remoteRoot: typeof meta.remoteRoot === "string" ? meta.remoteRoot : "",
      dirty: meta.dirty === true,
      pinned: meta.pinned === true,
    };
  }

  touch(hash, metadata = {}) {
    if (!hash) return;
    const current = this._readMeta(hash);
    const next = {
      version: 1,
      hash,
      lastAccess: this.now(),
      authority: metadata.authority ?? current.authority,
      remoteRoot: metadata.remoteRoot ?? current.remoteRoot,
      dirty: metadata.dirty ?? current.dirty,
      pinned: metadata.pinned ?? current.pinned,
    };
    writeJsonAtomic(this._metaFile(hash), next);
  }

  markActive(hash, metadata) {
    if (!hash) return;
    this.active.add(hash);
    this.touch(hash, metadata);
  }

  markInactive(hash) {
    if (!hash) return;
    this.active.delete(hash);
    this.touch(hash);
  }

  _knownHashes() {
    const hashes = new Set();
    for (const root of [this.mirrorRoot, this.lspRoot]) {
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* ignore */ }
      for (const entry of entries) {
        if (entry.isDirectory()) hashes.add(entry.name.replace(/\.staging$/, ""));
        else if (entry.name.endsWith(".sync.tar.gz")) hashes.add(entry.name.slice(0, -".sync.tar.gz".length));
      }
    }
    let metas = [];
    try { metas = fs.readdirSync(this.metaRoot); } catch { /* ignore */ }
    for (const name of metas) {
      if (name.endsWith(".json")) hashes.add(name.slice(0, -5));
    }
    return [...hashes].filter(Boolean);
  }

  _removeProject(hash) {
    const dirs = this._projectDirs(hash);
    let freed = 0;
    freed += rmDir(dirs.mirror);
    freed += rmDir(dirs.lsp);
    freed += rmDir(dirs.staging);
    try {
      if (fs.existsSync(dirs.tar)) {
        freed += fs.statSync(dirs.tar).size;
        fs.rmSync(dirs.tar, { force: true });
      }
    } catch { /* ignore */ }
    try { fs.rmSync(this._metaFile(hash), { force: true }); } catch { /* ignore */ }
    return freed;
  }

  _limits() {
    const cfg = this.config() || {};
    return {
      maxBytes: safeNumber(cfg.maxSizeMB, DEFAULT_MAX_SIZE_MB) * 1024 * 1024,
      maxProjectBytes: safeNumber(cfg.maxProjectMB, DEFAULT_MAX_PROJECT_MB) * 1024 * 1024,
      ttlMs: safeNumber(cfg.ttlDays, DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000,
      cleanupOnDisconnect: cfg.cleanupOnDisconnect === true,
    };
  }

  cleanup() {
    if (this._cleanupPromise) return this._cleanupPromise;
    this._cleanupPromise = (async () => {
      const limits = this._limits();
      const now = this.now();
      const records = [];
      let totalBytes = 0;

      for (const hash of this._knownHashes()) {
        const dirs = this._projectDirs(hash);
        // 清理上次异常退出留下的 staging / tar；活跃项目不能碰。
        for (const temp of [dirs.staging, dirs.tar]) {
          if (!this.active.has(hash) && fs.existsSync(temp) && now - mtimeMs(temp) > STALE_TEMP_MS) {
            totalBytes += rmDir(temp);
          }
        }
        const bytes = dirSize(dirs.mirror) + dirSize(dirs.lsp);
        totalBytes += bytes;
        records.push({ ...this._readMeta(hash), bytes });
      }

      const candidates = records
        .filter((r) => !this.active.has(r.hash) && !r.dirty && !r.pinned)
        .sort((a, b) => a.lastAccess - b.lastAccess);
      const removed = [];
      let freedBytes = 0;

      const remove = (record, reason) => {
        if (!record || this.active.has(record.hash)) return false;
        const freed = this._removeProject(record.hash);
        totalBytes -= record.bytes;
        freedBytes += freed;
        removed.push({ hash: record.hash, authority: record.authority, remoteRoot: record.remoteRoot, bytes: record.bytes, reason });
        return true;
      };

      // 1) TTL：过期且不在用的项目先清。
      for (const record of [...candidates]) {
        if (limits.ttlMs > 0 && now - record.lastAccess > limits.ttlMs) {
          if (remove(record, "ttl")) candidates.splice(candidates.indexOf(record), 1);
        }
      }

      // 2) 单项目上限：异常大的索引单独淘汰。
      for (const record of [...candidates]) {
        if (limits.maxProjectBytes > 0 && record.bytes > limits.maxProjectBytes) {
          if (remove(record, "project-size")) candidates.splice(candidates.indexOf(record), 1);
        }
      }

      // 3) 总容量上限：LRU 清到低水位，避免每写一点就触发一次清理。
      if (limits.maxBytes > 0 && totalBytes > limits.maxBytes) {
        const lowWater = Math.floor(limits.maxBytes * 0.7);
        for (const record of candidates) {
          if (totalBytes <= lowWater) break;
          remove(record, "total-size");
        }
      }

      const result = { removed, freedBytes, totalBytes: Math.max(0, totalBytes), active: this.active.size };
      if (removed.length) this.log(`[缓存] 已清理 ${removed.length} 个项目，释放 ${freedBytes} 字节`);
      return result;
    })().finally(() => {
      this._cleanupPromise = null;
    });
    return this._cleanupPromise;
  }

  async stats() {
    const records = this._knownHashes().map((hash) => {
      const dirs = this._projectDirs(hash);
      return { ...this._readMeta(hash), bytes: dirSize(dirs.mirror) + dirSize(dirs.lsp) };
    });
    return {
      root: this.rootDir,
      totalBytes: records.reduce((sum, r) => sum + r.bytes, 0),
      count: records.length,
      active: records.filter((r) => this.active.has(r.hash)).length,
      projects: records.sort((a, b) => b.lastAccess - a.lastAccess),
    };
  }
}

module.exports = {
  ShadowCacheManager,
  DEFAULT_MAX_SIZE_MB,
  DEFAULT_MAX_PROJECT_MB,
  DEFAULT_TTL_DAYS,
};
