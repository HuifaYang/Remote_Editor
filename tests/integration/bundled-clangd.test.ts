// 内置 clangd：验证打包资源能在独立本地 cwd 启动并完成 initialize，不依赖 SSHFS cwd。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { LspManager } from "../../src/main/lsp/manager";
import type { MirrorManager } from "../../src/main/mirror/manager";

let root: string | null = null;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("内置 clangd", () => {
  it("test_bundled_clangd_spawns_with_local_cwd", async (ctx: TestContext) => {
    const exe = path.resolve("resources/clangd/linux/clangd");
    if (!fs.existsSync(exe)) ctx.skip();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rce-clangd-"));
    const project = path.join(root, "project");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(project);
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(project, "main.cpp"), "int main() { return 0; }\n");
    const mirror = { root: project, targetTriplet: "x86_64-linux-gnu" } as unknown as MirrorManager;
    const mgr = new LspManager(mirror, path.join(root, "cache"), {
      transportMode: () => "mount",
      writeClangdConfig: false,
      serverPaths: () => ({ cpp: exe, python: "" }),
    });
    try {
      const client = await mgr.ensure("cpp", project, {
        id: "cpp", command: exe, args: ["--background-index=0", "--pch-storage=memory"], env: {},
      }, runtime);
      expect(client.alive).toBe(true);
    } finally {
      await mgr.stopAll();
    }
  }, 30_000);
});
