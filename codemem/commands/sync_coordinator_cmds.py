from __future__ import annotations

from http.server import HTTPServer
from pathlib import Path

from rich import print

from ..coordinator_api import build_coordinator_handler
from ..coordinator_store import DEFAULT_COORDINATOR_DB_PATH, CoordinatorStore


def coordinator_serve_cmd(*, db_path: str | None, host: str, port: int) -> None:
    resolved_db = Path(db_path or DEFAULT_COORDINATOR_DB_PATH).expanduser()
    store = CoordinatorStore(resolved_db)
    store.close()
    handler = build_coordinator_handler(resolved_db)
    server = HTTPServer((host, port), handler)
    print(f"[green]Coordinator listening[/green] {host}:{port}")
    print(f"- DB: {resolved_db}")
    server.serve_forever()


def coordinator_group_create_cmd(*, group_id: str, name: str | None, db_path: str | None) -> None:
    store = CoordinatorStore(db_path or DEFAULT_COORDINATOR_DB_PATH)
    try:
        store.create_group(group_id, display_name=name)
    finally:
        store.close()
    print(f"[green]Created coordinator group[/green] {group_id}")


def coordinator_enroll_device_cmd(
    *,
    group_id: str,
    device_id: str,
    fingerprint: str,
    public_key_file: str,
    name: str | None,
    db_path: str | None,
) -> None:
    public_key = Path(public_key_file).expanduser().read_text().strip()
    store = CoordinatorStore(db_path or DEFAULT_COORDINATOR_DB_PATH)
    try:
        store.create_group(group_id)
        store.enroll_device(
            group_id,
            device_id=device_id,
            fingerprint=fingerprint,
            public_key=public_key,
            display_name=name,
        )
    finally:
        store.close()
    print(f"[green]Enrolled device[/green] {device_id} -> {group_id}")
