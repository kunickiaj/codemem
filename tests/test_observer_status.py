from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from codemem.config import OpencodeMemConfig
from codemem.observer import ObserverClient, probe_available_credentials


def test_probe_finds_openai_oauth(tmp_path: Path) -> None:
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
    with (
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
    ):
        result = probe_available_credentials()
    assert result["openai"]["oauth"] is True
    assert result["openai"]["env_var"] is False
    assert result["anthropic"]["oauth"] is False


def test_probe_finds_anthropic_oauth(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "anthropic": {
                    "type": "oauth",
                    "access": "anth-access",
                    "refresh": "anth-refresh",
                    "expires": 9999999999999,
                }
            }
        )
    )
    with (
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
    ):
        result = probe_available_credentials()
    assert result["anthropic"]["oauth"] is True
    assert result["openai"]["oauth"] is False


def test_probe_finds_both_oauth(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "openai": {
                    "type": "oauth",
                    "access": "oa-access",
                    "refresh": "oa-refresh",
                    "expires": 9999999999999,
                },
                "anthropic": {
                    "type": "oauth",
                    "access": "anth-access",
                    "refresh": "anth-refresh",
                    "expires": 9999999999999,
                },
            }
        )
    )
    with (
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
    ):
        result = probe_available_credentials()
    assert result["openai"]["oauth"] is True
    assert result["anthropic"]["oauth"] is True


def test_probe_detects_expired_oauth(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "anthropic": {
                    "type": "oauth",
                    "access": "anth-access",
                    "refresh": "anth-refresh",
                    "expires": 1000,  # long expired
                }
            }
        )
    )
    with (
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
    ):
        result = probe_available_credentials()
    assert result["anthropic"]["oauth"] is False


def test_probe_detects_env_vars(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text("{}")
    with (
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict(
            "os.environ",
            {"OPENAI_API_KEY": "sk-test", "ANTHROPIC_API_KEY": "ant-test"},
            clear=True,
        ),
    ):
        result = probe_available_credentials()
    assert result["openai"]["env_var"] is True
    assert result["anthropic"]["env_var"] is True
    assert result["openai"]["oauth"] is False
    assert result["anthropic"]["oauth"] is False


def test_probe_detects_explicit_api_key(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text("{}")
    with (
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {"CODEMEM_OBSERVER_API_KEY": "explicit"}, clear=True),
    ):
        result = probe_available_credentials()
    assert result["openai"]["api_key"] is True
    assert result["anthropic"]["api_key"] is True


def test_get_status_anthropic_consumer(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "anthropic": {
                    "type": "oauth",
                    "access": "anth-access",
                    "refresh": "anth-refresh",
                    "expires": 9999999999999,
                }
            }
        )
    )
    cfg = OpencodeMemConfig(observer_api_key=None, observer_provider="anthropic")
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
    ):
        client = ObserverClient()
        status = client.get_status()
    assert status["provider"] == "anthropic"
    assert status["auth"]["method"] == "anthropic_consumer"
    assert status["auth"]["source"] == "oauth"
    assert status["auth"]["token_present"] is True


def test_get_status_claude_sidecar() -> None:
    cfg = OpencodeMemConfig(observer_runtime="claude_sidecar")
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
    ):
        client = ObserverClient()
        status = client.get_status()
    assert status["runtime"] == "claude_sidecar"
    assert status["auth"]["method"] == "claude_sidecar"


def test_get_status_no_auth() -> None:
    cfg = OpencodeMemConfig(observer_api_key=None, observer_provider="anthropic")
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch.dict("os.environ", {}, clear=True),
    ):
        client = ObserverClient()
        status = client.get_status()
    assert status["auth"]["method"] == "none"
    assert status["auth"]["token_present"] is False
