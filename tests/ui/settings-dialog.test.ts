// @vitest-environment happy-dom
// U9 设置：分组卡片、统一样式控件、确定回调
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openSettingsDialog } from "../../src/renderer/views/dialogs/settings-dialog";

const current = {
  theme: "dark" as const,
  uiFontFamily: "",
  fontSize: 12,
  zoomLevel: 1,
  tabSize: 4,
  useSpaces: true,
  wordWrap: false,
  showLineNumbers: true,
  highlightCurrentLine: true,
  autoSave: true,
  autoSaveDelayMs: 1500,
  maxFileSizeMb: 32,
  sshTimeoutSeconds: 15,
  sshKeepaliveSeconds: 30,
  sshStrictHostKey: false,
  lspEnabled: true,
  lspTransport: "local" as const,
  cppServer: "clangd",
  pythonServer: "python3 -m pylsp",
};

beforeEach(() => { document.body.textContent = ""; });

describe("设置对话框", () => {
  it("test_settings_uses_sections_switches_and_applies", () => {
    const apply = vi.fn();
    openSettingsDialog(current, apply);
    expect(document.querySelectorAll(".settings-section")).toHaveLength(5);
    expect(document.querySelectorAll(".ui-switch").length).toBeGreaterThan(0);
    document.querySelector<HTMLButtonElement>(".dialog-buttons .ui-btn.primary")?.click();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark", fontSize: 12 }));
  });
});
