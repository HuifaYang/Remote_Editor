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
const dryRun = process.argv.includes("--dry-run");

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
  urlProtocol: "weavecode",
  serverApplicationName: "weavecode-server",
  serverDataFolderName: ".weavecode-server",
  tunnelApplicationName: "weavecode-tunnel",
};

// ---- 行为开关 ----
const behavior = {
  enableTelemetry: false,          // 不发遥测
  // 源码版的 product.json 没有 commit；语言包缓存路径 nlsMetadataHash ?? commit 会拼到 undefined，
  // 导致简体中文语言包被静默回退成英文。给一个稳定的构建标识，打包时应由正式 CI 的 hash 覆盖。
  nlsMetadataHash: "weavecode-i18n-v1",
  builtInExtensions: [],           // 不再从微软市场内置扩展（许可干净 + 构建不依赖外网）
  // 正式版（isBuilt）里 proposed API 必须在这里放行，否则我们的远端搜索注册不上
  // （extensionsProposedApi.ts：出源码跑时全放开，打包后只认这份白名单）
  extensionEnabledApiProposals: {
    "remote-code-editor.rce-remote": ["fileSearchProvider", "textSearchProvider", "contribViewsRemote"],
  },
  extensionsGallery: {             // 扩展市场走 Open VSX（开源注册表）
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    itemUrl: "https://open-vsx.org/vscode/item",
    resourceUrlTemplate: "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
    controlUrl: "",
    recommendationsUrl: "",
  },
};

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
