// T2：porcelain 解析 / 目录继承色 / 本地更新 / 路径换算（样例来自分册 1 · A2~A5）
import { describe, expect, it } from "vitest";
import { parsePorcelain, propagateInto, TreeStatus, type ChangeKind } from "../../src/shared/git-status";

describe("parsePorcelain（A2）", () => {
  it("test_parse_basic_states", () => {
    // Given M/A 各一行 When 解析 Then letter 与 change 正确
    const { files } = parsePorcelain(" M src/main.c\nA  src/new.c\n");
    expect(files.get("src/main.c")).toMatchObject({ letter: "M", change: "modified", indexStatus: " ", worktreeStatus: "M" });
    expect(files.get("src/new.c")).toMatchObject({ letter: "A", change: "added", indexStatus: "A", worktreeStatus: " " });
  });
  it("test_parse_rename_takes_new_path", () => {
    const { files } = parsePorcelain("R  old.c -> new.c\n");
    expect(files.has("old.c")).toBe(false);
    expect(files.get("new.c")).toMatchObject({ letter: "R", change: "modified" });
  });
  it("test_parse_quoted_path", () => {
    const { files } = parsePorcelain(' D "quoted name.c"\n');
    expect(files.get("quoted name.c")).toMatchObject({ letter: "D", change: "deleted" });
  });
  it("test_parse_untracked_dir_goes_to_untracked_dirs", () => {
    const { files, untrackedDirs } = parsePorcelain("?? untracked_dir/\n");
    expect(files.size).toBe(0);
    expect(untrackedDirs).toEqual(["untracked_dir"]);
  });
  it("test_parse_conflict_pair_is_exclamation", () => {
    const { files } = parsePorcelain("UU src/conflict.c\n");
    expect(files.get("src/conflict.c")).toMatchObject({ letter: "!", change: "modified" });
  });
});

describe("propagateInto（A3）", () => {
  it("test_propagate_reaches_root_with_priority", () => {
    // Given root=/ws，/ws/a/b/c.c=modified，/ws/a/d.c=added
    const dirs = new Map<string, ChangeKind>();
    propagateInto(dirs, "/ws/a/b/c.c", "modified", "/ws");
    propagateInto(dirs, "/ws/a/d.c", "added", "/ws");
    // Then 继承色传播到根，且 modified 优先于 added
    expect(dirs.get("/ws/a/b")).toBe("modified");
    expect(dirs.get("/ws/a")).toBe("modified");
    expect(dirs.get("/ws")).toBe("modified");
  });
});

/** 造一个 root=/ws、scope=/ws 的快照，files 用仓库相对路径传入 */
function makeTree(files: Record<string, { letter: "U" | "A" | "M" | "D" | "R"; change: ChangeKind }>): TreeStatus {
  const map = new Map(
    Object.entries(files).map(([rel, st]) => [
      rel,
      { path: rel, indexStatus: " ", worktreeStatus: st.letter, letter: st.letter, change: st.change },
    ]),
  );
  return TreeStatus.fromParsed("/ws", "/ws", "main", { files: map, untrackedDirs: [] });
}

describe("TreeStatus 本地更新（A4）", () => {
  it("test_mark_saved_clean_removes_and_recomputes_dirs", () => {
    // Given 一个 modified 文件 When markSaved(clean=true) Then files 空、dirs 重算为空
    const tree = makeTree({ "a.c": { letter: "M", change: "modified" } });
    expect(tree.markSaved("/ws/a.c", true)).toBe(true);
    expect(tree.files.size).toBe(0);
    expect(tree.dirs.size).toBe(0);
  });
  it("test_mark_saved_keeps_untracked_added", () => {
    // Given untracked U When markSaved(clean=false) Then 仍是 U
    const tree = makeTree({ "u.c": { letter: "U", change: "added" } });
    expect(tree.markSaved("/ws/u.c", false)).toBe(true);
    expect(tree.files.get("/ws/u.c")).toMatchObject({ letter: "U", change: "added" });
  });
  it("test_mark_saved_dirty_marks_modified", () => {
    // Given 干净文件 When markSaved(clean=false) Then 变 modified/M，目录色重建
    const tree = makeTree({});
    expect(tree.markSaved("/ws/src/m.c", false)).toBe(true);
    expect(tree.files.get("/ws/src/m.c")).toMatchObject({ letter: "M", change: "modified" });
    expect(tree.dirs.get("/ws/src")).toBe("modified");
    expect(tree.dirs.get("/ws")).toBe("modified");
  });
  it("test_mark_removed_marks_tracked_deleted", () => {
    // Given tracked M When markRemoved Then D
    const tree = makeTree({ "t.c": { letter: "M", change: "modified" } });
    expect(tree.markRemoved("/ws/t.c")).toBe(true);
    expect(tree.files.get("/ws/t.c")).toMatchObject({ letter: "D", change: "deleted" });
  });
  it("test_mark_removed_untracked_just_drops", () => {
    const tree = makeTree({ "u.c": { letter: "U", change: "added" } });
    expect(tree.markRemoved("/ws/u.c")).toBe(true);
    expect(tree.files.size).toBe(0);
  });
  it("test_mark_removed_unknown_returns_false", () => {
    const tree = makeTree({});
    expect(tree.markRemoved("/ws/ghost.c")).toBe(false);
  });
  it("test_out_of_scope_returns_false", () => {
    const tree = makeTree({});
    expect(tree.markSaved("/other/x.c")).toBe(false);
    expect(tree.markRemoved("/other/x.c")).toBe(false);
  });
});

describe("keyFor 路径换算（A5 符号链接场景）", () => {
  // root=/data/ws，scope=/home/me/ws（符号链接打开）
  const tree = TreeStatus.fromParsed("/data/ws", "/home/me/ws", "main", {
    files: new Map([
      ["a/b.c", { path: "a/b.c", indexStatus: " ", worktreeStatus: "M", letter: "M", change: "modified" }],
    ]),
    untrackedDirs: [],
  });
  it("test_key_for_maps_symlinked_workspace", () => {
    expect(tree.keyFor("/home/me/ws/a/b.c")).toBe("/data/ws/a/b.c");   // tail 唯一命中
    expect(tree.keyFor("/home/me/ws/a")).toBe("/data/ws/a");           // 目录继承色命中
    expect(tree.keyFor("/home/me/ws")).toBe("/data/ws");               // tail="" 走规则 4
    expect(tree.keyFor("/elsewhere/x.c")).toBe("/elsewhere/x.c");      // 不在 scope，原样
  });
  it("test_key_for_refuses_ambiguous_tail", () => {
    const dup = TreeStatus.fromParsed("/w", "/home/me/ws", "main", {
      files: new Map([
        ["a/pkg/x.c", { path: "a/pkg/x.c", indexStatus: " ", worktreeStatus: "M", letter: "M", change: "modified" }],
        ["b/pkg/x.c", { path: "b/pkg/x.c", indexStatus: " ", worktreeStatus: "M", letter: "M", change: "modified" }],
      ]),
      untrackedDirs: [],
    });
    // 两个后缀命中 → 不猜，返回原路径
    expect(dup.keyFor("/home/me/ws/pkg/x.c")).toBe("/home/me/ws/pkg/x.c");
  });
});

describe("toSnapshot", () => {
  it("label 形如 Git: main · N 处变更", () => {
    const tree = makeTree({ "a.c": { letter: "M", change: "modified" } });
    expect(tree.toSnapshot().label).toBe("Git: main · 1 处变更");
    expect(makeTree({}).toSnapshot().label).toBe("Git: main");
  });
});
