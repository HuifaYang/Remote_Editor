// sshfs:// FileSystemProvider：把我们自己的 SSH/SFTP 层接到 VSCode 的文件系统契约上。
//
// 两个和编辑器语义强相关的关键点（Q1 验证中实测到的，别改坏）：
//   1) 读/写必须**字节保真**：不能走 RemoteFs.readFile/saveFile（那两个是按文本解码 + 换行归一化的，
//      给自研外壳的文本编辑器用）。这里直接走原始 SFTP 流，编码/换行由 VSCode 自己管。
//   2) 错误必须映射成 vscode.FileSystemError：VSCode 的 createDirectory 会先 stat，
//      **只把 FileNotFound 当正常**，其它错误直接抛给用户。
"use strict";

/** 远端路径 = URI 的 path 部分（authority 只承载 user@host:port 用于选会话） */
function remotePath(uri) {
  return uri.path && uri.path.length > 1 ? uri.path : "/";
}

function createSshfsProvider(vscode, deps) {
  const { log, sessionOf } = deps;

  /** 一个 provider 要服务所有 authority，所以每次调用都按 URI 找会话。
   *  **会话还在连的时候要等它**：工作台在窗口恢复阶段就来读工作区配置 / 问 `.vscode` 在不在，
   *  立刻抛 Unavailable 会让它认定"读不到"并且不再重试（远端 settings.json 不生效、snippet 初始化卡死 → 补全一直 Loading）。
   *  见 docs/ssh-vs-remotessh.md §5.4。 */
  const CONNECT_WAIT_MS = 15000;
  const requireSession = async (uri) => {
    const session = deps.whenSession
      ? await deps.whenSession(uri, CONNECT_WAIT_MS)
      : sessionOf(uri);
    if (!session) throw vscode.FileSystemError.Unavailable(`没有到 ${uri.authority} 的 SSH 会话（请先执行「连接到远程主机」）`);
    return session;
  };

  const onDidChangeFile = new vscode.EventEmitter();
  const pollMs = Math.max(1000, Number(deps.pollMs || 3000));
  const recursivePollMs = Math.max(pollMs, Number(deps.recursivePollMs || 8000));
  const maxWatchDirs = Number(deps.maxWatchDirs || 200);

  // 把我们的 AppError（带 code/sftpCode）翻译成 VSCode 的错误类型
  const fail = (err, uri) => {
    const code = err && err.code;
    const sftpCode = err && err.sftpCode;
    const msg = (err && err.message) || String(err);
    if (code === "not-found" || sftpCode === 2) return vscode.FileSystemError.FileNotFound(uri);
    if (code === "timeout") return vscode.FileSystemError.Unavailable(`远端超时：${msg}`);
    if (sftpCode === 3 || /permission denied|EACCES|权限不足/i.test(msg)) return vscode.FileSystemError.NoPermissions(uri);
    if (/already exists|EEXIST|File exists/i.test(msg)) return vscode.FileSystemError.FileExists(uri);
    if (code === "unsupported") return vscode.FileSystemError.Unavailable(msg);
    return vscode.FileSystemError.Unavailable(msg);
  };

  const typeOf = (e) =>
    e.isDir ? vscode.FileType.Directory
      : e.isSymlink ? vscode.FileType.SymbolicLink
        : vscode.FileType.File;

  // ---- 原始字节读写（编辑器路径） ----
  function readBytes(session, p) {
    return session.conn.sftpRun((sftp) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        const stream = sftp.createReadStream(p);
        stream.on("data", (c) => chunks.push(c));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
      }),
    );
  }

  /** 原子写（§5.2.1）：同目录临时文件 → rename 覆盖。字节原样落盘，不做换行/编码转换。 */
  async function writeBytes(session, p, bytes) {
    const conn = session.conn;
    const tmp = `${p}.rce-tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await conn.sftpRun((sftp) =>
      new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(tmp);
        stream.on("error", reject);
        stream.on("close", () => resolve());
        stream.end(Buffer.from(bytes));
      }),
    ).catch((err) => {
      throw err;
    });
    try {
      await conn.sftpRun((sftp) =>
        new Promise((resolve, reject) => {
          sftp.rename(tmp, p, (err) => (err ? reject(err) : resolve()));
        }),
      );
    } catch (err) {
      // 失败要把临时文件清掉，别在用户仓库里留垃圾
      await conn.sftpRun((sftp) => new Promise((res) => sftp.unlink(tmp, () => res()))).catch(() => {});
      throw err;
    }
  }

  // ---- 轮询监听 ----
  // 说明：SFTP 没有 inotify，远端也不允许常驻服务，所以「外部改动」只能轮询。
  //   · 非递归（资源管理器逐个目录打开时）：每轮 1 次 readdir，带 size/mtime，能发现改名/改内容
  //   · 递归（git / TS 扩展要的整树监听）：一条 `find` 命令拿全树名字，只能发现增删
  const watched = new Map(); // 目录远端路径 -> { uri, options, signature, timer }

  async function signatureOf(session, dirPath, recursive) {
    if (recursive) {
      const r = await session.conn.exec(
        `cd ${shellQuote(dirPath)} && find . -mindepth 1 2>/dev/null | head -n 20000`,
        { timeoutMs: 20000 },
      );
      if (r.code !== 0) return null;
      return r.stdout;
    }
    const list = await session.fs.listDir(dirPath);
    return list.map((e) => `${e.name}|${typeOf(e)}|${e.size}|${e.mtime}`).join("\n");
  }

  /** 快照对比 → 变更事件；已存在条目比对 size/mtime，新条目 = Created，消失条目 = Deleted */
  function diffToEvents(prev, next, dirPath) {
    const parse = (text) => {
      const map = new Map();
      for (const line of String(text).split("\n")) {
        if (!line) continue;
        const i = line.indexOf("|");
        map.set(i < 0 ? line : line.slice(0, i), i < 0 ? "" : line.slice(i + 1));
      }
      return map;
    };
    const a = parse(prev);
    const b = parse(next);
    const events = [];
    for (const [name, rest] of b) {
      if (!a.has(name)) events.push({ type: vscode.FileChangeType.Created, uri: childUri(dirPath, name) });
      else if (a.get(name) !== rest) events.push({ type: vscode.FileChangeType.Changed, uri: childUri(dirPath, name) });
    }
    for (const name of a.keys()) {
      if (!b.has(name)) events.push({ type: vscode.FileChangeType.Deleted, uri: childUri(dirPath, name) });
    }
    return events;
  }

  function childUri(dirPath, name) {
    const uri = watched.get(dirPath)?.uri;
    const base = uri || vscode.Uri.parse(`${SCHEME}:///`);
    return vscode.Uri.joinPath(base, name);
  }

  /** 自己动过的目录立刻重读一次快照（吞掉自己造成的“外部变更”，避免编辑器弹出磁盘冲突） */
  async function resync(dirPath) {
    const w = watched.get(dirPath);
    if (!w) return;
    try {
      w.signature = await signatureOf(await requireSession(w.uri), dirPath, w.options.recursive);
    } catch {
      /* 忽略：下一轮轮询再算 */
    }
  }

  async function resyncParents(p) {
    const dir = p.replace(/\/[^/]*$/, "") || "/";
    await resync(dir);
  }

  const provider = {
    onDidChangeFile: onDidChangeFile.event,

    watch(uri, options) {
      const dirPath = remotePath(uri);
      const existing = watched.get(dirPath);
      if (existing) {
        clearInterval(existing.timer);
        watched.delete(dirPath);
      }
      if (watched.size >= maxWatchDirs) {
        // 目录太多就放弃轮询（VSCode 会退回“假装没变化”），避免把板子打爆
        log(`监听目录数超过上限 ${maxWatchDirs}，跳过 ${dirPath}`);
        return { dispose() {} };
      }
      const entry = { uri, options: { recursive: !!options.recursive }, signature: null, timer: null };
      watched.set(dirPath, entry);
      const interval = entry.options.recursive ? recursivePollMs : pollMs;
      entry.timer = setInterval(async () => {
        try {
          const next = await signatureOf(await requireSession(uri), dirPath, entry.options.recursive);
          if (next === null) return;
          if (entry.signature === null) {
            entry.signature = next;
            return;
          }
          if (next === entry.signature) return;
          const events = diffToEvents(entry.signature, next, dirPath);
          entry.signature = next;
          if (events.length) onDidChangeFile.fire(events);
        } catch {
          /* 目录没了 / 连接断了：安静等下一轮，反复报错没意义 */
        }
      }, interval);
      return {
        dispose() {
          const w = watched.get(dirPath);
          if (w?.timer) clearInterval(w.timer);
          if (watched.get(dirPath) === entry) watched.delete(dirPath);
        },
      };
    },

    async stat(uri) {
      const p = remotePath(uri);
      try {
        const e = await (await requireSession(uri)).fs.stat(p);
        return {
          type: typeOf(e),
          ctime: 0,                      // SFTPv3 不保证 ctime，VSCode 只拿它展示
          mtime: (e.mtime || 0) * 1000,  // ssh2 的 mtime 是秒，VSCode 要毫秒
          size: e.size || 0,
        };
      } catch (err) {
        throw fail(err, uri);
      }
    },

    async readDirectory(uri) {
      const p = remotePath(uri);
      try {
        const list = await (await requireSession(uri)).fs.listDir(p);
        return list.map((e) => [e.name, typeOf(e)]);
      } catch (err) {
        throw fail(err, uri);
      }
    },

    async readFile(uri) {
      try {
        return await readBytes(await requireSession(uri), remotePath(uri));
      } catch (err) {
        throw fail(err, uri);
      }
    },

    async writeFile(uri, content, opts) {
      const p = remotePath(uri);
      const session = await requireSession(uri);
      try {
        if (opts && opts.create) {
          // VSCode 要求 create=true 时文件必须不存在
          const exists = await session.fs.exists(p).catch(() => false);
          if (exists) throw vscode.FileSystemError.FileExists(uri);
        }
        if (opts && opts.overwrite === false) {
          const exists = await session.fs.exists(p).catch(() => false);
          if (exists) throw vscode.FileSystemError.FileExists(uri);
        }
        await writeBytes(session, p, content);
        await resyncParents(p);
      } catch (err) {
        if (err instanceof vscode.FileSystemError) throw err;
        throw fail(err, uri);
      }
    },

    async delete(uri, options) {
      const p = remotePath(uri);
      const session = await requireSession(uri);
      try {
        const e = await session.fs.stat(p);
        if (e.isDir && !(options && options.recursive)) {
          throw vscode.FileSystemError.NoPermissions("目录需要递归删除");
        }
        await session.fs.remove(p);
        await resyncParents(p);
      } catch (err) {
        if (err instanceof vscode.FileSystemError) throw err;
        throw fail(err, uri);
      }
    },

    async rename(oldUri, newUri, options) {
      const from = remotePath(oldUri);
      const to = remotePath(newUri);
      const session = await requireSession(oldUri);
      try {
        if (options && options.overwrite === false) {
          const exists = await session.fs.exists(to).catch(() => false);
          if (exists) throw vscode.FileSystemError.FileExists(newUri);
        }
        await session.fs.rename(from, to);
        await resyncParents(from);
        await resyncParents(to);
      } catch (err) {
        if (err instanceof vscode.FileSystemError) throw err;
        throw fail(err, oldUri);
      }
    },

    async createDirectory(uri) {
      const p = remotePath(uri);
      const session = await requireSession(uri);
      try {
        await session.fs.createDir(p);
        await resyncParents(p);
      } catch (err) {
        throw fail(err, uri);
      }
    },

    dispose() {
      for (const w of watched.values()) if (w.timer) clearInterval(w.timer);
      watched.clear();
      onDidChangeFile.dispose();
    },
  };

  // 调试用（RCE_SPIKE_TRACE=1）：把渲染进程/编辑器来的每一次文件操作都记下来。
  // 排查「工作台在等某个请求永远不返回」这类问题时，先看请求有没有到达我们这一层。
  if (process.env.RCE_SPIKE_TRACE) {
    for (const name of ["stat", "readDirectory", "readFile", "writeFile", "delete", "rename", "createDirectory", "watch"]) {
      const orig = provider[name];
      if (typeof orig !== "function") continue;
      provider[name] = function (uri, ...rest) {
        const t0 = Date.now();
        log(`[FS] ${name}( ) 进入 ${uri && uri.path}`);
        const r = orig.apply(this, [uri, ...rest]);
        if (r && typeof r.then === "function") {
          r.then(
            () => log(`[FS] ${name} 完成 ${Date.now() - t0}ms ${uri && uri.path}`),
            (e) => log(`[FS] ${name} 失败 ${Date.now() - t0}ms ${uri && uri.path}：${e && e.message}`),
          );
        } else {
          log(`[FS] ${name} 同步返回 ${Date.now() - t0}ms ${uri && uri.path}`);
        }
        return r;
      };
    }
  }

  return provider;
}

/** 远端 shell 安全引号：整串单引号包裹，内部单引号拆开（与 src/shared/paths.ts 的 shellQuote 同语义） */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const SCHEME = "sshfs";

module.exports = { createSshfsProvider, SCHEME, remotePath, shellQuote };
