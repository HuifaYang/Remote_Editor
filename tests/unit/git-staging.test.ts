// M5 暂存区：状态拆分（纯函数）+ 逐文件暂存/取消/丢弃/仓库管理的命令拼装
import { describe, expect, it } from "vitest";
import { GitRemote } from "../../src/main/session/git";
import { splitStatus } from "../../src/shared/git-status";
import type { GitFileStatus, GitTreeStatus } from "../../src/shared/types";

class RecordingConn {
  readonly calls: Array<{ cmd: string; cwd?: string }> = [];
  constructor(private readonly replies: Array<{ code: number; stdout: string; stderr: string }> = []) {}
  async exec(cmd: string, opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push({ cmd, cwd: opts?.cwd });
    return this.replies.shift() ?? { code: 0, stdout: "", stderr: "" };
  }
}

function treeWith(files: Record<string, { index: string; worktree: string; letter: GitFileStatus["letter"]; change: GitFileStatus["change"] }>): GitTreeStatus {
  const entries: Record<string, GitFileStatus> = {};
  for (const [abs, st] of Object.entries(files)) {
    entries[abs] = { path: abs.replace("/ws/", ""), indexStatus: st.index, worktreeStatus: st.worktree, letter: st.letter, change: st.change };
  }
  return {
    root: "/ws", branch: "main", scope: "/ws", files: entries, dirs: {}, untrackedDirs: [],
    fetchedAt: Date.now(), complete: true, label: "Git: main",
  };
}

describe("M5.1 快照 → 暂存区/工作区拆分", () => {
  it("test_splits_staged_unstaged_and_untracked", () => {
    const status = treeWith({
      "/ws/a.c": { index: "M", worktree: " ", letter: "M", change: "modified" },   // 已暂存
      "/ws/b.c": { index: " ", worktree: "M", letter: "M", change: "modified" },   // 仅工作区
      "/ws/c.c": { index: "M", worktree: "M", letter: "M", change: "modified" },   // 两边都有
      "/ws/d.c": { index: "?", worktree: "?", letter: "U", change: "added" },      // 未跟踪
      "/ws/e.c": { index: "R", worktree: " ", letter: "R", change: "modified" },   // 重命名（暂存）
    });
    const { staged, unstaged } = splitStatus(status);
    expect(staged.map((e) => e.path)).toEqual(["a.c", "c.c", "e.c"]);
    expect(staged.find((e) => e.path === "e.c")?.letter).toBe("R");
    expect(unstaged.map((e) => e.path)).toEqual(["b.c", "c.c", "d.c"]);
    expect(unstaged.find((e) => e.path === "d.c")).toMatchObject({ letter: "U", staged: false });
  });
});

describe("M5.2 暂存 / 取消 / 丢弃（每条 1 条命令 + 路径转义）", () => {
  it("test_stage_quotes_paths_and_uses_one_command", async () => {
    const conn = new RecordingConn();
    const git = new GitRemote(conn as never);
    await git.stage("/ws", ["src/a.c", "dir with space/b.c"]);
    expect(conn.calls).toHaveLength(1);
    expect(conn.calls[0].cmd).toBe("git add -- 'src/a.c' 'dir with space/b.c'");
    expect(conn.calls[0].cwd).toBe("/ws");
  });

  it("test_unstage_uses_restore_staged", async () => {
    const conn = new RecordingConn();
    const git = new GitRemote(conn as never);
    await git.unstage("/ws", ["a.c"]);
    expect(conn.calls[0].cmd).toBe("git restore --staged -- 'a.c'");
  });

  it("test_discard_and_clean_have_separate_semantics", async () => {
    const conn = new RecordingConn();
    const git = new GitRemote(conn as never);
    await git.discard("/ws", ["a.c"]);
    await git.clean("/ws", ["new.c"]);
    const cmds = conn.calls.map((c) => c.cmd);
    expect(cmds).toContain("git restore -- 'a.c'");
    expect(cmds).toContain("git clean -fd -- 'new.c'");
  });

  it("test_unstage_all_falls_back_to_reset_before_first_commit", async () => {
    // Given 还没有提交（restore --staged 失败）When 全部取消暂存 Then 退化到 git reset -q
    const conn = new RecordingConn([{ code: 1, stdout: "", stderr: "fatal: could not resolve HEAD" }]);
    const git = new GitRemote(conn as never);
    await git.unstageAll("/ws");
    expect(conn.calls[0].cmd).toBe("git restore --staged .");
    expect(conn.calls[1].cmd).toBe("git reset -q");
  });

  it("test_local_staged_mark_updates_snapshot_without_git", async () => {
    // Given 一份含未暂存修改的快照 When 暂存该文件 Then 快照本地变成「已暂存」，只发 1 条 git 命令
    const conn = new RecordingConn([
      { code: 0, stdout: "/ws\nmain\n", stderr: "" },                    // treeStatus: rev-parse
      { code: 0, stdout: " M src/a.c\n", stderr: "" },                   // treeStatus: status
      { code: 0, stdout: "", stderr: "" },                               // stage
    ]);
    const git = new GitRemote(conn as never);
    await git.treeStatus("/ws");
    await git.stage("/ws", ["/ws/src/a.c"]);
    const snap = git.treeFor("/ws")?.toSnapshot();
    expect(conn.calls.filter((c) => c.cmd.startsWith("git ")).length).toBe(3);
    expect(snap?.files["/ws/src/a.c"]).toMatchObject({ indexStatus: "M", worktreeStatus: " " });
  });
});

describe("M5.3 仓库管理", () => {
  it("test_clone_runs_in_parent_dir", async () => {
    const conn = new RecordingConn();
    const git = new GitRemote(conn as never);
    await git.clone("git@github.com:a/b.git", "/home/le/proj");
    expect(conn.calls[0].cmd).toBe("git clone -- 'git@github.com:a/b.git' 'proj'");
    expect(conn.calls[0].cwd).toBe("/home/le");
  });

  it("test_init_tags_remotes_and_stash", async () => {
    const conn = new RecordingConn([
      { code: 0, stdout: "", stderr: "" },                              // init
      { code: 0, stdout: "v1.0\nv0.9\n", stderr: "" },                  // tags
      { code: 0, stdout: "origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n", stderr: "" },
      { code: 0, stdout: "Saved working directory\n", stderr: "" },     // stash push
    ]);
    const git = new GitRemote(conn as never);
    await git.init("/ws");
    expect(await git.tags("/ws")).toEqual([
      { name: "v1.0", hash: "", message: "", date: "" },
      { name: "v0.9", hash: "", message: "", date: "" },
    ]);
    expect(await git.remotes("/ws")).toEqual([{ name: "origin", fetchUrl: "git@github.com:a/b.git", pushUrl: "git@github.com:a/b.git" }]);
    await git.stashSave("/ws", "改一下");
    expect(conn.calls.map((c) => c.cmd)).toEqual([
      "git init", "git for-each-ref --sort=-creatordate --format='%(refname:short)%09%(objectname:short)%09%(contents:subject)%09%(creatordate:iso)' refs/tags", "git remote -v", "git stash push -m '改一下'",
    ]);
  });
});
