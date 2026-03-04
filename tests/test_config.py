import json
from pathlib import Path

import pytest

from codemem.config import (
    get_config_path,
    get_env_overrides,
    load_config,
    read_config_file,
    write_config_file,
)


def test_read_config_file_rejects_invalid_json(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{not-json}")
    with pytest.raises(ValueError, match="invalid config json"):
        read_config_file(config_path)


def test_read_config_file_accepts_jsonc_comments_and_trailing_commas(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        """
        {
          // comment should be ignored
          "observer_provider": "openai",
          "observer_model": "gpt-5.1-codex-mini",
        }
        """
    )

    data = read_config_file(config_path)

    assert data["observer_provider"] == "openai"
    assert data["observer_model"] == "gpt-5.1-codex-mini"


def test_read_config_file_accepts_jsonc_block_comments(tmp_path: Path) -> None:
    config_path = tmp_path / "config.jsonc"
    config_path.write_text(
        """
        {
          /* block comment */
          "observer_provider": "anthropic",
        }
        """
    )

    data = read_config_file(config_path)

    assert data["observer_provider"] == "anthropic"


def test_read_config_file_preserves_comment_like_text_inside_strings(tmp_path: Path) -> None:
    config_path = tmp_path / "config.jsonc"
    config_path.write_text(
        """
        {
          "note": "not // a comment, keep comma, and slash",
          "url": "https://example.com/a,b",
        }
        """
    )

    data = read_config_file(config_path)

    assert data["note"] == "not // a comment, keep comma, and slash"
    assert data["url"] == "https://example.com/a,b"


def test_read_config_file_rejects_unterminated_block_comment(tmp_path: Path) -> None:
    config_path = tmp_path / "config.jsonc"
    config_path.write_text('{"observer_provider": "openai"} /* broken')

    with pytest.raises(ValueError, match="invalid config json"):
        read_config_file(config_path)


def test_write_config_file_roundtrip(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    data = {"observer_provider": "openai", "observer_max_chars": 9000}
    write_config_file(data, config_path)
    assert json.loads(config_path.read_text()) == data
    assert read_config_file(config_path) == data


def test_get_config_path_prefers_jsonc_when_json_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    json_path = tmp_path / "config.json"
    jsonc_path = tmp_path / "config.jsonc"
    jsonc_path.write_text('{"observer_provider": "anthropic"}\n')
    monkeypatch.setattr("codemem.config.DEFAULT_CONFIG_PATH", json_path)
    monkeypatch.setattr("codemem.config.DEFAULT_CONFIG_PATH_JSONC", jsonc_path)

    assert get_config_path() == jsonc_path


def test_get_config_path_prefers_json_when_both_exist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    json_path = tmp_path / "config.json"
    jsonc_path = tmp_path / "config.jsonc"
    json_path.write_text("{}\n")
    jsonc_path.write_text("{}\n")
    monkeypatch.setattr("codemem.config.DEFAULT_CONFIG_PATH", json_path)
    monkeypatch.setattr("codemem.config.DEFAULT_CONFIG_PATH_JSONC", jsonc_path)

    assert get_config_path() == json_path


def test_load_config_reads_jsonc_file_when_selected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jsonc_path = tmp_path / "config.jsonc"
    jsonc_path.write_text(
        """
        {
          "observer_provider": "anthropic",
          "sync_port": 7337,
        }
        """
    )
    monkeypatch.setenv("CODEMEM_CONFIG", str(jsonc_path))

    cfg = load_config()

    assert cfg.observer_provider == "anthropic"


def test_load_config_warns_and_uses_defaults_on_invalid_json(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{broken-json")

    with pytest.warns(RuntimeWarning, match="Invalid config file"):
        cfg = load_config(config_path)

    assert cfg.observer_provider is None


def test_get_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEMEM_OBSERVER_PROVIDER", "anthropic")
    monkeypatch.setenv("CODEMEM_OBSERVER_MODEL", "claude-4.5-haiku")
    monkeypatch.setenv("CODEMEM_OBSERVER_BASE_URL", "https://gateway.example/v1")
    monkeypatch.setenv("CODEMEM_CLAUDE_COMMAND", '["wrapper", "claude", "--"]')
    overrides = get_env_overrides()
    assert overrides["observer_provider"] == "anthropic"
    assert overrides["observer_model"] == "claude-4.5-haiku"
    assert overrides["observer_base_url"] == "https://gateway.example/v1"
    assert overrides["claude_command"] == '["wrapper", "claude", "--"]'


def test_load_config_invalid_int_env_does_not_crash_and_warns(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_SYNC_PORT", "nope")
    with pytest.warns(RuntimeWarning, match="sync_port"):
        cfg = load_config(config_path)
    assert cfg.sync_port == 7337


def test_load_config_invalid_config_value_does_not_crash_and_warns(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"sync_port": "abc"}\n')
    with pytest.warns(RuntimeWarning, match="sync_port"):
        cfg = load_config(config_path)
    assert cfg.sync_port == 7337


def test_load_config_reads_hybrid_retrieval_enabled_from_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"hybrid_retrieval_enabled": true}\n')

    cfg = load_config(config_path)

    assert cfg.hybrid_retrieval_enabled is True


def test_load_config_reads_hybrid_retrieval_enabled_from_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_HYBRID_RETRIEVAL_ENABLED", "1")

    cfg = load_config(config_path)

    assert cfg.hybrid_retrieval_enabled is True


def test_load_config_hybrid_retrieval_env_overrides_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"hybrid_retrieval_enabled": true}\n')
    monkeypatch.setenv("CODEMEM_HYBRID_RETRIEVAL_ENABLED", "0")

    cfg = load_config(config_path)

    assert cfg.hybrid_retrieval_enabled is False


def test_load_config_hybrid_retrieval_invalid_env_uses_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_HYBRID_RETRIEVAL_ENABLED", "maybe")

    cfg = load_config(config_path)

    assert cfg.hybrid_retrieval_enabled is False


def test_load_config_pack_exact_dedupe_default_true(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")

    cfg = load_config(config_path)

    assert cfg.pack_exact_dedupe_enabled is True


def test_load_config_reads_pack_exact_dedupe_from_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"pack_exact_dedupe_enabled": false}\n')

    cfg = load_config(config_path)

    assert cfg.pack_exact_dedupe_enabled is False


def test_load_config_reads_pack_exact_dedupe_from_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_PACK_EXACT_DEDUPE_ENABLED", "0")

    cfg = load_config(config_path)

    assert cfg.pack_exact_dedupe_enabled is False


def test_load_config_reads_hybrid_shadow_settings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        '{"hybrid_retrieval_shadow_log": true, "hybrid_retrieval_shadow_sample_rate": 0.5}\n'
    )
    monkeypatch.setenv("CODEMEM_HYBRID_RETRIEVAL_SHADOW_LOG", "1")
    monkeypatch.setenv("CODEMEM_HYBRID_RETRIEVAL_SHADOW_SAMPLE_RATE", "0.25")

    cfg = load_config(config_path)

    assert cfg.hybrid_retrieval_shadow_log is True
    assert cfg.hybrid_retrieval_shadow_sample_rate == 0.25


def test_load_config_clamps_hybrid_shadow_sample_rate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_HYBRID_RETRIEVAL_SHADOW_SAMPLE_RATE", "5")

    cfg = load_config(config_path)

    assert cfg.hybrid_retrieval_shadow_sample_rate == 1.0


def test_load_config_reads_observer_auth_fields(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "observer_runtime": "api_http",
                "observer_auth_source": "command",
                "observer_auth_file": "~/.codemem/token.txt",
                "observer_auth_command": ["iap-auth", "--audience", "gateway"],
                "observer_auth_timeout_ms": 2500,
                "observer_auth_cache_ttl_s": 120,
                "observer_headers": {
                    "Authorization": "Bearer ${auth.token}",
                    "X-Auth-Source": "${auth.source}",
                },
            }
        )
    )

    cfg = load_config(config_path)

    assert cfg.observer_runtime == "api_http"
    assert cfg.observer_auth_source == "command"
    assert cfg.observer_auth_file == "~/.codemem/token.txt"
    assert cfg.observer_auth_command == ["iap-auth", "--audience", "gateway"]
    assert cfg.observer_auth_timeout_ms == 2500
    assert cfg.observer_auth_cache_ttl_s == 120
    assert cfg.observer_headers["Authorization"] == "Bearer ${auth.token}"


def test_load_config_reads_observer_base_url_from_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_OBSERVER_BASE_URL", "https://gateway.example/v1")

    cfg = load_config(config_path)

    assert cfg.observer_base_url == "https://gateway.example/v1"


def test_load_config_parses_observer_auth_command_from_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv(
        "CODEMEM_OBSERVER_AUTH_COMMAND",
        '["iap-auth", "--audience", "gateway"]',
    )

    cfg = load_config(config_path)

    assert cfg.observer_auth_command == ["iap-auth", "--audience", "gateway"]


def test_load_config_rejects_non_json_observer_auth_command_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_OBSERVER_AUTH_COMMAND", "iap-auth --audience gateway")

    with pytest.warns(RuntimeWarning, match="observer_auth_command"):
        cfg = load_config(config_path)

    assert cfg.observer_auth_command == []


def test_load_config_parses_observer_headers_from_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv(
        "CODEMEM_OBSERVER_HEADERS",
        '{"Authorization":"Bearer ${auth.token}","X-Auth-Source":"${auth.source}"}',
    )

    cfg = load_config(config_path)

    assert cfg.observer_headers == {
        "Authorization": "Bearer ${auth.token}",
        "X-Auth-Source": "${auth.source}",
    }


def test_load_config_invalid_observer_headers_warns_and_uses_default(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"observer_headers": {"Authorization": 1}}\n')

    with pytest.warns(RuntimeWarning, match="observer_headers"):
        cfg = load_config(config_path)

    assert cfg.observer_headers == {}


def test_load_config_reads_raw_events_sweeper_interval_from_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"raw_events_sweeper_interval_s": 90}\n')

    cfg = load_config(config_path)

    assert cfg.raw_events_sweeper_interval_s == 90


def test_load_config_reads_raw_events_sweeper_interval_from_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_S", "75")

    cfg = load_config(config_path)

    assert cfg.raw_events_sweeper_interval_s == 75


def test_load_config_parses_claude_command_from_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_CLAUDE_COMMAND", '["wrapper", "claude", "--"]')

    cfg = load_config(config_path)

    assert cfg.claude_command == ["wrapper", "claude", "--"]


def test_load_config_reads_claude_command_from_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"claude_command": ["wrapper", "claude", "--"]}\n')

    cfg = load_config(config_path)

    assert cfg.claude_command == ["wrapper", "claude", "--"]


def test_load_config_rejects_invalid_claude_command_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}\n")
    monkeypatch.setenv("CODEMEM_CONFIG", str(config_path))
    monkeypatch.setenv("CODEMEM_CLAUDE_COMMAND", "wrapper claude --")

    with pytest.warns(RuntimeWarning, match="claude_command"):
        cfg = load_config(config_path)

    assert cfg.claude_command == ["claude"]


def test_load_config_rejects_claude_command_with_empty_tokens(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text('{"claude_command": ["wrapper", " ", "--"]}\n')

    with pytest.warns(RuntimeWarning, match="claude_command"):
        cfg = load_config(config_path)

    assert cfg.claude_command == ["claude"]
