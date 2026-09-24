// M5 UI 纯逻辑：提交按钮状态（T10.6）与搜索命中高亮切分
import { describe, expect, it } from "vitest";
import { commitStateOf } from "../../src/renderer/views/scm-view";
import { splitHighlight } from "../../src/renderer/views/search-view";

describe("M5.4 提交按钮状态", () => {
  it("test_commit_button_states", () => {
    expect(commitStateOf(false, false, false)).toEqual({ enabled: false, hint: null });     // 没更改 → 禁用
    expect(commitStateOf(true, true, false)).toEqual({ enabled: true, hint: null });        // 有更改有信息 → 可点
    expect(commitStateOf(true, false, false)).toEqual({ enabled: true, hint: "请先填写提交信息" });
    expect(commitStateOf(true, true, true).enabled).toBe(false);                            // 提交中 → 禁用
  });
});

describe("M5.5 搜索命中高亮", () => {
  it("test_split_highlight_is_case_insensitive_by_default", () => {
    const parts = splitHighlight("int Handle_dock(int x)", "handle_dock", false, false);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["Handle_dock"]);
  });

  it("test_split_highlight_regex_and_invalid_pattern", () => {
    const parts = splitHighlight("a1 b22 c333", "\\d+", true, true);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["1", "22", "333"]);
    expect(() => splitHighlight("x", "([", true, true)).toThrow(/正则/);
  });

  it("test_split_highlight_treats_pattern_literally_when_not_regex", () => {
    const parts = splitHighlight("a.b.c", ".", false, false);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual([".", "."]);
  });
});
