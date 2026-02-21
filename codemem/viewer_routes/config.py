from __future__ import annotations

import json
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


def handle_get(
    handler: _ViewerHandler,
    *,
    path: str,
    load_provider_options: callable,
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
    load_provider_options: callable,
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
        "observer_provider",
        "observer_model",
        "observer_max_chars",
        "pack_observation_limit",
        "pack_session_limit",
        "sync_enabled",
        "sync_host",
        "sync_port",
        "sync_interval_s",
        "sync_mdns",
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
        if key == "observer_max_chars":
            try:
                value = int(value)
            except (TypeError, ValueError):
                handler._send_json({"error": "observer_max_chars must be int"}, status=400)
                return True
            if value <= 0:
                handler._send_json({"error": "observer_max_chars must be positive"}, status=400)
                return True
            config_data[key] = value
            continue
        if key in {"pack_observation_limit", "pack_session_limit"}:
            try:
                value = int(value)
            except (TypeError, ValueError):
                handler._send_json({"error": f"{key} must be int"}, status=400)
                return True
            if value <= 0:
                handler._send_json({"error": f"{key} must be positive"}, status=400)
                return True
            config_data[key] = value
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
            try:
                value = int(value)
            except (TypeError, ValueError):
                handler._send_json({"error": f"{key} must be int"}, status=400)
                return True
            if value <= 0:
                handler._send_json({"error": f"{key} must be positive"}, status=400)
                return True
            config_data[key] = value
            continue

    try:
        write_config_file(config_data, config_path)
    except OSError:
        handler._send_json({"error": "failed to write config"}, status=500)
        return True
    handler._send_json({"path": str(config_path), "config": config_data})
    return True
