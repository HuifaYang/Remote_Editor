import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLANGD_ARGS,
  matchLanguageServer,
  resolveLanguageServers,
  rootMarkersFor,
  splitCommandLine,
} from "../../src/main/lsp/server-config";

describe("通用语言服务器注册表", () => {
  it("默认提供 C++ 与 Python，并保留 clangd 参数", () => {
    const servers = resolveLanguageServers({});
    expect(servers.get("cpp")?.command).toBe("clangd");
    expect(servers.get("cpp")?.args).toEqual(DEFAULT_CLANGD_ARGS);
    expect(servers.get("cpp")?.languageIds).toEqual(["c", "cpp"]);
    expect(servers.get("python")?.command).toBe("python3");
    expect(servers.get("python")?.args).toEqual(["-m", "pylsp"]);
  });

  it("可以注册任意标准 LSP，并按 languageId 或扩展名匹配", () => {
    const servers = resolveLanguageServers({
      go: {
        command: "gopls",
        args: ["serve"],
        extensions: ["go"],
        rootMarkers: ["go.mod"],
        env: { GOMAXPROCS: "1" },
      },
      rust: { command: "rust-analyzer", extensions: [".rs"] },
    });
    expect(servers.get("go")).toMatchObject({
      command: "gopls",
      args: ["serve"],
      languageIds: ["go"],
      extensions: [".go"],
      env: { GOMAXPROCS: "1" },
    });
    expect(matchLanguageServer(servers.values(), "go", "/ws/main.go")?.server.id).toBe("go");
    expect(matchLanguageServer(servers.values(), "plaintext", "/ws/main.RS")?.server.id).toBe("rust");
    expect(rootMarkersFor(servers.values()).has("go.mod")).toBe(true);
  });

  it("支持关闭默认服务器、覆盖旧路径设置和带引号命令", () => {
    const servers = resolveLanguageServers({ python: false }, {
      cppCommand: "'/opt/llvm/bin/clangd' --background-index=false",
    });
    expect(servers.has("python")).toBe(false);
    expect(servers.get("cpp")).toMatchObject({
      command: "/opt/llvm/bin/clangd",
      args: ["--background-index=false"],
    });
  });

  it("命令拆分会保留引号中的空格", () => {
    expect(splitCommandLine(`'/opt/My Tools/lsp' --stdio "a b"`)).toEqual(["/opt/My Tools/lsp", "--stdio", "a b"]);
  });
});
