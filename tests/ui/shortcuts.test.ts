// T10.4 快捷键表触发：每个规格快捷键至少 1 条用例
import { beforeEach, describe, expect, it } from "vitest";
// @vitest-environment happy-dom
import { installShortcuts, matchShortcut } from "../../src/renderer/app/shortcuts";

type Handlers = Parameters<typeof installShortcuts>[0];

function makeHandlers(): Handlers & { calls: Record<string, number> } {
  const calls = new Proxy({}, { get: (t, p) => Number((t as Record<string, number>)[p as string] ?? 0) }) as unknown as Record<string, number>;
  const handlers = {
    calls,
    save: () => { calls.save = (calls.save ?? 0) + 1; },
    saveAll: () => { calls.saveAll = (calls.saveAll ?? 0) + 1; },
    closeTab: () => { calls.closeTab = (calls.closeTab ?? 0) + 1; },
    nextTab: () => { calls.nextTab = (calls.nextTab ?? 0) + 1; },
    openFolder: () => { calls.openFolder = (calls.openFolder ?? 0) + 1; },
    newFile: () => { calls.newFile = (calls.newFile ?? 0) + 1; },
    toggleSidebar: () => { calls.toggleSidebar = (calls.toggleSidebar ?? 0) + 1; },
    togglePanel: () => { calls.togglePanel = (calls.togglePanel ?? 0) + 1; },
    zoomIn: () => { calls.zoomIn = (calls.zoomIn ?? 0) + 1; },
    zoomOut: () => { calls.zoomOut = (calls.zoomOut ?? 0) + 1; },
    zoomReset: () => { calls.zoomReset = (calls.zoomReset ?? 0) + 1; },
    find: () => { calls.find = (calls.find ?? 0) + 1; },
    replace: () => { calls.replace = (calls.replace ?? 0) + 1; },
    gotoLine: () => { calls.gotoLine = (calls.gotoLine ?? 0) + 1; },
    searchAll: () => { calls.searchAll = (calls.searchAll ?? 0) + 1; },
    triggerCompletion: () => { calls.triggerCompletion = (calls.triggerCompletion ?? 0) + 1; },
    refreshMirror: () => { calls.refreshMirror = (calls.refreshMirror ?? 0) + 1; },
    refreshGit: () => { calls.refreshGit = (calls.refreshGit ?? 0) + 1; },
    newTerminal: () => { calls.newTerminal = (calls.newTerminal ?? 0) + 1; },
    openSettings: () => { calls.openSettings = (calls.openSettings ?? 0) + 1; },
  } as unknown as Handlers & { calls: Record<string, number> };
  return handlers;
}

beforeEach(() => { document.body.textContent = ""; });

describe("T10.4 快捷键表触发", () => {
  it("test_shortcut_table_dispatches_all_required_actions", () => {
    const cases: Array<[string, KeyboardEventInit]> = [
      ["save", { key: "s", ctrlKey: true }],
      ["saveAll", { key: "S", ctrlKey: true, shiftKey: true }],
      ["closeTab", { key: "w", ctrlKey: true }],
      ["nextTab", { key: "Tab", ctrlKey: true }],
      ["openFolder", { key: "o", ctrlKey: true }],
      ["newFile", { key: "n", ctrlKey: true }],
      ["toggleSidebar", { key: "b", ctrlKey: true }],
      ["togglePanel", { key: "j", ctrlKey: true }],
      ["zoomIn", { key: "=", ctrlKey: true }],
      ["zoomOut", { key: "-", ctrlKey: true }],
      ["zoomReset", { key: "0", ctrlKey: true }],
      ["find", { key: "f", ctrlKey: true }],
      ["replace", { key: "h", ctrlKey: true }],
      ["gotoLine", { key: "g", ctrlKey: true }],
      ["searchAll", { key: "F", ctrlKey: true, shiftKey: true }],
      ["triggerCompletion", { key: " ", ctrlKey: true }],
      ["refreshMirror", { key: "F5" }],
      ["refreshGit", { key: "F5", shiftKey: true }],
      ["newTerminal", { key: "`", ctrlKey: true, shiftKey: true }],
      ["openSettings", { key: ",", ctrlKey: true }],
    ];
    const handlers = makeHandlers();
    const off = installShortcuts(handlers);
    for (const [, init] of cases) {
      window.dispatchEvent(new KeyboardEvent("keydown", init));
    }
    off();
    for (const [name] of cases) {
      expect(handlers.calls[name]).toBe(1);
    }
  });

  it("test_matchShortcut_is_case_insensitive_and_ignores_meta_only", () => {
    expect(matchShortcut({ key: "S", ctrlKey: true, shiftKey: false })?.run).toBe("save");
    expect(matchShortcut({ key: "s", ctrlKey: false })?.run).toBeUndefined();
  });
});
