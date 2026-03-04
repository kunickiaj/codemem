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
        identity = store.conn.execute(
            "SELECT source, stream_id FROM raw_event_sessions WHERE opencode_session_id = ?",
            ("sess-cli",),
        ).fetchone()
        assert identity is not None
        assert identity["source"] == "opencode"
        assert identity["stream_id"] == "sess-cli"
    finally:
        store.close()


def test_enqueue_raw_event_cmd_accepts_session_stream_id_alias(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    payload = {
        "session_stream_id": "sess-stream-alias",
        "event_id": "evt-1",
        "event_type": "assistant_message",
        "payload": {"type": "assistant_message", "assistant_text": "done"},
    }

    result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload),
    )

    assert result.exit_code == 0
    store = MemoryStore(db_path)
    try:
        events = store.raw_events_since(opencode_session_id="sess-stream-alias", after_event_seq=-1)
        assert len(events) == 1
    finally:
        store.close()


def test_enqueue_raw_event_cmd_rejects_conflicting_session_id_fields(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    payload = {
        "session_stream_id": "sess-a",
        "opencode_session_id": "sess-b",
        "event_id": "evt-1",
        "event_type": "assistant_message",
        "payload": {"type": "assistant_message", "assistant_text": "done"},
    }

    result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload),
    )

    assert result.exit_code != 0
    assert "conflicting session id fields" in result.output


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
                "authorization": "Bearer abc123",
            },
            "api_key": "key-1",
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
        assert "abc123" not in stored_event
        assert "key-1" not in stored_event
        assert "[REDACTED]" in stored_event
    finally:
        store.close()


def test_enqueue_raw_event_cmd_tracks_source_and_stream_identity_columns(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    stream_id = "4d297237-0bcd-4f1c-9f4e-c8b934c6fab8"
    payload = {
        "opencode_session_id": stream_id,
        "source": "claude",
        "event_id": "evt-claude-1",
        "event_type": "user_prompt",
        "payload": {"type": "user_prompt", "prompt_text": "Claude identity test"},
    }

    result = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload),
    )

    assert result.exit_code == 0
    store = MemoryStore(db_path)
    try:
        session_row = store.conn.execute(
            "SELECT source, stream_id FROM raw_event_sessions WHERE opencode_session_id = ?",
            (stream_id,),
        ).fetchone()
        assert session_row is not None
        assert session_row["source"] == "claude"
        assert session_row["stream_id"] == stream_id

        event_row = store.conn.execute(
            "SELECT source, stream_id FROM raw_events WHERE opencode_session_id = ?",
            (stream_id,),
        ).fetchone()
        assert event_row is not None
        assert event_row["source"] == "claude"
        assert event_row["stream_id"] == stream_id
    finally:
        store.close()


def test_enqueue_raw_event_cmd_allows_same_stream_id_across_sources(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    stream_id = "shared-stream"
    payload_opencode = {
        "opencode_session_id": stream_id,
        "source": "opencode",
        "event_id": "evt-shared",
        "event_type": "user_prompt",
        "payload": {"type": "user_prompt", "prompt_text": "OpenCode"},
    }
    payload_claude = {
        "opencode_session_id": stream_id,
        "source": "claude",
        "event_id": "evt-shared",
        "event_type": "user_prompt",
        "payload": {"type": "user_prompt", "prompt_text": "Claude"},
    }

    first = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload_opencode),
    )
    second = runner.invoke(
        app,
        ["enqueue-raw-event", "--db-path", str(db_path)],
        input=json.dumps(payload_claude),
    )

    assert first.exit_code == 0
    assert second.exit_code == 0

    store = MemoryStore(db_path)
    try:
        rows = store.conn.execute(
            """
            SELECT source, stream_id, event_id
            FROM raw_events
            WHERE stream_id = ? AND event_id = ?
            ORDER BY source ASC
            """,
            (stream_id, "evt-shared"),
        ).fetchall()
        assert [dict(row) for row in rows] == [
            {"source": "claude", "stream_id": stream_id, "event_id": "evt-shared"},
            {"source": "opencode", "stream_id": stream_id, "event_id": "evt-shared"},
        ]
    finally:
        store.close()
