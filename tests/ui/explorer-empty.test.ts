// @vitest-environment happy-dom
// 资源管理器空态：未连接时按钮禁用，连接后才提供打开远程文件夹入口
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Explorer } from "../../src/renderer/views/explorer";

beforeEach(() => {
  document.body.textContent = "";
});

describe("资源管理器空态", () => {
  it("test_open_folder_disabled_without_connection", () => {
    const body = document.createElement("div");
    const header = document.createElement("div");
    new Explorer({ body, header, onOpenFile: vi.fn() });
    expect(body.querySelector<HTMLButtonElement>(".ui-empty-actions .ui-btn")?.disabled).toBe(true);
  });

  it("test_open_folder_enabled_with_connection", () => {
    const body = document.createElement("div");
    const header = document.createElement("div");
    new Explorer({ body, header, onOpenFile: vi.fn(), onOpenFolder: vi.fn() });
    expect(body.querySelector<HTMLButtonElement>(".ui-empty-actions .ui-btn")?.disabled).toBe(false);
  });
});
