// hosts.json（分册 3 D1.1）：主机配置 + 历史工作目录；**禁止含任何凭据**（§8.3）
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "../../shared/errors.js";
import type { HostConfig } from "../../shared/types.js";
import { log } from "../log.js";

export const MAX_WORKSPACES = 10;

export interface HostRecord extends HostConfig {
  workspaces: string[];     // 历史工作目录，最多 10 条，最新在前
}

const FORBIDDEN_KEYS = ["password", "passphrase", "secret"];

/** 保存前断言：任何层级都不许出现凭据键（§8.3 + D1.1） */
export function assertNoCredentials(host: unknown): void {
  const walk = (v: unknown, pathText: string): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${pathText}[${i}]`));
      return;
    }
    if (typeof v !== "object" || v === null) return;
    for (const [key, value] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
        throw new AppError("invalid-input", "主机配置禁止保存凭据", `${pathText}.${key}`);
      }
      walk(value, `${pathText}.${key}`);
    }
  };
  walk(host, "host");
}

function normalizeHost(raw: unknown): HostRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.host !== "string" || typeof r.name !== "string") return null;
  const workspaces = Array.isArray(r.workspaces)
    ? r.workspaces.filter((w): w is string => typeof w === "string").slice(0, MAX_WORKSPACES)
    : [];
  const host: HostRecord = {
    id: r.id,
    name: r.name,
    host: r.host,
    port: typeof r.port === "number" ? r.port : 22,
    username: typeof r.username === "string" ? r.username : "root",
    authMethod: r.authMethod === "key" ? "key" : "password",
    workspaces,
  };
  if (typeof r.privateKeyPath === "string" && r.privateKeyPath) host.privateKeyPath = r.privateKeyPath;
  if (typeof r.workspace === "string" && r.workspace) host.workspace = r.workspace;
  if (typeof r.lastUsedAt === "number") host.lastUsedAt = r.lastUsedAt;
  return host;
}

export class HostStore {
  private cache: HostRecord[] | null = null;
  constructor(private readonly file: string) {}

  list(): HostRecord[] {
    if (!this.cache) {
      this.cache = [];
      try {
        const data: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
        const hosts = (data as { hosts?: unknown }).hosts;
        if (Array.isArray(hosts)) {
          this.cache = hosts.map(normalizeHost).filter((h): h is HostRecord => h !== null);
        }
      } catch (err) {
        // 首次运行没有文件是正常的；文件坏了只记日志，不让启动失败
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") log("warn", `hosts.json 读取失败：${String(err)}`);
      }
    }
    return this.cache;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, hosts: this.list() }, null, 2) + "\n", "utf8");
  }

  /** 新增或更新（按 id）；顺带把 workspace 记进历史 */
  save(host: HostRecord): HostRecord {
    assertNoCredentials(host);
    const hosts = this.list();
    const idx = hosts.findIndex((h) => h.id === host.id);
    const next: HostRecord = { ...host, workspaces: [...host.workspaces].slice(0, MAX_WORKSPACES) };
    if (idx >= 0) hosts[idx] = next;
    else hosts.push(next);
    this.persist();
    return next;
  }

  remove(id: string): void {
    this.cache = this.list().filter((h) => h.id !== id);
    this.persist();
  }

  /** 记录一次成功使用：更新 lastUsedAt + workspace 历史（去重、最新在前、上限 10） */
  touch(id: string, workspace?: string): void {
    const host = this.list().find((h) => h.id === id);
    if (!host) return;
    host.lastUsedAt = Math.floor(Date.now() / 1000);
    if (workspace) {
      host.workspace = workspace;
      host.workspaces = [workspace, ...host.workspaces.filter((w) => w !== workspace)].slice(0, MAX_WORKSPACES);
    }
    this.persist();
  }
}
