// T1：路径规范化与 shell 引号（样例来自分册 1 · A1，原样进测试）
import { describe, expect, it } from "vitest";
import { normalizeRemotePath, shellQuote } from "../../src/shared/paths";

describe("normalizeRemotePath", () => {
  it("test_normalize_expands_tilde_with_home", () => {
    // Given home="/home/le" When normalize("~/ros2_ws/src/") Then "/home/le/ros2_ws/src"
    expect(normalizeRemotePath("~/ros2_ws/src/", "/home/le")).toBe("/home/le/ros2_ws/src");
  });
  it("test_normalize_collapses_dot_segments", () => {
    expect(normalizeRemotePath("/home/le/../le/x/./y//", "/home/le")).toBe("/home/le/x/y");
  });
  it("test_normalize_relative_uses_home", () => {
    expect(normalizeRemotePath("a/b", "/home/le")).toBe("/home/le/a/b");
  });
  it("test_normalize_empty_returns_home", () => {
    expect(normalizeRemotePath("", "/home/le")).toBe("/home/le");
    expect(normalizeRemotePath("", "")).toBe("/");
  });
  it("test_normalize_root_stays_root", () => {
    expect(normalizeRemotePath("/", "/home/le")).toBe("/");
  });
  it("test_normalize_clamps_above_root", () => {
    expect(normalizeRemotePath("/../../etc", "/home/le")).toBe("/etc");
  });
  it("test_normalize_tilde_alone_is_home", () => {
    expect(normalizeRemotePath("~", "/home/le")).toBe("/home/le");
  });
});

describe("shellQuote", () => {
  it("test_shell_quote_escapes_single_quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it("test_shell_quote_protects_leading_dash", () => {
    expect(shellQuote("-Wall")).toBe("'-Wall'");
  });
  it("test_shell_quote_empty", () => {
    expect(shellQuote("")).toBe("''");
  });
});
