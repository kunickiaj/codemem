from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from codemem.cli import app
from codemem.store import MemoryStore

runner = CliRunner()


def test_enqueue_raw_event_cmd_writes_event_and_meta(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    payload = {
        "opencode_session_id": "sess-cli",
        "event_id": "evt-1",
        "event_type": "assistant_message",
        "payload": {"type": "assistant_message", "assistant_text": "done"},
        "ts_wall_ms": 123,
        "ts_mono_ms": 4.5,
        "cwd": "/tmp/wt",
        "project": "codemem",
        "started_at": "2026-03-02T20:00:00Z",
    }

    result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload),
    )

    assert result.exit_code == 0
    store = MemoryStore(db_path)
    try:
        events = store.raw_events_since(opencode_session_id="sess-cli", after_event_seq=-1)
        assert len(events) == 1
        assert events[0]["event_id"] == "evt-1"
        meta = store.raw_event_session_meta("sess-cli")
        assert meta["cwd"] == "/tmp/wt"
        assert meta["project"] == "codemem"
        assert meta["started_at"] == "2026-03-02T20:00:00Z"
        assert meta["last_seen_ts_wall_ms"] == 123
    finally:
        store.close()


def test_enqueue_raw_event_cmd_rejects_empty_stdin(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    result = runner.invoke(app, ["enqueue-raw-event", "--db-path", str(db_path)], input="\n")

    assert result.exit_code != 0
    assert "stdin payload required" in result.output
    store = MemoryStore(db_path)
    try:
        events = store.raw_events_since(opencode_session_id="sess-empty", after_event_seq=-1)
        assert events == []
    finally:
        store.close()


def test_enqueue_raw_event_cmd_uses_payload_raw_event_id_when_event_id_missing(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "mem.sqlite"
    payload = {
        "opencode_session_id": "sess-cli",
        "event_type": "user_prompt",
        "payload": {"_raw_event_id": "stable-raw-id", "type": "user_prompt"},
    }

    result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload),
    )

    assert result.exit_code == 0
    store = MemoryStore(db_path)
    try:
        events = store.raw_events_since(opencode_session_id="sess-cli", after_event_seq=-1)
        assert len(events) == 1
        assert events[0]["event_id"] == "stable-raw-id"
    finally:
        store.close()


def test_enqueue_raw_event_cmd_rejects_invalid_payload(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    payload = {
        "opencode_session_id": "sess-cli",
        "event_id": "evt-1",
        "event_type": "assistant_message",
        "payload": "not-an-object",
    }

    result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload),
    )

    assert result.exit_code != 0
    assert "payload must be an object" in result.output


def test_enqueue_raw_event_cmd_keeps_last_seen_timestamp_monotonic(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    first = {
        "opencode_session_id": "sess-cli",
        "event_id": "evt-1",
        "event_type": "assistant_message",
        "payload": {},
        "ts_wall_ms": 200,
    }
    second = {
        "opencode_session_id": "sess-cli",
        "event_id": "evt-2",
        "event_type": "assistant_message",
        "payload": {},
        "ts_wall_ms": 100,
    }

    first_result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(first),
    )
    second_result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(second),
    )

    assert first_result.exit_code == 0
    assert second_result.exit_code == 0
    store = MemoryStore(db_path)
    try:
        meta = store.raw_event_session_meta("sess-cli")
        assert meta["last_seen_ts_wall_ms"] == 200
    finally:
        store.close()


def test_enqueue_raw_event_cmd_strips_private_tags_from_payload(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    payload = {
        "opencode_session_id": "sess-redact",
        "event_id": "evt-redact-1",
        "event_type": "assistant_message",
        "payload": {
            "assistant_text": "before <private>secret-token</private> after",
            "nested": {
                "note": "x<private>hidden</private>y",
            },
        },
    }

    result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload),
    )

    assert result.exit_code == 0
    store = MemoryStore(db_path)
    try:
        events = store.raw_events_since(opencode_session_id="sess-redact", after_event_seq=-1)
        assert len(events) == 1
        stored_event = json.dumps(events[0], sort_keys=True)
        assert "<private>" not in stored_event
        assert "secret-token" not in stored_event
        assert "hidden" not in stored_event
    finally:
        store.close()
