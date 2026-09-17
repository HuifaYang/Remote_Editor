"""本机 ~/.ssh 扫描测试：私钥识别与 ssh_config 解析。"""

from __future__ import annotations

import textwrap
from pathlib import Path

from app.config.hosts import AuthMethod, HostConfig
from app.utils.ssh_keys import (
    default_private_key,
    list_private_keys,
    looks_like_private_key,
    parse_ssh_config,
)

OPENSSH_KEY = (
    "-----BEGIN OPENSSH PRIVATE KEY-----\n"
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n"
    "-----END OPENSSH PRIVATE KEY-----\n"
)

RSA_KEY = (
    "-----BEGIN RSA PRIVATE KEY-----\n"
    "Proc-Type: 4,ENCRYPTED\n"
    "DEK-Info: AES-128-CBC,0123456789ABCDEF\n\n"
    "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n"
    "-----END RSA PRIVATE KEY-----\n"
)


def make_ssh_dir(tmp_path: Path) -> Path:
    (tmp_path / "id_ed25519").write_text(OPENSSH_KEY, encoding="utf-8")
    (tmp_path / "id_rsa").write_text(RSA_KEY, encoding="utf-8")
    (tmp_path / "id_ed25519.pub").write_text("ssh-ed25519 AAAA user@host\n", encoding="utf-8")
    (tmp_path / "known_hosts").write_text("host ssh-rsa AAAA\n", encoding="utf-8")
    (tmp_path / "known_hosts.old").write_text("host ssh-rsa AAAA\n", encoding="utf-8")
    (tmp_path / "authorized_keys").write_text("ssh-rsa AAAA\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("just a note\n", encoding="utf-8")
    (tmp_path / "config").write_text("Host x\n", encoding="utf-8")
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent" / "id_rsa").write_text(OPENSSH_KEY, encoding="utf-8")
    return tmp_path


# ---------------------------------------------------------------------------
# 私钥清单
# ---------------------------------------------------------------------------


def test_looks_like_private_key(tmp_path: Path) -> None:
    key = tmp_path / "id_ed25519"
    key.write_text(OPENSSH_KEY, encoding="utf-8")
    assert looks_like_private_key(key)
    other = tmp_path / "readme.md"
    other.write_text("# hello\n", encoding="utf-8")
    assert not looks_like_private_key(other)
    assert not looks_like_private_key(tmp_path / "missing")


def test_list_private_keys_skips_non_keys(tmp_path: Path) -> None:
    directory = make_ssh_dir(tmp_path)
    names = [info.name for info in list_private_keys(directory)]
    assert names == ["id_ed25519", "id_rsa"]
    assert list_private_keys(tmp_path / "does-not-exist") == []


def test_list_private_keys_metadata(tmp_path: Path) -> None:
    directory = make_ssh_dir(tmp_path)
    keys = {info.name: info for info in list_private_keys(directory)}
    assert keys["id_ed25519"].key_type == "OpenSSH"
    assert keys["id_ed25519"].encrypted is False
    assert keys["id_rsa"].key_type == "RSA"
    assert keys["id_rsa"].encrypted is True  # Proc-Type: ENCRYPTED
    assert "OpenSSH" in keys["id_ed25519"].label


def test_default_private_key_prefers_ed25519(tmp_path: Path) -> None:
    directory = make_ssh_dir(tmp_path)
    chosen = default_private_key(directory)
    assert chosen is not None
    assert chosen.name == "id_ed25519"
    assert default_private_key(tmp_path / "empty") is None


# ---------------------------------------------------------------------------
# ~/.ssh/config
# ---------------------------------------------------------------------------


def test_parse_ssh_config(tmp_path: Path) -> None:
    include_dir = tmp_path / "conf.d"
    include_dir.mkdir()
    (include_dir / "extra.conf").write_text(
        "Host tea\n    HostName 192.168.1.224\n", encoding="utf-8"
    )
    config = tmp_path / "config"
    config.write_text(
        textwrap.dedent(
            f"""
            # 全局默认
            Host *
                User nobody
                ServerAliveInterval 30

            Host lele
                HostName 192.168.1.13
                User Le
                Port 2222
                IdentityFile ~/.ssh/id_ed25519_lele

            Host plain
                User root

            Match host foo
                User ignored

            Include {include_dir}/*.conf
            """
        ),
        encoding="utf-8",
    )
    hosts = {entry.alias: entry for entry in parse_ssh_config(config)}
    assert set(hosts) == {"lele", "plain", "tea"}

    lele = hosts["lele"]
    assert lele.hostname == "192.168.1.13"
    assert lele.port == 2222
    assert lele.username == "Le"
    assert lele.identity_file == str(Path("~/.ssh/id_ed25519_lele").expanduser())
    assert lele.target == "Le@192.168.1.13:2222"

    assert hosts["plain"].connect_host == "plain"
    assert hosts["plain"].port == 22
    assert hosts["tea"].hostname == "192.168.1.224"


def test_parse_ssh_config_missing_file(tmp_path: Path) -> None:
    assert parse_ssh_config(tmp_path / "nope") == []


def test_parse_ssh_config_tolerates_bad_port(tmp_path: Path) -> None:
    config = tmp_path / "config"
    config.write_text("Host box\n    Port not-a-number\n", encoding="utf-8")
    hosts = parse_ssh_config(config)
    assert len(hosts) == 1
    assert hosts[0].port == 22


def test_host_config_from_ssh_config() -> None:
    from app.utils.ssh_keys import SSHConfigHost

    entry = SSHConfigHost(
        alias="lele",
        hostname="192.168.1.13",
        port=22,
        username="Le",
        identity_file="/home/u/.ssh/id_ed25519_lele",
    )
    host = HostConfig.from_ssh_config(entry)
    host.validate()
    assert host.name == "lele"
    assert host.target == "Le@192.168.1.13:22"
    assert host.auth_method is AuthMethod.PRIVATE_KEY
    assert host.private_key_path == "/home/u/.ssh/id_ed25519_lele"
    assert host.remote_workspace == ""


def test_host_config_from_ssh_config_without_identity_file() -> None:
    from app.utils.ssh_keys import SSHConfigHost

    host = HostConfig.from_ssh_config(SSHConfigHost(alias="box", username="root"))
    assert host.auth_method is AuthMethod.PASSWORD
    assert host.host == "box"
    assert host.private_key_path == ""
