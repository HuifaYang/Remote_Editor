// T7：远端 Git（mock exec；往返次数预算是硬断言，总纲 §5.4 / §7）
import { describe, expect, it, vi } from "vitest";
import { GitRemote } from "../../src/main/session/git";
import type { SSHConnection } from "../../src/main/session/connection";
import type { GitFileStatus } from "../../src/shared/types";

interface ExecCall { cmd: string; cwd?: string }

/** 按规则应答的假 exec：rules = [匹配子串/正则, 应答] 按序匹配；未命中返回 code 0 空输出 */
function fakeConn(rules: Array<[RegExp, { code: number; stdout: string; stderr: string }]>) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(async (cmd: string, opts?: { cwd?: string }) => {
    calls.push({ cmd, cwd: opts?.cwd });
    for (const [pattern, reply] of rules) {
      if (pattern.test(cmd)) return reply;
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  return { conn: { exec } as unknown as SSHConnection, exec, calls };
}

type Reply = { code: number; stdout: string; stderr: string };
const REV_PARSE: [RegExp, Reply] = [/rev-parse --show-toplevel/, { code: 0, stdout: "/ws\nmain\n", stderr: "" }];

describe("往返预算", () => {
  it("test_tree_status_uses_two_commands", async () => {
    // Given 正常仓库 When treeStatus Then exec 恰好 2 次（rev-parse 合并 + status）
    const { conn, calls } = fakeConn([
      REV_PARSE,
      [/git status/, { code: 0, stdout: " M src/main.c\n", stderr: "" }],
    ]);
    const git = new GitRemote(conn);
    const snap = await git.treeStatus("/ws");
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toContain("rev-parse --show-toplevel");
    expect(calls[0].cmd).toContain("abbrev-ref");           // rev-parse 合并成一条
    expect(calls[1].cmd).toContain("git status --porcelain -uall");
    expect(snap.files["/ws/src/main.c"]).toMatchObject({ letter: "M" });
    expect(snap.branch).toBe("main");
  });
  it("test_clean_file_diff_uses_zero_git_commands", async () => {
    // Given 快照判「未变更」Then 打开文件 0 条 git 命令
    const { conn, calls } = fakeConn([]);
    const git = new GitRemote(conn);
    const clean: GitFileStatus = { path: "a.c", indexStatus: " ", worktreeStatus: " ", letter: "", change: null };
    const diff = await git.fileDiff("/ws", "a.c", "content", clean);
    expect(diff.addedLines).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it("test_untracked_file_diff_uses_zero_git_commands", async () => {
    // Given 未跟踪文件 + 当前内容 Then 0 条命令、全部行算 added
    const { conn, calls } = fakeConn([]);
    const git = new GitRemote(conn);
    const untracked: GitFileStatus = { path: "u.c", indexStatus: "?", worktreeStatus: "?", letter: "U", change: "added" };
    const diff = await git.fileDiff("/ws", "u.c", "l1\nl2", untracked);
    expect(diff.addedLines).toEqual([1, 2]);
    expect(calls).toHaveLength(0);
  });
  it("test_modified_file_diff_uses_one_git_command", async () => {
    const { conn, calls } = fakeConn([
      [/git diff/, { code: 0, stdout: "@@ -1 +1 @@\n-a\n+b\n", stderr: "" }],
    ]);
    const git = new GitRemote(conn);
    const modified: GitFileStatus = { path: "m.c", indexStatus: " ", worktreeStatus: "M", letter: "M", change: "modified" };
    await git.fileDiff("/ws", "m.c", undefined, modified);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toContain("git diff");
  });
});

describe("提交 / 推送 / 同步", () => {
  it("test_commit_all_stages_then_commits", async () => {
    const { conn, calls } = fakeConn([]);
    await new GitRemote(conn).commitAll("/ws", "修好了");
    expect(calls.map((c) => c.cmd)).toEqual(["git add -A", "git commit -m '修好了'"]);
  });
  it("test_commit_amend_empty_message_uses_no_edit", async () => {
    const { conn, calls } = fakeConn([]);
    await new GitRemote(conn).commitAll("/ws", "", { amend: true });
    expect(calls[1].cmd).toContain("--amend --no-edit");
  });
  it("test_commit_empty_message_rejected", async () => {
    const { conn } = fakeConn([]);
    await expect(new GitRemote(conn).commitAll("/ws", "")).rejects.toMatchObject({ code: "invalid-input" });
  });
  it("test_push_sets_upstream_when_missing", async () => {
    // Given push 报 no upstream branch Then 重试 push -u origin <branch>
    const { conn, calls } = fakeConn([
      [/^git push$/, { code: 1, stdout: "", stderr: "fatal: The current branch main has no upstream branch." }],
      [/rev-parse --abbrev-ref HEAD/, { code: 0, stdout: "main\n", stderr: "" }],
    ]);
    await new GitRemote(conn).push("/ws");
    expect(calls.map((c) => c.cmd)).toEqual([
      "git push",
      "git rev-parse --abbrev-ref HEAD",
      "git push -u origin 'main'",
    ]);
  });
  it("test_sync_pulls_then_pushes", async () => {
    const { conn, calls } = fakeConn([]);
    await new GitRemote(conn).sync("/ws");
    const cmds = calls.map((c) => c.cmd);
    expect(cmds[0]).toBe("git pull");
    expect(cmds.indexOf("git push")).toBeGreaterThan(cmds.indexOf("git pull"));
  });
  it("test_sync_falls_back_to_rebase", async () => {
    const { conn, calls } = fakeConn([
      [/^git pull$/, { code: 1, stdout: "", stderr: "fatal: not possible to fast-forward" }],
    ]);
    await new GitRemote(conn).sync("/ws");
    expect(calls.map((c) => c.cmd)).toContain("git pull --rebase");
  });
});

describe("分支与提交图", () => {
  it("test_switch_branch_rejects_dash_prefix", async () => {
    const { conn } = fakeConn([]);
    await expect(new GitRemote(conn).switchBranch("/ws", "-x")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(new GitRemote(conn).switchBranch("/ws", "")).rejects.toMatchObject({ code: "invalid-input" });
  });
  it("test_switch_branch_uses_checkout", async () => {
    const { conn, calls } = fakeConn([]);
    await new GitRemote(conn).switchBranch("/ws", "dev");
    expect(calls[0].cmd).toBe("git checkout 'dev'");
  });
  it("test_branches_parses_detached_head", async () => {
    const { conn } = fakeConn([
      [/git branch/, {
        code: 0,
        stdout: "* (HEAD detached at abc1234)\n  main\n  remotes/origin/main\n",
        stderr: "",
      }],
    ]);
    const branches = await new GitRemote(conn).branches("/ws");
    expect(branches[0]).toMatchObject({ current: true, detached: true });
    expect(branches.find((b) => b.name === "main")).toMatchObject({ remote: false });
    expect(branches.find((b) => b.name === "origin/main")).toMatchObject({ remote: true });
  });
  it("test_log_graph_returns_layouted_rows", async () => {
    const line = "abc123\0\0作者\0今天\0首个提交\0HEAD -> main";
    const { conn } = fakeConn([[/git log/, { code: 0, stdout: line + "\n", stderr: "" }]]);
    const rows = await new GitRemote(conn).logGraph("/ws");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 0, laneCount: 1 });
    expect(rows[0].commit).toMatchObject({ hash: "abc123", subject: "首个提交", refs: ["HEAD -> main"] });
  });
});

describe("快照本地更新（保存后 0 条 git 命令）", () => {
  it("markSaved 不重扫仓库", async () => {
    const { conn, calls } = fakeConn([
      REV_PARSE,
      [/git status/, { code: 0, stdout: " M a.c\n", stderr: "" }],
    ]);
    const git = new GitRemote(conn);
    await git.treeStatus("/ws");
    expect(calls).toHaveLength(2);
    const tree = git.treeFor("/ws");
    expect(tree?.markSaved("/ws/a.c")).toBe(true);
    expect(tree?.toSnapshot().files).toEqual({});
    expect(calls).toHaveLength(2);   // 没有新增远端命令
  });
});
