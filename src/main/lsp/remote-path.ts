// 远端 LSP 的路径归一到 workspace 命名空间：服务端可能把软链接解析成真实路径，
// 编辑器侧始终使用工作区打开时看到的路径，避免跳转/诊断落到一个不存在的 URI。
import * as path from "node:path";

export function normalizeRemotePath(value: string): string {
  let normalized = String(value || "/").replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  normalized = path.posix.normalize(normalized).replace(/\/+$/, "");
  return normalized || "/";
}

export function pathWithin(path: string, root: string): boolean {
  const p = normalizeRemotePath(path);
  const r = normalizeRemotePath(root);
  return r === "/" || p === r || p.startsWith(`${r}/`);
}

export function relativeToRoot(path: string, root: string): string | null {
  const p = normalizeRemotePath(path);
  const r = normalizeRemotePath(root);
  if (p === r) return "";
  if (r === "/") return p.slice(1);
  if (!p.startsWith(`${r}/`)) return null;
  return p.slice(r.length + 1);
}

/** 服务端路径 → 工作区可见路径。真实路径别名优先，否则原样保留（系统头文件等外部文件）。 */
export function mapServerPathToWorkspace(serverPath: string, workspaceRoot: string, realWorkspaceRoot?: string): string {
  const path = normalizeRemotePath(serverPath);
  const root = normalizeRemotePath(workspaceRoot);
  const aliases = [realWorkspaceRoot, root].filter((item): item is string => !!item);
  for (const alias of aliases) {
    const relative = relativeToRoot(path, alias);
    if (relative === null) continue;
    return relative ? `${root === "/" ? "" : root}/${relative}` : root;
  }
  return path;
}

/** 工作区可见路径 → 服务端真实路径；用于软链接项目匹配 compile_commands.json。 */
export function mapWorkspacePathToServer(documentPath: string, workspaceRoot: string, realWorkspaceRoot?: string): string {
  const path = normalizeRemotePath(documentPath);
  const root = normalizeRemotePath(workspaceRoot);
  if (!realWorkspaceRoot) return path;
  const real = normalizeRemotePath(realWorkspaceRoot);
  if (real === root) return path;
  const relative = relativeToRoot(path, root);
  return relative === null ? path : relative ? `${real === "/" ? "" : real}/${relative}` : real;
}

/** 编辑器文档路径 → 发给服务端的工作路径。 */
export function mapDocumentPathToServer(documentPath: string): string {
  return normalizeRemotePath(documentPath);
}
