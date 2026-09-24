// Electron 主进程入口：窗口创建、生命周期（总纲 §3）
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { initSession, registerIpc, shutdownSession } from "./ipc";
import { initLog, log } from "./log";

let mainWindow: BrowserWindow | null = null;

void app.whenReady().then(() => {
  initLog();
  log("info", "应用启动");
  initSession();
  registerIpc(() => mainWindow);
  mainWindow = createMainWindow(app.getPath("userData"));
  mainWindow.on("closed", () => { mainWindow = null; });
});

// 退出前收口：语言服务器与 SSH 都要关（§5.5.1 不留僵尸进程）
app.on("before-quit", () => {
  void shutdownSession();
});

// 无 macOS 需求（总纲 §1.4）：全部窗口关闭即退出
app.on("window-all-closed", () => {
  log("info", "应用退出");
  app.quit();
});
