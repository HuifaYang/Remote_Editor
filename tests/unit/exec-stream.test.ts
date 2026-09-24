// 回归：execStream().wait() 的竞态 —— 短命命令在调用 wait() 之前就 close 了，wait 必须立即返回
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

class FakeClient extends EventEmitter {
  connect(): void { setImmediate(() => this.emit("ready")); }
  end(): void { setImmediate(() => this.emit("close")); }
  exec(_cmd: string, cb: (err: Error | null, stream?: unknown) => void): void {
    const channel = Object.assign(new PassThrough(), {
      stderr: new PassThrough(),
      close: () => { /* noop */ },
      signal: () => { /* noop */ },
    });
    cb(null, channel);
    // 立刻结束：模拟“命令很快就跑完”
    setImmediate(() => {
      channel.emit("close", 0);
      channel.end();
    });
  }
}

vi.mock("ssh2", () => ({ Client: FakeClient }));

const { SSHConnection } = await import("../../src/main/session/connection");

describe("execStream 竞态回归", () => {
  it("test_wait_returns_after_process_already_exited", async () => {
    const conn = new SSHConnection({
      host: "127.0.0.1", port: 22, username: "u", password: "p",
      timeoutMs: 1000, keepaliveMs: 0, strictHostKey: false,
    });
    await conn.connect();
    const handle = await conn.execStream("true");
    await new Promise((r) => setTimeout(r, 30));      // 确保 close 先于 wait()
    const result = await Promise.race([
      handle.wait(),
      new Promise((_res, rej) => setTimeout(() => rej(new Error("wait() 挂住了（竞态回归）")), 500)),
    ]);
    expect(result).toMatchObject({ code: 0 });
  });
});
