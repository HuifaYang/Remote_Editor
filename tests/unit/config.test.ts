// M4 配置层：settings / hosts / ~/.ssh 集成（分册 3 D1）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore, normalizeSettings } from "../../src/main/config/settings";
import { HostStore, assertNoCredentials, type HostRecord } from "../../src/main/config/hosts";
import { importSshConfig, listLocalKeys } from "../../src/main/config/ssh-config";

let scratch: string;
beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rce-cfg-")); });
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe("D1.2 settings.json", () => {
  it("test_invalid_fields_fall_back_to_default", () => {
    // Given 越界与大类型错误的字段 When 归一化 Then 全部回默认，不抛错
    const s = normalizeSettings({ fontSize: 999, zoomLevel: "big", autoSaveDelayMs: 10, theme: "neon", window: { width: 10 } });
    expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(s.zoomLevel).toBe(DEFAULT_SETTINGS.zoomLevel);
    expect(s.autoSaveDelayMs).toBe(DEFAULT_SETTINGS.autoSaveDelayMs);
    expect(s.theme).toBe("dark");
    expect(s.window.width).toBe(DEFAULT_SETTINGS.window.width);
  });

  it("test_partial_update_persists", () => {
    const store = new SettingsStore(path.join(scratch, "settings.json"));
    store.update({ autoSave: false, autoSaveDelayMs: 3000 });
    const reread = new SettingsStore(path.join(scratch, "settings.json")).get();
    expect(reread.autoSave).toBe(false);
    expect(reread.autoSaveDelayMs).toBe(3000);
    expect(reread.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it("test_lsp_transport_disabled_persists", () => {
    const store = new SettingsStore(path.join(scratch, "settings.json"));
    store.update({ lspTransport: "disabled" });
    expect(new SettingsStore(path.join(scratch, "settings.json")).get().lspTransport).toBe("disabled");
  });

  it("test_broken_json_does_not_crash", () => {
    const file = path.join(scratch, "settings.json");
    fs.writeFileSync(file, "{ not json");
    expect(new SettingsStore(file).get().autoSave).toBe(true);
  });
});

describe("D1.1 hosts.json", () => {
  const host = (id: string): HostRecord => ({
    id, name: `Robot-${id}`, host: "192.168.1.10", port: 22, username: "root",
    authMethod: "password", workspace: "/ws/a", workspaces: ["/ws/a"],
  });

  it("test_save_list_remove_round_trip", () => {
    const store = new HostStore(path.join(scratch, "hosts.json"));
    store.save(host("a"));
    store.save(host("b"));
    expect(new HostStore(path.join(scratch, "hosts.json")).list().map((h) => h.id)).toEqual(["a", "b"]);
    store.remove("a");
    expect(store.list().map((h) => h.id)).toEqual(["b"]);
  });

  it("test_rejects_credentials_nested", () => {
    expect(() => assertNoCredentials({ id: "a", password: "p" })).toThrow(/凭据/);
    expect(() => assertNoCredentials({ id: "a", nested: { passphrase: "p" } })).toThrow();
    expect(() => new HostStore(path.join(scratch, "h.json")).save({ ...host("a"), password: "p" } as unknown as HostRecord)).toThrow();
  });

  it("test_touch_keeps_workspace_history_unique_and_capped", () => {
    const store = new HostStore(path.join(scratch, "hosts.json"));
    store.save(host("a"));
    for (let i = 0; i < 12; i++) store.touch("a", `/ws/${i}`);
    store.touch("a", "/ws/5");
    const saved = store.list()[0];
    expect(saved.workspaces.length).toBe(10);
    expect(saved.workspaces[0]).toBe("/ws/5");
    expect(new Set(saved.workspaces).size).toBe(10);
  });
});

describe("§8.4/§8.5 本机 ~/.ssh 集成", () => {
  it("test_list_keys_skips_public_and_known_hosts", () => {
    const dir = path.join(scratch, ".ssh");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
    fs.writeFileSync(path.join(dir, "id_ed25519.pub"), "ssh-ed25519 AAA fake@host\n");
    fs.writeFileSync(path.join(dir, "known_hosts"), "example.com ssh-rsa AAA\n");
    fs.writeFileSync(path.join(dir, "id_rsa"), "-----BEGIN RSA PRIVATE KEY-----\nENCRYPTED\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    fs.mkdirSync(path.join(dir, "subdir"));
    const keys = listLocalKeys(dir);
    expect(keys.map((k) => path.basename(k.path))).toEqual(["id_ed25519", "id_rsa"]);
    expect(keys[0].label).toBe("fake@host");       // .pub 注释优先
    expect(keys[0].encrypted).toBe(false);
    expect(keys[1].encrypted).toBe(true);
  });

  it("test_import_ssh_config_with_include_and_wildcards", () => {
    const dir = path.join(scratch, ".ssh");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "extra.conf"), "Host board\n  HostName 10.0.0.9\n  User le\n");
    fs.writeFileSync(path.join(dir, "config"), [
      "Host *",
      "  User nobody",
      "Host robot",
      "  HostName 192.168.1.100",
      "  Port 2222",
      "  User root",
      "  IdentityFile ~/.ssh/id_ed25519",
      "Include extra.conf",
      "Host dup",
      "  HostName 10.0.0.1",
      "Host dup",
      "  HostName 10.0.0.1",
      "Match host 10.*",
      "  User ignored",
    ].join("\n"));
    const hosts = importSshConfig(dir);
    // Include 按出现位置就地展开 → robot、被包含的 board、dup；重复的 dup 只留一条
    expect(hosts.map((h) => h.name)).toEqual(["robot", "board", "dup"]);
    expect(hosts[0]).toMatchObject({ host: "192.168.1.100", port: 2222, username: "root" });
    expect(hosts[0].identityFile).toBe(path.join(os.homedir(), ".ssh/id_ed25519"));
    expect(hosts[1]).toMatchObject({ host: "10.0.0.9", username: "le" });
    expect(hosts[2].host).toBe("10.0.0.1");
  });
});
