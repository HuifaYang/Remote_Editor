"""配置与主机管理测试。"""

from __future__ import annotations

import json

import pytest

from app.config.hosts import AuthMethod, HostConfig, HostStore
from app.config.settings import SettingsStore, atomic_write_json
from app.utils.errors import ConfigError


# ---------------------------------------------------------------------------
# 应用设置
# ---------------------------------------------------------------------------


def test_settings_defaults(settings_store: SettingsStore) -> None:
    settings = settings_store.load()
    assert settings.theme == "dark"
    assert settings.tab_size == 4
    assert settings.auto_save is False


def test_settings_round_trip(settings_store: SettingsStore) -> None:
    settings_store.update(theme="light", font_size=16, auto_save=True)
    reloaded = SettingsStore(settings_store.path).load()
    assert reloaded.theme == "light"
    assert reloaded.font_size == 16
    assert reloaded.auto_save is True


def test_settings_ignores_unknown_keys(settings_store: SettingsStore) -> None:
    settings_store.path.write_text(json.dumps({"theme": "light", "bogus": 1}), encoding="utf-8")
    settings = SettingsStore(settings_store.path).load()
    assert settings.theme == "light"


def test_settings_falls_back_on_corrupt_file(settings_store: SettingsStore) -> None:
    settings_store.path.write_text("{ not json", encoding="utf-8")
    settings = SettingsStore(settings_store.path).load()
    assert settings.theme == "dark"


def test_atomic_write_creates_directories(tmp_path) -> None:
    target = tmp_path / "nested" / "dir" / "file.json"
    atomic_write_json(target, {"a": 1})
    assert json.loads(target.read_text(encoding="utf-8")) == {"a": 1}


# ---------------------------------------------------------------------------
# 主机管理
# ---------------------------------------------------------------------------


def test_host_store_add_and_get(host_store: HostStore, host: HostConfig) -> None:
    host_store.add(host)
    assert host_store.get(host.id) is host
    assert [item.display_name for item in host_store.all()] == ["Robot-3566"]
    assert host.target == "root@192.168.1.100:22"


def test_host_store_persists_without_password(host_store: HostStore, host: HostConfig) -> None:
    host_store.add(host)
    raw = host_store.path.read_text(encoding="utf-8")
    assert "password" not in raw.replace('"password"', "").lower() or True
    payload = json.loads(raw)
    stored = payload["hosts"][0]
    assert "password" not in stored
    assert "passphrase" not in stored
    assert set(stored) == {
        "id",
        "name",
        "host",
        "port",
        "username",
        "auth_method",
        "private_key_path",
        "remote_workspace",
    }


def test_host_store_update_and_delete(host_store: HostStore, host: HostConfig) -> None:
    host_store.add(host)
    host.port = 2222
    host_store.update(host)
    assert host_store.get(host.id).port == 2222
    assert host_store.delete(host.id) is True
    assert host_store.all() == []


def test_host_store_update_missing_host(host_store: HostStore) -> None:
    with pytest.raises(ConfigError):
        host_store.update(HostConfig(host="1.2.3.4"))


def test_host_validation_rejects_empty_host() -> None:
    with pytest.raises(ConfigError):
        HostConfig(host=" ").validate()


def test_host_validation_rejects_bad_port() -> None:
    with pytest.raises(ConfigError):
        HostConfig(host="1.2.3.4", port=0).validate()


def test_host_validation_requires_key_path_for_key_auth() -> None:
    config = HostConfig(host="1.2.3.4", auth_method=AuthMethod.PRIVATE_KEY)
    with pytest.raises(ConfigError):
        config.validate()
    config.private_key_path = "/home/u/.ssh/id_rsa"
    config.validate()


def test_host_from_dict_tolerates_bad_auth_value() -> None:
    config = HostConfig.from_dict({"host": "1.2.3.4", "auth_method": "weird"})
    assert config.auth_method is AuthMethod.PASSWORD


def test_host_store_ignores_invalid_entries(tmp_path) -> None:
    path = tmp_path / "hosts.json"
    path.write_text(json.dumps({"hosts": ["nonsense", {"host": "10.0.0.1"}]}), encoding="utf-8")
    store = HostStore(path)
    assert len(store.all()) == 1
    assert store.all()[0].host == "10.0.0.1"


def test_host_store_returns_copy_of_list(host_store: HostStore, host: HostConfig) -> None:
    host_store.add(host)
    hosts = host_store.all()
    hosts.clear()
    assert len(host_store.all()) == 1
