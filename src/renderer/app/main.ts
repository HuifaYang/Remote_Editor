// 渲染进程入口：组装外壳（标题栏 / 活动栏 / 侧栏 / 编辑区 / 状态栏 / 快捷键 / 会话事件）
import { mountTitleBar } from "./title-bar.js";
import { mountActivityBar } from "../views/activity-bar.js";
import { mountStatusBar } from "../views/status-bar.js";
import { mountEdgeResize } from "./edge-resize.js";
import { installShortcuts } from "./shortcuts.js";
import { appStore, uiStore } from "./store.js";
import { loadMonaco, defineMonacoThemes } from "../editor/monaco-setup.js";
import { LspBridge } from "../editor/lsp-bridge.js";
import { EditorArea } from "../views/editor-area.js";
import { Explorer } from "../views/explorer.js";
import { HostsView } from "../views/hosts-view.js";
import { ScmView, openRepoManager } from "../views/scm-view.js";
import { SearchView } from "../views/search-view.js";
import { TerminalPanel } from "../views/terminal-panel.js";
import { WelcomeView } from "../views/welcome.js";
import { openSettingsDialog } from "../views/dialogs/settings-dialog.js";
import type { GitTreeStatus } from "../../shared/types.js";
import { showMessage } from "../views/dialogs/index.js";

let editorArea: EditorArea | null = null;
let explorer: Explorer | null = null;
let hostsView: HostsView | null = null;
let scmView: ScmView | null = null;
let latestStatus: GitTreeStatus | null = null;
let terminalPanel: TerminalPanel | null = null;
let sidebarVisible = false;


/** 侧边栏可拖分隔条（U1：宽 200~480px，热区 6px） */
function mountSidebarDivider(workbench: HTMLElement, sidebar: HTMLElement): void {
  const divider = document.createElement("div");
  divider.className = "divider sidebar-divider";
  workbench.insertBefore(divider, sidebar.nextSibling);
  startDragDivider(divider, (dx) => {
    const width = Math.min(480, Math.max(200, sidebar.getBoundingClientRect().width + dx));
    sidebar.style.width = `${width}px`;
  });
}

/** 底部面板可拖分隔条（U1：高 80~窗口高度 70%） */
function mountPanelDivider(editorColumn: HTMLElement, panel: HTMLElement): void {
  const divider = document.createElement("div");
  divider.className = "divider panel-divider";
  editorColumn.insertBefore(divider, panel);
  startDragDivider(divider, (_dx, dy) => {
    const height = Math.min(window.innerHeight * 0.7, Math.max(80, panel.getBoundingClientRect().height - dy));
    panel.style.height = `${height}px`;
  });
}

function startDragDivider(divider: HTMLElement, onMove: (dx: number, dy: number) => void): void {
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    let lastX = e.screenX;
    let lastY = e.screenY;
    const move = (ev: PointerEvent): void => {
      const dx = ev.screenX - lastX;
      const dy = ev.screenY - lastY;
      lastX = ev.screenX;
      lastY = ev.screenY;
      onMove(dx, dy);
    };
    const up = (): void => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
}


function buildShell(app: HTMLElement): void {
  mountTitleBar(app, {
    openFolder: () => void promptOpenFolder(),
    newFile: () => void editorArea?.newFile(),
    newFolder: () => void explorer?.createFolder(),
    save: () => void editorArea?.save(),
    saveAll: () => void editorArea?.saveAll(),
    closeTab: () => void editorArea?.close(),
    quit: () => window.api.window.close(),
    undo: () => void editorArea?.execEditorCommand("undo"),
    redo: () => void editorArea?.execEditorCommand("redo"),
    cut: () => void editorArea?.execEditorCommand("actions.cut"),
    copy: () => void editorArea?.execEditorCommand("actions.copy"),
    paste: () => void editorArea?.execEditorCommand("actions.paste"),
    find: () => void editorArea?.execEditorCommand("actions.find"),
    replace: () => void editorArea?.execEditorCommand("editor.action.startFindReplaceAction"),
    searchAll: () => void switchView("search"),
    gotoLine: () => void editorArea?.execEditorCommand("editor.action.gotoLine"),
    viewFiles: () => void switchView("files"),
    viewSearch: () => void switchView("search"),
    viewScm: () => void switchView("source-control"),
    viewHosts: () => void switchView("hosts"),
    toggleSidebar: () => { sidebar.classList.toggle("hidden"); sidebarVisible = !sidebarVisible; },
    togglePanel: () => terminalPanel?.toggle(),
    zoomIn: () => zoom(0.1),
    zoomOut: () => zoom(-0.1),
    zoomReset: () => zoom(0),
    themeDark: () => void setTheme("dark"),
    themeLight: () => void setTheme("light"),
    newTerminal: () => void terminalPanel?.newTerminal(),
    killTerminal: () => terminalPanel?.killActive(),
    clearTerminal: () => terminalPanel?.clearActive(),
    openSettings: () => void openSettings(),
    openShortcuts: () => void showShortcuts(),
    about: () => void showAbout(),
  });

  const workbench = document.createElement("div");
  workbench.className = "workbench";

  const sidebar = document.createElement("div");
  sidebar.className = "sidebar hidden";
  const sidebarHeader = document.createElement("div");
  sidebarHeader.className = "sidebar-header";
  const sidebarBody = document.createElement("div");
  sidebarBody.className = "sidebar-body";
  sidebar.append(sidebarHeader, sidebarBody);

  const switchView = (view: string | null): void => {
    if (view === null) { sidebar.classList.add("hidden"); sidebarVisible = false; uiStore.set({ sidebarView: null }); return; }
    sidebar.classList.remove("hidden");
    sidebarVisible = true;
    uiStore.set({ sidebarView: view });
    renderSidebar(view);
  };
  mountActivityBar(workbench, (view) => {
    if (view === "settings") { void openSettings(); return; }
    if (view === null) { switchView(null); return; }
    if (uiStore.get().sidebarView === view) { switchView(null); return; }
    switchView(view);
  });

  const editorAreaEl = document.createElement("div");
  editorAreaEl.className = "editor-area";
  const tabsHost = document.createElement("div");
  tabsHost.className = "editor-tabs";
  const welcome = new WelcomeView({
    onConnect: () => switchView("hosts"),
    onOpenFolder: () => void promptOpenFolder(),
    onSearch: () => switchView("search"),
    onTerminal: () => void terminalPanel?.newTerminal(),
    onOpenRecent: (hostId, workspace) => {
      switchView("hosts");
      queueMicrotask(() => void hostsView?.connectHost(hostId, workspace));
    },
    loadRecent: () => window.api.host.list().catch(() => []),
  });
  editorAreaEl.append(tabsHost, welcome.root);

  const editorColumn = document.createElement("div");
  editorColumn.className = "editor-column";
  const terminalEl = document.createElement("div");
  terminalEl.className = "terminal-panel hidden";
  editorColumn.append(editorAreaEl, terminalEl);
  workbench.append(sidebar, editorColumn);
  app.appendChild(workbench);
  const status = mountStatusBar(app, {
    onConnections: () => switchView("hosts"),
    onFiles: () => switchView("files"),
    onGit: () => switchView("source-control"),
  });
  mountEdgeResize(app);
  mountSidebarDivider(workbench, sidebar);
  mountPanelDivider(editorColumn, terminalEl);
  terminalPanel = new TerminalPanel(terminalEl);
  appStore.subscribe(() => welcome.setConnected(appStore.get().connected, appStore.get().hostName));

  const renderSidebar = (view: string): void => {
    sidebarHeader.textContent = "";
    const titleEl = document.createElement("span");
    titleEl.className = "sidebar-title";
    titleEl.textContent = { files: "资源管理器", search: "搜索", "source-control": "源代码管理", hosts: "远程主机" }[view] ?? view;
    sidebarHeader.appendChild(titleEl);
    sidebarBody.textContent = "";
    const viewBody = document.createElement("div");
    viewBody.className = "sidebar-view-body";
    sidebarBody.appendChild(viewBody);
    if (view === "files") explorer = new Explorer({
      body: viewBody,
      header: sidebarHeader,
      onOpenFile: (p) => void openFile(p),
      onOpenFolder: appStore.get().connected ? () => void promptOpenFolder() : undefined,
    });
    else if (view === "hosts") {
      hostsView = new HostsView(viewBody, { onOpenFolder: (_id, ws) => void openFolder(ws) });
      void hostsView.refresh();
    }
    else if (view === "search") {
      new SearchView(viewBody, { onOpenFile: (p, line) => void openFile(p, line), onConnect: () => switchView("hosts") });
    } else if (view === "source-control") {
      scmView = new ScmView(viewBody, {
        onOpenFile: (p) => void openFile(p),
        onOpenFolder: () => void promptOpenFolder(),
        onConnect: () => switchView("hosts"),
        onStatus: (m) => appStore.set({ saveMessage: m }),
        onRepoManager: () => void openRepoManager(() => void scmView?.refresh()),
      });
      scmView.setStatus(latestStatus);   // 打开面板 0 远端请求（复用文件树那份快照）
    }
  };

  void initMonaco(tabsHost, status.setTabName.bind(status));

  installShortcuts({
    save: () => void editorArea?.save(),
    saveAll: () => void editorArea?.saveAll(),
    closeTab: () => void editorArea?.close(),
    refreshMirror: () => void window.api.mirror.sync().then(() => appStore.set({ mirrorStale: false })).catch(() => appStore.set({ mirrorStale: true })),
    refreshGit: () => void scmView?.refresh(),
    openSettings: () => void openSettings(),
    togglePanel: () => terminalPanel?.toggle(),
    newTerminal: () => void terminalPanel?.newTerminal(),
    nextTab: () => editorArea?.next(),
    openFolder: () => void promptOpenFolder(),
    toggleSidebar: () => { sidebar.classList.toggle("hidden"); sidebarVisible = !sidebarVisible; },
    zoomIn: () => zoom(0.1),
    zoomOut: () => zoom(-0.1),
    zoomReset: () => zoom(0),
    newFile: () => void editorArea?.newFile(),
    find: () => void editorArea?.execEditorCommand("actions.find"),
    replace: () => void editorArea?.execEditorCommand("editor.action.startFindReplaceAction"),
    gotoLine: () => void editorArea?.execEditorCommand("editor.action.gotoLine"),
    searchAll: () => switchView("search"),
    triggerCompletion: () => void editorArea?.execEditorCommand("editor.action.triggerSuggest"),
  });

  window.api.on("event:connection-state", (p) => {
    const payload = p as { connected: boolean; message?: string };
    appStore.set({ connected: payload.connected, hostName: payload.message ?? appStore.get().hostName });
    if (uiStore.get().sidebarView === "files") renderSidebar("files");
  });
  window.api.on("event:mirror-progress", (p) => {
    const payload = p as { current: string };
    appStore.set({ saveMessage: payload.current });
  });
  window.api.on("event:mirror-done", () => appStore.set({ mirrorStale: false }));
  window.api.on("event:progress", (p) => {
    const payload = p as { key: string; text: string };
    if (payload.key === "mirror-stale") appStore.set({ mirrorStale: true, saveMessage: payload.text });
  });

  switchView("files");   // 初始布局与 VS Code 一致：资源管理器侧边栏默认展开
  void window.api.settings.get().then((s) => applySettings(s)).catch(() => { /* 用默认外观 */ });
}

async function initMonaco(tabsHost: HTMLElement, onTabName: (name: string) => void): Promise<void> {
  const monaco = await loadMonaco();
  defineMonacoThemes(monaco);
  const bridge = new LspBridge(monaco);
  editorArea = new EditorArea(monaco, tabsHost, bridge, {
    save: (path, text) => window.api.fs.saveFile(path, text),
    stat: (path) => window.api.fs.stat(path),
    onTabName,
  });
  window.monaco = monaco;
}

/** 打开文件：读远端 → 写进编辑区（D3.2） */
async function openFile(path: string, line?: number): Promise<void> {
  if (!editorArea) return;
  try {
    const file = await window.api.fs.readFile(path);
    await editorArea.open(path, file.text, file.fingerprint, file.encoding, file.newline);
    if (line && line > 0) editorArea.revealLine(line);
    document.getElementById("welcome")?.classList.add("hidden");
  } catch (err) {
    await showMessage({ title: "打开文件失败", body: String((err as Error).message ?? err), severity: "error" });
  }
}

/** 打开远程文件夹：一次 listDir + 两次 git（§7 预算） */
async function openFolder(workspace: string): Promise<void> {
  try {
    const result = await window.api.fs.openFolder(workspace);
    appStore.set({ workspace: result.workspace, gitLabel: result.status?.label ?? "" });
    latestStatus = result.status;
    explorer?.setWorkspace(result.workspace, result.entries, result.status);
    explorer?.setStatus(result.status);
    scmView?.setStatus(result.status);
  } catch (err) {
    await showMessage({ title: "打开远程文件夹失败", body: String((err as Error).message ?? err), severity: "error" });
  }
}

/** 设置：读主进程 → 应用主题/字号/缩放/编辑器选项 */
type RawSettings = Record<string, unknown>;

function applySettings(raw: RawSettings): void {
  const theme = raw.theme === "light" ? "light" : "dark";
  const zoom = typeof raw.zoomLevel === "number" ? raw.zoomLevel : 1;
  uiStore.set({ theme, zoom });
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--zoom", String(zoom));
  if (typeof raw.fontSize === "number") {
    document.documentElement.style.setProperty("--font-size", `${raw.fontSize}px`);
  }
  if (typeof raw.uiFontFamily === "string" && raw.uiFontFamily) {
    document.documentElement.style.setProperty("--ui-font", raw.uiFontFamily);
  }
  const monaco = window.monaco;
  if (monaco) monaco.editor.setTheme(theme === "light" ? "rce-light" : "rce-dark");
  editorArea?.applySettings({
    fontSize: raw.fontSize as number | undefined,
    tabSize: raw.tabSize as number | undefined,
    wordWrap: raw.wordWrap as boolean | undefined,
    lineNumbers: raw.showLineNumbers as boolean | undefined,
    highlightCurrentLine: raw.highlightCurrentLine as boolean | undefined,
    autoSave: raw.autoSave as boolean | undefined,
    useSpaces: raw.useSpaces as boolean | undefined,
    autoSaveDelayMs: raw.autoSaveDelayMs as number | undefined,
  });
}

/** 菜单/快捷键用：切主题（仅改 UI 状态与 Monaco，不落盘；落盘由设置对话框负责） */
function setTheme(theme: "dark" | "light"): void {
  uiStore.set({ theme });
  document.documentElement.dataset.theme = theme;
  window.monaco?.editor.setTheme(theme === "light" ? "rce-light" : "rce-dark");
}

function showShortcuts(): void {
  void showMessage({ title: "快捷键一览", body: document.body.ownerDocument === document ? "见 docs/shortcuts.md" : "", severity: "info" });
}

function showAbout(): void {
  void window.api.app.version().then((v) => showMessage({ title: "关于", body: `RemoteCodeEditor ${v}\n轻量级 SSH 远程代码编辑器 · 远端零部署`, severity: "info" }));
}

async function openSettings(): Promise<void> {
  const current = await window.api.settings.get();
  openSettingsDialog(current as never, (patch) => {
    void window.api.settings.update(patch as unknown as Record<string, unknown>).then((saved) => applySettings(saved));
  });
}

async function promptOpenFolder(): Promise<void> {
  if (!appStore.get().connected) {
    await showMessage({ title: "未连接", body: "请先连接远程主机", severity: "info" });
    return;
  }
  const path = await prompt("远端路径：", appStore.get().workspace);
  if (path) await openFolder(path);
}

function prompt(label: string, value: string): Promise<string | null> {
  return import("../views/dialogs/index.js").then(({ promptDialog }) =>
    promptDialog({ title: "打开远程文件夹", body: "", label, value }));
}

function zoom(delta: number): void {
  const current = uiStore.get().zoom;
  const next = delta === 0 ? 1 : Math.min(2, Math.max(0.7, Number((current + delta).toFixed(2))));
  uiStore.set({ zoom: next });
  document.documentElement.style.setProperty("--zoom", String(next));
}

const app = document.getElementById("app");
if (app) {
  document.documentElement.dataset.theme = uiStore.get().theme;
  buildShell(app);
}
