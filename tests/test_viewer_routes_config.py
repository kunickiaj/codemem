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
    saved = read_config_file(config_path)
    assert saved["claude_command"] == ["wrapper", "claude", "--"]
    assert saved["observer_auth_source"] == "command"
    assert saved["observer_auth_command"] == ["iap-auth"]
    assert saved["observer_auth_timeout_ms"] == 2000
    assert saved["observer_auth_cache_ttl_s"] == 60
    assert saved["observer_headers"] == {"Authorization": "Bearer ${auth.token}"}
    assert saved["raw_events_sweeper_interval_s"] == 45


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
