// @vitest-environment happy-dom
// U10 主菜单：双层结构、快捷键分列、键盘导航
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountTitleBar } from "../../src/renderer/app/title-bar";

beforeEach(() => {
  document.body.textContent = "";
  (globalThis as unknown as { window: unknown }).window.api = {
    window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
    on: vi.fn(() => () => { /* 退订 */ }),
  };
});

describe("标题栏菜单", () => {
  it("test_menu_uses_group_nav_and_shortcut_column", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountTitleBar(host, { newFile: vi.fn(), newFolder: vi.fn(), openFolder: vi.fn(), quit: vi.fn() });
    host.querySelector<HTMLButtonElement>(".menu-btn")?.click();

    expect(host.querySelectorAll(".menu-nav-item")).toHaveLength(5);
    expect(host.querySelectorAll(".menu-action").length).toBeGreaterThan(0);
    expect(host.querySelector(".menu-action kbd")?.textContent).toBe("Ctrl+N");
    expect(host.querySelector(".menu-dropdown")?.classList.contains("hidden")).toBe(false);
  });

  it("test_menu_arrow_keys_move_focus", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountTitleBar(host, { newFile: vi.fn(), newFolder: vi.fn(), openFolder: vi.fn(), quit: vi.fn() });
    host.querySelector<HTMLButtonElement>(".menu-btn")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const menu = host.querySelector<HTMLElement>(".menu-dropdown");
    menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.textContent).toContain("新建文件夹");
  });
});
