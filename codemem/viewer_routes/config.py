from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import asdict
from typing import Any, Protocol

from ..config import (
    OpencodeMemConfig,
    get_config_path,
    get_env_overrides,
    load_config,
    read_config_file,
    write_config_file,
)


class _ViewerHandler(Protocol):
    headers: Any
    rfile: Any

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None: ...


_RUNTIMES = {"api_http", "claude_sidecar"}
_AUTH_SOURCES = {"auto", "env", "file", "command", "none"}


def _as_positive_int(value: Any, *, key: str, allow_zero: bool = False) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if allow_zero:
        return parsed if parsed >= 0 else None
    return parsed if parsed > 0 else None


def _as_string_map(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    parsed: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            return None
        stripped = key.strip()
        if not stripped:
            return None
        parsed[stripped] = item
    return parsed


def _as_command_argv(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    if any(not isinstance(item, str) for item in value):
        return None
    return list(value)


def _as_executable_argv(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return None
        token = item.strip()
        if not token:
            return None
        normalized.append(token)
    return normalized


def handle_get(
    handler: _ViewerHandler,
    *,
    path: str,
    load_provider_options: Callable[[], list[str]],
) -> bool:
    if path != "/api/config":
        return False

    config_path = get_config_path()
    try:
        config_data = read_config_file(config_path)
    except ValueError:
        handler._send_json({"error": "config file could not be read"}, status=500)
        return True
    effective = asdict(load_config(config_path))
    handler._send_json(
        {
            "path": str(config_path),
            "config": config_data,
            "defaults": asdict(OpencodeMemConfig()),
            "effective": effective,
            "env_overrides": get_env_overrides(),
            "providers": load_provider_options(),
        }
    )
    return True


def handle_post(
    handler: _ViewerHandler,
    *,
    path: str,
    load_provider_options: Callable[[], list[str]],
) -> bool:
    if path != "/api/config":
        return False

    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length).decode("utf-8") if length else ""
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        handler._send_json({"error": "invalid json"}, status=400)
        return True
    if not isinstance(payload, dict):
        handler._send_json({"error": "payload must be an object"}, status=400)
        return True
    updates = payload.get("config") if "config" in payload else payload
    if not isinstance(updates, dict):
        handler._send_json({"error": "config must be an object"}, status=400)
        return True

    allowed_keys = {
        "claude_command",
        "observer_provider",
        "observer_model",
        "observer_runtime",
        "observer_auth_source",
        "observer_auth_file",
        "observer_auth_command",
        "observer_auth_timeout_ms",
        "observer_auth_cache_ttl_s",
        "observer_headers",
        "observer_max_chars",
        "pack_observation_limit",
        "pack_session_limit",
        "sync_enabled",
        "sync_host",
        "sync_port",
        "sync_interval_s",
        "sync_mdns",
        "raw_events_sweeper_interval_s",
    }
    allowed_providers = set(load_provider_options())

    config_path = get_config_path()
    try:
        config_data = read_config_file(config_path)
    except ValueError:
        handler._send_json({"error": "config file could not be read"}, status=500)
        return True

    for key in allowed_keys:
        if key not in updates:
            continue
        value = updates[key]
        if value in (None, ""):
            config_data.pop(key, None)
            continue
        if key == "observer_provider":
            if not isinstance(value, str):
                handler._send_json({"error": "observer_provider must be string"}, status=400)
                return True
            provider = value.strip().lower()
            if provider not in allowed_providers:
                handler._send_json(
                    {"error": "observer_provider must match a configured provider"},
                    status=400,
                )
                return True
            config_data[key] = provider
            continue
        if key == "claude_command":
            argv = _as_executable_argv(value)
            if argv is None:
                handler._send_json({"error": "claude_command must be string array"}, status=400)
                return True
            if argv:
                config_data[key] = argv
            else:
                config_data.pop(key, None)
            continue
        if key == "observer_model":
            if not isinstance(value, str):
                handler._send_json({"error": "observer_model must be string"}, status=400)
                return True
            model_value = value.strip()
            if not model_value:
                config_data.pop(key, None)
                continue
            config_data[key] = model_value
            continue
        if key == "observer_runtime":
            if not isinstance(value, str):
                handler._send_json({"error": "observer_runtime must be string"}, status=400)
                return True
            runtime = value.strip().lower()
            if runtime not in _RUNTIMES:
                handler._send_json(
                    {"error": "observer_runtime must be one of: api_http, claude_sidecar"},
                    status=400,
                )
                return True
            config_data[key] = runtime
            continue
        if key == "observer_auth_source":
            if not isinstance(value, str):
                handler._send_json({"error": "observer_auth_source must be string"}, status=400)
                return True
            source = value.strip().lower()
            if source not in _AUTH_SOURCES:
                handler._send_json(
                    {
                        "error": "observer_auth_source must be one of: auto, env, file, command, none"
                    },
                    status=400,
                )
                return True
            config_data[key] = source
            continue
        if key == "observer_auth_file":
            if not isinstance(value, str):
                handler._send_json({"error": "observer_auth_file must be string"}, status=400)
                return True
            file_path = value.strip()
            if not file_path:
                config_data.pop(key, None)
                continue
            config_data[key] = file_path
            continue
        if key == "observer_auth_command":
            argv = _as_command_argv(value)
            if argv is None:
                handler._send_json(
                    {"error": "observer_auth_command must be string array"}, status=400
                )
                return True
            if argv:
                config_data[key] = argv
            else:
                config_data.pop(key, None)
            continue
        if key == "observer_headers":
            headers = _as_string_map(value)
            if headers is None:
                handler._send_json(
                    {"error": "observer_headers must be object of string values"}, status=400
                )
                return True
            if headers:
                config_data[key] = headers
            else:
                config_data.pop(key, None)
            continue
        if key == "observer_auth_timeout_ms":
            timeout_ms = _as_positive_int(value, key=key)
            if timeout_ms is None:
                handler._send_json(
                    {"error": "observer_auth_timeout_ms must be positive int"}, status=400
                )
                return True
            config_data[key] = timeout_ms
            continue
        if key == "observer_auth_cache_ttl_s":
            ttl_s = _as_positive_int(value, key=key, allow_zero=True)
            if ttl_s is None:
                handler._send_json(
                    {"error": "observer_auth_cache_ttl_s must be non-negative int"},
                    status=400,
                )
                return True
            config_data[key] = ttl_s
            continue
        if key == "observer_max_chars":
            parsed = _as_positive_int(value, key=key)
            if parsed is None:
                handler._send_json({"error": "observer_max_chars must be int"}, status=400)
                return True
            config_data[key] = parsed
            continue
        if key in {"pack_observation_limit", "pack_session_limit"}:
            parsed = _as_positive_int(value, key=key)
            if parsed is None:
                handler._send_json({"error": f"{key} must be int"}, status=400)
                return True
            config_data[key] = parsed
            continue
        if key in {"sync_enabled", "sync_mdns"}:
            if not isinstance(value, bool):
                handler._send_json({"error": f"{key} must be boolean"}, status=400)
                return True
            config_data[key] = value
            continue
        if key == "sync_host":
            if not isinstance(value, str):
                handler._send_json({"error": "sync_host must be string"}, status=400)
                return True
            host_value = value.strip()
            if not host_value:
                config_data.pop(key, None)
                continue
            config_data[key] = host_value
            continue
        if key in {"sync_port", "sync_interval_s"}:
            parsed = _as_positive_int(value, key=key)
            if parsed is None:
                handler._send_json({"error": f"{key} must be int"}, status=400)
                return True
            config_data[key] = parsed
            continue
        if key == "raw_events_sweeper_interval_s":
            parsed = _as_positive_int(value, key=key)
            if parsed is None:
                handler._send_json(
                    {"error": "raw_events_sweeper_interval_s must be int"}, status=400
                )
                return True
            config_data[key] = parsed
            continue

    try:
        write_config_file(config_data, config_path)
    except OSError:
        handler._send_json({"error": "failed to write config"}, status=500)
        return True
    handler._send_json({"path": str(config_path), "config": config_data})
    return True
