#!/usr/bin/env node
// 把我们的扩展打成自包含的单文件 JS（含我们自己的 SSH 层 + ssh2），并同步到上游 extensions/ 目录，
// 这样打出来的 CodeOSS 里就自带"我们的 SSH"。
//
// 用法：node ide/tools/build-extension.mjs
"use strict";

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const TOOLS = import.meta.dirname;
const ROOT = path.resolve(TOOLS, "..", "..");
const SRC = path.resolve(ROOT, "ide", "extensions", "sshfs");     // 唯一真源
const VSCODE = path.resolve(ROOT, "ide", "vscode");
const DEST = path.resolve(VSCODE, "extensions", "rce-remote");    // 构建期产物（ide/vscode 已 gitignore）
const PKG_DEST = path.resolve(ROOT, "ide", "VSCode-linux-x64", "resources", "app", "extensions", "rce-remote");
const PRODUCTS = [
  path.resolve(VSCODE, "product.json"),
  path.resolve(ROOT, "ide", "VSCode-linux-x64", "resources", "app", "product.json"),
];
const REQUIRED_PROPOSALS = [
  "fileSearchProvider",
  "textSearchProvider",
  "contribViewsRemote",
  "scmHistoryProvider",
  "scmActionButton",
  "contribSourceControlHistoryItemMenu",
];
const LANG_SRC = path.resolve(VSCODE, "extensions", "language-pack-zh-hans", "translations", "main.i18n.json");
const LANG_DEST = path.resolve(ROOT, "ide", "VSCode-linux-x64", "resources", "app", "extensions", "language-pack-zh-hans", "translations", "main.i18n.json");
const PYTHON_LSP_SRC = path.resolve(ROOT, "resources", "python-lsp");

// 正式包只允许 product.json 白名单里的 proposed API。build-extension 会直接同步到已解包的
// VSCode-linux-x64，因此这里同步补齐白名单，避免「源码里正常、正式包看不到 Remote Explorer」。
function ensureProposals(file) {
  if (!fs.existsSync(file)) return;
  const product = JSON.parse(fs.readFileSync(file, "utf8"));
  const all = product.extensionEnabledApiProposals || (product.extensionEnabledApiProposals = {});
  const current = new Set(all["remote-code-editor.rce-remote"] || []);
  for (const proposal of REQUIRED_PROPOSALS) current.add(proposal);
  all["remote-code-editor.rce-remote"] = [...current];
  fs.writeFileSync(file, `${JSON.stringify(product, null, "\t")}\n`);
}

for (const product of PRODUCTS) ensureProposals(product);

// 品牌补丁会改 workbench.desktop.main.js 等内置文件。CodeOSS 启动时会拿 product.json
// 里的 checksum 校验安装完整性；不重算就会出现“安装似乎损坏”的假警报。
function refreshChecksums(file) {
  if (!fs.existsSync(file)) return;
  const product = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!product.checksums) return;
  const appRoot = path.dirname(file);
  let changed = false;
  for (const rel of Object.keys(product.checksums)) {
    // product.checksums 的 key（如 vs/workbench/...）是相对 resources/app/out/ 的路径，
    // 不是相对 product.json 所在目录；路径写错会静默跳过，导致 integrity 继续报警。
    const target = [path.join(appRoot, "out", rel), path.join(appRoot, rel)]
      .find((candidate) => fs.existsSync(candidate));
    if (!target) continue;
    const actual = createHash("sha256").update(fs.readFileSync(target)).digest("base64").replace(/=+$/, "");
    if (product.checksums[rel] !== actual) {
      product.checksums[rel] = actual;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, `${JSON.stringify(product, null, "\t")}\n`);
}
for (const product of PRODUCTS) refreshChecksums(product);

if (fs.existsSync(LANG_SRC) && fs.existsSync(path.dirname(LANG_DEST))) {
  fs.copyFileSync(LANG_SRC, LANG_DEST);
}

// 先用仓库自己的编译产物保证 SSH 层是最新的
console.log("== 1/3 编译仓库 SSH 层（npm run compile）");
const { execFileSync } = await import("node:child_process");
execFileSync("npm", ["run", "compile"], { cwd: ROOT, stdio: "inherit" });

console.log("== 2/3 esbuild 打包扩展（含 SSH 层与 ssh2）");
// esbuild 由上游或本仓库提供（两边都找一下）
const esbuildCandidates = [
  path.resolve(VSCODE, "node_modules", "esbuild", "lib", "main.js"),
  path.resolve(ROOT, "node_modules", "esbuild", "lib", "main.js"),
];
const esbuildEntry = esbuildCandidates.find((p) => fs.existsSync(p));
if (!esbuildEntry) throw new Error("找不到 esbuild（上游或仓库根 node_modules 都没有）");
const esbuild = await import(pathToFileURL(esbuildEntry).href);
await esbuild.build({
  entryPoints: [path.join(SRC, "src", "extension.js")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(SRC, "out", "extension.js"),
  // vscode 由宿主提供；cpu-features / *.node 是 ssh2 的可选原生加速（ssh2 里是 try/catch 引的），
  // 缺失时 ssh2 自动退回纯 JS 实现，所以这里保持外部引用即可
  external: ["vscode", "cpu-features", "*.node"],
  // src/main/** 里的主进程代码（日志模块）会 require("electron")，扩展宿主里没有这个模块 ——
  // 用 alias 指到打包桩，这样 SSH 层 / 镜像层 / 语言服务层可以原样复用，不用抄第二份
  alias: { electron: path.join(SRC, "src", "electron-stub.js") },
  logLevel: "info",
});

console.log(`== 3/3 同步到 ${DEST}`);
// 早期版本的产物目录叫 extensions/sshfs，留着会和 rce-remote 抢同一个 sshfs:// scheme（激活即报
// "a provider for the scheme 'sshfs' is already registered"），所以每次构建顺手清掉
fs.rmSync(path.resolve(VSCODE, "extensions", "sshfs"), { recursive: true, force: true });
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
for (const f of ["package.json", "out/extension.js", "resources/remote-explorer.svg"]) {
  const target = path.join(DEST, f);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(SRC, f), target);
}
if (fs.existsSync(PYTHON_LSP_SRC)) {
  fs.cpSync(PYTHON_LSP_SRC, path.join(DEST, "resources", "python-lsp"), { recursive: true });
}
fs.writeFileSync(path.join(DEST, "README.md"), "构建期产物，勿改。真源：ide/extensions/sshfs\n");

// 若已经有正式 Linux 包，同步替换其中的内置扩展，避免跑正式包时还是旧 SSH 层。
if (fs.existsSync(path.dirname(path.dirname(PKG_DEST)))) {
  fs.rmSync(PKG_DEST, { recursive: true, force: true });
  fs.mkdirSync(PKG_DEST, { recursive: true });
  for (const f of ["package.json", "out/extension.js", "resources/remote-explorer.svg"]) {
    const target = path.join(PKG_DEST, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), target);
  }
  if (fs.existsSync(PYTHON_LSP_SRC)) {
    fs.cpSync(PYTHON_LSP_SRC, path.join(PKG_DEST, "resources", "python-lsp"), { recursive: true });
  }
  fs.writeFileSync(path.join(PKG_DEST, "README.md"), "构建期产物，勿改。真源：ide/extensions/sshfs\n");
  console.log(`== 4/4 已同步到正式包 ${PKG_DEST}`);
}
console.log("完成。");
