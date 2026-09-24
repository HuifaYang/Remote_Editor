// 欢迎页（U6）：VS Code 风格左对齐起始页；连接状态、最近主机和快捷键入口都在这里收口
import { icon } from "../app/icons.js";
import { uiButton } from "./ui.js";

export interface WelcomeRecentHost {
  id: string;
  name: string;
  host: string;
  username: string;
  workspace?: string;
  workspaces?: string[];
}

export interface WelcomeDeps {
  onConnect: () => void;
  onOpenFolder: () => void;
  onSearch: () => void;
  onTerminal: () => void;
  onOpenRecent: (hostId: string, workspace?: string) => void;
  loadRecent: () => Promise<WelcomeRecentHost[]>;
}

export class WelcomeView {
  readonly root: HTMLElement;
  private connected = false;
  private hostName = "";
  private recent: WelcomeRecentHost[] = [];
  private loadSeq = 0;

  constructor(private readonly deps: WelcomeDeps) {
    this.root = document.createElement("div");
    this.root.className = "welcome";
    this.root.id = "welcome";
    this.render();
    void this.refreshRecent();
  }

  setConnected(connected: boolean, hostName = ""): void {
    if (this.connected === connected && this.hostName === hostName) return;
    this.connected = connected;
    this.hostName = hostName;
    this.render();
    if (connected) void this.refreshRecent();
  }

  async refreshRecent(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const hosts = await this.deps.loadRecent();
      if (seq !== this.loadSeq) return;
      this.recent = hosts
        .slice()
        .sort((a, b) => (b.workspaces?.length ?? 0) - (a.workspaces?.length ?? 0))
        .slice(0, 4);
      this.render();
    } catch {
      if (seq === this.loadSeq) this.recent = [];
    }
  }

  private render(): void {
    this.root.textContent = "";
    const content = document.createElement("div");
    content.className = "welcome-content";

    const eyebrow = document.createElement("div");
    eyebrow.className = "welcome-eyebrow";
    eyebrow.textContent = "REMOTE CODE EDITOR";
    const title = document.createElement("h1");
    title.textContent = "RemoteCodeEditor";
    const subtitle = document.createElement("p");
    subtitle.className = "welcome-subtitle";
    subtitle.textContent = "轻量级 SSH 远程代码编辑器 · 远端零部署";
    const status = document.createElement("div");
    status.className = `welcome-status${this.connected ? " connected" : ""}`;
    status.textContent = this.connected ? `已连接 · ${this.hostName}` : "未连接远程主机";
    content.append(eyebrow, title, subtitle, status);

    const actions = document.createElement("div");
    actions.className = "welcome-actions";
    if (this.connected) {
      actions.append(
        uiButton({ label: "打开远程文件夹…", variant: "primary", icon: "folder-opened", onClick: this.deps.onOpenFolder }),
        uiButton({ label: "管理主机…", variant: "secondary", icon: "plug", onClick: this.deps.onConnect }),
      );
    } else {
      actions.append(
        uiButton({ label: "连接主机…", variant: "primary", icon: "plug", onClick: this.deps.onConnect }),
        uiButton({ label: "全局搜索", variant: "secondary", icon: "search", onClick: this.deps.onSearch }),
      );
    }
    content.appendChild(actions);

    if (this.recent.length > 0) content.appendChild(this.recentSection());
    content.appendChild(this.shortcutSection());
    this.root.appendChild(content);
  }

  private recentSection(): HTMLElement {
    const section = document.createElement("section");
    section.className = "welcome-section";
    const head = document.createElement("h2");
    head.textContent = "最近主机";
    const list = document.createElement("div");
    list.className = "welcome-recent";
    for (const host of this.recent) {
      const workspace = host.workspace ?? host.workspaces?.[0] ?? "";
      const item = document.createElement("button");
      item.type = "button";
      item.className = "welcome-recent-item";
      item.title = workspace ? `连接 ${host.name} 并打开 ${workspace}` : `连接 ${host.name}`;
      item.onclick = () => this.deps.onOpenRecent(host.id, workspace || undefined);
      item.appendChild(icon("plug", host.name));
      const text = document.createElement("span");
      text.className = "welcome-recent-text";
      const name = document.createElement("span");
      name.textContent = host.name;
      const target = document.createElement("span");
      target.className = "muted";
      target.textContent = workspace || `${host.username}@${host.host}`;
      text.append(name, target);
      item.appendChild(text);
      list.appendChild(item);
    }
    section.append(head, list);
    return section;
  }

  private shortcutSection(): HTMLElement {
    const section = document.createElement("section");
    section.className = "welcome-section";
    const head = document.createElement("h2");
    head.textContent = "常用操作";
    const grid = document.createElement("div");
    grid.className = "welcome-shortcut-grid";
    const shortcuts: Array<{ key: string; label: string; run: () => void }> = [
      { key: "Ctrl+O", label: "打开远程文件夹", run: this.deps.onOpenFolder },
      { key: "Ctrl+Shift+F", label: "全局搜索", run: this.deps.onSearch },
      { key: "Ctrl+`", label: "打开终端", run: this.deps.onTerminal },
    ];
    for (const item of shortcuts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "welcome-shortcut";
      btn.onclick = item.run;
      const key = document.createElement("kbd");
      key.textContent = item.key;
      const label = document.createElement("span");
      label.textContent = item.label;
      btn.append(key, label);
      grid.appendChild(btn);
    }
    section.append(head, grid);
    return section;
  }
}
