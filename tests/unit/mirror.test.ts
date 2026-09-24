// 分册 4 T5：镜像 tar 命令、manifest 差集、路径换算、compile_commands 重写（A8/A8b/A9）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { makeTarGz } from "../fixtures/tar-writer";
import { extractTarGz } from "../../src/main/mirror/tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MirrorManager, buildFullSyncCommand, buildIncrementalSyncCommand, buildPythonEnvTarCommand,
  buildSysrootTarCommand, splitStderr,
} from "../../src/main/mirror/manager";
import {
  createManifest, diffManifest, mirrorRelativePath, parseFindListing, parseManifest, serializeManifest, toEntryMap,
} from "../../src/main/mirror/manifest";
import {
  buildCompileFlagsTxt, buildCompileCommandsFindCommand, buildDirExistsCommand, mergeCompileCommands,
  rewriteCompileCommand, splitCommandLine, type CompileRewriteContext,
} from "../../src/main/lsp/clangd-config";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rce-mirror-"));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("T5.1 同步命令拼装（A8b）", () => {
  it("test_full_sync_command_is_single_tar_stream_with_excludes", () => {
    // Given 工作目录 /home/le/ws When 拼全量同步命令 Then 1 条命令 + 全部排除规则 + tar 单流
    const cmd = buildFullSyncCommand("/home/le/ws");
    expect(cmd.startsWith("cd '/home/le/ws' && { date +%s 1>&2;")).toBe(true);
    for (const rule of ["./build/*", "./install/*", "./log/*", "./.git/*", "./.cache/*", "*/__pycache__/*", "*.pyc"]) {
      expect(cmd).toContain(rule);
    }
    expect(cmd).toContain("tar --null -czf - -T -");
    // 清单必须走 stderr，不能混进 gzip 流
    expect(cmd).toContain("-printf '%p %s %T@\\n' 1>&2");
    // 只有一条命令（一个 && 链里的分号不算额外往返）
    expect(cmd.split("ssh").length).toBe(1);
  });

  it("test_incremental_uses_remote_clock_and_newermt", () => {
    const cmd = buildIncrementalSyncCommand("/ws", 1729990000);
    expect(cmd).toContain("date +%s 1>&2");
    expect(cmd).toContain("-newermt '@1729990000'");
    expect(cmd).toContain("tar --null -czf - -T -");
  });

  it("test_sysroot_tar_keeps_only_headers", () => {
    const full = buildSysrootTarCommand(["/usr/include", "/opt/ros/humble/include"]);
    expect(full).toContain("cd / && tar czf -");
    expect(full).toContain("--exclude='*.a'");
    expect(full).toContain("--exclude='*.so*'");
    expect(full).toContain("'usr/include'");
    expect(full).toContain("'opt/ros/humble/include'");

    const inc = buildSysrootTarCommand(["/usr/include"], 1729990000);
    expect(inc).toContain("-newermt '@1729990000'");
    expect(inc).toContain("-not -name '*.so*'");
  });

  it("test_python_env_excludes_native_extensions", () => {
    const cmd = buildPythonEnvTarCommand(["/usr/lib/python3/dist-packages"]);
    expect(cmd).toContain("--exclude='*.so'");
    expect(cmd).toContain("--exclude='*.pyd'");
    expect(cmd).toContain("'usr/lib/python3/dist-packages'");
  });

  it("test_split_stderr_peels_remote_timestamp", () => {
    // Given stderr = 时间戳 + 文件清单 When 切分 Then 时间戳单独返回、清单保留
    const { syncedAt, listing } = splitStderr("1729990000\n./a.c 12 1729990000.1\n./b.c 3 1729990000.2\n");
    expect(syncedAt).toBe(1729990000);
    expect(listing.trim().split("\n")).toHaveLength(2);
  });
});

describe("T5.2 manifest 与差集（A8）", () => {
  it("test_parse_find_listing_strips_dot_slash_and_keeps_spaces", () => {
    const entries = parseFindListing([
      "./src/a.cpp 123 1729990000.123456",
      "./src/my file.c 7 1729990001.5",
      "/etc/passwd 1 1",       // 越出工作目录 → 丢弃
      "garbage line",
    ].join("\n"));
    expect(entries).toEqual([
      { path: "src/a.cpp", size: 123, mtime: 1729990000.123456 },
      { path: "src/my file.c", size: 7, mtime: 1729990001.5 },
    ]);
  });

  it("test_diff_manifest_reports_changed_and_removed", () => {
    // Given 旧清单 {a(不变), b(改), d(删)} When 与新清单 {a, b(新 size), c} 比 Then changed=[b,c], removed=[d]
    const old = toEntryMap([
      { path: "a.c", size: 1, mtime: 10 },
      { path: "b.c", size: 2, mtime: 20 },
      { path: "d.c", size: 4, mtime: 40 },
    ]);
    const diff = diffManifest(old, [
      { path: "a.c", size: 1, mtime: 10 },
      { path: "b.c", size: 3, mtime: 20 },
      { path: "c.c", size: 5, mtime: 50 },
    ]);
    expect(diff.changed.map((e) => e.path)).toEqual(["b.c", "c.c"]);
    expect(diff.removed).toEqual(["d.c"]);
  });

  it("test_manifest_round_trip_and_tolerates_bad_json", () => {
    const m = createManifest("/ws", 1729990000, [{ path: "a.c", size: 1, mtime: 1 }]);
    expect(parseManifest(serializeManifest(m))).toEqual(m);
    expect(parseManifest("{ not json")).toBeNull();
    expect(parseManifest('{"version":99}')).toBeNull();
  });
});

describe("T5.3 路径换算（§5.3.4）", () => {
  it("test_maps_workspace_relative_tail", () => {
    expect(mirrorRelativePath("/home/le/ws", "/home/le/ws/src/a.c")).toBe("src/a.c");
    expect(mirrorRelativePath("/home/le/ws", "/home/le/ws")).toBe("");
    expect(mirrorRelativePath("/home/le/ws", "/home/le/other/a.c")).toBeNull();
  });

  it("test_maps_sysroot_paths_under_underscore_sysroot", () => {
    expect(mirrorRelativePath("/home/le/ws", "/usr/include/stdio.h", ["/usr/include"]))
      .toBe("_sysroot/usr/include/stdio.h");
    expect(mirrorRelativePath("/home/le/ws", "/opt/ros/humble/include/rclcpp.hpp", ["/opt/ros/humble/include"]))
      .toBe("_sysroot/opt/ros/humble/include/rclcpp.hpp");
  });

  it("test_manager_local_and_remote_path_round_trip", async () => {
    const conn = makeFakeConn({ tars: [makeTarGz([{ path: "./src/a.c", content: "int a;\n" }])], listings: ["./src/a.c 7 1729990000.5\n"] });
    const mirrorRoot = path.join(scratch, "mirror");
    const mgr = new MirrorManager(conn, mirrorRoot);
    await mgr.sync("/ws");
    const local = mgr.localPathOf("/ws/src/a.c");
    expect(local).toBe(path.join(mirrorRoot, "src", "a.c"));
    expect(mgr.remotePathOf(local)).toBe("/ws/src/a.c");
  });
});

describe("T5.4 compile_commands.json 收集与重写（A9）", () => {
  const ctx: CompileRewriteContext = {
    remotePrefix: "/home/le/ros2_ws/src",
    localPrefix: "/mirror/x",
    sysrootRoots: ["/usr/include", "/opt/ros/humble/include"],
    localSysrootPrefix: "/mirror/x/_sysroot",
  };

  it("test_rewrites_directory_file_and_workspace_include", () => {
    // Given 分册 A9 的样例 When 重写 Then directory/file/-I 全部指向镜像
    const { entry } = rewriteCompileCommand({
      directory: "/home/le/ros2_ws/src",
      command: "g++ -I/home/le/ros2_ws/src/include -c a.cpp",
      file: "/home/le/ros2_ws/src/a.cpp",
    }, ctx);
    expect(entry.directory).toBe("/mirror/x");
    expect(entry.file).toBe("/mirror/x/a.cpp");
    expect(entry.command).toBe(`g++ -I'/mirror/x/include' -c a.cpp`);
  });

  it("test_include_three_way_rule_drops_host_toolchain", () => {
    // Given 工作目录内 / sysroot 内 / 两者都不是 三条 -I When 重写 Then 前两条改写、第三条整条删除
    const { entry, dropped } = rewriteCompileCommand({
      directory: "/home/le/ros2_ws/src",
      arguments: [
        "g++",
        "-I", "/opt/ros/humble/include",
        "-isystem/usr/include",
        "-I/opt/host-toolchain/include",
        "-c", "/home/le/ros2_ws/src/a.cpp",
      ],
      file: "/home/le/ros2_ws/src/a.cpp",
    }, ctx);
    expect(entry.arguments).toEqual([
      "g++",
      "-I", "'/mirror/x/_sysroot/opt/ros/humble/include'",
      "-isystem'/mirror/x/_sysroot/usr/include'",
      "-c", "'/mirror/x/a.cpp'",
    ]);
    expect(dropped).toEqual(["/opt/host-toolchain/include"]);
  });

  it("test_merge_orders_by_file_path_and_keeps_entry_order", () => {
    const merged = mergeCompileCommands([
      { path: "/ws/build/b/compile_commands.json", entries: [{ file: "/home/le/ros2_ws/src/b.cpp" }] },
      { path: "/ws/build/a/compile_commands.json", entries: [{ file: "/home/le/ros2_ws/src/a1.cpp" }, { file: "/home/le/ros2_ws/src/a2.cpp" }] },
    ], ctx);
    expect(merged.entries.map((e) => e.file)).toEqual(["/mirror/x/a1.cpp", "/mirror/x/a2.cpp", "/mirror/x/b.cpp"]);
  });

  it("test_compile_flags_fallback", () => {
    const flags = buildCompileFlagsTxt("/mirror/x");
    expect(flags.split("\n").filter(Boolean)).toEqual(["-std=c++17", "-I/mirror/x/include", "-I/mirror/x"]);
  });

  it("test_collect_command_prefers_build_then_limited_depth", () => {
    const cmd = buildCompileCommandsFindCommand("/ws");
    expect(cmd).toContain("[ -d '/ws/build' ]");
    expect(cmd).toContain("find '/ws/build' -type f -name compile_commands.json");
    expect(cmd).toContain("-maxdepth 4");
  });

  it("test_dir_exists_command_quotes_each_dir", () => {
    const cmd = buildDirExistsCommand(["/usr/include", "/opt/it's/include"]);
    expect(cmd).toContain("[ -d '/usr/include' ]");
    expect(cmd).toContain("'/opt/it'\\''s/include'");
  });

  it("test_split_command_line_keeps_quoted_token", () => {
    expect(splitCommandLine(`g++ -I "/a b/include" -c 'x y.c'`)).toEqual(["g++", "-I", `"/a b/include"`, "-c", "'x y.c'"]);
  });
});

describe("T5.5 MirrorManager.sync 全流程（假连接）", () => {
  it("test_sync_extracts_tar_and_writes_manifest", async () => {
    // Given 假服务端返回 tar 流 + 清单 When 首次 sync Then 解包 + manifest + 结果统计
    const conn = makeFakeConn({
      tars: [makeTarGz([{ path: "./src/a.c", content: "int a;\n" }, { path: "./src/b.c", content: "int b;\n" }])],
      listings: ["./src/a.c 7 1729990000.5\n./src/b.c 7 1729990001.5\n"],
    });
    const mirrorRoot = path.join(scratch, "mirror");
    const mgr = new MirrorManager(conn, mirrorRoot);
    const result = await mgr.sync("/ws");

    expect(fs.readFileSync(path.join(mirrorRoot, "src", "a.c"), "utf8")).toBe("int a;\n");
    expect(result.fileCount).toBe(2);
    expect(result.root).toBe(mirrorRoot);
    const manifest = parseManifest(fs.readFileSync(path.join(mirrorRoot, "manifest.json"), "utf8"));
    expect(manifest?.entries.map((e) => e.path)).toEqual(["src/a.c", "src/b.c"]);
    expect(manifest?.workspace).toBe("/ws");
  });

  it("test_incremental_sync_deletes_removed_files", async () => {
    const mirrorRoot = path.join(scratch, "mirror");
    const first = makeFakeConn({
      tars: [makeTarGz([{ path: "./src/a.c", content: "int a;\n" }, { path: "./src/b.c", content: "int b;\n" }])],
      listings: ["./src/a.c 7 1729990000.5\n./src/b.c 7 1729990001.5\n"],
    });
    const mgr = new MirrorManager(first, mirrorRoot);
    await mgr.sync("/ws");
    expect(fs.existsSync(path.join(mirrorRoot, "src", "b.c"))).toBe(true);

    // When 第二次是增量：只有 a.c 变更，清单里没有 b.c Then 本地删掉 b.c
    const second = makeFakeConn({
      tars: [makeTarGz([{ path: "./src/a.c", content: "int a2;\n" }])],
      listings: ["./src/a.c 8 1729990100.5\n"],
    });
    const mgr2 = new MirrorManager(second, mirrorRoot);
    mgr2.loadPersistedManifest("/ws");
    const result = await mgr2.sync("/ws");
    expect(fs.existsSync(path.join(mirrorRoot, "src", "b.c"))).toBe(false);
    expect(fs.readFileSync(path.join(mirrorRoot, "src", "a.c"), "utf8")).toBe("int a2;\n");
    expect(result.removed).toEqual(["src/b.c"]);
  });

  it("test_rejects_remote_without_tar", async () => {
    const conn = makeFakeConn({ tars: [], listings: [], tarAvailable: false });
    const mgr = new MirrorManager(conn, path.join(scratch, "mirror"));
    await expect(mgr.sync("/ws")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("test_apply_local_save_updates_mirror_file", async () => {
    const conn = makeFakeConn({ tars: [makeTarGz([{ path: "./src/a.c", content: "int a;\n" }])], listings: ["./src/a.c 7 1729990000.5\n"] });
    const mirrorRoot = path.join(scratch, "mirror");
    const mgr = new MirrorManager(conn, mirrorRoot);
    await mgr.sync("/ws");
    await mgr.applyLocalSave("/ws/src/a.c", "int a2;\n", "utf8", "lf");
    expect(fs.readFileSync(path.join(mirrorRoot, "src", "a.c"), "utf8")).toBe("int a2;\n");
    expect(mgr.manifest().get("src/a.c")?.size).toBe(8);
  });
});

describe("T5.6 tar.gz 解包（纯 Node 实现）", () => {
  it("test_extracts_nested_files_and_long_paths", async () => {
    // Given 嵌套文件 + 超过 100 字节的长路径 When 解包 Then 内容与路径都对
    const longPath = "./src/" + "very-long-directory-name/".repeat(5) + "deep.c";
    const tarPath = path.join(scratch, "in.tar.gz");
    fs.writeFileSync(tarPath, makeTarGz([
      { path: "./src/a.c", content: "int a;\n" },
      { path: longPath, content: "int deep;\n" },
    ]));
    const dest = path.join(scratch, "out");
    await extractTarGz(tarPath, dest);
    expect(fs.readFileSync(path.join(dest, "src", "a.c"), "utf8")).toBe("int a;\n");
    expect(fs.readFileSync(path.join(dest, longPath.replace(/^\.\//, "")), "utf8")).toBe("int deep;\n");
  });

  it("test_handles_large_file_split_across_chunks", async () => {
    const big = "x".repeat(300 * 1024);
    const tarPath = path.join(scratch, "big.tar.gz");
    fs.writeFileSync(tarPath, makeTarGz([{ path: "./big.bin", content: big }]));
    const dest = path.join(scratch, "big-out");
    await extractTarGz(tarPath, dest);
    expect(fs.readFileSync(path.join(dest, "big.bin"), "utf8").length).toBe(big.length);
  });

  it("test_skips_path_traversal_entries", async () => {
    // Given 恶意 ../ 路径 When 解包 Then 不写到目标目录之外
    const tarPath = path.join(scratch, "evil.tar.gz");
    fs.writeFileSync(tarPath, makeTarGz([{ path: "../evil.txt", content: "bad" }]));
    const dest = path.join(scratch, "safe");
    await extractTarGz(tarPath, dest);
    expect(fs.existsSync(path.join(scratch, "evil.txt"))).toBe(false);
  });
});

// ---- 测试替身 ----

interface FakeConnOptions {
  tars: Buffer[];
  listings: string[];
  tarAvailable?: boolean;
}

/** 假 SSHConnection：exec 按命令分类应答；execStream 依次吐出 tar 流 + 清单 */
function makeFakeConn(opts: FakeConnOptions): FakeConnection {
  return new FakeConnection(opts);
}

class FakeConnection {
  private tarIndex = 0;
  constructor(private readonly opts: FakeConnOptions) {}

  async exec(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    if (cmd.includes("tar --version")) {
      return this.opts.tarAvailable === false
        ? { code: 1, stdout: "", stderr: "__RCE_NO_TAR__\n" }
        : { code: 0, stdout: "tar (GNU tar) 1.34\n", stderr: "" };
    }
    if (cmd.includes("gcc -dumpmachine")) {
      return { code: 0, stdout: "aarch64-linux-gnu\n/usr/lib/gcc/aarch64-linux-gnu/11/include\n", stderr: "" };
    }
    if (cmd.includes("python3 -c")) {
      return { code: 1, stdout: "", stderr: "python3: not found" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async execStream(_cmd: string): Promise<{
    stdout: NodeJS.ReadableStream;
    wait(): Promise<{ code: number; stderr: string }>;
    close(): void;
  }> {
    const tar = this.opts.tars[Math.min(this.tarIndex, this.opts.tars.length - 1)];
    const listing = this.opts.listings[Math.min(this.tarIndex, this.opts.listings.length - 1)];
    this.tarIndex++;
    return {
      stdout: Readable.from(tar),
      wait: async () => ({ code: 0, stderr: `1729990000\n${listing}` }),
      close: () => { /* noop */ },
    };
  }

  async sftpRun<T>(fn: (sftp: never) => Promise<T>): Promise<T> {
    return fn(undefined as never);
  }
}
describe("T5.7 镜像同步命令预算（§5.3.1）", () => {
  it("test_full_sync_command_is_single_exec_with_tar_and_listing", () => {
    const cmd = buildFullSyncCommand("/home/le/ws");
    // 同步本体 1 条 exec：内含 tar 单流 + 清单，不拆成多次远端调用
    expect(cmd).toContain("cd '/home/le/ws'");
    expect(cmd).toContain("tar --null -czf - -T -");
    expect(cmd).toContain("1>&2");
  });

  it("test_incremental_sync_command_is_single_exec", () => {
    const cmd = buildIncrementalSyncCommand("/home/le/ws", 1729990000);
    expect(cmd).toContain("-newermt '@1729990000'");
    expect(cmd).toContain("tar --null -czf - -T -");
    expect(cmd).toContain("1>&2");
  });
});
