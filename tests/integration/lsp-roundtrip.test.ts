// 分册 4 T9 集成：真起一个假 LSP 服务器进程，验证客户端全链路（initialize → 补全/跳转/悬浮/诊断）
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { LspClient } from "../../src/main/lsp/client";
import { localTransport } from "../../src/main/lsp/manager";
import type { LspDiagnosticEvent, LspLocation } from "../../src/shared/types";

const SCRIPT = path.join(__dirname, "..", "fixtures", "fake-lsp.mjs");
let available = false;

/** 沙箱里 node 子进程会被拦（表现为立刻 exit 0 且无输出）——探测不到就整组跳过，与 SSH 集成测试同一约定 */
async function canSpawnNode(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const probe = spawn(process.execPath, ["-e", "process.stdout.write('ok')"], { stdio: ["ignore", "pipe", "ignore"] });
      probe.stdout.on("data", (d: Buffer) => { if (d.toString().includes("ok")) done(true); });
      probe.on("error", () => done(false));
      probe.on("exit", () => setTimeout(() => done(false), 50));
      setTimeout(() => { probe.kill("SIGKILL"); done(false); }, 3000);
    } catch {
      done(false);
    }
  });
}

beforeAll(async () => {
  available = await canSpawnNode();
  if (!available) console.warn("[integration] 无法 spawn node 子进程（沙箱？），LSP 集成整组跳过");
});

let client: LspClient | null = null;
let child: ChildProcess | null = null;

afterEach(async () => {
  if (client) {
    await client.dispose().catch(() => { /* 已退出 */ });
    client = null;
  }
  if (child && child.exitCode === null) child.kill("SIGKILL");
  child = null;
});

function skipIfNoServer(ctx: TestContext): void {
  if (!available) ctx.skip();
}

describe("T9.6 假 LSP 服务器端到端", () => {
  it("test_lsp_roundtrip_completion_definition_hover_diagnostics", async (ctx) => {
    skipIfNoServer(ctx);
    // Given 真进程跑假 LSP When 客户端握手 Then 补全/跳转/悬浮/诊断全链路通
    const diagnostics: LspDiagnosticEvent[] = [];
    child = spawn(process.execPath, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", (err) => console.warn(`[integration] 无法启动假 LSP：${String(err)}`));
    client = new LspClient(localTransport(child), {
      rootUri: "file:///mirror/x",
      timeoutMs: 5000,
      diagnostics: (e) => diagnostics.push(e),
    });
    await client.start();
    client.didOpen("file:///mirror/x/a.cpp", "int main() { return 0; }\n", 1);

    const items = await client.completion("file:///mirror/x/a.cpp", 0, 4);
    expect(items[0].label).toBe("fake_complete");

    const definitions = await client.definition("file:///mirror/x/a.cpp", 0, 4) as LspLocation[];
    expect(definitions[0].uri).toBe("file:///mirror/x/b.cpp");
    expect(definitions[0].range.start.line).toBe(9);

    await expect(client.hover("file:///mirror/x/a.cpp", 0, 4)).resolves.toBe("**fake hover**");

    // 诊断是服务端在 initialized 后主动推的，稍等一拍
    for (let i = 0; i < 50 && diagnostics.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(diagnostics[0]?.uri).toBe("file:///mirror/x/a.cpp");
    expect(diagnostics[0]?.diagnostics[0]?.message).toBe("expected ';'");
  });
});
