from __future__ import annotations

from http.server import HTTPServer
from pathlib import Path

from rich import print

from .. import db
from ..config import get_config_path, load_config, read_config_file, write_config_file
from ..coordinator_api import build_coordinator_handler
from ..coordinator_invites import (
    InvitePayload,
    decode_invite_payload,
    encode_invite_payload,
    extract_invite_payload,
    invite_link,
)
from ..coordinator_store import DEFAULT_COORDINATOR_DB_PATH, CoordinatorStore
from ..sync import http_client
from ..sync_identity import ensure_device_identity, load_public_key

VALID_INVITE_POLICIES = {"auto_admit", "approval_required"}


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


def coordinator_list_devices_cmd(
    *,
    group_id: str,
    include_disabled: bool,
    db_path: str | None,
) -> None:
    store = CoordinatorStore(db_path or DEFAULT_COORDINATOR_DB_PATH)
    try:
        rows = store.list_enrolled_devices(group_id=group_id, include_disabled=include_disabled)
    finally:
        store.close()
    if not rows:
        print(f"[yellow]No enrolled devices[/yellow] for {group_id}")
        return
    print(f"[bold]Enrolled devices[/bold] for {group_id}")
    for row in rows:
        state = "enabled" if row.get("enabled") else "disabled"
        display_name = row.get("display_name") or row.get("device_id")
        print(f"- {display_name} ({state}) ({row.get('device_id')})")


def coordinator_rename_device_cmd(
    *,
    group_id: str,
    device_id: str,
    name: str,
    db_path: str | None,
) -> None:
    store = CoordinatorStore(db_path or DEFAULT_COORDINATOR_DB_PATH)
    try:
        updated = store.rename_device(group_id=group_id, device_id=device_id, display_name=name)
    finally:
        store.close()
    if not updated:
        raise SystemExit(f"Device not found in {group_id}: {device_id}")
    print(f"[green]Renamed device[/green] {device_id} -> {name}")


def coordinator_disable_device_cmd(
    *,
    group_id: str,
    device_id: str,
    db_path: str | None,
) -> None:
    store = CoordinatorStore(db_path or DEFAULT_COORDINATOR_DB_PATH)
    try:
        updated = store.set_device_enabled(group_id=group_id, device_id=device_id, enabled=False)
    finally:
        store.close()
    if not updated:
        raise SystemExit(f"Device not found in {group_id}: {device_id}")
    print(f"[green]Disabled device[/green] {device_id}")


def coordinator_remove_device_cmd(
    *,
    group_id: str,
    device_id: str,
    db_path: str | None,
) -> None:
    store = CoordinatorStore(db_path or DEFAULT_COORDINATOR_DB_PATH)
    try:
        removed = store.remove_device(group_id=group_id, device_id=device_id)
    finally:
        store.close()
    if not removed:
        raise SystemExit(f"Device not found in {group_id}: {device_id}")
    print(f"[green]Removed device[/green] {device_id}")


def _resolve_remote_target(
    remote_url: str | None, admin_secret: str | None
) -> tuple[str | None, str | None]:
    config = load_config()
    resolved_url = (remote_url or "").strip() or None
    resolved_secret = (
        (admin_secret or config.sync_coordinator_admin_secret or "").strip()
        if resolved_url
        else None
    )
    return resolved_url, resolved_secret


def _remote_admin_headers(admin_secret: str) -> dict[str, str]:
    return {"X-Codemem-Coordinator-Admin": admin_secret}


def _remote_request(
    method: str,
    url: str,
    *,
    admin_secret: str,
    body: dict | None = None,
) -> dict | None:
    status, payload = http_client.request_json(
        method,
        url,
        headers=_remote_admin_headers(admin_secret),
        body=body,
        timeout_s=3.0,
    )
    if not (200 <= status < 300):
        detail = payload.get("error") if isinstance(payload, dict) else None
        raise SystemExit(f"Remote coordinator request failed ({status}): {detail or 'unknown'}")
    return payload


def coordinator_create_invite_cmd(
    *,
    group_id: str,
    coordinator_url: str | None,
    policy: str,
    ttl_hours: int,
    created_by: str | None,
    db_path: str | None,
    remote_url: str | None,
    admin_secret: str | None,
) -> None:
    if policy not in VALID_INVITE_POLICIES:
        raise SystemExit(
            f"Invalid policy: {policy!r}. Must be one of: {', '.join(sorted(VALID_INVITE_POLICIES))}"
        )
    expires_at = __import__("datetime").datetime.now(__import__("datetime").UTC) + __import__(
        "datetime"
    ).timedelta(hours=ttl_hours)
    expires_value = expires_at.isoformat()
    resolved_remote_url, resolved_admin_secret = _resolve_remote_target(remote_url, admin_secret)
    if resolved_remote_url:
        if not resolved_admin_secret:
            raise SystemExit("Remote coordinator admin secret required")
        payload = _remote_request(
            "POST",
            f"{resolved_remote_url.rstrip('/')}/v1/admin/invites",
            admin_secret=resolved_admin_secret,
            body={
                "group_id": group_id,
                "policy": policy,
                "expires_at": expires_value,
                "created_by": created_by,
                "coordinator_url": coordinator_url or resolved_remote_url,
            },
        )
        print(f"[green]Invite created[/green] {group_id}")
        print(f"- import: {payload.get('encoded')}")
        print(f"- link: {payload.get('link')}")
        return

    store = CoordinatorStore(db_path or DEFAULT_COORDINATOR_DB_PATH)
    try:
        group = store.get_group(group_id)
        if group is None:
            raise SystemExit(f"Group not found: {group_id}")
        invite = store.create_invite(
            group_id=group_id,
            policy=policy,
            expires_at=expires_value,
            created_by=created_by,
        )
    finally:
        store.close()
    payload: InvitePayload = {
        "v": 1,
        "kind": "coordinator_team_invite",
        "coordinator_url": (coordinator_url or "").strip(),
        "group_id": group_id,
        "policy": policy,
        "token": str(invite.get("token") or ""),
        "expires_at": expires_value,
        "team_name": invite.get("team_name_snapshot"),
    }
    encoded = encode_invite_payload(payload)
    print(f"[green]Invite created[/green] {group_id}")
    print(f"- import: {encoded}")
    print(f"- link: {invite_link(encoded)}")


def coordinator_import_invite_cmd(
    *,
    invite_value: str,
    db_path: str | None,
    keys_dir: str | None,
    config_path: str | None,
) -> None:
    payload: InvitePayload = decode_invite_payload(extract_invite_payload(invite_value))
    resolved_db_path = (
        Path(db_path).expanduser() if db_path else Path.home() / ".codemem" / "mem.sqlite"
    )
    resolved_keys_dir = Path(keys_dir).expanduser() if keys_dir else None
    resolved_config_path = get_config_path(Path(config_path).expanduser() if config_path else None)

    conn = db.connect(resolved_db_path)
    try:
        db.initialize_schema(conn)
        device_id, fingerprint = ensure_device_identity(conn, keys_dir=resolved_keys_dir)
    finally:
        conn.close()
    public_key = load_public_key(resolved_keys_dir)
    if not public_key:
        raise SystemExit("public key missing")

    resolved_config = load_config(resolved_config_path)
    display_name = resolved_config.actor_display_name or device_id

    status, response = http_client.request_json(
        "POST",
        f"{str(payload['coordinator_url']).rstrip('/')}/v1/join",
        body={
            "token": str(payload["token"]),
            "device_id": device_id,
            "public_key": public_key,
            "fingerprint": fingerprint,
            "display_name": display_name,
        },
        timeout_s=3.0,
    )
    if not (200 <= status < 300):
        detail = response.get("error") if isinstance(response, dict) else None
        raise SystemExit(f"Invite import failed ({status}): {detail or 'unknown'}")
    response_data = response if isinstance(response, dict) else {}

    config_data = read_config_file(resolved_config_path)
    config_data["sync_coordinator_url"] = str(payload["coordinator_url"])
    config_data["sync_coordinator_group"] = str(payload["group_id"])
    write_config_file(config_data, resolved_config_path)

    print(f"[green]Invite imported[/green] {payload['group_id']}")
    print(f"- coordinator: {payload['coordinator_url']}")
    print(f"- status: {response_data.get('status')}")
