// T6：SSH 连接（mock ssh2；认证顺序是事故高发区，断言逐条对应总纲 §5.1）
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- ssh2 mock：记录 connect 配置，按队列注入结果 ----
type FakeOutcome = { kind: "ready" } | { kind: "error"; error: Error };

class FakeClient extends EventEmitter {
  static configs: Array<Record<string, unknown>> = [];
  static outcomes: FakeOutcome[] = [];
  static execHandler: ((cmd: string, cb: (err: Error | null, stream?: unknown) => void) => void) | null = null;
  static sftpImpl: unknown = null;

  connect(cfg: Record<string, unknown>): void {
    FakeClient.configs.push(cfg);
    const outcome = FakeClient.outcomes.shift() ?? { kind: "ready" as const };
    setImmediate(() => {
      if (outcome.kind === "ready") this.emit("ready");
      else this.emit("error", outcome.error);
    });
  }
  exec(cmd: string, cb: (err: Error | null, stream?: unknown) => void): void {
    FakeClient.execHandler?.(cmd, cb);
  }
  sftp(cb: (err: Error | null, sftp?: unknown) => void): void {
    cb(null, FakeClient.sftpImpl);
  }
  end(): void {
    setImmediate(() => this.emit("close"));
  }
}

vi.mock("ssh2", () => ({ Client: FakeClient }));

const { SSHConnection, listDefaultKeys } = await import("../../src/main/session/connection");
const { RemoteFs } = await import("../../src/main/session/remote-fs");

const BASE = {
  host: "192.168.1.10", port: 22, username: "root",
  timeoutMs: 15000, keepaliveMs: 30000, strictHostKey: false, knownHostsPath: undefined,
};

let sshDir: string;
let keyFile: string;

beforeEach(() => {
  FakeClient.configs = [];
  FakeClient.outcomes = [];
  FakeClient.execHandler = null;
  FakeClient.sftpImpl = null;
  sshDir = fs.mkdtempSync(path.join(os.tmpdir(), "rce-ssh-"));
  keyFile = path.join(sshDir, "my_key");
  fs.writeFileSync(keyFile, "FAKE-KEY-DATA");
});
afterEach(() => {
  fs.rmSync(sshDir, { recursive: true, force: true });
});

describe("认证顺序（§5.1.1）", () => {
  it("test_explicit_key_only_uses_that_key", async () => {
    // Given 显式 privateKeyPath When connect Then 只用该私钥、不探测默认名、不碰 agent
    fs.writeFileSync(path.join(sshDir, "id_ed25519"), "DEFAULT-KEY");   // 默认名私钥也存在
    const conn = new SSHConnection({ ...BASE, privateKeyPath: keyFile, sshDir });
    await conn.connect();
    expect(FakeClient.configs).toHaveLength(1);
    expect(FakeClient.configs[0].privateKey).toEqual(Buffer.from("FAKE-KEY-DATA"));
    expect(FakeClient.configs[0].agent).toBeUndefined();   // agent 恒不设 = 恒不走 ssh-agent
    expect(FakeClient.configs[0].tryKeyboard).toBe(false);
  });
  it("test_default_named_keys_are_tried_first", async () => {
    // Given 无显式私钥、本机有 id_ed25519 Then 先试默认名私钥
    fs.writeFileSync(path.join(sshDir, "id_ed25519"), "DEFAULT-KEY");
    const conn = new SSHConnection({ ...BASE, sshDir });
    await conn.connect();
    expect(FakeClient.configs).toHaveLength(1);
    expect(FakeClient.configs[0].privateKey).toEqual(Buffer.from("DEFAULT-KEY"));
    expect(FakeClient.configs[0].password).toBeUndefined();
  });
  it("test_no_default_named_keys_skips_discovery", async () => {
    // Given 只有自定义名 id_ed25519_github Then 不参与自动尝试，直接抛 auth
    fs.writeFileSync(path.join(sshDir, "id_ed25519_github"), "GH-KEY");
    const conn = new SSHConnection({ ...BASE, sshDir });
    await expect(conn.connect()).rejects.toMatchObject({ code: "auth" });
    expect(FakeClient.configs).toHaveLength(0);
  });
  it("test_all_default_keys_rejected_maps_to_auth", async () => {
    fs.writeFileSync(path.join(sshDir, "id_ed25519"), "K1");
    fs.writeFileSync(path.join(sshDir, "id_rsa"), "K2");
    FakeClient.outcomes = [
      { kind: "error", error: new Error("All configured authentication methods failed") },
      { kind: "error", error: new Error("All configured authentication methods failed") },
    ];
    const conn = new SSHConnection({ ...BASE, sshDir });
    await expect(conn.connect()).rejects.toMatchObject({ code: "auth" });
    expect(FakeClient.configs).toHaveLength(2);   // 两把都试过
  });
  it("test_no_authentication_methods_maps_to_auth_error", async () => {
    // Given ssh2 抛 No supported authentication methods available Then code=auth（不得是 ssh）
    FakeClient.outcomes = [{ kind: "error", error: new Error("No supported authentication methods available") }];
    const conn = new SSHConnection({ ...BASE, privateKeyPath: keyFile, sshDir });
    await expect(conn.connect()).rejects.toMatchObject({ code: "auth" });
  });
  it("test_timeout_maps_to_timeout_error", async () => {
    const err = new Error("Timed out while waiting for handshake") as Error & { level: string };
    err.level = "client-timeout";
    FakeClient.outcomes = [{ kind: "error", error: err }];
    const conn = new SSHConnection({ ...BASE, privateKeyPath: keyFile, sshDir });
    await expect(conn.connect()).rejects.toMatchObject({ code: "timeout" });
  });
  it("test_passphrase_required_maps_to_its_code", async () => {
    FakeClient.outcomes = [
      { kind: "error", error: new Error("Encrypted private OpenSSH key detected, but no passphrase given") },
    ];
    const conn = new SSHConnection({ ...BASE, privateKeyPath: keyFile, sshDir });
    await expect(conn.connect()).rejects.toMatchObject({ code: "auth-passphrase-required" });
  });
});

describe("exec / SFTP 行为", () => {
  it("test_exec_uses_quoted_cwd", async () => {
    // Given cwd="/a b" When exec Then 命令前缀 `cd '/a b' &&`
    FakeClient.execHandler = (cmd, cb) => {
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      cb(null, stream);
      setImmediate(() => stream.emit("close", 0));
      FakeClient.configs.push({ lastCommand: cmd });
    };
    const conn = new SSHConnection({ ...BASE, privateKeyPath: keyFile, sshDir });
    await conn.connect();
    await conn.exec("pwd", { cwd: "/a b" });
    const cmd = (FakeClient.configs.at(-1) as { lastCommand: string }).lastCommand;
    expect(cmd.startsWith("cd '/a b' && ")).toBe(true);
  });
  it("test_sftp_calls_are_serialized", async () => {
    // Given 并发 3 个 readFile Then SFTP 调用严格串行（同时在飞 ≤1）
    let active = 0;
    let maxActive = 0;
    FakeClient.sftpImpl = {
      on: () => { /* EventEmitter 接口占位 */ },
      stat: (_p: string, cb: (err: Error | null, st?: unknown) => void) =>
        setImmediate(() => cb(null, { size: 3, mtime: 1, isDirectory: () => false, isSymbolicLink: () => false, mode: 0o100644 })),
      createReadStream: () => {
        active++;
        maxActive = Math.max(maxActive, active);
        let sent = false;
        return new Readable({
          read() {
            // 人为拉长在飞时间：不延迟的话串行性测不出来
            setTimeout(() => {
              if (!sent) { sent = true; this.push(Buffer.from("abc")); }
              else { active--; this.push(null); }
            }, 5);
          },
        });
      },
    };
    const conn = new SSHConnection({ ...BASE, privateKeyPath: keyFile, sshDir });
    await conn.connect();
    const fsApi = new RemoteFs(conn);
    await Promise.all([fsApi.readFile("/a.txt"), fsApi.readFile("/b.txt"), fsApi.readFile("/c.txt")]);
    expect(maxActive).toBe(1);
  });
});

describe("listDefaultKeys", () => {
  it("只认默认名、按优先级排序", () => {
    fs.writeFileSync(path.join(sshDir, "id_rsa"), "K");
    fs.writeFileSync(path.join(sshDir, "id_ed25519"), "K");
    fs.writeFileSync(path.join(sshDir, "id_ed25519_github"), "K");
    const keys = listDefaultKeys(sshDir).map((p) => path.basename(p));
    expect(keys).toEqual(["id_ed25519", "id_rsa"]);
  });
});
