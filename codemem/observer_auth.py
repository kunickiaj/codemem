from __future__ import annotations

import json
import logging
import os
import platform
import re
import time
from pathlib import Path
from typing import Any

from . import __version__

logger = logging.getLogger("codemem.observer")

_REDACT_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9]{10,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._-]{10,}"),
)


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
