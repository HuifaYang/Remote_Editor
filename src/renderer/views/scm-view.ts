// 源代码管理（分册 2 U4）：提交区（绿色拆分按钮）+ 暂存区/更改分组 + 提交图 + 分支菜单 + 仓库管理
import type { GitTreeStatus, GraphRow } from "../../shared/types.js";
import { splitStatus, type ScmFileEntry } from "../../shared/git-status.js";
import { confirmDialog, openDialog, promptDialog, showMessage } from "./dialogs/index.js";
import { appStore } from "../app/store.js";
import { icon as appIcon } from "../app/icons.js";
import { emptyState, openContextMenu, uiIconButton } from "./ui.js";

export interface ScmViewDeps {
  onOpenFile: (path: string) => void;
  onStatus?: (message: string) => void;
  onOpenFolder?: () => void;
  onConnect?: () => void;
  /** 打开仓库管理对话框（M5：克隆 / 初始化 / 远程 / stash / 标签） */
  onRepoManager?: () => void;
}

/** 提交按钮可用性（分册 2 U4；单测覆盖） */
export function commitStateOf(hasChanges: boolean, hasMessage: boolean, submitting: boolean): { enabled: boolean; hint: string | null } {
  if (submitting) return { enabled: false, hint: null };
  if (!hasChanges) return { enabled: false, hint: null };
  if (!hasMessage) return { enabled: true, hint: "请先填写提交信息" };   // 可点，但提示而不弹窗
  return { enabled: true, hint: null };
}

export class ScmView {
  private status: GitTreeStatus | null = null;
  private graph: GraphRow[] | null = null;
  private message = "";
  private submitting = false;
  private graphOpen = false;

  constructor(private readonly body: HTMLElement, private readonly deps: ScmViewDeps) {
    this.render();
  }

  setStatus(status: GitTreeStatus | null): void {
    this.status = status;
    if (!status) this.graph = null;
    this.render();
  }

  async refresh(): Promise<void> {
    try {
      const status = await window.api.git.refresh();
      appStore.set({ gitLabel: status.label });
      this.setStatus(status);
    } catch (err) {
      this.deps.onStatus?.(`刷新 Git 状态失败：${String(err)}`);
    }
  }

  private render(): void {
    const body = this.body;
    body.textContent = "";
    if (!this.status) {
      const connected = appStore.get().connected;
      body.appendChild(emptyState({
        icon: "source-control",
        title: connected ? "尚未打开工作目录" : "请先连接主机",
        description: connected ? "打开一个 Git 工作目录后，在这里查看和提交更改。" : "连接远程主机后，源代码管理才能读取 Git 状态。",
        actionLabel: connected ? "打开远程文件夹…" : "连接主机…",
        onAction: () => connected ? this.deps.onOpenFolder?.() : this.deps.onConnect?.(),
      }));
      return;
    }
    body.appendChild(this.commitArea());
    body.appendChild(this.branchBar());
    const { staged, unstaged } = splitStatus(this.status);
    body.appendChild(this.group("暂存的更改", staged, true));
    body.appendChild(this.group("更改", unstaged, false));
    body.appendChild(this.graphArea());
  }

  private commitArea(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "scm-commit";
    const box = document.createElement("textarea");
    box.className = "scm-message";
    box.placeholder = this.status?.branch ? `消息（Ctrl+Enter 在"${this.status.branch}"上提交）` : "消息（回车提交）";
    box.value = this.message;
    box.oninput = () => { this.message = box.value; this.updateCommitButtons(); };
    box.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void this.commit();
    };
    wrap.appendChild(box);

    const row = document.createElement("div");
    row.className = "scm-buttons";
    const main = document.createElement("button");
    main.className = "scm-commit-btn";
    main.id = "scm-commit";
    main.textContent = "✓ 提交";
    main.onclick = () => void this.commit();
    const arrow = document.createElement("button");
    arrow.className = "scm-commit-arrow";
    arrow.textContent = "▾";
    arrow.onclick = (e) => this.commitMenu(e.clientX, e.clientY);
    row.append(main, arrow);
    wrap.appendChild(row);
    queueMicrotask(() => this.updateCommitButtons());
    return wrap;
  }

  private updateCommitButtons(): void {
    const hasChanges = (this.status?.files ? Object.keys(this.status.files).length : 0) > 0;
    const state = commitStateOf(hasChanges, this.message.trim() !== "", this.submitting);
    const main = this.body.querySelector<HTMLButtonElement>("#scm-commit");
    const arrow = this.body.querySelector<HTMLButtonElement>(".scm-commit-arrow");
    if (main) main.disabled = !state.enabled;
    if (arrow) arrow.disabled = !state.enabled;
  }

  /** 分支行：点开列出本地/远程分支，本地分支可切换（分册 2 U1/U4） */
  private branchBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "scm-branch";
    const branchIcon = appIcon("source-control", "分支");
    const name = document.createElement("span");
    name.textContent = this.status?.branch || "（无分支）";
    bar.append(branchIcon, name);
    bar.onclick = () => void this.branchMenu();
    return bar;
  }

  private async branchMenu(): Promise<void> {
    let items: Array<[string, () => void]> = [];
    try {
      const branches = await window.api.git.branches();
      items = branches.map((b) => [
        `${b.current ? "✓ " : ""}${b.remote ? "远程 · " : ""}${b.name}`,
        () => { if (!b.current && !b.remote) void this.switchBranch(b.name); },
      ]);
    } catch (err) {
      items = [[`读取分支失败：${String(err)}`, () => { /* 只展示 */ }]];
    }
    const rect = this.body.getBoundingClientRect();
    this.menu(rect.left + 12, rect.top + 12, items);
  }

  private async switchBranch(name: string): Promise<void> {
    try {
      await window.api.git.switchBranch(name);
      await this.refresh();
      this.deps.onStatus?.(`已切换到 ${name}`);
    } catch (err) {
      await showMessage({ title: "切换分支失败", body: String((err as Error).message ?? err), severity: "error" });
    }
  }

  private commitMenu(x: number, y: number): void {
    this.menu(x, y, [
      ["提交(修改)", () => void this.commit({ amend: true })],
      ["提交和推送", () => void this.commit({ push: true })],
      ["提交和同步", () => void this.commit({ sync: true })],
      ["提交所有更改", () => void this.commit({ all: true })],
    ]);
  }

  private async commit(opts?: { amend?: boolean; push?: boolean; sync?: boolean; all?: boolean }): Promise<void> {
    const hasChanges = (this.status?.files ? Object.keys(this.status.files).length : 0) > 0;
    const state = commitStateOf(hasChanges, this.message.trim() !== "", this.submitting);
    if (!state.enabled) return;
    if (state.hint) {
      this.deps.onStatus?.(state.hint);
      return;
    }
    if (!opts?.all && this.stagedCount() === 0) {
      const ok = await confirmDialog({
        title: "提交", severity: "warning",
        body: "没有已暂存的更改。\n\n是否暂存全部更改并提交？",
        okText: "暂存全部并提交",
      });
      if (!ok) return;
      await window.api.git.setStagedAll(true);
    }
    this.submitting = true;
    this.updateCommitButtons();
    try {
      await window.api.git.commit(this.message, opts);
      this.message = "";
      await this.refresh();
      this.deps.onStatus?.("提交完成");
    } catch (err) {
      await showMessage({ title: "提交失败", body: String((err as Error).message ?? err), severity: "error" });
    } finally {
      this.submitting = false;
      this.render();
    }
  }

  private stagedCount(): number {
    return splitStatus(this.status as GitTreeStatus).staged.length;
  }

  private group(title: string, entries: ScmFileEntry[], staged: boolean): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "scm-group";
    const head = document.createElement("div");
    head.className = "scm-group-head";
    const arrow = document.createElement("span");
    arrow.className = "scm-arrow";
    arrow.textContent = "▾";
    const label = document.createElement("span");
    label.textContent = title;
    const count = document.createElement("span");
    count.className = "muted";
    count.textContent = `${entries.length}`;
    const all = uiIconButton({ icon: staged ? "arrow-down" : "arrow-up", label: staged ? "全部取消暂存" : "全部暂存" });
    const refresh = uiIconButton({ icon: "refresh", label: "刷新 Git 状态", title: "刷新 Git 状态（Shift+F5）" });
    refresh.onclick = (e) => { e.stopPropagation(); void this.refresh(); };
    all.onclick = async (e) => {
      e.stopPropagation();
      const status = await window.api.git.setStagedAll(!staged);
      this.setStatus(status);
    };
    head.append(arrow, label, count, all, refresh);
    wrap.appendChild(head);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scm-empty muted";
      empty.textContent = staged ? "没有暂存的更改" : "没有检测到更改。";
      wrap.appendChild(empty);
      return wrap;
    }
    for (const entry of entries) wrap.appendChild(this.row(entry, staged));
    return wrap;
  }

  private row(entry: ScmFileEntry, staged: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "scm-row";
    const letter = document.createElement("span");
    letter.className = "scm-letter";
    letter.dataset.change = entry.change ?? "";
    letter.textContent = entry.letter || "?";
    const name = document.createElement("span");
    name.className = "scm-name";
    name.textContent = entry.path.split("/").pop() ?? entry.path;
    const dir = document.createElement("span");
    dir.className = "muted scm-dir";
    dir.textContent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const actions = document.createElement("span");
    actions.className = "scm-actions";
    const toggle = uiIconButton({ icon: staged ? "arrow-down" : "arrow-up", label: staged ? "取消暂存" : "暂存更改" });
    toggle.onclick = async (e) => {
      e.stopPropagation();
      const status = await window.api.git.setStaged([entry.absPath], !staged);
      this.setStatus(status);
    };
    const discard = uiIconButton({ icon: "discard", label: "丢弃更改", danger: true });
    discard.onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: "丢弃更改", severity: "warning", okText: "丢弃", danger: true,
        body: `确定丢弃「${entry.path}」的更改吗？\n此操作不可撤销。`,
      });
      if (!ok) return;
      const status = await window.api.git.discard([entry.absPath], entry.letter === "U");
      this.setStatus(status);
    };
    actions.append(toggle, discard);
    row.append(letter, name, dir, actions);
    row.onclick = () => this.deps.onOpenFile(entry.absPath);
    return row;
  }

  private graphArea(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "scm-group";
    const head = document.createElement("div");
    head.className = "scm-group-head";
    const arrow = document.createElement("span");
    arrow.className = "scm-arrow";
    arrow.textContent = this.graphOpen ? "▾" : "▸";
    const label = document.createElement("span");
    label.textContent = "图表";
    const repo = uiIconButton({ icon: "settings-gear", label: "仓库管理" });
    repo.onclick = (e) => { e.stopPropagation(); this.deps.onRepoManager?.(); };
    const refresh = uiIconButton({ icon: "refresh", label: "刷新提交历史" });
    refresh.onclick = (e) => { e.stopPropagation(); this.graph = null; void this.toggleGraph(); };
    const actions = document.createElement("span");
    actions.className = "scm-head-actions";
    actions.append(repo, refresh);
    head.append(arrow, label, actions);
    head.onclick = () => void this.toggleGraph();
    wrap.appendChild(head);
    if (this.graphOpen && this.graph) {
      for (const row of this.graph.slice(0, 200)) {
        const item = document.createElement("div");
        item.className = "graph-row";
        const lane = document.createElement("span");
        lane.className = "graph-lane";
        lane.textContent = "●";
        lane.style.color = `var(${LANE_VARS[row.lane % LANE_VARS.length]})`;
        const badge = document.createElement("span");
        badge.className = "graph-badge";
        badge.textContent = row.commit.refs.join(" ");
        const text = document.createElement("span");
        text.className = "graph-text";
        text.textContent = `${row.commit.subject}`;
        const meta = document.createElement("span");
        meta.className = "graph-meta muted";
        meta.textContent = `${row.commit.hash.slice(0, 7)} · ${row.commit.author} · ${relativeTime(row.commit.date)}`;
        item.append(lane, badge, text, meta);
        wrap.appendChild(item);
      }
    }
    return wrap;
  }

  /** 展开才拉一次 git log（分册 2 U4：换仓库清空但不自动重取） */
  private async toggleGraph(): Promise<void> {
    this.graphOpen = !this.graphOpen;
    if (this.graphOpen && !this.graph) {
      try {
        this.graph = await window.api.git.logGraph(200);
      } catch (err) {
        this.graph = [];
        this.deps.onStatus?.(`读取提交历史失败：${String(err)}`);
      }
    }
    this.render();
  }

  private menu(x: number, y: number, items: Array<[string, () => void]>): void {
    openContextMenu(items.map(([label, run]) => ({ label, onClick: run })), x, y);
  }
}

/** 泳道色：只取 tokens.css 变量，禁止硬编码颜色（总纲 §6.2） */
function relativeTime(date: string): string {
  const ts = Date.parse(date);
  if (!Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleString();
}

const LANE_VARS = ["--git-added", "--git-modified", "--git-deleted", "--accent", "--border", "--divider", "--commit-green", "--commit-green-hover"];

/** 仓库管理对话框（G4.3：无边框外壳，标题 `仓库管理`，宽 520、高 560；点开分组才拉数据） */
export async function openRepoManager(_onChanged: () => void): Promise<void> {
  const body = document.createElement("div");
  body.className = "repo-manager-body";
  const dialog = openDialog({ title: "仓库管理", body, className: "repo-manager" });
  const buttons = dialog.buttonRow;

  // 分组：点开才拉数据（G4.3）
  const makeGroup = (label: string): { group: HTMLElement; content: HTMLElement; opened: boolean } => {
    const group = document.createElement("div");
    group.className = "repo-group";
    const head = document.createElement("div");
    head.className = "repo-group-head";
    const arrow = document.createElement("span");
    arrow.className = "repo-arrow";
    arrow.textContent = "▸";
    const name = document.createElement("span");
    name.textContent = label;
    head.append(arrow, name);
    const content = document.createElement("div");
    content.className = "repo-group-body hidden";
    let opened = false;
    head.onclick = () => {
      opened = !opened;
      arrow.textContent = opened ? "▾" : "▸";
      content.classList.toggle("hidden", !opened);
      if (opened) content.dataset.load = "1";
    };
    group.append(head, content);
    body.appendChild(group);
    return { group, content, get opened() { return opened; } };
  };

  const remotes = makeGroup("远程仓库");
  const staging = makeGroup("暂存的更改");
  const tags = makeGroup("标签");
  const branches = makeGroup("分支");

  const renderRemotes = async (): Promise<void> => {
    const list = document.createElement("div");
    list.className = "repo-table";
    try {
      const items = await window.api.git.remotes();
      for (const r of items) {
        const row = document.createElement("div");
        row.className = "repo-row";
        const name = document.createElement("span");
        name.textContent = r.name;
        const fetch = document.createElement("span");
        fetch.textContent = r.fetchUrl;
        const push = document.createElement("span");
        push.textContent = r.pushUrl;
        row.append(name, fetch, push);
        list.appendChild(row);
      }
      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = "没有远程仓库";
        list.appendChild(empty);
      }
    } catch (err) {
      list.textContent = String((err as Error).message ?? err);
    }
    remotes.content.replaceChildren(list);
  };

  const renderStaging = async (): Promise<void> => {
    const wrap = document.createElement("div");
    try {
      const status = await window.api.git.refresh();
      const { staged, unstaged } = splitStatus(status);
      const mk = (label: string, items: ScmFileEntry[], stagedFlag: boolean): HTMLElement => {
        const head = document.createElement("div");
        head.className = "repo-subhead";
        head.textContent = `${label} (${items.length})`;
        const all = document.createElement("button");
        all.className = "icon-btn";
        all.textContent = stagedFlag ? "↓" : "↑";
        all.onclick = async () => {
          await window.api.git.setStagedAll(!stagedFlag);
          await renderStaging();
        };
        head.appendChild(all);
        const list = document.createElement("div");
        for (const item of items) {
          const row = document.createElement("div");
          row.className = "repo-row";
          row.textContent = item.path;
          list.appendChild(row);
        }
        const wrap2 = document.createElement("div");
        wrap2.append(head, list);
        return wrap2;
      };
      wrap.append(mk("暂存的更改", staged, true), mk("更改", unstaged, false));
    } catch (err) {
      wrap.textContent = String((err as Error).message ?? err);
    }
    staging.content.replaceChildren(wrap);
  };

  const renderTags = async (): Promise<void> => {
    const wrap = document.createElement("div");
    try {
      const items = await window.api.git.tags();
      for (const tag of items) {
        const row = document.createElement("div");
        row.className = "repo-row";
        const name = document.createElement("span");
        name.textContent = tag.name;
        const hash = document.createElement("span");
        hash.textContent = tag.hash;
        const message = document.createElement("span");
        message.textContent = tag.message;
        const date = document.createElement("span");
        date.textContent = tag.date;
        row.append(name, hash, message, date);
        wrap.appendChild(row);
      }
    } catch (err) {
      wrap.textContent = String((err as Error).message ?? err);
    }
    tags.content.replaceChildren(wrap);
  };

  const renderBranches = async (): Promise<void> => {
    const wrap = document.createElement("div");
    try {
      const items = await window.api.git.branches();
      for (const branch of items) {
        const row = document.createElement("div");
        row.className = "repo-row";
        const name = document.createElement("span");
        name.textContent = `${branch.current ? "✓ " : ""}${branch.name}`;
        const type = document.createElement("span");
        type.textContent = branch.remote ? "远程" : "本地";
        const upstream = document.createElement("span");
        upstream.textContent = branch.upstream || "";
        row.append(name, type, upstream);
        wrap.appendChild(row);
      }
    } catch (err) {
      wrap.textContent = String((err as Error).message ?? err);
    }
    branches.content.replaceChildren(wrap);
  };

  const loaders: Array<[typeof remotes, () => Promise<void>]> = [
    [remotes, renderRemotes],
    [staging, renderStaging],
    [tags, renderTags],
    [branches, renderBranches],
  ];
  // 简化：点开后手动调用对应渲染
  const hookLoad = (group: typeof remotes, render: () => Promise<void>): void => {
    const head = group.group.querySelector<HTMLElement>(".repo-group-head");
    head?.addEventListener("click", () => {
      if (head.querySelector<HTMLElement>(".repo-arrow")?.textContent === "▾") void render();
    });
  };
  loaders.forEach(([group, render]) => hookLoad(group, render));

  const addRemote = document.createElement("button");
  addRemote.className = "dialog-btn";
  addRemote.textContent = "新增远程…";
  addRemote.onclick = async () => {
    const name = await promptDialog({ title: "添加远程", body: "", label: "名称：", value: "origin" });
    if (!name) return;
    const url = await promptDialog({ title: "添加远程", body: "", label: "地址：", value: "" });
    if (!url) return;
    await window.api.git.addRemote(name, url);
    await renderRemotes();
  };
  const editRemote = document.createElement("button");
  editRemote.className = "dialog-btn";
  editRemote.textContent = "修改地址…";
  editRemote.onclick = async () => {
    const name = await promptDialog({ title: "修改地址", body: "", label: "名称：", value: "origin" });
    if (!name) return;
    const url = await promptDialog({ title: "修改地址", body: "", label: "地址：", value: "" });
    if (!url) return;
    await window.api.git.setRemoteUrl(name, url);
    await renderRemotes();
  };
  const deleteRemote = document.createElement("button");
  deleteRemote.className = "dialog-btn";
  deleteRemote.textContent = "删除";
  deleteRemote.onclick = async () => {
    const name = await promptDialog({ title: "删除远程", body: "", label: "名称：", value: "origin" });
    if (!name) return;
    await window.api.git.removeRemote(name);
    await renderRemotes();
  };
  const createTag = document.createElement("button");
  createTag.className = "dialog-btn";
  createTag.textContent = "新建标签…";
  createTag.onclick = async () => {
    const name = await promptDialog({ title: "新建标签", body: "", label: "名称：", value: "" });
    if (!name) return;
    const message = await promptDialog({ title: "新建标签", body: "", label: "说明：", value: "" });
    if (!message) return;
    await window.api.git.createTag(name, message);
    await renderTags();
  };
  const deleteTag = document.createElement("button");
  deleteTag.className = "dialog-btn";
  deleteTag.textContent = "删除标签…";
  deleteTag.onclick = async () => {
    const name = await promptDialog({ title: "删除标签", body: "", label: "名称：", value: "" });
    if (!name) return;
    await window.api.git.deleteTag(name);
    await renderTags();
  };
  const createBranch = document.createElement("button");
  createBranch.className = "dialog-btn";
  createBranch.textContent = "新建分支…";
  createBranch.onclick = async () => {
    const name = await promptDialog({ title: "新建分支", body: "", label: "名称：", value: "" });
    if (!name) return;
    await window.api.git.createBranch(name, false);
    await renderBranches();
  };
  const deleteBranch = document.createElement("button");
  deleteBranch.className = "dialog-btn";
  deleteBranch.textContent = "删除分支…";
  deleteBranch.onclick = async () => {
    const name = await promptDialog({ title: "删除分支", body: "", label: "名称：", value: "" });
    if (!name) return;
    await window.api.git.deleteBranch(name);
    await renderBranches();
  };
  const mergeBranch = document.createElement("button");
  mergeBranch.className = "dialog-btn";
  mergeBranch.textContent = "合并到当前分支…";
  mergeBranch.onclick = async () => {
    const name = await promptDialog({ title: "合并分支", body: "", label: "分支：", value: "" });
    if (!name) return;
    await window.api.git.mergeBranch(name);
    await renderBranches();
  };
  const stashSave = document.createElement("button");
  stashSave.className = "dialog-btn";
  stashSave.textContent = "暂存当前更改…";
  stashSave.onclick = async () => {
    const message = await promptDialog({ title: "暂存当前更改", body: "", label: "说明：", value: "" });
    if (!message) return;
    await window.api.git.stashSave(message);
    await renderStaging();
  };
  const stashView = document.createElement("button");
  stashView.className = "dialog-btn";
  stashView.textContent = "查看暂存…";
  stashView.onclick = async () => {
    const items = await window.api.git.stashList();
    await showMessage({ title: "查看暂存", body: items.map((i) => `stash@{${i.index}} ${i.message}`).join("\n") || "（没有暂存）", severity: "info" });
  };
  buttons.append(addRemote, editRemote, deleteRemote, createTag, deleteTag, createBranch, deleteBranch, mergeBranch, stashSave, stashView);
}
