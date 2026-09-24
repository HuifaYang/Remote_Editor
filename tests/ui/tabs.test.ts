// 分册 4 T10.3：标签页增删、脏标记、关闭策略
import { describe, expect, it } from "vitest";
import { TabsModel, type TabState } from "../../src/renderer/app/tabs";

function tab(path: string): TabState {
  return { path, name: path.split("/").pop() ?? path, language: "cpp", dirty: false, fingerprint: null, encoding: "utf8", newline: "lf" };
}

describe("T10.3 标签页", () => {
  it("test_add_activate_and_close_updates_active", () => {
    const tabs = new TabsModel();
    tabs.open(tab("/ws/a.cpp"));
    tabs.open(tab("/ws/b.cpp"));
    expect(tabs.active()?.path).toBe("/ws/b.cpp");
    tabs.activate("/ws/a.cpp");
    expect(tabs.active()?.path).toBe("/ws/a.cpp");
    tabs.close("/ws/a.cpp");
    expect(tabs.list().map((t) => t.path)).toEqual(["/ws/b.cpp"]);
    expect(tabs.active()?.path).toBe("/ws/b.cpp");
  });

  it("test_dirty_marker_and_clear_on_save", () => {
    const tabs = new TabsModel();
    tabs.open(tab("/ws/a.cpp"));
    tabs.setDirty("/ws/a.cpp", true);
    expect(tabs.dirtyTabs().map((t) => t.path)).toEqual(["/ws/a.cpp"]);
    tabs.setFingerprint("/ws/a.cpp", { path: "/ws/a.cpp", size: 10, mtime: 1 });
    tabs.setDirty("/ws/a.cpp", false);
    expect(tabs.dirtyTabs()).toHaveLength(0);
  });

  it("test_close_others_and_right", () => {
    const tabs = new TabsModel();
    for (const p of ["/ws/a.cpp", "/ws/b.cpp", "/ws/c.cpp"]) tabs.open(tab(p));
    tabs.closeRight("/ws/b.cpp");                       // 关掉 b 右侧的 c
    expect(tabs.list().map((t) => t.path)).toEqual(["/ws/a.cpp", "/ws/b.cpp"]);
    tabs.closeOthers("/ws/b.cpp");                      // 只留 b
    expect(tabs.list().map((t) => t.path)).toEqual(["/ws/b.cpp"]);
    expect(tabs.active()?.path).toBe("/ws/b.cpp");
  });

  it("test_move_reorders", () => {
    const tabs = new TabsModel();
    for (const p of ["/ws/a.cpp", "/ws/b.cpp", "/ws/c.cpp"]) tabs.open(tab(p));
    tabs.move(0, 2);
    expect(tabs.list().map((t) => t.path)).toEqual(["/ws/b.cpp", "/ws/c.cpp", "/ws/a.cpp"]);
  });
});
