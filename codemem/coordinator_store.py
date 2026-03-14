from __future__ import annotations

import datetime as dt
import json
import secrets
import sqlite3
from pathlib import Path
from typing import Any

from .sync.discovery import merge_addresses

DEFAULT_COORDINATOR_DB_PATH = Path.home() / ".codemem" / "coordinator.sqlite"


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    db_path = Path(path or DEFAULT_COORDINATOR_DB_PATH).expanduser()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    initialize_schema(conn)
    return conn


def initialize_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS groups (
            group_id TEXT PRIMARY KEY,
            display_name TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS enrolled_devices (
            group_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            public_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            display_name TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            PRIMARY KEY (group_id, device_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS presence_records (
            group_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            addresses_json TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            capabilities_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (group_id, device_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS request_nonces (
            device_id TEXT NOT NULL,
            nonce TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (device_id, nonce)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS coordinator_invites (
            invite_id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL,
            token TEXT NOT NULL UNIQUE,
            policy TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_by TEXT,
            team_name_snapshot TEXT,
            revoked_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS coordinator_join_requests (
            request_id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            public_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            display_name TEXT,
            token TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reviewed_at TEXT,
            reviewed_by TEXT
        )
        """
    )
    conn.commit()


class CoordinatorStore:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path or DEFAULT_COORDINATOR_DB_PATH).expanduser()
        self.conn = connect(self.path)

    def close(self) -> None:
        self.conn.close()

    def create_group(self, group_id: str, *, display_name: str | None = None) -> None:
        now = dt.datetime.now(dt.UTC).isoformat()
        self.conn.execute(
            "INSERT OR IGNORE INTO groups(group_id, display_name, created_at) VALUES (?, ?, ?)",
            (group_id, display_name, now),
        )
        self.conn.commit()

    def get_group(self, group_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT group_id, display_name, created_at FROM groups WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    def enroll_device(
        self,
        group_id: str,
        *,
        device_id: str,
        fingerprint: str,
        public_key: str,
        display_name: str | None = None,
    ) -> None:
        now = dt.datetime.now(dt.UTC).isoformat()
        self.conn.execute(
            """
            INSERT INTO enrolled_devices(
                group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(group_id, device_id) DO UPDATE SET
                public_key = excluded.public_key,
                fingerprint = excluded.fingerprint,
                display_name = excluded.display_name,
                enabled = 1
            """,
            (group_id, device_id, public_key, fingerprint, display_name, now),
        )
        self.conn.commit()

    def list_enrolled_devices(
        self, *, group_id: str, include_disabled: bool = False
    ) -> list[dict[str, Any]]:
        where = "" if include_disabled else "AND enabled = 1"
        rows = self.conn.execute(
            f"""
            SELECT group_id, device_id, fingerprint, display_name, enabled, created_at
            FROM enrolled_devices
            WHERE group_id = ?
            {where}
            ORDER BY created_at ASC, device_id ASC
            """,
            (group_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_enrollment(self, *, group_id: str, device_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            """
            SELECT device_id, public_key, fingerprint, display_name
            FROM enrolled_devices
            WHERE group_id = ? AND device_id = ? AND enabled = 1
            """,
            (group_id, device_id),
        ).fetchone()
        return dict(row) if row is not None else None

    def rename_device(self, *, group_id: str, device_id: str, display_name: str) -> bool:
        result = self.conn.execute(
            """
            UPDATE enrolled_devices
            SET display_name = ?
            WHERE group_id = ? AND device_id = ?
            """,
            (display_name, group_id, device_id),
        )
        self.conn.commit()
        return int(result.rowcount or 0) > 0

    def set_device_enabled(self, *, group_id: str, device_id: str, enabled: bool) -> bool:
        result = self.conn.execute(
            """
            UPDATE enrolled_devices
            SET enabled = ?
            WHERE group_id = ? AND device_id = ?
            """,
            (1 if enabled else 0, group_id, device_id),
        )
        self.conn.commit()
        return int(result.rowcount or 0) > 0

    def remove_device(self, *, group_id: str, device_id: str) -> bool:
        self.conn.execute(
            "DELETE FROM presence_records WHERE group_id = ? AND device_id = ?",
            (group_id, device_id),
        )
        result = self.conn.execute(
            "DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?",
            (group_id, device_id),
        )
        self.conn.commit()
        return int(result.rowcount or 0) > 0

    def create_invite(
        self,
        *,
        group_id: str,
        policy: str,
        expires_at: str,
        created_by: str | None = None,
    ) -> dict[str, Any]:
        now = dt.datetime.now(dt.UTC).isoformat()
        invite_id = secrets.token_urlsafe(12)
        token = secrets.token_urlsafe(24)
        group = self.get_group(group_id)
        self.conn.execute(
            """
            INSERT INTO coordinator_invites(
                invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                invite_id,
                group_id,
                token,
                policy,
                expires_at,
                now,
                created_by,
                (group or {}).get("display_name"),
            ),
        )
        self.conn.commit()
        row = self.conn.execute(
            """
            SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
            FROM coordinator_invites WHERE invite_id = ?
            """,
            (invite_id,),
        ).fetchone()
        return dict(row) if row is not None else {}

    def get_invite_by_token(self, *, token: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            """
            SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
            FROM coordinator_invites
            WHERE token = ?
            """,
            (token,),
        ).fetchone()
        return dict(row) if row is not None else None

    def create_join_request(
        self,
        *,
        group_id: str,
        device_id: str,
        public_key: str,
        fingerprint: str,
        display_name: str | None,
        token: str,
    ) -> dict[str, Any]:
        now = dt.datetime.now(dt.UTC).isoformat()
        request_id = secrets.token_urlsafe(12)
        self.conn.execute(
            """
            INSERT INTO coordinator_join_requests(
                request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)
            """,
            (request_id, group_id, device_id, public_key, fingerprint, display_name, token, now),
        )
        self.conn.commit()
        row = self.conn.execute(
            """
            SELECT request_id, group_id, device_id, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
            FROM coordinator_join_requests WHERE request_id = ?
            """,
            (request_id,),
        ).fetchone()
        return dict(row) if row is not None else {}

    def upsert_presence(
        self,
        *,
        group_id: str,
        device_id: str,
        addresses: list[str],
        ttl_s: int,
        capabilities: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = dt.datetime.now(dt.UTC)
        expires_at = (now + dt.timedelta(seconds=ttl_s)).isoformat()
        normalized = merge_addresses([], addresses)
        self.conn.execute(
            """
            INSERT INTO presence_records(group_id, device_id, addresses_json, last_seen_at, expires_at, capabilities_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_id, device_id) DO UPDATE SET
                addresses_json = excluded.addresses_json,
                last_seen_at = excluded.last_seen_at,
                expires_at = excluded.expires_at,
                capabilities_json = excluded.capabilities_json
            """,
            (
                group_id,
                device_id,
                json.dumps(normalized, ensure_ascii=False),
                now.isoformat(),
                expires_at,
                json.dumps(capabilities or {}, ensure_ascii=False),
            ),
        )
        self.conn.commit()
        return {
            "group_id": group_id,
            "device_id": device_id,
            "addresses": normalized,
            "expires_at": expires_at,
        }

    def list_group_peers(self, *, group_id: str, requesting_device_id: str) -> list[dict[str, Any]]:
        now = dt.datetime.now(dt.UTC)
        rows = self.conn.execute(
            """
            SELECT enrolled_devices.device_id, enrolled_devices.fingerprint, enrolled_devices.display_name,
                   presence_records.addresses_json, presence_records.last_seen_at, presence_records.expires_at,
                   presence_records.capabilities_json
            FROM enrolled_devices
            LEFT JOIN presence_records
              ON presence_records.group_id = enrolled_devices.group_id
             AND presence_records.device_id = enrolled_devices.device_id
            WHERE enrolled_devices.group_id = ?
              AND enrolled_devices.enabled = 1
              AND enrolled_devices.device_id != ?
            ORDER BY enrolled_devices.device_id ASC
            """,
            (group_id, requesting_device_id),
        ).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            expires_raw = str(row["expires_at"] or "").strip()
            stale = True
            if expires_raw:
                try:
                    expires_at = dt.datetime.fromisoformat(expires_raw.replace("Z", "+00:00"))
                    if expires_at.tzinfo is None:
                        expires_at = expires_at.replace(tzinfo=dt.UTC)
                    stale = expires_at <= now
                except ValueError:
                    stale = True
            addresses = (
                [] if stale else merge_addresses([], json.loads(row["addresses_json"] or "[]"))
            )
            items.append(
                {
                    "device_id": row["device_id"],
                    "fingerprint": row["fingerprint"],
                    "display_name": row["display_name"],
                    "addresses": addresses,
                    "last_seen_at": row["last_seen_at"],
                    "expires_at": row["expires_at"],
                    "stale": stale,
                    "capabilities": json.loads(row["capabilities_json"] or "{}"),
                }
            )
        return items
