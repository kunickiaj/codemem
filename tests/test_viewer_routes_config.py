from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

from codemem.config import read_config_file
from codemem.viewer_routes import config as viewer_config


class DummyHandler:
    def __init__(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.headers = {"Content-Length": str(len(body))}
        self.rfile = io.BytesIO(body)
        self.response: dict[str, Any] | None = None
        self.status: int | None = None

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        self.response = payload
        self.status = status


def test_config_route_accepts_observer_auth_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler(
        {
            "claude_command": ["wrapper", "claude", "--"],
            "observer_provider": "openai",
            "observer_runtime": "api_http",
            "observer_auth_source": "command",
            "observer_auth_command": ["iap-auth"],
            "observer_auth_timeout_ms": 2000,
            "observer_auth_cache_ttl_s": 60,
            "observer_headers": {"Authorization": "Bearer ${auth.token}"},
            "raw_events_sweeper_interval_s": 45,
        }
    )

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    assert handler.response is not None
    effects = handler.response["effects"]
    assert "observer_auth_source" in effects["hot_reloaded_keys"]
    assert effects["sync"]["action"] is None
    saved = read_config_file(config_path)
    assert saved["claude_command"] == ["wrapper", "claude", "--"]
    assert saved["observer_auth_source"] == "command"
    assert saved["observer_auth_command"] == ["iap-auth"]
    assert saved["observer_auth_timeout_ms"] == 2000
    assert saved["observer_auth_cache_ttl_s"] == 60
    assert saved["observer_headers"] == {"Authorization": "Bearer ${auth.token}"}
    assert saved["raw_events_sweeper_interval_s"] == 45


def test_config_route_accepts_sync_coordinator_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler(
        {
            "sync_coordinator_url": "https://coord.example.workers.dev",
            "sync_coordinator_group": "nerdworld",
            "sync_coordinator_timeout_s": 5,
            "sync_coordinator_presence_ttl_s": 240,
        }
    )

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    saved = read_config_file(config_path)
    assert saved["sync_coordinator_url"] == "https://coord.example.workers.dev"
    assert saved["sync_coordinator_group"] == "nerdworld"
    assert saved["sync_coordinator_timeout_s"] == 5
    assert saved["sync_coordinator_presence_ttl_s"] == 240


def test_config_route_rejects_invalid_sync_coordinator_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler({"sync_coordinator_timeout_s": "abc"})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "sync_coordinator_timeout_s must be int"}


def test_config_route_rejects_fractional_sync_coordinator_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler({"sync_coordinator_timeout_s": 1.9})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "sync_coordinator_timeout_s must be int"}


def test_config_route_preserves_observer_auth_command_exactly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    command = ["iap-auth", "--audience", " gateway ", ""]
    handler = DummyHandler(
        {
            "observer_auth_source": "command",
            "observer_auth_command": command,
        }
    )

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    saved = read_config_file(config_path)
    assert saved["observer_auth_command"] == command


def test_config_route_rejects_invalid_observer_auth_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler(
        {
            "observer_auth_source": "command",
            "observer_auth_command": "iap-auth",
        }
    )

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "observer_auth_command must be string array"}


def test_config_route_rejects_invalid_claude_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler({"claude_command": "wrapper claude"})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "claude_command must be string array"}


def test_config_route_rejects_claude_command_with_empty_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler({"claude_command": ["wrapper", " ", "--"]})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "claude_command must be string array"}


def test_config_route_clears_claude_command_with_empty_array(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"claude_command": ["wrapper", "claude", "--"]}\n')
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler({"claude_command": []})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    saved = read_config_file(config_path)
    assert "claude_command" not in saved


def test_config_route_rejects_invalid_observer_headers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler(
        {
            "observer_headers": {"Authorization": 123},
        }
    )

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "observer_headers must be object of string values"}


def test_config_route_accepts_custom_provider_with_observer_base_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler(
        {
            "observer_provider": "gateway",
            "observer_base_url": "https://gateway.example/v1",
        }
    )

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    saved = read_config_file(config_path)
    assert saved["observer_provider"] == "gateway"
    assert saved["observer_base_url"] == "https://gateway.example/v1"


def test_config_route_rejects_unknown_provider_without_observer_base_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler({"observer_provider": "gateway"})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "observer_provider must match a configured provider"}


def test_config_route_rejects_unknown_provider_when_base_url_cleared_in_same_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "observer_provider": "gateway",
                "observer_base_url": "https://gateway.example/v1",
            }
        )
        + "\n"
    )
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler(
        {
            "observer_provider": "another-gateway",
            "observer_base_url": "",
        }
    )

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "observer_provider must match a configured provider"}


def test_config_route_rejects_invalid_raw_events_sweeper_interval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    handler = DummyHandler({"raw_events_sweeper_interval_s": 0})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "raw_events_sweeper_interval_s must be int"}


def test_config_route_hot_reloads_runtime_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    invalidated: list[str] = []
    notified: list[str] = []
    reset_calls: list[str] = []
    monkeypatch.setattr(
        viewer_config, "invalidate_runtime_state", lambda: invalidated.append("runtime")
    )
    monkeypatch.setattr(
        viewer_config.RAW_EVENT_SWEEPER,
        "notify_config_changed",
        lambda: notified.append("sweeper"),
    )
    monkeypatch.setattr(
        viewer_config.RAW_EVENT_SWEEPER,
        "reset_auth_backoff",
        lambda: reset_calls.append("reset"),
    )

    handler = DummyHandler(
        {
            "observer_runtime": "claude_sidecar",
            "raw_events_sweeper_interval_s": 15,
            "pack_observation_limit": 25,
        }
    )

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    assert invalidated == ["runtime"]
    assert notified == ["sweeper"]
    assert reset_calls == ["reset"]
    assert handler.response is not None
    effects = handler.response["effects"]
    assert sorted(effects["hot_reloaded_keys"]) == [
        "observer_runtime",
        "raw_events_sweeper_interval_s",
    ]
    assert effects["live_applied_keys"] == ["pack_observation_limit"]


def test_config_route_warns_when_env_override_blocks_effective_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_OBSERVER_RUNTIME", "api_http")
    invalidated: list[str] = []
    monkeypatch.setattr(
        viewer_config, "invalidate_runtime_state", lambda: invalidated.append("runtime")
    )

    handler = DummyHandler({"observer_runtime": "claude_sidecar"})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    assert invalidated == []
    assert handler.response is not None
    effects = handler.response["effects"]
    assert effects["hot_reloaded_keys"] == []
    assert effects["ignored_by_env_keys"] == ["observer_runtime"]
    assert effects["warnings"]


def test_config_route_auto_starts_sync_when_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"sync_enabled": false, "sync_interval_s": 60}\n')
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    applied: list[str] = []

    def _apply(action: str, *, effective_config: dict[str, Any]) -> dict[str, Any]:
        applied.append(action)
        return {
            "attempted": True,
            "ok": True,
            "message": f"sync {action} ok",
            "manual_action": None,
        }

    monkeypatch.setattr(viewer_config, "_apply_sync_runtime_action", _apply)

    handler = DummyHandler({"sync_enabled": True})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    assert applied == ["start"]
    assert handler.response is not None
    sync_effect = handler.response["effects"]["sync"]
    assert sync_effect["action"] == "start"
    assert sync_effect["ok"] is True


def test_config_route_auto_stops_sync_when_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"sync_enabled": true, "sync_interval_s": 60}\n')
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    applied: list[str] = []

    def _apply(action: str, *, effective_config: dict[str, Any]) -> dict[str, Any]:
        applied.append(action)
        return {
            "attempted": True,
            "ok": True,
            "message": f"sync {action} ok",
            "manual_action": None,
        }

    monkeypatch.setattr(viewer_config, "_apply_sync_runtime_action", _apply)

    handler = DummyHandler({"sync_enabled": False})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    assert applied == ["stop"]
    assert handler.response is not None
    sync_effect = handler.response["effects"]["sync"]
    assert sync_effect["action"] == "stop"
    assert sync_effect["ok"] is True


def test_config_route_auto_restarts_sync_when_runtime_settings_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"sync_enabled": true, "sync_interval_s": 60}\n')
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    applied: list[str] = []

    def _apply(action: str, *, effective_config: dict[str, Any]) -> dict[str, Any]:
        applied.append(action)
        return {
            "attempted": True,
            "ok": True,
            "message": f"sync {action} ok",
            "manual_action": None,
        }

    monkeypatch.setattr(viewer_config, "_apply_sync_runtime_action", _apply)

    handler = DummyHandler({"sync_interval_s": 90})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    assert applied == ["restart"]
    assert handler.response is not None
    sync_effect = handler.response["effects"]["sync"]
    assert sync_effect["action"] == "restart"
    assert sync_effect["ok"] is True


def test_config_route_reports_manual_sync_action_when_auto_apply_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"sync_enabled": true, "sync_interval_s": 60}\n')
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))

    monkeypatch.setattr(
        viewer_config,
        "_apply_sync_runtime_action",
        lambda action, *, effective_config: {
            "attempted": True,
            "ok": False,
            "message": "sync restart failed",
            "manual_action": {
                "kind": "sync",
                "command": "uv run codemem sync restart",
                "label": "Run `codemem sync restart`",
                "reason": "sync restart failed",
            },
        },
    )

    handler = DummyHandler({"sync_interval_s": 90})

    handled = viewer_config.handle_post(
        handler,
        path="/api/config",
        load_provider_options=lambda: ["openai", "anthropic"],
    )

    assert handled is True
    assert handler.status == 200
    assert handler.response is not None
    sync_effect = handler.response["effects"]["sync"]
    assert sync_effect["action"] == "restart"
    assert sync_effect["ok"] is False
    assert handler.response["effects"]["manual_actions"] == [
        {
            "kind": "sync",
            "command": "uv run codemem sync restart",
            "label": "Run `codemem sync restart`",
            "reason": "sync restart failed",
        }
    ]


def test_sync_stop_does_not_report_success_when_pidfile_missing_but_daemon_still_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(viewer_config, "run_service_action_quiet", lambda *args, **kwargs: False)
    monkeypatch.setattr(
        viewer_config,
        "stop_pidfile_with_reason",
        lambda: type("Result", (), {"stopped": False, "reason": "pidfile_missing"})(),
    )
    monkeypatch.setattr(
        viewer_config,
        "effective_status",
        lambda host, port: type("Status", (), {"running": True, "mechanism": "port"})(),
    )

    ok, message = viewer_config._sync_stop(host="127.0.0.1", port=7337)

    assert ok is False
    assert message == "failed to stop sync daemon (pidfile_missing)"
