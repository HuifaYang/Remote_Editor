// 远端路径规范化（分册 1 · A1）：纯函数，无 IO

/** 规范化远端路径：去空白、`~` 展开、相对路径补 home、折叠 `.`/`..`、去尾斜杠 */
export function normalizeRemotePath(path: string, home: string): string {
  const base = home.replace(/\/+$/, "");
  let raw = path.trim();
  if (raw === "" || raw === "~") return base || "/";
  if (raw.startsWith("~/")) raw = base + raw.slice(1);
  if (!raw.startsWith("/")) raw = (base || "") + "/" + raw;
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop(); // `..` 超出根时停在 `/`
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** shell 单引号包裹：内部 `'` 替换为 `'\''`（A1 附加函数；所有发往远端的参数必须过它） */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** posix 风格的 dirname（远端路径一律 posix，不能用 node:path 的 win32 行为） */
export function remoteDirname(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

/** posix 风格的 basename */
export function remoteBasename(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
