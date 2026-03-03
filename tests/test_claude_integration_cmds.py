from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import patch

from codemem.commands.claude_integration_cmds import (
    ALLOWED_HOOK_EVENTS,
    _adapter_stream_id,
    _build_install_report,
    _load_json_or_empty,
    _merge_enabled_plugins,
    _queue_adapter_event,
    ingest_claude_hook_cmd,
    install_claude_integration_cmd,
)


def test_merge_enabled_plugins_preserves_existing_entries() -> None:
    settings = {
        "enabledPlugins": ["./plugins/existing"],
        "other": {"x": 1},
    }

    merged = _merge_enabled_plugins(settings, "./plugins/codemem")

    assert merged["enabledPlugins"] == ["./plugins/existing", "./plugins/codemem"]
    assert merged["other"] == {"x": 1}


def test_build_install_report_shape() -> None:
    report = _build_install_report(
        plugin_dir=Path("/tmp/.claude/plugins/codemem"),
        settings_path=Path("/tmp/.claude/settings.json"),
        plugin_ref="./plugins/codemem",
    )

    assert set(report.keys()) == {
        "plugin_dir",
        "settings_path",
        "enabled_plugin",
        "hook_entrypoint",
    }
    assert report["enabled_plugin"] == "./plugins/codemem"


def test_install_claude_integration_writes_plugin_and_settings(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "source"
    (source / ".claude-plugin").mkdir(parents=True)
    (source / "hooks").mkdir(parents=True)
    (source / "scripts").mkdir(parents=True)
    (source / ".claude-plugin" / "plugin.json").write_text('{"name":"codemem"}\n')
    (source / "hooks" / "hooks.json").write_text('{"hooks":{}}\n')
    (source / "scripts" / "ingest-hook.sh").write_text("#!/usr/bin/env bash\n")

    monkeypatch.setattr(
        "codemem.commands.claude_integration_cmds._resolve_claude_plugin_source",
        lambda: source,
    )

    report = install_claude_integration_cmd(force=False, cwd=tmp_path)

    assert report["enabled_plugin"] == "./plugins/codemem"
    installed_plugin = (
        tmp_path / ".claude" / "plugins" / "codemem" / ".claude-plugin" / "plugin.json"
    )
    settings_path = tmp_path / ".claude" / "settings.json"
    assert installed_plugin.exists()
    assert settings_path.exists()
    assert "./plugins/codemem" in settings_path.read_text()


def test_load_json_or_empty_rejects_non_object(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text("[]\n")

    try:
        _load_json_or_empty(path)
    except ValueError as exc:
        assert "JSON object" in str(exc)
    else:
        raise AssertionError("Expected ValueError for non-object JSON")


def test_ingest_claude_hook_cmd_skips_pre_tool_use_hook() -> None:
    payload = {
        "hook_event_name": "PreToolUse",
        "session_id": "sess-1",
        "tool_name": "Bash",
        "tool_input": {"command": "echo hi"},
    }
    called = {"count": 0}

    def _fake_ingest(_: object) -> None:
        called["count"] += 1

    with (
        patch("sys.stdin", io.StringIO(json.dumps(payload))),
        patch("codemem.commands.claude_integration_cmds.MemoryStore", side_effect=AssertionError),
    ):
        ingest_claude_hook_cmd()

    assert called["count"] == 0


def test_ingest_claude_hook_cmd_processes_stop_hook() -> None:
    payload = {
        "hook_event_name": "Stop",
        "session_id": "sess-1",
        "last_assistant_message": "Done",
    }
    called = {"count": 0}

    class _FakeStore:
        def __init__(self, _: object) -> None:
            pass

        def record_raw_event(self, **kwargs: object) -> bool:
            called["count"] += 1
            assert kwargs["event_type"] == "claude.hook"
            return True

        def update_raw_event_session_meta(self, **_: object) -> None:
            return None

        def close(self) -> None:
            return None

    def _fake_flush(*_: object, **__: object) -> dict[str, int]:
        called["count"] += 1
        return {"flushed": 1, "updated_state": 1}

    with (
        patch("sys.stdin", io.StringIO(json.dumps(payload))),
        patch("codemem.commands.claude_integration_cmds.MemoryStore", _FakeStore),
        patch("codemem.commands.claude_integration_cmds.flush_raw_events", _fake_flush),
    ):
        ingest_claude_hook_cmd()

    assert called["count"] == 2


def test_ingest_claude_hook_cmd_flushes_stop_hook_when_assistant_text_missing() -> None:
    payload = {
        "hook_event_name": "Stop",
        "session_id": "sess-1",
        "source": "startup",
    }
    called = {"record": 0, "flush": 0}

    class _FakeStore:
        def __init__(self, _: object) -> None:
            pass

        def record_raw_event(self, **_: object) -> bool:
            called["record"] += 1
            return True

        def update_raw_event_session_meta(self, **_: object) -> None:
            return None

        def close(self) -> None:
            return None

    def _fake_flush(*_: object, **kwargs: object) -> dict[str, int]:
        called["flush"] += 1
        assert kwargs["opencode_session_id"] == "sess-1"
        return {"flushed": 0, "updated_state": 0}

    with (
        patch("sys.stdin", io.StringIO(json.dumps(payload))),
        patch("codemem.commands.claude_integration_cmds.MemoryStore", _FakeStore),
        patch("codemem.commands.claude_integration_cmds.flush_raw_events", _fake_flush),
    ):
        ingest_claude_hook_cmd()

    assert called["record"] == 0
    assert called["flush"] == 1


def test_ingest_claude_hook_cmd_noops_on_invalid_json() -> None:
    called = {"count": 0}

    with (
        patch("sys.stdin", io.StringIO("{not-json")),
        patch("codemem.commands.claude_integration_cmds.MemoryStore", side_effect=AssertionError),
    ):
        ingest_claude_hook_cmd()

    assert called["count"] == 0


def test_ingest_claude_hook_cmd_noops_on_non_object_payload() -> None:
    called = {"count": 0}

    with (
        patch("sys.stdin", io.StringIO("[]")),
        patch("codemem.commands.claude_integration_cmds.MemoryStore", side_effect=AssertionError),
    ):
        ingest_claude_hook_cmd()

    assert called["count"] == 0


def test_ingest_claude_hook_cmd_skips_unmappable_hook() -> None:
    called = {"count": 0}
    payload = {
        "hook_event_name": "NotMapped",
        "session_id": "sess-1",
    }

    def _fake_ingest(_: object) -> None:
        called["count"] += 1

    with (
        patch("sys.stdin", io.StringIO(json.dumps(payload))),
        patch("codemem.commands.claude_integration_cmds.MemoryStore", side_effect=AssertionError),
    ):
        ingest_claude_hook_cmd()

    assert called["count"] == 0


def test_hooks_template_matches_allowlist_events() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    hooks_path = repo_root / ".claude" / "plugin" / "codemem" / "hooks" / "hooks.json"
    hooks_payload = json.loads(hooks_path.read_text())

    assert set(hooks_payload["hooks"].keys()) == ALLOWED_HOOK_EVENTS


def test_adapter_stream_id_uses_source_and_session_only() -> None:
    stream_id = _adapter_stream_id(session_id="sess-1")
    assert stream_id == "sess-1"


def test_queue_adapter_event_writes_claude_hook_payload() -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-queue",
        "prompt": "hello",
        "cwd": "/tmp/worktree-a",
    }

    calls: dict[str, object] = {}

    class _FakeStore:
        def record_raw_event(self, **kwargs: object) -> bool:
            calls["record"] = kwargs
            return True

        def update_raw_event_session_meta(self, **kwargs: object) -> None:
            calls["meta"] = kwargs

    queued = _queue_adapter_event(payload, store=_FakeStore())

    assert queued is not None
    stream_id, inserted = queued
    assert inserted is True
    assert stream_id == "sess-queue"
    record = calls["record"]
    assert isinstance(record, dict)
    assert record["event_type"] == "claude.hook"


def test_queue_adapter_event_strips_private_tags_from_payload() -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-redact",
        "prompt": "before <private>secret</private> after",
        "tool_input": {"note": "x<private>hidden</private>y"},
        "cwd": "/tmp/worktree-a",
    }

    calls: dict[str, object] = {}

    class _FakeStore:
        def record_raw_event(self, **kwargs: object) -> bool:
            calls["record"] = kwargs
            return True

        def update_raw_event_session_meta(self, **kwargs: object) -> None:
            calls["meta"] = kwargs

    queued = _queue_adapter_event(payload, store=_FakeStore())

    assert queued is not None
    record = calls["record"]
    assert isinstance(record, dict)
    stored_payload = json.dumps(record["payload"], sort_keys=True)
    assert "<private>" not in stored_payload
    assert "secret" not in stored_payload
    assert "hidden" not in stored_payload
