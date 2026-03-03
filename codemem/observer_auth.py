from __future__ import annotations

import json
import logging
import os
import platform
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import __version__

logger = logging.getLogger("codemem.observer")

_REDACT_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9]{10,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._-]{10,}"),
)
_AUTH_TOKEN_TEMPLATE = re.compile(r"\$\{auth\.token\}")
_AUTH_TYPE_TEMPLATE = re.compile(r"\$\{auth\.type\}")
_AUTH_SOURCE_TEMPLATE = re.compile(r"\$\{auth\.source\}")


def _get_iap_token() -> str | None:
    """Get IAP token from environment (set by iap-auth plugin)."""
    return os.getenv("IAP_AUTH_TOKEN")


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
    # Mirror OpenCode's Codex transport headers as closely as we can.
    # These are safe metadata headers; do not add anything that could leak secrets.
    originator = os.getenv("CODEMEM_CODEX_ORIGINATOR", "opencode")
    user_agent = os.getenv(
        "CODEMEM_CODEX_USER_AGENT",
        f"codemem/{__version__} ({platform.system()} {platform.release()}; {platform.machine()})",
    )

    headers = {
        "authorization": f"Bearer {access_token}",
        "originator": originator,
        "User-Agent": user_agent,
        "accept": "text/event-stream",
    }
    if account_id:
        headers["ChatGPT-Account-Id"] = account_id
    return headers


def _redact_text(text: str, limit: int = 400) -> str:
    redacted = text
    for pattern in _REDACT_PATTERNS:
        redacted = pattern.sub("[redacted]", redacted)
    if len(redacted) > limit:
        return f"{redacted[:limit]}…"
    return redacted


def _normalize_auth_source(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    if normalized in {"", "auto", "env", "file", "command", "none"}:
        return normalized or "auto"
    return "auto"


def _run_auth_command(command: tuple[str, ...], timeout_ms: int) -> str | None:
    if not command:
        return None
    timeout_s = max(0.1, timeout_ms / 1000.0)
    try:
        result = subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        logger.warning(
            "observer auth command timed out",
            extra={"command": command[0], "timeout_ms": timeout_ms},
            exc_info=exc,
        )
        return None
    except Exception as exc:
        logger.warning(
            "observer auth command failed",
            extra={"command": command[0]},
            exc_info=exc,
        )
        return None

    if result.returncode != 0:
        logger.warning(
            "observer auth command returned non-zero",
            extra={
                "command": command[0],
                "returncode": result.returncode,
                "stderr": _redact_text((result.stderr or "").strip()),
            },
        )
        return None

    token = (result.stdout or "").strip()
    return token or None


def _read_auth_file(file_path: str | None) -> str | None:
    if not file_path:
        return None
    path = Path(os.path.expanduser(os.path.expandvars(file_path))).resolve()
    if not path.exists() or not path.is_file():
        return None
    try:
        token = path.read_text().strip()
    except Exception as exc:
        logger.warning("observer auth file read failed", extra={"path": str(path)}, exc_info=exc)
        return None
    return token or None


@dataclass(frozen=True)
class ObserverAuthMaterial:
    token: str | None
    auth_type: str = "none"
    source: str = "none"


@dataclass
class ObserverAuthAdapter:
    source: str = "auto"
    file_path: str | None = None
    command: tuple[str, ...] = ()
    timeout_ms: int = 1500
    cache_ttl_s: int = 300
    _cached: ObserverAuthMaterial = field(
        default_factory=lambda: ObserverAuthMaterial(token=None, auth_type="none", source="none")
    )
    _cached_at_monotonic_s: float = 0.0

    def resolve(
        self,
        *,
        explicit_token: str | None = None,
        env_tokens: tuple[str, ...] = (),
        oauth_token: str | None = None,
        force_refresh: bool = False,
    ) -> ObserverAuthMaterial:
        source = _normalize_auth_source(self.source)

        if source == "none":
            return ObserverAuthMaterial(token=None, auth_type="none", source="none")

        if not force_refresh and source in {"command", "file"} and self.cache_ttl_s > 0:
            age_s = time.monotonic() - self._cached_at_monotonic_s
            if self._cached_at_monotonic_s > 0 and age_s <= self.cache_ttl_s:
                return self._cached

        token = None
        token_source = "none"
        if source in {"auto", "env"}:
            if explicit_token:
                token = explicit_token
                token_source = "explicit"
            if not token:
                token = next((value for value in env_tokens if value), None)
                if token:
                    token_source = "env"
            if not token and oauth_token and source == "auto":
                token = oauth_token
                token_source = "oauth"

        if source in {"auto", "file"} and not token:
            token = _read_auth_file(self.file_path)
            if token:
                token_source = "file"

        if source in {"auto", "command"} and not token:
            token = _run_auth_command(self.command, self.timeout_ms)
            if token:
                token_source = "command"

        resolved = (
            ObserverAuthMaterial(token=token, auth_type="bearer", source=token_source)
            if token
            else ObserverAuthMaterial(token=None, auth_type="none", source="none")
        )

        should_cache = source in {"command", "file"}
        if should_cache and resolved.token:
            self._cached = resolved
            self._cached_at_monotonic_s = time.monotonic()
        elif should_cache:
            self.invalidate_cache()
        return resolved

    def invalidate_cache(self) -> None:
        self._cached = ObserverAuthMaterial(token=None, auth_type="none", source="none")
        self._cached_at_monotonic_s = 0.0


def _render_observer_headers(
    headers: dict[str, str],
    auth: ObserverAuthMaterial,
) -> dict[str, str]:
    rendered: dict[str, str] = {}
    token = auth.token or ""
    for key, value in headers.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        candidate = _AUTH_TOKEN_TEMPLATE.sub(token, value)
        candidate = _AUTH_TYPE_TEMPLATE.sub(auth.auth_type, candidate)
        candidate = _AUTH_SOURCE_TEMPLATE.sub(auth.source, candidate)
        if "${auth.token}" in value and not token:
            continue
        cleaned = candidate.strip()
        if not cleaned:
            continue
        rendered[key] = cleaned
    return rendered
