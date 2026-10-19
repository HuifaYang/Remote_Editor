// 本地假 SSH + 真子进程假 LSP：验证标准 LSP 的 SSH exec 全链路，不连接任何外部主机。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { LspManager } from "../../src/main/lsp/manager";
import type { MirrorManager } from "../../src/main/mirror/manager";
import { SSHConnection } from "../../src/main/session/connection";
import { startFakeServer, type FakeServer } from "./fake-ssh-server";

let server: FakeServer;
let conn: SSHConnection;
let scratch: string;
let available = false;

function skip(ctx: TestContext): void {
  if (!available) ctx.skip();
}

beforeAll(async () => {
  try {
    server = await startFakeServer([], { realExec: true });
    available = true;
  } catch (err) {
    console.warn(`[integration] 无法启动假 SSH（沙箱？），远端 LSP 用例跳过：${String(err)}`);
    return;
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rce-remote-lsp-"));
  fs.mkdirSync(path.join(server.root, "ws", "src"), { recursive: true });
  fs.writeFileSync(path.join(server.root, "ws", "src", "main.c"), "int main(void) { return 0; }\n");
  conn = new SSHConnection({
    host: "127.0.0.1",
    port: server.port,
    username: "u",
    password: "test",
    timeoutMs: 5000,
    keepaliveMs: 0,
    strictHostKey: false,
    knownHostsPath: path.join(scratch, "known_hosts"),
    sshDir: path.join(scratch, "empty-ssh"),
  });
  await conn.connect();
});

afterAll(async () => {
  if (!available) return;
  await conn.close().catch(() => {});
  await server.close();
  fs.rmSync(server.root, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("远端标准 LSP（假 SSH）", () => {
  it("test_ssh_exec_lsp_completion_definition_and_diagnostics", async (ctx) => {
    skip(ctx);
    const mirror = { root: "/unused-mirror", targetTriplet: "aarch64-linux-gnu" } as unknown as MirrorManager;
    const diagnostics: Array<{ uri: string }> = [];
    const mgr = new LspManager(mirror, path.join(scratch, "lsp"), {
      transportMode: () => "remote",
      connection: () => conn,
    });
    mgr.diagnostics((event) => diagnostics.push(event));
    try {
      const client = await mgr.ensure("cpp", "/ws", {
        id: "cpp",
        command: path.resolve("ide/tools/fake-lsp.js"),
        args: [],
        env: {},
      });
      client.didOpen("/ws/src/main.c", "int main(void) { return 0; }\n", 1, "c");
      const items = await client.completion("/ws/src/main.c", 0, 4);
      expect(items.map((item) => item.label)).toContain("rce_fake_printf");
      const definitions = await client.definition("/ws/src/main.c", 0, 4);
      expect(definitions[0]?.uri).toBe("file:///ws/src/util.c");
      for (let i = 0; i < 50 && diagnostics.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(diagnostics[0]?.uri).toBe("file:///ws/src/main.c");
    } finally {
      await mgr.stopAll();
    }
  }, 20_000);
});
