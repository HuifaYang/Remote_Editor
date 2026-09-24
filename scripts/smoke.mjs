// 开发冒烟脚本（不进安装包）：起窗口 → 等 Monaco 就绪 → 截图 → 退出。
// 用法：xvfb-run -a npx electron scripts/smoke.mjs [--no-sandbox]
import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";

const outPng = process.argv.includes("--png")
  ? process.argv[process.argv.indexOf("--png") + 1]
  : "/tmp/rce-smoke.png";

app.whenReady().then(async () => {
  // 必须走真实入口的初始化，否则渲染进程调 window.api 会报「没有注册 handler」
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
  win.webContents.on("console-message", (_e, _level, message) => console.log("[renderer]", message));
  await win.loadFile(path.resolve("dist/renderer/index.html"));
  // 等 Monaco 全局对象出现（最多 15 秒）
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await win.webContents.executeJavaScript("!!(window.monaco && document.querySelector('.editor-container .monaco-editor'))");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(ready ? "SMOKE: monaco ready" : "SMOKE: monaco NOT ready (timeout)");
  const apiOk = await win.webContents.executeJavaScript("!!window.api && typeof window.api.window.minimize === 'function'");
  console.log(apiOk ? "SMOKE: preload api ok" : "SMOKE: preload api MISSING");
  // 图标加载探针：SVG 能否取到、mask 计算样式是否生效
  const probe = await win.webContents.executeJavaScript(`(async () => {
    const el = document.querySelector(".activity-btn .icon");
    if (!el) return "no .icon element";
    const cs = getComputedStyle(el);
    const url = el.style.getPropertyValue("--icon-url");
    const load = await new Promise((res) => {
      const img = new Image();
      img.onload = () => res("img-ok " + img.width + "x" + img.height);
      img.onerror = (e) => res("img-FAIL");
      img.src = "../../resources/codicons/files.svg";
    });
    return JSON.stringify({ url, mask: cs.webkitMaskImage || cs.maskImage, bg: cs.backgroundColor,
      w: el.offsetWidth, h: el.offsetHeight, load });
  })()`);
  console.log("SMOKE icon probe:", probe);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(outPng, img.toPNG());
  console.log("SMOKE: screenshot ->", outPng);
  app.exit(ready && apiOk ? 0 : 1);
});
