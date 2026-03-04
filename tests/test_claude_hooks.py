from __future__ import annotations

from codemem.claude_hooks import (
    build_ingest_payload_from_hook,
    build_raw_event_envelope_from_hook,
    map_claude_hook_payload,
)


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
    assert ingest_payload["session_context"]["source"] == "claude"
    assert ingest_payload["session_context"]["stream_id"] == "sess-xyz"
    assert ingest_payload["session_context"]["opencode_session_id"] == "sess-xyz"
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


def test_build_raw_event_envelope_from_hook_includes_queue_fields() -> None:
    payload = {
        "hook_event_name": "SessionStart",
        "session_id": "sess-enqueue",
        "source": "startup",
        "cwd": "/tmp/repo",
        "project": "codemem",
        "ts": "2026-03-04T01:00:00Z",
    }

    envelope = build_raw_event_envelope_from_hook(payload)

    assert envelope is not None
    assert envelope["opencode_session_id"] == "sess-enqueue"
    assert envelope["source"] == "claude"
    assert envelope["event_type"] == "claude.hook"
    assert envelope["started_at"] == "2026-03-04T01:00:00Z"
    assert envelope["payload"]["_adapter"]["event_type"] == "session_start"
    assert envelope["ts_wall_ms"] == 1772586000000


def test_build_raw_event_envelope_prefers_codemem_project_env(monkeypatch) -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-env-project",
        "prompt": "ship it",
        "cwd": "/tmp/repo",
        "project": "payload-project",
        "ts": "2026-03-04T01:00:00Z",
    }
    monkeypatch.setenv("CODEMEM_PROJECT", "env-project")

    envelope = build_raw_event_envelope_from_hook(payload)

    assert envelope is not None
    assert envelope["project"] == "env-project"


def test_build_raw_event_envelope_infers_project_from_cwd(tmp_path, monkeypatch) -> None:
    repo_root = tmp_path / "codemem-main"
    repo_root.mkdir()
    (repo_root / ".git").mkdir()
    cwd = repo_root / "subdir"
    cwd.mkdir()

    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-cwd-project",
        "prompt": "ship it",
        "cwd": str(cwd),
        "ts": "2026-03-04T01:00:00Z",
    }
    monkeypatch.delenv("CODEMEM_PROJECT", raising=False)

    envelope = build_raw_event_envelope_from_hook(payload)

    assert envelope is not None
    assert envelope["project"] == "codemem-main"


def test_build_raw_event_envelope_prefers_cwd_project_over_payload_project(
    tmp_path, monkeypatch
) -> None:
    repo_root = tmp_path / "codemem"
    repo_root.mkdir()
    (repo_root / ".git").mkdir()
    cwd = repo_root / "pkg"
    cwd.mkdir()

    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-cwd-over-payload",
        "prompt": "ship it",
        "cwd": str(cwd),
        "project": "main",
        "ts": "2026-03-04T01:00:00Z",
    }
    monkeypatch.delenv("CODEMEM_PROJECT", raising=False)

    envelope = build_raw_event_envelope_from_hook(payload)

    assert envelope is not None
    assert envelope["project"] == "codemem"


def test_build_raw_event_envelope_uses_payload_project_without_cwd(monkeypatch) -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-payload-project",
        "prompt": "ship it",
        "project": "payload-project",
        "ts": "2026-03-04T01:00:00Z",
    }
    monkeypatch.delenv("CODEMEM_PROJECT", raising=False)

    envelope = build_raw_event_envelope_from_hook(payload)

    assert envelope is not None
    assert envelope["project"] == "payload-project"


def test_build_raw_event_envelope_invalid_cwd_falls_back_to_payload_project(monkeypatch) -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-invalid-cwd",
        "prompt": "ship it",
        "cwd": "/tmp/does-not-exist/codemem",
        "project": "payload-project",
        "ts": "2026-03-04T01:00:00Z",
    }
    monkeypatch.delenv("CODEMEM_PROJECT", raising=False)

    envelope = build_raw_event_envelope_from_hook(payload)

    assert envelope is not None
    assert envelope["project"] == "payload-project"


def test_map_stop_hook_uses_transcript_fallback_for_assistant_text(tmp_path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    transcript_path.write_text(
        '{"message":{"role":"assistant","content":"assistant from transcript"}}\n',
        encoding="utf-8",
    )
    payload = {
        "hook_event_name": "Stop",
        "session_id": "sess-stop",
        "last_assistant_message": "",
        "transcript_path": str(transcript_path),
    }

    event = map_claude_hook_payload(payload)

    assert event is not None
    assert event["event_type"] == "assistant"
    assert event["payload"]["text"] == "assistant from transcript"


def test_map_stop_hook_includes_usage_from_hook_payload() -> None:
    payload = {
        "hook_event_name": "Stop",
        "session_id": "sess-stop-usage",
        "last_assistant_message": "done",
        "usage": {
            "input_tokens": 10,
            "output_tokens": 4,
            "cache_creation_input_tokens": 2,
            "cache_read_input_tokens": 1,
        },
    }

    event = map_claude_hook_payload(payload)

    assert event is not None
    assert event["event_type"] == "assistant"
    assert event["payload"]["usage"]["input_tokens"] == 10
    assert event["payload"]["usage"]["output_tokens"] == 4


def test_map_stop_hook_transcript_usage_is_tied_to_latest_assistant_text(tmp_path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    transcript_path.write_text(
        "\n".join(
            [
                '{"message":{"role":"assistant","content":"first reply"},"usage":{"input_tokens":30,"output_tokens":8,"cache_creation_input_tokens":2,"cache_read_input_tokens":1}}',
                '{"message":{"role":"assistant","content":"latest reply"}}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    event = map_claude_hook_payload(
        {
            "hook_event_name": "Stop",
            "session_id": "sess-stop-transcript",
            "last_assistant_message": "",
            "transcript_path": str(transcript_path),
            "ts": "2026-03-04T01:00:00Z",
        }
    )

    assert event is not None
    assert event["payload"]["text"] == "latest reply"
    assert "usage" not in event["payload"]


def test_map_stop_hook_event_id_stable_across_transcript_content_changes(tmp_path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    transcript_path.write_text(
        '{"message":{"role":"assistant","content":"first reply"}}\n',
        encoding="utf-8",
    )
    payload = {
        "hook_event_name": "Stop",
        "session_id": "sess-stop-stable",
        "last_assistant_message": "",
        "transcript_path": str(transcript_path),
        "ts": "2026-03-04T01:00:00Z",
    }

    first = map_claude_hook_payload(payload)

    transcript_path.write_text(
        '{"message":{"role":"assistant","content":"second reply"},"usage":{"input_tokens":7,"output_tokens":3,"cache_creation_input_tokens":1,"cache_read_input_tokens":0}}\n',
        encoding="utf-8",
    )
    second = map_claude_hook_payload(payload)

    assert first is not None
    assert second is not None
    assert first["payload"]["text"] != second["payload"]["text"]
    assert first["event_id"] == second["event_id"]
