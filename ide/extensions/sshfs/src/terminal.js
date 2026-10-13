// 集成终端：把 VSCode 的 Pseudoterminal 接到我们自己的 SSH shell（PTY）通道上。
//
// 为什么必须自己接：`sshfs://` 工作区在 VSCode 眼里是**虚拟工作区**，内置终端会去开一个**本机**
// shell（还会弹 "This shell is open to a local folder, NOT to the virtual folder"），
// 这对"远程板卡"完全没意义。Remote-SSH 靠远端扩展宿主天生解决，我们只能自己补（见 docs/ssh-vs-remotessh.md）。
"use strict";

const os = require("node:os");

const REMOTE_PROFILE_NAME = "RemoteCodeEditor";

class SshPseudoterminal {
  constructor(vscode, session, log, name) {
    this.vscode = vscode;
    this.session = session;
    this.log = log;
    this.name = name;
    this.channel = null;
    this.cols = 80;
    this.rows = 24;
    this.pendingInput = [];
    this.closed = false;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
  }

  async open(dims) {
    if (dims) {
      this.cols = dims.columns;
      this.rows = dims.rows;
    }
    try {
      this.channel = await this.session.openTerminal(this.cols, this.rows);
    } catch (err) {
      this.writeEmitter.fire(`\r\n\x1b[31m远端 shell 打不开：${err && err.message}\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
      return;
    }
    this.channel.onData((chunk) => this.writeEmitter.fire(chunk.toString("utf8").replace(/\n/g, "\r\n")));
    this.channel.onClose(() => {
      if (this.closed) return;
      this.closed = true;
      this.closeEmitter.fire(0);
    });
    // 名称必须固定成 REMOTE_PROFILE_NAME，否则 terminal.integrated.defaultProfile.* 匹配不上
    this.writeEmitter.fire(`\x1b[2m已连接 ${this.session.authority}（RemoteCodeEditor 远端 shell）\x1b[0m\r\n`);
    for (const data of this.pendingInput) this.channel.write(data);
    this.pendingInput = [];
  }

  handleInput(data) {
    if (this.channel) this.channel.write(data);
    else this.pendingInput.push(data);
  }

  setDimensions(dims) {
    this.cols = dims.columns;
    this.rows = dims.rows;
    // TerminalChannel.resize 内部已经判空
    try {
      this.channel?.resize(dims.columns, dims.rows);
    } catch (err) {
      this.log(`终端 resize 失败：${err && err.message}`);
    }
  }

  close() {
    this.closed = true;
    try {
      this.channel?.close();
    } catch {
      /* 关掉时连接可能已经断了 */
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

/** profile provider：有远端会话就开远端 shell，否则退回本机 shell（本地工作区时行为与原生一致） */
function createTerminalProfileProvider(vscode, deps) {
  const { log, currentSession, workspaceFolderForCwd } = deps;
  return {
    provideTerminalProfile(_token) {
      const session = currentSession();
      if (session) {
        const pty = new SshPseudoterminal(vscode, session, log, REMOTE_PROFILE_NAME);
        return new vscode.TerminalProfile({
          name: REMOTE_PROFILE_NAME,
          pty,
          isTransient: true,
        });
      }
      const folder = workspaceFolderForCwd && workspaceFolderForCwd();
      const cwd = folder && folder.uri.scheme === "file" ? folder.uri.fsPath : os.homedir();
      return new vscode.TerminalProfile({ name: REMOTE_PROFILE_NAME, cwd });
    },
  };
}

module.exports = { createTerminalProfileProvider, SshPseudoterminal, REMOTE_PROFILE_NAME };
