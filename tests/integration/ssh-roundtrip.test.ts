// T9：假 SSH 服务端端到端（总纲 §10.2；M2 覆盖 1/3，镜像同步用例在 M3 补）
// 沙箱环境禁 socket 监听时整组跳过（与 v1 的 SSH 端到端用例同一约定），CI / 本机正常跑
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { SSHConnection } from "../../src/main/session/connection";
import { RemoteFs } from "../../src/main/session/remote-fs";
import { GitRemote } from "../../src/main/session/git";
import { SearchRemote } from "../../src/main/session/search";
import { startFakeServer, type FakeServer } from "./fake-ssh-server";

let server: FakeServer;
let conn: SSHConnection;
let scratch: string;   // known_hosts / 空 sshDir 的落点
let serverAvailable = false;

function skipIfNoServer(ctx: TestContext): void {
  if (!serverAvailable) ctx.skip();
}

beforeAll(async () => {
  try {
    server = await startFakeServer([
      [/git rev-parse --show-toplevel/, { code: 0, stdout: "/ws\nmain\n", stderr: "" }],
      [/git status --porcelain -uall/, { code: 0, stdout: " M src/main.c\n?? new_dir/\n", stderr: "" }],
      [/^grep /, { code: 0, stdout: "/ws/src/a.c:12:int handle_dock(int x) {\n", stderr: "" }],
    ]);
    serverAvailable = true;
  } catch (err) {
    console.warn(`[integration] 无法监听 127.0.0.1（沙箱？），整组跳过：${String(err)}`);
    return;
  }
  fs.writeFileSync(path.join(server.root, "main.c"), "int main() { return 0; }\n");
  fs.mkdirSync(path.join(server.root, "src"));
  fs.writeFileSync(path.join(server.root, "src", "a.c"), "int a;\n");
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rce-it-"));
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
  fs.rmSync(server.root, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("T9.1 连接 → 列目录 → 读 → 保存 全链路", () => {
  it("test_connect_list_read_save_roundtrip", async (ctx) => {
    skipIfNoServer(ctx);
    // Given 假服务端（密码 u/test）When connect Then ready
    await conn.connect();
    expect(conn.connected).toBe(true);

    const fsApi = new RemoteFs(conn);
    // When 列根目录 Then 目录在前、含 main.c 与 src/
    const list = await fsApi.listDir("/");
    expect(list.map((e) => e.name)).toEqual(["src", "main.c"]);
    expect(list[0].isDir).toBe(true);

    // When 读文件 Then 内容/编码/换行/指纹正确
    const read = await fsApi.readFile("/main.c");
    expect(read.text).toBe("int main() { return 0; }\n");
    expect(read.encoding).toBe("utf8");
    expect(read.newline).toBe("lf");
    expect(read.fingerprint.path).toBe("/main.c");

    // When 原子写 Then 服务端内容更新，且不残留 .rce-tmp-*（临时文件已被 rename 覆盖）
    await fsApi.saveFile("/main.c", "int main() { return 1; }\n");
    expect(fs.readFileSync(path.join(server.root, "main.c"), "utf8")).toBe("int main() { return 1; }\n");
    expect(fs.readdirSync(server.root).filter((n) => n.includes(".rce-tmp-"))).toEqual([]);

    // 新建/重命名/删除/指纹 顺带过一遍
    await fsApi.createFile("/new.txt");
    expect(fs.existsSync(path.join(server.root, "new.txt"))).toBe(true);
    await fsApi.rename("/new.txt", "/renamed.txt");
    expect(fs.existsSync(path.join(server.root, "renamed.txt"))).toBe(true);
    await fsApi.remove("/renamed.txt");
    expect(fs.existsSync(path.join(server.root, "renamed.txt"))).toBe(false);
    expect(await fsApi.fingerprint("/ghost.txt")).toBeNull();
  });

  it("test_wrong_password_maps_to_auth", async (ctx) => {
    skipIfNoServer(ctx);
    // Given 错误密码 When connect Then 归类 auth（总纲 §5.1.2：禁止死胡同错误框）
    const bad = new SSHConnection({
      host: "127.0.0.1", port: server.port, username: "u", password: "wrong",
      timeoutMs: 5000, keepaliveMs: 0, strictHostKey: false,
      knownHostsPath: path.join(scratch, "kh2"), sshDir: path.join(scratch, "empty-ssh"),
    });
    await expect(bad.connect()).rejects.toMatchObject({ code: "auth" });
  });
});

describe("T9.3 Git 快照与搜索（exec 罐装输出）", () => {
  it("test_git_status_and_search_over_exec", async (ctx) => {
    skipIfNoServer(ctx);
    const git = new GitRemote(conn);
    const snap = await git.treeStatus("/ws");
    expect(snap.branch).toBe("main");
    expect(snap.files["/ws/src/main.c"]).toMatchObject({ letter: "M", change: "modified" });
    expect(snap.untrackedDirs).toEqual(["/ws/new_dir"]);
    expect(snap.dirs["/ws/src"]).toBe("modified");
    expect(snap.dirs["/ws"]).toBe("modified");
    expect(snap.label).toBe("Git: main · 2 处变更");

    const matches = await new SearchRemote(conn).search("/ws", "handle_dock", { caseSensitive: true, regex: false });
    expect(matches).toEqual([{ path: "/ws/src/a.c", line: 12, text: "int handle_dock(int x) {" }]);
  });
});
