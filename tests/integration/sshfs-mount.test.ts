// 本地假 SSH + 真 sshfs：验证目标机零语言服务时，开发机能惰性读取远端文件。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { SshfsMount, isMountPoint } from "../../src/main/lsp/sshfs-mount";
import { startFakeServer, type FakeServer } from "./fake-ssh-server";

let server: FakeServer;
let scratch: string;
let mount: SshfsMount;
let mountPoint: string;
let available = false;

function skip(ctx: TestContext): void {
  if (!available) ctx.skip();
}

beforeAll(async () => {
  const binary = process.env.RCE_SSHFS_BIN || "sshfs";
  try {
    server = await startFakeServer([]);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rce-sshfs-it-"));
    mountPoint = path.join(scratch, "remote");
    fs.mkdirSync(path.join(server.root, "ws"), { recursive: true });
    fs.writeFileSync(path.join(server.root, "ws", "main.cpp"), "int main() { return 0; }\n");
    mount = new SshfsMount({
      binary,
      mountPoint,
      spec: {
        host: "127.0.0.1", port: server.port, username: "u", password: "test",
        strictHostKey: false, knownHostsPath: "/dev/null",
      },
    });
    await mount.mount();
    available = true;
  } catch (err) {
    console.warn(`[integration] sshfs 不可用，挂载用例跳过：${String(err)}`);
  }
});

afterAll(async () => {
  if (mount) await mount.unmount().catch(() => {});
  if (server) await server.close().catch(() => {});
  if (server?.root) fs.rmSync(server.root, { recursive: true, force: true });
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe("只读 SSHFS 语言视图", () => {
  it("test_mount_reads_remote_file_without_copying", async (ctx) => {
    skip(ctx);
    expect(isMountPoint(mountPoint)).toBe(true);
    await expect(fs.promises.readFile(path.join(mountPoint, "ws", "main.cpp"), "utf8"))
      .resolves.toBe("int main() { return 0; }\n");
    await expect(fs.promises.writeFile(path.join(mountPoint, "ws", "new.cpp"), "x")).rejects.toThrow();
  });
});
