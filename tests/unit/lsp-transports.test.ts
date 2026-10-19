// 分册 4 T9b：两种传输都要测 —— 本机 spawn 带 --target；板子上走 SSH exec 流；设置切换后换传输
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspManager } from "../../src/main/lsp/manager";
import type { MirrorManager } from "../../src/main/mirror/manager";
import type { SSHConnection } from "../../src/main/session/connection";
import type { LspTransportMode } from "../../src/shared/types";
import { encodeMessage } from "../../src/main/lsp/client";

interface JsonRpc {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function parseFrames(buf: Buffer): { messages: JsonRpc[]; rest: Buffer } {
  const messages: JsonRpc[] = [];
  let cur = buf;
  for (;;) {
    const headerEnd = cur.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const len = Number(/content-length:\s*(\d+)/i.exec(cur.subarray(0, headerEnd).toString("ascii"))?.[1] ?? 0);
    if (cur.length < headerEnd + 4 + len) break;
    messages.push(JSON.parse(cur.subarray(headerEnd + 4, headerEnd + 4 + len).toString("utf8")) as JsonRpc);
    cur = cur.subarray(headerEnd + 4 + len);
  }
  return { messages, rest: cur };
}

/** 假语言服务链路：写入的请求原地应答（initialize / shutdown / completion） */
function makeServerLink(): Duplex {
  let buf = Buffer.alloc(0);
  const link: Duplex = new Duplex({
    read() { /* push 提供数据 */ },
    write(chunk: Buffer, _enc, cb) {
      const parsed = parseFrames(Buffer.concat([buf, Buffer.from(chunk)]));
      buf = parsed.rest;
      for (const msg of parsed.messages) {
        if (msg.id === undefined || msg.method === undefined) continue;
        const result = msg.method === "textDocument/completion"
          ? { isIncomplete: false, items: [{ label: "tick", kind: 3 }] }
          : {};
        link.push(encodeMessage({ jsonrpc: "2.0", id: msg.id, result }));
      }
      cb();
    },
  });
  return link;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = makeServerLink();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.stdout.write(chunk));
  }
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "rce-lsp-"));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

function stubMirror(): MirrorManager {
  return {
    root: "/mirror/x",
    targetTriplet: "aarch64-linux-gnu",
    localPathOf: (p: string) => p,
  } as unknown as MirrorManager;
}

describe("T9b 语言服务两种传输", () => {
  it("test_local_transport_spawns_without_target_flag", async () => {
    // Given 本机模式 When ensure(cpp) Then spawn 参数只有固定参数。
    // 交叉编译目标**不能**走命令行：clangd 18 收到 --target 会「Unknown command line argument」直接退出
    // （已在本机复现），正确姿势是镜像根的 .clangd 配置 CompileFlags.Add（writeClangdTargetConfig）。
    const child = new FakeChild();
    const spawnFn = vi.fn(() => {
      setImmediate(() => child.emit("spawn"));
      return child;
    });
    // existsFn 全否：本用例专测「找不到任何内置二进制时回退 PATH 里的裸 clangd」。
    // 不注入的话开发机仓库里自带 resources/clangd/linux/clangd，会被新探测逻辑正确命中，断言就不稳定了。
    const mgr = new LspManager(stubMirror(), userData, {
      spawnFn: spawnFn as never,
      transportMode: () => "local",
      resourcesDir: () => null,
      existsFn: () => false,
      platform: "linux",
    });
    const client = await mgr.ensure("cpp");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect(cmd).toBe("clangd");
    expect(args).toEqual([
      "--background-index", "--completion-style=detailed", "--header-insertion=never", "--malloc-trim", "-j=1",
    ]);
    expect(args.some((a) => a.startsWith("--target"))).toBe(false);   // 回归守卫：再传 --target clangd 必死
    expect(opts.cwd).toBe("/mirror/x");
    client.didClose("file:///mirror/x/a.cpp");
    await mgr.stopAll();
    expect(child.killed).toBe(true);
  });

  it("test_local_prefers_bundled_clangd", async () => {
    // 打包布局：extraResources 已把 <os> 目录拍平，clangd 直接在 resources/clangd/ 下
    const child = new FakeChild();
    const spawnFn = vi.fn(() => { setImmediate(() => child.emit("spawn")); return child; });
    const mgr = new LspManager(stubMirror(), userData, {
      spawnFn: spawnFn as never,
      transportMode: () => "local",
      resourcesDir: () => "/opt/rce/resources",
      existsFn: (p) => p === path.join("/opt/rce/resources", "clangd", "clangd"),
      platform: "linux",
    });
    await mgr.ensure("cpp");
    expect(spawnFn.mock.calls[0][0]).toBe(path.join("/opt/rce/resources", "clangd", "clangd"));
    await mgr.stopAll();
  });

  it("test_dev_layout_uses_platform_subdir", () => {
    // 开发期布局：resources/clangd/<平台目录>/clangd
    const mgr = new LspManager(stubMirror(), userData, {
      resourcesDir: () => null,
      existsFn: (p) => p.endsWith(path.join("resources", "clangd", "linux", "clangd")),
      platform: "linux",
    });
    const candidates = mgr.clangdCandidates();
    expect(candidates.some((c) => c.endsWith(path.join("resources", "clangd", "linux", "clangd")))).toBe(true);
    expect(mgr.clangdExecutable()).toBe(candidates.find((c) => c.endsWith(path.join("resources", "clangd", "linux", "clangd"))));
  });

  it("test_remote_transport_pipes_over_ssh_exec", async () => {
    // Given 板子上模式 When ensure(cpp) Then 经 SSH exec 流收发 JSON-RPC
    const link = makeServerLink();
    const execStream = vi.fn(async () => ({ stdout: link, close: () => link.push(null) }));
    const conn = { execStream } as unknown as SSHConnection;
    const mgr = new LspManager(stubMirror(), userData, {
      transportMode: () => "remote",
      connection: () => conn,
    });
    const client = await mgr.ensure("cpp", "/home/le/ws");
    const items = await client.completion("file:///home/le/ws/a.cpp", 0, 0);
    expect(execStream).toHaveBeenCalledTimes(1);
    expect(String(execStream.mock.calls[0][0])).toContain("'clangd' '--background-index");
    expect(String(execStream.mock.calls[0][0])).not.toContain("--target=");   // 板子上模式同样不能带 --target
    expect((execStream.mock.calls[0][1] as { cwd: string }).cwd).toBe("/home/le/ws");
    expect(items[0].label).toBe("tick");
    await mgr.stopAll();
  });

  it("test_remote_transport_supports_arbitrary_lsp_command", async () => {
    const link = makeServerLink();
    const exec = vi.fn(async () => ({ code: 0, stdout: "/usr/bin/gopls\n", stderr: "" }));
    const execStream = vi.fn(async () => ({ stdout: link, stderr: new PassThrough(), close: () => link.push(null) }));
    const conn = { exec, execStream } as unknown as SSHConnection;
    const mgr = new LspManager(stubMirror(), userData, {
      transportMode: () => "remote",
      connection: () => conn,
    });
    await mgr.ensure("go", "/home/le/ws", {
      id: "go",
      command: "gopls",
      args: ["serve"],
      env: { GOMAXPROCS: "1" },
    });
    expect(exec).toHaveBeenCalledWith("command -v 'gopls' >/dev/null 2>&1", { timeoutMs: 8000 });
    expect(String(execStream.mock.calls[0][0])).toBe("GOMAXPROCS='1' 'gopls' 'serve'");
    await mgr.stopAll();
  });

  it("test_setting_switch_changes_transport", async () => {
    // Given 先本机后切「板子上」 When 再次 ensure Then 重新用远端传输，旧子进程被杀
    const child = new FakeChild();
    const spawnFn = vi.fn(() => { setImmediate(() => child.emit("spawn")); return child; });
    let mode: LspTransportMode = "local";
    const link = makeServerLink();
    const conn = { execStream: vi.fn(async () => ({ stdout: link, close: () => link.push(null) })) } as unknown as SSHConnection;
    const mgr = new LspManager(stubMirror(), userData, {
      spawnFn: spawnFn as never,
      transportMode: () => mode,
      connection: () => conn,
    });
    await mgr.ensure("cpp");
    expect(spawnFn).toHaveBeenCalledTimes(1);

    mode = "remote";
    await mgr.ensure("cpp", "/home/le/ws");
    expect(child.killed).toBe(true);
    expect((conn as unknown as { execStream: { mock: { calls: unknown[] } } }).execStream.mock.calls).toHaveLength(1);
    await mgr.stopAll();
  });
});
