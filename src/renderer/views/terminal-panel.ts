// 底部终端（分册 2 U7）：xterm.js + 多标签；数据经 IPC 批量传输（主进程已按帧合并）
import { appStore } from "../app/store.js";
import { icon } from "../app/icons.js";
import { emptyState, uiIconButton } from "./ui.js";

interface XTermLike {
  open(el: HTMLElement): void;
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
  focus(): void;
  readonly cols: number;
  readonly rows: number;
}
interface FitLike { fit(): void }

interface TermTab {
  id: string;
  name: string;
  term: XTermLike;
  fit: FitLike;
  container: HTMLElement;
  tabEl: HTMLElement;
}

function decodeBase64(data: string): string {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class TerminalPanel {
  private readonly tabs = new Map<string, TermTab>();
  private activeId: string | null = null;
  private counter = 0;
  private readonly body: HTMLElement;
  private readonly tabBar: HTMLElement;
  private emptyEl: HTMLElement | null = null;
  private killButton: HTMLButtonElement | null = null;

  constructor(private readonly root: HTMLElement) {
    const toolbar = document.createElement("div");
    toolbar.className = "terminal-toolbar";
    const title = document.createElement("span");
    title.className = "terminal-title";
    title.append(icon("terminal", "终端"), document.createTextNode("终端"));
    this.tabBar = document.createElement("div");
    this.tabBar.className = "terminal-tabs";
    const add = uiIconButton({ icon: "add", label: "新建终端", title: "新建终端（Ctrl+Shift+`）", onClick: () => void this.newTerminal() });
    const kill = uiIconButton({ icon: "trash", label: "终止当前终端", danger: true, onClick: () => { if (this.activeId) window.api.terminal.close(this.activeId); } });
    kill.disabled = true;
    this.killButton = kill;
    const hide = uiIconButton({ icon: "chevron-down", label: "收起面板", onClick: () => this.hide() });
    toolbar.append(title, this.tabBar, add, kill, hide);

    this.body = document.createElement("div");
    this.body.className = "terminal-body";
    this.root.append(toolbar, this.body);
    this.renderEmpty();

    window.api.on("event:terminal-data", (p) => {
      const payload = p as { id: string; data: string };
      this.tabs.get(payload.id)?.term.write(decodeBase64(payload.data));
    });
    window.api.on("event:terminal-closed", (p) => {
      const payload = p as { id: string };
      this.removeTab(payload.id);
    });
    window.addEventListener("resize", () => this.fitActive());
    window.addEventListener("keydown", (e) => {
      if (e.key === "v" && e.ctrlKey && e.shiftKey) void this.pasteClipboard();
      if (e.key === "PageUp" && e.shiftKey) this.scrollPage(-1);
      if (e.key === "PageDown" && e.shiftKey) this.scrollPage(1);
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  show(): void {
    this.root.classList.remove("hidden");
    this.fitActive();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** 新建终端：先按容器尺寸 fit 出 cols/rows，再让主进程开 PTY */
  async newTerminal(): Promise<void> {
    if (!appStore.get().connected) {
      this.show();
      this.renderEmpty("请先连接主机", "连接远程主机后才能打开终端。");
      return;
    }
    const Xterm = (window as unknown as { Terminal?: new (opts: Record<string, unknown>) => XTermLike }).Terminal;
    const FitAddonCtor = (window as unknown as { FitAddon?: { FitAddon: new () => FitLike } }).FitAddon;
    if (!Xterm || !FitAddonCtor) return;
    this.emptyEl?.remove();
    this.emptyEl = null;
    if (this.killButton) this.killButton.disabled = false;
    const id = `t${++this.counter}`;
    const container = document.createElement("div");
    container.className = "terminal-instance";
    this.body.appendChild(container);
    const term = new Xterm({
      fontFamily: '"JetBrains Mono", Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue("--bg-editor").trim(),
        foreground: getComputedStyle(document.documentElement).getPropertyValue("--fg").trim(),
      },
      scrollback: 5000,
    });
    const fit = new FitAddonCtor.FitAddon();
    term.open(container);
    term.loadAddon(fit);
    fit.fit();

    const tabEl = document.createElement("div");
    tabEl.className = "terminal-tab";
    tabEl.textContent = `终端 ${this.counter}`;
    tabEl.onclick = () => this.activate(id);
    const close = document.createElement("span");
    close.className = "tab-close";
    close.appendChild(icon("close", "关闭终端"));
    close.onclick = (e) => { e.stopPropagation(); window.api.terminal.close(id); };
    tabEl.appendChild(close);
    this.tabBar.appendChild(tabEl);

    const tab: TermTab = { id, name: tabEl.textContent ?? id, term, fit, container, tabEl };
    this.tabs.set(id, tab);
    term.onData((data) => window.api.terminal.write(id, data));

    try {
      await window.api.terminal.create(id, term.cols || 80, term.rows || 24);
    } catch (err) {
      term.write(`\r\n[无法打开终端] ${String((err as Error).message ?? err)}\r\n`);
    }
    this.activate(id);
    this.show();
    this.deps.onNew?.();
  }

  private async pasteClipboard(): Promise<void> {
    if (!this.activeId) return;
    try {
      const text = await navigator.clipboard.readText();
      window.api.terminal.write(this.activeId, text);
    } catch {
      /* 剪贴板不可用忽略 */
    }
  }

  private scrollPage(direction: number): void {
    const tab = this.activeId ? this.tabs.get(this.activeId) : null;
    if (!tab) return;
    const rows = tab.term.rows || 24;
    tab.term.write(direction < 0 ? "\x1b[5~".repeat(1) : "\x1b[6~".repeat(1));
    void rows;
  }

  private deps: { onNew?: () => void } = {};
  setOnNew(cb: () => void): void { this.deps.onNew = cb; }


  /** 主菜单/快捷键用：终止当前终端 */
  killActive(): void {
    if (this.activeId) window.api.terminal.close(this.activeId);
  }

  /** 主菜单/快捷键用：清屏当前终端 */
  clearActive(): void {
    const tab = this.activeId ? this.tabs.get(this.activeId) : null;
    tab?.term.write("\x1b[2J\x1b[H");
  }

  private activate(id: string): void {
    this.activeId = id;
    for (const [key, tab] of this.tabs) {
      tab.container.classList.toggle("hidden", key !== id);
      tab.tabEl.classList.toggle("active", key === id);
    }
    this.fitActive();
    this.tabs.get(id)?.term.focus();
  }

  private fitActive(): void {
    const tab = this.activeId ? this.tabs.get(this.activeId) : null;
    if (!tab || this.root.classList.contains("hidden")) return;
    tab.fit.fit();
    window.api.terminal.resize(tab.id, tab.term.cols || 80, tab.term.rows || 24);
  }

  private removeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.term.dispose();
    tab.container.remove();
    tab.tabEl.remove();
    this.tabs.delete(id);
    if (this.activeId === id) {
      const next = [...this.tabs.keys()][0] ?? null;
      this.activeId = next;
      if (next) this.activate(next);
      else this.renderEmpty();
      if (this.killButton) this.killButton.disabled = this.tabs.size === 0;
    }
  }

  private renderEmpty(title = "没有打开的终端。", description = "点右上角「+」新建一个。"): void {
    if (this.tabs.size > 0) return;
    this.emptyEl?.remove();
    this.emptyEl = emptyState({ icon: "terminal", title, description });
    this.emptyEl.classList.add("terminal-empty");
    this.body.appendChild(this.emptyEl);
    if (this.killButton) this.killButton.disabled = true;
  }
}
