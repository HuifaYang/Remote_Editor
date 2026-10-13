// 语言服务桥：把「本机镜像 + 工作机上的 clangd / pylsp」接到 VSCode 的 provider 上（总纲 §5.5）。
//
// 为什么必须自己接：
//   · Remote-SSH 的语言服务跑在**远端扩展宿主**里，URI 天然是远端路径，什么都不用做；
//   · 我们零部署（AGENTS 硬约束），扩展宿主只能在本机，所以远端能力都得自己补；
//   · VSCode 内置的 C/C++ 扩展不含语言服务（Python 同理）—— 不接就没有补全/跳转/悬浮/诊断。
//
// 数据流（本文件的核心就是把两边 URI 来回翻译）：
//   sshfs://u@host:22/ws/src/main.c        ← 编辑器里的文档
//        ⇅  translate
//   file:///…/mirror/<hash>/src/main.c     ← 镜像里的同一份文件，clangd 只认这个
//        ⇅  stdio + JSON-RPC
//   clangd / pylsp 子进程（cwd = 镜像根，跑在**工作机**上）
//
// 别改坏的几条（总纲 §7 / §13）：
//   · 镜像一次 1 条 tar 命令，禁止逐文件 SFTP；
//   · compile_commands.json 的远端绝对路径由镜像层重写（§13 坑 2），这里不碰；
//   · 诊断走 vscode.DiagnosticCollection（固定 owner，等同 setModelMarkers），不许自己画波浪线；
//   · 关标签只发 didClose，**不杀进程**；进程生命周期归 LspManager，退出/断连由 dispose 统一收。
"use strict";

const vscode = require("vscode");
const path = require("node:path");
const crypto = require("node:crypto");
const { MirrorManager, buildMirrorFileCountCommand } = require("../../../../dist/main/main/mirror/manager.js");
const { LspManager } = require("../../../../dist/main/main/lsp/manager.js");
const { uriToPath } = require("../../../../dist/main/main/lsp/client.js");

const SCHEME = "sshfs";

/** VSCode 的 languageId → 我们要拉起的语言服务。注意 `.c` 在 VSCode 里是 **c** 不是 cpp（内置 cpp 扩展的贡献），
 *  documentSelector 写错就一个 provider 都不会被调用（实测踩过：跳转一直返回空） */
const LANGUAGE_BY_VSCODE_ID = { c: "cpp", cpp: "cpp", python: "python" };

/** 我们负责的语言（按扩展名兜底）；其余（TS/JSON/Markdown/HTML…）交给内置扩展，它们走 workspace.fs 就能用（§2.9） */
const LANGUAGE_BY_EXT = new Map([
  [".c", "cpp"], [".h", "cpp"], [".cc", "cpp"], [".cpp", "cpp"],
  [".cxx", "cpp"], [".hpp", "cpp"], [".hh", "cpp"], [".hxx", "cpp"],
  [".py", "python"],
]);

// 语言服务镜像的“项目边界”。只认这些标记，避免把 /home/<user> 当成一个大项目。
const PROJECT_MARKERS = new Set([
  "compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "Makefile",
  ".git", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile",
  ".clangd",
]);

const SELECTOR = [
  { scheme: SCHEME, language: "c" },
  { scheme: SCHEME, language: "cpp" },
  { scheme: SCHEME, language: "python" },
];

/** LSP 的 kind 枚举整体比 vscode 的大 1（CompletionItemKind / SymbolKind 两套都是），别写反 */
const kindOf = (lspKind, fallback) => (typeof lspKind === "number" && lspKind > 0 ? lspKind - 1 : fallback);

const languageOfPath = (p) => LANGUAGE_BY_EXT.get(path.extname(p || "").toLowerCase()) || null;

/** 文档 → 语言服务语言：先看 VSCode 判定的 languageId，再看扩展名 */
const languageOfDocument = (doc) =>
  LANGUAGE_BY_VSCODE_ID[doc.languageId] || languageOfPath(doc.uri.path) || null;

/** 一个远端工作目录对应一份镜像 + 一套语言服务进程 */
class LanguageService {
  constructor(deps, folderUri) {
    this.deps = deps;
    this.authority = folderUri.authority;
    this.remoteRoot = folderUri.path && folderUri.path.length > 1 ? folderUri.path : "/";
    const hash = crypto.createHash("sha1").update(`${this.authority}${this.remoteRoot}`).digest("hex").slice(0, 12);
    this.cacheKey = hash;
    this.mirrorRoot = path.join(deps.storageDir, "mirror", hash);
    this.mirror = new MirrorManager(deps.session(folderUri).conn, this.mirrorRoot);
    deps.cache?.markActive(hash, { authority: this.authority, remoteRoot: this.remoteRoot });
    this.lsp = new LspManager(this.mirror, path.join(deps.storageDir, "lsp", hash), {
      transportMode: () => deps.config().transport,
      connection: () => deps.session(folderUri)?.conn ?? null,
      serverPaths: () => ({ cpp: deps.config().cppPath, python: deps.config().pythonPath }),
      onLog: (line) => deps.log(`[LSP ${this.authority}] ${line}`),
    });
    this.diagnostics = vscode.languages.createDiagnosticCollection(`rce-lsp:${this.authority}`);
    // 诊断：语言服务报的是**镜像路径**，必须翻回 sshfs:// 再塞进 collection（固定 owner，等同 setModelMarkers）
    this.diagnosticsSub = this.lsp.diagnostics((event) => {
      try {
        this.setDiagnostics(event.uri, event.diagnostics);
      } catch (err) {
        this.deps.log(`[LSP ${this.title}] 诊断映射失败：${err && err.message}`);
      }
    });
    this.sync = null;
    this._preflightPromise = null;
    this._tooLarge = null;
    /** 镜像路径 → { client, version }：已 didOpen 的文档（关标签只删这条，不杀进程） */
    this.docs = new Map();
  }

  get title() {
    return `${this.authority}${this.remoteRoot}`;
  }

  /**
   * 镜像准备。并发调用共用同一次同步（单飞）；force = 手工「重新同步镜像」。
   * force 也必须**排队**：两条 tar 流同时往同一个 staging 目录写会互相踩（§13 坑：SFTP 不走并发，exec 流同理）。
   */
  ensureMirror(force = false) {
    if (!force && this.sync) return this.sync;
    const previous = this.sync ?? Promise.resolve();
    const next = previous.catch(() => { /* 上一次失败不影响这一次 */ }).then(() => this.doSync(force));
    this.sync = next;
    next.catch(() => { if (this.sync === next) this.sync = null; });
    return next;
  }

  /**
   * 自动镜像闸门：VS Code Remote-SSH 不镜像目录；我们必须镜像，但绝不能把整个 home 静默吞掉。
   * 首次同步前先跑一条很轻的 find | wc -l；超过上限就暂停，由用户改打开项目子目录，
   * 或点状态栏手动强制同步。手动同步 full=true 会绕过这个闸门。
   */
  preflightWorkspace(force = false) {
    if (force) {
      this._tooLarge = null;
      return Promise.resolve();
    }
    if (this._tooLarge) return Promise.reject(this._tooLarge);
    if (this._preflightPromise) return this._preflightPromise;

    this._preflightPromise = (async () => {
      const maxFiles = Number(this.deps.config().maxFiles) || 20000;
      const session = this.deps.session(this.authority);
      const conn = session?.conn;
      if (!conn) return;
      const command = buildMirrorFileCountCommand(this.remoteRoot);
      const result = await conn.exec(command, { timeoutMs: 15000 });
      const count = Number(String(result.stdout || "").trim().split(/\s+/).pop());
      if (!Number.isFinite(count) || count <= maxFiles) return;
      const err = new Error(`项目包含 ${count} 个源文件，超过自动镜像上限 ${maxFiles}`);
      err.code = "mirror-too-large";
      err.mirrorFileCount = count;
      err.mirrorMaxFiles = maxFiles;
      err.mirrorWorkspace = this.remoteRoot;
      this._tooLarge = err;
      throw err;
    })().finally(() => {
      this._preflightPromise = null;
    });
    return this._preflightPromise;
  }

  /** full=true 时强制走全量命令：compile_commands / sysroot 只有全量命令里才有分段（A9） */
  doSync(full = false) {
    const started = Date.now();
    this.deps.cache?.touch(this.cacheKey, { authority: this.authority, remoteRoot: this.remoteRoot });
    this.deps.onMirrorProgress?.(this, { done: 0, total: 5, current: full ? "全量同步项目…" : "检查项目…" });
    return this.preflightWorkspace(full)
      .then(() => this.mirror.sync(
        this.remoteRoot,
        (p) => {
          this.deps.log(`[镜像 ${this.title}] ${p.current}（${p.done}/${p.total}）`);
          this.deps.onMirrorProgress?.(this, p);
        },
        { full },
      ))
      .then((r) => {
        this.deps.cache?.touch(this.cacheKey, { authority: this.authority, remoteRoot: this.remoteRoot });
        this.deps.log(`[镜像 ${this.title}] 就绪：${r.fileCount} 个文件 / ${r.totalBytes} 字节 / ${Date.now() - started}ms`);
        this.deps.onMirrorReady?.(this, r);
        return r;
      })
      .catch((err) => {
        const detail = err && err.detail ? `（${err.detail}）` : "";
        this.deps.log(`[镜像 ${this.title}] 同步失败：${err && err.message}${detail}`);
        if (err?.code === "mirror-too-large") this.deps.onMirrorTooLarge?.(this, err);
        else this.deps.onMirrorError?.(this, err);
        throw err;
      });
  }

  /** 取（必要时启动）语言服务；镜像没好就先等镜像 */
  async client(language) {
    this.deps.cache?.touch(this.cacheKey, { authority: this.authority, remoteRoot: this.remoteRoot });
    await this.ensureMirror();
    return this.lsp.ensure(language);
  }

  /** provider 用：文档 → { client, mirrorPath }；不是我们的文件 / 我们不管的语言 → null */
  async contextFor(doc) {
    const cfg = this.deps.config();
    if (!cfg.enabled || cfg.transport === "disabled") return null;
    const language = languageOfDocument(doc);
    if (!language) return null;
    const mirrorPath = this.mirrorPathOf(doc.uri);
    if (!mirrorPath) return null;
    let entry = this.docs.get(mirrorPath);
    if (!entry) {
      const client = await this.client(language);
      entry = this.docs.get(mirrorPath) ?? { client, version: 1 };
      if (!this.docs.has(mirrorPath)) {
        this.docs.set(mirrorPath, entry);
        client.didOpen(mirrorPath, doc.getText(), entry.version);
      }
    }
    return { client: entry.client, mirrorPath };
  }

  /** 编辑 → didChange（全文同步，§5.5.4） */
  changeDocument(doc) {
    const mirrorPath = this.mirrorPathOf(doc.uri);
    const entry = mirrorPath ? this.docs.get(mirrorPath) : null;
    if (!entry) return;
    entry.version += 1;
    entry.client.didChange(mirrorPath, doc.getText(), entry.version);
  }

  /** 保存 → 先把镜像副本写新（clangd 解析 #include 会读盘），再 didSave */
  async saveDocument(doc) {
    const mirrorPath = this.mirrorPathOf(doc.uri);
    const entry = mirrorPath ? this.docs.get(mirrorPath) : null;
    if (!entry) return;
    try {
      await this.mirror.applyLocalSave(doc.uri.path, doc.getText(), "utf8", doc.eol === vscode.EndOfLine.CRLF ? "crlf" : "lf");
      entry.client.didSave(mirrorPath, doc.getText());
    } catch (err) {
      this.deps.log(`[镜像 ${this.title}] 保存回写失败：${err && err.message}`);
    }
  }

  closeDocument(doc) {
    const mirrorPath = this.mirrorPathOf(doc.uri);
    if (!mirrorPath) return;
    const entry = this.docs.get(mirrorPath);
    if (!entry) return;
    this.docs.delete(mirrorPath);
    entry.client.didClose(mirrorPath);
  }

  /** sshfs:// → 镜像本地路径（不在镜像范围内 → null，比如 .git 下的东西） */
  mirrorPathOf(uri) {
    try {
      return this.mirror.localPathOf(uri.path);
    } catch {
      return null;
    }
  }

  /** 镜像本地路径 → sshfs://（_sysroot 下的头文件会翻回远端真实绝对路径，跳 /usr/include 也能开） */
  uriOfLocal(localPath) {
    const rel = path.relative(this.mirrorRoot, localPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;   // 不认得的外部文件
    let remote;
    try {
      remote = this.mirror.remotePathOf(localPath);
    } catch {
      return null;
    }
    return vscode.Uri.from({ scheme: SCHEME, authority: this.authority, path: remote });
  }

  /** 诊断：镜像路径翻回 sshfs:// 后塞进 collection（固定 owner） */
  setDiagnostics(mirrorUri, list) {
    const localPath = uriToPath(mirrorUri);
    const uri = this.uriOfLocal(localPath);
    if (!uri) return;
    if (!list || list.length === 0) {
      this.diagnostics.delete(uri);
      return;
    }
    this.diagnostics.set(uri, list.map((d) => ({
      range: toRange(d.range),
      message: String(d.message ?? ""),
      severity: d.severity ? (d.severity - 1) : vscode.DiagnosticSeverity.Error,
      code: d.code === undefined ? undefined : String(d.code),
      source: d.source || "rce-lsp",
    })));
  }

  async dispose() {
    this.deps.cache?.markInactive(this.cacheKey);
    this.docs.clear();
    try {
      this.diagnosticsSub?.();
    } catch { /* 已释放 */ }
    this.diagnostics.dispose();
    try {
      await this.lsp.stopAll();
    } catch (err) {
      this.deps.log(`[LSP ${this.title}] 关闭失败：${err && err.message}`);
    }
  }
}

function toRange(r) {
  const s = r && r.start ? r.start : { line: 0, character: 0 };
  const e = r && r.end ? r.end : s;
  return new vscode.Range(s.line, s.character, e.line, e.character);
}

/**
 * 语言服务门面：provider 注册 + 文档事件 + 诊断路由。
 * 一个 provider 服务所有 authority，按文档所在工作区找对应的 LanguageService（同文件系统 provider 的思路）。
 */
function createLanguageServices(vscode, deps) {
  const services = new Map();     // `${authority}|${projectRoot}` → LanguageService
  const disposables = [];
  const projectRootCache = new Map();

  const normalizeRoot = (remoteRoot) => {
    const value = String(remoteRoot || "/").replace(/\/+$/, "");
    return value || "/";
  };
  const keyOf = (authority, remoteRoot) => `${authority}|${normalizeRoot(remoteRoot)}`;

  const serviceForRoot = (authority, remoteRoot, folderUri) => {
    const root = normalizeRoot(remoteRoot);
    const key = keyOf(authority, root);
    let service = services.get(key);
    if (!service) {
      service = new LanguageService(deps, vscode.Uri.from({ scheme: SCHEME, authority, path: root }));
      services.set(key, service);
      disposables.push(service);
      deps.log(`[LSP] 为项目 ${service.title} 建立语言服务通道（镜像根 ${service.mirrorRoot}）`);
    }
    return service;
  };

  /** 兼容手工命令：没有项目服务时，才退到工作区根。 */
  const serviceFor = (folderUri) => {
    if (!folderUri || folderUri.scheme !== SCHEME || !deps.session(folderUri)) return null;
    return serviceForRoot(folderUri.authority, folderUri.path, folderUri);
  };

  const projectRootForDocument = async (doc) => {
    const dir = path.posix.dirname(doc.uri.path || "/");
    const cacheKey = `${doc.uri.authority}|${dir}`;
    const cached = projectRootCache.get(cacheKey);
    if (cached) return cached;

    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const stop = normalizeRoot(folder?.uri?.path || "/");
    const session = deps.session(doc.uri);
    if (!session) return dir;

    const insideWorkspace = (candidate) => stop === "/" || candidate === stop || candidate.startsWith(stop + "/");
    let cursor = normalizeRoot(dir);
    while (insideWorkspace(cursor)) {
      try {
        const entries = await session.fs.listDir(cursor);
        if (entries.some((entry) => PROJECT_MARKERS.has(entry.name))) {
          projectRootCache.set(cacheKey, cursor);
          deps.log(`[LSP] 项目根：${cursor}（来自 ${doc.uri.path}）`);
          return cursor;
        }
      } catch (err) {
        deps.log(`[LSP] 探测项目根失败 ${cursor}：${err && err.message}`);
      }
      if (cursor === stop || cursor === "/") break;
      const parent = path.posix.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }

    // 没有项目标记时，只镜像文件所在目录；这比把整个工作区/home 镜像下来合理得多。
    projectRootCache.set(cacheKey, dir);
    deps.log(`[LSP] 未找到项目标记，按文件目录建项目：${dir}`);
    return dir;
  };

  const serviceOfDocument = (doc) => {
    if (!doc || !doc.uri || doc.uri.scheme !== SCHEME) return null;
    for (const service of services.values()) {
      if (service.authority !== doc.uri.authority) continue;
      if (service.mirrorPathOf(doc.uri)) return service;
    }
    return null;
  };

  const serviceForDocument = async (doc) => {
    const existing = serviceOfDocument(doc);
    if (existing) return existing;
    let root = await projectRootForDocument(doc);
    const fileDir = path.posix.dirname(doc.uri.path || "/");
    const session = deps.session(doc.uri);
    if (session && root !== fileDir) {
      try {
        const maxFiles = Number(deps.config().maxFiles) || 20000;
        const result = await session.conn.exec(buildMirrorFileCountCommand(root), { timeoutMs: 15000 });
        const count = Number(String(result.stdout || "").trim().split(/\s+/).pop());
        if (Number.isFinite(count) && count > maxFiles) {
          deps.log(`[LSP] 项目 ${root} 有 ${count} 个源文件，超过自动镜像上限 ${maxFiles}；自动降级为文件目录 ${fileDir}`);
          root = fileDir;
        }
      } catch (err) {
        deps.log(`[LSP] 项目大小检查失败，继续按项目处理：${err && err.message}`);
      }
    }
    return serviceForRoot(doc.uri.authority, root, doc.uri);
  };

  /** provider 统一入口：拿上下文 + 兜异常（语言服务卡住不能把编辑器挂死） */
  const run = async (doc, fn, fallback, label) => {
    const tag = label || "provider";
    const t0 = Date.now();
    let service;
    try {
      service = await serviceForDocument(doc);
    } catch (err) {
      deps.log(`[LSP] ${tag} 项目解析失败（${doc.uri.toString()}）：${err && err.message}`);
      return fallback;
    }
    if (!service) {
      deps.log(`[LSP] ${tag} 跳过：没有匹配的语言服务通道（${doc.uri.toString()}，languageId=${doc.languageId}）`);
      return fallback;
    }
    try {
      const ctx = await service.contextFor(doc);
      if (!ctx) {
        deps.log(`[LSP] ${tag} 跳过：拿不到镜像上下文（${doc.uri.toString()}）`);
        return fallback;
      }
      const out = await fn(service, ctx);
      deps.log(`[LSP] ${tag} 完成 ${Date.now() - t0}ms（${doc.uri.path}）`);
      return out;
    } catch (err) {
      deps.log(`[LSP] ${tag} 失败 ${Date.now() - t0}ms（${doc.uri.toString()}）：${err && err.message}`);
      return fallback;
    }
  };

  const locationsFor = (service, locations) => locations.map((l) => {
    const uri = service.uriOfLocal(uriToPath(l.uri));
    return uri ? new vscode.Location(uri, toRange(l.range)) : null;
  }).filter(Boolean);

  const toLspRange = (range) => ({
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  });

  const toLspDiagnostic = (d) => ({
    range: toLspRange(d.range),
    severity: typeof d.severity === "number" ? d.severity + 1 : 1,
    code: d.code === undefined ? undefined : String(d.code),
    source: d.source,
    message: d.message,
  });

  const applyWorkspaceEdit = (service, edit) => {
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const [fileUri, edits] of Object.entries(edit?.changes || {})) {
      const uri = service.uriOfLocal(uriToPath(fileUri));
      if (!uri) continue;
      for (const item of edits) workspaceEdit.replace(uri, toRange(item.range), item.newText);
    }
    return workspaceEdit;
  };

  const codeActionKind = (kind) => {
    switch (kind) {
      case "quickfix": return vscode.CodeActionKind.QuickFix;
      case "refactor": return vscode.CodeActionKind.Refactor;
      case "refactor.extract": return vscode.CodeActionKind.RefactorExtract;
      case "refactor.inline": return vscode.CodeActionKind.RefactorInline;
      case "refactor.rewrite": return vscode.CodeActionKind.RefactorRewrite;
      case "source": return vscode.CodeActionKind.Source;
      case "source.organizeImports": return vscode.CodeActionKind.SourceOrganizeImports;
      default: return vscode.CodeActionKind.Empty;
    }
  };

  const foldingKind = (kind) => {
    switch (kind) {
      case "comment": return vscode.FoldingRangeKind.Comment;
      case "imports": return vscode.FoldingRangeKind.Imports;
      case "region": return vscode.FoldingRangeKind.Region;
      default: return undefined;
    }
  };

  const toSignatureHelp = (raw) => {
    if (!raw) return undefined;
    const help = new vscode.SignatureHelp();
    help.signatures = raw.signatures.map((s) => {
      const info = new vscode.SignatureInformation(
        s.label,
        s.documentation ? new vscode.MarkdownString(s.documentation) : undefined,
      );
      if (Array.isArray(s.parameters)) {
        info.parameters = s.parameters.map((p) => new vscode.ParameterInformation(
          p.label,
          p.documentation ? new vscode.MarkdownString(p.documentation) : undefined,
        ));
      }
      if (typeof s.activeParameter === "number") info.activeParameter = s.activeParameter;
      return info;
    });
    help.activeSignature = raw.activeSignature ?? 0;
    help.activeParameter = raw.activeParameter ?? 0;
    return help;
  };

  const formatOptions = (options) => ({
    tabSize: options?.tabSize ?? 4,
    insertSpaces: options?.insertSpaces !== false,
    trimTrailingWhitespace: options?.trimTrailingWhitespace === true,
    insertFinalNewline: options?.insertFinalNewline === true,
    trimFinalNewlines: options?.trimFinalNewlines === true,
  });

  disposables.push(
    vscode.languages.registerDefinitionProvider(SELECTOR, {
      provideDefinition: (doc, pos) => run(doc, async (service, ctx) => locationsFor(
        service,
        await ctx.client.definition(ctx.mirrorPath, pos.line, pos.character),
      ), undefined, "definition"),
    }),

    vscode.languages.registerDeclarationProvider(SELECTOR, {
      provideDeclaration: (doc, pos) => run(doc, async (service, ctx) => locationsFor(
        service,
        await ctx.client.declaration(ctx.mirrorPath, pos.line, pos.character),
      ), undefined, "declaration"),
    }),

    vscode.languages.registerTypeDefinitionProvider(SELECTOR, {
      provideTypeDefinition: (doc, pos) => run(doc, async (service, ctx) => locationsFor(
        service,
        await ctx.client.typeDefinition(ctx.mirrorPath, pos.line, pos.character),
      ), undefined, "typeDefinition"),
    }),

    vscode.languages.registerImplementationProvider(SELECTOR, {
      provideImplementation: (doc, pos) => run(doc, async (service, ctx) => locationsFor(
        service,
        await ctx.client.implementation(ctx.mirrorPath, pos.line, pos.character),
      ), undefined, "implementation"),
    }),

    vscode.languages.registerReferenceProvider(SELECTOR, {
      provideReferences: (doc, pos, context) => run(doc, async (service, ctx) => locationsFor(
        service,
        await ctx.client.references(ctx.mirrorPath, pos.line, pos.character, context.includeDeclaration),
      ), [], "references"),
    }),

    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover: (doc, pos) => run(doc, async (service, ctx) => {
        const md = await ctx.client.hover(ctx.mirrorPath, pos.line, pos.character);
        if (!md) return undefined;
        const out = new vscode.MarkdownString(md);
        out.isTrusted = { enabledCommands: [] };
        return new vscode.Hover(out);
      }, undefined, "hover"),
    }),

    vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
      provideDocumentSymbols: (doc) => run(doc, async (service, ctx) => {
        const symbols = await ctx.client.documentSymbol(ctx.mirrorPath);
        return symbols.map(toSymbol);
      }, undefined, "documentSymbol"),
    }),

    vscode.languages.registerCompletionItemProvider(SELECTOR, {
      provideCompletionItems: (doc, pos) => run(doc, async (service, ctx) => {
        const items = await ctx.client.completion(ctx.mirrorPath, pos.line, pos.character);
        return new vscode.CompletionList(items.map(toCompletionItem), false);
      }, undefined, "completion"),
    }),

    vscode.languages.registerSignatureHelpProvider(SELECTOR, {
      provideSignatureHelp: (doc, pos) => run(doc, async (service, ctx) => toSignatureHelp(
        await ctx.client.signatureHelp(ctx.mirrorPath, pos.line, pos.character),
      ), undefined, "signatureHelp"),
    }, "(", ","),

    vscode.languages.registerDocumentHighlightProvider(SELECTOR, {
      provideDocumentHighlights: (doc, pos) => run(doc, async (service, ctx) => {
        const items = await ctx.client.documentHighlight(ctx.mirrorPath, pos.line, pos.character);
        return items.map((h) => new vscode.DocumentHighlight(
          toRange(h.range),
          typeof h.kind === "number" ? Math.max(0, h.kind - 1) : vscode.DocumentHighlightKind.Text,
        ));
      }, [], "documentHighlight"),
    }),

    vscode.languages.registerRenameProvider(SELECTOR, {
      prepareRename: (doc, pos) => run(doc, async (service, ctx) => {
        const range = await ctx.client.prepareRename(ctx.mirrorPath, pos.line, pos.character);
        return range ? toRange(range) : undefined;
      }, undefined, "prepareRename"),
      provideRenameEdits: (doc, pos, newName) => run(doc, async (service, ctx) => {
        const changes = await ctx.client.rename(ctx.mirrorPath, pos.line, pos.character, newName);
        return applyWorkspaceEdit(service, { changes });
      }, undefined, "rename"),
    }),

    vscode.languages.registerCodeActionsProvider(SELECTOR, {
      provideCodeActions: (doc, range, context) => run(doc, async (service, ctx) => {
        const actions = await ctx.client.codeAction(
          ctx.mirrorPath,
          toLspRange(range),
          (context.diagnostics || []).map(toLspDiagnostic),
        );
        return actions.map((raw) => {
          const action = new vscode.CodeAction(raw.title, codeActionKind(raw.kind));
          if (raw.edit) action.edit = applyWorkspaceEdit(service, raw.edit);
          if (raw.command) action.command = {
            title: raw.command.title,
            command: raw.command.command,
            arguments: raw.command.arguments,
          };
          if (raw.isPreferred) action.isPreferred = true;
          if (raw.disabled) action.disabled = { reason: raw.disabled.reason };
          return action;
        });
      }, [], "codeAction"),
    }),

    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, {
      provideDocumentFormattingEdits: (doc, options) => run(doc, async (service, ctx) => {
        const edits = await ctx.client.formatting(ctx.mirrorPath, formatOptions(options));
        return edits.map((e) => new vscode.TextEdit(toRange(e.range), e.newText));
      }, [], "formatting"),
    }),

    vscode.languages.registerDocumentRangeFormattingEditProvider(SELECTOR, {
      provideDocumentRangeFormattingEdits: (doc, range, options) => run(doc, async (service, ctx) => {
        const edits = await ctx.client.rangeFormatting(ctx.mirrorPath, toLspRange(range), formatOptions(options));
        return edits.map((e) => new vscode.TextEdit(toRange(e.range), e.newText));
      }, [], "rangeFormatting"),
    }),

    vscode.languages.registerFoldingRangeProvider(SELECTOR, {
      provideFoldingRanges: (doc) => run(doc, async (service, ctx) => {
        const ranges = await ctx.client.foldingRanges(ctx.mirrorPath);
        return ranges.map((f) => new vscode.FoldingRange(f.startLine, f.endLine, foldingKind(f.kind)));
      }, [], "foldingRange"),
    }),
  );

  // 文档事件：开了/改了/存了/关了都要让语言服务知道（字符串换 UI 里的镜像副本）
  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => serviceOfDocument(e.document)?.changeDocument(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => { void serviceOfDocument(doc)?.saveDocument(doc); }),
    vscode.workspace.onDidCloseTextDocument((doc) => serviceOfDocument(doc)?.closeDocument(doc)),
  );

  return {
    /** 工作区打开时不再预同步；第一次语言服务请求再按项目懒加载。 */
    attach(_folderUri) {
      return true;
    },
    serviceFor,
    serviceOfDocument,
    /** 手工重新同步镜像（§5.3「重新同步」入口）：只同步当前项目，绝不再退化成整个工作区。 */
    async syncMirror(folderUri) {
      const candidates = [...services.values()].filter((service) =>
        service.authority === folderUri.authority
        && (folderUri.path === service.remoteRoot || folderUri.path.startsWith(service.remoteRoot + "/"))
      );
      let service = candidates.sort((a, b) => b.remoteRoot.length - a.remoteRoot.length)[0];
      if (!service) {
        const active = vscode.window.activeTextEditor?.document;
        if (active?.uri?.scheme === SCHEME && active.uri.authority === folderUri.authority) {
          service = await serviceForDocument(active);
        }
      }
      if (!service) throw new Error("请先打开一个 C/C++ 或 Python 源码文件；系统会按项目自动同步");
      await service.ensureMirror(true);
      return service;
    },
    /** 重启语言服务（改了 compile_commands / 换了编译器时用） */
    async restart(folderUri) {
      const targets = [...services.values()].filter((service) =>
        service.authority === folderUri.authority
        && (folderUri.path === service.remoteRoot || folderUri.path.startsWith(service.remoteRoot + "/"))
      );
      if (targets.length === 0) {
        const active = vscode.window.activeTextEditor?.document;
        if (active?.uri?.scheme === SCHEME && active.uri.authority === folderUri.authority) {
          targets.push(await serviceForDocument(active));
        }
      }
      if (targets.length === 0) throw new Error("当前没有已启动的语言服务项目");
      for (const service of targets) {
        await service.lsp.stopAll();
        service.docs.clear();
        deps.log(`[LSP] ${service.title} 语言服务已重启`);
      }
      return targets[0];
    },
    /** 自检 / 端到端用：某个开关先关掉语言服务时统计一下 */
    stats() {
      return [...services.values()].map((s) => ({
        title: s.title,
        cacheKey: s.cacheKey,
        mirrorRoot: s.mirrorRoot,
        openDocs: s.docs.size,
      }));
    },
    /** 自检 / 端到端用：读某个文档当前的诊断（provider 之外没有公开读法） */
    diagnosticsFor(uri) {
      const service = serviceOfDocument({ uri });
      if (!service) return [];
      return service.diagnostics.get(uri) ?? [];
    },
    dispose() {
      for (const d of disposables) {
        try {
          const r = d.dispose();
          if (r && typeof r.catch === "function") r.catch(() => { /* 收尾失败就算了 */ });
        } catch { /* 已释放 */ }
      }
      for (const s of services.values()) {
        void Promise.resolve(s.dispose()).catch(() => { /* 同上 */ });
      }
      services.clear();
    },
  };
}

/** LSP DocumentSymbol → vscode.DocumentSymbol（子节点递归） */
function toSymbol(s) {
  const range = toRange(s.range);
  const sel = s.selectionRange ? toRange(s.selectionRange) : range;
  const symbol = new vscode.DocumentSymbol(
    String(s.name ?? ""),
    String(s.detail ?? ""),
    kindOf(s.kind, vscode.SymbolKind.Variable),
    range,
    sel,
  );
  for (const child of s.children ?? []) symbol.children.push(toSymbol(child));
  return symbol;
}

function toCompletionItem(item) {
  const out = new vscode.CompletionItem(String(item.label ?? ""), kindOf(item.kind, vscode.CompletionItemKind.Text));
  if (item.detail) out.detail = String(item.detail);
  if (item.documentation) out.documentation = new vscode.MarkdownString(String(item.documentation));
  if (item.sortText) out.sortText = String(item.sortText);
  if (item.filterText) out.filterText = String(item.filterText);
  // LSP 的 2 = Snippet：插进编辑器要按 snippet 语法解析
  out.insertText = item.insertTextFormat === 2 && item.insertText
    ? new vscode.SnippetString(String(item.insertText))
    : (item.insertText ?? item.label);
  return out;
}

module.exports = { createLanguageServices, LANGUAGE_BY_EXT, LANGUAGE_BY_VSCODE_ID, SCHEME };
