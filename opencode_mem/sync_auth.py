from __future__ import annotations

import base64
import binascii
import datetime as dt
import hashlib
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .sync_identity import resolve_key_paths

SIGNATURE_VERSION = "v1"
DEFAULT_TIME_WINDOW_S = 300


def build_canonical_request(
    method: str,
    path_with_query: str,
    *,
    timestamp: str,
    nonce: str,
    body_bytes: bytes,
) -> bytes:
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    canonical = "\n".join([method.upper(), path_with_query, timestamp, nonce, body_hash])
    return canonical.encode("utf-8")


def _ssh_keygen_available() -> bool:
    return shutil.which("ssh-keygen") is not None


def sign_request(
    *,
    method: str,
    url: str,
    body_bytes: bytes,
    keys_dir: Path | None = None,
    timestamp: str | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    if not _ssh_keygen_available():
        raise RuntimeError("ssh-keygen required for signing")
    ts = timestamp or str(int(dt.datetime.now(dt.UTC).timestamp()))
    nonce_value = nonce or secrets.token_hex(16)
    parsed = urlparse(url)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    canonical = build_canonical_request(
        method,
        path,
        timestamp=ts,
        nonce=nonce_value,
        body_bytes=body_bytes,
    )
    private_key_path, _ = resolve_key_paths(keys_dir)
    if not private_key_path.exists():
        raise RuntimeError("private key missing")
    with tempfile.TemporaryDirectory() as tmp:
        data_path = Path(tmp) / "request"
        data_path.write_bytes(canonical)
        subprocess.run(
            [
                "ssh-keygen",
                "-Y",
                "sign",
                "-f",
                str(private_key_path),
                "-n",
                "opencode-mem-sync",
                str(data_path),
            ],
            capture_output=True,
            check=True,
        )
        sig_path = Path(f"{data_path}.sig")
        signature_bytes = sig_path.read_bytes()
    signature = base64.b64encode(signature_bytes).decode("utf-8")
    return {
        "X-Opencode-Timestamp": ts,
        "X-Opencode-Nonce": nonce_value,
        "X-Opencode-Signature": f"{SIGNATURE_VERSION}:{signature}",
    }


def verify_signature(
    *,
    method: str,
    path_with_query: str,
    body_bytes: bytes,
    timestamp: str,
    nonce: str,
    signature: str,
    public_key: str,
    device_id: str,
    time_window_s: int = DEFAULT_TIME_WINDOW_S,
) -> bool:
    try:
        ts_int = int(timestamp)
    except (TypeError, ValueError):
        return False
    now = int(dt.datetime.now(dt.UTC).timestamp())
    if abs(now - ts_int) > time_window_s:
        return False
    if not signature.startswith(f"{SIGNATURE_VERSION}:"):
        return False
    encoded = signature.split(":", 1)[1]
    try:
        signature_bytes = base64.b64decode(encoded)
    except (ValueError, binascii.Error):
        return False
    canonical = build_canonical_request(
        method,
        path_with_query,
        timestamp=timestamp,
        nonce=nonce,
        body_bytes=body_bytes,
    )
    with tempfile.TemporaryDirectory() as tmp:
        key_path = Path(tmp) / "allowed_signers"
        key_path.write_text(f"{device_id} {public_key}\n")
        sig_path = Path(tmp) / "request.sig"
        sig_path.write_bytes(signature_bytes)
        proc = subprocess.run(
            [
                "ssh-keygen",
                "-Y",
                "verify",
                "-f",
                str(key_path),
                "-I",
                device_id,
                "-n",
                "opencode-mem-sync",
                "-s",
                str(sig_path),
            ],
            input=canonical,
            capture_output=True,
        )
    return proc.returncode == 0


def build_auth_headers(
    *,
    device_id: str,
    method: str,
    url: str,
    body_bytes: bytes,
    keys_dir: Path | None = None,
    timestamp: str | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    headers = {"X-Opencode-Device": device_id}
    headers.update(
        sign_request(
            method=method,
            url=url,
            body_bytes=body_bytes,
            keys_dir=keys_dir,
            timestamp=timestamp,
            nonce=nonce,
        )
    )
    return headers


def record_nonce(
    conn: sqlite3.Connection,
    *,
    device_id: str,
    nonce: str,
    created_at: str,
) -> bool:
    try:
        conn.execute(
            "INSERT INTO sync_nonces(nonce, device_id, created_at) VALUES (?, ?, ?)",
            (nonce, device_id, created_at),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def cleanup_nonces(conn: sqlite3.Connection, *, cutoff: str) -> None:
    conn.execute("DELETE FROM sync_nonces WHERE created_at < ?", (cutoff,))
    conn.commit()
