// 真实验证：用内置 clangd 跑通「补全 / 跳转定义 / 诊断」三条链路（不依赖 SSH，直接对本地 C++ 工程）
// 用法：node scripts/verify-lsp.mjs [--verbose]
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { LspClient } = await import("../dist/main/main/lsp/client.js");
const { localTransport } = await import("../dist/main/main/lsp/manager.js");
const { toMonacoCompletion, toMonacoLocation, toMonacoMarker } = await import("../dist/main/shared/lsp-map.js");

const verify = process.argv.includes("--verbose");
const CLANGD = path.resolve("resources/clangd/linux/clangd");
if (!fs.existsSync(CLANGD)) {
  console.error(`✗ 找不到内置 clangd：${CLANGD}`);
  process.exit(2);
}

const project = fs.mkdtempSync(path.join(os.tmpdir(), "rce-lsp-verify-"));
const includeDir = path.join(project, "include");
fs.mkdirSync(includeDir, { recursive: true });
fs.writeFileSync(path.join(includeDir, "robot.hpp"), `#pragma once
class Robot {
public:
  void moveForward(double meters);
  double speed() const;
};
`);
const mainPath = path.join(project, "main.cpp");
const goodSource = `#include "robot.hpp"
int main() {
  Robot robot;
  robot.moveForward(1.0);
  double s = robot.speed();
  return (int)s;
}
`;
fs.writeFileSync(mainPath, goodSource);
// compile_commands 指向真实路径（等价于镜像重写后的结果）
fs.writeFileSync(path.join(project, "compile_commands.json"), JSON.stringify([{
  directory: project,
  file: mainPath,
  command: `c++ -std=c++17 -I${includeDir} -c ${mainPath} -o /tmp/rce-verify.o`,
}], null, 2));

const mainUri = pathToFileURL(mainPath).toString();
const rootUri = pathToFileURL(project).toString();

const child = spawn(CLANGD, [
  "--background-index", "--completion-style=detailed", "--header-insertion=never",
  "--malloc-trim", "-j=2", "--log=error",
  `--compile-commands-dir=${project}`,
], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });

const diagnostics = [];
const client = new LspClient(localTransport(child), {
  rootUri,
  timeoutMs: 20000,
  diagnostics: (e) => diagnostics.push(e),
});

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${verify && detail ? ` — ${detail}` : ""}`);
};

async function waitFor(label, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last && (Array.isArray(last) ? last.length > 0 : true)) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

try {
  await client.start();
  client.didOpen(mainUri, goodSource, 1);

  // 1) 补全：robot. 之后应给出 moveForward / speed
  const lines = goodSource.split("\n");
  const line = lines.findIndex((l) => l.includes("robot.moveForward")) ;
  const character = lines[line].indexOf("robot.") + "robot.".length;
  const items = await waitFor("completion", () => client.completion(mainUri, line, character));
  const itemList = Array.isArray(items) ? items : [];
  const labels = itemList.map((i) => i.label);
  const monacoItems = itemList.map(toMonacoCompletion);
  const completionOk = itemList.length > 0;
  record("代码补全（clangd 返回补全项）", completionOk,
    `${itemList.length} 项，含 ${labels.slice(0, 6).join(", ")}｜首项 Monaco kind=${monacoItems[0]?.kind}`);
  record("补全项包含头文件里的成员", labels.some((l) => /moveForward|speed/.test(l)),
    `命中：${labels.filter((l) => /moveForward|speed/.test(l)).join(", ") || "无"}`);

  // 2) 跳转定义：moveForward 应跳到 include/robot.hpp
  const defChar = lines[line].indexOf("moveForward") + 2;
  const defs = await waitFor("definition", () => client.definition(mainUri, line, defChar));
  const locations = Array.isArray(defs) ? defs : [];
  const mapped = locations.map(toMonacoLocation);
  const defOk = mapped.some((l) => decodeURIComponent(l.uri).endsWith("robot.hpp"));
  record("F12 跳转定义（指向 robot.hpp）", defOk,
    mapped.map((l) => `${l.uri.split("/").pop()} 行 ${l.range.startLineNumber}`).join(", ") || "无结果");

  // 3) 诊断：写一行错代码，应收到 clangd 的报错
  const badSource = goodSource.replace("return (int)s;", "return (int)s");
  client.didChange(mainUri, badSource, 2);
  const diag = await waitFor("diagnostics", () => diagnostics.flatMap((e) => e.diagnostics));
  const diagList = Array.isArray(diag) ? diag : [];
  record("红色波浪线（clangd 诊断）", diagList.length > 0,
    diagList.slice(0, 2).map((d) => `${d.message} @行${d.range.start.line + 1}`).join(" ｜ ") || "无诊断");
  if (diagList.length > 0) {
    const marker = toMonacoMarker(diagList[0]);
    record("诊断转 Monaco marker（setModelMarkers 用）", marker.severity === 8 && marker.startLineNumber > 0,
      `severity=${marker.severity} 行=${marker.startLineNumber} 列=${marker.startColumn}`);
  }

  // 4) 悬浮（Hover）
  const hover = await waitFor("hover", () => client.hover(mainUri, line, character));
  record("悬浮文档（Hover）", typeof hover === "string" && hover.length > 0,
    typeof hover === "string" ? hover.slice(0, 60).replace(/\n/g, " ") : String(hover));
} catch (err) {
  record("LSP 验证过程", false, String(err));
} finally {
  await client.dispose().catch(() => { /* 退出路径不抛 */ });
  if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(project, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
