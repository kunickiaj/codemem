from __future__ import annotations

import json
import logging
import os
import subprocess
from dataclasses import dataclass
from typing import Any

from . import observer_auth as _observer_auth
from . import observer_config as _observer_config
from .config import load_config
from .observer_prompts import ObserverContext, build_observer_prompt
from .xml_parser import ParsedOutput, parse_observer_output

DEFAULT_OPENAI_MODEL = "gpt-5.1-codex-mini"
DEFAULT_ANTHROPIC_MODEL = "claude-4.5-haiku"
CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
DEFAULT_CODEX_ENDPOINT = CODEX_API_ENDPOINT


logger = logging.getLogger(__name__)

_REDACT_PATTERNS = _observer_auth._REDACT_PATTERNS
_build_codex_headers = _observer_auth._build_codex_headers
_extract_oauth_access = _observer_auth._extract_oauth_access
_extract_oauth_account_id = _observer_auth._extract_oauth_account_id
_extract_oauth_expires = _observer_auth._extract_oauth_expires
_get_iap_token = _observer_auth._get_iap_token
_get_opencode_auth_path = _observer_auth._get_opencode_auth_path
_now_ms = _observer_auth._now_ms
_redact_text = _observer_auth._redact_text
_resolve_oauth_provider = _observer_auth._resolve_oauth_provider

_get_opencode_provider_config = _observer_config._get_opencode_provider_config
_get_provider_api_key = _observer_config._get_provider_api_key
_get_provider_base_url = _observer_config._get_provider_base_url
_get_provider_headers = _observer_config._get_provider_headers
_get_provider_options = _observer_config._get_provider_options
_list_custom_providers = _observer_config._list_custom_providers
_load_opencode_config = _observer_config._load_opencode_config
_resolve_custom_provider_default_model = _observer_config._resolve_custom_provider_default_model
_resolve_custom_provider_from_model = _observer_config._resolve_custom_provider_from_model
_resolve_custom_provider_model = _observer_config._resolve_custom_provider_model
_resolve_file_placeholder = _observer_config._resolve_file_placeholder
_resolve_placeholder = _observer_config._resolve_placeholder
_strip_json_comments = _observer_config._strip_json_comments
_strip_trailing_commas = _observer_config._strip_trailing_commas

del _observer_auth
del _observer_config


def _load_opencode_oauth_cache() -> dict[str, Any]:
    """Load OpenCode OAuth cache from the auth.json path.

    This wrapper exists so tests can patch `opencode_mem.observer._get_opencode_auth_path`
    and affect the cache loader without having to patch the implementation module.
    """

    path = _get_opencode_auth_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        logger.warning("opencode auth cache load failed", exc_info=exc)
        return {}
    return data if isinstance(data, dict) else {}


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
