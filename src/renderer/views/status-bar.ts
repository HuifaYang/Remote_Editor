// 状态栏（分册 2 U1）：左侧连接/文件/Git，右侧保存/编码/语言/行列；可点击项使用按钮语义
import { appStore } from "../app/store.js";
import { icon } from "../app/icons.js";

export interface StatusBarApi {
  setTabName(name: string): void;
}

interface StatusCell {
  root: HTMLButtonElement | HTMLSpanElement;
  text: HTMLElement;
  set(value: string, clickable?: boolean): void;
}

export function mountStatusBar(container: HTMLElement, actions?: { onConnections?: () => void; onFiles?: () => void; onGit?: () => void }): StatusBarApi {
  const bar = document.createElement("div");
  bar.className = "status-bar";
  bar.setAttribute("role", "status");

  const conn = cell("plug", "连接状态", () => actions?.onConnections?.());
  const file = cell("files", "当前文件", () => actions?.onFiles?.());
  const git = cell("source-control", "Git 分支", () => actions?.onGit?.());
  const left = document.createElement("div");
  left.className = "status-group left";
  left.append(conn.root, file.root, git.root);

  const stale = staticCell("warning", "镜像可能过期，按 F5 同步");
  stale.root.classList.add("warning");
  const saveState = staticCell("save", "");
  const encoding = staticCell("", "");
  const language = staticCell("", "");
  const position = staticCell("", "");
  const right = document.createElement("div");
  right.className = "status-group right";
  right.append(stale.root, saveState.root, encoding.root, language.root, position.root);

  bar.append(left, right);
  container.appendChild(bar);

  let currentTabName = "";
  const render = (): void => {
    const s = appStore.get();
    conn.set(s.connected ? `已连接 · ${s.hostName}` : "未连接", true);
    file.set(currentTabName, Boolean(currentTabName));
    git.set(s.connected && s.gitLabel ? s.gitLabel : "", Boolean(s.gitLabel));
    stale.root.classList.toggle("hidden", !s.mirrorStale);
    saveState.set(saveLabel(s.saveState, s.saveMessage));
    encoding.set(currentTabName ? s.encoding : "");
    language.set(currentTabName ? s.language : "");
    position.set(currentTabName ? `行 ${s.line}，列 ${s.column}` : "");
  };

  appStore.subscribe(render);
  render();

  return {
    setTabName(name: string): void {
      currentTabName = name;
      render();
    },
  };
}

function cell(iconName: string, label: string, onClick: () => void): StatusCell {
  const root = document.createElement("button");
  root.type = "button";
  root.className = "status-item status-button";
  root.title = label;
  root.setAttribute("aria-label", label);
  root.appendChild(icon(iconName, label));
  const text = document.createElement("span");
  text.className = "status-text";
  root.appendChild(text);
  root.onclick = onClick;
  return {
    root,
    text,
    set(value, clickable = true): void {
      text.textContent = value;
      root.classList.toggle("hidden", !value);
      root.disabled = !clickable;
    },
  };
}

function staticCell(iconName: string, value: string): StatusCell {
  const root = document.createElement("span");
  root.className = "status-item";
  if (iconName) root.appendChild(icon(iconName, value));
  const text = document.createElement("span");
  text.className = "status-text";
  root.appendChild(text);
  return {
    root,
    text,
    set(next): void {
      text.textContent = next;
      root.classList.toggle("hidden", !next);
    },
  };
}

function saveLabel(state: string, message: string): string {
  switch (state) {
    case "dirty": return "未保存";
    case "saving": return "自动保存中…";
    case "failed": return message ? `自动保存失败：${message}` : "保存失败";
    default: return "已保存";
  }
}
