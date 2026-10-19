// 内置 pylsp：验证开发机不预装 python-lsp-server 时，语言库随 IDE 一起可用。
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

describe("内置 Python 语言库", () => {
  it("test_bundled_pylsp_initializes_and_completes", async (ctx: TestContext) => {
    if (!fs.existsSync(path.resolve("resources/python-lsp/pylsp/__init__.py"))) ctx.skip();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rce-pylsp-"));
    fs.writeFileSync(path.join(root, "main.py"), "import os\nos.pa\n");
    const mirror = { root, targetTriplet: "x86_64-linux-gnu" } as unknown as MirrorManager;
    const mgr = new LspManager(mirror, path.join(root, "cache"), {
      transportMode: () => "mount",
      writeClangdConfig: false,
      serverPaths: () => ({ cpp: "", python: "" }),
    });
    try {
      const client = await mgr.ensure("python", root, {
        id: "python", command: "python3", args: ["-m", "pylsp"], env: {},
      });
      client.didOpen(path.join(root, "main.py"), "import os\nos.pa\n", 1, "python");
      const items = await client.completion(path.join(root, "main.py"), 1, 5);
      expect(items.length).toBeGreaterThan(0);
    } finally {
      await mgr.stopAll();
    }
  }, 30_000);
});
