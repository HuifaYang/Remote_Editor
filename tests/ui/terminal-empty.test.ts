// @vitest-environment happy-dom
// 终端空态：未连接时不创建 xterm，终止按钮保持禁用
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "../../src/renderer/views/terminal-panel";
import { appStore } from "../../src/renderer/app/store";

beforeEach(() => {
  document.body.textContent = "";
  appStore.set({ connected: false });
  (globalThis as unknown as { window: unknown }).window.api = {
    on: vi.fn(() => () => { /* 退订 */ }),
    terminal: { create: vi.fn(), write: vi.fn(), resize: vi.fn(), close: vi.fn() },
  };
});

describe("终端空态", () => {
  it("test_disconnected_new_terminal_shows_empty_state", async () => {
    const root = document.createElement("div");
    root.className = "terminal-panel hidden";
    document.body.appendChild(root);
    const panel = new TerminalPanel(root);
    await panel.newTerminal();
    expect(root.classList.contains("hidden")).toBe(false);
    expect(root.querySelector(".terminal-empty")?.textContent).toContain("请先连接主机");
    const kill = [...root.querySelectorAll<HTMLButtonElement>(".terminal-toolbar .ui-icon-btn")].find((b) => b.title === "终止当前终端");
    expect(kill?.disabled).toBe(true);
  });
});
