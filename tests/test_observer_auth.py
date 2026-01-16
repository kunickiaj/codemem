import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from opencode_mem.config import OpencodeMemConfig
from opencode_mem.observer import _load_opencode_oauth_cache, _resolve_oauth_provider


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
                }
            }
        )
    )
    with patch("opencode_mem.observer._get_opencode_auth_path", return_value=auth_path):
        data = _load_opencode_oauth_cache()
    assert data["openai"]["access"] == "oa-access"


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
        patch("opencode_mem.observer.load_config", return_value=cfg),
        patch("opencode_mem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
        patch.dict(sys.modules, {"openai": openai_module}),
    ):
        from opencode_mem.observer import ObserverClient

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
        patch("opencode_mem.observer.load_config", return_value=cfg),
        patch("opencode_mem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
        patch.dict(sys.modules, {"anthropic": anthropic_module}),
    ):
        from opencode_mem.observer import ObserverClient

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
        patch("opencode_mem.observer.load_config", return_value=cfg),
        patch("opencode_mem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
        patch.dict(sys.modules, {"openai": openai_module}),
    ):
        from opencode_mem.observer import ObserverClient

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
    from opencode_mem.observer import _extract_oauth_access

    assert _extract_oauth_access(payload, "openai") == expected


def test_opencode_run_enabled_when_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENCODE_API_KEY", raising=False)
    monkeypatch.delenv("OPENCODE_MEM_OBSERVER_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with (
        patch("opencode_mem.observer._load_opencode_oauth_cache", return_value={}),
        patch(
            "opencode_mem.observer.load_config",
            return_value=OpencodeMemConfig(use_opencode_run=True),
        ),
    ):
        from opencode_mem.observer import ObserverClient

        client = ObserverClient()
        assert client.use_opencode_run is True
        assert client.client is None
