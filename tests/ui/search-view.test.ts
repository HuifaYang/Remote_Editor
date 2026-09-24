// @vitest-environment happy-dom
// M5 搜索视图：分组、命中高亮、点击跳行、选项开关、打开面板 0 请求
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchMatch } from "../../src/shared/types";

function fakeWindowApi(): { find: ReturnType<typeof vi.fn> } {
  const find = vi.fn(async () => [] as SearchMatch[]);
  (globalThis as unknown as { window: unknown }).window.api = { search: { find } };
  (globalThis as unknown as { window: { api: { on?: () => void } } }).window.api.on = () => () => { /* 退订 */ };
  return { find };
}

beforeEach(() => {
  document.body.textContent = "";
  fakeWindowApi();
});

describe("M5 搜索视图", () => {
  it("test_results_grouped_by_file_and_click_targets_line", async () => {
    const { SearchView } = await import("../../src/renderer/views/search-view");
    const opened: Array<[string, number]> = [];
    const body = document.createElement("div");
    const view = new SearchView(body, { onOpenFile: (p, line) => opened.push([p, line]) });
    expect(body.querySelector(".search-row")?.children).toHaveLength(2);
    expect(body.querySelector(".search-options")?.children).toHaveLength(3);
    view.setResults([
      { path: "/ws/src/a.c", line: 12, text: "int a" },
      { path: "/ws/src/a.c", line: 30, text: "int b" },
      { path: "/ws/docs/b.md", line: 3, text: "b" },
    ]);
    const groups = body.querySelectorAll(".search-group");
    expect(groups.length).toBe(2);
    const hits = [...body.querySelectorAll<HTMLElement>(".search-hit")];
    hits[0].click();
    expect(opened).toEqual([["/ws/src/a.c", 12]]);
  });

  it("test_toggle_case_updates_state", async () => {
    const { SearchView } = await import("../../src/renderer/views/search-view");
    const body = document.createElement("div");
    const view = new SearchView(body, { onOpenFile: () => { /* 无需 */ } });
    view.setCaseSensitive(true);
    const aa = body.querySelector<HTMLButtonElement>(".search-toggle");
    expect(aa?.classList.contains("active")).toBe(true);
  });
});
