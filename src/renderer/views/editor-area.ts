// 编辑区（分册 2 U6）：标签页 + Monaco model 生命周期 + 脏标记 + 自动保存 + 冲突提示
import type * as monaco from "monaco-editor";
import type { Fingerprint } from "../../shared/types.js";
import type { LspBridge } from "../editor/lsp-bridge.js";
import { confirmDialog, chooseDialog } from "./dialogs/index.js";
import { TabsModel } from "../app/tabs.js";
import { appStore } from "../app/store.js";
import { icon } from "../app/icons.js";
import { openContextMenu } from "./ui.js";

export interface EditorDeps {
  save: (path: string, text: string) => Promise<Fingerprint>;
  stat: (path: string) => Promise<{ mtime: number; size: number } | null>;
  autoSaveDelayMs?: number;
  onTabName?: (name: string) => void;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
  py: "python", json: "json", md: "markdown", ts: "typescript", js: "javascript",
};

export class EditorArea {
  readonly tabs = new TabsModel();
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private readonly container: HTMLElement;
  private readonly gutter: monaco.editor.IEditorDecorationsCollection;
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private autoSaveTimer: number | null = null;
  private autoSaveDelayMs: number;
  private autoSaveEnabled = true;

  constructor(
    private readonly m: typeof monaco,
    private readonly tabsHost: HTMLElement,
    private readonly bridge: LspBridge,
    private readonly deps: EditorDeps,
  ) {
    const container = document.createElement("div");
    container.className = "editor-container hidden";   // 无标签时让位给欢迎页
    this.container = container;
    this.editor = m.editor.create(container, {
      theme: document.documentElement.dataset.theme === "light" ? "rce-light" : "rce-dark",
      fontSize: 13,
      fontFamily: '"JetBrains Mono", Consolas, monospace',
      lineNumbers: "on",
      minimap: { enabled: true },
      renderWhitespace: "selection",
      quickSuggestions: true,
      parameterHints: { enabled: true },
      wordWrap: "off",
      automaticLayout: true,
    });
    this.autoSaveDelayMs = deps.autoSaveDelayMs ?? 1500;
    this.gutter = this.editor.createDecorationsCollection([]);
    this.editor.onDidChangeCursorPosition((e) => {
      appStore.set({ line: e.position.lineNumber, column: e.position.column });
    });
    const app = document.querySelector(".editor-area");
    app?.appendChild(container);
    this.tabs.subscribe(() => this.renderTabs());
    this.renderTabs();
  }

  /** 打开（或激活）文件：model 已存在就直接切 */
  async open(path: string, text: string, fingerprint: Fingerprint, encoding: string, newline: string): Promise<void> {
    let model = this.models.get(path);
    if (!model) {
      model = this.m.editor.createModel(text, LANGUAGE_BY_EXT[extOf(path)] ?? "plaintext", this.m.Uri.file(path));
      this.models.set(path, model);
      this.bridge.track(model);
    }
    const language = model.getLanguageId();
    this.tabs.open({
      path, name: path.split("/").pop() ?? path, language: language === "cpp" ? "C++" : language,
      dirty: false, fingerprint, encoding, newline,
    });
    model.onDidChangeContent(() => {
      this.tabs.setDirty(path, true);
      appStore.set({ saveState: "dirty" });
      this.scheduleAutoSave(path);
    });
    this.activate(path);
    this.updateEmptyState();
    void this.refreshGutter(path);
  }

  activate(path: string): void {
    const model = this.models.get(path);
    if (!model) return;
    this.tabs.activate(path);
    this.editor.setModel(model);
    void this.refreshGutter(path);
    const tab = this.tabs.active();
    if (tab) {
      appStore.set({ encoding: tab.encoding, language: tab.language, saveState: tab.dirty ? "dirty" : "saved" });
      this.deps.onTabName?.(tab.name);
    }
    this.updateEmptyState();
  }


  /** 执行 Monaco 内置命令（主菜单/快捷键用） */
  execEditorCommand(command: string): void {
    this.editor.focus();
    this.editor.trigger("", command, null);
  }


  /** 新建文件（主菜单/快捷键用）：打开一个空 model，路径未定时不写远端 */
  newFile(): Promise<void> {
    const model = this.m.editor.createModel("", "plaintext", this.m.Uri.file(`untitled-${Date.now()}.txt`));
    this.models.set(model.uri.toString(), model);
    this.bridge.track(model);
    this.tabs.open({ path: model.uri.toString(), name: model.uri.path.split("/").pop() ?? "untitled", language: "plaintext", dirty: false, fingerprint: { path: model.uri.toString(), size: 0, mtime: 0 }, encoding: "utf8", newline: "lf" });
    this.activate(model.uri.toString());
    this.updateEmptyState();
    return Promise.resolve();
  }

  activePath(): string | null {
    return this.tabs.active()?.path ?? null;
  }

  /** 跳到指定行（搜索结果 / 上次光标位置） */
  revealLine(line: number): void {
    this.editor.revealLineInCenter(line);
    this.editor.setPosition({ lineNumber: line, column: 1 });
    this.editor.focus();
  }

  activeText(): string {
    return this.editor.getModel()?.getValue() ?? "";
  }

  /** 保存（Ctrl+S）：不超过 2 次 SFTP（临时文件 + rename）；冲突由远端指纹变化在保存后提示 */
  async save(path = this.activePath()): Promise<void> {
    if (!path) return;
    const model = this.models.get(path);
    const tab = this.tabs.list().find((t) => t.path === path);
    if (!model || !tab) return;
    appStore.set({ saveState: "saving" });
    try {
      const text = model.getValue();
      const fp = await this.deps.save(path, text);
      const hadConflict = tab.fingerprint && (fp.mtime !== tab.fingerprint.mtime || fp.size !== tab.fingerprint.size) && tab.dirty;
      this.tabs.setFingerprint(path, fp);
      this.tabs.setDirty(path, false);
      this.bridge.saved(model);
      appStore.set({ saveState: "saved" });
      if (hadConflict) {
        const choice = await chooseDialog({
          title: "远程文件已被修改", severity: "warning",
          body: `远程文件已发生变化：\n${path}\n\n请选择处理方式（不会静默覆盖）。`,
          buttons: [
            { label: "重新加载远程", value: "reload" },
            { label: "保持本地", value: "keep" },
          ],
        });
        if (choice === "reload") {
          const fresh = await window.api.fs.readFile(path);
          model.setValue(fresh.text);
          this.tabs.setFingerprint(path, fresh.fingerprint);
          this.tabs.setDirty(path, false);
          appStore.set({ saveState: "saved" });
        }
      }
    } catch (err) {
      appStore.set({ saveState: "failed", saveMessage: String(err) });
    }
  }

  async saveAll(): Promise<void> {
    for (const tab of this.tabs.dirtyTabs()) await this.save(tab.path);
  }

  async close(path = this.activePath()): Promise<void> {
    if (!path) return;
    const tab = this.tabs.list().find((t) => t.path === path);
    if (tab?.dirty) {
      const ok = await confirmDialog({ title: "未保存的修改", body: `${tab.name} 有未保存的修改，是否保存？`, okText: "保存", cancelText: "不保存", severity: "warning" });
      if (ok) await this.save(path);
    }
    const model = this.models.get(path);
    if (model) {
      this.bridge.release(model);
      model.dispose();
      this.models.delete(path);
    }
    this.tabs.close(path);
    const next = this.tabs.active();
    if (next) this.activate(next.path);
    else {
      this.editor.setModel(null);
      this.updateEmptyState();
    }
  }

  /** 设置变更后即时生效（分册 2 U9） */
  applySettings(opts: { fontSize?: number; tabSize?: number; useSpaces?: boolean; wordWrap?: boolean; lineNumbers?: boolean; highlightCurrentLine?: boolean; autoSave?: boolean; autoSaveDelayMs?: number }): void {
    this.editor.updateOptions({
      fontSize: opts.fontSize,
      tabSize: opts.tabSize,
      insertSpaces: opts.useSpaces,
      wordWrap: opts.wordWrap === undefined ? undefined : opts.wordWrap ? "on" : "off",
      lineNumbers: opts.lineNumbers === undefined ? undefined : opts.lineNumbers ? "on" : "off",
      renderLineHighlight: opts.highlightCurrentLine === undefined ? undefined : opts.highlightCurrentLine ? "line" : "none",
    });
    if (opts.autoSave !== undefined) this.autoSaveEnabled = opts.autoSave;
    if (opts.autoSaveDelayMs) this.autoSaveDelayMs = opts.autoSaveDelayMs;
  }

  /** 行级差异与 gutter（M5）：干净文件 0 条 git 命令，已修改 1 条 git diff */
  private async refreshGutter(path: string): Promise<void> {
    const model = this.models.get(path);
    if (!model) return;
    try {
      const diff = await window.api.git.fileDiff(path, model.getValue());
      const deco = [
        ...diff.addedLines.map((line) => this.decoration(line, "git-line-added")),
        ...diff.modifiedLines.map((line) => this.decoration(line, "git-line-modified")),
        ...diff.deletedLines.map((line) => this.decoration(line, "git-line-deleted")),
      ];
      this.gutter.set(deco);
    } catch {
      this.gutter.set([]);      // 非 Git 仓库 / 未连接 → 清空
    }
  }

  private decoration(line: number, className: string): monaco.editor.IModelDeltaDecoration {
    return {
      range: new this.m.Range(line, 1, line, 1),
      options: { linesDecorationsClassName: className, stickiness: this.m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    };
  }

  /** 无标签 → 显示欢迎页、隐藏 Monaco 容器（分册 2 U6 空态） */
  private updateEmptyState(): void {
    const empty = this.tabs.list().length === 0;
    this.container.classList.toggle("hidden", empty);
    document.getElementById("welcome")?.classList.toggle("hidden", !empty);
    if (!empty) this.editor.layout();
  }

  next(): void {
    const list = this.tabs.list();
    if (list.length < 2) return;
    const idx = list.findIndex((t) => t.path === this.activePath());
    const next = list[(idx + 1) % list.length];
    this.activate(next.path);
  }

  async closeAll(): Promise<boolean> {
    for (const tab of [...this.tabs.list()]) {
      await this.close(tab.path);
    }
    return true;
  }

  private scheduleAutoSave(path: string): void {
    if (this.autoSaveTimer !== null) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = window.setTimeout(() => {
      const tab = this.tabs.list().find((t) => t.path === path);
      if (this.autoSaveEnabled && tab?.dirty) void this.save(path);
    }, this.autoSaveDelayMs);
  }

  private renderTabs(): void {
    this.tabsHost.textContent = "";
    this.tabs.list().forEach((tab, index) => {
      const el = document.createElement("div");
      el.className = "editor-tab" + (tab.path === this.activePath() ? " active" : "");
      el.draggable = true;
      el.title = tab.path;
      const fileIcon = icon("files", tab.name);
      fileIcon.classList.add("tab-icon");
      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = tab.name;
      const close = document.createElement("span");
      close.className = `tab-close${tab.dirty ? " dirty" : ""}`;
      close.title = tab.dirty ? "未保存，点击关闭" : "关闭";
      if (tab.dirty) close.textContent = "●";
      else close.appendChild(icon("close", "关闭"));
      close.onclick = (e) => { e.stopPropagation(); void this.close(tab.path); };
      el.append(fileIcon, name, close);
      el.onclick = () => this.activate(tab.path);
      el.onauxclick = (e) => { if (e.button === 1) void this.close(tab.path); };
      el.ondragstart = (e) => { e.dataTransfer?.setData("text/plain", String(index)); };
      el.ondragover = (e) => e.preventDefault();
      el.ondrop = (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData("text/plain"));
        if (Number.isInteger(from)) this.tabs.move(from, index);
      };
      el.oncontextmenu = (e) => {
        e.preventDefault();
        void this.tabMenu(tab.path, e.clientX, e.clientY);
      };
      this.tabsHost.appendChild(el);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "editor-tab-add";
    add.title = "新建文件";
    add.setAttribute("aria-label", "新建文件");
    add.appendChild(icon("add", "新建文件"));
    add.onclick = () => void this.newFile();
    this.tabsHost.appendChild(add);
  }

  private async tabMenu(path: string, x: number, y: number): Promise<void> {
    openContextMenu([
      { label: "关闭", icon: "close", onClick: () => void this.close(path) },
      { label: "关闭其它", icon: "close", onClick: () => { this.tabs.closeOthers(path); this.activate(path); } },
      { label: "关闭右侧", icon: "close", onClick: () => { this.tabs.closeRight(path); this.activate(path); } },
      { label: "全部保存", icon: "save", onClick: () => void this.saveAll() },
    ], x, y);
  }
}

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx < 0 ? "" : path.slice(idx + 1).toLowerCase();
}
