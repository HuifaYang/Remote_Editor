// 本机 ~/.ssh 集成（§8.4 / §8.5）：识别私钥 + 只读导入 config 的 Host/HostName/Port/User/IdentityFile
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LocalKeyInfo {
  path: string;
  label: string;        // .pub 注释优先，其次文件名
  encrypted: boolean;
}

const SKIP_NAMES = ["known_hosts", "known_hosts.old", "authorized_keys"];
const MAX_KEY_BYTES = 1024 * 1024;

export const DEFAULT_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

function sshDirOf(sshDir?: string): string {
  return sshDir ?? path.join(os.homedir(), ".ssh");
}

/** 认文件头，跳过 known_hosts / *.pub / authorized_keys / 子目录 / >1MB（§8.4） */
export function isPrivateKeyFile(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_KEY_BYTES) return false;
    const head = fs.readFileSync(file, "utf8").slice(0, 4096);
    return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(head);
  } catch {
    return false;
  }
}

function pubComment(keyPath: string): string {
  try {
    const line = fs.readFileSync(`${keyPath}.pub`, "utf8").split("\n")[0].trim();
    const parts = line.split(/\s+/);
    return parts.length >= 3 ? parts.slice(2).join(" ") : "";
  } catch {
    return "";
  }
}

function isEncrypted(keyPath: string): boolean {
  try {
    const head = fs.readFileSync(keyPath, "utf8").slice(0, 8192);
    // OpenSSH 新格式的加密标志是 KDF 名（bcrypt）；老 PEM 格式带 ENCRYPTED
    return /bcrypt|ENCRYPTED/i.test(head);
  } catch {
    return false;
  }
}

/** 列本机私钥（默认名优先，其余按名排序；跳过非私钥文件） */
export function listLocalKeys(sshDir?: string): LocalKeyInfo[] {
  const dir = sshDirOf(sshDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const keys: LocalKeyInfo[] = [];
  for (const name of names) {
    if (SKIP_NAMES.includes(name) || name.endsWith(".pub")) continue;
    const full = path.join(dir, name);
    if (!isPrivateKeyFile(full)) continue;
    const comment = pubComment(full);
    keys.push({ path: full, label: comment || name, encrypted: isEncrypted(full) });
  }
  const rank = (k: LocalKeyInfo): number => {
    const idx = DEFAULT_KEY_NAMES.indexOf(path.basename(k.path));
    return idx < 0 ? DEFAULT_KEY_NAMES.length : idx;
  };
  keys.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  return keys;
}

export interface SshConfigHost {
  name: string;          // Host 别名
  host: string;
  port: number;
  username: string;
  identityFile?: string;
}

/** 解析 ~/.ssh/config（含 Include ≤4 层、去重；忽略通配 Host 与 Match，§8.5） */
export function importSshConfig(sshDir?: string, configPath?: string): SshConfigHost[] {
  const dir = sshDirOf(sshDir);
  const root = configPath ?? path.join(dir, "config");
  const out: SshConfigHost[] = [];
  const seenKeys = new Set<string>();
  const seenFiles = new Set<string>();

  const readFile = (file: string, depth: number): void => {
    if (depth > 4 || seenFiles.has(file)) return;
    seenFiles.add(file);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    let current: SshConfigHost | null = null;
    let inMatch = false;
    const flush = (): void => {
      if (!current) return;
      const key = `${current.name}|${current.host}|${current.port}|${current.username}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        out.push(current);
      }
      current = null;
    };
    for (const rawLine of text.split("\n")) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const [keywordRaw, ...rest] = line.split(/\s+/);
      const keyword = keywordRaw.toLowerCase();
      const value = rest.join(" ");
      if (keyword === "include") {
        flush();
        const pattern = value.replace(/^~/, os.homedir());
        const base = path.isAbsolute(pattern) ? pattern : path.join(dir, pattern);
        for (const included of expandGlob(base)) readFile(included, depth + 1);
        continue;
      }
      if (keyword === "match") {
        flush();
        inMatch = true;
        continue;
      }
      if (keyword === "host") {
        flush();
        inMatch = false;
        if (/[*?]/.test(value) || !value) continue;   // 通配 Host 不进列表
        current = { name: value, host: value, port: 22, username: "" };
        continue;
      }
      if (inMatch || !current) continue;
      if (keyword === "hostname") current.host = value;
      else if (keyword === "port") current.port = Number(value) || 22;
      else if (keyword === "user") current.username = value;
      else if (keyword === "identityfile") current.identityFile = value.replace(/^~/, os.homedir());
    }
    flush();
  };

  readFile(root, 0);
  return out;
}

/** 极简 glob：只支持 * 与 ?（Include 的常见写法），目录不存在就返回空 */
function expandGlob(pattern: string): string[] {
  if (!/[*?]/.test(pattern)) return [pattern];
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const re = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  try {
    return fs.readdirSync(dir).filter((name) => re.test(name)).map((name) => path.join(dir, name)).sort();
  } catch {
    return [];
  }
}
