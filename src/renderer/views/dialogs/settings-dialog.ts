// 设置对话框（分册 2 U9）：分组卡片、统一控件、sticky 底部按钮、Esc/Tab 语义由通用对话框提供
import { openDialog } from "./index.js";

interface SettingsShape {
  theme: "dark" | "light";
  uiFontFamily: string;
  fontSize: number;
  zoomLevel: number;
  tabSize: number;
  useSpaces: boolean;
  wordWrap: boolean;
  showLineNumbers: boolean;
  highlightCurrentLine: boolean;
  autoSave: boolean;
  autoSaveDelayMs: number;
  maxFileSizeMb: number;
  sshTimeoutSeconds: number;
  sshKeepaliveSeconds: number;
  sshStrictHostKey: boolean;
  lspEnabled: boolean;
  lspTransport: "local" | "remote" | "disabled";
  cppServer: string;
  pythonServer: string;
}

export type SettingsApply = SettingsShape;

/** 打开设置对话框；确定后回调（由 main.ts 负责应用主题/字号/编辑器选项） */
export function openSettingsDialog(current: SettingsShape, onApply: (patch: SettingsApply) => void): void {
  const draft: SettingsShape = { ...current };
  const content = document.createElement("div");
  content.className = "settings-content";

  const appearance = section("外观", "主题、界面字体和缩放。 ");
  appearance.body.append(
    field("主题", select("settings-theme", [["dark", "深色"], ["light", "浅色"]], draft.theme, (v) => { draft.theme = v === "light" ? "light" : "dark"; })),
    field("界面字体", text("settings-ui-font", draft.uiFontFamily, "留空使用系统界面字体", (v) => { draft.uiFontFamily = v; })),
    field("界面字号", number("settings-font-size", draft.fontSize, 8, 32, (v) => { draft.fontSize = v; }), "8～32 px。"),
  );

  const editor = section("编辑器", "影响 Monaco 编辑器。 ");
  const autoSaveDelay = number("settings-auto-save-delay", draft.autoSaveDelayMs, 500, 30000, (v) => { draft.autoSaveDelayMs = v; });
  autoSaveDelay.disabled = !draft.autoSave;
  editor.body.append(
    field("缩进宽度", number("settings-tab-size", draft.tabSize, 1, 16, (v) => { draft.tabSize = v; })),
    field("使用空格缩进", toggle("settings-use-spaces", draft.useSpaces, (v) => { draft.useSpaces = v; })),
    field("自动换行", toggle("settings-word-wrap", draft.wordWrap, (v) => { draft.wordWrap = v; })),
    field("显示行号", toggle("settings-line-numbers", draft.showLineNumbers, (v) => { draft.showLineNumbers = v; })),
    field("高亮当前行", toggle("settings-current-line", draft.highlightCurrentLine, (v) => { draft.highlightCurrentLine = v; })),
    field("自动保存", toggle("settings-auto-save", draft.autoSave, (v) => { draft.autoSave = v; autoSaveDelay.disabled = !v; }), "停止输入后自动上传远端。"),
    field("自动保存延迟（ms）", autoSaveDelay, "500～30000 ms。"),
  );

  const files = section("文件", "大文件保护。 ");
  files.body.append(
    field("最大打开文件（MB）", number("settings-max-file", draft.maxFileSizeMb, 1, 512, (v) => { draft.maxFileSizeMb = v; })),
  );

  const ssh = section("SSH", "连接超时和主机密钥校验。 ");
  ssh.body.append(
    field("连接超时（秒）", number("settings-ssh-timeout", draft.sshTimeoutSeconds, 3, 300, (v) => { draft.sshTimeoutSeconds = v; })),
    field("Keepalive（秒）", number("settings-keepalive", draft.sshKeepaliveSeconds, 0, 300, (v) => { draft.sshKeepaliveSeconds = v; }), "0 表示关闭。"),
    field("严格校验 known_hosts", toggle("settings-strict-host", draft.sshStrictHostKey, (v) => { draft.sshStrictHostKey = v; })),
  );

  const lsp = section("语言服务", "默认在工作机运行并指向本地镜像，目标机零常驻服务。 ");
  lsp.body.append(
    field("语言服务位置", select("settings-lsp-transport", [["local", "本机（默认）"], ["remote", "板子上（备用）"], ["disabled", "关闭"]], draft.lspTransport, (v) => {
      draft.lspTransport = v === "remote" ? "remote" : v === "disabled" ? "disabled" : "local";
    }), "「板子上」只拉起你自己已安装的服务；连接断开即退出。"),
    field("启用代码补全", toggle("settings-lsp-enabled", draft.lspEnabled, (v) => { draft.lspEnabled = v; })),
    field("C++ 服务器路径", text("settings-cpp-server", draft.cppServer, "留空使用内置 clangd", (v) => { draft.cppServer = v; })),
    field("Python 服务器路径", text("settings-python-server", draft.pythonServer, "默认：python3 -m pylsp", (v) => { draft.pythonServer = v; })),
  );

  content.append(appearance.root, editor.root, files.root, ssh.root, lsp.root);
  const dialog = openDialog({
    title: "设置",
    body: content,
    className: "settings-box",
    initialFocus: content.querySelector("select"),
    onCancel: () => { /* 不保存 */ },
  });

  const cancel = button("取消", "secondary");
  const ok = button("确定", "primary");
  const apply = (): void => {
    dialog.close();
    onApply({ ...draft });
  };
  cancel.onclick = () => dialog.close();
  ok.onclick = apply;
  dialog.box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      apply();
    }
  });
  dialog.buttonRow.append(cancel, ok);
}

function section(title: string, description: string): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement("section");
  root.className = "settings-section";
  const head = document.createElement("div");
  head.className = "settings-section-head";
  const h = document.createElement("h2");
  h.textContent = title;
  const desc = document.createElement("p");
  desc.textContent = description;
  head.append(h, desc);
  const body = document.createElement("div");
  body.className = "settings-grid";
  root.append(head, body);
  return { root, body };
}

function field(labelText: string, control: HTMLElement, hint = ""): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-row";
  const label = document.createElement("label");
  label.className = "settings-label";
  label.textContent = labelText;
  if (control.id) label.htmlFor = control.id;
  const right = document.createElement("div");
  right.className = "settings-control";
  right.appendChild(control);
  if (hint) {
    const hintEl = document.createElement("div");
    hintEl.className = "settings-hint";
    hintEl.textContent = hint;
    right.appendChild(hintEl);
  }
  wrap.append(label, right);
  return wrap;
}

function text(id: string, value: string, placeholder: string, onChange: (value: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "ui-input";
  input.id = id;
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.oninput = () => onChange(input.value);
  return input;
}

function number(id: string, value: number, min: number, max: number, onChange: (value: number) => void): HTMLInputElement {
  const input = text(id, String(value), "", () => { /* change 里处理 */ });
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.onchange = () => {
    const next = Number(input.value);
    if (Number.isFinite(next) && next >= min && next <= max) onChange(Math.round(next));
    else input.value = String(value);
  };
  return input;
}

function toggle(id: string, checked: boolean, onChange: (value: boolean) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "ui-switch";
  input.id = id;
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("role", "switch");
  input.onchange = () => onChange(input.checked);
  return input;
}

function select(id: string, options: Array<[string, string]>, value: string, onChange: (value: string) => void): HTMLSelectElement {
  const input = document.createElement("select");
  input.className = "ui-select";
  input.id = id;
  for (const [optionValue, label] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    input.appendChild(option);
  }
  input.value = value;
  input.onchange = () => onChange(input.value);
  return input;
}

function button(label: string, variant: "primary" | "secondary"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `dialog-btn ui-btn ${variant}`;
  btn.textContent = label;
  return btn;
}
