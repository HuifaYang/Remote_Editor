// @vitest-environment happy-dom
// 远程主机视图：空态与底部操作必须先出现，不能等待 host.list 后才渲染
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostsView } from "../../src/renderer/views/hosts-view";

let resolveList: (hosts: unknown[]) => void = () => { /* 测试中替换 */ };

beforeEach(() => {
  document.body.textContent = "";
  const list = vi.fn(() => new Promise<unknown[]>((resolve) => { resolveList = resolve; }));
  (globalThis as unknown as { window: unknown }).window = {
    api: {
      on: vi.fn(),
      host: { list },
    },
  };
});

describe("远程主机视图", () => {
  it("test_empty_state_and_footer_render_before_list_resolves", async () => {
    const body = document.createElement("div");
    const view = new HostsView(body, { onOpenFolder: () => { /* 无需 */ } });
    void view.refresh();

    expect(body.querySelector(".hosts-footer")).not.toBeNull();
    expect(body.querySelector(".ui-loading")?.textContent).toContain("正在读取主机");
    expect(body.querySelector<HTMLButtonElement>(".hosts-footer .ui-btn")?.disabled).toBe(false);

    resolveList([{
      id: "robot", name: "Robot", host: "192.168.1.10", port: 22, username: "root",
      authMethod: "password", workspaces: [],
    }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(body.querySelector(".host-row")).not.toBeNull();
  });
});
