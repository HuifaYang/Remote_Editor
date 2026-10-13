// VS Code 原生「远程资源管理器」数据源。
//
// 界面不是我们自己画的：这里只向内置的 remoteTargets TreeView 提供数据和命令，
// 容器、图标、标题栏、悬停按钮、右键菜单、折叠和字体全部由 CodeOSS / VS Code 渲染。
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const VIEW_ID = "remoteTargets";
const HISTORY_KEY = "rce.remote.folderHistory";

function defaultSshConfigPath() {
  return path.join(os.homedir(), ".ssh", "config");
}

function sshConfigPath(vscode) {
  const configured = vscode.workspace.getConfiguration("remote.SSH").get("configFile");
  return configured && String(configured).trim() ? path.resolve(String(configured).trim()) : defaultSshConfigPath();
}

function parseTarget(raw) {
  let text = String(raw || "").trim();
  if (!text) return undefined;
  if (text.startsWith("ssh ")) text = text.slice(4).trim();

  const tokens = text.split(/\s+/).filter(Boolean);
  let username;
  let port = 22;
  let endpoint;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-p" && tokens[i + 1]) {
      port = Number(tokens[++i]) || 22;
      continue;
    }
    if (token === "-l" && tokens[i + 1]) {
      username = tokens[++i];
      continue;
    }
    if (!token.startsWith("-")) endpoint = token;
  }
  if (!endpoint) return undefined;

  let host = endpoint;
  const at = host.lastIndexOf("@");
  if (at >= 0) {
    username = host.slice(0, at);
    host = host.slice(at + 1);
  }

  // 支持 user@host:2222；IPv6 需要写成 [::1]:2222。
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
      port = Number(host.slice(colon + 1));
      host = host.slice(0, colon);
    }
  }

  if (!host) return undefined;
  return { host, username: username || process.env.USER || "root", port: port || 22 };
}

async function readSshHosts(vscode) {
  const file = sshConfigPath(vscode);
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const hosts = [];
  let current;
  const finish = () => {
    if (!current) return;
    for (const alias of current.aliases) {
      if (!alias || alias.includes("*") || alias.startsWith("!")) continue;
      hosts.push({
        label: alias,
        hostName: current.hostName || alias,
        username: current.username || process.env.USER || "root",
        port: current.port || 22,
        identityFile: current.identityFile || "",
        preferredAuthentications: current.preferredAuthentications || "",
        source: file,
      });
    }
    current = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "host") {
      finish();
      current = { aliases: value.split(/\s+/), hostName: "", username: "", port: 22, identityFile: "", preferredAuthentications: "" };
      continue;
    }
    if (!current) continue;
    if (key === "hostname") current.hostName = value;
    else if (key === "user") current.username = value;
    else if (key === "port") current.port = Number(value) || 22;
    else if (key === "identityfile") current.identityFile = value.replace(/^~(?=$|\/)/, os.homedir());
    else if (key === "preferredauthentications") current.preferredAuthentications = value.toLowerCase();
  }
  finish();
  return hosts;
}

function hostSpecKey(spec) {
  return `${spec.username || ""}@${spec.hostName || spec.label}:${spec.port || 22}`;
}

function sessionMatchesHost(session, host) {
  const spec = session?.spec || {};
  if (!spec.host) return false;
  const userHost = `${spec.username || ""}@${spec.host}`;
  return spec.host === host.hostName
    || spec.host === host.label
    || userHost === host.hostName
    || userHost === host.label
    || (spec.username === host.username && spec.host === host.hostName && (spec.port || 22) === (host.port || 22));
}

function folderName(folder) {
  return path.posix.basename(folder.replace(/\/+$/, "")) || folder;
}

class RemoteExplorerProvider {
  constructor(vscode, deps) {
    this.vscode = vscode;
    this.deps = deps;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._history = deps.context.globalState.get(HISTORY_KEY, []);
    this._collapsed = false;
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async recordFolder(record) {
    if (!record || !record.host || !record.folder) return;
    const next = this._history.filter((item) => !(item.host === record.host && item.folder === record.folder));
    next.unshift({
      host: record.host,
      authority: record.authority,
      folder: record.folder,
      name: record.name,
    });
    this._history = next.slice(0, 40);
    await this.deps.context.globalState.update(HISTORY_KEY, this._history);
    this.refresh();
  }

  async removeFolder(folderRecord) {
    this._history = this._history.filter((item) => !(item.host === folderRecord.host && item.folder === folderRecord.folder));
    await this.deps.context.globalState.update(HISTORY_KEY, this._history);
    this.refresh();
  }

  _activeSessions() {
    return [...(this.deps.getSessions()?.byAuthority?.values?.() || [])];
  }

  _foldersForHost(host) {
    const active = this._activeSessions()
      .filter((session) => sessionMatchesHost(session, host))
      .filter((session) => session.spec?.workspace)
      .map((session) => ({
        host: host.label,
        authority: session.authority,
        folder: session.spec.workspace,
        name: session.spec.workspace,
        active: true,
      }));
    const history = this._history
      .filter((item) => item.host === host.label || item.host === host.hostName)
      .map((item) => ({
        ...item,
        active: active.some((entry) => entry.authority === item.authority && entry.folder === item.folder),
      }));
    const merged = [];
    for (const item of [...history, ...active]) {
      if (!merged.some((entry) => entry.authority === item.authority && entry.folder === item.folder)) merged.push(item);
    }
    return merged;
  }

  async _hosts() {
    const configured = await readSshHosts(this.vscode);
    const active = this._activeSessions();
    const byName = new Map();

    for (const host of configured) {
      const match = active.find((session) => sessionMatchesHost(session, host));
      byName.set(host.label, { ...host, active: !!match, session: match });
    }

    for (const session of active) {
      const spec = session.spec || {};
      const label = `${spec.username || "user"}@${spec.host || "host"}`;
      // 配置里已经有同一条主机（可能别名写成 user@host）时，绝不能再把活动会话追加成第二行。
      if ([...byName.values()].some((host) => sessionMatchesHost(session, host))) continue;
      if (!byName.has(label)) byName.set(label, {
        label,
        hostName: spec.host,
        username: spec.username,
        port: spec.port || 22,
        identityFile: spec.privateKeyPath || "",
        source: "",
        active: true,
        session,
      });
    }
    return [...byName.values()];
  }

  async getChildren(element) {
    if (!element) {
      const item = new this.vscode.TreeItem("SSH", this.vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "remote-explorer.sshGroup";
      item.id = "rce.remote.sshGroup";
      item.rceExplorer = this;
      return [item];
    }

    if (element.contextValue === "remote-explorer.sshGroup") {
      const hosts = await this._hosts();
      return hosts.sort((a, b) => a.label.localeCompare(b.label)).map((host) => {
        const folders = this._foldersForHost(host);
        const item = new this.vscode.TreeItem(
          host.label,
          folders.length ? this.vscode.TreeItemCollapsibleState.Expanded : this.vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = "remote-explorer.sshRemoteTarget";
        item.description = host.active ? "已连接" : "";
        item.tooltip = `${host.username || "user"}@${host.hostName || host.label}:${host.port || 22}`;
        item.iconPath = new this.vscode.ThemeIcon(
          host.active ? "vm-active" : "vm",
          host.active ? new this.vscode.ThemeColor("debugIcon.startForeground") : undefined,
        );
        item.id = `rce.remote.host:${hostSpecKey(host)}`;
        item.rceHost = host;
        item.command = {
          command: "remote-explorer.connectToRemoteInCurrentWindow",
          title: "连接",
          arguments: [host],
        };
        return item;
      });
    }

    if (element.contextValue === "remote-explorer.sshRemoteTarget" && element.rceHost) {
      return this._foldersForHost(element.rceHost).map((folder) => {
        const item = new this.vscode.TreeItem(folderName(folder.folder), this.vscode.TreeItemCollapsibleState.None);
        item.contextValue = "remote-explorer.remoteFolder";
        item.description = folder.folder;
        item.tooltip = `'${folder.folder}' on ${element.rceHost.label}`;
        item.resourceUri = this.vscode.Uri.from({ scheme: "sshfs", authority: folder.authority, path: folder.folder });
        item.iconPath = new this.vscode.ThemeIcon(folder.active ? "folder-active" : "folder");
        item.id = `rce.remote.folder:${folder.authority}:${folder.folder}`;
        item.rceFolder = { ...folder, host: element.rceHost.label };
        return item;
      });
    }

    return [];
  }
}

async function ensureConfigFile(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, "", "utf8");
  }
}

async function addHost(vscode, deps) {
  const raw = await vscode.window.showInputBox({
    title: "新建远程",
    prompt: "输入 SSH 主机，例如 user@192.168.1.20 或 user@host:2222",
    placeHolder: "user@host",
    ignoreFocusOut: true,
  });
  const target = parseTarget(raw);
  if (!target) return;

  const file = sshConfigPath(vscode);
  await ensureConfigFile(file);

  let aliases = new Set();
  try {
    const existing = await readSshHosts(vscode);
    aliases = new Set(existing.map((entry) => entry.label));
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  let alias = target.host;
  for (let i = 2; aliases.has(alias); i++) alias = `${target.host}-${i}`;

  const lines = [
    `Host ${alias}`,
    `    HostName ${target.host}`,
    `    User ${target.username}`,
    target.port !== 22 ? `    Port ${target.port}` : undefined,
    "",
  ].filter((line) => line !== undefined);
  let prefix = "";
  try {
    const current = await fs.readFile(file, "utf8");
    if (current && !current.endsWith("\n")) prefix = "\n";
  } catch { /* ensureConfigFile 已处理 */ }
  await fs.appendFile(file, `${prefix}${lines.join("\n")}\n`, "utf8");
  deps.refresh();

  const choice = await vscode.window.showInformationMessage(`已添加 SSH 主机 ${alias}`, "连接");
  if (choice === "连接") await deps.connect({ ...target, label: alias }, false);
}

async function configureSsh(vscode) {
  const file = sshConfigPath(vscode);
  await ensureConfigFile(file);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: false });
}

function createRemoteExplorer(vscode, options) {
  let provider;
  let treeView;
  let connectQueue = Promise.resolve();

  const runConnect = (host, forceNewWindow) => {
    connectQueue = connectQueue
      .catch(() => undefined)
      .then(() => options.connect(host, forceNewWindow))
      .catch((err) => vscode.window.showErrorMessage(`连接失败：${err && err.message}`));
    return connectQueue;
  };

  const deps = {
    context: options.context,
    refresh: () => provider?.refresh(),
    connect: (host, forceNewWindow) => runConnect(host, forceNewWindow),
  };

  provider = new RemoteExplorerProvider(vscode, {
    context: options.context,
    getSessions: options.getSessions,
  });
  treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });

  const registrations = [
    vscode.commands.registerCommand("remote-explorer.add", () => addHost(vscode, deps)
      .catch((err) => vscode.window.showErrorMessage(`添加主机失败：${err && err.message}`))),
    vscode.commands.registerCommand("remote-explorer.configureSsh", () => configureSsh(vscode)
      .catch((err) => vscode.window.showErrorMessage(`打开 SSH 配置文件失败：${err && err.message}`))),
    vscode.commands.registerCommand("remote-explorer.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("remote-explorer.connectToRemoteInCurrentWindow", (host) => runConnect(host.rceHost || host, false)),
    vscode.commands.registerCommand("remote-explorer.connectToRemoteInNewWindow", (host) => runConnect(host.rceHost || host, true)),
    vscode.commands.registerCommand("remote-explorer.connectToFolderInCurrentWindow", (folder) => {
      const uri = folder.rceFolder?.authority
        ? vscode.Uri.from({ scheme: "sshfs", authority: folder.rceFolder.authority, path: folder.rceFolder.folder })
        : undefined;
      if (uri) return vscode.commands.executeCommand("vscode.openFolder", uri);
    }),
    vscode.commands.registerCommand("remote-explorer.connectToFolderInNewWindow", (folder) => {
      const uri = folder.rceFolder?.authority
        ? vscode.Uri.from({ scheme: "sshfs", authority: folder.rceFolder.authority, path: folder.rceFolder.folder })
        : undefined;
      if (uri) return vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
    }),
    vscode.commands.registerCommand("remote-explorer.deleteFolderHistoryItem", (folder) => {
      if (folder.rceFolder) return provider.removeFolder(folder.rceFolder);
    }),
  ];

  return {
    provider,
    refresh: () => provider.refresh(),
    recordFolder: (record) => provider.recordFolder(record),
    dispose() {
      for (const registration of registrations) registration.dispose();
      treeView.dispose();
      provider.dispose();
    },
  };
}

module.exports = { createRemoteExplorer, parseTarget, readSshHosts, sshConfigPath, VIEW_ID };
