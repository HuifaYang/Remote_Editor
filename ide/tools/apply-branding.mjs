// 给上游 CodeOSS 打上"我们自己的产品"这套改动（可重复执行，升级上游后重跑一遍即可）。
//
// 设计原则：**上游源码保持干净**，我们的改动全部集中在 product.json 的少数几个字段，
// 由本脚本幂等写入。这样 git 里只有这一个脚本需要维护，升级上游就是"拉新代码 + 重跑本脚本"。
//
// 用法：node ide/tools/apply-branding.mjs [--dry-run]
"use strict";

import fs from "node:fs";
import path from "node:path";

const PRODUCT = path.resolve(import.meta.dirname, "..", "vscode", "product.json");
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"));
const dryRun = process.argv.includes("--dry-run");

const GALLERY_PRESETS = {
  openvsx: {
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    itemUrl: "https://open-vsx.org/vscode/item",
    resourceUrlTemplate: "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
    controlUrl: "",
    recommendationsUrl: "",
  },
  microsoft: {
    nlsBaseUrl: "https://www.vscode-unpkg.net/_lp/",
    serviceUrl: "https://marketplace.visualstudio.com/_apis/public/gallery",
    itemUrl: "https://marketplace.visualstudio.com/items",
    publisherUrl: "https://marketplace.visualstudio.com/publishers",
    resourceUrlTemplate: "https://{publisher}.vscode-unpkg.net/{publisher}/{name}/{version}/{path}",
    extensionUrlTemplate: "https://www.vscode-unpkg.net/_gallery/{publisher}/{name}/latest",
    controlUrl: "https://main.vscode-cdn.net/extensions/marketplace.json",
    mcpUrl: "https://main.vscode-cdn.net/mcp/servers.json",
  },
};

function resolveGallery() {
  const custom = process.env.RCE_EXTENSION_GALLERY_JSON;
  if (custom) {
    try {
      return { kind: "custom", gallery: JSON.parse(custom) };
    } catch (err) {
      throw new Error(`RCE_EXTENSION_GALLERY_JSON 不是合法 JSON：${err && err.message}`);
    }
  }
  const kind = (process.env.RCE_EXTENSION_GALLERY || "openvsx").toLowerCase();
  const gallery = GALLERY_PRESETS[kind];
  if (!gallery) {
    throw new Error(`RCE_EXTENSION_GALLERY 只支持 openvsx、microsoft 或 RCE_EXTENSION_GALLERY_JSON，收到：${kind}`);
  }
  return { kind, gallery };
}

const gallerySelection = resolveGallery();

// ---- 品牌（改这里就能换名字） ----
const BRAND = {
  nameShort: "织码",
  nameLong: "织码 WeaveCode",
  applicationName: "weavecode",
  dataFolderName: ".weavecode",
  win32DirName: "WeaveCode",
  win32MutexName: "weavecode",
  win32RegValueName: "WeaveCode",
  win32AppUserModelId: "WeaveCode.WeaveCode",
  darwinBundleIdentifier: "com.weavecode.app",
  linuxIconName: "weavecode",
  linuxDesktopName: "com.weavecode.WeaveCode",
  urlProtocol: "weavecode",
  reportIssueUrl: "https://github.com/HuifaYang/Remote_Editor/issues/new",
  serverApplicationName: "weavecode-server",
  serverDataFolderName: ".weavecode-server",
  // 本产品不做端口转发/隧道；置空后 Linux 依赖生成器不会把不存在的 tunnel 二进制当必需文件。
  tunnelApplicationName: undefined,
};

// ---- 行为开关 ----
const behavior = {
  // 应用内运行时版本伪装成上游 CodeOSS 基线。官方扩展（尤其 Copilot Chat）会按
  // engines.vscode 判断宿主兼容性，看见 3.0.0-alpha.0 会拒绝安装。deb 包版本仍由
  // Linux 打包链读取这里的 productVersionOverride，不受影响。
  productVersionOverride: "1.142.0",
  version: ROOT_PACKAGE.version,
  enableTelemetry: false,          // 不发遥测
  // 源码版的 product.json 没有 commit；语言包缓存路径 nlsMetadataHash ?? commit 会拼到 undefined，
  // 导致简体中文语言包被静默回退成英文。给一个稳定的构建标识，打包时应由正式 CI 的 hash 覆盖。
  nlsMetadataHash: "weavecode-i18n-v1",
  builtInExtensions: [],           // 不再从微软市场内置扩展（许可干净 + 构建不依赖外网）
  // 这条必须跟着一起清空：否则 GitHub.copilot-chat 会被当成“内置自动更新扩展”，
  // 用户手动装官方 VSIX 时被 extensionsScannerService 直接跳过（报 Cannot read the extension）。
  builtInExtensionsEnabledWithAutoUpdates: [],
  // 正式版（isBuilt）里 proposed API 必须在这里放行，否则我们的远端搜索注册不上
  // （extensionsProposedApi.ts：出源码跑时全放开，打包后只认这份白名单）
  // Copilot 全家桶（官方 VSIX，从市场安装）必须放行其声明的 proposed API，否则登录、
  // 聊天、补全全部失效（日志报 CANNOT USE these API proposals）。清单取自上游
  // microsoft/vscode 仓库 extensions/copilot 与用户机已装 copilot-chat 0.48.1 的
  // enabledApiProposals 并集，剔除了本代码库不存在的 languageModelRateLimit。
  // 升级扩展版本后若新增 proposal，需同步更新这里。
  extensionEnabledApiProposals: {
    "remote-code-editor.rce-remote": [
      "fileSearchProvider",
      "textSearchProvider",
      "contribViewsRemote",
      "scmHistoryProvider",
      "scmActionButton",
      "contribSourceControlHistoryItemMenu",
    ],
    "github.copilot": [
			"activeComment",
			"agentSessionsWorkspace",
			"agentsWindowConfiguration",
			"aiRelatedInformation",
			"aiSettingsSearch",
			"aiTextSearchProvider",
			"authIssuers",
			"authLearnMore",
			"chatDebug",
			"chatHooks",
			"chatInputNotification",
			"chatParticipantAdditions",
			"chatParticipantPrivate",
			"chatPromptFiles",
			"chatProvider",
			"chatReferenceBinaryData",
			"chatReferenceDiagnostic",
			"chatSessionCustomizationProvider",
			"chatSessionsProvider",
			"chatStatusItem",
			"codeActionAI",
			"commentReveal",
			"contribChatEditorInlineGutterMenu",
			"contribCommentThreadAdditionalMenu",
			"contribCommentsViewThreadMenus",
			"contribDebugCreateConfiguration",
			"contribEditorContentMenu",
			"contribLanguageModelToolSets",
			"contribSourceControlInputBoxMenu",
			"dataChannels",
			"defaultChatParticipant",
			"devDeviceId",
			"documentFiltersExclusive",
			"embeddings",
			"envIsConnectionMetered",
			"environmentPower",
			"extensionsAny",
			"findFiles2",
			"findTextInFiles",
			"findTextInFiles2",
			"inlineCompletionsAdditions",
			"interactive",
			"languageModelCapabilities",
			"languageModelPricing",
			"languageModelSystem",
			"languageModelThinkingPart",
			"languageModelToolSupportsModel",
			"mappedEditsProvider",
			"mcpServerDefinitions",
			"newSymbolNamesProvider",
			"resolvers",
			"tabInputMultiDiff",
			"taskExecutionTerminal",
			"taskProblemMatcherStatus",
			"terminalDataWriteEvent",
			"terminalExecuteCommandEvent",
			"terminalQuickFixProvider",
			"terminalSelection",
			"terminalTitle",
			"testObserver",
			"textDocumentChangeReason",
			"textSearchProvider",
			"textSearchProvider2",
			"toolInvocationApproveCombination",
			"workspaceTrust",
    ],
    "github.copilot-chat": [
			"activeComment",
			"agentSessionsWorkspace",
			"agentsWindowConfiguration",
			"aiRelatedInformation",
			"aiSettingsSearch",
			"aiTextSearchProvider",
			"authIssuers",
			"authLearnMore",
			"chatDebug",
			"chatHooks",
			"chatInputNotification",
			"chatParticipantAdditions",
			"chatParticipantPrivate",
			"chatPromptFiles",
			"chatProvider",
			"chatReferenceBinaryData",
			"chatReferenceDiagnostic",
			"chatSessionCustomizationProvider",
			"chatSessionsProvider",
			"chatStatusItem",
			"codeActionAI",
			"commentReveal",
			"contribChatEditorInlineGutterMenu",
			"contribCommentThreadAdditionalMenu",
			"contribCommentsViewThreadMenus",
			"contribDebugCreateConfiguration",
			"contribEditorContentMenu",
			"contribLanguageModelToolSets",
			"contribSourceControlInputBoxMenu",
			"dataChannels",
			"defaultChatParticipant",
			"devDeviceId",
			"documentFiltersExclusive",
			"embeddings",
			"envIsConnectionMetered",
			"environmentPower",
			"extensionsAny",
			"findFiles2",
			"findTextInFiles",
			"findTextInFiles2",
			"inlineCompletionsAdditions",
			"interactive",
			"languageModelCapabilities",
			"languageModelPricing",
			"languageModelSystem",
			"languageModelThinkingPart",
			"languageModelToolSupportsModel",
			"mappedEditsProvider",
			"mcpServerDefinitions",
			"newSymbolNamesProvider",
			"resolvers",
			"tabInputMultiDiff",
			"taskExecutionTerminal",
			"taskProblemMatcherStatus",
			"terminalDataWriteEvent",
			"terminalExecuteCommandEvent",
			"terminalQuickFixProvider",
			"terminalSelection",
			"terminalTitle",
			"testObserver",
			"textDocumentChangeReason",
			"textSearchProvider",
			"textSearchProvider2",
			"toolInvocationApproveCombination",
			"workspaceTrust",
    ],
  },
  extensionsGallery: gallerySelection.gallery,
};

console.log(`[marketplace] 扩展市场：${gallerySelection.kind || "custom"}`);

const product = JSON.parse(fs.readFileSync(PRODUCT, "utf8"));
const target = { ...BRAND, ...behavior };
const changed = Object.keys(target).filter((k) => JSON.stringify(product[k]) !== JSON.stringify(target[k]));

for (const [k, v] of Object.entries(target)) {
  if (k === "extensionEnabledApiProposals") {
    // 保留上游为 Copilot / Chat 等扩展预置的 proposed API 白名单，只追加我们自己的。
    product[k] = { ...(product[k] || {}), ...v };
  } else {
    product[k] = v;
  }
}
console.log(changed.length ? `[branding] 需要改写 ${changed.length} 个字段：${changed.join(", ")}` : "[branding] 已经是目标状态");

if (dryRun) {
  console.log("[branding] --dry-run，未写入。");
} else {
  fs.writeFileSync(PRODUCT, `${JSON.stringify(product, null, "\t")}\n`);
  console.log(`[branding] 已写入 ${PRODUCT}`);
}

for (const k of Object.keys(target)) {
  console.log(`  ${k}: ${JSON.stringify(product[k])}`);
}

// ---------------------------------------------------------------------------
// 二、处理上游 Copilot 源码目录（本产品不内置专有扩展，但允许安装官方 VSIX）
// ---------------------------------------------------------------------------

const VSCODE_DIR = path.dirname(PRODUCT);
const BRAND_DIR = path.resolve(import.meta.dirname, "..", "..", "resources", "brand");
const APP_ICON = path.resolve(import.meta.dirname, "..", "..", "resources", "icon.ico");
const LINUX_TEMPLATE_DIR = path.resolve(import.meta.dirname, "..", "..", "resources", "linux");

// 发行包装模板必须属于本产品：上游默认写 Microsoft 维护者、主页、截图，并在 postinst 里添加
// packages.microsoft.com。这里统一覆盖为 WeaveCode 的 deb/desktop/appdata 模板。
// 标题栏与欢迎页的 UI 图标来自 workbench/browser/media/code-icon.svg；这里同步为织码 mark，
// 否则即使 Linux 应用图标换成织码，窗口左上角和欢迎页仍显示上游图标。
{
  const source = path.join(BRAND_DIR, "weavecode-mark.svg");
  const target = path.join(VSCODE_DIR, "src", "vs", "workbench", "browser", "media", "code-icon.svg");
  if (!fs.existsSync(source)) {
    console.warn(`[branding] ⚠️ 找不到织码 UI 图标：${source}`);
  } else if (!dryRun) {
    fs.copyFileSync(source, target);
  }
  console.log("[branding] 已同步 workbench 标题栏/欢迎页图标为织码 mark");
}

const linuxPackagingAssets = [
  ["code.desktop", "resources/linux/code.desktop"],
  ["code-url-handler.desktop", "resources/linux/code-url-handler.desktop"],
  ["code.appdata.xml", "resources/linux/code.appdata.xml"],
  ["debian/control.template", "resources/linux/debian/control.template"],
  ["debian/postinst.template", "resources/linux/debian/postinst.template"],
  ["debian/prerm.template", "resources/linux/debian/prerm.template"],
  ["debian/postrm.template", "resources/linux/debian/postrm.template"],
  ["debian/templates.template", "resources/linux/debian/templates.template"],
];
for (const [from, to] of linuxPackagingAssets) {
  const source = path.join(LINUX_TEMPLATE_DIR, from);
  const target = path.join(VSCODE_DIR, to);
  if (!fs.existsSync(source)) {
    console.warn(`[linux] ⚠️ 找不到发行模板：${source}`);
    continue;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  console.log(`[linux] 已同步发行模板 ${from} → ${to}`);
}

// 上游 Linux 依赖生成器无条件扫描 bin/<tunnelApplicationName>。产品没有 tunnel 时，
// 该文件不存在会让 dpkg-shlibdeps 直接失败，这里按产品开关跳过。
{
  const f = path.join(VSCODE_DIR, "build", "linux", "dependencies-generator.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[linux] ⚠️ 找不到 ${f}`);
  } else {
    const oldLine = "\t// Add the tunnel binary.\n\tfiles.push(path.join(buildDir, 'bin', product.tunnelApplicationName));\n";
    const newLine = "\t// Add the tunnel binary when the product provides one.\n\tif (product.tunnelApplicationName) {\n\t\tfiles.push(path.join(buildDir, 'bin', product.tunnelApplicationName));\n\t}\n";
    const text = fs.readFileSync(f, "utf8");
    if (text.includes("if (product.tunnelApplicationName) {")) {
      console.log("[linux] dependencies-generator.ts 已按产品开关跳过 tunnel");
    } else if (text.includes(oldLine)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldLine, newLine));
      console.log("[linux] dependencies-generator.ts 已按产品开关跳过 tunnel");
    } else {
      console.warn("[linux] ⚠️ dependencies-generator.ts 没匹配上，请人工检查");
    }
  }
}

// CodeOSS 的 deb 依赖计算每次都从 raw.githubusercontent.com 下载 dpkg-shlibdeps；
// 网络抖动会让已经缓存的构建直接失败。已有缓存脚本时复用，只在缺失/空文件时下载。
{
  const f = path.join(VSCODE_DIR, "build", "linux", "debian", "calculate-deps.ts");
  if (fs.existsSync(f)) {
    let text = fs.readFileSync(f, "utf8");
    if (text.includes("existsSync(dpkgShlibdepsScriptLocation)")) {
      console.log("[linux] dpkg-shlibdeps 已支持本地缓存");
    } else {
      text = text.replace(
        "import { constants, statSync } from 'fs';",
        "import { constants, existsSync, statSync } from 'fs';",
      );
      text = text.replace(
        "\tconst result = spawnSync('curl', [dpkgShlibdepsUrl, '-o', dpkgShlibdepsScriptLocation]);\n\tif (result.status !== 0) {\n\t\tthrow new Error('Cannot retrieve dpkg-shlibdeps. Stderr:\\n' + result.stderr);\n\t}",
        "\tif (!existsSync(dpkgShlibdepsScriptLocation) || statSync(dpkgShlibdepsScriptLocation).size === 0) {\n\t\tconst result = spawnSync('curl', [dpkgShlibdepsUrl, '-o', dpkgShlibdepsScriptLocation]);\n\t\tif (result.status !== 0) {\n\t\t\tthrow new Error('Cannot retrieve dpkg-shlibdeps. Stderr:\\n' + result.stderr);\n\t\t}\n\t}",
      );
      if (!dryRun) fs.writeFileSync(f, text);
      console.log("[linux] dpkg-shlibdeps 已支持本地缓存");
    }
  }
}

// WeaveCode 不注册 apt 仓库，也不使用 debconf 交互；包含注释的 templates 会让
// `debconf 模板解读错误`。上游打包链无条件复制 templates，因此这里改为让打包不生成该文件。
{
  const f = path.join(VSCODE_DIR, "build", "gulpfile.vscode.linux.ts");
  if (fs.existsSync(f)) {
    const oldBlock = "\tconst templates = gulp.src('resources/linux/debian/templates.template', { base: '.' })\n"
      + "\t\t\t.pipe(replace('@@NAME@@', product.applicationName))\n"
      + "\t\t\t.pipe(rename('DEBIAN/templates'));\n";
    const newBlock = "\t// [织码 WeaveCode] 不使用 debconf 模板；templates 文件留空会让安装器报模板解读错误。\n"
      + "\tconst templates = es.merge();\n";
    const text = fs.readFileSync(f, "utf8");
    if (text.includes("const templates = es.merge();")) {
      console.log("[linux] deb templates 已改为不生成");
    } else if (text.includes(oldBlock)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldBlock, newBlock));
      console.log("[linux] deb templates 已改为不生成");
    } else {
      console.warn("[linux] ⚠️ templates 打包行没匹配上，请人工检查");
    }
  }
}

// Linux 包的版本号默认读上游 CodeOSS package.json（1.142.x）。产品 deb 必须使用
// WeaveCode 自己的版本，因此优先使用 product.json#version，同时让运行时版本保持一致。
{
  const f = path.join(VSCODE_DIR, "build", "gulpfile.vscode.linux.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[linux] ⚠️ 找不到 ${f}`);
  } else {
    const oldLine = ".pipe(replace('@@VERSION@@', packageJson.version + '-' + linuxPackageRevision))";
    const newLine = ".pipe(replace('@@VERSION@@', (product.version ?? packageJson.version) + '-' + linuxPackageRevision))";
    const text = fs.readFileSync(f, "utf8");
    if (text.includes(newLine)) {
      console.log("[linux] deb 版本已使用 product.json#version");
    } else if (text.includes(oldLine)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldLine, newLine));
      console.log("[linux] deb 版本已使用 product.json#version");
    } else {
      console.warn("[linux] ⚠️ Linux 包版本行没匹配上，请人工检查");
    }
  }
}

// CodeOSS 打包时无条件用上游 package.json.version 覆盖 product.json.version。
// 品牌产品必须反过来：product.json 已有版本时优先保留，避免 deb 是 WeaveCode 版本、
// 应用内“关于/扩展兼容性”却还是 1.142.x。
{
  const f = path.join(VSCODE_DIR, "build", "gulpfile.vscode.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[linux] ⚠️ 找不到 ${f}`);
  } else {
    const oldLine = "\t\tlet version = packageJson.version;";
    const newLine = "\t\tlet version = (product as { version?: string }).version ?? packageJson.version;";
    const text = fs.readFileSync(f, "utf8");
    if (text.includes(newLine)) {
      console.log("[linux] 应用 product.json 已优先使用 WeaveCode 版本");
    } else if (text.includes(oldLine)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldLine, newLine));
      console.log("[linux] 应用 product.json 已优先使用 WeaveCode 版本");
    } else {
      console.warn("[linux] ⚠️ gulpfile.vscode.ts 版本覆盖行没匹配上，请人工检查");
    }
  }
}

// 上游参考依赖表对应官方 VS Code 的扩展组合；WeaveCode 不内置 Copilot、没有 tunnel，
// 并且跟随子模块里的 Electron 版本，实际 dpkg-shlibdeps 结果会不同。deb 的 Depends
// 使用本次真实计算结果，参考表差异只记警告，不再误杀产品构建。
{
  const f = path.join(VSCODE_DIR, "build", "linux", "dependencies-generator.ts");
  if (fs.existsSync(f)) {
    const oldLine = "const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = true;";
    const newLine = "const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = false; // [WeaveCode] 使用本次 dpkg-shlibdeps 结果生成 Depends";
    const text = fs.readFileSync(f, "utf8");
    if (text.includes(newLine)) {
      console.log("[linux] 依赖表差异已改为警告");
    } else if (text.includes(oldLine)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldLine, newLine));
      console.log("[linux] 依赖表差异已改为警告");
    } else {
      console.warn("[linux] ⚠️ 依赖表开关没匹配上，请人工检查");
    }
  }
}

// 把仓库里的品牌资产同步到上游 CodeOSS 打包路径。上游升级后重跑本脚本即可。
const brandAssets = [
  ["weavecode-icon-512.png", "resources/linux/code.png"],
  ["weavecode-icon-512.png", "resources/server/code-512.png"],
  ["weavecode-icon-192.png", "resources/server/code-192.png"],
  ["weavecode-icon-150.png", "resources/win32/code_150x150.png"],
  ["weavecode-icon-70.png", "resources/win32/code_70x70.png"],
  ["weavecode.icns", "resources/darwin/code.icns"],
];
for (const [from, to] of brandAssets) {
  const source = path.join(BRAND_DIR, from);
  const target = path.join(VSCODE_DIR, to);
  if (!fs.existsSync(source)) {
    console.warn(`[brand] ⚠️ 找不到品牌资产：${source}`);
    continue;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  console.log(`[brand] 已同步图标 ${from} → ${to}`);
}
for (const targetRel of ["resources/win32/code.ico", "resources/server/favicon.ico"]) {
  const target = path.join(VSCODE_DIR, targetRel);
  if (!fs.existsSync(APP_ICON)) {
    console.warn(`[brand] ⚠️ 找不到品牌资产：${APP_ICON}`);
    continue;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(APP_ICON, target);
  }
  console.log(`[brand] 已同步图标 icon.ico → ${targetRel}`);
}

// 2) 删掉内置的 copilot 扩展源码目录（不然打包会连它一起塞进产物）
const copilotDir = path.join(VSCODE_DIR, "extensions", "copilot");
if (fs.existsSync(copilotDir)) {
  if (!dryRun) fs.rmSync(copilotDir, { recursive: true, force: true });
  console.log("[copilot] 已移除内置 extensions/copilot 源码目录（官方 Copilot 仍可通过 VSIX 安装）");
} else {
  console.log("[copilot] 内置 extensions/copilot 已不在");
}

// 3) 打包时那个"准备 Copilot ripgrep shim"的任务是无条件的、缺 SDK 就直接抛错，去掉
//    ⚠️ 它在一个**数组字面量**里，替换必须留一个合法的空语句位置（早期版本在这里写过 `void platform;`
//       导致 gulpfile 语法错误，`npm run compile` 直接 ERR_INVALID_TYPESCRIPT_SYNTAX）
const gulpfile = path.join(VSCODE_DIR, "build", "gulpfile.vscode.ts");
const GULP_ORIGINAL = "\t\t\tprepareCopilotRipgrepShimTask(platform, arch, destinationFolderName)\n";
const GULP_BROKEN = "\t\t\t/* [本产品已移除 Copilot] */ void platform; /* prepareCopilotRipgrepShimTask(platform, arch, destinationFolderName) */\n";
const GULP_FIXED = "\t\t\t/* [本产品已移除 Copilot] 原 prepareCopilotRipgrepShimTask 需要拿不到的 @github/copilot/sdk，本产品不带 Copilot，故省去这一步 */\n";
if (fs.existsSync(gulpfile)) {
  let text = fs.readFileSync(gulpfile, "utf8");
  if (text.includes(GULP_FIXED)) {
    console.log("[copilot] gulpfile 已打过补丁（只影响内置源码打包）");
  } else if (text.includes(GULP_BROKEN)) {
    if (!dryRun) fs.writeFileSync(gulpfile, text.replace(GULP_BROKEN, GULP_FIXED));
    console.log("[copilot] gulpfile 的坏补丁已修正（原先会让编译直接语法报错）");
  } else if (text.includes(GULP_ORIGINAL)) {
    if (!dryRun) fs.writeFileSync(gulpfile, text.replace(GULP_ORIGINAL, GULP_FIXED));
    console.log("[copilot] 已把内置 Copilot shim 任务从打包流程里去掉");
  } else {
    console.warn("[copilot] ⚠️ 没在 gulpfile 里找到调用点，上游可能改过结构，请人工检查");
  }
}

// ---------------------------------------------------------------------------
// 三、开发版启动器要能找到 Electron 二进制
// ---------------------------------------------------------------------------
// scripts/code.sh 按 product.applicationName 找 .build/electron/<applicationName>，
// 改完品牌名之后原来下好的 code-oss 就对不上了（症状：`.build/electron/weavecode: 没有那个文件或目录`）。
// 这里给旧名字做一条相对软链，省掉再下一次 220MB（仅 Linux；mac/win 的产物名不同，另行处理）。
{
  const electronDir = path.join(VSCODE_DIR, ".build", "electron");
  const source = path.join(electronDir, "code-oss");
  const target = path.join(electronDir, BRAND.applicationName);
  if (fs.existsSync(source) && !fs.existsSync(target)) {
    if (!dryRun) fs.symlinkSync("code-oss", target);
    console.log(`[branding] 已给 Electron 二进制补软链 code-oss → ${BRAND.applicationName}`);
  } else if (fs.existsSync(target)) {
    console.log("[branding] Electron 二进制名字已就位");
  } else {
    console.log("[branding] 还没下 Electron 二进制（cd ide/vscode && npm run electron）");
  }
}

// ---------------------------------------------------------------------------
// 四、移除 Copilot 的连带修补（不补就起不来）
// ---------------------------------------------------------------------------
// 实测 2026-10-12：删掉 product.defaultChatAgent 会让两处工作台代码炸掉——
//   · welcomeOnboarding/browser/onboardingVariationA.ts 在**模块顶层** assert 它，
//     缺了它整个 workbench.js 加载即抛（症状：窗口一片黑，Electron 日志
//     "Onboarding requires a default chat agent product configuration"）
//   · accounts/browser/defaultAccount.ts 的 toDefaultAccountConfig() 无条件解引用它
// 所以"去 Copilot"必须连这两处一起放行。
const ONBOARDING_OLD_FIXED =
  "/* [本产品已移除 Copilot] 没有 defaultChatAgent 也必须能启动（onboarding 只在被显式打开时才读这些字段） */\n" +
  "const defaultChat: typeof product.defaultChatAgent = product.defaultChatAgent ?? ({} as typeof product.defaultChatAgent);";
const ONBOARDING_FIXED =
  "/* [本产品已移除 Copilot] 没有 defaultChatAgent 也必须能启动（onboarding 只在被显式打开时才读这些字段） */\n" +
  "const defaultChat = product.defaultChatAgent ?? ({\n" +
  "\tprovider: {\n" +
  "\t\tdefault: { id: '', name: 'GitHub' },\n" +
  "\t\tenterprise: { id: '', name: 'GitHub Enterprise' },\n" +
  "\t\tgoogle: { id: '', name: 'Google' },\n" +
  "\t\tapple: { id: '', name: 'Apple' },\n" +
  "\t\tmicrosoft: { id: '', name: 'Microsoft' },\n" +
  "\t},\n" +
  "\ttermsStatementUrl: '',\n" +
  "\tprivacyStatementUrl: '',\n" +
  "\tpublicCodeMatchesUrl: '',\n" +
  "\tproviderUriSetting: '',\n" +
  "} as unknown as typeof product.defaultChatAgent);";

const PATCHES = [
  {
    file: path.join(VSCODE_DIR, "src", "vs", "workbench", "contrib", "welcomeOnboarding", "browser", "onboardingVariationA.ts"),
    done: ONBOARDING_FIXED,
    // ⚠️ 这个 assert 在**模块顶层**：product 里没有 defaultChatAgent 时整个 workbench.js 加载即抛
    //    （症状：窗口一片黑 + "Onboarding requires a default chat agent product configuration"）
    pairs: [
      // 修掉早期版本在这里写坏的补丁
      [ONBOARDING_OLD_FIXED, ONBOARDING_FIXED],
      [
        "/* [本产品已移除 Copilot] 没有 defaultChatAgent 也必须能启动：onboarding 只在被显式打开时才读这些字段 */\n" +
          "const defaultChat = assertDefined(product.defaultChatAgent ?? ({} as typeof product.defaultChatAgent));",
        ONBOARDING_FIXED,
      ],
      [
        "assertDefined(product.defaultChatAgent, 'Onboarding requires a default chat agent product configuration.');\n" +
          "const defaultChat = product.defaultChatAgent;",
        ONBOARDING_FIXED,
      ],
      // assertDefined 在这个文件里就这一处，一并删掉 import，免得 noUnusedLocals 报错
      ["import { assertDefined } from '../../../../base/common/types.js';\n", ""],
    ],
  },
  {
    file: path.join(VSCODE_DIR, "src", "vs", "workbench", "services", "accounts", "browser", "defaultAccount.ts"),
    done: "[本产品已移除 Copilot] 没有默认聊天代理时给一份空配置",
    pairs: [
      [
        "function toDefaultAccountConfig(defaultChatAgent: IDefaultChatAgent): IDefaultAccountConfig {\n\treturn {",
        "function toDefaultAccountConfig(defaultChatAgent: IDefaultChatAgent): IDefaultAccountConfig {\n" +
          "\t/* [本产品已移除 Copilot] 没有默认聊天代理时给一份空配置，别让账号服务整个起不来 */\n" +
          "\tif (!defaultChatAgent) {\n" +
          "\t\treturn { preferredExtensions: [], authenticationProvider: { default: { id: '', name: '' }, enterprise: { id: '', name: '' }, enterpriseProviderConfig: 'chat.advanced.authProvider', scopes: [] }, tokenEntitlementUrl: '', entitlementUrl: '', mcpRegistryDataUrl: '', managedSettingsUrl: '' };\n" +
          "\t}\n" +
          "\treturn {",
      ],
    ],
  },
];

for (const p of PATCHES) {
  const name = path.basename(p.file);
  if (!fs.existsSync(p.file)) {
    console.warn(`[copilot] ⚠️ 找不到 ${p.file}`);
    continue;
  }
  let text = fs.readFileSync(p.file, "utf8");
  if (text.includes(p.done)) {
    console.log(`[copilot] ${name} 已打过补丁`);
    continue;
  }
  let hit = false;
  for (const [from, to] of p.pairs) {
    if (text.includes(from)) {
      text = text.replace(from, to);
      hit = true;
    }
  }
  if (hit) {
    if (!dryRun) fs.writeFileSync(p.file, text);
    console.log(`[copilot] ${name} 已放行无 Copilot 场景`);
  } else {
    console.warn(`[copilot] ⚠️ ${name} 没匹配上，上游可能改过结构，请人工检查`);
  }
}

// 4) 上游的 compile / watch 脚本里挂着 compile-copilot / watch-copilot，扩展目录被删后它们会 254 失败
{
  const pkgFile = path.join(VSCODE_DIR, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const before = JSON.stringify({ compile: pkg.scripts.compile, watch: pkg.scripts.watch, wt: pkg.scripts["watch-transpile"] });
  pkg.scripts.compile = "npm run compile-client";
  for (const key of ["watch", "watch-transpile"]) {
    pkg.scripts[key] = pkg.scripts[key].replace(/\s*watch-copilot\b/g, "");
  }
  const after = JSON.stringify({ compile: pkg.scripts.compile, watch: pkg.scripts.watch, wt: pkg.scripts["watch-transpile"] });
  if (before === after) {
    console.log("[copilot] package.json 的 compile/watch 已经不含 copilot");
  } else if (!dryRun) {
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, "\t")}\n`);
    console.log("[copilot] 已把 compile-copilot / watch-copilot 从 npm 脚本里摘掉");
  }
}

// ---------------------------------------------------------------------------
// 五、虚拟工作区（sshfs://）补丁：snippet 初始化里的存在性探测必须有上限
// ---------------------------------------------------------------------------
// 实测 2026-10-12（E2E）：工作区是**虚拟 scheme** 时，窗口恢复阶段发出的文件请求可能永远不落地
// （那时我们扩展刚激活、provider 还没注册完）。上游 snippets 服务在 Restored 阶段会
// `await fileService.exists(<工作区>/.vscode)`，这条 promise 一旦不落地：
//   _initWorkspaceFolderSnippets 永远不完成 → _pendingWork 不排空 → getSnippets() 一直 await
//   → **补全永远 "Loading…"**（本地 `file:` 窗口不受影响；同一窗口里重新连一次又能好）
// 给个 5s 上限，超时先按"没有 .vscode"处理，等文件系统缓过来后由文件变更监听补上。
// 详见 docs/ssh-vs-remotessh.md §5.4。
{
  const f = path.join(VSCODE_DIR, "src", "vs", "workbench", "contrib", "snippets", "browser", "snippetsService.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[virtualws] ⚠️ 找不到 ${f}`);
  } else {
    let text = fs.readFileSync(f, "utf8");
    if (text.includes("_existsBounded")) {
      console.log("[virtualws] snippetsService.ts 已打过补丁");
    } else {
      const importAnchor = "import { IJSONSchema } from '../../../../base/common/jsonSchema.js';\n";
      const oldCall = "\t\t\tconst value = await this._fileService.exists(snippetFolder);\n";
      const helper =
        "\t/** [织码 WeaveCode 补丁] 带上限的存在性探测（虚拟工作区下的健壮性，见 docs/ssh-vs-remotessh.md §5.4）。 */\n" +
        "\tprivate _existsBounded(resource: URI, ms = 5000): Promise<boolean> {\n" +
        "\t\treturn Promise.race([\n" +
        "\t\t\tthis._fileService.exists(resource),\n" +
        "\t\t\ttimeout(ms).then(() => false),\n" +
        "\t\t]);\n" +
        "\t}\n\n" +
        "\tprivate async _initWorkspaceFolderSnippets(workspace: IWorkspace, bucket: DisposableStore): Promise<void> {\n";
      if (text.includes(importAnchor) && text.includes(oldCall)) {
        text = text
          .replace(importAnchor, "import { timeout } from '../../../../base/common/async.js';\n" + importAnchor)
          .replace(oldCall, "\t\t\tconst value = await this._existsBounded(snippetFolder);\n")
          .replace("\tprivate async _initWorkspaceFolderSnippets(workspace: IWorkspace, bucket: DisposableStore): Promise<void> {\n", helper);
        if (!dryRun) fs.writeFileSync(f, text);
        console.log("[virtualws] snippetsService.ts 已给工作区 .vscode 探测加上限");
      } else {
        console.warn("[virtualws] ⚠️ snippetsService.ts 没匹配上，上游可能改过结构，请人工检查");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 六、源码开发版也要允许加载语言包（否则 VSCODE_DEV=1 永远回退英文）
// ---------------------------------------------------------------------------
// `resolveNLSConfiguration` 原本在 VSCODE_DEV 下直接返回英文，且源码版 product.json
// 没有 commit，`nlsMetadataHash ?? commit` 也会走不下去。品牌脚本写入 nlsMetadataHash
// 后，这里只移除 VSCODE_DEV 的硬回退，让 `--locale=zh-cn` + 内置语言包生效。
{
  const f = path.join(VSCODE_DIR, "src", "vs", "base", "node", "nls.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[i18n] ⚠️ 找不到 ${f}`);
  } else {
    const oldBlock = `\tif (\n\t\tprocess.env['VSCODE_DEV'] ||\n\t\tuserLocale === 'pseudo' ||\n\t\tuserLocale.startsWith('en') ||\n\t\t!commit ||\n\t\t!userDataPath\n\t) {`;
    const newBlock = `\tif (\n\t\tuserLocale === 'pseudo' ||\n\t\tuserLocale.startsWith('en') ||\n\t\t(!commit && !nlsMetadataHash) ||\n\t\t!userDataPath\n\t) {`;
    let text = fs.readFileSync(f, "utf8");
    if (text.includes("(!commit && !nlsMetadataHash)")) {
      console.log("[i18n] nls.ts 已允许开发版加载语言包");
    } else if (text.includes(oldBlock)) {
      text = text.replace(oldBlock, newBlock);
      if (!dryRun) fs.writeFileSync(f, text);
      console.log("[i18n] nls.ts 已允许源码开发版加载语言包");
    } else {
      console.warn("[i18n] ⚠️ nls.ts 没匹配上，上游可能改过结构，请人工检查");
    }
    const oldJoin = "const commitLanguagePackCachePath = join(globalLanguagePackCachePath, nlsMetadataHash ?? commit);";
    const newJoin = "const commitLanguagePackCachePath = join(globalLanguagePackCachePath, String(nlsMetadataHash ?? commit));";
    if (text.includes(newJoin)) {
      console.log("[i18n] nls.ts 语言包缓存路径已加固");
    } else if (text.includes(oldJoin)) {
      text = text.replace(oldJoin, newJoin);
      if (!dryRun) fs.writeFileSync(f, text);
      console.log("[i18n] nls.ts 语言包缓存路径已加固");
    } else {
      console.warn("[i18n] ⚠️ nls.ts 缓存路径没匹配上，请人工检查");
    }
  }
}


// ---------------------------------------------------------------------------
// 七、源码启动入口也不能在 VSCODE_DEV 下丢掉已解析出的语言包
// ---------------------------------------------------------------------------
// `resolveNLSConfiguration` 现在能返回 zh-cn，但 `bootstrap-esm.ts` 还会按
// `VSCODE_DEV` 再次跳过消息表加载。两处必须同时放开，否则菜单元数据看着是中文，
// 渲染进程实际仍拿到英文消息。这里只移除开发版硬回退，语言包缺失时仍自然回退英文。
{
  const f = path.join(VSCODE_DIR, "src", "bootstrap-esm.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[i18n] ⚠️ 找不到 ${f}`);
  } else {
    const oldBlock = "\tif (\n\t\tprocess.env['VSCODE_DEV'] ||\t// no NLS support in dev mode\n\t\t!messagesFile\t\t\t\t\t// no NLS messages file\n\t) {\n\t\treturn undefined;\n\t}";
    const newBlock = "\tif (!messagesFile) {\n\t\treturn undefined;\n\t}";
    let text = fs.readFileSync(f, "utf8");
    if (text.includes(newBlock)) {
      console.log("[i18n] bootstrap-esm.ts 已允许开发版加载语言包");
    } else if (text.includes(oldBlock)) {
      text = text.replace(oldBlock, newBlock);
      if (!dryRun) fs.writeFileSync(f, text);
      console.log("[i18n] bootstrap-esm.ts 已允许开发版加载语言包");
    } else {
      console.warn("[i18n] ⚠️ bootstrap-esm.ts 没匹配上，上游可能改过结构，请人工检查");
    }
  }
}


// ---------------------------------------------------------------------------
// 八、离线打包时允许直接使用本机缓存的 Electron 压缩包
// ---------------------------------------------------------------------------
// CodeOSS 打包任务每次都会走 @vscode/gulp-electron 重新取 Electron；在本机已有官方
// 缓存包时不应再依赖 GitHub 网络。设置 RCE_ELECTRON_ARCHIVE 后，构建器把该压缩包
// 作为 repo resolver 的本地响应源，校验仍走上游 build/checksums/electron.txt。
{
  const f = path.join(VSCODE_DIR, "build", "lib", "electron.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[pack] ⚠️ 找不到 ${f}`);
  } else {
    let text = fs.readFileSync(f, "utf8");
    if (text.includes("RCE_ELECTRON_ARCHIVE")) {
      console.log("[pack] electron.ts 已支持本地 Electron 压缩包");
    } else {
      const importAnchor = "import { downloadFeedPackage } from './azureFeed.ts';\n";
      const resolverAnchor = "const electronAssetResolver = electronFeed\n";
      const helper = `const localElectronArchive = process.env['RCE_ELECTRON_ARCHIVE'];\nconst localElectronResolver = localElectronArchive && fs.existsSync(localElectronArchive)\n\t? async ({ fileName }: { url: string; fileName: string }): Promise<Response> => {\n\t\tconst archiveName = path.basename(localElectronArchive);\n\t\tif (fileName === 'SHASUMS256.txt') {\n\t\t\tconst sha256 = createHash('sha256').update(fs.readFileSync(localElectronArchive)).digest('hex');\n\t\t\treturn new Response(\`\${sha256} *\${archiveName}\\n\`);\n\t\t}\n\t\tif (fileName !== archiveName) {\n\t\t\treturn new Response(null, { status: 404 });\n\t\t}\n\t\tconst size = (await fs.promises.stat(localElectronArchive)).size;\n\t\tconst body = Readable.toWeb(fs.createReadStream(localElectronArchive)) as ReadableStream<Uint8Array>;\n\t\treturn new Response(body, { status: 200, headers: { 'Content-Length': String(size) } });\n\t}\n\t: undefined;\n\n`;
      if (text.includes(importAnchor) && text.includes(resolverAnchor)) {
        text = text
          .replace(importAnchor, importAnchor + "import { createHash } from 'node:crypto';\n")
          .replace(resolverAnchor, helper + "const electronAssetResolver = localElectronResolver ? localElectronResolver : electronFeed\n");
        if (!dryRun) fs.writeFileSync(f, text);
        console.log("[pack] electron.ts 已支持本地 Electron 压缩包");
      } else {
        console.warn("[pack] ⚠️ electron.ts 没匹配上，上游可能改过结构，请人工检查");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 九、sshfs 虚拟工作区的“关闭远程连接”必须先通知我们的 SSH 会话层
// ---------------------------------------------------------------------------
// CodeOSS 的 RemoteStatusIndicator 对 virtualWorkspace 走 workbench.action.remote.close，
// 只换窗口，不会清掉扩展宿主内存里的 SessionManager；菜单因此会继续显示“已连接”。
// 这里把该分支改到 rce.disconnect，由扩展关闭所有 SSH 会话并移除 sshfs 工作区。
{
  const f = path.join(VSCODE_DIR, 'src', 'vs', 'workbench', 'contrib', 'remote', 'browser', 'remoteIndicator.ts');
  if (!fs.existsSync(f)) {
    console.warn(`[remote] ⚠️ 找不到 ${f}`);
  } else {
    const oldBlock = `				} else if (this.virtualWorkspaceLocation) {
					items.push({
						type: 'item',
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						label: nls.localize('closeVirtualWorkspace.title', 'Close Remote Workspace')
					});
				}`;
    const newBlock = `				} else if (this.virtualWorkspaceLocation) {
					items.push({
						type: 'item',
						// [织码 WeaveCode] 先释放我们自己的 SSH 会话，再关闭远端工作区。
						id: 'rce.disconnect',
						label: nls.localize('closeRemoteConnection.title', 'Close Remote Connection')
					});
				}`;
    let text = fs.readFileSync(f, 'utf8');
    if (text.includes("id: 'rce.disconnect'")) {
      console.log('[remote] remoteIndicator.ts 已接管 sshfs 关闭连接');
    } else if (text.includes(oldBlock)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldBlock, newBlock));
      console.log('[remote] remoteIndicator.ts 已接管 sshfs 关闭连接');
    } else {
      console.warn('[remote] ⚠️ remoteIndicator.ts 没匹配上，请人工检查');
    }
  }
}

// ---------------------------------------------------------------------------
// 九之一、sshfs Remote Indicator 显示真实连接生命周期
// ---------------------------------------------------------------------------
// CodeOSS 的虚拟工作区分支只根据 URI 画 `$(remote) user@host`，SSH 正在连接或已经失败时
// 仍然显示同一状态。扩展通过 rce.remoteConnectionState/Message 上报真实状态，这里让原生
// 指示器立即重绘，并保留它的菜单能力。
{
  const f = path.join(VSCODE_DIR, 'src', 'vs', 'workbench', 'contrib', 'remote', 'browser', 'remoteIndicator.ts');
  if (!fs.existsSync(f)) {
    console.warn(`[remote-status] ⚠️ 找不到 ${f}`);
  } else {
    let text = fs.readFileSync(f, 'utf8');
    let changed = false;

    if (!text.includes('[rce-status]')) {
      const listenerAnchor = "\t\tthis._register(this.unrestrictedRemoteIndicatorMenu.onDidChange(updateRemoteActions));\n"
        + "\t\tthis._register(this.remoteIndicatorMenu.onDidChange(updateRemoteActions));\n";
      const listenerBlock = listenerAnchor + `
		// [织码 WeaveCode][rce-status] sshfs 是虚拟工作区，Remote Indicator 默认只看 URI，不看 SSH 会话是否真的连上。
		// 扩展上报真实状态后立即重绘，避免连接中/失败时仍显示成已连接。
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set(['rce.remoteConnectionState', 'rce.remoteConnectionMessage']))) {
				this.updateRemoteStatusIndicator();
			}
		}));
`;
      const workspaceAnchor = "\t\t\tif (workspaceLabel) {\n";
      const workspacePatch = `\t\t\tif (workspaceLabel) {\n`
        + `\t\t\t\t// [织码 WeaveCode][rce-status] 原生 Remote Indicator 对 sshfs 虚拟工作区只认识 authority。\n`
        + `\t\t\t\t// 这里接入扩展上报的真实 SSH 状态，左下角与连接生命周期保持一致。\n`
        + `\t\t\t\tif (this.virtualWorkspaceLocation.scheme === 'sshfs') {\n`
        + `\t\t\t\t\tconst connectionState = this.contextKeyService.getContextKeyValue<string>('rce.remoteConnectionState');\n`
        + `\t\t\t\t\tconst connectionMessage = this.contextKeyService.getContextKeyValue<string>('rce.remoteConnectionMessage') ?? '';\n`
        + `\t\t\t\t\t// 左下角只显示原生状态图标；主机和状态详情放 tooltip，避免长期占用状态栏宽度。\n`
        + `\t\t\t\t\tconst tooltip = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });\n`
        + `\t\t\t\t\ttooltip.appendText(workspaceLabel);\n`
        + `\t\t\t\t\tif (connectionMessage) {\n`
        + `\t\t\t\t\t\ttooltip.appendMarkdown('\\n\\n');\n`
        + `\t\t\t\t\t\ttooltip.appendText(connectionMessage);\n`
        + `\t\t\t\t\t}\n`
        + `\t\t\t\t\tswitch (connectionState) {\n`
        + `\t\t\t\t\t\tcase 'connecting':\n`
        + `\t\t\t\t\t\t\tthis.renderRemoteStatusIndicator('$(sync~spin)', tooltip);\n`
        + `\t\t\t\t\t\t\treturn;\n`
        + `\t\t\t\t\t\tcase 'reconnecting':\n`
        + `\t\t\t\t\t\t\tthis.renderRemoteStatusIndicator('$(sync~spin)', tooltip);\n`
        + `\t\t\t\t\t\t\treturn;\n`
        + `\t\t\t\t\t\tcase 'failed':\n`
        + `\t\t\t\t\t\t\tthis.renderRemoteStatusIndicator('$(alert)', tooltip);\n`
        + `\t\t\t\t\t\t\treturn;\n`
        + `\t\t\t\t\t\tcase 'disconnected':\n`
        + `\t\t\t\t\t\t\tthis.renderRemoteStatusIndicator('$(debug-disconnect)', tooltip);\n`
        + `\t\t\t\t\t\t\treturn;\n`
        + `\t\t\t\t\t}\n`
        + `\t\t\t\t\tthis.renderRemoteStatusIndicator('$(remote)', tooltip);\n`
        + `\t\t\t\t\treturn;\n`
        + `\t\t\t\t}\n`;
      if (text.includes(listenerAnchor) && text.includes(workspaceAnchor)) {
        text = text.replace(listenerAnchor, listenerBlock).replace(workspaceAnchor, workspacePatch);
        changed = true;
      } else {
        console.warn('[remote-status] ⚠️ remoteIndicator.ts 状态补丁锚点没匹配上，请人工检查');
      }
    }

    if (changed) {
      if (!dryRun) fs.writeFileSync(f, text);
      console.log('[remote-status] remoteIndicator.ts 已接入真实 SSH 状态');
    } else if (text.includes('[rce-status]')) {
      console.log('[remote-status] remoteIndicator.ts 已接入真实 SSH 状态');
    }
  }
}

// ---------------------------------------------------------------------------
// 九之二、远端 SCM 图默认展示所有分支
// ---------------------------------------------------------------------------
// 上游图的默认筛选是 auto（只取当前分支 + upstream）。我们的 Remote SSH 自用场景下，
// 用户期望打开就同时看到本地分支、远端分支及分叉；只改 rce-sshfs Provider 的默认值，
// 不影响本机内置 Git 的默认行为。
{
  const f = path.join(VSCODE_DIR, 'src', 'vs', 'workbench', 'contrib', 'scm', 'browser', 'scmHistoryViewPane.ts');
  if (!fs.existsSync(f)) {
    console.warn(`[scm-graph] ⚠️ 找不到 ${f}`);
  } else {
    let text = fs.readFileSync(f, 'utf8');
    const marker = '[rce-graph-all]';
    if (text.includes(marker)) {
      console.log('[scm-graph] scmHistoryViewPane.ts 已默认展示所有远端分支');
    } else {
      const typeAnchor = "type HistoryItemRefsFilter = 'all' | 'auto' | string[];\n";
      const helper = typeAnchor + `
// [织码 WeaveCode][rce-graph-all] 我们的远端 SCM Provider 默认展示所有分支，分叉和远端分支必须在同一张图上。
// CodeOSS 原生默认是 auto（只取 HEAD + upstream），独立远端 IDE 下这个默认不够直观。
function getDefaultHistoryItemFilter(provider: ISCMProvider): HistoryItemRefsFilter {
\treturn provider.providerId.startsWith('rce-sshfs-') ? 'all' : 'auto';
}
`;
      const oldDefault = "?? 'auto';";
      if (text.includes(typeAnchor) && text.split(oldDefault).length - 1 >= 2) {
        text = text.replace(typeAnchor, helper);
        text = text.replaceAll(oldDefault, `?? getDefaultHistoryItemFilter(repository.provider);`);
        if (!dryRun) fs.writeFileSync(f, text);
        console.log('[scm-graph] scmHistoryViewPane.ts 已默认展示所有远端分支');
      } else {
        console.warn('[scm-graph] ⚠️ scmHistoryViewPane.ts 默认筛选锚点没匹配上，请人工检查');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 十、单文件夹 transient workspace 的根名称使用文件夹名
// ---------------------------------------------------------------------------
// 我们的 SSH 工作区通过 vscode.workspace.updateWorkspaceFolders 添加。上游会把空窗口变成
// transient 多根工作区，workspace.name 为空时标题和资源管理器显示“无标题（工作区）”。
// 只有单文件夹时显示该文件夹名，和正常“打开文件夹”一致。
{
  const f = path.join(VSCODE_DIR, 'src', 'vs', 'platform', 'workspace', 'common', 'workspace.ts');
  if (!fs.existsSync(f)) {
    console.warn(`[workspace] ⚠️ 找不到 ${f}`);
  } else {
    const oldBlock = `\tget name(): string | undefined {\n\t\treturn this._workspaceName;\n\t}`;
    const newBlock = `\tget name(): string | undefined {\n\t\t// [织码 WeaveCode] transient 单文件夹工作区显示文件夹名，而不是“无标题（工作区）”。\n\t\treturn this._workspaceName || (this.folders.length === 1 ? this.folders[0].name : undefined);\n\t}`;
    let text = fs.readFileSync(f, 'utf8');
    if (text.includes('this.folders.length === 1 ? this.folders[0].name')) {
      console.log('[workspace] 单文件夹 transient workspace 已使用文件夹名');
    } else if (text.includes(oldBlock)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldBlock, newBlock));
      console.log('[workspace] 单文件夹 transient workspace 已使用文件夹名');
    } else {
      console.warn('[workspace] ⚠️ workspace.ts 没匹配上，请人工检查');
    }
  }
}

// ---------------------------------------------------------------------------
// 十一、交给扩展的 appName 用 ASCII（品牌名带中文会写坏 HTTP 头）
// ---------------------------------------------------------------------------
// vscode.env.appName = product.nameLong（我们这里是“织码 WeaveCode”）。GitHub 登录扩展、
// Copilot、市场请求都会把它拼进 User-Agent；HTTP 头只允许 Latin-1，中文会让 Electron/Node
// 在本地构造请求时就抛 “Cannot convert argument to a ByteString”，上层只看到 network error
// （实测 2026-10-14：中文品牌名导致 Copilot 登录必失败）。
// 界面显示名仍然走 product.nameLong / nameShort（保持中文），只把交给扩展的这一份改成 ASCII。
{
  const files = [
    ["src", "vs", "workbench", "services", "extensions", "common", "remoteExtensionHost.ts"],
    ["src", "vs", "workbench", "services", "extensions", "electron-browser", "localProcessExtensionHost.ts"],
    ["src", "vs", "workbench", "services", "extensions", "browser", "webWorkerExtensionHost.ts"],
  ];
  const oldLine = "\t\t\t\tappName: this._productService.nameLong,";
  const newLine = "\t\t\t\t// [织码 WeaveCode] 扩展拿到的应用名必须是 ASCII：它会进 User-Agent，中文会让请求直接构造失败。\n\t\t\t\tappName: 'WeaveCode',";
  for (const rel of files) {
    const f = path.join(VSCODE_DIR, ...rel);
    if (!fs.existsSync(f)) {
      console.warn(`[ua] ⚠️ 找不到 ${f}`);
      continue;
    }
    const text = fs.readFileSync(f, "utf8");
    if (text.includes("appName: 'WeaveCode'")) {
      console.log(`[ua] ${rel[rel.length - 1]} 已是 ASCII appName`);
    } else if (!text.includes(oldLine)) {
      console.warn(`[ua] ⚠️ ${rel[rel.length - 1]} 没匹配上，请人工检查`);
    } else {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldLine, newLine));
      console.log(`[ua] ${rel[rel.length - 1]} appName 已改为 ASCII`);
    }
  }
}

// 市场请求的 User-Agent 用的是 product.nameShort（“织码”），同样必须 ASCII。
{
  const f = path.join(VSCODE_DIR, "src", "vs", "platform", "externalServices", "common", "marketplace.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[ua] ⚠️ 找不到 ${f}`);
  } else {
    const oldLine = "\t\t'User-Agent': `VSCode ${version} (${productService.nameShort})`";
    const newLine = "\t\t// [织码 WeaveCode] 同上：中文只用于界面，不能进 HTTP 头。\n\t\t'User-Agent': `VSCode ${version} (WeaveCode)`";
    const text = fs.readFileSync(f, "utf8");
    if (text.includes("(WeaveCode)`")) {
      console.log("[ua] marketplace.ts 已是 ASCII User-Agent");
    } else if (text.includes(oldLine)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldLine, newLine));
      console.log("[ua] marketplace.ts User-Agent 已改为 ASCII");
    } else {
      console.warn("[ua] ⚠️ marketplace.ts 没匹配上，请人工检查");
    }
  }
}

// ---------------------------------------------------------------------------
// 十二、chat setup 不要为了“安装”已装好的外部 VSIX 去查画廊
// ---------------------------------------------------------------------------
// chatSetupController.doInstall() 无条件调 extensionsWorkbenchService.install(id)，而上游的
// _install() 只在“内置扩展且允许自动更新”时才提前返回；普通扩展一律去画廊查条目。
// 我们走 CodeOSS + Open VSX，Copilot 专有扩展不在画廊里，于是即使本地已经用官方 VSIX
// 装好并激活，setup 仍会抛“无法安装扩展 … 因为找不到它”。
// 这里让本地已存在时直接复用（Ui 与聊天都能正常走已装的扩展）。
{
  const f = path.join(VSCODE_DIR, "src", "vs", "workbench", "contrib", "chat", "browser", "chatSetup", "chatSetupController.ts");
  if (!fs.existsSync(f)) {
    console.warn(`[chatsetup] ⚠️ 找不到 ${f}`);
  } else {
    const oldBlock = "\tprivate async doInstall(): Promise<void> {\n\t\tawait this.extensionsWorkbenchService.install(defaultChat.chatExtensionId, {";
    const newBlock = "\tprivate async doInstall(): Promise<void> {\n"
      + "\t\t// [织码 WeaveCode] Copilot / Copilot Chat 由官方 VSIX 手工安装，Open VSX 没有对应条目；\n"
      + "\t\t// 本地已装时直接复用，否则这里会去画廊查找并抛“无法安装扩展 … 找不到它”。\n"
      + "\t\tconst chatExtensionId = defaultChat.chatExtensionId.toLowerCase();\n"
      + "\t\tif (this.extensionsWorkbenchService.local.some(e => e.identifier.id.toLowerCase() === chatExtensionId)) {\n"
      + "\t\t\treturn;\n"
      + "\t\t}\n"
      + "\t\tawait this.extensionsWorkbenchService.install(defaultChat.chatExtensionId, {";
    const text = fs.readFileSync(f, "utf8");
    if (text.includes("const chatExtensionId = defaultChat.chatExtensionId.toLowerCase();")) {
      console.log("[chatsetup] chatSetupController.ts 已是“本地已装就复用”");
    } else if (text.includes(oldBlock)) {
      if (!dryRun) fs.writeFileSync(f, text.replace(oldBlock, newBlock));
      console.log("[chatsetup] chatSetupController.ts 已打上“本地已装就复用”");
    } else {
      console.warn("[chatsetup] ⚠️ chatSetupController.ts 没匹配上，请人工检查");
    }
  }
}
