from __future__ import annotations

from codemem.claude_hooks import build_ingest_payload_from_hook, map_claude_hook_payload


def test_map_user_prompt_submit_to_prompt_event() -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-123",
        "prompt": "Run tests",
        "cwd": "/tmp/repo",
        "custom_field": "keep-me",
    }

    event = map_claude_hook_payload(payload)

    assert event is not None
    assert event["source"] == "claude"
    assert event["event_type"] == "prompt"
    assert event["payload"]["text"] == "Run tests"
    assert event["meta"]["hook_event_name"] == "UserPromptSubmit"
    assert event["meta"]["hook_fields"]["custom_field"] == "keep-me"


def test_map_pre_tool_use_to_tool_call_event() -> None:
    payload = {
        "hook_event_name": "PreToolUse",
        "session_id": "sess-abc",
        "tool_use_id": "toolu_1",
        "tool_name": "Bash",
        "tool_input": {"command": "uv run pytest"},
    }

    event = map_claude_hook_payload(payload)

    assert event is not None
    assert event["event_type"] == "tool_call"
    assert event["payload"]["tool_name"] == "Bash"
    assert event["payload"]["tool_input"] == {"command": "uv run pytest"}
    assert event["meta"]["tool_use_id"] == "toolu_1"


def test_map_post_tool_use_failure_to_tool_result_error() -> None:
    payload = {
        "hook_event_name": "PostToolUseFailure",
        "session_id": "sess-abc",
        "tool_name": "Bash",
        "tool_input": {"command": "uv run pytest"},
        "error": {"message": "1 failed"},
    }

    event = map_claude_hook_payload(payload)

    assert event is not None
    assert event["event_type"] == "tool_result"
    assert event["payload"]["status"] == "error"
    assert event["payload"]["error"] == {"message": "1 failed"}


def test_build_ingest_payload_wraps_adapter_event() -> None:
    payload = {
        "hook_event_name": "SessionStart",
        "session_id": "sess-xyz",
        "source": "startup",
        "cwd": "/tmp/repo",
    }

    ingest_payload = build_ingest_payload_from_hook(payload)

    assert ingest_payload is not None
    assert ingest_payload["session_context"]["opencode_session_id"] == "claude:sess-xyz"
    event = ingest_payload["events"][0]
    assert event["_adapter"]["event_type"] == "session_start"


def test_map_post_tool_use_to_tool_result_ok() -> None:
    payload = {
        "hook_event_name": "PostToolUse",
        "session_id": "sess-abc",
        "tool_name": "Bash",
        "tool_input": {"command": "uv run pytest"},
        "tool_response": {"exit_code": 0},
    }

    event = map_claude_hook_payload(payload)

    assert event is not None
    assert event["event_type"] == "tool_result"
    assert event["payload"]["status"] == "ok"
    assert event["payload"]["tool_output"] == {"exit_code": 0}


def test_map_session_end_to_session_end_event() -> None:
    payload = {
        "hook_event_name": "SessionEnd",
        "session_id": "sess-end",
        "reason": "user_exit",
    }

    event = map_claude_hook_payload(payload)

    assert event is not None
    assert event["event_type"] == "session_end"
    assert event["payload"]["reason"] == "user_exit"


def test_map_claude_hook_payload_event_id_is_stable_with_explicit_timestamp() -> None:
    payload = {
        "hook_event_name": "SessionStart",
        "session_id": "sess-stable",
        "source": "startup",
        "ts": "2026-03-02T20:00:00Z",
    }

    first = map_claude_hook_payload(payload)
    second = map_claude_hook_payload(payload)

    assert first is not None
    assert second is not None
    assert first["event_id"] == second["event_id"]


def test_map_claude_hook_payload_marks_generated_timestamp_when_missing() -> None:
    payload = {
        "hook_event_name": "SessionStart",
        "session_id": "sess-stable-no-ts",
        "source": "startup",
    }

    mapped = map_claude_hook_payload(payload)

    assert mapped is not None
    assert mapped["meta"]["ts_normalized"] == "generated"
    assert mapped["event_id"].startswith("cld_evt_")


def test_map_claude_hook_payload_missing_ts_generates_distinct_event_ids(
    monkeypatch,
) -> None:
    payload = {
        "hook_event_name": "SessionStart",
        "session_id": "sess-repeat",
        "source": "startup",
    }
    generated = iter(
        [
            "2026-03-02T20:00:00.000000Z",
            "2026-03-02T20:00:00.000001Z",
        ]
    )

    monkeypatch.setattr("codemem.claude_hooks._now_iso", lambda: next(generated))

    first = map_claude_hook_payload(payload)
    second = map_claude_hook_payload(payload)

    assert first is not None
    assert second is not None
    assert first["ts"] != second["ts"]
    assert first["event_id"] != second["event_id"]
