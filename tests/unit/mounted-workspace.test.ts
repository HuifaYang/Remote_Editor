import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCmakeSources,
  parseIncludeSearch,
  prepareMountedWorkspace,
  rewriteMountedCompileCommand,
  rewriteMountedFlags,
} from "../../src/main/lsp/mounted-workspace";
import { mountedRemotePath, remotePathFromMount } from "../../src/main/lsp/sshfs-mount";
import type { SSHConnection } from "../../src/main/session/connection";

let scratch: string | null = null;
afterEach(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe("SSHFS 挂载语言视图", () => {
  it("把远端绝对路径映射到只读挂载前缀", () => {
    expect(mountedRemotePath("/mnt/remote", "/home/Le/ros2_ws/src/main.cpp")).toBe("/mnt/remote/home/Le/ros2_ws/src/main.cpp");
    expect(remotePathFromMount("/mnt/remote", "/mnt/remote/home/Le/ros2_ws/src/main.cpp")).toBe("/home/Le/ros2_ws/src/main.cpp");
    expect(remotePathFromMount("/mnt/remote", "/tmp/other.cpp")).toBeNull();
  });

  it("compile_commands 的工作目录、文件和所有绝对参数都改为挂载前缀", () => {
    const entry = rewriteMountedCompileCommand({
      directory: "/home/Le/ws",
      file: "/home/Le/ws/src/main.cpp",
      command: "g++ -I/opt/ros/humble/include -c /home/Le/ws/src/main.cpp -o /home/Le/ws/build/main.o",
    }, "/mnt/remote", "aarch64-linux-gnu", ["/usr/include/c++/11", "/opt/ros/humble/include"], "gnu++17");
    expect(entry.directory).toBe("/mnt/remote/home/Le/ws");
    expect(entry.file).toBe("/mnt/remote/home/Le/ws/src/main.cpp");
    expect(entry.command).toContain("'/mnt/remote/opt/ros/humble/include'");
    expect(entry.command).toContain("'--target=aarch64-linux-gnu'");
    expect(entry.command).toContain("'-isystem' '/mnt/remote/usr/include/c++/11'");
    expect(entry.command).toContain("'-std=gnu++17'");
  });

  it("从 build.make 提取每个 target 的真实源文件", () => {
    const buildMake = [
      "CMakeFiles/diff_driver_node.dir/src/diff_driver_node.cpp.o: /ws/src/diff_driver_node.cpp",
      "CMakeFiles/diff_driver_node.dir/src/protocol.cpp.o: /ws/src/protocol.cpp",
      "CMakeFiles/foo.dir/include/a.hpp.o: /ws/include/a.hpp",
    ].join("\n");
    expect(parseCmakeSources(buildMake)).toEqual(["/ws/src/diff_driver_node.cpp", "/ws/src/protocol.cpp"]);
  });

  it("flags 与 GCC include 搜索解析保留全部目标系统目录", () => {
    expect(rewriteMountedFlags(["-I/opt/ros/humble/include", "-DROS=1"], "/mnt/remote"))
      .toEqual(["-I/mnt/remote/opt/ros/humble/include", "-DROS=1"]);
    const stderr = [
      "ignoring nonexistent directory",
      "#include <...> search starts here:",
      " /usr/lib/gcc/aarch64-linux-gnu/11/include",
      " /usr/include/c++/11",
      " /usr/include/aarch64-linux-gnu/c++/11",
      "End of search list.",
    ].join("\n");
    expect(parseIncludeSearch(stderr)).toEqual([
      "/usr/lib/gcc/aarch64-linux-gnu/11/include",
      "/usr/include/c++/11",
      "/usr/include/aarch64-linux-gnu/c++/11",
    ]);
  });

  it("按 target 生成逐文件编译命令，不混入 rosidl 的 gnu++14", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rce-mounted-workspace-"));
    const mountRoot = path.join(scratch, "root");
    const flagsRoot = path.join(mountRoot, "remote/build/CMakeFiles");
    const mainDir = path.join(flagsRoot, "diff_driver_node.dir");
    const rosDir = path.join(flagsRoot, "pkg__rosidl_typesupport_cpp.dir");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(rosDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, "flags.make"), [
      "CXX_DEFINES = -DDEFAULT_RMW_IMPLEMENTATION=rmw_fastrtps_cpp",
      "CXX_INCLUDES = -I/remote/src/include -isystem /opt/ros/humble/include/rclcpp",
      "CXX_FLAGS = -Wall -Wextra",
    ].join("\n"));
    fs.writeFileSync(path.join(mainDir, "build.make"), [
      "CMakeFiles/diff_driver_node.dir/src/main.cpp.o: /remote/src/main.cpp",
    ].join("\n"));
    fs.writeFileSync(path.join(rosDir, "flags.make"), [
      "CXX_INCLUDES = -I/remote/build/rosidl_generator_cpp",
      "CXX_FLAGS = -fPIC -std=gnu++14",
    ].join("\n"));
    fs.writeFileSync(path.join(rosDir, "build.make"), [
      "CMakeFiles/pkg__rosidl_typesupport_cpp.dir/src/generated.cpp.o: /remote/build/rosidl_generator_cpp/generated.cpp",
    ].join("\n"));
    const mainFlags = "/remote/build/CMakeFiles/diff_driver_node.dir/flags.make";
    const rosFlags = "/remote/build/CMakeFiles/pkg__rosidl_typesupport_cpp.dir/flags.make";
    const conn = {
      exec: async (command: string) => {
        if (command.includes("compile_commands.json")) return { code: 0, stdout: "", stderr: "" };
        if (command.includes("flags.make")) return { code: 0, stdout: `${mainFlags}\n${rosFlags}\n`, stderr: "" };
        if (command.includes("gcc -dumpmachine")) return { code: 0, stdout: "aarch64-linux-gnu\n", stderr: "" };
        if (command.includes("__cplusplus")) return { code: 0, stdout: "#define __cplusplus 201703L\n", stderr: "" };
        if (command.includes("-E -x c++")) {
          return {
            code: 0,
            stdout: "",
            stderr: "#include <...> search starts here:\n /usr/include/c++/11\n /usr/include/aarch64-linux-gnu/c++/11\nEnd of search list.\n",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as SSHConnection;
    const result = await prepareMountedWorkspace({
      conn, remoteRoot: "/remote", mountRoot, cacheDir: path.join(scratch, "cache"),
    });
    const commands = JSON.parse(fs.readFileSync(path.join(result.compileCommandsDir, "compile_commands.json"), "utf8"));
    const main = commands.find((entry: { file: string }) => entry.file.endsWith("/remote/src/main.cpp"));
    expect(main.arguments).toContain("-std=gnu++17");
    expect(main.arguments).not.toContain("-std=gnu++14");
    expect(main.arguments.filter((arg: string) => arg.includes("/usr/include/c++/11"))).toHaveLength(1);
    expect(main.arguments.filter((arg: string) => arg === "-isystem").length).toBeGreaterThanOrEqual(2);
  });
});
