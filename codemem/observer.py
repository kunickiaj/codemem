from __future__ import annotations

import json
import logging
import os
import subprocess
from dataclasses import dataclass
from typing import Any

from . import observer_auth as _observer_auth
from . import observer_codex as _observer_codex
from . import observer_config as _observer_config
from .config import load_config
from .observer_prompts import ObserverContext, build_observer_prompt
from .xml_parser import ParsedOutput, parse_observer_output

DEFAULT_OPENAI_MODEL = "gpt-5.1-codex-mini"
DEFAULT_ANTHROPIC_MODEL = "claude-4.5-haiku"
CODEX_API_ENDPOINT = _observer_codex.CODEX_API_ENDPOINT
DEFAULT_CODEX_ENDPOINT = _observer_codex.DEFAULT_CODEX_ENDPOINT


logger = logging.getLogger(__name__)

_CLAUDE_SIDECAR_TIMEOUT_S = 45


class ObserverAuthError(Exception):
    """Raised when the observer encounters an authentication/authorization failure.

    Auth errors (expired tokens, invalid keys, 401/403) are non-retryable until
    credentials are refreshed.  The raw-event sweeper uses this to back off
    instead of retrying every tick cycle.
    """


def _is_auth_error(exc: Exception) -> bool:
    """Detect authentication/authorization errors from provider SDKs."""
    # OpenAI SDK: AuthenticationError (401) and PermissionDeniedError (403)
    type_name = type(exc).__name__
    if type_name in ("AuthenticationError", "PermissionDeniedError"):
        return True
    # Anthropic SDK: AuthenticationError
    if type_name == "AuthenticationError":
        return True
    # HTTP status code check for generic cases
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    return isinstance(status, int) and status in (401, 403)


def _extract_claude_result_payload(output: str) -> dict[str, Any] | None:
    if not output:
        return None
    for line in reversed(output.splitlines()):
        text = line.strip()
        if not text:
            continue
        try:
            payload = json.loads(text)
        except Exception:
            continue
        if isinstance(payload, dict) and payload.get("type") == "result":
            return payload
    return None


def _is_claude_sidecar_model_error(message: str) -> bool:
    lowered = message.lower()
    return (
        "issue with the selected model" in lowered
        or "run --model to pick a different model" in lowered
        or "model" in lowered
        and "may not exist" in lowered
    )


def _is_claude_sidecar_auth_error(message: str) -> bool:
    lowered = message.lower()
    checks = (
        "not logged in",
        "login",
        "authentication",
        "unauthorized",
        "permission denied",
        "api key",
        "anthropic_api_key",
        "setup-token",
    )
    return any(token in lowered for token in checks)


_REDACT_PATTERNS = _observer_codex._REDACT_PATTERNS
_build_codex_headers = _observer_auth._build_codex_headers
_extract_oauth_access = _observer_auth._extract_oauth_access
_extract_oauth_account_id = _observer_auth._extract_oauth_account_id
_extract_oauth_expires = _observer_auth._extract_oauth_expires
_get_opencode_auth_path = _observer_auth._get_opencode_auth_path
_now_ms = _observer_auth._now_ms
ObserverAuthAdapter = _observer_auth.ObserverAuthAdapter
ObserverAuthMaterial = _observer_auth.ObserverAuthMaterial
_render_observer_headers = _observer_auth._render_observer_headers
_redact_text = _observer_codex._redact_text
_resolve_oauth_provider = _observer_auth._resolve_oauth_provider

_build_codex_payload = _observer_codex._build_codex_payload
_parse_codex_stream = _observer_codex._parse_codex_stream
_resolve_codex_endpoint = _observer_codex._resolve_codex_endpoint

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
del _observer_codex
del _observer_config


def _load_opencode_oauth_cache() -> dict[str, Any]:
    """Load OpenCode OAuth cache from the auth.json path.

    This wrapper exists so tests can patch `codemem.observer._get_opencode_auth_path`
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


@dataclass
class ObserverResponse:
    raw: str | None
    parsed: ParsedOutput


class ObserverClient:
    def __init__(self) -> None:
        cfg = load_config()
        provider = (cfg.observer_provider or "").lower()
        model = cfg.observer_model or ""
        self._configured_model = model.strip() or None
        self._sidecar_model = self._configured_model or DEFAULT_ANTHROPIC_MODEL
        self._claude_command = []
        for part in cfg.claude_command or []:
            token = str(part).strip()
            if token:
                self._claude_command.append(token)
        if not self._claude_command:
            self._claude_command = ["claude"]
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
        self._configured_provider = provider or None
        self.use_opencode_run = cfg.use_opencode_run
        runtime_raw = cfg.observer_runtime
        runtime = runtime_raw.strip().lower() if isinstance(runtime_raw, str) else "api_http"
        if runtime not in {"api_http", "claude_sidecar"}:
            runtime = "api_http"
        self.runtime = runtime
        self.opencode_model = cfg.opencode_model
        self.opencode_agent = cfg.opencode_agent
        self.observer_headers = dict(cfg.observer_headers or {})
        self.auth_adapter = ObserverAuthAdapter(
            source=cfg.observer_auth_source,
            file_path=cfg.observer_auth_file,
            command=tuple(cfg.observer_auth_command or []),
            timeout_ms=max(100, int(cfg.observer_auth_timeout_ms or 1500)),
            cache_ttl_s=max(0, int(cfg.observer_auth_cache_ttl_s or 300)),
        )
        self.auth = ObserverAuthMaterial(token=None, auth_type="none", source="none")
        if model:
            self.model = model
        elif resolved_provider == "anthropic":
            self.model = DEFAULT_ANTHROPIC_MODEL
        elif resolved_provider == "openai":
            self.model = DEFAULT_OPENAI_MODEL
        else:
            self.model = _resolve_custom_provider_default_model(resolved_provider) or ""
        if self.runtime == "claude_sidecar":
            self.model = self._sidecar_model
        self.api_key = cfg.observer_api_key or os.getenv("CODEMEM_OBSERVER_API_KEY")
        self.max_chars = cfg.observer_max_chars
        self.max_tokens = cfg.observer_max_tokens
        self.client: object | None = None
        self.codex_access: str | None = None
        self.codex_account_id: str | None = None

        if self.runtime == "api_http":
            self._init_provider_client(force_refresh=False)

    def _init_provider_client(self, *, force_refresh: bool) -> None:
        self.client = None
        self.codex_access = None
        self.codex_account_id = None

        oauth_cache = _load_opencode_oauth_cache()
        oauth_access = None
        oauth_expires = None
        oauth_provider = None
        if self.provider in {"openai", "anthropic"}:
            oauth_provider = _resolve_oauth_provider(self._configured_provider, self.model)
            oauth_access = _extract_oauth_access(oauth_cache, oauth_provider)
            oauth_expires = _extract_oauth_expires(oauth_cache, oauth_provider)
            if oauth_access and oauth_expires is not None and oauth_expires <= _now_ms():
                oauth_access = None
        if self.use_opencode_run:
            logger.info("observer auth: using opencode run")
            return

        if self.provider not in {"openai", "anthropic"}:
            provider_config = _get_opencode_provider_config(self.provider)
            base_url, model_id, headers = _resolve_custom_provider_model(
                self.provider,
                self.model,
            )
            if not base_url or not model_id:
                logger.warning("observer auth: missing custom provider config")
                return
            api_key = _get_provider_api_key(provider_config) or self.api_key
            merged_headers = dict(headers)
            merged_headers.update(self.observer_headers)
            self.auth = self.auth_adapter.resolve(
                explicit_token=api_key,
                env_tokens=(os.getenv("CODEMEM_OBSERVER_API_KEY") or "",),
                force_refresh=force_refresh,
            )
            rendered_headers = _render_observer_headers(merged_headers, self.auth)
            try:
                from openai import OpenAI  # type: ignore

                self.client = OpenAI(
                    api_key=self.auth.token or "unused",
                    base_url=base_url,
                    default_headers=rendered_headers or None,
                )
                self.model = model_id
            except Exception as exc:  # pragma: no cover
                logger.exception("observer auth: custom provider client init failed", exc_info=exc)
                self.client = None
        elif self.provider == "anthropic":
            self.auth = self.auth_adapter.resolve(
                explicit_token=self.api_key,
                env_tokens=(os.getenv("ANTHROPIC_API_KEY") or "",),
                oauth_token=oauth_access,
                force_refresh=force_refresh,
            )
            if not self.auth.token:
                logger.warning("observer auth: missing anthropic api key")
                return
            try:
                import anthropic  # type: ignore

                self.client = anthropic.Anthropic(api_key=self.auth.token)
            except Exception as exc:  # pragma: no cover
                logger.exception("observer auth: anthropic client init failed", exc_info=exc)
                self.client = None
        else:
            self.auth = self.auth_adapter.resolve(
                explicit_token=self.api_key,
                env_tokens=(
                    os.getenv("OPENCODE_API_KEY") or "",
                    os.getenv("OPENAI_API_KEY") or "",
                    os.getenv("CODEX_API_KEY") or "",
                ),
                oauth_token=oauth_access,
                force_refresh=force_refresh,
            )
            if self.auth.source == "oauth" and oauth_access:
                self.codex_access = oauth_access
                self.codex_account_id = _extract_oauth_account_id(
                    oauth_cache, oauth_provider or "openai"
                )
            if not self.auth.token:
                logger.warning("observer auth: missing openai api key")
                return
            try:
                from openai import OpenAI  # type: ignore

                self.client = OpenAI(api_key=self.auth.token)
            except Exception as exc:  # pragma: no cover
                logger.exception("observer auth: openai client init failed", exc_info=exc)
                self.client = None

    def _refresh_provider_client(self) -> bool:
        self.auth_adapter.invalidate_cache()
        self._init_provider_client(force_refresh=True)
        return self.client is not None or bool(self.codex_access)

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
        if self.runtime == "claude_sidecar":
            return self._call_claude_sidecar(prompt)
        try:
            return self._call_once(prompt)
        except ObserverAuthError as exc:
            logger.warning(
                "observer auth error: %s (provider=%s, model=%s)",
                exc,
                self.provider,
                self.model,
            )
            if not self._refresh_provider_client():
                raise
            return self._call_once(prompt)

    def _claude_sidecar_cmd(self, prompt: str, *, use_model: bool) -> list[str]:
        cmd = [
            *self._claude_command,
            "-p",
            "--output-format",
            "json",
            "--permission-mode",
            "bypassPermissions",
        ]
        if use_model and self._sidecar_model:
            cmd.extend(["--model", self._sidecar_model])
        cmd.append(prompt)
        return cmd

    def _invoke_claude_sidecar(
        self, prompt: str, *, use_model: bool
    ) -> tuple[str | None, str | None]:
        cmd = self._claude_sidecar_cmd(prompt, use_model=use_model)
        env = dict(os.environ)
        env.update(
            {
                "CODEMEM_PLUGIN_IGNORE": "1",
                "CODEMEM_VIEWER": "0",
                "CODEMEM_VIEWER_AUTO": "0",
                "CODEMEM_VIEWER_AUTO_STOP": "0",
            }
        )
        try:
            result = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=_CLAUDE_SIDECAR_TIMEOUT_S,
                env=env,
            )
        except FileNotFoundError:
            logger.warning(
                "observer claude_sidecar unavailable: configured claude command not found"
            )
            return None, "configured claude command not found"
        except subprocess.TimeoutExpired:
            logger.warning(
                "observer claude_sidecar timed out", extra={"timeout_s": _CLAUDE_SIDECAR_TIMEOUT_S}
            )
            return None, "claude sidecar call timed out"
        except Exception as exc:  # pragma: no cover
            logger.exception("observer claude_sidecar call failed", exc_info=exc)
            return None, str(exc)

        payload = _extract_claude_result_payload(result.stdout)
        if payload is not None:
            message = str(payload.get("result") or "").strip()
            is_error = bool(payload.get("is_error"))
            if is_error:
                return None, message or "claude sidecar returned an error"
            return (message or None), None

        if result.returncode != 0:
            message = (result.stderr or "").strip() or (result.stdout or "").strip()
            return None, message or f"claude sidecar exited with code {result.returncode}"

        text = (result.stdout or "").strip()
        return (text or None), None

    def _call_claude_sidecar(self, prompt: str) -> str | None:
        output, error = self._invoke_claude_sidecar(prompt, use_model=True)
        if error and self._sidecar_model and _is_claude_sidecar_model_error(error):
            logger.warning(
                "observer claude_sidecar model unsupported; retrying with default model",
                extra={"model": self._sidecar_model},
            )
            output, error = self._invoke_claude_sidecar(prompt, use_model=False)
        if error:
            if _is_claude_sidecar_auth_error(error):
                raise ObserverAuthError(error)
            logger.warning("observer claude_sidecar call failed: %s", error)
            return None
        return output

    def _call_once(self, prompt: str) -> str | None:
        if self.codex_access:
            return self._call_codex(prompt)
        if not self.client:
            self._refresh_provider_client()
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
            if _is_auth_error(exc):
                raise ObserverAuthError(str(exc)) from exc
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
                "CODEMEM_PLUGIN_IGNORE": "1",
                "CODEMEM_VIEWER": "0",
                "CODEMEM_VIEWER_AUTO": "0",
                "CODEMEM_VIEWER_AUTO_STOP": "0",
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
        if self.observer_headers:
            codex_auth = ObserverAuthMaterial(
                token=self.codex_access,
                auth_type="bearer",
                source=self.auth.source,
            )
            headers.update(_render_observer_headers(self.observer_headers, codex_auth))
        payload = _build_codex_payload(self.model, prompt, self.max_tokens)
        endpoint = _resolve_codex_endpoint()

        def _exc_chain(exc: BaseException, *, limit: int = 4) -> str:
            parts: list[str] = []
            seen: set[int] = set()
            cur: BaseException | None = exc
            while cur is not None and id(cur) not in seen and len(parts) < limit:
                seen.add(id(cur))
                message = str(cur)
                parts.append(
                    f"{cur.__class__.__name__}: {message}" if message else cur.__class__.__name__
                )
                cur = cur.__cause__ or cur.__context__
            return " | ".join(parts)

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
                    request_id = None
                    try:
                        request_id = response.headers.get("x-request-id") or response.headers.get(
                            "x-openai-request-id"
                        )
                    except Exception:
                        request_id = None
                    message = "observer codex oauth call failed"
                    if error_summary:
                        message = f"{message}: {error_summary}"
                    if response.status_code in (401, 403):
                        raise ObserverAuthError(message)
                    logger.error(
                        message,
                        extra={
                            "provider": self.provider,
                            "model": self.model,
                            "endpoint": endpoint,
                            "status": response.status_code,
                            "error": error_summary,
                            "request_id": request_id,
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

            request_url = None
            try:
                req = getattr(response, "request", None) or getattr(exc, "request", None)
                request_url = str(getattr(req, "url", None) or "") or None
            except Exception:
                request_url = None

            if status_code in (401, 403) or _is_auth_error(exc):
                raise ObserverAuthError(message) from exc
            logger.exception(
                message,
                extra={
                    "provider": self.provider,
                    "model": self.model,
                    "endpoint": endpoint,
                    "request_url": request_url,
                    "status": status_code,
                    "error": error_summary,
                    "exc_chain": _exc_chain(exc),
                    "exc_type": exc.__class__.__name__,
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
