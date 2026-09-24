// @vitest-environment happy-dom
// 主机编辑表单：完整字段、内联校验、保存并连接返回
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openHostDialog } from "../../src/renderer/views/dialogs/host-dialog";

beforeEach(() => {
  document.body.textContent = "";
  (globalThis as unknown as { window: unknown }).window.api = {
    host: { listLocalKeys: vi.fn(async () => []) },
  };
});

describe("主机编辑对话框", () => {
  it("test_host_form_validates_and_returns_record", async () => {
    const promise = openHostDialog();
    await Promise.resolve();
    await Promise.resolve();
    document.querySelector<HTMLButtonElement>(".dialog-buttons .ui-btn.primary")?.click();
    expect(document.querySelector(".ui-field.error")?.textContent).toContain("请输入显示名");

    document.querySelector<HTMLInputElement>("#host-name")!.value = "Robot";
    document.querySelector<HTMLInputElement>("#host-address")!.value = "192.168.1.10";
    document.querySelector<HTMLButtonElement>(".dialog-buttons .ui-btn.primary")?.click();
    await expect(promise).resolves.toMatchObject({
      connect: true,
      host: { name: "Robot", host: "192.168.1.10", port: 22, username: "root" },
    });
  });
});
