from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import patch

from codemem import __version__
from codemem.commands.claude_integration_cmds import (
    ALLOWED_HOOK_EVENTS,
    _adapter_stream_id,
    _queue_adapter_event,
    ingest_claude_hook_cmd,
)


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


def test_ingest_claude_hook_cmd_processes_stop_hook_without_default_flush() -> None:
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

    assert called["count"] == 1


def test_ingest_claude_hook_cmd_does_not_flush_session_end_by_default() -> None:
    payload = {
        "hook_event_name": "SessionEnd",
        "session_id": "sess-1",
        "stop_reason": "end_turn",
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

    assert called["count"] == 1


def test_ingest_claude_hook_cmd_flushes_session_end_when_enabled() -> None:
    payload = {
        "hook_event_name": "SessionEnd",
        "session_id": "sess-1",
        "stop_reason": "end_turn",
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
        patch.dict("os.environ", {"CODEMEM_CLAUDE_HOOK_FLUSH": "1"}, clear=False),
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
        patch.dict(
            "os.environ",
            {
                "CODEMEM_CLAUDE_HOOK_FLUSH": "1",
                "CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP": "1",
            },
            clear=False,
        ),
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
    hooks_path = repo_root / "plugins" / "claude" / "hooks" / "hooks.json"
    hooks_payload = json.loads(hooks_path.read_text())

    assert set(hooks_payload["hooks"].keys()) == ALLOWED_HOOK_EVENTS
    user_prompt_hooks = hooks_payload["hooks"]["UserPromptSubmit"]
    assert user_prompt_hooks[0]["hooks"][0]["command"] == (
        "${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-hook.sh"
    )


def test_claude_plugin_manifest_version_matches_package_version() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    plugin_manifest_path = repo_root / "plugins" / "claude" / ".claude-plugin" / "plugin.json"
    plugin_manifest = json.loads(plugin_manifest_path.read_text())

    assert plugin_manifest["name"] == "codemem"
    assert plugin_manifest["version"] == __version__
    assert plugin_manifest["description"].startswith("Persistent memory for Claude Code")
    assert "hooks" not in plugin_manifest
    mcp_servers = plugin_manifest["mcpServers"]
    codemem_mcp = mcp_servers["codemem"]
    assert codemem_mcp["command"] == "uvx"
    assert codemem_mcp["args"] == [f"codemem=={__version__}", "mcp"]


def test_marketplace_manifest_points_to_codemem_plugin() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    marketplace_path = repo_root / ".claude-plugin" / "marketplace.json"
    marketplace = json.loads(marketplace_path.read_text())

    assert marketplace["name"] == "codemem-marketplace"
    plugins = marketplace["plugins"]
    assert isinstance(plugins, list)
    assert len(plugins) == 1
    codemem_plugin = plugins[0]
    assert codemem_plugin["name"] == "codemem"
    assert codemem_plugin["source"] == "./plugins/claude"
    assert codemem_plugin["version"] == __version__
    assert codemem_plugin["description"].startswith("Persistent memory for Claude Code")

    resolved_plugin_path = repo_root / codemem_plugin["source"]
    assert resolved_plugin_path.exists()


def test_claude_hook_script_has_version_pinned_uvx_fallback() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    hook_script_path = repo_root / "plugins" / "claude" / "scripts" / "ingest-hook.sh"
    hook_script = hook_script_path.read_text()

    assert 'UVX_PACKAGE_SPEC="codemem"' in hook_script
    assert 'UVX_PACKAGE_SPEC="codemem==${PLUGIN_VERSION}"' in hook_script
    assert "codemem claude-hook-ingest" in hook_script
    assert 'uvx "${UVX_PACKAGE_SPEC}" claude-hook-ingest' in hook_script
    assert "CODEMEM_PLUGIN_IGNORE=1" not in hook_script
    assert "CODEMEM_HOOK_ALLOW_UVX" not in hook_script


def test_user_prompt_hook_script_runs_ingest_and_inject() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    hook_script_path = repo_root / "plugins" / "claude" / "scripts" / "user-prompt-hook.sh"
    hook_script = hook_script_path.read_text()

    assert '"${SCRIPT_DIR}/ingest-hook.sh"' in hook_script
    assert '"${SCRIPT_DIR}/inject-context-hook.sh"' in hook_script
    assert "mktemp" in hook_script
    assert "nohup bash -c" in hook_script
    assert '{"continue":true}' in hook_script


def test_inject_context_hook_script_returns_additional_context_payload() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    hook_script_path = repo_root / "plugins" / "claude" / "scripts" / "inject-context-hook.sh"
    hook_script = hook_script_path.read_text()

    assert "codemem claude-hook-inject" in hook_script
    assert "CODEMEM_INJECT_ALLOW_UVX:-0" in hook_script
    assert 'uvx "${UVX_PACKAGE_SPEC}" claude-hook-inject' in hook_script
    assert "CODEMEM_PLUGIN_IGNORE=1" not in hook_script
    assert '{"continue":true}' in hook_script


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
