// 诊断：直接用我们的层对假服务端做 createDir / rename，打印真实错误（绕过 VSCode）
"use strict";
const path = require("node:path");
const { startFakeServer } = require("./build/fake-ssh-server.js");
const { SSHConnection } = require("../../dist/main/main/session/connection.js");
const { RemoteFs } = require("../../dist/main/main/session/remote-fs.js");

(async () => {
  const server = await startFakeServer([]);
  const fs = require("node:fs");
  fs.mkdirSync(path.join(server.root, "ws"), { recursive: true });
  const conn = new SSHConnection({
    host: "127.0.0.1", port: server.port, username: "u", password: "test",
    timeoutMs: 8000, keepaliveMs: 0, strictHostKey: false,
    knownHostsPath: path.join(server.root, "known_hosts"), sshDir: path.join(server.root, "empty-ssh"),
  });
  await conn.connect();
  const remoteFs = new RemoteFs(conn);
  console.log("server root:", server.root);

  const attempt = async (name, fn) => {
    try { console.log(`OK   ${name}:`, await fn()); }
    catch (err) { console.log(`FAIL ${name}: [${err && err.kind}] ${err && err.message} | raw=${err && err.raw && err.raw.message}`); }
  };

  await attempt("listDir(/ws)", () => remoteFs.listDir("/ws"));
  await attempt("createDir(/ws/d1)", () => remoteFs.createDir("/ws/d1"));
  await attempt("stat(/ws/d1)", () => remoteFs.stat("/ws/d1"));
  await attempt("rename(/ws/d1 → /ws/d2)", () => remoteFs.rename("/ws/d1", "/ws/d2"));
  await attempt("裸 sftp.mkdir(/ws/d3)", () => conn.sftpRun((sftp) => new Promise((res, rej) => sftp.mkdir("/ws/d3", (e) => (e ? rej(e) : res("ok"))))));
  console.log("磁盘上 ws 内容:", fs.readdirSync(path.join(server.root, "ws")));

  await conn.close();
  await server.close();
})().catch((e) => { console.error("崩了:", e); process.exit(1); });
