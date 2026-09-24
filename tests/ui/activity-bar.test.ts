// @vitest-environment happy-dom
// 活动栏点击：不能预先写 uiStore，否则主逻辑会误判“点击当前视图”并收起侧边栏
import { beforeEach, describe, expect, it } from "vitest";
import { mountActivityBar } from "../../src/renderer/views/activity-bar";
import { uiStore } from "../../src/renderer/app/store";

beforeEach(() => {
  uiStore.set({ sidebarView: null });
  document.body.textContent = "";
});

describe("活动栏点击", () => {
  it("test_first_click_opens_view", () => {
    const calls: Array<string | null> = [];
    const host = document.createElement("div");
    mountActivityBar(host, (v) => calls.push(v));
    const btn = host.querySelector<HTMLButtonElement>(".activity-btn");
    btn?.click();
    expect(calls).toEqual(["files"]);
  });

  it("test_click_same_view_collapses", () => {
    const calls: Array<string | null> = [];
    const host = document.createElement("div");
    mountActivityBar(host, (v) => calls.push(v));
    const btn = host.querySelector<HTMLButtonElement>(".activity-btn");
    uiStore.set({ sidebarView: "files" });
    btn?.click();
    expect(calls).toEqual([null]);
  });
});
