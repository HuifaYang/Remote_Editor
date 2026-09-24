// 远程主机（分册 2 U5）：SSH 分组树 + 历史工作目录 + 底部凭据行；连接状态、断开和主机表单都在面板内完成
import type { HostConfig } from "../../shared/types.js";
import { icon } from "../app/icons.js";
import { confirmDialog, promptDialog, showMessage } from "./dialogs/index.js";
import { openHostDialog } from "./dialogs/host-dialog.js";
import { appStore } from "../app/store.js";
import { emptyState, spinner, uiButton, uiIconButton } from "./ui.js";

/** 与 preload 的 HostRecord 一致（含历史工作目录） */
interface HostRecord extends HostConfig {
  workspaces: string[];
}

export interface HostsViewDeps {
  /** 连接成功（或点了历史目录）→ 打开工作目录 */
  onOpenFolder: (hostId: string, workspace: string) => void;
}

export class HostsView {
  private hosts: HostRecord[] = [];
  private pending: { hostId: string; kind: "password" | "passphrase" } | null = null;
  private connectedHostId: string | null = null;
  private connectingHostId: string | null = null;
  private loading = false;
  private loadError = "";

  constructor(private readonly body: HTMLElement, private readonly deps: HostsViewDeps) {
    this.body.classList.add("hosts-view");
    window.api.on("event:auth-required", (p) => this.showCredentialRow(p.hostId, p.kind));
    this.render();   // 面板必须先有结构和操作，不能等 host.list 返回
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.loadError = "";
    this.render();
    try {
      this.hosts = await window.api.host.list();
    } catch (err) {
      this.hosts = [];
      this.loadError = String((err as Error).message ?? err);
    } finally {
      this.loading = false;
    }
    this.render();
  }

  /** 供欢迎页“最近主机”直接触发连接 */
  async connectHost(hostId: string, workspace?: string): Promise<void> {
    if (this.hosts.length === 0) {
      try { this.hosts = await window.api.host.list(); } catch { /* connect 的错误路径会提示 */ }
    }
    await this.connect(hostId, workspace);
  }

  private render(): void {
    this.body.textContent = "";

    const connected = appStore.get().connected;
    const connectedHost = connected
      ? this.hosts.find((h) => h.id === this.connectedHostId) ?? this.hosts.find((h) => h.name === appStore.get().hostName) ?? null
      : null;
    if (!connected) this.connectedHostId = null;
    if (connectedHost) this.connectedHostId = connectedHost.id;
    if (connectedHost) this.body.appendChild(this.connectedBanner(connectedHost));

    const list = document.createElement("div");
    list.className = "hosts-list";
    if (this.loading) {
      list.appendChild(spinner("正在读取主机…"));
    } else if (this.loadError) {
      list.appendChild(emptyState({
        icon: "warning",
        title: "主机列表读取失败",
        description: this.loadError,
        actionLabel: "重试",
        onAction: () => void this.refresh(),
      }));
    } else if (this.hosts.length === 0) {
      list.appendChild(emptyState({
        icon: "plug",
        title: "还没有主机",
        description: "新增一台 SSH 主机，或从本机 ~/.ssh/config 导入。",
      }));
    } else {
      list.appendChild(this.groupHeader());
      for (const host of this.hosts) {
        list.appendChild(this.hostRow(host));
        for (const workspace of host.workspaces) list.appendChild(this.workspaceRow(host, workspace));
      }
    }
    this.body.appendChild(list);

    if (this.pending) this.body.appendChild(this.credentialRow(this.pending.hostId, this.pending.kind));
    this.body.appendChild(this.footer());
  }

  private connectedBanner(host: HostRecord): HTMLElement {
    const row = document.createElement("div");
    row.className = "host-connected";
    row.appendChild(icon("plug", host.name));
    const text = document.createElement("div");
    text.className = "host-connected-text";
    const title = document.createElement("div");
    title.textContent = `已连接：${host.name}`;
    const target = document.createElement("div");
    target.className = "muted";
    target.textContent = `${host.username}@${host.host}:${host.port}`;
    text.append(title, target);
    const disconnect = uiButton({ label: "断开", variant: "secondary", icon: "debug-disconnect", onClick: () => void this.disconnect() });
    row.append(text, disconnect);
    return row;
  }

  private groupHeader(): HTMLElement {
    const row = document.createElement("div");
    row.className = "hosts-group";
    row.appendChild(icon("list-tree", "SSH"));
    const label = document.createElement("span");
    label.textContent = "SSH";
    const count = document.createElement("span");
    count.className = "ui-badge";
    count.textContent = String(this.hosts.length);
    row.append(label, count);
    return row;
  }

  private hostRow(host: HostRecord): HTMLElement {
    const row = document.createElement("div");
    const connected = this.connectedHostId === host.id;
    const connecting = this.connectingHostId === host.id;
    row.className = `host-row${connected ? " connected" : ""}${connecting ? " connecting" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `连接 ${host.name}`);

    const hostIcon = icon("plug", host.name);
    hostIcon.classList.add("host-icon");
    const main = document.createElement("div");
    main.className = "host-main";
    const nameLine = document.createElement("div");
    nameLine.className = "host-name-line";
    const name = document.createElement("span");
    name.className = "host-name";
    name.textContent = host.name;
    nameLine.appendChild(name);
    if (connected) {
      const badge = document.createElement("span");
      badge.className = "ui-badge success";
      badge.textContent = "已连接";
      nameLine.appendChild(badge);
    }
    const target = document.createElement("span");
    target.className = "host-target";
    target.textContent = `${host.username}@${host.host}:${host.port}`;
    main.append(nameLine, target);

    const actions = document.createElement("div");
    actions.className = "host-actions";
    if (connecting) actions.appendChild(spinner("连接中…"));
    else {
      actions.append(
        uiIconButton({ icon: "plug", label: "连接", title: `连接 ${host.name}`, onClick: (e) => { e.stopPropagation(); void this.connect(host.id); } }),
        uiIconButton({ icon: "edit", label: "编辑主机", onClick: (e) => { e.stopPropagation(); void this.editHost(host); } }),
        uiIconButton({ icon: "trash", label: "删除主机", danger: true, onClick: (e) => { e.stopPropagation(); void this.removeHost(host); } }),
      );
    }
    row.append(hostIcon, main, actions);
    row.onclick = () => void this.connect(host.id);
    row.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void this.connect(host.id);
      }
    };
    return row;
  }

  private workspaceRow(host: HostRecord, workspace: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "host-workspace";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = `连接 ${host.name} 并打开 ${workspace}`;
    row.appendChild(icon("history", workspace));
    const path = document.createElement("span");
    path.textContent = workspace;
    row.appendChild(path);
    const run = (): void => void this.connect(host.id, workspace);
    row.onclick = run;
    row.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        run();
      }
    };
    return row;
  }

  private footer(): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "hosts-footer";
    footer.append(
      uiButton({ label: "新增主机…", variant: "primary", icon: "add", onClick: () => void this.addHost() }),
      uiButton({ label: "导入配置", variant: "secondary", icon: "cloud-download", title: "从 ~/.ssh/config 导入", onClick: () => void this.importSshConfig() }),
    );
    return footer;
  }

  /** 底部凭据行：密码 / 私钥口令（§5.1，禁止弹居中对话框） */
  showCredentialRow(hostId: string, kind: "password" | "passphrase", keep = false): void {
    if (!keep) this.pending = { hostId, kind };
    this.render();
    setTimeout(() => this.body.querySelector<HTMLInputElement>(".credential-input")?.focus(), 0);
  }

  private credentialRow(hostId: string, kind: "password" | "passphrase"): HTMLElement {
    const row = document.createElement("div");
    row.className = "credential-row";
    const label = document.createElement("label");
    label.className = "credential-label";
    label.textContent = kind === "password" ? "密码" : "私钥口令";
    const input = document.createElement("input");
    input.className = "credential-input ui-input";
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = kind === "password" ? "输入密码后回车连接" : "输入口令后回车连接";
    label.htmlFor = input.id = `credential-${hostId}`;
    const hint = document.createElement("div");
    hint.className = "credential-hint muted";
    hint.textContent = kind === "password" ? "本机私钥未被接受，输入密码后回车连接" : "该私钥有口令，输入后回车连接（无口令可留空）";
    const submit = async (): Promise<void> => {
      const value = input.value;
      input.value = "";
      await this.connect(hostId, undefined, kind === "password" ? { password: value } : { passphrase: value });
    };
    input.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
    const connect = uiButton({ label: "连接", variant: "primary", onClick: () => void submit() });
    row.append(label, input, connect, hint);
    return row;
  }

  private async connect(hostId: string, workspace?: string, secret?: { password?: string; passphrase?: string }): Promise<void> {
    if (this.connectingHostId) return;
    this.connectingHostId = hostId;
    this.render();
    try {
      const result = await window.api.host.connect(hostId, secret);
      this.pending = null;
      this.connectedHostId = hostId;
      const host = this.hosts.find((h) => h.id === hostId);
      appStore.set({ connected: true, hostName: host?.name ?? "", mirrorStale: true });
      const target = workspace ?? result.workspace ?? host?.workspace ?? "";
      if (target) this.deps.onOpenFolder(hostId, target);
      else {
        const picked = await promptDialog({ title: "打开远程文件夹", body: "", label: "远端路径：", value: host?.workspace ?? "~" });
        if (picked) this.deps.onOpenFolder(hostId, picked);
      }
      await this.refresh();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "auth" && code !== "auth-passphrase-required") {
        await showMessage({ title: "连接失败", body: String((err as Error).message ?? err), severity: "error" });
      }
    } finally {
      this.connectingHostId = null;
      this.render();
    }
  }

  private async disconnect(): Promise<void> {
    await window.api.host.disconnect().catch(() => { /* 主进程会继续上报状态 */ });
    this.connectedHostId = null;
    appStore.set({ connected: false, hostName: "", workspace: "", gitLabel: "" });
    this.render();
  }

  private async addHost(): Promise<void> {
    const result = await openHostDialog();
    if (!result) return;
    await window.api.host.save(result.host);
    await this.refresh();
    if (result.connect) await this.connect(result.host.id, result.host.workspace || undefined);
  }

  private async editHost(host: HostRecord): Promise<void> {
    const result = await openHostDialog(host);
    if (!result) return;
    await window.api.host.save(result.host);
    await this.refresh();
    if (result.connect) await this.connect(result.host.id, result.host.workspace || undefined);
  }

  private async removeHost(host: HostRecord): Promise<void> {
    const ok = await confirmDialog({
      title: "删除主机",
      body: `确定删除「${host.name}」吗？\n（只删除本机配置，不影响远端任何文件）`,
      okText: "删除", danger: true, severity: "warning",
    });
    if (!ok) return;
    await window.api.host.remove(host.id);
    if (this.connectedHostId === host.id) await this.disconnect();
    await this.refresh();
  }

  private async importSshConfig(): Promise<void> {
    const parsed = await window.api.host.importSshConfig();
    if (parsed.length === 0) {
      await showMessage({ title: "导入", body: "没有在 ~/.ssh/config 里找到可用主机", severity: "info" });
      return;
    }
    for (const item of parsed) {
      await window.api.host.save({
        id: globalThis.crypto?.randomUUID?.() ?? `host-${item.name}-${Date.now()}`,
        name: item.name, host: item.host, port: item.port || 22,
        username: item.username || "root",
        authMethod: item.identityFile ? "key" : "password",
        privateKeyPath: item.identityFile,
        workspaces: [],
      });
    }
    await this.refresh();
    await showMessage({ title: "导入完成", body: `已导入 ${parsed.length} 台主机。`, severity: "info" });
  }
}
