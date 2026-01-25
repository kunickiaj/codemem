from __future__ import annotations

import datetime as dt
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

from . import db
from .config import load_config
from .utils import ensure_path

DEFAULT_KEYS_DIR = Path("~/.config/opencode-mem/keys").expanduser()
PRIVATE_KEY_NAME = "device.key"
PUBLIC_KEY_NAME = "device.key.pub"
KEYCHAIN_SERVICE = "opencode-mem-sync"


def fingerprint_public_key(public_key: str) -> str:
    return hashlib.sha256(public_key.encode("utf-8")).hexdigest()


def _key_store_mode() -> str:
    config = load_config()
    mode = (config.sync_key_store or "file").lower()
    return mode if mode in {"file", "keychain"} else "file"


def _warn_keychain_limitations() -> None:
    if not sys.platform.startswith("darwin"):
        return
    if _key_store_mode() != "keychain":
        return
    if os.environ.get("OPENCODE_MEM_SYNC_KEYCHAIN_WARN") == "0":
        return
    print(
        "[opencode-mem] keychain storage on macOS uses the `security` CLI and may expose the key in process arguments."
    )


def _secret_tool_available() -> bool:
    return shutil.which("secret-tool") is not None


def _security_cli_available() -> bool:
    return shutil.which("security") is not None


def _load_device_id(db_path: Path | None = None) -> str | None:
    path = Path(db_path or os.environ.get("OPENCODE_MEM_DB") or db.DEFAULT_DB_PATH)
    conn = db.connect(path)
    try:
        row = conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
        return str(row["device_id"]) if row else None
    finally:
        conn.close()


def store_private_key_keychain(private_key: bytes, device_id: str) -> bool:
    if sys.platform.startswith("linux"):
        if not _secret_tool_available():
            return False
        result = subprocess.run(
            [
                "secret-tool",
                "store",
                "--label",
                "opencode-mem sync key",
                "service",
                KEYCHAIN_SERVICE,
                "account",
                device_id,
            ],
            input=private_key,
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    if sys.platform.startswith("darwin"):
        if not _security_cli_available():
            return False
        result = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-a",
                device_id,
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
                private_key.decode("utf-8"),
                "-U",
            ],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    return False


def load_private_key_keychain(device_id: str) -> bytes | None:
    if sys.platform.startswith("linux"):
        if not _secret_tool_available():
            return None
        result = subprocess.run(
            [
                "secret-tool",
                "lookup",
                "service",
                KEYCHAIN_SERVICE,
                "account",
                device_id,
            ],
            capture_output=True,
            check=False,
        )
        return result.stdout if result.returncode == 0 else None
    if sys.platform.startswith("darwin"):
        if not _security_cli_available():
            return None
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-a",
                device_id,
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
            ],
            capture_output=True,
            check=False,
        )
        return result.stdout if result.returncode == 0 else None
    return None


def _ssh_keygen_available() -> bool:
    return shutil.which("ssh-keygen") is not None


def _generate_keypair(private_key_path: Path, public_key_path: Path) -> None:
    ensure_path(private_key_path)
    if private_key_path.exists() and public_key_path.exists():
        return
    if not _ssh_keygen_available():
        raise RuntimeError("ssh-keygen not available for key generation")
    cmd = [
        "ssh-keygen",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        str(private_key_path),
        "-q",
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    os.chmod(private_key_path, 0o600)
    if not public_key_path.exists():
        raise RuntimeError("public key generation failed")


def ensure_device_identity(
    conn: sqlite3.Connection,
    *,
    keys_dir: Path | None = None,
    device_id: str | None = None,
) -> tuple[str, str]:
    key_dir = (keys_dir or DEFAULT_KEYS_DIR).expanduser()
    private_key_path = key_dir / PRIVATE_KEY_NAME
    public_key_path = key_dir / PUBLIC_KEY_NAME
    _warn_keychain_limitations()

    row = conn.execute(
        "SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 1"
    ).fetchone()
    existing_device_id = str(row["device_id"]) if row else ""
    existing_public_key = str(row["public_key"]) if row else ""
    existing_fingerprint = str(row["fingerprint"]) if row else ""

    keys_ready = private_key_path.exists() and public_key_path.exists()
    if not keys_ready:
        _generate_keypair(private_key_path, public_key_path)

    public_key = public_key_path.read_text().strip()
    if not public_key:
        raise RuntimeError("public key missing")
    fingerprint = fingerprint_public_key(public_key)
    now = dt.datetime.now(dt.UTC).isoformat()

    if existing_device_id:
        if existing_public_key != public_key or existing_fingerprint != fingerprint:
            conn.execute(
                """
                UPDATE sync_device
                SET public_key = ?, fingerprint = ?
                WHERE device_id = ?
                """,
                (public_key, fingerprint, existing_device_id),
            )
            conn.commit()
            existing_fingerprint = fingerprint
        if _key_store_mode() == "keychain":
            private_key = load_private_key(keys_dir)
            if private_key:
                store_private_key_keychain(private_key, existing_device_id)
        return existing_device_id, existing_fingerprint

    resolved_device_id = device_id or str(uuid4())
    conn.execute(
        """
        INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (resolved_device_id, public_key, fingerprint, now),
    )
    conn.commit()
    if _key_store_mode() == "keychain":
        private_key = load_private_key(keys_dir)
        if private_key:
            store_private_key_keychain(private_key, resolved_device_id)
    return resolved_device_id, fingerprint


def load_private_key(keys_dir: Path | None = None) -> bytes | None:
    if _key_store_mode() == "keychain":
        device_id = _load_device_id()
        if device_id:
            keychain_value = load_private_key_keychain(device_id)
            if keychain_value:
                return keychain_value
    key_dir = (keys_dir or DEFAULT_KEYS_DIR).expanduser()
    private_key_path = key_dir / PRIVATE_KEY_NAME
    if not private_key_path.exists():
        return None
    return private_key_path.read_bytes()


def load_public_key(keys_dir: Path | None = None) -> str | None:
    key_dir = (keys_dir or DEFAULT_KEYS_DIR).expanduser()
    public_key_path = key_dir / PUBLIC_KEY_NAME
    if not public_key_path.exists():
        return None
    return public_key_path.read_text().strip() or None


def resolve_key_paths(keys_dir: Path | None = None) -> tuple[Path, Path]:
    key_dir = (keys_dir or DEFAULT_KEYS_DIR).expanduser()
    return key_dir / PRIVATE_KEY_NAME, key_dir / PUBLIC_KEY_NAME
