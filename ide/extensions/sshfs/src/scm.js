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

function createScmService(vscode, deps) {
  const { log, sessionOf } = deps;
  const entries = new Map(); // folderUriString -> entry
  let seq = 0;

  /** HEAD 版本内容的虚拟文档（diff 左侧 + quick diff 都要它） */
  const originalResourceOf = (uri, root) =>
    vscode.Uri.from({
      scheme: GIT_SCHEME,
      authority: uri.authority,
      path: uri.path,
      query: `root=${encodeURIComponent(root)}`,
    });

  function makeResource(entry, file, staged) {
    const uri = vscode.Uri.joinPath(entry.uri, file.path);
    const table = STATE_TABLE[file.letter] || STATE_TABLE.M;
    return {
      resourceUri: uri,
      command: {
        title: "打开更改",
        command: "vscode.diff",
        arguments: [originalResourceOf(uri, entry.root), uri, `${file.path}（工作区 ↔ HEAD）`],
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
      const { staged, unstaged } = splitStatus(snapshot);
      entry.sc.inputBox.placeholder = `提交信息（${snapshot.branch}）`;
      entry.staged.resourceStates = staged.map((f) => makeResource(entry, f, true));
      entry.changes.resourceStates = unstaged.map((f) => makeResource(entry, f, false));
      entry.sc.count = staged.length + unstaged.length;
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

  async function attach(folderUri) {
    const key = folderUri.toString();
    if (entries.has(key)) return;
    const session = sessionOf(folderUri);
    if (!session) return;
    const info = await session.git.repoInfo(folderUri.path).catch(() => ({ isRepository: false }));
    if (!info.isRepository) return;

    seq += 1;
    const sc = vscode.scm.createSourceControl(`rce-sshfs-${seq}`, `SSH（${session.authority}）`, folderUri);
    sc.inputBox.placeholder = "提交信息";
    sc.acceptInputCommand = { command: "rce.scm.commit", title: "提交" };
    const staged = sc.createResourceGroup("staged", "暂存的更改");
    const changes = sc.createResourceGroup("changes", "更改");
    const entry = { uri: folderUri, session, sc, staged, changes, git: session.git, root: "", timer: null };
    sc.quickDiffProvider = {
      provideOriginalResource(uri) {
        if (!entry.root) return undefined;
        const root = entry.root.replace(/\/+$/, "");
        if (uri.path !== root && !uri.path.startsWith(root + "/")) return undefined;
        return originalResourceOf(uri, entry.root);
      },
    };
    entries.set(key, entry);
    await refresh(entry);
    // 远端可能在 IDE 之外被改（git 命令行 / 别人提交）：便宜的定时兜底
    entry.timer = setInterval(() => {
      refresh(entry).catch(() => {});
    }, 15000);
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

  /** diff/quick diff 的左侧内容：远端 `git show HEAD:<rel>` */
  async function provideOriginalContent(uri) {
    const root = decodeURIComponent((uri.query || "").replace(/^root=/, ""));
    const session = sessionOf(uri.authority);
    if (!session) return "";
    const rel = uri.path === root ? "" : uri.path.slice(root.replace(/\/+$/, "").length + 1);
    if (!rel) return "";
    const { shellQuote } = require("./fs-provider.js");
    const r = await session.conn.exec(`git show HEAD:${shellQuote(rel)}`, { cwd: root, timeoutMs: 20000 });
    if (r.code !== 0) return "";   // 新文件 / 未跟踪：左侧就是空的
    return r.stdout;
  }

  return {
    attach,
    provideOriginalContent,
    entries,
    runOnResources,
    resolvePaths,
    entryOf,
    refreshAll: () => Promise.all([...entries.values()].map((e) => refresh(e))),
    dispose() {
      for (const e of entries.values()) if (e.timer) clearInterval(e.timer);
      entries.clear();
    },
  };
}

module.exports = { createScmService, GIT_SCHEME };
