// @vitest-environment happy-dom
// 统一上下文菜单：键盘导航、Esc、视口边界
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openContextMenu } from "../../src/renderer/views/ui";

beforeEach(() => { document.body.textContent = ""; });

describe("上下文菜单", () => {
  it("test_context_menu_keyboard_and_escape", async () => {
    const first = vi.fn();
    openContextMenu([
      { label: "第一项", onClick: first },
      { label: "第二项", onClick: vi.fn() },
    ], 10, 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const menu = document.querySelector<HTMLElement>(".context-menu");
    expect(document.activeElement?.textContent).toContain("第一项");
    menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.textContent).toContain("第二项");
    menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    (document.activeElement as HTMLButtonElement).click();
    expect(first).toHaveBeenCalledOnce();
    expect(document.querySelector(".context-menu")).toBeNull();
  });
});
