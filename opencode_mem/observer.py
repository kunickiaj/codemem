from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import load_config
from .observer_prompts import ObserverContext, build_observer_prompt
from .xml_parser import ParsedOutput, parse_observer_output

DEFAULT_OPENAI_MODEL = "gpt-5.1-codex-mini"
DEFAULT_ANTHROPIC_MODEL = "claude-4.5-haiku"
CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
DEFAULT_CODEX_ENDPOINT = CODEX_API_ENDPOINT


logger = logging.getLogger(__name__)


_REDACT_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9]{10,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._-]{10,}"),
)


def _get_iap_token() -> str | None:
    """Get IAP token from environment (set by iap-auth plugin)."""
    return os.getenv("IAP_AUTH_TOKEN")


def _strip_json_comments(text: str) -> str:
    """Strip JavaScript-style comments from JSON (JSONC support)."""
    lines = []
    for line in text.splitlines():
        # Strip single-line comments (// ...) but not inside strings
        # Simple approach: find // not inside quotes
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
                # Found comment, stop here
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
    # Try standard JSON first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Try stripping comments (JSONC support)
    try:
        cleaned = _strip_json_comments(text)
        cleaned = _strip_trailing_commas(cleaned)
        return json.loads(cleaned)
    except Exception as exc:
        logger.warning("opencode config load failed after comment strip", exc_info=exc)
        return {}


def _get_opencode_auth_path() -> Path:
    return Path.home() / ".local" / "share" / "opencode" / "auth.json"


def _load_opencode_oauth_cache() -> dict[str, Any]:
    path = _get_opencode_auth_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        logger.warning("opencode auth cache load failed", exc_info=exc)
        return {}
    return data if isinstance(data, dict) else {}


def _resolve_oauth_provider(configured: str | None, model: str) -> str:
    if configured and configured.lower() in {"openai", "anthropic"}:
        return configured.lower()
    if model.lower().startswith("claude"):
        return "anthropic"
    return "openai"


def _extract_oauth_access(cache: dict[str, Any], provider: str) -> str | None:
    entry = cache.get(provider)
    if not isinstance(entry, dict):
        return None
    access = entry.get("access")
    if isinstance(access, str) and access:
        return access
    return None


def _extract_oauth_account_id(cache: dict[str, Any], provider: str) -> str | None:
    entry = cache.get(provider)
    if not isinstance(entry, dict):
        return None
    account_id = entry.get("accountId")
    if isinstance(account_id, str) and account_id:
        return account_id
    return None


def _extract_oauth_expires(cache: dict[str, Any], provider: str) -> int | None:
    entry = cache.get(provider)
    if not isinstance(entry, dict):
        return None
    expires = entry.get("expires")
    if isinstance(expires, int):
        return expires
    return None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _build_codex_headers(access_token: str, account_id: str | None) -> dict[str, str]:
    headers = {"authorization": f"Bearer {access_token}"}
    if account_id:
        headers["ChatGPT-Account-Id"] = account_id
    return headers


def _build_codex_payload(model: str, prompt: str, max_tokens: int) -> dict[str, Any]:
    payload = {
        "model": model,
        "instructions": "You are a memory observer.",
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}],
            }
        ],
        "store": False,
        "stream": True,
    }
    return payload


def _resolve_codex_endpoint() -> str:
    return os.getenv("OPENCODE_MEM_CODEX_ENDPOINT", DEFAULT_CODEX_ENDPOINT)


def _redact_text(text: str, limit: int = 400) -> str:
    redacted = text
    for pattern in _REDACT_PATTERNS:
        redacted = pattern.sub("[redacted]", redacted)
    if len(redacted) > limit:
        return f"{redacted[:limit]}…"
    return redacted


def _parse_codex_stream(response: Any) -> str | None:
    text_parts: list[str] = []
    for line in response.iter_lines():
        if not line:
            continue
        decoded = line.decode("utf-8") if isinstance(line, (bytes, bytearray)) else str(line)
        if not decoded.startswith("data:"):
            continue
        payload = decoded[len("data:") :].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "response.output_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str) and delta:
                text_parts.append(delta)
    if text_parts:
        return "".join(text_parts).strip()
    return None


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


@dataclass
class ObserverResponse:
    raw: str | None
    parsed: ParsedOutput


class ObserverClient:
    def __init__(self) -> None:
        cfg = load_config()
        provider = (cfg.observer_provider or "").lower()
        model = cfg.observer_model or ""
        custom_providers = _list_custom_providers()

        if provider and provider not in {"openai", "anthropic"} | custom_providers:
            provider = ""

        resolved_provider = provider
        if not resolved_provider:
            inferred_custom = _resolve_custom_provider_from_model(model, custom_providers)
            if inferred_custom:
                resolved_provider = inferred_custom
        if not resolved_provider:
            resolved_provider = _resolve_oauth_provider(None, model or DEFAULT_OPENAI_MODEL)
        if resolved_provider not in {"openai", "anthropic"} | custom_providers:
            resolved_provider = "openai"

        self.provider = resolved_provider
        self.use_opencode_run = cfg.use_opencode_run
        self.opencode_model = cfg.opencode_model
        self.opencode_agent = cfg.opencode_agent
        if model:
            self.model = model
        elif resolved_provider == "anthropic":
            self.model = DEFAULT_ANTHROPIC_MODEL
        elif resolved_provider == "openai":
            self.model = DEFAULT_OPENAI_MODEL
        else:
            self.model = _resolve_custom_provider_default_model(resolved_provider) or ""
        self.api_key = cfg.observer_api_key or os.getenv("OPENCODE_MEM_OBSERVER_API_KEY")
        self.max_chars = cfg.observer_max_chars
        self.max_tokens = cfg.observer_max_tokens
        self.client: object | None = None
        self.codex_access: str | None = None
        self.codex_account_id: str | None = None
        oauth_cache = _load_opencode_oauth_cache()
        oauth_access = None
        oauth_expires = None
        oauth_provider = None
        if resolved_provider in {"openai", "anthropic"}:
            oauth_provider = _resolve_oauth_provider(provider or None, self.model)
            oauth_access = _extract_oauth_access(oauth_cache, oauth_provider)
            oauth_expires = _extract_oauth_expires(oauth_cache, oauth_provider)
            if oauth_access and (oauth_expires is None or oauth_expires > _now_ms()):
                self.codex_access = oauth_access
                self.codex_account_id = _extract_oauth_account_id(oauth_cache, oauth_provider)
        if self.use_opencode_run:
            logger.info("observer auth: using opencode run")
            return
        if resolved_provider not in {"openai", "anthropic"}:
            provider_config = _get_opencode_provider_config(resolved_provider)
            base_url, model_id, headers = _resolve_custom_provider_model(
                resolved_provider,
                self.model,
            )
            if not base_url or not model_id:
                logger.warning("observer auth: missing custom provider config")
                return
            api_key = _get_provider_api_key(provider_config) or self.api_key
            try:
                from openai import OpenAI  # type: ignore

                self.client = OpenAI(
                    api_key=api_key or "unused",
                    base_url=base_url,
                    default_headers=headers or None,
                )
                self.model = model_id
            except Exception as exc:  # pragma: no cover
                logger.exception("observer auth: custom provider client init failed", exc_info=exc)
                self.client = None
        elif resolved_provider == "anthropic":
            if not self.api_key:
                self.api_key = os.getenv("ANTHROPIC_API_KEY") or oauth_access
            if not self.api_key:
                logger.warning("observer auth: missing anthropic api key")
                return
            try:
                import anthropic  # type: ignore

                self.client = anthropic.Anthropic(api_key=self.api_key)
            except Exception as exc:  # pragma: no cover
                logger.exception("observer auth: anthropic client init failed", exc_info=exc)
                self.client = None
        else:
            if not self.api_key:
                self.api_key = (
                    os.getenv("OPENCODE_API_KEY")
                    or os.getenv("OPENAI_API_KEY")
                    or os.getenv("CODEX_API_KEY")
                    or oauth_access
                )
            if not self.api_key:
                logger.warning("observer auth: missing openai api key")
                return
            try:
                from openai import OpenAI  # type: ignore

                self.client = OpenAI(api_key=self.api_key)
            except Exception as exc:  # pragma: no cover
                logger.exception("observer auth: openai client init failed", exc_info=exc)
                self.client = None

    def observe(self, context: ObserverContext) -> ObserverResponse:
        prompt = build_observer_prompt(context)
        if self.max_chars > 0 and len(prompt) > self.max_chars:
            prompt = prompt[: self.max_chars]
        raw = self._call(prompt)
        parsed = parse_observer_output(raw or "")
        return ObserverResponse(raw=raw, parsed=parsed)

    def _call(self, prompt: str) -> str | None:
        if self.use_opencode_run:
            return self._call_opencode_run(prompt)
        if self.codex_access:
            return self._call_codex(prompt)
        if not self.client:
            logger.warning("observer auth: missing client and codex token")
            return None
        try:
            if self.provider == "anthropic":
                resp = self.client.completions.create(  # type: ignore[union-attr]
                    model=self.model,
                    prompt=f"\nHuman: {prompt}\nAssistant:",
                    temperature=0,
                    max_tokens_to_sample=self.max_tokens,
                )
                return resp.completion
            # OpenAI and custom providers use OpenAI-compatible APIs
            resp = self.client.chat.completions.create(  # type: ignore[union-attr]
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are a memory observer."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0,
                max_tokens=self.max_tokens,
            )
            return resp.choices[0].message.content
        except Exception as exc:  # pragma: no cover
            logger.exception(
                "observer call failed",
                extra={"provider": self.provider, "model": self.model},
                exc_info=exc,
            )
            return None

    def _call_opencode_run(self, prompt: str) -> str | None:
        model = self.opencode_model or self.model
        cmd = ["opencode", "run", "--format", "json", "--model", model]
        if self.opencode_agent:
            cmd.extend(["--agent", self.opencode_agent])
        cmd.append(prompt)
        env = dict(os.environ)
        env.update(
            {
                "OPENCODE_MEM_PLUGIN_IGNORE": "1",
                "OPENCODE_MEM_VIEWER": "0",
                "OPENCODE_MEM_VIEWER_AUTO": "0",
                "OPENCODE_MEM_VIEWER_AUTO_STOP": "0",
            }
        )
        try:
            result = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
                env=env,
            )
        except Exception as exc:  # pragma: no cover
            logger.exception("observer opencode run failed", exc_info=exc)
            return None
        if result.returncode != 0:
            logger.warning(
                "observer opencode run returned non-zero",
                extra={"returncode": result.returncode},
            )
            return None
        return self._extract_opencode_text(result.stdout)

    def _call_codex(self, prompt: str) -> str | None:
        if not self.codex_access:
            logger.warning("observer auth: missing codex access token")
            return None
        headers = _build_codex_headers(self.codex_access, self.codex_account_id)
        payload = _build_codex_payload(self.model, prompt, self.max_tokens)
        endpoint = _resolve_codex_endpoint()
        try:
            import httpx

            with (
                httpx.Client(timeout=60) as client,
                client.stream(
                    "POST",
                    endpoint,
                    json=payload,
                    headers=headers,
                ) as response,
            ):
                if response.status_code >= 400:
                    error_text = None
                    try:
                        response.read()
                        error_text = response.text
                    except Exception:
                        error_text = None
                    error_summary = _redact_text(error_text or "")
                    message = "observer codex oauth call failed"
                    if error_summary:
                        message = f"{message}: {error_summary}"
                    logger.error(
                        message,
                        extra={
                            "provider": self.provider,
                            "model": self.model,
                            "endpoint": endpoint,
                            "status": response.status_code,
                            "error": error_summary,
                        },
                    )
                    return None
                response.raise_for_status()
                return _parse_codex_stream(response)
        except Exception as exc:  # pragma: no cover
            response = getattr(exc, "response", None)
            status_code = getattr(response, "status_code", None)
            error_text = None
            if response is not None:
                try:
                    response.read()
                    error_text = response.text
                except Exception:
                    error_text = None
            error_summary = _redact_text(error_text or "")
            message = "observer codex oauth call failed"
            if error_summary:
                message = f"{message}: {error_summary}"
            logger.exception(
                message,
                extra={
                    "provider": self.provider,
                    "model": self.model,
                    "endpoint": endpoint,
                    "status": status_code,
                    "error": error_summary,
                },
                exc_info=exc,
            )
            return None

    def _extract_opencode_text(self, output: str) -> str:
        if not output:
            return ""
        lines = output.splitlines()
        parts: list[str] = []
        for line in lines:
            try:
                payload = json.loads(line)
            except Exception:
                continue
            if payload.get("type") == "text":
                part = payload.get("part") or {}
                text = part.get("text") if isinstance(part, dict) else None
                if text:
                    parts.append(text)
        if parts:
            return "\n".join(parts).strip()
        return output.strip()
