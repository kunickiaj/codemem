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


def _load_opencode_config() -> dict:
    """Load OpenCode config from ~/.config/opencode/opencode.json"""
    config_path = Path.home() / ".config" / "opencode" / "opencode.json"
    if not config_path.exists():
        return {}
    try:
        return json.loads(config_path.read_text())
    except Exception as exc:
        logger.warning("opencode config load failed", exc_info=exc)
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


def _resolve_custom-gateway_model(model_name: str) -> tuple[str, str]:
    """
    Resolve custom-gateway/model-name to (base_url, model_id).

    Args:
        model_name: e.g., "custom-gateway/claude-haiku"

    Returns:
        (base_url, model_id) e.g., ("https://custom-gateway.a.example.com/v1", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
    """
    config = _load_opencode_config()
    provider_config = config.get("provider", {}).get("custom-gateway", {})
    base_url = provider_config.get("options", {}).get(
        "baseURL", "https://custom-gateway.a.example.com/v1"
    )

    # Strip custom-gateway/ prefix
    short_name = model_name.replace("custom-gateway/", "")

    # Look up model ID from config
    models = provider_config.get("models", {})
    model_config = models.get(short_name, {})
    model_id = model_config.get("id", short_name)

    return base_url, model_id


@dataclass
class ObserverResponse:
    raw: str | None
    parsed: ParsedOutput


class ObserverClient:
    def __init__(self) -> None:
        cfg = load_config()
        provider = (cfg.observer_provider or "").lower()
        model = cfg.observer_model or ""

        if provider and provider not in {"openai", "anthropic", "custom-gateway"}:
            provider = ""

        resolved_provider = provider
        if not resolved_provider and model.startswith("custom-gateway/"):
            resolved_provider = "custom-gateway"
        if not resolved_provider:
            resolved_provider = _resolve_oauth_provider(None, model or DEFAULT_OPENAI_MODEL)
        if resolved_provider not in {"openai", "anthropic", "custom-gateway"}:
            resolved_provider = "openai"

        self.provider = resolved_provider
        self.use_opencode_run = cfg.use_opencode_run
        self.opencode_model = cfg.opencode_model
        self.opencode_agent = cfg.opencode_agent
        self.model = model or (
            DEFAULT_ANTHROPIC_MODEL if resolved_provider == "anthropic" else DEFAULT_OPENAI_MODEL
        )
        self.api_key = cfg.observer_api_key or os.getenv("OPENCODE_MEM_OBSERVER_API_KEY")
        self.max_chars = cfg.observer_max_chars
        self.max_tokens = cfg.observer_max_tokens
        self.client: object | None = None
        self.codex_access: str | None = None
        self.codex_account_id: str | None = None
        oauth_cache = _load_opencode_oauth_cache()
        oauth_provider = _resolve_oauth_provider(provider or None, self.model)
        oauth_access = _extract_oauth_access(oauth_cache, oauth_provider)
        oauth_expires = _extract_oauth_expires(oauth_cache, oauth_provider)
        if oauth_access and (oauth_expires is None or oauth_expires > _now_ms()):
            self.codex_access = oauth_access
            self.codex_account_id = _extract_oauth_account_id(oauth_cache, oauth_provider)
        if self.use_opencode_run:
            logger.info("observer auth: using opencode run")
            return
        if resolved_provider == "custom-gateway":
            # Use OpenAI client with custom-gateway base URL and IAP token
            iap_token = _get_iap_token()
            if not iap_token:
                logger.warning("observer auth: missing IAP token for custom-gateway")
                return
            try:
                from openai import OpenAI  # type: ignore

                base_url, model_id = _resolve_custom-gateway_model(self.model)
                self.client = OpenAI(
                    api_key="unused",  # custom-gateway uses IAP, not API key
                    base_url=base_url,
                    default_headers={"Authorization": f"Bearer {iap_token}"},
                )
                self.model = model_id
            except Exception as exc:  # pragma: no cover
                logger.exception("observer auth: custom-gateway client init failed", exc_info=exc)
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
            # OpenAI and custom-gateway both use OpenAI-compatible API
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
