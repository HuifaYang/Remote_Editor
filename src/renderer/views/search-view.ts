// 搜索（分册 2 U3）：查询行 + 选项开关 + 状态行 + 按文件分组的结果（命中片段高亮）
import type { SearchMatch } from "../../shared/types.js";
import { appStore } from "../app/store.js";
import { emptyState, spinner, uiIconButton } from "./ui.js";

export interface SearchViewDeps {
  onOpenFile: (path: string, line: number) => void;
  onConnect?: () => void;
}

/** 命中片段的切分（纯函数，单测覆盖）：区分大小写 / 正则两种模式都算得出位置 */
export function splitHighlight(text: string, pattern: string, caseSensitive: boolean, regex: boolean): Array<{ text: string; hit: boolean }> {
  if (!pattern) return [{ text, hit: false }];
  let re: RegExp;
  try {
    re = regex
      ? new RegExp(pattern, caseSensitive ? "g" : "gi")
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
  } catch {
    throw new Error("正则表达式无效");
  }
  const out: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index === undefined || m[0] === "") break;
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}

export class SearchView {
  private pattern = "";
  private caseSensitive = false;
  private regex = false;
  private results: SearchMatch[] = [];
  private state = "";

  constructor(private readonly body: HTMLElement, private readonly deps: SearchViewDeps) {
    this.body.classList.add("search-view");
    this.render();
    queueMicrotask(() => this.body.querySelector<HTMLInputElement>(".search-input")?.focus());
  }

  private render(): void {
    this.body.textContent = "";
    const row = document.createElement("div");
    row.className = "search-row";
    const input = document.createElement("input");
    input.className = "search-input";
    input.placeholder = "在文件中搜索";
    input.type = "search";
    input.value = this.pattern;
    input.oninput = () => { this.pattern = input.value; };
    input.onkeydown = (e) => { if (e.key === "Enter") void this.run(); };

    const clear = uiIconButton({
      icon: "close",
      label: "清除",
      onClick: () => {
      this.pattern = "";
      this.results = [];
      this.state = "";
      this.render();
      },
    });
    clear.classList.toggle("hidden", !this.pattern);

    const aa = document.createElement("button");
    aa.className = "search-toggle" + (this.caseSensitive ? " active" : "");
    aa.textContent = "Aa";
    aa.onclick = () => { this.caseSensitive = !this.caseSensitive; void this.run(); };

    const re = document.createElement("button");
    re.className = "search-toggle" + (this.regex ? " active" : "");
    re.textContent = ".*";
    re.title = "使用正则表达式";
    re.onclick = () => { this.regex = !this.regex; void this.run(); };

    const refresh = uiIconButton({ icon: "refresh", label: "重新搜索", onClick: () => void this.run() });

    row.append(input, clear);
    const options = document.createElement("div");
    options.className = "search-options";
    aa.title = "区分大小写";
    options.append(aa, re, refresh);
    this.body.append(row, options);

    const status = document.createElement("div");
    status.className = `search-status muted${this.state ? "" : " hidden"}`;
    status.textContent = this.state;
    status.setAttribute("aria-live", "polite");
    this.body.appendChild(status);

    if (this.results.length === 0) {
      this.body.appendChild(this.emptyState());
      return;
    }
    const files = groupByFile(this.results);
    for (const [path, matches] of files) {
      const group = document.createElement("div");
      group.className = "search-group";
      const head = document.createElement("div");
      head.className = "search-group-head";
      const name = document.createElement("span");
      name.className = "search-file";
      name.textContent = path.split("/").pop() ?? path;
      const count = document.createElement("span");
      count.className = "muted";
      count.textContent = `（${matches.length}）`;
      const dir = document.createElement("span");
      dir.className = "muted";
      dir.textContent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      head.append(name, count, dir);
      group.appendChild(head);
      for (const match of matches) {
        const line = document.createElement("div");
        line.className = "search-hit";
        line.title = `${match.path}:${match.line}`;
        line.onclick = () => this.deps.onOpenFile(match.path, match.line);
        const pos = document.createElement("span");
        pos.className = "muted";
        pos.textContent = `行 ${match.line}：`;
        line.appendChild(pos);
        try {
          for (const part of splitHighlight(match.text, this.pattern, this.caseSensitive, this.regex)) {
            const span = document.createElement("span");
            span.textContent = part.text;
            if (part.hit) span.className = "hit";
            line.appendChild(span);
          }
        } catch {
          line.appendChild(document.createTextNode(match.text));
        }
        group.appendChild(line);
      }
      this.body.appendChild(group);
    }
  }

  private emptyState(): HTMLElement {
    if (!appStore.get().connected) {
      return emptyState({
        icon: "search",
        title: "请先连接主机",
        description: "连接远程主机并打开工作目录后，才能在工作区中搜索。",
        actionLabel: "连接主机…",
        onAction: () => this.deps.onConnect?.(),
      });
    }
    if (this.state === "正在搜索…") return spinner("正在搜索…");
    if (this.state.startsWith("搜索失败")) {
      return emptyState({ icon: "warning", title: "搜索失败", description: this.state.replace(/^搜索失败：/, "") });
    }
    if (this.pattern && this.state === "未找到") {
      return emptyState({ icon: "search", title: "未找到", description: `没有匹配「${this.pattern}」的内容。` });
    }
    return emptyState({ icon: "search", title: "搜索工作区", description: "输入关键字后按 Enter；打开面板本身不会发起远端请求。" });
  }

  /** 测试用：直接注入结果 */
  setResults(items: SearchMatch[]): void {
    this.results = items;
    this.state = "";
    this.render();
  }

  setCaseSensitive(value: boolean): void {
    this.caseSensitive = value;
    this.render();
  }

  /** 回车才发请求（打开面板 0 远端请求） */
  private async run(): Promise<void> {
    if (!appStore.get().connected) {
      this.state = "请先连接主机，再搜索";
      this.results = [];
      this.render();
      return;
    }
    if (!this.pattern) {
      this.state = "";
      this.results = [];
      this.render();
      return;
    }
    this.state = "正在搜索…";
    this.render();
    try {
      this.results = await window.api.search.find(this.pattern, { caseSensitive: this.caseSensitive, regex: this.regex });
      const files = new Set(this.results.map((r) => r.path)).size;
      this.state = this.results.length === 0 ? "未找到" : `${this.results.length} 处结果，分布在 ${files} 个文件中`;
    } catch (err) {
      this.results = [];
      this.state = `搜索失败：${String((err as Error).message ?? err)}`;
    }
    this.render();
  }
}

function groupByFile(matches: SearchMatch[]): Map<string, SearchMatch[]> {
  const map = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const list = map.get(m.path) ?? [];
    list.push(m);
    map.set(m.path, list);
  }
  return map;
}
