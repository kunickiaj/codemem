import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from codemem.config import OpencodeMemConfig
from codemem.observer import (
    DEFAULT_ANTHROPIC_MODEL,
    ObserverAuthError,
    _build_codex_headers,
    _extract_oauth_account_id,
    _extract_oauth_expires,
    _get_provider_api_key,
    _get_provider_headers,
    _load_opencode_oauth_cache,
    _resolve_oauth_provider,
)
from codemem.observer_auth import (
    ObserverAuthAdapter,
    ObserverAuthMaterial,
    _render_observer_headers,
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


def test_auth_adapter_command_source_caches_until_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = ObserverAuthAdapter(
        source="command",
        command=("iap-auth",),
        timeout_ms=1000,
        cache_ttl_s=300,
    )
    calls: list[int] = []

    def fake_run(_cmd: tuple[str, ...], _timeout_ms: int) -> str:
        calls.append(1)
        return "token-a"

    monkeypatch.setattr("codemem.observer_auth._run_auth_command", fake_run)

    first = adapter.resolve()
    second = adapter.resolve()

    assert first.token == "token-a"
    assert second.token == "token-a"
    assert len(calls) == 1


def test_auth_adapter_command_force_refresh_bypasses_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = ObserverAuthAdapter(
        source="command",
        command=("iap-auth",),
        timeout_ms=1000,
        cache_ttl_s=300,
    )
    tokens = iter(["token-a", "token-b"])

    def fake_run(_cmd: tuple[str, ...], _timeout_ms: int) -> str:
        return next(tokens)

    monkeypatch.setattr("codemem.observer_auth._run_auth_command", fake_run)

    first = adapter.resolve()
    second = adapter.resolve(force_refresh=True)

    assert first.token == "token-a"
    assert second.token == "token-b"


def test_auth_adapter_command_source_does_not_cache_failed_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = ObserverAuthAdapter(
        source="command",
        command=("iap-auth",),
        timeout_ms=1000,
        cache_ttl_s=300,
    )
    calls: list[int] = []
    tokens = iter([None, "token-b"])

    def fake_run(_cmd: tuple[str, ...], _timeout_ms: int) -> str | None:
        calls.append(1)
        return next(tokens)

    monkeypatch.setattr("codemem.observer_auth._run_auth_command", fake_run)

    first = adapter.resolve()
    second = adapter.resolve()

    assert first.token is None
    assert second.token == "token-b"
    assert len(calls) == 2


def test_auth_adapter_env_source_uses_environment_tokens_only() -> None:
    adapter = ObserverAuthAdapter(source="env")

    resolved = adapter.resolve(explicit_token="config-token", env_tokens=("env-token",))

    assert resolved.token == "env-token"
    assert resolved.source == "env"


def test_auth_adapter_env_source_ignores_explicit_token_when_env_missing() -> None:
    adapter = ObserverAuthAdapter(source="env")

    resolved = adapter.resolve(explicit_token="config-token", env_tokens=())

    assert resolved.token is None
    assert resolved.source == "none"


def test_custom_provider_none_auth_source_does_not_use_api_key() -> None:
    cfg = OpencodeMemConfig(
        observer_provider="gateway",
        observer_model="gateway-model",
        observer_api_key="should-not-be-used",
        observer_auth_source="none",
    )
    openai_module = SimpleNamespace(OpenAI=OpenAIStub)
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch("codemem.observer._list_custom_providers", return_value={"gateway"}),
        patch("codemem.observer._get_opencode_provider_config", return_value={}),
        patch(
            "codemem.observer._resolve_custom_provider_model",
            return_value=("https://gateway.example/v1", "gateway-model", {}),
        ),
        patch("codemem.observer._get_provider_api_key", return_value=None),
        patch.dict(sys.modules, {"openai": openai_module}),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()

    assert isinstance(client.client, OpenAIStub)
    assert client.client.kwargs["api_key"] == "unused"
    assert client.auth.token is None
    assert client.auth.source == "none"


def test_observer_retries_auth_resolution_when_client_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = OpencodeMemConfig(
        observer_provider="openai",
        observer_auth_source="command",
        observer_auth_command=["iap-auth"],
    )
    tokens = iter([None, "token-2"])

    def fake_run(_cmd: tuple[str, ...], _timeout_ms: int) -> str | None:
        return next(tokens)

    class OpenAIWithChatStub:
        def __init__(self, **_kwargs: object) -> None:
            self.kwargs = _kwargs

            class _Completions:
                def create(self, **_payload: object) -> object:
                    return SimpleNamespace(
                        choices=[SimpleNamespace(message=SimpleNamespace(content="observer-ok"))]
                    )

            self.chat = SimpleNamespace(completions=_Completions())

    monkeypatch.setattr("codemem.observer_auth._run_auth_command", fake_run)
    openai_module = SimpleNamespace(OpenAI=OpenAIWithChatStub)
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch.dict(sys.modules, {"openai": openai_module}),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()
        assert client.client is None
        output = client._call("hello")

    assert output == "observer-ok"


def _claude_sidecar_payload(*, result: str, is_error: bool = False) -> str:
    return json.dumps(
        {
            "type": "result",
            "subtype": "success",
            "is_error": is_error,
            "result": result,
        }
    )


def test_observer_runtime_claude_sidecar_uses_sidecar_call() -> None:
    cfg = OpencodeMemConfig(
        observer_runtime="claude_sidecar",
    )
    run_mock = Mock(
        return_value=subprocess.CompletedProcess(
            args=["claude"],
            returncode=0,
            stdout=_claude_sidecar_payload(result="hello from sidecar"),
            stderr="",
        )
    )
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch("codemem.observer.subprocess.run", run_mock),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()
        output = client._call("hello")

    assert client.runtime == "claude_sidecar"
    assert client.client is None
    assert output == "hello from sidecar"
    assert run_mock.call_count == 1
    called_cmd = run_mock.call_args.args[0]
    assert called_cmd[:4] == ["claude", "-p", "--output-format", "json"]
    assert "--model" in called_cmd
    assert DEFAULT_ANTHROPIC_MODEL in called_cmd


def test_observer_runtime_claude_sidecar_retries_without_model_on_model_error() -> None:
    cfg = OpencodeMemConfig(
        observer_runtime="claude_sidecar",
        observer_model="claude-4.5-haiku",
    )
    run_mock = Mock(
        side_effect=[
            subprocess.CompletedProcess(
                args=["claude"],
                returncode=0,
                stdout=_claude_sidecar_payload(
                    result=(
                        "There's an issue with the selected model (claude-4.5-haiku). "
                        "Run --model to pick a different model."
                    ),
                    is_error=True,
                ),
                stderr="",
            ),
            subprocess.CompletedProcess(
                args=["claude"],
                returncode=0,
                stdout=_claude_sidecar_payload(result="hello from fallback"),
                stderr="",
            ),
        ]
    )
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch("codemem.observer.subprocess.run", run_mock),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()
        output = client._call("hello")

    assert output == "hello from fallback"
    assert run_mock.call_count == 2
    first_cmd = run_mock.call_args_list[0].args[0]
    second_cmd = run_mock.call_args_list[1].args[0]
    assert "--model" in first_cmd
    assert "claude-4.5-haiku" in first_cmd
    assert "--model" not in second_cmd


def test_observer_runtime_claude_sidecar_raises_auth_error() -> None:
    cfg = OpencodeMemConfig(observer_runtime="claude_sidecar")
    run_mock = Mock(
        return_value=subprocess.CompletedProcess(
            args=["claude"],
            returncode=0,
            stdout=_claude_sidecar_payload(result="Please login first.", is_error=True),
            stderr="",
        )
    )
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch("codemem.observer.subprocess.run", run_mock),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()
        with pytest.raises(ObserverAuthError):
            client._call("hello")


def test_observer_runtime_non_string_falls_back_to_api_http() -> None:
    cfg = OpencodeMemConfig(observer_provider="openai", observer_api_key="stub-key")
    cfg.observer_runtime = 1  # type: ignore[assignment]
    openai_module = SimpleNamespace(OpenAI=OpenAIStub)
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch.dict(sys.modules, {"openai": openai_module}),
    ):
        from codemem.observer import ObserverClient

        client = ObserverClient()

    assert client.runtime == "api_http"


def test_render_observer_headers_injects_auth_token() -> None:
    auth = ObserverAuthMaterial(token="secret-token", auth_type="bearer", source="command")
    headers = _render_observer_headers(
        {
            "Authorization": "Bearer ${auth.token}",
            "X-Auth-Source": "${auth.source}",
        },
        auth,
    )

    assert headers["Authorization"] == "Bearer secret-token"
    assert headers["X-Auth-Source"] == "command"


def test_render_observer_headers_skips_token_placeholder_when_missing() -> None:
    auth = ObserverAuthMaterial(token=None, auth_type="none", source="none")
    headers = _render_observer_headers(
        {
            "Authorization": "Bearer ${auth.token}",
            "X-Mode": "${auth.type}",
        },
        auth,
    )

    assert "Authorization" not in headers
    assert headers["X-Mode"] == "none"
