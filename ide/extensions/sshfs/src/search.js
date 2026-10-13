// 搜索：把 VSCode 的「快速打开」和「在文件中查找」接到远端。
//
// 为什么必须自己接：内置搜索只给 file: 注册了 provider（searchService.ts 里只 registerSearchResultProvider
// (Schemas.file, ...)），虚拟工作区下没有 provider 就永远搜不到东西。
// 这两个 API 是 proposed（fileSearchProvider / textSearchProvider），要在扩展清单里声明 enabledApiProposals，
// 并在产物 product.json 的 extensionEnabledApiProposals 里放行（apply-branding.mjs 负责写）。
"use strict";

const { shellQuote } = require("./fs-provider.js");

const LIST_CACHE_TTL_MS = 15000;
const LIST_CAP = 20000;

/** 子序列模糊匹配（VSCode 自己还会再打分排序，这里只做粗筛，避免回传两万条） */
function fuzzyMatch(pattern, target) {
  if (!pattern) return true;
  const p = pattern.toLowerCase();
  const t = target.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === p[i]) i++;
    if (i === p.length) return true;
  }
  return false;
}

function createSearchProviders(vscode, deps) {
  const { log, sessionFor } = deps;
  const listCache = new Map(); // folderKey -> { at, files: string[] }

  async function listFiles(folderUri) {
    const key = folderUri.toString();
    const hit = listCache.get(key);
    if (hit && Date.now() - hit.at < LIST_CACHE_TTL_MS) return hit.files;
    const session = sessionFor(folderUri);
    if (!session) throw new Error("没有可用的远端会话");
    const dir = folderUri.path || "/";
    const r = await session.conn.exec(
      `cd ${shellQuote(dir)} && find . -mindepth 1 -type f ` +
        `! -path './.git/*' ! -path './node_modules/*' ! -path './build/*' ! -path './install/*' ` +
        `! -path './__pycache__/*' 2>/dev/null | head -n ${LIST_CAP}`,
      { timeoutMs: 30000 },
    );
    if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || "远端目录列举失败");
    const files = r.stdout
      .split("\n")
      .map((s) => s.replace(/^\.\//, "").trim())
      .filter(Boolean);
    listCache.set(key, { at: Date.now(), files });
    log(`远端文件清单：${dir} → ${files.length} 个文件`);
    return files;
  }

  const fileSearchProvider = {
    async provideFileSearchResults(query, options, _token) {
      const folder = options.folder;
      const files = await listFiles(folder);
      const max = options.maxResults || 2000;
      const out = [];
      for (const rel of files) {
        if (out.length >= max) break;
        if (fuzzyMatch(query.pattern, rel)) out.push(vscode.Uri.joinPath(folder, rel));
      }
      return out;
    },
  };

  /** grep 只给行号和行内容，不给列：这里补算匹配列（正则在结果行里再跑一遍） */
  function matchSpan(text, pattern, isRegExp, isCaseSensitive) {
    if (!pattern) return null;
    try {
      if (isRegExp) {
        const re = new RegExp(pattern, isCaseSensitive ? "" : "i");
        const m = re.exec(text);
        return m ? { start: m.index, end: m.index + m[0].length } : null;
      }
      const hay = isCaseSensitive ? text : text.toLowerCase();
      const needle = isCaseSensitive ? pattern : pattern.toLowerCase();
      const idx = hay.indexOf(needle);
      return idx < 0 ? null : { start: idx, end: idx + pattern.length };
    } catch {
      return null;
    }
  }

  const textSearchProvider = {
    async provideTextSearchResults(query, options, progress, token) {
      const folder = options.folder;
      const session = sessionFor(folder);
      if (!session) return { limitHit: false, message: "没有可用的远端会话" };
      const matches = await session.search.search(folder.path || "/", query.pattern, {
        caseSensitive: !!query.isCaseSensitive,
        regex: !!query.isRegExp,
      });
      let reported = 0;
      for (const m of matches) {
        if (token.isCancellationRequested) break;
        if (reported >= (options.maxResults || 500)) break;
        const span = matchSpan(m.text, query.pattern, query.isRegExp, query.isCaseSensitive);
        const raw = m.path;
        const rel = raw.startsWith((folder.path || "/").replace(/\/+$/, "") + "/")
          ? raw.slice((folder.path || "/").replace(/\/+$/, "").length + 1)
          : raw.replace(/^\/+/, "");
        const uri = vscode.Uri.joinPath(folder, rel);
        const line = Math.max(0, m.line - 1);
        const range = new vscode.Range(
          line, span ? span.start : 0,
          line, span ? span.end : m.text.length,
        );
        const previewRange = new vscode.Range(0, span ? span.start : 0, 0, span ? span.end : m.text.length);
        progress.report({ uri, ranges: [range], preview: { text: m.text, matches: [previewRange] } });
        reported++;
      }
      return { limitHit: matches.length >= 500 };
    },
  };

  return { fileSearchProvider, textSearchProvider };
}

module.exports = { createSearchProviders, fuzzyMatch };
