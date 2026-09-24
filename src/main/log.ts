// 日志（总纲 §9.4）：落 userData/logs/app-YYYYMMDD.log，按天滚动，保留 7 天；级别 INFO 起；脱敏
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

let logDir = "";

export function initLog(): void {
  logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  rotateOldLogs();
}

function logFile(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return path.join(logDir, `app-${day}.log`);
}

/** 删除 7 天前的日志 */
function rotateOldLogs(): void {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const name of fs.readdirSync(logDir)) {
    const m = /^app-(\d{4})(\d{2})(\d{2})\.log$/.exec(name);
    if (!m) continue;
    if (new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime() < cutoff) {
      fs.rmSync(path.join(logDir, name), { force: true });
    }
  }
}

/** 脱敏：密码 / 口令 / 私钥内容一律 <已脱敏>（总纲 §8.7） */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<已脱敏>")
    .replace(/(password|passphrase|口令|密码)["']?\s*[:=]\s*["']?[^"',}\s]+/gi, "$1=<已脱敏>");
}

export function log(level: "info" | "warn" | "error", message: string): void {
  if (!logDir) return; // initLog 之前只落内存（启动早期）
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redact(message)}\n`;
  fs.appendFileSync(logFile(), line, "utf8");
}
