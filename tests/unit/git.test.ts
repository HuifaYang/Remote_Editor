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
  it("test_tree_status_parses_workspace_prefix_and_upstream", async () => {
    const { conn } = fakeConn([
      [/rev-parse --show-toplevel/, {
        code: 0,
        stdout: "/robotdata/ws\nmain\nabc123\npkg/\nrefs/remotes/origin/main\ndef456\n",
        stderr: "",
      }],
      [/git status/, { code: 0, stdout: "", stderr: "" }],
    ]);
    const snap = await new GitRemote(conn).treeStatus("/home/me/ws/pkg");
    expect(snap).toMatchObject({
      root: "/robotdata/ws",
      workspacePrefix: "pkg/",
      upstreamRef: "refs/remotes/origin/main",
      upstreamCommit: "def456",
    });
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
  it("test_branches_reads_for_each_ref_with_revision", async () => {
    // for-each-ref 输出：refname \0 objectname \0 HEAD 标记；revision 必须带出来（历史图配色/定位依赖它）
    const { conn } = fakeConn([
      [/git for-each-ref/, {
        code: 0,
        stdout: [
          "refs/heads/main\0abc1234000000000000000000000000000000000\0*",
          "refs/heads/dev\0def5678000000000000000000000000000000000\0 ",
          "refs/remotes/origin/main\0feed123000000000000000000000000000000000\0 ",
          "refs/remotes/origin/HEAD\0abc1234000000000000000000000000000000000\0 ",
        ].join("\n") + "\n",
        stderr: "",
      }],
    ]);
    const branches = await new GitRemote(conn).branches("/ws");
    expect(branches.find((b) => b.name === "main")).toMatchObject({ current: true, remote: false, revision: "abc1234000000000000000000000000000000000" });
    expect(branches.find((b) => b.name === "dev")).toMatchObject({ remote: false });
    expect(branches.find((b) => b.name === "origin/main")).toMatchObject({ remote: true });
    // origin/HEAD 是符号引用，必须跳过
    expect(branches.find((b) => b.name === "origin/HEAD")).toBeUndefined();
  });
  it("test_branches_reads_upstream", async () => {
    const { conn } = fakeConn([
      [/git for-each-ref/, {
        code: 0,
        stdout: "refs/heads/main\0abc123\0*\0origin/main\n",
        stderr: "",
      }],
    ]);
    await expect(new GitRemote(conn).branches("/ws")).resolves.toEqual([
      expect.objectContaining({ name: "main", upstream: "origin/main" }),
    ]);
  });
  it("test_log_graph_returns_layouted_rows", async () => {
    const line = "abc123\0\0作者\0今天\0首个提交\0HEAD -> main";
    const { conn } = fakeConn([[/git log/, { code: 0, stdout: line + "\n", stderr: "" }]]);
    const rows = await new GitRemote(conn).logGraph("/ws");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 0, laneCount: 1 });
    expect(rows[0].commit).toMatchObject({ hash: "abc123", subject: "首个提交", refs: ["HEAD -> main"] });
  });
  it("test_log_graph_uses_requested_branch_revisions", async () => {
    const { conn, calls } = fakeConn([[/git log/, { code: 0, stdout: "", stderr: "" }]]);
    await new GitRemote(conn).logGraph("/ws", 50, ["abc123", "def456"], 10);
    expect(calls[0].cmd).toContain("--topo-order");
    expect(calls[0].cmd).toContain("--max-count=50");
    expect(calls[0].cmd).toContain("--skip=10");
    expect(calls[0].cmd).toContain("'abc123' 'def456'");
    expect(calls[0].cmd).not.toContain("--all");
  });
  it("test_checkout_revert_reset_quote_revision", async () => {
    const { conn, calls } = fakeConn([]);
    const git = new GitRemote(conn);
    await git.checkoutRev("/ws", "abc123");
    await git.revert("/ws", "def456");
    await git.resetHard("/ws", "fedcba");
    expect(calls.map((c) => c.cmd)).toEqual([
      "git checkout 'abc123'",
      "git revert --no-edit 'def456'",
      "git reset --hard 'fedcba'",
    ]);
  });
  it("test_commit_changes_parses_add_modify_rename", async () => {
    const { conn } = fakeConn([[/git diff-tree/, {
      code: 0,
      stdout: "M\tsrc/main.c\nA\tsrc/new.c\nR100\tsrc/old.c\tsrc/renamed.c\n",
      stderr: "",
    }]]);
    await expect(new GitRemote(conn).commitChanges("/ws", "abc123")).resolves.toEqual([
      { status: "M", path: "src/main.c" },
      { status: "A", path: "src/new.c" },
      { status: "R", path: "src/renamed.c" },
    ]);
  });
  it("test_commit_changes_uses_parent_for_merge_commit", async () => {
    const { conn, calls } = fakeConn([[/git diff --name-status/, {
      code: 0,
      stdout: "M\tsrc/main.c\n",
      stderr: "",
    }]]);
    await new GitRemote(conn).commitChanges("/ws", "merge123", "parent456");
    expect(calls[0].cmd).toBe("git diff --name-status -r 'parent456' 'merge123'");
  });
  it("test_commit_changes_surfaces_git_stderr", async () => {
    const { conn } = fakeConn([[/git diff-tree/, { code: 128, stdout: "", stderr: "bad revision" }]]);
    await expect(new GitRemote(conn).commitChanges("/ws", "nope")).rejects.toMatchObject({
      code: "git",
      detail: "bad revision",
    });
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
