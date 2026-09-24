// settings.json（分册 3 D1.2）：逐字段校验范围，非法值回默认；禁止整份读失败就崩
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "../log.js";

export interface AppSettings {
  version: 1;
  theme: "dark" | "light";
  uiFontFamily: string;
  fontSize: number;            // 8~32
  zoomLevel: number;           // 0.7~2.0
  tabSize: number;             // 1~16
  useSpaces: boolean;
  wordWrap: boolean;
  showLineNumbers: boolean;
  highlightCurrentLine: boolean;
  autoSave: boolean;
  autoSaveDelayMs: number;     // 500~30000
  maxFileSizeMb: number;       // 1~512
  sshTimeoutSeconds: number;   // 3~300
  sshKeepaliveSeconds: number; // 0~300
  sshStrictHostKey: boolean;
  lspEnabled: boolean;
  lspTransport: "local" | "remote" | "disabled";
  cppServer: string;
  pythonServer: string;
  window: { x: number; y: number; width: number; height: number; maximized: boolean };
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  theme: "dark",
  uiFontFamily: "",
  fontSize: 12,
  zoomLevel: 1,
  tabSize: 4,
  useSpaces: true,
  wordWrap: false,
  showLineNumbers: true,
  highlightCurrentLine: true,
  autoSave: true,
  autoSaveDelayMs: 1500,
  maxFileSizeMb: 32,
  sshTimeoutSeconds: 15,
  sshKeepaliveSeconds: 30,
  sshStrictHostKey: false,
  lspEnabled: true,
  lspTransport: "local",
  cppServer: "clangd",
  pythonServer: "python3 -m pylsp",
  window: { x: 0, y: 0, width: 1280, height: 800, maximized: false },
};

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** 校验并合并（导出给单测用）；缺字段/越界一律回默认 */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS;
  if (typeof raw !== "object" || raw === null) return { ...d, window: { ...d.window } };
  const r = raw as Record<string, unknown>;
  const win = (typeof r.window === "object" && r.window !== null ? r.window : {}) as Record<string, unknown>;
  return {
    version: 1,
    theme: r.theme === "light" ? "light" : "dark",
    uiFontFamily: str(r.uiFontFamily, d.uiFontFamily),
    fontSize: num(r.fontSize, d.fontSize, 8, 32),
    zoomLevel: num(r.zoomLevel, d.zoomLevel, 0.7, 2),
    tabSize: num(r.tabSize, d.tabSize, 1, 16),
    useSpaces: bool(r.useSpaces, d.useSpaces),
    wordWrap: bool(r.wordWrap, d.wordWrap),
    showLineNumbers: bool(r.showLineNumbers, d.showLineNumbers),
    highlightCurrentLine: bool(r.highlightCurrentLine, d.highlightCurrentLine),
    autoSave: bool(r.autoSave, d.autoSave),
    autoSaveDelayMs: num(r.autoSaveDelayMs, d.autoSaveDelayMs, 500, 30000),
    maxFileSizeMb: num(r.maxFileSizeMb, d.maxFileSizeMb, 1, 512),
    sshTimeoutSeconds: num(r.sshTimeoutSeconds, d.sshTimeoutSeconds, 3, 300),
    sshKeepaliveSeconds: num(r.sshKeepaliveSeconds, d.sshKeepaliveSeconds, 0, 300),
    sshStrictHostKey: bool(r.sshStrictHostKey, d.sshStrictHostKey),
    lspEnabled: bool(r.lspEnabled, d.lspEnabled),
    lspTransport: r.lspTransport === "remote" ? "remote" : r.lspTransport === "disabled" ? "disabled" : "local",
    cppServer: str(r.cppServer, d.cppServer),
    pythonServer: str(r.pythonServer, d.pythonServer),
    window: {
      x: num(win.x, d.window.x, -100000, 100000),
      y: num(win.y, d.window.y, -100000, 100000),
      width: num(win.width, d.window.width, 960, 100000),
      height: num(win.height, d.window.height, 600, 100000),
      maximized: bool(win.maximized, d.window.maximized),
    },
  };
}

export class SettingsStore {
  private cache: AppSettings | null = null;
  constructor(private readonly file: string) {}

  get(): AppSettings {
    if (!this.cache) {
      let raw = "";
      try {
        raw = fs.readFileSync(this.file, "utf8");
      } catch {
        raw = "";
      }
      if (raw) {
        try {
          this.cache = normalizeSettings(JSON.parse(raw));
        } catch (err) {
          log("warn", `settings.json 解析失败，用默认设置：${String(err)}`);
        }
      }
      this.cache ??= { ...DEFAULT_SETTINGS, window: { ...DEFAULT_SETTINGS.window } };
    }
    return this.cache;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = normalizeSettings({ ...this.get(), ...patch });
    this.cache = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2) + "\n", "utf8");
    return next;
  }
}
