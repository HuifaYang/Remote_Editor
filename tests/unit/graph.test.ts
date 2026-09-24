// T3：提交图泳道布局（样例来自分册 1 · A7）
import { describe, expect, it } from "vitest";
import { layout } from "../../src/shared/graph";
import type { CommitInfo } from "../../src/shared/types";

function c(hash: string, parents: string[]): CommitInfo {
  return { hash, parents, author: "a", date: "d", subject: hash, refs: [] };
}

describe("layout（A7）", () => {
  it("test_linear_history_uses_one_lane", () => {
    // Given 3 个单父提交 Then 全部 lane=0，首行 topLanes=()，末行 bottomLanes=()
    const rows = layout([c("c1", ["c2"]), c("c2", ["c3"]), c("c3", [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0].topLanes).toEqual([]);
    expect(rows[2].bottomLanes).toEqual([]);
  });
  it("test_two_branch_tips_get_separate_lanes", () => {
    // Given 两个分支顶端都指向同一 base Then lane=[0,1,0]
    const rows = layout([c("t1", ["base"]), c("t2", ["base"]), c("base", [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
  });
  it("test_merge_gets_two_parent_lanes", () => {
    // A7 worked example：m 有两个父 p1/p2，p1/p2 都指向 base
    const rows = layout([c("m", ["p1", "p2"]), c("p1", ["base"]), c("p2", ["base"]), c("base", [])]);
    // 行 m：lane 0，top ()，bottom (0,1)，parentLanes (0,1)
    expect(rows[0]).toMatchObject({ lane: 0, topLanes: [], bottomLanes: [0, 1], parentLanes: [0, 1] });
    // 行 p1：lane 0，top (0,1)，bottom (0,1)，parentLanes (0,)
    expect(rows[1]).toMatchObject({ lane: 0, topLanes: [0, 1], bottomLanes: [0, 1], parentLanes: [0] });
    // 行 p2：lane 1，top (0,1)，bottom (0,)，parentLanes (0,)（p2 并回 lane 0）
    expect(rows[2]).toMatchObject({ lane: 1, topLanes: [0, 1], bottomLanes: [0], parentLanes: [0] });
    // 行 base：lane 0，top (0,)，bottom ()，parentLanes ()
    expect(rows[3]).toMatchObject({ lane: 0, topLanes: [0], bottomLanes: [], parentLanes: [] });
  });
  it("test_merged_lanes_collapse_left", () => {
    const rows = layout([c("m", ["p1", "p2"]), c("p1", ["base"]), c("p2", ["base"]), c("base", [])]);
    expect(rows[2].bottomLanes).toEqual([0]);   // 并回后只剩 lane 0
  });
  it("test_empty_input_returns_empty", () => {
    expect(layout([])).toEqual([]);
  });
});
