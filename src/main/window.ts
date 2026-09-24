// BrowserWindow 创建与安全配置（总纲 §5 / §8.1：sandbox + contextIsolation，无系统标题栏）
import { BrowserWindow } from "electron";
import * as path from "node:path";
import type { AppSettings } from "./config/settings.js";
import { SettingsStore } from "./config/settings.js";

export const MIN_WIDTH = 960;
export const MIN_HEIGHT = 600;

/** 读取窗口状态；坏文件/缺字段回默认，避免启动失败（规格未覆盖：先创建窗口再初始化会话） */
function loadWindowSettings(userData: string): AppSettings["window"] {
  try {
    return new SettingsStore(path.join(userData, "settings.json")).get().window;
  } catch {
    return { x: 0, y: 0, width: 1280, height: 800, maximized: false };
  }
}

export function createMainWindow(settingsDir: string): BrowserWindow {
  const saved = loadWindowSettings(settingsDir);
  const win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,                    // 自绘标题栏（总纲 §6.1）
    backgroundColor: "#1f1f1f",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../../preload/preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  if (saved.maximized) win.maximize();
  void win.loadFile(path.join(__dirname, "../../renderer/index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send("window-state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("window-state", { maximized: false }));
  return win;
}
