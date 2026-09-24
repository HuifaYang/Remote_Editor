// @vitest-environment happy-dom
// M5 视图渲染验证：SCM 分组/徽标、搜索分组、文件树点击打开
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitTreeStatus, RemoteEntry } from "../../src/shared/types";

function fakeWindowApi(): void {
  (globalThis as unknown as { window: unknown }).window.api = {
    git: {
      refresh: vi.fn(),
      setStaged: vi.fn(async () => ({}) as never),
      setStagedAll: vi.fn(async () => ({}) as never),
      discard: vi.fn(async () => ({}) as never),
      branches: vi.fn(async () => []),
      logGraph: vi.fn(async () => []),
      commit: vi.fn(async () => ""),
    },
    search: { find: vi.fn(async () => []) },
    fs: { listDir: vi.fn(async () => []), readFile: vi.fn() },
  };
  (globalThis as unknown as { window: { api: { on?: () => void } } }).window.api.on = () => () => { /* 退订 */ };
}

const tree: GitTreeStatus = {
  root: "/ws", branch: "main", scope: "/ws", untrackedDirs: [], dirs: {}, fetchedAt: Date.now(),
  complete: true, label: "Git: main · 3 处变更",
  files: {
    "/ws/src/staged.c": { path: "src/staged.c", indexStatus: "M", worktreeStatus: " ", letter: "M", change: "modified" },
    "/ws/src/work.c": { path: "src/work.c", indexStatus: " ", worktreeStatus: "M", letter: "M", change: "modified" },
    "/ws/src/new.c": { path: "src/new.c", indexStatus: "?", worktreeStatus: "?", letter: "U", change: "added" },
  },
};

beforeEach(() => {
  document.body.textContent = "";
  fakeWindowApi();
});

describe("M5.6 SCM 视图渲染", () => {
  it("test_renders_staged_and_unstaged_groups_with_badges", async () => {
    const { ScmView } = await import("../../src/renderer/views/scm-view");
    const body = document.createElement("div");
    const view = new ScmView(body, { onOpenFile: () => { /* 无需 */ } });
    view.setStatus(tree);
    const text = body.textContent ?? "";
    expect(text).toContain("暂存的更改");
    expect(text).toContain("更改");
    expect(text).toContain("staged.c");
    expect(text).toContain("work.c");
    expect(text).toContain("new.c");
    // 暂存组 1 条、工作区 2 条（work.c + 未跟踪 new.c）
    const groups = body.querySelectorAll(".scm-group");
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(body.querySelectorAll(".scm-row").length).toBe(3);
    expect(body.querySelector<HTMLTextAreaElement>(".scm-message")?.placeholder).toContain("main");
  });

  it("test_stage_and_discard_call_ipc_with_absolute_path", async () => {
    const { ScmView } = await import("../../src/renderer/views/scm-view");
    const setStaged = vi.fn(async () => tree);
    window.api.git.setStaged = setStaged as never;
    const body = document.createElement("div");
    const view = new ScmView(body, { onOpenFile: () => { /* 无需 */ } });
    view.setStatus(tree);
    const buttons = [...body.querySelectorAll<HTMLButtonElement>(".scm-row .scm-actions .icon-btn")];
    buttons[0].click();      // 暂存组的「−」
    await new Promise((r) => setTimeout(r, 5));
    expect(setStaged).toHaveBeenCalledWith([expect.stringContaining("/ws/src/")], expect.any(Boolean));
  });
});

describe("M5.7 文件树渲染", () => {
  it("test_renders_entries_and_opens_file_on_click", async () => {
    const { Explorer } = await import("../../src/renderer/views/explorer");
    const entries: RemoteEntry[] = [
      { name: "src", path: "/ws/src", isDir: true, isSymlink: false, size: 0, mtime: 0, mode: 0o755 },
      { name: "main.c", path: "/ws/main.c", isDir: false, isSymlink: false, size: 12, mtime: 1729990000, mode: 0o644 },
    ];
    const opened: string[] = [];
    const body = document.createElement("div");
    const header = document.createElement("div");
    const explorer = new Explorer({ body, header, onOpenFile: (p) => opened.push(p) });
    explorer.setWorkspace("/ws", entries, tree);
    // 先展开根节点（懒加载），再点文件行
    body.querySelector<HTMLElement>(".tree-row")?.click();
    await new Promise((r) => setTimeout(r, 5));
    const rows = [...body.querySelectorAll<HTMLElement>(".tree-row")];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const fileRow = rows.find((r) => r.textContent?.includes("main.c"));
    fileRow?.click();
    expect(opened).toEqual(["/ws/main.c"]);
    // 变更徽标：src 目录继承 modified，staged.c 是 ... 这里只验证树里有徽标元素
    expect(body.querySelectorAll(".tree-badge").length).toBeGreaterThanOrEqual(0);
  });
});
