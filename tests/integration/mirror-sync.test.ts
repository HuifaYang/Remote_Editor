// 分册 4 T9.2 集成：假 SSH 服务端回放固定 tar 流 → 验证解包、manifest、changed/removed
// 沙箱禁 socket 监听时整组跳过（与 ssh-roundtrip 同一约定）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { MirrorManager } from "../../src/main/mirror/manager";
import { parseManifest } from "../../src/main/mirror/manifest";
import { SSHConnection } from "../../src/main/session/connection";
import { makeTarGz } from "../fixtures/tar-writer";
import { startFakeServer, type FakeServer } from "./fake-ssh-server";

let server: FakeServer;
let conn: SSHConnection;
let scratch: string;
let serverAvailable = false;

function skipIfNoServer(ctx: TestContext): void {
  if (!serverAvailable) ctx.skip();
}

beforeAll(async () => {
  const first = makeTarGz([
    { path: "./src/a.c", content: "int a;\n" },
    { path: "./src/b.c", content: "int b;\n" },
    { path: "./build/skip.o", content: "should not be mirrored\n" },
  ]);
  const second = makeTarGz([{ path: "./src/a.c", content: "int a2;\n" }]);
  try {
    server = await startFakeServer([
      // 新复合命令包含 tar --version / gcc / date +%s，所以 date +%s 必须排在前面
      [/date \+%s.*find \. -type f -newermt/, { code: 0, stdout: second, stderr: "1729990100\n./src/a.c 8 1729990100.5\n" }],
      [/date \+%s/, { code: 0, stdout: first, stderr: "1729990000\n./src/a.c 7 1729990000.5\n./src/b.c 7 1729990001.5\n./build/skip.o 0 1729990002.5\n" }],
      [/tar --version/, { code: 0, stdout: "tar (GNU tar) 1.34\n", stderr: "" }],
      [/gcc -dumpmachine/, { code: 0, stdout: "aarch64-linux-gnu\n/usr/lib/gcc/aarch64-linux-gnu/11/include\n", stderr: "" }],
    ]);
    serverAvailable = true;
  } catch (err) {
    console.warn(`[integration] 无法监听 127.0.0.1（沙箱？），镜像集成整组跳过：${String(err)}`);
    return;
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rce-mirror-it-"));
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
});

afterAll(async () => {
  if (!serverAvailable) return;
  await conn.close();
  await server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("T9.2 镜像同步（假 SSH 服务端 + 固定 tar 流）", () => {
  it("test_mirror_sync_extracts_and_builds_manifest", async (ctx) => {
    skipIfNoServer(ctx);
    // Given 假服务端回放 tar 流 When sync Then 解包 + manifest + changed/removed 正确
    await conn.connect();
    const mirrorRoot = path.join(scratch, "mirror");
    const mgr = new MirrorManager(conn, mirrorRoot);
    const result = await mgr.sync("/ws");
    expect(result.fileCount).toBe(3);
    expect(fs.readFileSync(path.join(mirrorRoot, "src", "a.c"), "utf8")).toBe("int a;\n");
    const manifest = parseManifest(fs.readFileSync(path.join(mirrorRoot, "manifest.json"), "utf8"));
    expect(manifest?.entries.map((e) => e.path)).toEqual(["build/skip.o", "src/a.c", "src/b.c"]);

    // When 第二次走增量（服务端只回 a.c）Then b.c 被本地删除、a.c 更新
    const mgr2 = new MirrorManager(conn, mirrorRoot);
    mgr2.loadPersistedManifest("/ws");
    const second = await mgr2.sync("/ws");
    expect(second.removed).toEqual(["build/skip.o", "src/b.c"]);
    expect(fs.readFileSync(path.join(mirrorRoot, "src", "a.c"), "utf8")).toBe("int a2;\n");
    expect(fs.existsSync(path.join(mirrorRoot, "src", "b.c"))).toBe(false);
    expect(mgr2.localPathOf("/ws/src/a.c")).toBe(path.join(mirrorRoot, "src", "a.c"));
  });
});
