#!/usr/bin/env node
// 组装一个带 NLS 中文索引的本地运行目录。目录必须是真实目录（不能把 out 直接做成软链），
// 否则 CodeOSS 会把 appRoot 解析回 vscode/out，再次加载未翻译的开发版源码。
"use strict";

import fs from "node:fs";
import path from "node:path";

const TOOLS = import.meta.dirname;
const VSCODE = path.resolve(TOOLS, "..", "vscode");
const APP = path.join(TOOLS, "app-out-vscode");
const OUT = path.join(APP, "out");
const SOURCE_OUT = path.join(VSCODE, "out-vscode");

function linkOrCopyFile(source, target) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	try {
		fs.linkSync(source, target);
	} catch {
		fs.copyFileSync(source, target);
	}
}

function cloneTree(source, target) {
	fs.mkdirSync(target, { recursive: true });
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(target, entry.name);
		if (entry.isDirectory()) cloneTree(from, to);
		else if (entry.isFile()) linkOrCopyFile(from, to);
		else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
	}
}

function setLink(name, relativeTarget) {
	const target = path.join(APP, name);
	try { fs.unlinkSync(target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
	fs.symlinkSync(relativeTarget, target);
}

if (!fs.existsSync(path.join(SOURCE_OUT, "main.js")) || !fs.existsSync(path.join(SOURCE_OUT, "nls.messages.json"))) {
	throw new Error("缺少带 NLS 的 out-vscode，请先运行：RCE_REBUILD_ZH=1 bash ide/tools/run-app.sh");
}

fs.mkdirSync(APP, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true });
cloneTree(SOURCE_OUT, OUT);

setLink("extensions", "../../vscode/extensions");
setLink("resources", "../../vscode/resources");
setLink("product.json", "../../vscode/product.json");
setLink("node_modules", "../../vscode/node_modules");
// 打包运行时上游只认 node_modules.asar；开发目录没有归档，用同名软链指向真实依赖即可。
setLink("node_modules.asar", "../../vscode/node_modules");

fs.writeFileSync(path.join(APP, "package.json"), `${JSON.stringify({
	name: "weavecode-zh",
	version: JSON.parse(fs.readFileSync(path.join(VSCODE, "package.json"), "utf8")).version,
	type: "module",
	main: "./out/main.js",
}, null, 2)}\n`);

console.log(`[i18n] 中文运行目录已就绪：${APP}`);
