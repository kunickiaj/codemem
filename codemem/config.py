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
    "observer_provider": "CODEMEM_OBSERVER_PROVIDER",
    "observer_model": "CODEMEM_OBSERVER_MODEL",
    "observer_max_chars": "CODEMEM_OBSERVER_MAX_CHARS",
    "pack_observation_limit": "CODEMEM_PACK_OBSERVATION_LIMIT",
    "pack_session_limit": "CODEMEM_PACK_SESSION_LIMIT",
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
    "sync_projects_include": "CODEMEM_SYNC_PROJECTS_INCLUDE",
    "sync_projects_exclude": "CODEMEM_SYNC_PROJECTS_EXCLUDE",
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
    observer_provider: str | None = None
    observer_model: str | None = None
    observer_api_key: str | None = None
    observer_max_chars: int = 12000
    observer_max_tokens: int = 4000
    summary_max_chars: int = 6000
    pack_observation_limit: int = 50
    pack_session_limit: int = 10
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
            "observer_max_chars",
            "observer_max_tokens",
            "summary_max_chars",
            "pack_observation_limit",
            "pack_session_limit",
            "viewer_port",
            "plugin_cmd_timeout_ms",
            "sync_port",
            "sync_interval_s",
        }:
            setattr(cfg, key, _parse_int(value, getattr(cfg, key), key=key))
            continue
        if key in {"hybrid_retrieval_shadow_sample_rate"}:
            sample_rate = _parse_float(value, getattr(cfg, key), key=key)
            setattr(cfg, key, min(1.0, max(0.0, sample_rate)))
            continue
        if key in {
            "use_opencode_run",
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
        if key in {"sync_projects_include", "sync_projects_exclude"}:
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
    cfg.observer_provider = os.getenv("CODEMEM_OBSERVER_PROVIDER", cfg.observer_provider)
    cfg.observer_model = os.getenv("CODEMEM_OBSERVER_MODEL", cfg.observer_model)
    cfg.observer_api_key = os.getenv("CODEMEM_OBSERVER_API_KEY", cfg.observer_api_key)
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
    cfg.sync_mdns = _parse_bool(os.getenv("CODEMEM_SYNC_MDNS"), cfg.sync_mdns)
    cfg.sync_key_store = os.getenv("CODEMEM_SYNC_KEY_STORE", cfg.sync_key_store)
    cfg.sync_advertise = os.getenv("CODEMEM_SYNC_ADVERTISE", cfg.sync_advertise)

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
    return cfg
