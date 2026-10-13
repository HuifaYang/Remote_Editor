#!/usr/bin/env node
// 把与当前 CodeOSS 同版本的官方简体中文语言包内置到应用里。
// 目标机零部署不变：语言包只随本地程序分发，不往远端安装任何东西。
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const TOOLS = import.meta.dirname;
const VSCODE = path.resolve(TOOLS, "..", "vscode");
const DEST = path.join(VSCODE, "extensions", "language-pack-zh-hans");
const TMP = path.join(TOOLS, "tmp");
const VERSION = JSON.parse(fs.readFileSync(path.join(VSCODE, "package.json"), "utf8")).version;
const LOC_BRANCH = `update-localization-files-microsoft-vscode-loc-drop-vscode-version-number-${VERSION}`;
const TARBALL_URL = `https://codeload.github.com/microsoft/vscode-loc/tar.gz/refs/heads/${LOC_BRANCH}`;
const MARKETPLACE_URL = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-ceintl/vsextensions/vscode-language-pack-zh-hans/latest/vspackage";
const USER_DATA_DIRS = ["udd-app", "udd-oss", "udd-pkg"].map((name) => path.join(TOOLS, name));

function readManifest() {
	return JSON.parse(fs.readFileSync(path.join(DEST, "package.json"), "utf8"));
}

function installed() {
	try {
		const pkg = readManifest();
		return String(pkg?.publisher || "").toLowerCase() === "ms-ceintl"
			&& pkg?.name === "vscode-language-pack-zh-hans"
			&& pkg?.version === VERSION;
	} catch {
		return false;
	}
}

function patchProductTranslations() {
	const file = path.join(DEST, "translations", "main.i18n.json");
	if (!fs.existsSync(file)) return;
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	const section = data?.contents?.["vs/workbench/contrib/remote/browser/remoteIndicator"];
	if (!section || section["closeVirtualWorkspace.title"] === "关闭远程连接") return;
	// CodeOSS 对 sshfs:// 走 virtualWorkspace 分支，动作仍是关闭远程窗口并断开连接；
	// 产品里按 VS Code 的菜单名显示为“关闭远程连接”，不再暴露含糊的“关闭远程工作区”。
	section["closeVirtualWorkspace.title"] = "关闭远程连接";
	fs.writeFileSync(file, `${JSON.stringify(data, null, "\t")}\n`);
}

function writeLanguagePackConfig() {
	const pkg = readManifest();
	const localization = pkg.contributes?.localizations?.find((entry) => entry?.languageId === "zh-cn");
	if (!localization) throw new Error("简体中文语言包缺少 zh-cn localizations 配置");
	const translations = {};
	for (const entry of localization.translations || []) {
		if (typeof entry?.id === "string" && typeof entry?.path === "string") {
			translations[entry.id] = path.resolve(DEST, entry.path);
		}
	}
	const extensionId = `${pkg.publisher}.${pkg.name}`.toLowerCase();
	const hash = createHash("md5").update(extensionId).update(pkg.version).digest("hex");
	const config = {
		"zh-cn": {
			hash,
			extensions: [{ extensionIdentifier: { id: extensionId }, version: pkg.version }],
			translations,
			label: localization.localizedLanguageName || localization.languageName || "中文(简体)",
		},
	};
	const raw = `${JSON.stringify(config)}\n`;
	for (const dir of USER_DATA_DIRS) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "languagepacks.json"), raw);
	}
	console.log(`[i18n] 已预置语言包配置（${VERSION}，${Object.keys(translations).length} 个翻译域）`);
}

function ensureDevNlsMetadata() {
	const outDir = path.join(VSCODE, "out");
	const candidates = [path.join(VSCODE, "out-vscode"), path.join(VSCODE, "out-build")];
	for (const name of ["nls.keys.json", "nls.messages.json"]) {
		const target = path.join(outDir, name);
		if (fs.existsSync(target)) continue;
		const source = candidates.map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
		if (source) {
			fs.mkdirSync(outDir, { recursive: true });
			fs.copyFileSync(source, target);
		}
	}
}

function installFromTarball(bytes) {
	const archive = path.join(TMP, `vscode-language-pack-zh-hans-${VERSION}.tar.gz`);
	const extract = fs.mkdtempSync(path.join(os.tmpdir(), "rce-zh-pack-"));
	fs.writeFileSync(archive, bytes);
	try {
		execFileSync("tar", ["-xzf", archive, "-C", extract], { stdio: "inherit" });
		const root = fs.readdirSync(extract, { withFileTypes: true }).find((entry) => entry.isDirectory());
		if (!root) throw new Error("语言包压缩包结构不对：没有顶层目录");
		const source = path.join(extract, root.name, "i18n", "vscode-language-pack-zh-hans");
		if (!fs.existsSync(path.join(source, "package.json"))) throw new Error("语言包压缩包缺少 package.json");
		fs.rmSync(DEST, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(DEST), { recursive: true });
		fs.cpSync(source, DEST, { recursive: true });
	} finally {
		fs.rmSync(extract, { recursive: true, force: true });
	}
}

function installFromVsix(bytes) {
	const archive = path.join(TMP, `vscode-language-pack-zh-hans-${VERSION}.vsix`);
	const zip = path.join(TMP, `vscode-language-pack-zh-hans-${VERSION}.zip`);
	const extract = fs.mkdtempSync(path.join(os.tmpdir(), "rce-zh-pack-"));
	fs.writeFileSync(archive, bytes);
	const unzipped = bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes;
	fs.writeFileSync(zip, unzipped);
	try {
		execFileSync("unzip", ["-q", zip, "extension/*", "-d", extract], { stdio: "inherit" });
		const source = path.join(extract, "extension");
		if (!fs.existsSync(path.join(source, "package.json"))) throw new Error("语言包 VSIX 结构不对：缺少 extension/package.json");
		fs.rmSync(DEST, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(DEST), { recursive: true });
		fs.cpSync(source, DEST, { recursive: true });
	} finally {
		fs.rmSync(extract, { recursive: true, force: true });
	}
}

if (!installed()) {
	fs.mkdirSync(TMP, { recursive: true });
	console.log(`[i18n] 下载 CodeOSS ${VERSION} 官方简体中文语言包…`);
	try {
		const response = await fetch(TARBALL_URL);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		installFromTarball(Buffer.from(await response.arrayBuffer()));
	} catch (error) {
		console.warn(`[i18n] 同版本 GitHub 包不可用，改用市场 latest：${error instanceof Error ? error.message : error}`);
		const response = await fetch(MARKETPLACE_URL);
		if (!response.ok) throw new Error(`下载语言包失败：HTTP ${response.status}`);
		installFromVsix(Buffer.from(await response.arrayBuffer()));
	}
	console.log(`[i18n] 已内置到 ${DEST}`);
} else {
	console.log(`[i18n] 简体中文语言包已内置（${VERSION}）`);
}

patchProductTranslations();
writeLanguagePackConfig();
ensureDevNlsMetadata();
