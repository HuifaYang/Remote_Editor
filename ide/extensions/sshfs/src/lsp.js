// 标准 LSP 桥：编辑器里的 sshfs:// 文档 ⇄ 远端按需语言服务。
//
// 主链路（默认）：
//   sshfs://u@host:port/ws/src/main.c ⇄ file:///ws/src/main.c → 远端 clangd/gopls/pylsp...
// 远端语言服务直接读取远端权威源码，不复制 sysroot、不维护源码镜像，也不依赖 VS Code Server。
// local 模式只作为离线/兼容选项保留，语言定义与远端模式完全共用。
"use strict";

const vscode = require("vscode");
const path = require("node:path");
const crypto = require("node:crypto");
const { MirrorManager, buildMirrorFileCountCommand } = require("../../../../dist/main/main/mirror/manager.js");
const { LspManager } = require("../../../../dist/main/main/lsp/manager.js");
const { uriToPath } = require("../../../../dist/main/main/lsp/client.js");
const { resolveLanguageServers, matchLanguageServer, rootMarkersFor } = require("../../../../dist/main/main/lsp/server-config.js");
const { normalizeRemotePath, mapServerPathToWorkspace, mapWorkspacePathToServer, pathWithin } = require("../../../../dist/main/main/lsp/remote-path.js");
const { SshfsMount, mountedRemotePath, remotePathFromMount } = require("../../../../dist/main/main/lsp/sshfs-mount.js");
const { prepareMountedWorkspace } = require("../../../../dist/main/main/lsp/mounted-workspace.js");

const SCHEME = "sshfs";

/** 所有 sshfs 文档都经过这里；未配置语言服务器的语言直接返回 undefined，不影响内置语法能力。 */
const SELECTOR = [{ scheme: SCHEME }];

const kindOf = (lspKind, fallback) => (typeof lspKind === "number" && lspKind > 0 ? lspKind - 1 : fallback);

function normalizeRoot(remoteRoot) {
  const value = String(remoteRoot || "/").replace(/\/+$/, "");
  return value || "/";
}

function markerMatches(name, marker) {
  if (marker.startsWith("*.")) return name.toLowerCase().endsWith(marker.slice(1).toLowerCase());
  return name === marker;
}

function toRange(r) {
  const s = r && r.start ? r.start : { line: 0, character: 0 };
  const e = r && r.end ? r.end : s;
  return new vscode.Range(s.line, s.character, e.line, e.character);
}

function launchOf(match) {
  return {
    id: match.server.id,
    command: match.server.command,
    args: [...match.server.args],
    env: { ...match.server.env },
    initializationOptions: match.server.initializationOptions,
  };
}

/** 一个远端项目目录共享一个本地语言服务通道；内部可同时运行多个语言服务。 */
class LanguageService {
  constructor(deps, folderUri) {
    this.deps = deps;
    this.authority = folderUri.authority;
    this.remoteRoot = normalizeRoot(folderUri.path);
    this.cacheKey = crypto.createHash("sha1").update(`${this.authority}${this.remoteRoot}`).digest("hex").slice(0, 12);
    this.mirrorRoot = path.join(deps.storageDir, "mirror", this.cacheKey);
    this.mountRoot = path.join(deps.storageDir, "mount", this.cacheKey, "root");
    this.localRoot = this.mountRoot;
    this.mountReady = null;
    this.mountedWorkspace = null;
    const mode = deps.config().transport;
    this.mirror = mode === "local"
      ? new MirrorManager(deps.session(folderUri).conn, this.mirrorRoot)
      : { root: this.localRoot, targetTriplet: "unknown" };
    this.mount = mode === "mount"
      ? new SshfsMount({
        mountPoint: this.mountRoot,
        spec: deps.session(folderUri).spec,
        binary: deps.config().sshfsPath || undefined,
        onLog: (line) => deps.log(`[SSHFS ${this.title}] ${line}`),
      })
      : null;
    this.realRoot = this.remoteRoot;
    this.aliasReady = this.prepareRemoteAlias();
    deps.cache?.markActive(this.cacheKey, { authority: this.authority, remoteRoot: this.remoteRoot });
    this.lsp = new LspManager(this.mirror, path.join(deps.storageDir, "lsp", this.cacheKey), {
      transportMode: () => this.deps.config().transport,
      connection: () => this.deps.session(folderUri)?.conn ?? null,
      serverPaths: () => ({ cpp: this.deps.config().cppPath, python: this.deps.config().pythonPath }),
      writeClangdConfig: mode !== "mount",
      onLog: (line) => this.deps.log(`[LSP ${this.title}] ${line}`),
    });
    this.diagnostics = vscode.languages.createDiagnosticCollection(`rce-lsp:${this.authority}`);
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
    /** `${serverId}|${servicePath}` → 文档状态，只保存最新全文，启动期间也不会回放旧版本。 */
    this.docs = new Map();
    this.active = false;
  }

  get title() {
    return `${this.authority}${this.remoteRoot}`;
  }

  get isRemote() {
    return this.deps.config().transport === "remote";
  }

  get isMount() {
    return this.deps.config().transport === "mount";
  }

  get hasLiveClients() {
    return this.active;
  }

  /** 软链接工作区：pwd -P 得到服务端真实根，用于把 clangd 返回的真实路径映射回工作区 URI。 */
  async prepareRemoteAlias() {
    const session = this.deps.session(this.authority);
    if (!session) return;
    try {
      const result = await session.conn.exec("pwd -P", { cwd: this.remoteRoot, timeoutMs: 8000 });
      const real = String(result.stdout || "").trim().split(/\r?\n/).pop();
      if (result.code === 0 && real && real.startsWith("/")) {
        this.realRoot = normalizeRoot(real);
        if (this.realRoot !== this.remoteRoot) {
          this.deps.log(`[LSP ${this.title}] 软链接工作区真实路径：${this.realRoot}`);
        }
      }
    } catch (err) {
      this.deps.log(`[LSP ${this.title}] 解析真实路径失败，继续使用工作区路径：${err && err.message}`);
    }
  }

  ensureMirror(force = false) {
    if (this.isMount) return this.ensureMount();
    if (this.isRemote) return Promise.resolve({ remote: true, fileCount: 0 });
    if (!force && this.sync) return this.sync;
    const previous = this.sync ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.doSync(force));
    this.sync = next;
    next.catch(() => { if (this.sync === next) this.sync = null; });
    return next;
  }

  /** 挂载远端 `/` 为只读视图，并准备本地 clangd 的挂载前缀编译数据库。 */
  ensureMount() {
    if (!this.isMount || !this.mount) return Promise.resolve(null);
    if (this.mountReady) return this.mountReady;
    this.mountReady = (async () => {
      const session = this.deps.session(this.authority);
      if (!session) throw new Error("SSH 会话已断开，无法建立语言服务文件视图");
      await this.aliasReady;
      await this.mount.mount();
      const prepared = await prepareMountedWorkspace({
        conn: session.conn,
        remoteRoot: this.remoteRoot,
        mountRoot: this.mountRoot,
        cacheDir: path.join(this.deps.storageDir, "lsp", this.cacheKey, "mounted"),
        onLog: (line) => this.deps.log(`[编译视图 ${this.title}] ${line}`),
      });
      this.localRoot = prepared.localRoot;
      this.mountedWorkspace = prepared;
      this.mirror.root = prepared.localRoot;
      this.mirror.targetTriplet = prepared.targetTriplet;
      this.deps.onMountReady?.(this, prepared);
      return prepared;
    })().catch((err) => {
      this.mountReady = null;
      throw err;
    });
    return this.mountReady;
  }

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
      const result = await conn.exec(buildMirrorFileCountCommand(this.remoteRoot), { timeoutMs: 15000 });
      const count = Number(String(result.stdout || "").trim().split(/\s+/).pop());
      if (!Number.isFinite(count) || count <= maxFiles) return;
      const err = new Error(`项目包含 ${count} 个源文件，超过自动镜像上限 ${maxFiles}`);
      err.code = "mirror-too-large";
      err.mirrorFileCount = count;
      err.mirrorMaxFiles = maxFiles;
      err.mirrorWorkspace = this.remoteRoot;
      this._tooLarge = err;
      throw err;
    })().finally(() => { this._preflightPromise = null; });
    return this._preflightPromise;
  }

  doSync(full = false) {
    this.mirror.loadPersistedManifest(this.remoteRoot);
    const started = Date.now();
    this.deps.cache?.touch(this.cacheKey, { authority: this.authority, remoteRoot: this.remoteRoot });
    this.deps.onMirrorProgress?.(this, { done: 0, total: 5, current: full ? "全量同步项目…" : "检查项目…" });
    return this.preflightWorkspace(full)
      .then(() => this.mirror.sync(this.remoteRoot, (p) => {
        this.deps.log(`[镜像 ${this.title}] ${p.current}（${p.done}/${p.total}）`);
        this.deps.onMirrorProgress?.(this, p);
      }, { full }))
      .then((result) => {
        this.deps.cache?.touch(this.cacheKey, { authority: this.authority, remoteRoot: this.remoteRoot });
        this.deps.log(`[镜像 ${this.title}] 就绪：${result.fileCount} 个文件 / ${result.totalBytes} 字节 / ${Date.now() - started}ms`);
        this.deps.onMirrorReady?.(this, result);
        return result;
      })
      .catch((err) => {
        if (err?.code === "mirror-too-large") this.deps.onMirrorTooLarge?.(this, err);
        else this.deps.onMirrorError?.(this, err);
        throw err;
      });
  }

  async client(match) {
    this.deps.cache?.touch(this.cacheKey, { authority: this.authority, remoteRoot: this.remoteRoot });
    let root;
    if (this.isRemote) {
      await this.aliasReady;
      root = this.remoteRoot;
    } else if (this.isMount) {
      await this.ensureMount();
      root = this.localRoot;
    } else {
      await this.ensureMirror();
    }
    const launch = launchOf(match);
    if (this.isMount && match.server.id === "cpp") {
      // 只读挂载不能把 clangd 索引写回远端；索引留在内存，编译数据库用本地挂载前缀。
      launch.args = launch.args
        .filter((arg) => !arg.startsWith("--background-index") && !arg.startsWith("--compile-commands-dir"))
        .concat([
          "--background-index=0",
          "--pch-storage=memory",
          `--compile-commands-dir=${this.mountedWorkspace.compileCommandsDir}`,
        ]);
    }
    // 语言进程的 cwd 固定在本地缓存目录，避免 SSHFS cwd 短暂不可访问时 spawn 被误报 ENOENT。
    const runtimeCwd = this.isMount
      ? path.dirname(this.mountedWorkspace.compileCommandsDir)
      : root;
    const client = await this.lsp.ensure(match.server.id, root, launch, runtimeCwd);
    this.active = true;
    return client;
  }

  /** 文档 → { client, servicePath }。启动期间若继续编辑，didOpen 使用 entry 里的最新全文和版本。 */
  async contextFor(doc, match) {
    const servicePath = this.servicePathOf(doc.uri);
    if (!servicePath) return null;
    const key = `${match.server.id}|${servicePath}`;
    let entry = this.docs.get(key);
    if (!entry) {
      entry = {
        key,
        servicePath,
        client: null,
        version: 1,
        text: doc.getText(),
        languageId: match.languageId,
        opened: false,
        dirty: false,
        timer: null,
        opening: null,
      };
      this.docs.set(key, entry);
    } else {
      entry.text = doc.getText();
      entry.languageId = match.languageId;
    }
    if (!entry.client) {
      if (!entry.opening) {
        entry.opening = (async () => {
          const client = await this.client(match);
          if (this.docs.get(key) !== entry) return;
          entry.client = client;
          entry.opened = true;
          client.didOpen(entry.servicePath, entry.text, entry.version, entry.languageId);
        })().catch((err) => {
          entry.opening = null;
          throw err;
        });
      }
      await entry.opening;
    }
    if (!entry.client) return null;
    return { client: entry.client, servicePath, mirrorPath: servicePath };
  }

  trackDocument(doc, match, increment = false) {
    const servicePath = this.servicePathOf(doc.uri);
    if (!servicePath) return null;
    const key = `${match.server.id}|${servicePath}`;
    let entry = this.docs.get(key);
    if (!entry) {
      entry = {
        key,
        servicePath,
        client: null,
        version: 1,
        text: doc.getText(),
        languageId: match.languageId,
        opened: false,
        dirty: false,
        timer: null,
        opening: null,
      };
      this.docs.set(key, entry);
    } else {
      if (increment) entry.version += 1;
      entry.text = doc.getText();
      entry.languageId = match.languageId;
    }
    return entry;
  }

  scheduleChange(entry) {
    if (!entry?.client || !entry.opened) return;
    entry.dirty = true;
    if (entry.timer) return;
    // 全量同步合并 50ms 内的连续输入，只发送最后一版，避免打字时 JSON-RPC 排队。
    entry.timer = setTimeout(() => this.flushChange(entry), 50);
  }

  flushChange(entry) {
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.dirty || !entry.client || !entry.opened) return;
    entry.dirty = false;
    entry.client.didChange(entry.servicePath, entry.text, entry.version);
  }

  changeDocument(doc, match) {
    const entry = this.trackDocument(doc, match, true);
    this.scheduleChange(entry);
  }

  async saveDocument(doc, match) {
    const entry = this.trackDocument(doc, match, false);
    if (!entry) return;
    this.flushChange(entry);
    if (!this.isRemote && !this.isMount) {
      try {
        await this.mirror.applyLocalSave(
          doc.uri.path,
          doc.getText(),
          "utf8",
          doc.eol === vscode.EndOfLine.CRLF ? "crlf" : "lf",
        );
      } catch (err) {
        this.deps.log(`[镜像 ${this.title}] 保存回写失败：${err && err.message}`);
      }
    }
    if (entry.client && entry.opened) entry.client.didSave(entry.servicePath, entry.text);
  }

  closeDocument(doc, match) {
    const servicePath = this.servicePathOf(doc.uri);
    if (!servicePath) return;
    const key = `${match.server.id}|${servicePath}`;
    const entry = this.docs.get(key);
    if (!entry) return;
    this.docs.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.client && entry.opened) entry.client.didClose(entry.servicePath);
  }

  /** sshfs:// → 远端路径（remote）或镜像路径（local）。 */
  servicePathOf(uri) {
    const documentPath = normalizeRemotePath(uri.path);
    if (this.isMount) {
      if (!pathWithin(documentPath, this.remoteRoot) && !pathWithin(documentPath, this.realRoot)) return null;
      const serverPath = mapWorkspacePathToServer(documentPath, this.remoteRoot, this.realRoot);
      return mountedRemotePath(this.mountRoot, serverPath);
    }
    if (this.isRemote) {
      return pathWithin(documentPath, this.remoteRoot) || pathWithin(documentPath, this.realRoot) ? documentPath : null;
    }
    try {
      return this.mirror.localPathOf(documentPath);
    } catch {
      return null;
    }
  }

  /** 服务端 URI → sshfs://。真实软链接路径会折回工作区可见路径。 */
  uriOfServicePath(servicePath) {
    if (!servicePath) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(servicePath)) return vscode.Uri.parse(servicePath);
    if (!servicePath.startsWith("/")) return null;
    const normalized = normalizeRemotePath(servicePath);
    if (this.isMount) {
      const remote = remotePathFromMount(this.mountRoot, servicePath);
      if (!remote) return null;
      return vscode.Uri.from({
        scheme: SCHEME,
        authority: this.authority,
        path: mapServerPathToWorkspace(remote, this.remoteRoot, this.realRoot),
      });
    }
    if (this.isRemote) {
      const remote = mapServerPathToWorkspace(normalized, this.remoteRoot, this.realRoot);
      return vscode.Uri.from({ scheme: SCHEME, authority: this.authority, path: remote });
    }
    try {
      const remote = this.mirror.remotePathOf(normalized);
      return vscode.Uri.from({ scheme: SCHEME, authority: this.authority, path: remote });
    } catch {
      return null;
    }
  }

  setDiagnostics(serviceUri, list) {
    const localPath = uriToPath(serviceUri);
    const uri = this.uriOfServicePath(localPath);
    if (!uri) return;
    if (!list || list.length === 0) {
      this.diagnostics.delete(uri);
      return;
    }
    this.diagnostics.set(uri, list.map((d) => ({
      range: toRange(d.range),
      message: String(d.message ?? ""),
      severity: d.severity ? d.severity - 1 : vscode.DiagnosticSeverity.Error,
      code: d.code === undefined ? undefined : String(d.code),
      source: d.source || "LSP",
    })));
  }

  /** 浏览模式冷却：停止所有语言服务，但保留项目对象，切回智能模式无需重开窗口。 */
  async cool() {
    for (const entry of this.docs.values()) if (entry.timer) clearTimeout(entry.timer);
    this.docs.clear();
    this.active = false;
    await this.lsp.stopAll();
    if (this.mount && this.mount.isMounted) await this.mount.unmount();
    this.mountReady = null;
  }

  async dispose() {
    this.deps.cache?.markInactive(this.cacheKey);
    await this.cool();
    try { this.diagnosticsSub?.(); } catch { /* 已释放 */ }
    this.diagnostics.dispose();
  }
}

/** Provider 门面：模式、配置注册表、项目发现与文档事件都集中在这里。 */
function createLanguageServices(vscode, deps) {
  const services = new Map();
  const disposables = [];
  const projectRootCache = new Map();
  const primeInflight = new Map();
  let currentMode = deps.config().mode === "intelligent" ? "intelligent" : "browse";
  let coolingTimer = null;

  const settings = () => deps.config();
  const registry = () => {
    const cfg = settings();
    const servers = resolveLanguageServers(cfg.servers, {
      cppCommand: cfg.cppPath,
      pythonCommand: cfg.pythonPath,
    });
    return { cfg, servers, markers: rootMarkersFor(servers.values()) };
  };

  const matchFor = (doc) => {
    if (!doc?.uri || doc.uri.scheme !== SCHEME) return null;
    return matchLanguageServer(registry().servers.values(), doc.languageId, doc.uri.path);
  };

  const keyOf = (authority, remoteRoot) => `${authority}|${normalizeRoot(remoteRoot)}`;

  const emitState = (state, message, detail = "") => {
    deps.onLspState?.({ state, message, detail, mode: currentMode });
  };

  const serviceForRoot = (authority, remoteRoot) => {
    const root = normalizeRoot(remoteRoot);
    const key = keyOf(authority, root);
    let service = services.get(key);
    if (!service) {
      service = new LanguageService(deps, vscode.Uri.from({ scheme: SCHEME, authority, path: root }));
      services.set(key, service);
      disposables.push(service);
      deps.log(`[LSP] 为 ${service.title} 建立语言服务通道（${settings().transport}）`);
    }
    return service;
  };

  const serviceFor = (folderUri) => {
    if (!folderUri || folderUri.scheme !== SCHEME || !deps.session(folderUri)) return null;
    return serviceForRoot(folderUri.authority, folderUri.path);
  };

  const projectRootForDocument = async (doc, match) => {
    const dir = normalizeRoot(path.posix.dirname(doc.uri.path || "/"));
    const cacheKey = `${doc.uri.authority}|${match.server.id}|${dir}`;
    if (projectRootCache.has(cacheKey)) return projectRootCache.get(cacheKey);
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const stop = normalizeRoot(folder?.uri?.path || "/");
    const session = deps.session(doc.uri);
    if (!session) return dir;
    const inside = (candidate) => pathWithin(candidate, stop);
    const markers = rootMarkersFor([match.server]);
    let cursor = dir;
    while (inside(cursor)) {
      try {
        const entries = await session.fs.listDir(cursor);
        if (entries.some((entry) => [...markers].some((marker) => markerMatches(entry.name, marker)))) {
          projectRootCache.set(cacheKey, cursor);
          deps.log(`[LSP] 项目根：${cursor}（${match.server.id}，来自 ${doc.uri.path}）`);
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
    projectRootCache.set(cacheKey, dir);
    deps.log(`[LSP] 未找到项目标记，按文件目录建项目：${dir}`);
    return dir;
  };

  const serviceOfDocument = (doc) => {
    if (!doc?.uri || doc.uri.scheme !== SCHEME) return null;
    let best = null;
    for (const service of services.values()) {
      if (service.authority !== doc.uri.authority || !service.servicePathOf(doc.uri)) continue;
      // 嵌套项目取最深的根，避免诊断/定义被父项目通道截走。
      if (!best || service.remoteRoot.length > best.remoteRoot.length) best = service;
    }
    return best;
  };

  const serviceForDocument = async (doc, match) => {
    const existing = serviceOfDocument(doc);
    if (existing) return existing;
    let root = await projectRootForDocument(doc, match);
    const fileDir = normalizeRoot(path.posix.dirname(doc.uri.path || "/"));
    if (settings().transport === "local" && root !== fileDir) {
      const session = deps.session(doc.uri);
      if (session) {
        try {
          const maxFiles = Number(settings().maxFiles) || 20000;
          const result = await session.conn.exec(buildMirrorFileCountCommand(root), { timeoutMs: 15000 });
          const count = Number(String(result.stdout || "").trim().split(/\s+/).pop());
          if (Number.isFinite(count) && count > maxFiles) root = fileDir;
        } catch { /* 大小检查失败时继续按项目处理 */ }
      }
    }
    return serviceForRoot(doc.uri.authority, root);
  };

  const prime = async (doc) => {
    const cfg = settings();
    if (!doc || currentMode !== "intelligent" || !cfg.enabled || cfg.transport === "disabled") return null;
    const match = matchFor(doc);
    if (!match) return null;
    const cacheKey = `${doc.uri.authority}|${doc.uri.path}|${match.server.id}`;
    if (primeInflight.has(cacheKey)) return primeInflight.get(cacheKey);
    emitState("warming", "语言智能：启动中…", `${doc.uri.path}\n服务器：${match.server.command}`);
    const task = (async () => {
      const service = await serviceForDocument(doc, match);
      await service.contextFor(doc, match);
      emitState("ready", "语言智能：就绪", `${service.title}\n服务器：${match.server.command}`);
      return service;
    })().catch((err) => {
      deps.log(`[LSP] 启动失败（${doc.uri.path}）：${err && err.message}`);
      emitState("error", "语言智能：启动失败", `${err && err.message ? err.message : String(err)}\n点击查看操作`);
      throw err;
    }).finally(() => primeInflight.delete(cacheKey));
    primeInflight.set(cacheKey, task);
    return task;
  };

  const primeActive = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc) void prime(doc).catch(() => {});
  };

  const clearCooling = () => {
    if (coolingTimer) clearTimeout(coolingTimer);
    coolingTimer = null;
  };

  const setMode = (mode, options = {}) => {
    currentMode = mode === "intelligent" ? "intelligent" : "browse";
    clearCooling();
    if (currentMode === "intelligent") {
      emitState("warming", "语言智能：准备中…", "当前文件优先启动，后台索引不阻塞编辑");
      if (options.prime !== false) primeActive();
      return;
    }
    const warm = [...services.values()].some((service) => service.hasLiveClients);
    if (!warm) {
      emitState("browse", "浏览模式", "不启动语言服务；首次编辑可自动进入代码智能");
      return;
    }
    const retention = Math.max(0, Number(settings().warmRetentionMs) || 0);
    emitState("browse-warm", "浏览模式（热保留）", `语言服务保持 ${Math.round(retention / 1000)} 秒，切回智能模式立即恢复`);
    if (retention <= 0) {
      void coolAll();
      return;
    }
    coolingTimer = setTimeout(() => { void coolAll(); }, retention);
  };

  const coolAll = async () => {
    clearCooling();
    const active = [...services.values()].filter((service) => service.hasLiveClients);
    for (const service of active) await service.cool().catch(() => {});
    emitState("browse", "浏览模式", "语言服务已停止；首次编辑可自动进入代码智能");
  };

  const run = async (doc, fn, fallback, token, label) => {
    const cfg = settings();
    if (!cfg.enabled || cfg.transport === "disabled" || currentMode !== "intelligent") return fallback;
    const match = matchFor(doc);
    if (!match) return fallback;
    const t0 = Date.now();
    let lastError;
    const attempts = cfg.transport === "mount" ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const service = await serviceForDocument(doc, match);
        const ctx = await service.contextFor(doc, match);
        if (!ctx) return fallback;
        const out = await fn(service, ctx, match);
        deps.log(`[LSP] ${label || "provider"} ${Date.now() - t0}ms（${doc.uri.path}，${match.server.id}）`);
        return out;
      } catch (err) {
        lastError = err;
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    deps.log(`[LSP] ${label || "provider"} 失败：${lastError && lastError.message}`);
    return fallback;
  };

  const locationsFor = (service, locations) => locations.map((location) => {
    const uri = service.uriOfServicePath(uriToPath(location.uri));
    return uri ? new vscode.Location(uri, toRange(location.range)) : null;
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
      const uri = service.uriOfServicePath(uriToPath(fileUri));
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
      const info = new vscode.SignatureInformation(s.label, s.documentation ? new vscode.MarkdownString(s.documentation) : undefined);
      if (Array.isArray(s.parameters)) {
        info.parameters = s.parameters.map((p) => new vscode.ParameterInformation(
          p.label,
          p.documentation ? new vscode.MarkdownString(p.documentation) : undefined,
        ));
      }
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
      provideDefinition: (doc, pos, token) => run(doc, async (service, ctx) => locationsFor(
        service, await ctx.client.definition(ctx.servicePath, pos.line, pos.character, token),
      ), undefined, token, "definition"),
    }),
    vscode.languages.registerDeclarationProvider(SELECTOR, {
      provideDeclaration: (doc, pos, token) => run(doc, async (service, ctx) => locationsFor(
        service, await ctx.client.declaration(ctx.servicePath, pos.line, pos.character, token),
      ), undefined, token, "declaration"),
    }),
    vscode.languages.registerTypeDefinitionProvider(SELECTOR, {
      provideTypeDefinition: (doc, pos, token) => run(doc, async (service, ctx) => locationsFor(
        service, await ctx.client.typeDefinition(ctx.servicePath, pos.line, pos.character, token),
      ), undefined, token, "typeDefinition"),
    }),
    vscode.languages.registerImplementationProvider(SELECTOR, {
      provideImplementation: (doc, pos, token) => run(doc, async (service, ctx) => locationsFor(
        service, await ctx.client.implementation(ctx.servicePath, pos.line, pos.character, token),
      ), undefined, token, "implementation"),
    }),
    vscode.languages.registerReferenceProvider(SELECTOR, {
      provideReferences: (doc, pos, context, token) => run(doc, async (service, ctx) => locationsFor(
        service, await ctx.client.references(ctx.servicePath, pos.line, pos.character, context.includeDeclaration, token),
      ), [], token, "references"),
    }),
    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover: (doc, pos, token) => run(doc, async (service, ctx) => {
        const md = await ctx.client.hover(ctx.servicePath, pos.line, pos.character, token);
        if (!md) return undefined;
        const out = new vscode.MarkdownString(md);
        out.isTrusted = { enabledCommands: [] };
        return new vscode.Hover(out);
      }, undefined, token, "hover"),
    }),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
      provideDocumentSymbols: (doc, token) => run(doc, async (service, ctx) => {
        const symbols = await ctx.client.documentSymbol(ctx.servicePath, token);
        return symbols.map(toSymbol);
      }, undefined, token, "documentSymbol"),
    }),
    vscode.languages.registerCompletionItemProvider(SELECTOR, {
      provideCompletionItems: (doc, pos, token) => run(doc, async (service, ctx) => {
        const items = await ctx.client.completion(ctx.servicePath, pos.line, pos.character, token);
        return new vscode.CompletionList(items.map(toCompletionItem), false);
      }, undefined, token, "completion"),
    }),
    vscode.languages.registerSignatureHelpProvider(SELECTOR, {
      provideSignatureHelp: (doc, pos, token) => run(doc, async (service, ctx) => toSignatureHelp(
        await ctx.client.signatureHelp(ctx.servicePath, pos.line, pos.character, token),
      ), undefined, token, "signatureHelp"),
    }, "(", ","),
    vscode.languages.registerDocumentHighlightProvider(SELECTOR, {
      provideDocumentHighlights: (doc, pos, token) => run(doc, async (service, ctx) => {
        const items = await ctx.client.documentHighlight(ctx.servicePath, pos.line, pos.character, token);
        return items.map((h) => new vscode.DocumentHighlight(
          toRange(h.range),
          typeof h.kind === "number" ? Math.max(0, h.kind - 1) : vscode.DocumentHighlightKind.Text,
        ));
      }, [], token, "documentHighlight"),
    }),
    vscode.languages.registerRenameProvider(SELECTOR, {
      prepareRename: (doc, pos, token) => run(doc, async (service, ctx) => {
        const range = await ctx.client.prepareRename(ctx.servicePath, pos.line, pos.character, token);
        return range ? toRange(range) : undefined;
      }, undefined, token, "prepareRename"),
      provideRenameEdits: (doc, pos, newName, token) => run(doc, async (service, ctx) => {
        const changes = await ctx.client.rename(ctx.servicePath, pos.line, pos.character, newName, token);
        return applyWorkspaceEdit(service, { changes });
      }, undefined, token, "rename"),
    }),
    vscode.languages.registerCodeActionsProvider(SELECTOR, {
      provideCodeActions: (doc, range, context, token) => run(doc, async (service, ctx) => {
        const actions = await ctx.client.codeAction(
          ctx.servicePath,
          toLspRange(range),
          (context.diagnostics || []).map(toLspDiagnostic),
          token,
        );
        return actions.map((raw) => {
          const action = new vscode.CodeAction(raw.title, codeActionKind(raw.kind));
          if (raw.edit) action.edit = applyWorkspaceEdit(service, raw.edit);
          if (raw.command) action.command = { title: raw.command.title, command: raw.command.command, arguments: raw.command.arguments };
          if (raw.isPreferred) action.isPreferred = true;
          if (raw.disabled) action.disabled = { reason: raw.disabled.reason };
          return action;
        });
      }, [], token, "codeAction"),
    }),
    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, {
      provideDocumentFormattingEdits: (doc, options, token) => run(doc, async (service, ctx) => {
        const edits = await ctx.client.formatting(ctx.servicePath, formatOptions(options), token);
        return edits.map((e) => new vscode.TextEdit(toRange(e.range), e.newText));
      }, [], token, "formatting"),
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(SELECTOR, {
      provideDocumentRangeFormattingEdits: (doc, range, options, token) => run(doc, async (service, ctx) => {
        const edits = await ctx.client.rangeFormatting(ctx.servicePath, toLspRange(range), formatOptions(options), token);
        return edits.map((e) => new vscode.TextEdit(toRange(e.range), e.newText));
      }, [], token, "rangeFormatting"),
    }),
    vscode.languages.registerFoldingRangeProvider(SELECTOR, {
      provideFoldingRanges: (doc, _context, token) => run(doc, async (service, ctx) => {
        const ranges = await ctx.client.foldingRanges(ctx.servicePath, token);
        return ranges.map((f) => new vscode.FoldingRange(f.startLine, f.endLine, foldingKind(f.kind)));
      }, [], token, "foldingRange"),
    }),
  );

  disposables.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      const match = matchFor(doc);
      if (!match) return;
      if (currentMode === "browse" && settings().autoPromoteOnEdit !== false) {
        setMode("intelligent", { prime: false });
        void prime(doc).then(() => {
          const active = vscode.window.activeTextEditor?.document;
          if (currentMode === "intelligent" && active?.uri.toString() === doc.uri.toString()) {
            void vscode.commands.executeCommand("editor.action.triggerSuggest");
          }
        }).catch(() => {});
      }
      const service = serviceOfDocument(doc);
      if (service) service.changeDocument(doc, match);
      else if (currentMode === "intelligent") {
        void prime(doc).then((started) => started?.changeDocument(doc, match)).catch(() => {});
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const match = matchFor(doc);
      const service = serviceOfDocument(doc);
      if (match && service) void service.saveDocument(doc, match);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const match = matchFor(doc);
      const service = serviceOfDocument(doc);
      if (match && service) service.closeDocument(doc, match);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (currentMode === "intelligent" && editor) void prime(editor.document).catch(() => {});
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (currentMode === "intelligent") void prime(doc).catch(() => {});
    }),
  );

  return {
    attach() { return true; },
    serviceFor,
    serviceOfDocument,
    matchForDocument: matchFor,
    currentMode: () => currentMode,
    setMode,
    async reload() {
      for (const service of services.values()) await service.dispose().catch(() => {});
      services.clear();
      projectRootCache.clear();
      primeInflight.clear();
      currentMode = settings().mode === "intelligent" ? "intelligent" : "browse";
      setMode(currentMode);
    },
    async syncMirror(folderUri) {
      const active = vscode.window.activeTextEditor?.document;
      if (settings().transport !== "local") {
        await coolAll();
        if (active && matchFor(active)) {
          setMode("intelligent", { prime: false });
          await prime(active);
        }
        return serviceOfDocument(active) || serviceFor(folderUri);
      }
      const candidates = [...services.values()].filter((service) => service.authority === folderUri.authority
        && (folderUri.path === service.remoteRoot || folderUri.path.startsWith(`${service.remoteRoot}/`)));
      let service = candidates.sort((a, b) => b.remoteRoot.length - a.remoteRoot.length)[0];
      if (!service && active?.uri?.scheme === SCHEME) service = await serviceForDocument(active, matchFor(active));
      if (!service) throw new Error("请先打开一个已配置语言服务的源码文件");
      await service.ensureMirror(true);
      return service;
    },
    async restart(folderUri) {
      const targets = [...services.values()].filter((service) => service.authority === folderUri.authority
        && (folderUri.path === service.remoteRoot || folderUri.path.startsWith(`${service.remoteRoot}/`)));
      for (const service of targets) await service.cool().catch(() => {});
      const active = vscode.window.activeTextEditor?.document;
      if (active && matchFor(active)) await prime(active);
    },
    stats() {
      const reg = registry();
      return {
        mode: currentMode,
        transport: settings().transport,
        servers: [...reg.servers.values()].map((server) => ({
          id: server.id, command: server.command, languageIds: server.languageIds, extensions: server.extensions,
        })),
        projects: [...services.values()].map((service) => ({
          title: service.title,
          remoteRoot: service.remoteRoot,
          realRoot: service.realRoot,
          cacheKey: service.cacheKey,
          mirrorRoot: service.mirrorRoot,
          openDocs: service.docs.size,
          live: service.hasLiveClients,
          mountRoot: service.mountRoot,
          localRoot: service.localRoot,
          compileCommandsDir: service.mountedWorkspace?.compileCommandsDir || null,
        })),
      };
    },
    diagnosticsFor(uri) {
      const service = serviceOfDocument({ uri });
      if (!service) return [];
      return service.diagnostics.get(uri) ?? [];
    },
    dispose() {
      clearCooling();
      for (const d of disposables) {
        try { d.dispose(); } catch { /* 已释放 */ }
      }
      for (const service of services.values()) void service.dispose().catch(() => {});
      services.clear();
    },
  };
}

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
  out.insertText = item.insertTextFormat === 2 && item.insertText
    ? new vscode.SnippetString(String(item.insertText))
    : (item.insertText ?? item.label);
  return out;
}

module.exports = { createLanguageServices, SCHEME };
