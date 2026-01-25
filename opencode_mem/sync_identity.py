from __future__ import annotations

import datetime as dt
import hashlib
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path
from uuid import uuid4

from .utils import ensure_path

DEFAULT_KEYS_DIR = Path("~/.config/opencode-mem/keys").expanduser()
PRIVATE_KEY_NAME = "device.key"
PUBLIC_KEY_NAME = "device.key.pub"


def fingerprint_public_key(public_key: str) -> str:
    return hashlib.sha256(public_key.encode("utf-8")).hexdigest()


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
            return existing_device_id, fingerprint
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
    return resolved_device_id, fingerprint


def load_private_key(keys_dir: Path | None = None) -> bytes | None:
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
