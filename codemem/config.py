from __future__ import annotations

import json
import os
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_PATH = Path("~/.config/codemem/config.json").expanduser()
DEFAULT_CONFIG_PATH_JSONC = Path("~/.config/codemem/config.jsonc").expanduser()

CONFIG_ENV_OVERRIDES = {
    "actor_id": "CODEMEM_ACTOR_ID",
    "actor_display_name": "CODEMEM_ACTOR_DISPLAY_NAME",
    "claude_command": "CODEMEM_CLAUDE_COMMAND",
    "observer_provider": "CODEMEM_OBSERVER_PROVIDER",
    "observer_model": "CODEMEM_OBSERVER_MODEL",
    "observer_base_url": "CODEMEM_OBSERVER_BASE_URL",
    "observer_runtime": "CODEMEM_OBSERVER_RUNTIME",
    "observer_auth_source": "CODEMEM_OBSERVER_AUTH_SOURCE",
    "observer_auth_file": "CODEMEM_OBSERVER_AUTH_FILE",
    "observer_auth_command": "CODEMEM_OBSERVER_AUTH_COMMAND",
    "observer_auth_timeout_ms": "CODEMEM_OBSERVER_AUTH_TIMEOUT_MS",
    "observer_auth_cache_ttl_s": "CODEMEM_OBSERVER_AUTH_CACHE_TTL_S",
    "observer_headers": "CODEMEM_OBSERVER_HEADERS",
    "observer_max_chars": "CODEMEM_OBSERVER_MAX_CHARS",
    "pack_observation_limit": "CODEMEM_PACK_OBSERVATION_LIMIT",
    "pack_session_limit": "CODEMEM_PACK_SESSION_LIMIT",
    "pack_exact_dedupe_enabled": "CODEMEM_PACK_EXACT_DEDUPE_ENABLED",
    "hybrid_retrieval_enabled": "CODEMEM_HYBRID_RETRIEVAL_ENABLED",
    "hybrid_retrieval_shadow_log": "CODEMEM_HYBRID_RETRIEVAL_SHADOW_LOG",
    "hybrid_retrieval_shadow_sample_rate": "CODEMEM_HYBRID_RETRIEVAL_SHADOW_SAMPLE_RATE",
    "sync_enabled": "CODEMEM_SYNC_ENABLED",
    "sync_host": "CODEMEM_SYNC_HOST",
    "sync_port": "CODEMEM_SYNC_PORT",
    "sync_interval_s": "CODEMEM_SYNC_INTERVAL_S",
    "sync_mdns": "CODEMEM_SYNC_MDNS",
    "sync_key_store": "CODEMEM_SYNC_KEY_STORE",
    "sync_advertise": "CODEMEM_SYNC_ADVERTISE",
    "sync_coordinator_url": "CODEMEM_SYNC_COORDINATOR_URL",
    "sync_coordinator_group": "CODEMEM_SYNC_COORDINATOR_GROUP",
    "sync_coordinator_groups": "CODEMEM_SYNC_COORDINATOR_GROUPS",
    "sync_coordinator_timeout_s": "CODEMEM_SYNC_COORDINATOR_TIMEOUT_S",
    "sync_coordinator_presence_ttl_s": "CODEMEM_SYNC_COORDINATOR_PRESENCE_TTL_S",
    "sync_coordinator_admin_secret": "CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
    "sync_projects_include": "CODEMEM_SYNC_PROJECTS_INCLUDE",
    "sync_projects_exclude": "CODEMEM_SYNC_PROJECTS_EXCLUDE",
    "raw_events_sweeper_interval_s": "CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_S",
}


def get_config_path(path: Path | None = None) -> Path:
    if path is not None:
        return path.expanduser()
    env_path = os.getenv("CODEMEM_CONFIG")
    if env_path:
        return Path(env_path).expanduser()
    if DEFAULT_CONFIG_PATH.exists():
        return DEFAULT_CONFIG_PATH
    if DEFAULT_CONFIG_PATH_JSONC.exists():
        return DEFAULT_CONFIG_PATH_JSONC
    return DEFAULT_CONFIG_PATH


def _strip_json_comments(text: str) -> str:
    result: list[str] = []
    in_string = False
    escape_next = False
    in_block_comment = False
    i = 0
    while i < len(text):
        char = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if in_block_comment:
            if char == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            if char in {"\n", "\r"}:
                result.append(char)
            i += 1
            continue
        if escape_next:
            result.append(char)
            escape_next = False
            i += 1
            continue
        if char == "\\" and in_string:
            result.append(char)
            escape_next = True
            i += 1
            continue
        if char == '"':
            in_string = not in_string
            result.append(char)
            i += 1
            continue
        if not in_string and char == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if not in_string and char == "/" and nxt == "/":
            i += 2
            while i < len(text) and text[i] not in {"\n", "\r"}:
                i += 1
            continue
        result.append(char)
        i += 1
    if in_block_comment:
        raise ValueError("unterminated block comment")
    return "".join(result)


def _strip_trailing_commas(text: str) -> str:
    result: list[str] = []
    in_string = False
    escape_next = False
    i = 0
    while i < len(text):
        char = text[i]
        if escape_next:
            result.append(char)
            escape_next = False
            i += 1
            continue
        if char == "\\" and in_string:
            result.append(char)
            escape_next = True
            i += 1
            continue
        if char == '"':
            in_string = not in_string
            result.append(char)
            i += 1
            continue
        if not in_string and char == ",":
            j = i + 1
            while j < len(text) and text[j].isspace():
                j += 1
            if j < len(text) and text[j] in {"]", "}"}:
                i += 1
                continue
        result.append(char)
        i += 1
    return "".join(result)


def _load_json_with_jsonc_support(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        cleaned = _strip_json_comments(raw)
        cleaned = _strip_trailing_commas(cleaned)
        data = json.loads(cleaned)
    if not isinstance(data, dict):
        raise ValueError("config must be an object")
    return data


def read_config_file(path: Path | None = None) -> dict[str, Any]:
    config_path = get_config_path(path)
    if not config_path.exists():
        return {}
    raw = config_path.read_text()
    if not raw.strip():
        return {}
    try:
        data = _load_json_with_jsonc_support(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError("invalid config json") from exc
    return data


def write_config_file(data: dict[str, Any], path: Path | None = None) -> Path:
    config_path = get_config_path(path)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return config_path


def get_env_overrides() -> dict[str, str]:
    overrides: dict[str, str] = {}
    for key, env_var in CONFIG_ENV_OVERRIDES.items():
        value = os.getenv(env_var)
        if value is not None:
            overrides[key] = value
    return overrides


@dataclass
class OpencodeMemConfig:
    runner: str = "uvx"
    runner_from: str | None = None
    use_opencode_run: bool = False
    opencode_model: str = "openai/gpt-5.1-codex-mini"
    opencode_agent: str | None = None
    actor_id: str | None = None
    actor_display_name: str | None = None
    claude_command: list[str] = field(default_factory=lambda: ["claude"])
    observer_provider: str | None = None
    observer_model: str | None = None
    observer_base_url: str | None = None
    observer_api_key: str | None = None
    observer_runtime: str = "api_http"
    observer_auth_source: str = "auto"
    observer_auth_file: str | None = None
    observer_auth_command: list[str] = field(default_factory=list)
    observer_auth_timeout_ms: int = 1500
    observer_auth_cache_ttl_s: int = 300
    observer_headers: dict[str, str] = field(default_factory=dict)
    observer_max_chars: int = 12000
    observer_max_tokens: int = 4000
    summary_max_chars: int = 6000
    pack_observation_limit: int = 50
    pack_session_limit: int = 10
    pack_exact_dedupe_enabled: bool = True
    hybrid_retrieval_enabled: bool = False
    hybrid_retrieval_shadow_log: bool = False
    hybrid_retrieval_shadow_sample_rate: float = 1.0
    viewer_auto: bool = True
    viewer_auto_stop: bool = True
    viewer_enabled: bool = True
    viewer_host: str = "127.0.0.1"
    viewer_port: int = 38888
    plugin_log: str | None = "~/.codemem/plugin.log"
    plugin_cmd_timeout_ms: int = 1500
    sync_enabled: bool = False
    sync_host: str = "0.0.0.0"
    sync_port: int = 7337
    sync_interval_s: int = 120
    sync_mdns: bool = True
    sync_key_store: str = "file"

    sync_advertise: str = "auto"
    sync_coordinator_url: str | None = None
    sync_coordinator_group: str | None = None
    sync_coordinator_groups: list[str] = field(default_factory=list)
    sync_coordinator_timeout_s: int = 3
    sync_coordinator_presence_ttl_s: int = 180
    sync_coordinator_admin_secret: str | None = None

    raw_events_sweeper_interval_s: int = 30

    # Basename-based project filters for syncing memory_items.
    # When include is non-empty, only those projects will sync.
    # Exclude always takes precedence.
    sync_projects_include: list[str] = field(default_factory=list)
    sync_projects_exclude: list[str] = field(default_factory=list)


def _parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    if value.lower() in {"1", "true", "yes", "on"}:
        return True
    if value.lower() in {"0", "false", "off", "no"}:
        return False
    return default


def _parse_int(value: object, default: int, *, key: str) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if not isinstance(value, str):
        warnings.warn(f"Invalid int for {key}: {value!r}", RuntimeWarning, stacklevel=2)
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        warnings.warn(f"Invalid int for {key}: {value!r}", RuntimeWarning, stacklevel=2)
        return default


def _coerce_bool(value: object, default: bool, *, key: str) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        return _parse_bool(value, default)
    warnings.warn(f"Invalid bool for {key}: {value!r}", RuntimeWarning, stacklevel=2)
    return default


def _parse_float(value: object, default: float, *, key: str) -> float:
    if value is None:
        return default
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, int):
        return float(value)
    if isinstance(value, float):
        return value
    if not isinstance(value, str):
        warnings.warn(f"Invalid float for {key}: {value!r}", RuntimeWarning, stacklevel=2)
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        warnings.warn(f"Invalid float for {key}: {value!r}", RuntimeWarning, stacklevel=2)
        return default


def _coerce_str_list(value: object, *, key: str) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, list):
        items: list[str] = []
        for item in value:
            if isinstance(item, str) and item.strip():
                items.append(item.strip())
        return items
    if isinstance(value, str):
        return [p.strip() for p in value.split(",") if p.strip()]
    warnings.warn(f"Invalid list for {key}: {value!r}", RuntimeWarning, stacklevel=2)
    return None


def _coerce_command(value: object, *, key: str) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, list):
        if any(not isinstance(item, str) for item in value):
            warnings.warn(
                f"Invalid command list for {key}: {value!r}", RuntimeWarning, stacklevel=2
            )
            return None
        return list(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except Exception:
            warnings.warn(
                f"Invalid command list for {key}: {value!r}", RuntimeWarning, stacklevel=2
            )
            return None
        if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
            warnings.warn(
                f"Invalid command list for {key}: {value!r}", RuntimeWarning, stacklevel=2
            )
            return None
        return list(parsed)
    warnings.warn(f"Invalid command for {key}: {value!r}", RuntimeWarning, stacklevel=2)
    return None


def _coerce_claude_command(value: object) -> list[str] | None:
    parsed = _coerce_command(value, key="claude_command")
    if parsed is None:
        return None
    normalized = [item.strip() for item in parsed]
    if any(not item for item in normalized):
        warnings.warn(
            f"Invalid command list for claude_command: {value!r}",
            RuntimeWarning,
            stacklevel=2,
        )
        return None
    return normalized


def _coerce_str_map(value: object, *, key: str) -> dict[str, str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        try:
            value = json.loads(text)
        except Exception:
            warnings.warn(f"Invalid object for {key}: {value!r}", RuntimeWarning, stacklevel=2)
            return None
    if not isinstance(value, dict):
        warnings.warn(f"Invalid object for {key}: {value!r}", RuntimeWarning, stacklevel=2)
        return None
    parsed: dict[str, str] = {}
    for map_key, map_value in value.items():
        if not isinstance(map_key, str) or not isinstance(map_value, str):
            warnings.warn(
                f"Invalid header entry for {key}: {map_key!r}", RuntimeWarning, stacklevel=2
            )
            return None
        key_str = map_key.strip()
        if not key_str:
            warnings.warn(
                f"Invalid header key for {key}: {map_key!r}", RuntimeWarning, stacklevel=2
            )
            return None
        parsed[key_str] = map_value
    return parsed


def load_config(path: Path | None = None) -> OpencodeMemConfig:
    cfg = OpencodeMemConfig()
    config_path = get_config_path(path)
    if config_path.exists():
        try:
            data = read_config_file(config_path)
        except ValueError as exc:
            warnings.warn(
                f"Invalid config file {config_path}: {exc}; using defaults/env overrides",
                RuntimeWarning,
                stacklevel=2,
            )
            data = {}
        cfg = _apply_dict(cfg, data)
    cfg = _apply_env(cfg)
    return cfg


def _apply_dict(cfg: OpencodeMemConfig, data: dict[str, Any]) -> OpencodeMemConfig:
    for key, value in data.items():
        if not hasattr(cfg, key):
            continue
        if key in {
            "observer_auth_timeout_ms",
            "observer_auth_cache_ttl_s",
            "observer_max_chars",
            "observer_max_tokens",
            "summary_max_chars",
            "pack_observation_limit",
            "pack_session_limit",
            "viewer_port",
            "plugin_cmd_timeout_ms",
            "sync_port",
            "sync_interval_s",
            "sync_coordinator_timeout_s",
            "sync_coordinator_presence_ttl_s",
            "raw_events_sweeper_interval_s",
        }:
            setattr(cfg, key, _parse_int(value, getattr(cfg, key), key=key))
            continue
        if key in {"hybrid_retrieval_shadow_sample_rate"}:
            sample_rate = _parse_float(value, getattr(cfg, key), key=key)
            setattr(cfg, key, min(1.0, max(0.0, sample_rate)))
            continue
        if key in {
            "use_opencode_run",
            "pack_exact_dedupe_enabled",
            "hybrid_retrieval_enabled",
            "hybrid_retrieval_shadow_log",
            "viewer_auto",
            "viewer_auto_stop",
            "viewer_enabled",
            "sync_enabled",
            "sync_mdns",
        }:
            setattr(cfg, key, _coerce_bool(value, getattr(cfg, key), key=key))
            continue
        if key == "observer_auth_command":
            parsed = _coerce_command(value, key=key)
            if parsed is not None:
                setattr(cfg, key, parsed)
            continue
        if key == "claude_command":
            parsed = _coerce_claude_command(value)
            if parsed is not None:
                setattr(cfg, key, parsed)
            continue
        if key == "observer_headers":
            parsed = _coerce_str_map(value, key=key)
            if parsed is not None:
                setattr(cfg, key, parsed)
            continue
        if key in {"sync_projects_include", "sync_projects_exclude", "sync_coordinator_groups"}:
            parsed = _coerce_str_list(value, key=key)
            if parsed is not None:
                setattr(cfg, key, parsed)
            continue
        setattr(cfg, key, value)
    return cfg


def _apply_env(cfg: OpencodeMemConfig) -> OpencodeMemConfig:
    cfg.runner = os.getenv("CODEMEM_RUNNER", cfg.runner)
    cfg.runner_from = os.getenv("CODEMEM_RUNNER_FROM", cfg.runner_from)
    cfg.use_opencode_run = _parse_bool(os.getenv("CODEMEM_USE_OPENCODE_RUN"), cfg.use_opencode_run)
    cfg.opencode_model = os.getenv("CODEMEM_OPENCODE_MODEL", cfg.opencode_model)
    cfg.opencode_agent = os.getenv("CODEMEM_OPENCODE_AGENT", cfg.opencode_agent)
    cfg.actor_id = os.getenv("CODEMEM_ACTOR_ID", cfg.actor_id)
    cfg.actor_display_name = os.getenv("CODEMEM_ACTOR_DISPLAY_NAME", cfg.actor_display_name)
    parsed_claude_command = _coerce_claude_command(os.getenv("CODEMEM_CLAUDE_COMMAND"))
    if parsed_claude_command is not None:
        cfg.claude_command = parsed_claude_command
    cfg.observer_provider = os.getenv("CODEMEM_OBSERVER_PROVIDER", cfg.observer_provider)
    cfg.observer_model = os.getenv("CODEMEM_OBSERVER_MODEL", cfg.observer_model)
    cfg.observer_base_url = os.getenv("CODEMEM_OBSERVER_BASE_URL", cfg.observer_base_url)
    cfg.observer_api_key = os.getenv("CODEMEM_OBSERVER_API_KEY", cfg.observer_api_key)
    cfg.observer_runtime = os.getenv("CODEMEM_OBSERVER_RUNTIME", cfg.observer_runtime)
    cfg.observer_auth_source = os.getenv("CODEMEM_OBSERVER_AUTH_SOURCE", cfg.observer_auth_source)
    cfg.observer_auth_file = os.getenv("CODEMEM_OBSERVER_AUTH_FILE", cfg.observer_auth_file)
    parsed_auth_command = _coerce_command(
        os.getenv("CODEMEM_OBSERVER_AUTH_COMMAND"),
        key="observer_auth_command",
    )
    if parsed_auth_command is not None:
        cfg.observer_auth_command = parsed_auth_command
    parsed_headers = _coerce_str_map(
        os.getenv("CODEMEM_OBSERVER_HEADERS"),
        key="observer_headers",
    )
    if parsed_headers is not None:
        cfg.observer_headers = parsed_headers
    cfg.observer_auth_timeout_ms = _parse_int(
        os.getenv("CODEMEM_OBSERVER_AUTH_TIMEOUT_MS"),
        cfg.observer_auth_timeout_ms,
        key="observer_auth_timeout_ms",
    )
    cfg.observer_auth_cache_ttl_s = _parse_int(
        os.getenv("CODEMEM_OBSERVER_AUTH_CACHE_TTL_S"),
        cfg.observer_auth_cache_ttl_s,
        key="observer_auth_cache_ttl_s",
    )
    cfg.observer_max_chars = _parse_int(
        os.getenv("CODEMEM_OBSERVER_MAX_CHARS"),
        cfg.observer_max_chars,
        key="observer_max_chars",
    )
    cfg.observer_max_tokens = _parse_int(
        os.getenv("CODEMEM_OBSERVER_MAX_TOKENS"),
        cfg.observer_max_tokens,
        key="observer_max_tokens",
    )
    cfg.summary_max_chars = _parse_int(
        os.getenv("CODEMEM_SUMMARY_MAX_CHARS"), cfg.summary_max_chars, key="summary_max_chars"
    )
    cfg.pack_observation_limit = _parse_int(
        os.getenv("CODEMEM_PACK_OBSERVATION_LIMIT"),
        cfg.pack_observation_limit,
        key="pack_observation_limit",
    )
    cfg.pack_session_limit = _parse_int(
        os.getenv("CODEMEM_PACK_SESSION_LIMIT"),
        cfg.pack_session_limit,
        key="pack_session_limit",
    )
    cfg.pack_exact_dedupe_enabled = _parse_bool(
        os.getenv("CODEMEM_PACK_EXACT_DEDUPE_ENABLED"),
        cfg.pack_exact_dedupe_enabled,
    )
    cfg.hybrid_retrieval_enabled = _parse_bool(
        os.getenv("CODEMEM_HYBRID_RETRIEVAL_ENABLED"), cfg.hybrid_retrieval_enabled
    )
    cfg.hybrid_retrieval_shadow_log = _parse_bool(
        os.getenv("CODEMEM_HYBRID_RETRIEVAL_SHADOW_LOG"), cfg.hybrid_retrieval_shadow_log
    )
    cfg.hybrid_retrieval_shadow_sample_rate = min(
        1.0,
        max(
            0.0,
            _parse_float(
                os.getenv("CODEMEM_HYBRID_RETRIEVAL_SHADOW_SAMPLE_RATE"),
                cfg.hybrid_retrieval_shadow_sample_rate,
                key="hybrid_retrieval_shadow_sample_rate",
            ),
        ),
    )
    cfg.viewer_auto = _parse_bool(os.getenv("CODEMEM_VIEWER_AUTO"), cfg.viewer_auto)
    cfg.viewer_auto_stop = _parse_bool(os.getenv("CODEMEM_VIEWER_AUTO_STOP"), cfg.viewer_auto_stop)
    cfg.viewer_enabled = _parse_bool(os.getenv("CODEMEM_VIEWER"), cfg.viewer_enabled)
    cfg.viewer_host = os.getenv("CODEMEM_VIEWER_HOST", cfg.viewer_host)
    cfg.viewer_port = _parse_int(
        os.getenv("CODEMEM_VIEWER_PORT"), cfg.viewer_port, key="viewer_port"
    )
    cfg.plugin_log = os.getenv("CODEMEM_PLUGIN_LOG", cfg.plugin_log)
    cfg.plugin_cmd_timeout_ms = _parse_int(
        os.getenv("CODEMEM_PLUGIN_CMD_TIMEOUT"),
        cfg.plugin_cmd_timeout_ms,
        key="plugin_cmd_timeout_ms",
    )
    cfg.sync_enabled = _parse_bool(os.getenv("CODEMEM_SYNC_ENABLED"), cfg.sync_enabled)
    cfg.sync_host = os.getenv("CODEMEM_SYNC_HOST", cfg.sync_host)
    cfg.sync_port = _parse_int(os.getenv("CODEMEM_SYNC_PORT"), cfg.sync_port, key="sync_port")
    cfg.sync_interval_s = _parse_int(
        os.getenv("CODEMEM_SYNC_INTERVAL_S"), cfg.sync_interval_s, key="sync_interval_s"
    )
    cfg.raw_events_sweeper_interval_s = _parse_int(
        os.getenv("CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_S"),
        cfg.raw_events_sweeper_interval_s,
        key="raw_events_sweeper_interval_s",
    )
    cfg.sync_mdns = _parse_bool(os.getenv("CODEMEM_SYNC_MDNS"), cfg.sync_mdns)
    cfg.sync_key_store = os.getenv("CODEMEM_SYNC_KEY_STORE", cfg.sync_key_store)
    cfg.sync_advertise = os.getenv("CODEMEM_SYNC_ADVERTISE", cfg.sync_advertise)
    cfg.sync_coordinator_url = os.getenv("CODEMEM_SYNC_COORDINATOR_URL", cfg.sync_coordinator_url)
    cfg.sync_coordinator_group = os.getenv(
        "CODEMEM_SYNC_COORDINATOR_GROUP", cfg.sync_coordinator_group
    )
    coordinator_groups = _coerce_str_list(
        os.getenv("CODEMEM_SYNC_COORDINATOR_GROUPS"), key="sync_coordinator_groups"
    )
    if coordinator_groups is not None:
        cfg.sync_coordinator_groups = coordinator_groups
    cfg.sync_coordinator_timeout_s = _parse_int(
        os.getenv("CODEMEM_SYNC_COORDINATOR_TIMEOUT_S"),
        cfg.sync_coordinator_timeout_s,
        key="sync_coordinator_timeout_s",
    )
    cfg.sync_coordinator_presence_ttl_s = _parse_int(
        os.getenv("CODEMEM_SYNC_COORDINATOR_PRESENCE_TTL_S"),
        cfg.sync_coordinator_presence_ttl_s,
        key="sync_coordinator_presence_ttl_s",
    )
    cfg.sync_coordinator_admin_secret = os.getenv(
        "CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", cfg.sync_coordinator_admin_secret
    )

    include = _coerce_str_list(
        os.getenv("CODEMEM_SYNC_PROJECTS_INCLUDE"), key="sync_projects_include"
    )
    if include is not None:
        cfg.sync_projects_include = include
    exclude = _coerce_str_list(
        os.getenv("CODEMEM_SYNC_PROJECTS_EXCLUDE"), key="sync_projects_exclude"
    )
    if exclude is not None:
        cfg.sync_projects_exclude = exclude

    if cfg.sync_coordinator_groups:
        if not cfg.sync_coordinator_group:
            cfg.sync_coordinator_group = cfg.sync_coordinator_groups[0]
    elif cfg.sync_coordinator_group:
        cfg.sync_coordinator_groups = [cfg.sync_coordinator_group]
    return cfg
