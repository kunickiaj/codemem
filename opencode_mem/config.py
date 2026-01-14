from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_CONFIG_PATH = Path("~/.config/opencode-mem/config.json").expanduser()


@dataclass
class OpencodeMemConfig:
    runner: str = "uvx"
    runner_from: str | None = None
    use_opencode_run: bool = False
    opencode_model: str = "openai/gpt-5.1-codex-mini"
    opencode_agent: str | None = None
    classifier_fallback_heuristic: bool = True
    classifier_max_chars: int = 6000
    summary_max_chars: int = 6000
    store_typed: bool = True
    store_summary: bool = False
    store_observations: bool = False
    store_entities: bool = False
    viewer_auto: bool = True
    viewer_auto_stop: bool = True
    viewer_enabled: bool = True
    viewer_host: str = "127.0.0.1"
    viewer_port: int = 37777
    plugin_log: str | None = "~/.opencode-mem/plugin.log"
    plugin_cmd_timeout_ms: int = 1500


def _parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    if value.lower() in {"1", "true", "yes", "on"}:
        return True
    if value.lower() in {"0", "false", "off", "no"}:
        return False
    return default


def load_config(path: Path | None = None) -> OpencodeMemConfig:
    cfg = OpencodeMemConfig()
    config_path = path or Path(os.getenv("OPENCODE_MEM_CONFIG", DEFAULT_CONFIG_PATH))
    if config_path.exists():
        try:
            data = json.loads(config_path.read_text())
        except json.JSONDecodeError:
            data = {}
        cfg = _apply_dict(cfg, data)
    cfg = _apply_env(cfg)
    return cfg


def _apply_dict(cfg: OpencodeMemConfig, data: dict[str, Any]) -> OpencodeMemConfig:
    for key, value in data.items():
        if not hasattr(cfg, key):
            continue
        setattr(cfg, key, value)
    return cfg


def _apply_env(cfg: OpencodeMemConfig) -> OpencodeMemConfig:
    cfg.runner = os.getenv("OPENCODE_MEM_RUNNER", cfg.runner)
    cfg.runner_from = os.getenv("OPENCODE_MEM_RUNNER_FROM", cfg.runner_from)
    cfg.use_opencode_run = _parse_bool(
        os.getenv("OPENCODE_MEM_USE_OPENCODE_RUN"), cfg.use_opencode_run
    )
    cfg.opencode_model = os.getenv("OPENCODE_MEM_OPENCODE_MODEL", cfg.opencode_model)
    cfg.opencode_agent = os.getenv("OPENCODE_MEM_OPENCODE_AGENT", cfg.opencode_agent)
    cfg.classifier_fallback_heuristic = _parse_bool(
        os.getenv("OPENCODE_MEM_CLASSIFIER_FALLBACK"), cfg.classifier_fallback_heuristic
    )
    cfg.classifier_max_chars = int(
        os.getenv("OPENCODE_MEM_CLASSIFIER_MAX_CHARS", cfg.classifier_max_chars)
    )
    cfg.summary_max_chars = int(
        os.getenv("OPENCODE_MEM_SUMMARY_MAX_CHARS", cfg.summary_max_chars)
    )
    cfg.store_typed = _parse_bool(
        os.getenv("OPENCODE_MEM_PLUGIN_TYPED"), cfg.store_typed
    )
    cfg.store_summary = _parse_bool(
        os.getenv("OPENCODE_MEM_PLUGIN_SUMMARY"), cfg.store_summary
    )
    cfg.store_observations = _parse_bool(
        os.getenv("OPENCODE_MEM_PLUGIN_OBSERVATIONS"), cfg.store_observations
    )
    cfg.store_entities = _parse_bool(
        os.getenv("OPENCODE_MEM_PLUGIN_ENTITIES"), cfg.store_entities
    )
    cfg.viewer_auto = _parse_bool(
        os.getenv("OPENCODE_MEM_VIEWER_AUTO"), cfg.viewer_auto
    )
    cfg.viewer_auto_stop = _parse_bool(
        os.getenv("OPENCODE_MEM_VIEWER_AUTO_STOP"), cfg.viewer_auto_stop
    )
    cfg.viewer_enabled = _parse_bool(
        os.getenv("OPENCODE_MEM_VIEWER"), cfg.viewer_enabled
    )
    cfg.viewer_host = os.getenv("OPENCODE_MEM_VIEWER_HOST", cfg.viewer_host)
    cfg.viewer_port = int(os.getenv("OPENCODE_MEM_VIEWER_PORT", cfg.viewer_port))
    cfg.plugin_log = os.getenv("OPENCODE_MEM_PLUGIN_LOG", cfg.plugin_log)
    cfg.plugin_cmd_timeout_ms = int(
        os.getenv("OPENCODE_MEM_PLUGIN_CMD_TIMEOUT", cfg.plugin_cmd_timeout_ms)
    )
    return cfg
