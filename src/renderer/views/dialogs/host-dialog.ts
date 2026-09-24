// 主机编辑表单（U5 的补齐）：一次展示全部字段，密码/口令仍只允许在底部凭据行输入
import type { HostConfig } from "../../../shared/types.js";
import { openDialog } from "./index.js";

export interface HostRecordForm extends HostConfig {
  workspaces: string[];
}

export interface HostDialogResult {
  host: HostRecordForm;
  connect: boolean;
}

interface FieldRefs {
  wrap: HTMLElement;
  error: HTMLElement;
}

/** 打开主机编辑对话框；返回 null 表示取消。 */
export async function openHostDialog(existing?: HostRecordForm): Promise<HostDialogResult | null> {
  const localKeys = await window.api.host.listLocalKeys().catch(() => []);

  return new Promise((resolve) => {
    let done = false;
    const finish = (value: HostDialogResult | null): void => {
      if (done) return;
      done = true;
      dialog.close();
      resolve(value);
    };

    const form = document.createElement("form");
    form.className = "host-form";
    form.noValidate = true;

    const name = input("host-name", "例如：RK3566 开发板", existing?.name ?? "");
    const host = input("host-address", "例如：192.168.1.100 或 board.local", existing?.host ?? "");
    const port = input("host-port", "22", String(existing?.port ?? 22));
    port.type = "number";
    port.min = "1";
    port.max = "65535";
    const username = input("host-username", "root", existing?.username ?? "root");
    const auth = document.createElement("select");
    auth.className = "ui-select";
    auth.id = "host-auth";
    auth.append(option("password", "密码"), option("key", "私钥"));
    auth.value = existing?.authMethod ?? "password";

    const keySelect = document.createElement("select");
    keySelect.className = "ui-select host-key-select";
    keySelect.append(option("", "选择本机私钥…"), ...localKeys.map((k) => option(k.path, `${k.label}（${k.path}）`)), option("custom", "手动输入路径…"));
    const keyPath = input("host-key-path", "~/.ssh/id_ed25519", existing?.privateKeyPath ?? "");
    if (existing?.privateKeyPath && localKeys.some((k) => k.path === existing.privateKeyPath)) keySelect.value = existing.privateKeyPath;
    else if (existing?.privateKeyPath) keySelect.value = "custom";
    keySelect.onchange = () => {
      if (keySelect.value && keySelect.value !== "custom") keyPath.value = keySelect.value;
      if (keySelect.value === "custom") keyPath.focus();
    };
    const keyControl = document.createElement("div");
    keyControl.className = "host-key-controls";
    keyControl.append(keySelect, keyPath);

    const workspace = input("host-workspace", "例如：/home/root/project（可留空）", existing?.workspace ?? existing?.workspaces?.[0] ?? "");

    const nameField = field("显示名", name, "本机列表里显示的名称。");
    const hostField = field("主机地址", host, "只填 IP/域名，不要把用户名写在这里。");
    const portField = field("端口", port, "默认 22。");
    const userField = field("用户名", username, "SSH 登录用户。");
    const authField = field("认证方式", auth, "密码不会在配置里保存，连接时才输入。");
    const keyField = field("私钥", keyControl, "私钥路径只保存路径，不保存私钥口令。");
    keyField.wrap.classList.add("host-key-row");
    const workspaceField = field("默认工作目录", workspace, "连接成功后默认打开的远端目录。");

    form.append(
      nameField.wrap,
      hostField.wrap,
      twoColumns(portField.wrap, userField.wrap),
      authField.wrap,
      keyField.wrap,
      workspaceField.wrap,
    );
    const syncAuth = (): void => { keyField.wrap.classList.toggle("hidden", auth.value !== "key"); };
    auth.onchange = syncAuth;
    syncAuth();

    const dialog = openDialog({
      title: existing ? "编辑主机" : "新增主机",
      body: form,
      className: "host-dialog",
      initialFocus: name,
      onCancel: () => finish(null),
    });

    const cancel = dialogButton("取消", "secondary");
    const save = dialogButton("保存", "default");
    const saveConnect = dialogButton("保存并连接", "primary");
    cancel.onclick = () => finish(null);
    save.onclick = () => submit(false);
    saveConnect.onclick = () => submit(true);
    form.onsubmit = (event) => {
      event.preventDefault();
      submit(false);
    };
    dialog.buttonRow.append(cancel, save, saveConnect);

    function submit(connect: boolean): void {
      clearErrors();
      const parsedPort = Number(port.value);
      const errors: Array<[FieldRefs, string, HTMLElement]> = [];
      if (!name.value.trim()) errors.push([nameField, "请输入显示名", name]);
      if (!host.value.trim()) errors.push([hostField, "请输入主机地址", host]);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) errors.push([portField, "端口必须是 1~65535", port]);
      if (!username.value.trim()) errors.push([userField, "请输入用户名", username]);
      if (auth.value === "key" && !keyPath.value.trim()) errors.push([keyField, "请选择或输入私钥路径", keyPath]);
      if (errors.length > 0) {
        for (const [f, message] of errors) {
          f.wrap.classList.add("error");
          f.error.textContent = message;
        }
        errors[0][2].focus();
        return;
      }
      const record: HostRecordForm = {
        id: existing?.id ?? globalThis.crypto?.randomUUID?.() ?? `host-${Date.now()}`,
        name: name.value.trim(),
        host: host.value.trim(),
        port: parsedPort,
        username: username.value.trim(),
        authMethod: auth.value === "key" ? "key" : "password",
        workspace: workspace.value.trim(),
        workspaces: existing?.workspaces ? [...existing.workspaces] : (workspace.value.trim() ? [workspace.value.trim()] : []),
        lastUsedAt: existing?.lastUsedAt,
      };
      if (auth.value === "key") record.privateKeyPath = keyPath.value.trim();
      finish({ host: record, connect });
    }

    function clearErrors(): void {
      for (const f of [nameField, hostField, portField, userField, keyField]) {
        f.wrap.classList.remove("error");
        f.error.textContent = "";
      }
    }
  });
}

function input(id: string, placeholder: string, value: string): HTMLInputElement {
  const el = document.createElement("input");
  el.className = "ui-input";
  el.id = id;
  el.placeholder = placeholder;
  el.value = value;
  return el;
}

function option(value: string, label: string): HTMLOptionElement {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}

function field(labelText: string, control: HTMLElement, hint: string): FieldRefs {
  const wrap = document.createElement("div");
  wrap.className = "ui-field";
  const label = document.createElement("label");
  label.className = "ui-field-label";
  label.textContent = labelText;
  if (control.id) label.htmlFor = control.id;
  const controlWrap = document.createElement("div");
  controlWrap.className = "ui-field-control";
  controlWrap.appendChild(control);
  const hintEl = document.createElement("div");
  hintEl.className = "ui-field-hint";
  hintEl.textContent = hint;
  const error = document.createElement("div");
  error.className = "ui-field-error";
  wrap.append(label, controlWrap, hintEl, error);
  return { wrap, error };
}

function twoColumns(left: HTMLElement, right: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "host-form-grid";
  left.classList.remove("ui-field");
  right.classList.remove("ui-field");
  left.classList.add("host-grid-field");
  right.classList.add("host-grid-field");
  row.append(left, right);
  return row;
}

function dialogButton(label: string, variant: "primary" | "secondary" | "default"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `dialog-btn ui-btn ${variant}`;
  btn.textContent = label;
  return btn;
}
