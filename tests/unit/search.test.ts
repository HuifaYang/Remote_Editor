// T5：全局搜索（命令拼装 + A10 结果解析）
import { describe, expect, it, vi } from "vitest";
import { parseSearchResults, SearchRemote } from "../../src/main/session/search";
import type { SSHConnection } from "../../src/main/session/connection";

/** mock exec 的连接：记录命令，返回固定结果 */
function fakeConn(result: { code: number; stdout: string; stderr: string }) {
  const exec = vi.fn(async () => result);
  return { conn: { exec } as unknown as SSHConnection, exec };
}

describe("SearchRemote 命令拼装", () => {
  it("test_command_uses_extended_mode_for_regex", async () => {
    const { conn, exec } = fakeConn({ code: 1, stdout: "", stderr: "" });
    await new SearchRemote(conn).search("/ws", "foo.*", { caseSensitive: true, regex: true });
    const cmd = exec.mock.calls[0][0] as string;
    expect(cmd).toContain("-E");
    expect(cmd).not.toContain("-F");
  });
  it("test_command_uses_fixed_mode_for_plain", async () => {
    const { conn, exec } = fakeConn({ code: 1, stdout: "", stderr: "" });
    await new SearchRemote(conn).search("/ws", "foo", { caseSensitive: true, regex: false });
    expect(exec.mock.calls[0][0]).toContain("-F");
  });
  it("test_command_case_insensitive_flag", async () => {
    const { conn, exec } = fakeConn({ code: 1, stdout: "", stderr: "" });
    await new SearchRemote(conn).search("/ws", "foo", { caseSensitive: false, regex: false });
    expect(exec.mock.calls[0][0]).toContain("-i");
  });
  it("test_keyword_starting_with_dash_is_quoted", async () => {
    const { conn, exec } = fakeConn({ code: 1, stdout: "", stderr: "" });
    await new SearchRemote(conn).search("/ws", "-Wall", { caseSensitive: true, regex: false });
    expect(exec.mock.calls[0][0]).toContain("-e '-Wall'");
  });
  it("test_exit_code_1_is_empty_not_error", async () => {
    const { conn } = fakeConn({ code: 1, stdout: "", stderr: "" });
    await expect(new SearchRemote(conn).search("/ws", "foo", { caseSensitive: true, regex: false }))
      .resolves.toEqual([]);
  });
  it("test_other_exit_code_throws", async () => {
    const { conn } = fakeConn({ code: 2, stdout: "", stderr: "grep: error" });
    await expect(new SearchRemote(conn).search("/ws", "foo", { caseSensitive: true, regex: false }))
      .rejects.toMatchObject({ code: "ssh" });
  });
});

describe("parseSearchResults（A10）", () => {
  it("test_parse_line_number_and_text", () => {
    const stdout = "/ws/src/a.c:12:int handle_dock(int x) {\n/ws/docs/b.md:3:handle_dock 的说明\n";
    expect(parseSearchResults(stdout)).toEqual([
      { path: "/ws/src/a.c", line: 12, text: "int handle_dock(int x) {" },
      { path: "/ws/docs/b.md", line: 3, text: "handle_dock 的说明" },
    ]);
  });
  it("test_parse_skips_non_numeric_line", () => {
    expect(parseSearchResults("/ws/a.c:abc:text\n")).toEqual([]);
  });
  it("test_results_capped_at_500", () => {
    const stdout = Array.from({ length: 600 }, (_, i) => `/ws/a.c:${i + 1}:hit`).join("\n");
    expect(parseSearchResults(stdout)).toHaveLength(500);
  });
});
