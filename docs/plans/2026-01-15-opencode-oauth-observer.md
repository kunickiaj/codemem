# OpenCode OAuth Observer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-detect OpenCode OAuth cache for observer calls when API keys are absent, while preserving `opencode run` as an emergency fallback.

**Architecture:** Add a small OAuth cache loader that reads `~/.local/share/opencode/auth.json` on demand. Provider selection follows explicit config first, then model inference, then existing defaults. Use cached access tokens for OpenAI/Anthropic client init when API keys are missing; keep custom-gateway IAP flow unchanged. Preserve `opencode run` when explicitly enabled and no direct auth is available.

**Tech Stack:** Python 3.11+, OpenAI/Anthropic SDKs, pytest, ruff.

### Task 1: Add OAuth cache loader

**Files:**
- Modify: `opencode_mem/observer.py`
- Test: `tests/test_observer_auth.py`

**Step 1: Write the failing test**

```python
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from opencode_mem.observer import _load_opencode_oauth_cache


def test_loads_openai_oauth_cache(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "openai": {
                    "type": "oauth",
                    "access": "oa-access",
                    "refresh": "oa-refresh",
                    "expires": 9999999999999,
                }
            }
        )
    )
    with patch("opencode_mem.observer._get_opencode_auth_path", return_value=auth_path):
        data = _load_opencode_oauth_cache()
    assert data["openai"]["access"] == "oa-access"
```

**Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_observer_auth.py::test_loads_openai_oauth_cache -q`
Expected: FAIL with `ImportError` or missing symbol.

**Step 3: Write minimal implementation**

```python
from typing import Any


def _get_opencode_auth_path() -> Path:
    return Path.home() / ".local" / "share" / "opencode" / "auth.json"


def _load_opencode_oauth_cache() -> dict[str, Any]:
    path = _get_opencode_auth_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
```

**Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_observer_auth.py::test_loads_openai_oauth_cache -q`
Expected: PASS

**Step 5: Commit**

```bash
git add opencode_mem/observer.py tests/test_observer_auth.py
git commit -m "feat: load opencode oauth cache for observer"
```

### Task 2: Provider selection rules

**Files:**
- Modify: `opencode_mem/observer.py`
- Test: `tests/test_observer_auth.py`

**Step 1: Write the failing test**

```python
from opencode_mem.observer import _resolve_oauth_provider


def test_provider_resolves_from_model() -> None:
    assert _resolve_oauth_provider(None, "claude-4.5-haiku") == "anthropic"
    assert _resolve_oauth_provider(None, "gpt-5.1-codex-mini") == "openai"


def test_provider_respects_config_override() -> None:
    assert _resolve_oauth_provider("anthropic", "gpt-5.1-codex-mini") == "anthropic"
```

**Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_observer_auth.py::test_provider_resolves_from_model -q`
Expected: FAIL

**Step 3: Write minimal implementation**

```python

def _resolve_oauth_provider(configured: str | None, model: str) -> str:
    if configured:
        return configured.lower()
    if model.lower().startswith("claude"):
        return "anthropic"
    return "openai"
```

**Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_observer_auth.py::test_provider_resolves_from_model -q`
Expected: PASS

**Step 5: Commit**

```bash
git add opencode_mem/observer.py tests/test_observer_auth.py
git commit -m "feat: infer oauth provider for observer"
```

### Task 3: Use OAuth tokens for client init

**Files:**
- Modify: `opencode_mem/observer.py`
- Test: `tests/test_observer_auth.py`

**Step 1: Write the failing test**

```python
from unittest.mock import patch


def test_openai_client_uses_oauth_token(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "openai": {
                    "type": "oauth",
                    "access": "oa-access",
                    "refresh": "oa-refresh",
                    "expires": 9999999999999,
                }
            }
        )
    )
    with patch("opencode_mem.observer._get_opencode_auth_path", return_value=auth_path):
        with patch("opencode_mem.observer.OpenAI") as mock_openai:
            from opencode_mem.observer import ObserverClient

            client = ObserverClient()
            assert client.client is not None
            mock_openai.assert_called_once()
            _, kwargs = mock_openai.call_args
            assert kwargs["api_key"] == "oa-access"
```

**Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_observer_auth.py::test_openai_client_uses_oauth_token -q`
Expected: FAIL

**Step 3: Write minimal implementation**

```python
from typing import Optional


def _extract_oauth_access(cache: dict[str, Any], provider: str) -> Optional[str]:
    entry = cache.get(provider, {})
    access = entry.get("access") if isinstance(entry, dict) else None
    return access if isinstance(access, str) and access else None
```

Use the access token for `OpenAI(api_key=...)` or `anthropic.Anthropic(api_key=...)` when API key is missing.

**Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_observer_auth.py::test_openai_client_uses_oauth_token -q`
Expected: PASS

**Step 5: Commit**

```bash
git add opencode_mem/observer.py tests/test_observer_auth.py
git commit -m "feat: prefer oauth cache tokens for observer clients"
```

### Task 4: Preserve `opencode run` fallback

**Files:**
- Modify: `opencode_mem/observer.py`
- Test: `tests/test_observer_auth.py`

**Step 1: Write the failing test**

```python
from unittest.mock import patch


def test_opencode_run_fallback_when_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENCODE_API_KEY", raising=False)
    monkeypatch.delenv("OPENCODE_MEM_OBSERVER_API_KEY", raising=False)
    with patch("opencode_mem.observer._load_opencode_oauth_cache", return_value={}):
        from opencode_mem.config import OpencodeMemConfig
        from opencode_mem.observer import ObserverClient

        with patch("opencode_mem.observer.load_config", return_value=OpencodeMemConfig(use_opencode_run=True)):
            client = ObserverClient()
            assert client.use_opencode_run is True
```

**Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_observer_auth.py::test_opencode_run_fallback_when_no_auth -q`
Expected: FAIL

**Step 3: Write minimal implementation**

Keep `use_opencode_run` behavior intact, but only return early once OAuth cache is considered.

**Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_observer_auth.py::test_opencode_run_fallback_when_no_auth -q`
Expected: PASS

**Step 5: Commit**

```bash
git add opencode_mem/observer.py tests/test_observer_auth.py
git commit -m "test: ensure opencode run remains fallback"
```

### Task 5: Documentation

**Files:**
- Modify: `README.md`

**Step 1: Update configuration docs**

Add notes:
- Observer auto-detects OpenCode OAuth cache at `~/.local/share/opencode/auth.json` when API keys are absent.
- Provider chosen from `observer_provider` or inferred from model.
- `OPENCODE_MEM_USE_OPENCODE_RUN` remains optional fallback.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document observer oauth cache usage"
```

### Task 6: Final verification

Run:
- `uv run pytest`
- `uv run ruff check opencode_mem tests`
- `uv run ruff format --check opencode_mem tests`

Expected: All pass.

### Execution Handoff

Plan complete and saved to `docs/plans/2026-01-15-opencode-oauth-observer.md`. Two execution options:

1. **Subagent-Driven (this session)** — dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Parallel Session (separate)** — open new session with executing-plans, batch execution with checkpoints

Which approach?