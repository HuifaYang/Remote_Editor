// @vitest-environment happy-dom
// 欢迎页：左对齐结构、连接状态、最近主机和快捷键入口
import { describe, expect, it, vi } from "vitest";
import { WelcomeView } from "../../src/renderer/views/welcome";

describe("欢迎页", () => {
  it("test_welcome_has_actions_and_shortcut_cards", async () => {
    const onConnect = vi.fn();
    const welcome = new WelcomeView({
      onConnect,
      onOpenFolder: vi.fn(),
      onSearch: vi.fn(),
      onTerminal: vi.fn(),
      onOpenRecent: vi.fn(),
      loadRecent: async () => [{ id: "h1", name: "Robot", host: "192.168.1.10", username: "root", workspace: "/ws" }],
    });
    document.body.appendChild(welcome.root);
    await Promise.resolve();
    await Promise.resolve();

    expect(welcome.root.querySelector(".welcome-content")).not.toBeNull();
    expect(welcome.root.querySelector(".welcome-recent-item")?.textContent).toContain("Robot");
    expect(welcome.root.querySelectorAll(".welcome-shortcut")).toHaveLength(3);
    welcome.root.querySelector<HTMLButtonElement>(".welcome-actions .ui-btn")?.click();
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("test_connected_state_shows_open_folder", () => {
    const welcome = new WelcomeView({
      onConnect: vi.fn(), onOpenFolder: vi.fn(), onSearch: vi.fn(), onTerminal: vi.fn(), onOpenRecent: vi.fn(), loadRecent: async () => [],
    });
    welcome.setConnected(true, "Robot");
    expect(welcome.root.textContent).toContain("已连接 · Robot");
    expect(welcome.root.textContent).toContain("打开远程文件夹…");
    expect(welcome.root.textContent).toContain("管理主机…");
  });
});
