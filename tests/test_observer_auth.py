import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from codemem.config import OpencodeMemConfig
from codemem.observer import (
    _build_codex_headers,
    _extract_oauth_account_id,
    _extract_oauth_expires,
    _get_provider_api_key,
    _get_provider_headers,
    _load_opencode_oauth_cache,
    _resolve_oauth_provider,
)


class OpenAIStub:
    def __init__(self, **_kwargs: object) -> None:
        self.kwargs = _kwargs


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
                    "accountId": "acc-123",
                }
            }
        )
    )
    with patch("codemem.observer._get_opencode_auth_path", return_value=auth_path):
        data = _load_opencode_oauth_cache()
    assert data["openai"]["access"] == "oa-access"
    assert _extract_oauth_account_id(data, "openai") == "acc-123"
    assert _extract_oauth_expires(data, "openai") == 9999999999999


def test_provider_resolves_from_model() -> None:
    assert _resolve_oauth_provider(None, "claude-4.5-haiku") == "anthropic"
    assert _resolve_oauth_provider(None, "gpt-5.1-codex-mini") == "openai"


def test_provider_respects_config_override() -> None:
    assert _resolve_oauth_provider("anthropic", "gpt-5.1-codex-mini") == "anthropic"


def test_oauth_provider_uses_model_when_config_missing() -> None:
    assert _resolve_oauth_provider(None, "claude-4.5-haiku") == "anthropic"
    assert _resolve_oauth_provider(None, "gpt-5.1-codex-mini") == "openai"


def test_oauth_provider_prefers_runtime_provider() -> None:
    assert _resolve_oauth_provider("anthropic", "gpt-5.1-codex-mini") == "anthropic"
    assert _resolve_oauth_provider("openai", "claude-4.5-haiku") == "openai"


def test_oauth_provider_uses_model_when_provider_invalid() -> None:
    assert _resolve_oauth_provider("unknown", "claude-4.5-haiku") == "anthropic"


def test_openai_client_uses_oauth_token_when_api_key_missing(tmp_path: Path) -> None:
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
    cfg = OpencodeMemConfig(observer_api_key=None, observer_provider="openai")
    openai_module = SimpleNamespace(OpenAI=OpenAIStub)
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
        patch.dict(sys.modules, {"openai": openai_module}),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()
        assert client.client is not None
        assert isinstance(client.client, OpenAIStub)
        assert client.client.kwargs["api_key"] == "oa-access"


def test_anthropic_client_uses_oauth_token_when_api_key_missing(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "anthropic": {
                    "type": "oauth",
                    "access": "anthropic-access",
                    "refresh": "anthropic-refresh",
                    "expires": 9999999999999,
                }
            }
        )
    )
    anthropic_module = SimpleNamespace(Anthropic=Mock())
    cfg = OpencodeMemConfig(observer_api_key=None, observer_provider="anthropic")
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
        patch.dict(sys.modules, {"anthropic": anthropic_module}),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()
        assert client.client is not None
        anthropic_module.Anthropic.assert_called_once_with(api_key="anthropic-access")


def test_oauth_skips_when_api_key_present(tmp_path: Path) -> None:
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
    cfg = OpencodeMemConfig(observer_api_key="cfg-key", observer_provider="openai")
    openai_module = SimpleNamespace(OpenAI=OpenAIStub)
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
        patch.dict(sys.modules, {"openai": openai_module}),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()
        assert client.client is not None
        assert isinstance(client.client, OpenAIStub)
        assert client.client.kwargs["api_key"] == "cfg-key"


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"openai": {"access": "token"}}, "token"),
        ({"openai": {"access": ""}}, None),
        ({"openai": {"access": None}}, None),
        ({"openai": "oops"}, None),
        ({}, None),
    ],
)
def test_extract_oauth_access(payload: dict, expected: str | None) -> None:
    from codemem.observer import _extract_oauth_access

    assert _extract_oauth_access(payload, "openai") == expected


def test_build_codex_headers_includes_account_id() -> None:
    headers = _build_codex_headers("token", "acc-123")
    assert headers["authorization"] == "Bearer token"
    assert headers["ChatGPT-Account-Id"] == "acc-123"
    assert headers["originator"]
    assert headers["User-Agent"].startswith("codemem/")


def test_build_codex_headers_without_account_id() -> None:
    headers = _build_codex_headers("token", None)
    assert headers["authorization"] == "Bearer token"
    assert "ChatGPT-Account-Id" not in headers
    assert headers["originator"]
    assert headers["User-Agent"].startswith("codemem/")


def test_provider_headers_resolve_file_placeholders(tmp_path: Path) -> None:
    token_path = tmp_path / "token.txt"
    token_path.write_text("secret-token")
    provider_config = {
        "options": {
            "headers": {"Authorization": f"Bearer {{file:{token_path}}}"},
        }
    }
    headers = _get_provider_headers(provider_config)
    assert headers["Authorization"] == "Bearer secret-token"


def test_provider_api_key_resolves_file_placeholders(tmp_path: Path) -> None:
    token_path = tmp_path / "token.txt"
    token_path.write_text("secret-token")
    provider_config = {
        "options": {"apiKey": f"{{file:{token_path}}}"},
    }
    api_key = _get_provider_api_key(provider_config)
    assert api_key == "secret-token"


def test_codex_payload_uses_input_schema() -> None:
    from codemem.observer import _build_codex_payload

    payload = _build_codex_payload("gpt-5.1-codex-mini", "hello", 42)
    assert payload["model"] == "gpt-5.1-codex-mini"
    assert payload["input"][0]["role"] == "user"
    assert payload["input"][0]["content"][0]["text"] == "hello"
    assert payload["store"] is False
    assert payload["stream"] is True


def test_opencode_run_enabled_when_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENCODE_API_KEY", raising=False)
    monkeypatch.delenv("CODEMEM_OBSERVER_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with (
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch(
            "codemem.observer.load_config",
            return_value=OpencodeMemConfig(use_opencode_run=True),
        ),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()
        assert client.use_opencode_run is True
        assert client.client is None
