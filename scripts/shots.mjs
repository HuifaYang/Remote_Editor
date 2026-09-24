// UI 截图（开发用）：欢迎页 / 设置对话框 / 终端面板 / 搜索面板，逐张落盘
// 用法：ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx electron scripts/shots.mjs [--dir /tmp/rce-shots]
import { app, BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

const outDir = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : "/tmp/rce-shots";
fs.mkdirSync(outDir, { recursive: true });

app.whenReady().then(async () => {
  const mod = await import("../dist/main/main/ipc.js");
  const ipc = mod.initSession ? mod : mod.default;
  let win = null;
  ipc.initSession();
  ipc.registerIpc(() => win);
  win = new BrowserWindow({
    width: 1280, height: 800, frame: false, show: false,
    webPreferences: {
      preload: path.resolve("dist/preload/preload/index.js"),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  win.webContents.on("console-message", (_e, _l, message) => console.log("[renderer]", message));
  await win.loadFile(path.resolve("dist/renderer/index.html"));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    const ready = await win.webContents.executeJavaScript("!!(window.monaco && window.api)");
    if (ready) break;
    await wait(250);
  }

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log(`SHOT ${file}`);
  };

  await wait(400);
  await shot("01-welcome");

  // 设置对话框（活动栏底部齿轮）
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.activity-btn')].pop();
    btn.click();
    return true;
  })()`);
  await wait(600);
  await shot("02-settings");
  await win.webContents.executeJavaScript(`(() => {
    const cancel = [...document.querySelectorAll('.dialog-btn')].find(b => b.textContent === '取消');
    if (cancel) cancel.click();
    return true;
  })()`);

  // 终端面板（Ctrl+`）
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', ctrlKey: true, bubbles: true }))`);
  await wait(600);
  await shot("03-terminal");

  // 搜索面板（活动栏第二个图标）
  await win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('.activity-btn')];
    if (btns[1]) btns[1].click();
    return true;
  })()`);
  await wait(400);
  await shot("04-search");

  // 资源管理器空态
  await win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('.activity-btn')];
    if (btns[0]) btns[0].click();
    return true;
  })()`);
  await wait(300);
  await shot("05-explorer");

  app.quit();
});

app.on("window-all-closed", () => app.quit());
