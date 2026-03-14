from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import asdict
from typing import Any, Protocol

from ..commands.sync_service_cmds import run_service_action_quiet
from ..config import (
    CONFIG_ENV_OVERRIDES,
    OpencodeMemConfig,
    get_config_path,
    get_env_overrides,
    load_config,
    read_config_file,
    write_config_file,
)
from ..plugin_ingest import invalidate_runtime_state
from ..sync_runtime import effective_status, spawn_daemon, stop_pidfile_with_reason
from ..viewer_raw_events import RAW_EVENT_SWEEPER


class _ViewerHandler(Protocol):
    headers: Any
    rfile: Any

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None: ...


_RUNTIMES = {"api_http", "claude_sidecar"}
_AUTH_SOURCES = {"auto", "env", "file", "command", "none"}
_HOT_RELOAD_KEYS = {
    "claude_command",
    "observer_base_url",
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
    "raw_events_sweeper_interval_s",
}
_LIVE_APPLY_KEYS = {"pack_observation_limit", "pack_session_limit"}
_SYNC_ACTION_KEYS = {
    "sync_enabled",
    "sync_host",
    "sync_port",
    "sync_interval_s",
    "sync_mdns",
    "sync_coordinator_url",
    "sync_coordinator_group",
    "sync_coordinator_timeout_s",
    "sync_coordinator_presence_ttl_s",
}


def _config_value_changed(before: dict[str, Any], after: dict[str, Any], key: str) -> bool:
    return before.get(key) != after.get(key)


def _effective_value_changed(before: dict[str, Any], after: dict[str, Any], key: str) -> bool:
    return before.get(key) != after.get(key)


def _manual_action(kind: str, command: str, *, label: str, reason: str) -> dict[str, str]:
    return {
        "kind": kind,
        "command": command,
        "label": label,
        "reason": reason,
    }


def _build_warning(key: str) -> str:
    env_var = CONFIG_ENV_OVERRIDES.get(key, "environment")
    return f"{key} is currently controlled by {env_var}; saved config will not take effect until that override is removed."


def _determine_sync_action(
    *,
    changed_keys: set[str],
    before_effective: dict[str, Any],
    after_effective: dict[str, Any],
) -> tuple[str | None, str | None]:
    sync_keys = changed_keys & _SYNC_ACTION_KEYS
    if not sync_keys:
        return None, None
    before_enabled = bool(before_effective.get("sync_enabled"))
    after_enabled = bool(after_effective.get("sync_enabled"))
    if "sync_enabled" in sync_keys and not after_enabled:
        return "stop", "sync was disabled"
    if "sync_enabled" in sync_keys and after_enabled and not before_enabled:
        return "start", "sync was enabled"
    if after_enabled and sync_keys - {"sync_enabled"}:
        return "restart", "sync runtime settings changed"
    if not after_enabled and sync_keys - {"sync_enabled"}:
        return None, "sync settings saved and will apply next time sync starts"
    return None, None


def _sync_start(*, host: str, port: int, interval_s: int) -> tuple[bool, str | None]:
    if run_service_action_quiet("start", user=True, system=False):
        status = effective_status(host, port)
        if status.running:
            return True, f"sync daemon started ({status.mechanism})"
    status = effective_status(host, port)
    if status.running:
        return True, f"sync daemon already running ({status.mechanism})"
    try:
        spawn_daemon(host=host, port=port, interval_s=interval_s, db_path=None)
    except OSError as exc:
        return False, f"failed to start sync daemon: {exc}"
    status = effective_status(host, port)
    if status.running:
        return True, f"sync daemon started ({status.mechanism})"
    return False, "sync daemon start did not result in a running process"


def _sync_stop(*, host: str, port: int) -> tuple[bool, str | None]:
    if run_service_action_quiet("stop", user=True, system=False):
        status = effective_status(host, port)
        if not status.running:
            return True, "sync daemon stopped"
    result = stop_pidfile_with_reason()
    if result.stopped:
        return True, "sync daemon stopped"
    status = effective_status(host, port)
    if not status.running:
        return True, "sync daemon already stopped"
    return False, f"failed to stop sync daemon ({result.reason})"


def _sync_restart(*, host: str, port: int, interval_s: int) -> tuple[bool, str | None]:
    if run_service_action_quiet("restart", user=True, system=False):
        status = effective_status(host, port)
        if status.running:
            return True, f"sync daemon restarted ({status.mechanism})"
    stopped, stop_message = _sync_stop(host=host, port=port)
    if not stopped:
        return False, stop_message
    started, start_message = _sync_start(host=host, port=port, interval_s=interval_s)
    if not started:
        return False, start_message
    return True, start_message or "sync daemon restarted"


def _apply_sync_runtime_action(action: str, *, effective_config: dict[str, Any]) -> dict[str, Any]:
    host = str(effective_config.get("sync_host") or OpencodeMemConfig().sync_host)
    port = int(effective_config.get("sync_port") or OpencodeMemConfig().sync_port)
    interval_s = int(effective_config.get("sync_interval_s") or OpencodeMemConfig().sync_interval_s)
    if action == "start":
        ok, message = _sync_start(host=host, port=port, interval_s=interval_s)
    elif action == "stop":
        ok, message = _sync_stop(host=host, port=port)
    elif action == "restart":
        ok, message = _sync_restart(host=host, port=port, interval_s=interval_s)
    else:
        return {"attempted": False, "ok": None, "message": None, "manual_action": None}
    manual_action = None
    if not ok:
        manual_action = _manual_action(
            "sync",
            f"uv run codemem sync {action}",
            label=f"Run `codemem sync {action}`",
            reason=message or f"sync {action} failed",
        )
    return {
        "attempted": True,
        "ok": ok,
        "message": message,
        "manual_action": manual_action,
    }


def _apply_runtime_updates(changed_keys: set[str]) -> list[str]:
    applied: list[str] = []
    hot_reload_keys = changed_keys & _HOT_RELOAD_KEYS
    if hot_reload_keys:
        invalidate_runtime_state()
        RAW_EVENT_SWEEPER.reset_auth_backoff()
        applied.extend(sorted(hot_reload_keys - {"raw_events_sweeper_interval_s"}))
    if "raw_events_sweeper_interval_s" in hot_reload_keys:
        RAW_EVENT_SWEEPER.notify_config_changed()
        applied.append("raw_events_sweeper_interval_s")
    return applied


def _build_effects(
    *,
    saved_changed_keys: set[str],
    effective_changed_keys: set[str],
    before_effective: dict[str, Any],
    after_effective: dict[str, Any],
    env_overrides: dict[str, str],
) -> dict[str, Any]:
    ignored_by_env = sorted(
        key
        for key in saved_changed_keys
        if key not in effective_changed_keys and key in env_overrides
    )
    warnings = [_build_warning(key) for key in ignored_by_env]
    hot_reloaded_keys = sorted(effective_changed_keys & _HOT_RELOAD_KEYS)
    live_applied_keys = sorted(effective_changed_keys & _LIVE_APPLY_KEYS)
    restart_required_keys: list[str] = []
    sync_action, sync_reason = _determine_sync_action(
        changed_keys=effective_changed_keys,
        before_effective=before_effective,
        after_effective=after_effective,
    )
    sync_effect: dict[str, Any] = {
        "affected_keys": sorted(effective_changed_keys & _SYNC_ACTION_KEYS),
        "action": sync_action,
        "reason": sync_reason,
        "attempted": False,
        "ok": None,
        "message": sync_reason,
        "manual_action": None,
    }
    if sync_action is not None:
        sync_effect.update(
            _apply_sync_runtime_action(sync_action, effective_config=after_effective)
        )
    manual_actions: list[dict[str, str]] = []
    manual_action = sync_effect.get("manual_action")
    if isinstance(manual_action, dict):
        manual_actions.append(manual_action)
    if restart_required_keys:
        manual_actions.append(
            _manual_action(
                "viewer_restart",
                "uv run codemem serve --restart",
                label="Restart codemem viewer",
                reason="some settings still require a viewer restart",
            )
        )
    return {
        "saved_keys": sorted(saved_changed_keys),
        "effective_keys": sorted(effective_changed_keys),
        "hot_reloaded_keys": hot_reloaded_keys,
        "live_applied_keys": live_applied_keys,
        "restart_required_keys": restart_required_keys,
        "ignored_by_env_keys": ignored_by_env,
        "warnings": warnings,
        "sync": sync_effect,
        "manual_actions": manual_actions,
    }


def _as_positive_int(value: Any, *, key: str, allow_zero: bool = False) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, float):
        if not value.is_integer():
            return None
        parsed = int(value)
    else:
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
    redacted_keys = {"sync_coordinator_admin_secret"}
    config_data = {key: value for key, value in config_data.items() if key not in redacted_keys}
    effective = {
        key: value
        for key, value in asdict(load_config(config_path)).items()
        if key not in redacted_keys
    }
    defaults = {
        key: value for key, value in asdict(OpencodeMemConfig()).items() if key not in redacted_keys
    }
    handler._send_json(
        {
            "path": str(config_path),
            "config": config_data,
            "defaults": defaults,
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

    allowed_keys = (
        "claude_command",
        "observer_base_url",
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
        "sync_coordinator_url",
        "sync_coordinator_group",
        "sync_coordinator_timeout_s",
        "sync_coordinator_presence_ttl_s",
        "raw_events_sweeper_interval_s",
    )
    allowed_providers = set(load_provider_options())

    config_path = get_config_path()
    try:
        config_data = read_config_file(config_path)
    except ValueError:
        handler._send_json({"error": "config file could not be read"}, status=500)
        return True
    original_config_data = dict(config_data)
    before_effective = asdict(load_config(config_path))

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
            provided_base_url = False
            if "observer_base_url" in updates:
                base_url_override = updates.get("observer_base_url")
                if base_url_override in (None, ""):
                    provided_base_url = False
                elif isinstance(base_url_override, str):
                    provided_base_url = bool(base_url_override.strip())
                else:
                    handler._send_json({"error": "observer_base_url must be string"}, status=400)
                    return True
            saved_base_url = config_data.get("observer_base_url")
            has_saved_base_url = isinstance(saved_base_url, str) and bool(saved_base_url.strip())
            if provider not in allowed_providers and not (provided_base_url or has_saved_base_url):
                handler._send_json(
                    {"error": "observer_provider must match a configured provider"},
                    status=400,
                )
                return True
            config_data[key] = provider
            continue
        if key == "observer_base_url":
            if not isinstance(value, str):
                handler._send_json({"error": "observer_base_url must be string"}, status=400)
                return True
            base_url = value.strip()
            if not base_url:
                config_data.pop(key, None)
                continue
            config_data[key] = base_url
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
        if key in {"sync_coordinator_url", "sync_coordinator_group"}:
            if not isinstance(value, str):
                handler._send_json({"error": f"{key} must be string"}, status=400)
                return True
            string_value = value.strip()
            if not string_value:
                config_data.pop(key, None)
                continue
            config_data[key] = string_value
            continue
        if key in {
            "sync_port",
            "sync_interval_s",
            "sync_coordinator_timeout_s",
            "sync_coordinator_presence_ttl_s",
        }:
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
    after_effective = asdict(load_config(config_path))
    saved_changed_keys = {
        key for key in allowed_keys if _config_value_changed(original_config_data, config_data, key)
    }
    effective_changed_keys = {
        key
        for key in allowed_keys
        if _effective_value_changed(before_effective, after_effective, key)
    }
    _apply_runtime_updates(effective_changed_keys)
    effects = _build_effects(
        saved_changed_keys=saved_changed_keys,
        effective_changed_keys=effective_changed_keys,
        before_effective=before_effective,
        after_effective=after_effective,
        env_overrides=get_env_overrides(),
    )
    handler._send_json(
        {
            "path": str(config_path),
            "config": config_data,
            "effective": after_effective,
            "effects": effects,
        }
    )
    return True
