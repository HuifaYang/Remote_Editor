// 资源管理器（分册 2 U2）：单列树、懒加载 + 缓存 + 预取、徽标、右键菜单
import type { GitTreeStatus, RemoteEntry } from "../../shared/types.js";
import { icon } from "../app/icons.js";
import { TreeCache } from "../app/tree-cache.js";
import { confirmDialog, promptDialog, showMessage } from "./dialogs/index.js";
import { emptyState, openContextMenu, uiIconButton } from "./ui.js";

export interface ExplorerOptions {
  body: HTMLElement;
  header: HTMLElement;
  onOpenFile: (path: string) => void;
  onOpenFolder?: () => void;
}

export class Explorer {
  private readonly cache = new TreeCache({ list: (p) => window.api.fs.listDir(p) });
  private root = "";
  private entries = new Map<string, RemoteEntry[]>();     // 每层已加载的子项
  private expanded = new Set<string>();
  private status: GitTreeStatus | null = null;
  private loading = new Set<string>();

  constructor(private readonly opts: ExplorerOptions) {
    this.buildHeader();
    this.render();
  }

  setWorkspace(workspace: string, entries: RemoteEntry[], status: GitTreeStatus | null): void {
    this.root = workspace;
    this.status = status;
    this.entries.clear();
    this.expanded.clear();
    this.entries.set(workspace, entries);
    this.cache.invalidate();
    this.cache.prefetch(entries);
    this.render();
  }

  setStatus(status: GitTreeStatus | null): void {
    this.status = status;
    this.render();
  }

  async refresh(dir?: string): Promise<void> {
    const target = dir ?? this.root;
    this.cache.invalidateTree(target);
    if (!target || !this.root) { this.render(); return; }
    const list = target === this.root ? null : await window.api.fs.listDir(target);
    if (list) this.entries.set(target, list);
    else {
      const fresh = await window.api.fs.listDir(this.root);
      this.entries.set(this.root, fresh);
      for (const key of [...this.expanded]) this.entries.delete(key);
    }
    this.render();
  }

  private gitLabelFor(path: string): string {
    const file = this.status?.files[path];
    if (file) {
      const label: Record<string, string> = { A: "已新增 [A]", M: "已修改 [M]", D: "已删除 [D]", R: "已重命名 [R]", U: "未跟踪 [U]" };
      return label[file.letter] ?? file.letter;
    }
    const dir = this.status?.dirs[path];
    if (dir) {
      const label: Record<string, string> = { A: "新增目录 [A]", M: "已修改 [M]", D: "已删除 [D]" };
      return label[dir] ?? dir;
    }
    return "未变更";
  }

  private tooltipFor(entry: RemoteEntry): string {
    return [
      entry.path,
      `类型: ${entry.isDir ? "目录" : "文件"}`,
      `大小: ${formatBytes(entry.size)}`,
      `修改时间: ${new Date(entry.mtime * 1000).toLocaleString()}`,
      `权限: ${formatMode(entry.mode)}`,
      `Git: ${this.gitLabelFor(entry.path)}`,
    ].join("\n");
  }

  private buildHeader(): void {
    const actions: Array<[string, string, () => void]> = [
      ["new-file", "新建文件", () => void this.createEntry(false)],
      ["new-folder", "新建文件夹", () => void this.createEntry(true)],
      ["refresh", "刷新", () => void this.refresh()],
      ["collapse-all", "折叠全部", () => { this.expanded.clear(); this.render(); }],
    ];
    for (const [name, title, run] of actions) {
      const btn = uiIconButton({ icon: name, label: title, onClick: run });
      this.opts.header.appendChild(btn);
    }
  }

  private render(): void {
    const body = this.opts.body;
    body.textContent = "";
    if (!this.root) {
      const empty = emptyState({
        icon: "folder-opened",
        title: "尚未打开工作目录",
        description: this.opts.onOpenFolder ? "选择一个远端目录后开始编辑。" : "请先连接远程主机，再打开工作目录。",
        actionLabel: "打开远程文件夹…",
        actionDisabled: !this.opts.onOpenFolder,
        onAction: () => this.opts.onOpenFolder?.(),
      });
      body.appendChild(empty);
      return;
    }
    const rootRow = this.row({ name: this.root.split("/").filter(Boolean).pop() ?? this.root, path: this.root, isDir: true, isSymlink: false, size: 0, mtime: 0, mode: 0 }, 0);
    body.appendChild(rootRow);
    if (this.expanded.has(this.root)) this.renderChildren(this.root, 1, body);
  }

  private renderChildren(dir: string, depth: number, body: HTMLElement): void {
    const children = this.entries.get(dir);
    if (!children) {
      if (this.loading.has(dir)) {
        const row = document.createElement("div");
        row.className = "tree-row loading";
        row.style.paddingLeft = `${depth * 12 + 8}px`;
        row.textContent = "加载中…";
        body.appendChild(row);
      }
      return;
    }
    for (const child of children) {
      body.appendChild(this.row(child, depth));
      if (child.isDir && this.expanded.has(child.path)) this.renderChildren(child.path, depth + 1, body);
    }
  }

  private row(entry: RemoteEntry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${depth * 12 + 8}px`;
    const letter = entry.isDir ? "" : this.status?.files[entry.path]?.letter ?? "";
    if (letter) {
      const change = this.status?.files[entry.path]?.change;
      row.dataset.change = change ?? "";
    }
    if (entry.isDir && this.status?.dirs[entry.path]) row.dataset.change = this.status.dirs[entry.path] ?? "";
    const arrow = document.createElement("span");
    arrow.className = "tree-arrow";
    arrow.textContent = entry.isDir ? (this.expanded.has(entry.path) ? "▾" : "▸") : "";
    const ic = icon(entry.isDir ? "folder" : "file", entry.name);
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;
    name.title = [
      entry.path,
      `类型: ${entry.isDir ? "目录" : "文件"}`,
      `大小: ${formatBytes(entry.size)}`,
      `修改时间: ${new Date(entry.mtime * 1000).toLocaleString()}`,
      `权限: ${formatMode(entry.mode)}`,
      `Git: ${this.gitLabelFor(entry.path)}`,
    ].join("\n");
    row.append(arrow, ic, name);
    if (letter) {
      const badge = document.createElement("span");
      badge.className = "tree-badge";
      badge.textContent = letter;
      badge.dataset.change = this.status?.files[entry.path]?.change ?? "";
      row.appendChild(badge);
    }
    row.onclick = () => {
      if (entry.isDir) void this.toggle(entry.path);
      else this.opts.onOpenFile(entry.path);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      void this.contextMenu(entry, e.clientX, e.clientY);
    };
    return row;
  }

  private async toggle(path: string): Promise<void> {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this.render();
      return;
    }
    this.expanded.add(path);
    if (!this.entries.has(path)) {
      this.loading.add(path);
      this.render();
      try {
        const children = await this.cache.load(path);
        this.entries.set(path, children);
        this.cache.prefetch(children);
      } catch (err) {
        this.entries.set(path, []);
        this.loading.delete(path);
        this.render();
        const failed = document.createElement("div");
        failed.className = "tree-row failed";
        failed.textContent = `加载失败：${String(err)}`;
        failed.onclick = () => void this.toggle(path);
        return;
      } finally {
        this.loading.delete(path);
      }
    }
    this.render();
  }

  /** 右键菜单（分册 2 U2）：新建/重命名/删除/刷新/复制路径 */
  private async contextMenu(entry: RemoteEntry, x: number, y: number): Promise<void> {
    openContextMenu([
      { label: "新建文件…", icon: "new-file", onClick: () => void this.createEntry(false, entry.isDir ? entry.path : parentOf(entry.path)) },
      { label: "新建文件夹…", icon: "new-folder", onClick: () => void this.createEntry(true, entry.isDir ? entry.path : parentOf(entry.path)) },
      { label: "重命名…", icon: "edit", onClick: () => void this.renameEntry(entry) },
      { label: "删除", icon: "trash", danger: true, onClick: () => void this.deleteEntry(entry) },
      { label: "刷新", icon: "refresh", onClick: () => void this.refresh(entry.isDir ? entry.path : parentOf(entry.path)) },
      { label: "复制路径", icon: "files", onClick: () => { void navigator.clipboard.writeText(entry.path); } },
      { label: "属性", icon: "info", onClick: () => { void showMessage({ title: "属性", body: this.tooltipFor(entry), severity: "info" }); } },
    ], x, y);
  }

  private async createEntry(isDir: boolean, parent = this.root): Promise<void> {
    if (!this.root) return;
    const name = await promptDialog({ title: isDir ? "新建文件夹" : "新建文件", body: "", label: "名称：" });
    if (!name) return;
    const target = `${parent.replace(/\/+$/, "")}/${name}`;
    try {
      await window.api.fs.create(target, isDir);
      await this.refresh(parent);
    } catch (err) {
      await showMessage({ title: isDir ? "新建文件夹" : "新建文件", body: String(err), severity: "error" });
    }
  }

  private async renameEntry(entry: RemoteEntry): Promise<void> {
    const name = await promptDialog({ title: "重命名", body: "", label: "新名称：", value: entry.name });
    if (!name || name === entry.name) return;
    const to = `${parentOf(entry.path)}/${name}`;
    try {
      await window.api.fs.rename(entry.path, to);
      this.cache.invalidateTree(parentOf(entry.path));
      await this.refresh(parentOf(entry.path));
    } catch (err) {
      await showMessage({ title: "重命名", body: String(err), severity: "error" });
    }
  }

  private async deleteEntry(entry: RemoteEntry): Promise<void> {
    const ok = await confirmDialog({
      title: "删除",
      body: `确定删除远程路径吗？\n${entry.path}\n\n目录将被递归删除。`,
      okText: "删除", danger: true, severity: "warning",
    });
    if (!ok) return;
    try {
      await window.api.fs.remove(entry.path);
      this.cache.invalidateTree(entry.path);
      await this.refresh(parentOf(entry.path));
    } catch (err) {
      await showMessage({ title: "删除", body: String(err), severity: "error" });
    }
  }
  /** 新建文件夹（主菜单/快捷键用） */
  async createFolder(): Promise<void> {
    await this.createEntry(true);
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMode(mode: number): string {
  const perms = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const value = mode & 0o777;
  return `${perms[(value >> 6) & 7]} ${perms[(value >> 3) & 7]} ${perms[value & 7]}`;
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}
