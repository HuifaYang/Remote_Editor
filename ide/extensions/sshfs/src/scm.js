// 源代码管理：内置 git 扩展在虚拟工作区里会去本机跑 git（那些远端路径本机根本不存在），所以 SCM 面板
// 必须我们自己供给。复用仓库的 GitRemote（远端 `git` 命令），把结果喂给 VSCode 的 SourceControl API。
"use strict";

const { splitStatus } = require("../../../../dist/main/shared/git-status.js");

const GIT_SCHEME = "rce-git";

/** porcelain 字母 → 主题色 / 删除线（对齐内置 git 扩展的观感） */
const STATE_TABLE = {
  A: { color: "gitDecoration.addedResourceForeground" },
  M: { color: "gitDecoration.modifiedResourceForeground" },
  D: { color: "gitDecoration.deletedResourceForeground", strikeThrough: true },
  R: { color: "gitDecoration.renamedResourceForeground" },
  U: { color: "gitDecoration.untrackedResourceForeground" },
  "!": { color: "gitDecoration.ignoredResourceForeground", faded: true },
};

/**
 * 原生 Source Control Graph（源代码管理图）的数据源。
 *
 * proposed API `scmHistoryProvider`：只要在 SourceControl 上挂了 historyProvider，工作台就会
 * 自动显示出那个带分支/提交连线的 Graph 视图，渲染全部由 CodeOSS 负责——我们只把远端
 * `git log` 的结果翻译成它要的结构，不画任何 UI。
 */
function createHistoryProvider(vscode, entry, deps) {
  const { log, originalResourceOf } = deps;
  const onDidChangeCurrentHistoryItemRefs = new vscode.EventEmitter();
  const onDidChangeHistoryItemRefs = new vscode.EventEmitter();
  const itemCache = new Map();
  let refsByRevision = new Map();

  // CodeOSS Graph 只会渲染带 ThemeIcon 的 ref badge；没有 icon 的 reference 会被直接跳过。
  // 必须和内置 Git 扩展一样给本地分支/远端分支/标签提供原生图标。
  const iconForRef = (id) => new vscode.ThemeIcon(
    id.startsWith("refs/remotes/") ? "cloud" : id.startsWith("refs/tags/") ? "tag" : "git-branch",
  );
  const makeHistoryRef = (id, name) => ({ id, name, icon: iconForRef(id) });

  const toRef = (name, remote, revision) => ({
    id: remote ? `refs/remotes/${name}` : `refs/heads/${name}`,
    name,
    // revision（分支指向的 commit hash）必须带：CodeOSS 历史图用 ref.revision 定位提交与配色，
    // 缺了它图会退化（只剩一条线）。内置 git 扩展的每个 ref 都带这个字段。
    revision,
    description: revision ? revision.slice(0, 7) : undefined,
    category: remote ? "远端分支" : "本地分支",
    icon: iconForRef(remote ? `refs/remotes/${name}` : `refs/heads/${name}`),
  });

  /** `git log %D` 可能是短 ref，也可能因 --decorate=full 给出完整 ref；统一成完整 id。 */
  const toHistoryRef = (raw) => {
    let value = raw.replace(/^HEAD -> /, "");
    const tag = value.startsWith("tag: ");
    if (tag) value = value.slice(5);
    if (value.startsWith("refs/tags/")) return makeHistoryRef(value, value.slice("refs/tags/".length));
    if (value.startsWith("refs/heads/")) return makeHistoryRef(value, value.slice("refs/heads/".length));
    if (value.startsWith("refs/remotes/")) return makeHistoryRef(value, value.slice("refs/remotes/".length));
    if (tag) return makeHistoryRef(`refs/tags/${value}`, value);
    if (raw.startsWith("HEAD -> ") || value === entry.headRef?.name) {
      return makeHistoryRef(`refs/heads/${value}`, value);
    }
    const slash = value.indexOf("/");
    if (slash > 0 && entry.remoteNames?.has(value.slice(0, slash))) {
      return makeHistoryRef(`refs/remotes/${value}`, value);
    }
    return makeHistoryRef(`refs/heads/${value}`, value);
  };

  return {
    get currentHistoryItemRef() {
      return entry.headRef;
    },
    get currentHistoryItemRemoteRef() {
      return entry.upstreamRef;
    },
    get currentHistoryItemBaseRef() {
      return undefined;
    },
    onDidChangeCurrentHistoryItemRefs: onDidChangeCurrentHistoryItemRefs.event,
    onDidChangeHistoryItemRefs: onDidChangeHistoryItemRefs.event,

    /** 图顶部的分支 / 远端引用 */
    async provideHistoryItemRefs(historyItemRefs, _token) {
      const allBranches = await entry.git.branches(entry.uri.path).catch(() => []);
      entry.remoteNames = new Set(allBranches.filter((b) => b.remote).map((b) => b.name.split("/")[0]));
      let branches = allBranches;
      if (Array.isArray(historyItemRefs) && historyItemRefs.length > 0) {
        const wanted = new Set(historyItemRefs);
        branches = branches.filter((b) => wanted.has(b.remote ? `refs/remotes/${b.name}` : `refs/heads/${b.name}`));
      }
      const refs = branches.map((b) => toRef(b.name, b.remote, b.revision));
      refsByRevision = new Map();
      for (const ref of refs) {
        if (!ref.revision) continue;
        refsByRevision.set(ref.revision, [...(refsByRevision.get(ref.revision) || []), ref]);
      }
      log(`[history] provideHistoryItemRefs(${Array.isArray(historyItemRefs) ? historyItemRefs.length : "全部"}) → ${refs.length} 个分支（含远端）`);
      log(`[history] refs: ${refs.map((ref) => `${ref.name}@${String(ref.revision || "").slice(0, 7)}`).join(", ")}`);
      return refs;
    },

    /** 提交列表：id/parentIds 决定图里的连线，其余是列表内容 */
    async provideHistoryItems(options, _token) {
      const limit = typeof options.limit === "number" ? options.limit : 200;
      const refs = Array.isArray(options.historyItemRefs)
        ? options.historyItemRefs
        : (entry.headRef?.revision ? [entry.headRef.revision] : []);
      const rows = await entry.git.logGraph(entry.uri.path, limit, refs, Number(options.skip) || 0).catch(() => []);
      const parentCounts = rows.map((row) => row.commit.parents.length);
      log(`[history] provideHistoryItems(limit=${limit}, refs=${refs.length}, skip=${options.skip || 0}) → ${rows.length} 条，parent=${parentCounts.join(",")}`);
      const items = rows.map((row) => {
        const c = row.commit;
        const ts = Date.parse(c.date);
        const attached = new Map();
        for (const raw of c.refs || []) {
          const ref = toHistoryRef(raw);
          attached.set(ref.id, ref);
        }
        for (const ref of refsByRevision.get(c.hash) || []) {
          attached.set(ref.id, ref);
        }
        return {
          id: c.hash,
          displayId: c.hash.slice(0, 7),   // 多文件 diff 标签 / 悬停提示里的短 hash
          parentIds: c.parents || [],
          // 每行正文前也带上短 hash：VS Code 原生只在悬停和 diff 标签里给，
          // 但对着图表找提交时行内直接可见更省事（形如 `a6d3521 · 提交信息`）。
          subject: `${c.hash.slice(0, 7)} · ${c.subject || ""}`,
          message: c.subject || "",
          author: c.author || "",
          timestamp: Number.isFinite(ts) ? ts : undefined,
          references: [...attached.values()],
        };
      });
      // 点开某条提交时 resolveHistoryItem 要能拿到完整信息，这里顺手缓存
      for (const item of items) itemCache.set(item.id, item);
      log(`[history] badges: ${items.map((item) => `${item.displayId}[${(item.references || []).map((ref) => ref.name).join("|")}]`).join(", ")}`);
      return items;
    },

    /** 点开某条提交时列出的文件变更：original 用父提交内容，modified 用本条提交内容 */
    async provideHistoryItemChanges(id, parentId, _token) {
      log(`[history] provideHistoryItemChanges(${String(id).slice(0, 7)}, ${parentId ? String(parentId).slice(0, 7) : "无"})`);
      const changes = await entry.git.commitChanges(entry.uri.path, id, parentId).catch((err) => {
        log(`[history] 变更读取失败：${(err && err.message) || err}`);
        return [];
      });
      log(`[history] 变更 ${changes.length} 个（root=${entry.root || "空"}）`);
      if (!entry.root) return [];
      return changes.map((c) => {
        const fileUri = vscode.Uri.joinPath(entry.uri, c.path);
        return {
          uri: fileUri,
          originalUri: parentId ? originalResourceOf(fileUri, entry.root, parentId, entry.uri.path, entry.workspacePrefix) : undefined,
          modifiedUri: originalResourceOf(fileUri, entry.root, id, entry.uri.path, entry.workspacePrefix),
        };
      });
    },

    async resolveHistoryItem(id, _token) {
      const item = itemCache.get(id);
      log(`[history] resolveHistoryItem(${String(id).slice(0, 7)}) → ${item ? "命中缓存" : "未命中"}`);
      return item || { id, parentIds: [], subject: "", message: "" };
    },
    async resolveHistoryItemChatContext(_id, _token) {
      return undefined;
    },
    async resolveHistoryItemChangeRangeChatContext(_id, _parentId, _path, _token) {
      return undefined;
    },
    async resolveHistoryItemRefsCommonAncestor(_historyItemRefs, _token) {
      return undefined;
    },

    /**
     * 仓库状态变化后通知图重新取数。
     * 注意 payload 不能是空的：工作台靠 modified/added/removed 判断“要不要重新拉历史”，
     * 空数组会被当成“没有变化”，提交完图就不刷新（内置 git 也是传真实 delta 的）。
     */
    refresh() {
      onDidChangeCurrentHistoryItemRefs.fire();
      onDidChangeHistoryItemRefs.fire({
        added: [],
        removed: [],
        modified: entry.headRef ? [entry.headRef] : [],
        silent: false,
      });
    },
  };
}

function createScmService(vscode, deps) {
  const { log, sessionOf } = deps;
  const entries = new Map(); // folderUriString -> entry
  let seq = 0;

  // 资源管理器着色：VS Code 的文件树颜色来自 FileDecorationProvider，内置 git 扩展靠它给
  // 改动/未跟踪文件上色。只有 SCM 面板里的 resourceStates.decorations 是不够的——那只管
  // Source Control 面板；资源管理器必须另外注册 provider（这正是之前「git 扫出来了但不着色」的原因）。
  const decorations = new Map();   // uriString -> vscode.FileDecoration
  const onDidChangeDecorations = new vscode.EventEmitter();
  const decorationProvider = vscode.window.registerFileDecorationProvider
    ? vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: onDidChangeDecorations.event,
        provideFileDecoration: (uri) => decorations.get(uri.toString()),
      })
    : undefined;

  /** 指定 ref 版本内容的虚拟文档（diff 左侧 + quick diff + 历史节点都要它），ref 缺省 HEAD。
   *  base/prefix 是 UI 工作区路径与 Git canonical root 的映射；/home → /robotdata 这类
   *  符号链接场景不能再拿 canonical root 直接和编辑器 URI 做前缀判断。 */
  const originalResourceOf = (uri, root, ref, base, prefix) =>
    vscode.Uri.from({
      scheme: GIT_SCHEME,
      authority: uri.authority,
      path: uri.path,
      query: `root=${encodeURIComponent(root)}`
        + `&base=${encodeURIComponent(base || uri.path)}`
        + `&prefix=${encodeURIComponent(prefix || "")}`
        + `${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`,
    });

  /** 文件字母 → 资源管理器装饰（颜色 + 徽标字母），对齐内置 git 扩展的观感 */
  const DECORATION_TABLE = {
    A: { color: "gitDecoration.addedResourceForeground", badge: "A" },
    M: { color: "gitDecoration.modifiedResourceForeground", badge: "M" },
    D: { color: "gitDecoration.deletedResourceForeground", badge: "D", strikeThrough: true },
    R: { color: "gitDecoration.renamedResourceForeground", badge: "R" },
    U: { color: "gitDecoration.untrackedResourceForeground", badge: "U" },
    "!": { color: "gitDecoration.ignoredResourceForeground", badge: "!" },
  };

  /** 状态刷新时重建整张装饰表：文件按字母上色，父目录按「有改动」继承色（内置 git 行为） */
  function rebuildDecorations(entry, snapshot, files) {
    const previousUris = entry.decoratedUris || [];
    for (const uri of previousUris) decorations.delete(uri.toString());
    const touched = [];
    const dirtyDirs = new Set();
    for (const f of files) {
      const table = DECORATION_TABLE[f.letter] || DECORATION_TABLE.M;
      const uri = vscode.Uri.joinPath(entry.uri, f.path);
      decorations.set(uri.toString(), new vscode.FileDecoration(
        table.badge, undefined, new vscode.ThemeColor(table.color),
      ));
      touched.push(uri);
      // 目录继承：DS_Store 之类的文件路径逐级往上，直到仓库根
      const root = (entry.root || entry.uri.path).replace(/\/+$/, "");
      let dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      while (dir) {
        dirtyDirs.add(dir);
        dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      }
      void root;
    }
    for (const dir of dirtyDirs) {
      const uri = vscode.Uri.joinPath(entry.uri, dir);
      decorations.set(uri.toString(), new vscode.FileDecoration(
        undefined, undefined, new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      ));
      touched.push(uri);
    }
    entry.decoratedUris = touched;
    // 旧 URI 也必须进入失效通知。提交全部改动后 touched 会变成空数组；只通知新列表时，
    // 工作台不会重新查询旧文件，资源管理器就会一直残留提交前的 M/U 着色。
    const changed = new Map();
    for (const uri of [...previousUris, ...touched]) changed.set(uri.toString(), uri);
    onDidChangeDecorations.fire([...changed.values()]);
  }

  function makeResource(entry, file, staged) {
    const uri = vscode.Uri.joinPath(entry.uri, file.path);
    const table = STATE_TABLE[file.letter] || STATE_TABLE.M;
    return {
      resourceUri: uri,
      command: {
        title: "打开更改",
        command: "vscode.diff",
        arguments: [originalResourceOf(uri, entry.root, undefined, entry.uri.path, entry.workspacePrefix), uri, `${file.path}（工作区 ↔ HEAD）`],
      },
      contextValue: staged ? "staged" : "unstaged",
      decorations: {
        color: new vscode.ThemeColor(table.color),
        strikeThrough: !!table.strikeThrough,
        faded: !!table.faded,
        tooltip: file.path,
      },
    };
  }

  async function refresh(entry) {
    try {
      const snapshot = await entry.git.treeStatus(entry.uri.path);
      entry.root = snapshot.root;
      entry.workspacePrefix = snapshot.workspacePrefix || "";
      entry.upstreamRef = snapshot.upstreamRef && snapshot.upstreamCommit
        ? {
            id: snapshot.upstreamRef,
            name: snapshot.upstreamRef.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, ""),
            revision: snapshot.upstreamCommit,
          }
        : undefined;
      // HEAD 变了（提交 / 切换分支 / 拉取）→ Quick Diff 的「原始版本」缓存必须失效，
      // 否则编辑器里还按旧 HEAD 算差异，标记会串位。
      if (entry.lastHeadCommit && snapshot.headCommit && entry.lastHeadCommit !== snapshot.headCommit) {
        clearOriginalContents();
      }
      if (snapshot.headCommit) entry.lastHeadCommit = snapshot.headCommit;
      // 原生 Source Control Graph 的“当前分支”（proposed API scmHistoryProvider）
      // headRef 也要带 revision：CodeOSS 用 historyItem.id === currentHistoryItemRef.revision
      // 判定哪条是 HEAD（决定图里 HEAD 标签与 outgoing 泳道）。snapshot 里没有 commit hash，
      // 用分支名 + 最近一次 log 的首条提交补齐（下面 refresh 时回填）。
      entry.headRef = snapshot.branch && snapshot.branch !== "HEAD"
        ? { id: `refs/heads/${snapshot.branch}`, name: snapshot.branch, revision: snapshot.headCommit || entry.headRef?.revision }
        : undefined;
      if (entry.historyProvider) entry.historyProvider.refresh();
      const { staged, unstaged } = splitStatus(snapshot);
      rebuildDecorations(entry, snapshot, [...staged, ...unstaged]);
      entry.sc.inputBox.placeholder = `提交信息（${snapshot.branch}）`;
      entry.staged.resourceStates = staged.map((f) => makeResource(entry, f, true));
      entry.changes.resourceStates = unstaged.map((f) => makeResource(entry, f, false));
      entry.sc.count = staged.length + unstaged.length;
      if (entry.sc.actionButton) {
        entry.sc.actionButton = { ...entry.sc.actionButton, enabled: entry.sc.count > 0 };
      }
      entry.sc.statusBarCommands = [
        {
          command: "rce.scm.commit",
          title: "$(check) 提交",
          tooltip: "提交已暂存的更改",
        },
        {
          command: "rce.scm.refresh",
          title: `$(sync) ${snapshot.branch}`,
          tooltip: "刷新远端仓库状态",
        },
      ];
      log(`SCM 刷新 ${snapshot.root}：${staged.length} 暂存 / ${unstaged.length} 工作区`);
    } catch (err) {
      log(`SCM 刷新失败：${err && err.message}`);
    }
  }

  /** 把单个仓库挂进 SCM 面板。rootPath 用于显示名与 quickDiff 边界 */
  async function attachRepo(session, uri, displayName) {
    const key = uri.toString();
    if (entries.has(key)) return;
    let info;
    try {
      info = await session.git.repoInfo(uri.path);
    } catch (err) {
      log(`SCM 探测 ${uri.path} 失败：${err && err.message}`);
      return;
    }
    if (!info.isRepository) return;
    log(`SCM 发现仓库 ${info.root || uri.path}（分支 ${info.branch || "?"}），挂到 Source Control`);

    seq += 1;
    const sc = vscode.scm.createSourceControl(`rce-sshfs-${seq}`, displayName, uri);
    sc.inputBox.placeholder = "提交信息";
    sc.acceptInputCommand = { command: "rce.scm.commit", title: "提交" };
    const staged = sc.createResourceGroup("staged", "暂存的更改");
    const changes = sc.createResourceGroup("changes", "更改");
    const entry = { uri, session, sc, staged, changes, git: session.git, root: "", timer: null };
    // 菜单/大按钮要把点击发生在哪个仓库传回来，多根工作区才不会操作到第一个仓库。
    const actionArguments = [sc];
    // 把远端 git 历史喂给工作台原生的 Source Control Graph（图表由 CodeOSS 画）
    entry.historyProvider = createHistoryProvider(vscode, entry, { log, originalResourceOf });
    sc.historyProvider = entry.historyProvider;
    // 原生“大提交按钮”（proposed API scmActionButton）：输入框下方那个绿色 ✓ ＋下拉菜单，
    // 渲染完全由 CodeOSS 负责，我们只声明它触发哪些命令。
    sc.actionButton = {
      command: { command: "rce.scm.commit", title: "提交", shortTitle: "提交", arguments: actionArguments },
      secondaryCommands: [
        [{ command: "rce.scm.commit", title: "提交", arguments: actionArguments }],
        [
          { command: "rce.scm.commitAmend", title: "提交（修改）", arguments: actionArguments },
          { command: "rce.scm.commitAndPush", title: "提交和推送", arguments: actionArguments },
        ],
      ],
      enabled: false,
    };
    sc.quickDiffProvider = {
      provideOriginalResource(uri) {
        if (!entry.root) return undefined;
        const base = entry.uri.path.replace(/\/+$/, "");
        if (uri.path !== base && !uri.path.startsWith(base + "/")) return undefined;
        return originalResourceOf(uri, entry.root, undefined, entry.uri.path, entry.workspacePrefix);
      },
    };
    entries.set(key, entry);
    await refresh(entry);
    // 远端可能在 IDE 之外被改（git 命令行 / 别人提交）：便宜的定时兜底
    entry.timer = setInterval(() => {
      refresh(entry).catch(() => {});
    }, 15000);
  }

  async function attach(folderUri) {
    const session = sessionOf(folderUri);
    if (!session) {
      log(`SCM attach 跳过：${folderUri.authority} 还没有会话`);
      return;
    }
    // 1) 工作区根本身是仓库 → 直接挂
    let rootInfo;
    try {
      rootInfo = await session.git.repoInfo(folderUri.path);
    } catch (err) {
      log(`SCM 探测工作区根 ${folderUri.path} 失败：${err && err.message}`);
      return;
    }
    if (rootInfo.isRepository) {
      await attachRepo(session, folderUri, `SSH（${session.authority}）`);
      return;   // 整个工作区一个仓库，不再向下找
    }
    // 2) monorepo / 源码树布局：向下找两层独立 git 仓库（ROS2 常见 src/<pkg> 各一个仓库；
    //    也有 <ws>/src 本身一个仓库的情况）。深度 2 + 每层最多 64 项，成本有界。
    let topNames = [];
    try {
      topNames = (await session.fs.listDir(folderUri.path)).filter((e) => e.isDir).map((e) => e.name);
    } catch (err) {
      log(`SCM 列目录 ${folderUri.path} 失败：${err && err.message}`);
      return;
    }
    let found = 0;
    for (const name of topNames.slice(0, 64)) {
      const childUri = vscode.Uri.from({ scheme: folderUri.scheme, authority: folderUri.authority, path: `${folderUri.path.replace(/\/+$/, "")}/${name}` });
      let childInfo;
      try {
        childInfo = await session.git.repoInfo(childUri.path);
      } catch { continue; }
      if (childInfo.isRepository) {
        await attachRepo(session, childUri, `SSH（${session.authority} · ${name}）`);
        found += 1;
        continue;
      }
      // 第 2 层：只对有子目录的一级目录再探一次
      let subNames = [];
      try {
        subNames = (await session.fs.listDir(childUri.path)).filter((e) => e.isDir).map((e) => e.name);
      } catch { continue; }
      for (const sub of subNames.slice(0, 64)) {
        const grandUri = vscode.Uri.from({ scheme: folderUri.scheme, authority: folderUri.authority, path: `${childUri.path}/${sub}` });
        let grandInfo;
        try {
          grandInfo = await session.git.repoInfo(grandUri.path);
        } catch { continue; }
        if (grandInfo.isRepository) {
          await attachRepo(session, grandUri, `SSH（${session.authority} · ${name}/${sub}）`);
          found += 1;
        }
      }
    }
    log(found > 0 ? `SCM 完成：发现 ${found} 个子仓库` : `SCM 完成：${folderUri.path} 下未发现 Git 仓库（git 可用性与权限正常？）`);
  }

  /** 命令参数（单个资源状态 / 数组 / 资源组）→ 远端绝对路径列表 */
  function resolvePaths(args) {
    const flat = Array.isArray(args) ? args.flat(3) : [args];
    const out = [];
    for (const a of flat) {
      if (!a) continue;
      if (a.resourceUri) out.push(a.resourceUri);
      else if (a.resourceStates) out.push(...a.resourceStates.map((r) => r.resourceUri));
      else if (a instanceof vscode.Uri) out.push(a);
    }
    return out;
  }

  function entryOf(uri) {
    for (const entry of entries.values()) {
      const base = (entry.uri.path || "/").replace(/\/+$/, "");
      if (uri.path === base || uri.path.startsWith(base + "/")) return entry;
    }
    return undefined;
  }

  /** 一批资源 → 按仓库归组 → 执行远端 git → 刷新 SCM */
  async function runOnResources(args, fn) {
    const byEntry = new Map();
    for (const uri of resolvePaths(args)) {
      const entry = entryOf(uri);
      if (!entry) continue;
      const root = entry.root.replace(/\/+$/, "");
      const rel = uri.path === root ? "." : uri.path.slice(root.length + 1);
      byEntry.set(entry, [...(byEntry.get(entry) || []), rel]);
    }
    for (const [entry, paths] of byEntry) {
      await fn(entry, paths);
      await refresh(entry);
    }
    return byEntry.size;
  }

  /** diff / quick diff / 历史节点的内容：远端 `git show <ref>:<rel>`，ref 缺省 HEAD */
  /**
   * `rce-git:` 只读虚拟文件系统。
   *
   * 为什么要 FS Provider 而不是 TextDocumentContentProvider：内置 git 扩展正是给 `git:` 注册了
   * FileSystemProvider（GitFileSystemProvider），Quick Diff（gutter / 概览标尺 / minimap 改动标记）
   * 才能把「原始版本」当成普通文件解析、同步给 diff worker。只注册文本内容提供器时，模型会落到
   * 「虚拟文档」分支，diff worker 拿不到内容 → 三个位置的改动标记全部不显示。
   * 我们此前正是这种情况：资源管理器着色正常（FileDecoration），但编辑器里没有任何改动标记。
   */
  const originalFileContents = new Map();   // uriString -> string
  const onDidChangeOriginalFile = new vscode.EventEmitter();

  async function originalContentOf(uri) {
    const key = uri.toString();
    if (originalFileContents.has(key)) return originalFileContents.get(key);
    log(`[quickdiff] 读取原始版本 ${uri.toString()}`);
    const text = await provideOriginalContent(uri);
    originalFileContents.set(key, text);
    return text;
  }

  function clearOriginalContents() {
    if (originalFileContents.size === 0) return;
    const changed = [...originalFileContents.keys()].map((value) => vscode.Uri.parse(value));
    originalFileContents.clear();
    onDidChangeOriginalFile.fire(changed.map((uri) => ({ type: vscode.FileChangeType.Changed, uri })));
  }

  function createOriginalFileSystemProvider() {
    return {
      onDidChangeFile: onDidChangeOriginalFile.event,
      watch() { return { dispose() { /* 原始版本不可变，无需监听 */ } }; },
      async stat(uri) {
        const text = await originalContentOf(uri);
        const size = Buffer.byteLength(text, "utf8");
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size };
      },
      async readFile(uri) {
        const text = await originalContentOf(uri);
        return Buffer.from(text, "utf8");
      },
      async readDirectory() {
        throw vscode.FileSystemError.FileNotADirectory("rce-git 是只读虚拟文件系统");
      },
      async writeFile() { throw vscode.FileSystemError.NoPermissions("rce-git 只读"); },
      async delete() { throw vscode.FileSystemError.NoPermissions("rce-git 只读"); },
      async rename() { throw vscode.FileSystemError.NoPermissions("rce-git 只读"); },
      async createDirectory() { throw vscode.FileSystemError.NoPermissions("rce-git 只读"); },
    };
  }

  async function provideOriginalContent(uri) {
    const params = new URLSearchParams(uri.query || "");
    const root = params.get("root") || "";
    const base = (params.get("base") || root).replace(/\/+$/, "");
    const prefix = (params.get("prefix") || "").replace(/^\/+|\/+$/g, "");
    const ref = params.get("ref") || "HEAD";
    const session = sessionOf(uri.authority);
    if (!session || !root) return "";
    let rel = "";
    if (base && uri.path !== base) {
      if (!uri.path.startsWith(base + "/")) return "";
      rel = uri.path.slice(base.length + 1);
    }
    if (prefix) rel = rel ? `${prefix}/${rel}` : prefix;
    if (!rel) return "";
    const { shellQuote } = require("./fs-provider.js");
    const r = await session.conn.exec(`git show ${shellQuote(`${ref}:${rel}`)}`, { cwd: root, timeoutMs: 20000 });
    if (r.code !== 0) return "";   // 新文件 / 未跟踪 / 该 ref 下不存在：左侧就是空的
    log(`[quickdiff] git show ${ref}:${rel} → ${Buffer.byteLength(r.stdout, "utf8")} 字节`);
    return r.stdout;
  }

  return {
    attach,
    provideOriginalContent,
    createOriginalFileSystemProvider,
    entries,
    runOnResources,
    resolvePaths,
    entryOf,
    refreshAll: () => Promise.all([...entries.values()].map((e) => refresh(e))),
    /** 会话断开时全部解绑：旧 entry 持有死会话的 git 门面，不卸掉的话刷新会一直报错；
     *  重连成功后 attachFolders 会重新 attach。 */
    detachAll() {
      for (const e of entries.values()) {
        if (e.timer) clearInterval(e.timer);
        try { e.sc.dispose(); } catch { /* 已释放 */ }
      }
      entries.clear();
    },
    dispose() {
      for (const e of entries.values()) if (e.timer) clearInterval(e.timer);
      entries.clear();
      clearOriginalContents();
      try { decorationProvider?.dispose(); } catch { /* 已释放 */ }
      try { onDidChangeOriginalFile.dispose(); } catch { /* 已释放 */ }
      onDidChangeDecorations.dispose();
    },
  };
}

module.exports = { createScmService, GIT_SCHEME };
