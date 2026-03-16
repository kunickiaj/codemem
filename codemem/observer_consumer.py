from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .observer_auth import _redact_text

logger = logging.getLogger("codemem.observer")


@dataclass(frozen=True)
class ConsumerConfig:
    """Provider-specific pieces needed by the shared streaming consumer."""

    provider_name: str
    headers: dict[str, str]
    payload: dict[str, Any]
    url: str
    stream_parser: Callable[..., str | None]
    auth_error_message: str
    request_error_message: str
    error_prefix: str
    request_id_headers: list[str] = field(default_factory=list)
    error_detail_extractor: Callable[[str | None], dict[str, str] | None] | None = None


def _exc_chain(exc: BaseException, *, limit: int = 4) -> str:
    """Walk the exception chain and return a condensed summary string."""
    parts: list[str] = []
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen and len(parts) < limit:
        seen.add(id(cur))
        message = str(cur)
        parts.append(f"{cur.__class__.__name__}: {message}" if message else cur.__class__.__name__)
        cur = cur.__cause__ or cur.__context__
    return " | ".join(parts)


def call_streaming_consumer(
    config: ConsumerConfig,
    *,
    model: str,
    provider: str,
    set_last_error: Callable[..., None],
    is_auth_error: Callable[[Exception], bool],
    auth_error_class: type[Exception],
) -> str | None:
    """Shared httpx streaming POST with error handling for observer consumers.

    Raises *auth_error_class* on 401/403 or SDK-level auth errors so the
    caller can propagate without catching.
    """
    import httpx

    def _resolve_request_id(headers: Any) -> str | None:
        try:
            for name in config.request_id_headers:
                value = headers.get(name)
                if value:
                    return value
        except Exception:
            pass
        return None

    def _handle_auth_error(
        message: str,
        details: dict[str, str] | None,
        *,
        cause: BaseException | None = None,
    ) -> None:
        if isinstance(details, dict):
            set_last_error(details["message"], code=details["code"])
        else:
            set_last_error(config.auth_error_message, code="auth_failed")
        if cause is not None:
            raise auth_error_class(message) from cause
        raise auth_error_class(message)

    def _handle_request_error(
        message: str,
        details: dict[str, str] | None,
    ) -> None:
        if isinstance(details, dict):
            set_last_error(details["message"], code=details["code"])
        else:
            set_last_error(config.request_error_message, code="provider_request_failed")

    def _extract_details(error_text: str | None) -> dict[str, str] | None:
        if config.error_detail_extractor is not None:
            return config.error_detail_extractor(error_text)
        return None

    try:
        with (
            httpx.Client(timeout=60) as client,
            client.stream(
                "POST",
                config.url,
                json=config.payload,
                headers=config.headers,
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
                request_id = _resolve_request_id(response.headers)
                message = config.error_prefix
                if error_summary:
                    message = f"{message}: {error_summary}"
                details = _extract_details(error_text)
                if response.status_code in (401, 403):
                    _handle_auth_error(message, details)
                logger.error(
                    message,
                    extra={
                        "provider": provider,
                        "model": model,
                        "endpoint": config.url,
                        "status": response.status_code,
                        "error": error_summary,
                        "request_id": request_id,
                    },
                )
                _handle_request_error(message, details)
                return None
            response.raise_for_status()
            return config.stream_parser(response)
    except auth_error_class:
        raise
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
        message = config.error_prefix
        if error_summary:
            message = f"{message}: {error_summary}"
        details = _extract_details(error_text)

        request_url = None
        try:
            req = getattr(response, "request", None) or getattr(exc, "request", None)
            request_url = str(getattr(req, "url", None) or "") or None
        except Exception:
            request_url = None

        if status_code in (401, 403) or is_auth_error(exc):
            _handle_auth_error(message, details, cause=exc)
        logger.exception(
            message,
            extra={
                "provider": provider,
                "model": model,
                "endpoint": config.url,
                "request_url": request_url,
                "status": status_code,
                "error": error_summary,
                "exc_chain": _exc_chain(exc),
                "exc_type": exc.__class__.__name__,
            },
            exc_info=exc,
        )
        _handle_request_error(message, details)
        return None
