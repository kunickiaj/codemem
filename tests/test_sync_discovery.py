from pathlib import Path

from opencode_mem import db
from opencode_mem.sync_discovery import (
    load_peer_addresses,
    merge_addresses,
    record_peer_success,
    select_dial_addresses,
    update_peer_addresses,
)


def test_merge_addresses_dedupes_and_normalizes() -> None:
    merged = merge_addresses(
        ["http://Host:8000/", "host:8000", ""],
        ["http://host:8000", "peer.local:9000"],
    )
    assert merged == ["http://host:8000", "host:8000", "peer.local:9000"]


def test_update_peer_addresses_persists(tmp_path: Path) -> None:
    conn = db.connect(tmp_path / "mem.sqlite")
    try:
        db.initialize_schema(conn)
        update_peer_addresses(
            conn,
            "peer-1",
            ["peer.local:8000", "peer.local:8000", "http://peer.local:8000"],
        )
        addresses = load_peer_addresses(conn, "peer-1")
        assert addresses == ["peer.local:8000", "http://peer.local:8000"]
    finally:
        conn.close()


def test_record_peer_success_moves_address_first(tmp_path: Path) -> None:
    conn = db.connect(tmp_path / "mem.sqlite")
    try:
        db.initialize_schema(conn)
        update_peer_addresses(
            conn,
            "peer-1",
            ["peer.local:8000", "http://peer.local:8000"],
        )
        ordered = record_peer_success(conn, "peer-1", "http://peer.local:8000")
        assert ordered == ["http://peer.local:8000", "peer.local:8000"]
    finally:
        conn.close()


def test_select_dial_addresses_prefers_mdns() -> None:
    stored = ["peer.local:8000", "tailscale.local:7337", "10.0.0.5:7337"]
    mdns = ["peer.local:8000", "peer.local:9000"]
    ordered = select_dial_addresses(stored=stored, mdns=mdns)
    assert ordered == [
        "peer.local:8000",
        "peer.local:9000",
        "tailscale.local:7337",
        "10.0.0.5:7337",
    ]
