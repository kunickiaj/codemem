from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger("opencode_mem.observer")


def _strip_json_comments(text: str) -> str:
    """Strip JavaScript-style comments from JSON (JSONC support)."""
    lines = []
    for line in text.splitlines():
        result = []
        in_string = False
        escape_next = False
        i = 0
        while i < len(line):
            char = line[i]
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
            if not in_string and char == "/" and i + 1 < len(line) and line[i + 1] == "/":
                break
            result.append(char)
            i += 1
        lines.append("".join(result))
    return "\n".join(lines)


def _strip_trailing_commas(text: str) -> str:
    """Remove trailing commas before closing braces/brackets."""
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


def _load_opencode_config() -> dict:
    """Load OpenCode config from ~/.config/opencode/opencode.json{c}."""
    config_dir = Path.home() / ".config" / "opencode"
    candidates = [
        config_dir / "opencode.json",
        config_dir / "opencode.jsonc",
    ]
    config_path = next((path for path in candidates if path.exists()), None)
    if not config_path:
        return {}
    try:
        text = config_path.read_text()
    except Exception as exc:
        logger.warning("opencode config read failed", exc_info=exc)
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    try:
        cleaned = _strip_json_comments(text)
        cleaned = _strip_trailing_commas(cleaned)
        return json.loads(cleaned)
    except Exception as exc:
        logger.warning("opencode config load failed after comment strip", exc_info=exc)
        return {}


def _get_opencode_provider_config(provider: str) -> dict[str, Any]:
    config = _load_opencode_config()
    provider_config = config.get("provider", {})
    if not isinstance(provider_config, dict):
        return {}
    data = provider_config.get(provider, {})
    return data if isinstance(data, dict) else {}


def _list_custom_providers() -> set[str]:
    config = _load_opencode_config()
    provider_config = config.get("provider", {})
    if not isinstance(provider_config, dict):
        return set()
    return {key for key in provider_config if isinstance(key, str)}


def _resolve_custom_provider_from_model(model: str, providers: set[str]) -> str | None:
    if not model or "/" not in model:
        return None
    prefix = model.split("/", 1)[0]
    return prefix if prefix in providers else None


def _resolve_file_placeholder(value: str) -> str:
    pattern = re.compile(r"\{file:([^}]+)\}")

    def replace(match: re.Match[str]) -> str:
        path = match.group(1).strip()
        if not path:
            return match.group(0)
        resolved_path = Path(os.path.expandvars(os.path.expanduser(path)))
        try:
            return resolved_path.read_text().strip()
        except Exception as exc:
            logger.warning("opencode config file placeholder read failed", exc_info=exc)
            return match.group(0)

    if "{file:" not in value:
        return value
    return pattern.sub(replace, value)


def _resolve_placeholder(value: str) -> str:
    expanded = os.path.expandvars(value)
    return _resolve_file_placeholder(expanded)


def _get_provider_options(provider_config: dict[str, Any]) -> dict[str, Any]:
    options = provider_config.get("options", {})
    return options if isinstance(options, dict) else {}


def _get_provider_base_url(provider_config: dict[str, Any]) -> str | None:
    options = _get_provider_options(provider_config)
    base_url = (
        options.get("baseURL")
        or options.get("baseUrl")
        or options.get("base_url")
        or provider_config.get("base_url")
    )
    return base_url if isinstance(base_url, str) and base_url else None


def _get_provider_headers(provider_config: dict[str, Any]) -> dict[str, str]:
    options = _get_provider_options(provider_config)
    headers = options.get("headers", {})
    if not isinstance(headers, dict):
        return {}
    parsed: dict[str, str] = {}
    for key, value in headers.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        parsed[key] = _resolve_placeholder(value)
    return parsed


def _get_provider_api_key(provider_config: dict[str, Any]) -> str | None:
    options = _get_provider_options(provider_config)
    api_key = options.get("apiKey") or provider_config.get("apiKey")
    if isinstance(api_key, str) and api_key:
        return _resolve_placeholder(api_key)
    api_key_env = options.get("apiKeyEnv") or options.get("api_key_env")
    if isinstance(api_key_env, str) and api_key_env:
        value = os.getenv(api_key_env)
        if value:
            return value
    return None


def _resolve_custom_provider_default_model(provider: str) -> str | None:
    provider_config = _get_opencode_provider_config(provider)
    options = _get_provider_options(provider_config)
    default_model = (
        options.get("defaultModel")
        or options.get("default_model")
        or provider_config.get("defaultModel")
        or provider_config.get("default_model")
    )
    if isinstance(default_model, str) and default_model:
        if default_model.startswith(f"{provider}/"):
            return default_model
        return f"{provider}/{default_model}"
    models = provider_config.get("models", {})
    if isinstance(models, dict) and models:
        first_key = next(iter(models.keys()))
        if isinstance(first_key, str) and first_key:
            return f"{provider}/{first_key}"
    return None


def _resolve_custom_provider_model(
    provider: str,
    model_name: str,
) -> tuple[str | None, str | None, dict[str, str]]:
    provider_config = _get_opencode_provider_config(provider)
    base_url = _get_provider_base_url(provider_config)
    headers = _get_provider_headers(provider_config)
    if not model_name:
        model_name = _resolve_custom_provider_default_model(provider) or ""
    short_name = model_name
    prefix = f"{provider}/"
    if model_name.startswith(prefix):
        short_name = model_name[len(prefix) :]
    models = provider_config.get("models", {})
    model_id = short_name
    if isinstance(models, dict):
        model_config = models.get(short_name, {})
        if isinstance(model_config, dict):
            model_id = model_config.get("id", short_name)
    if not isinstance(model_id, str) or not model_id:
        model_id = None
    return base_url, model_id, headers
