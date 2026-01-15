import json
from pathlib import Path

import pytest

from opencode_mem.config import get_env_overrides, read_config_file, write_config_file


def test_read_config_file_rejects_invalid_json(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{not-json}")
    with pytest.raises(ValueError, match="invalid config json"):
        read_config_file(config_path)


def test_write_config_file_roundtrip(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    data = {"observer_provider": "openai", "observer_max_chars": 9000}
    write_config_file(data, config_path)
    assert json.loads(config_path.read_text()) == data
    assert read_config_file(config_path) == data


def test_get_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENCODE_MEM_OBSERVER_PROVIDER", "anthropic")
    monkeypatch.setenv("OPENCODE_MEM_OBSERVER_MODEL", "claude-4.5-haiku")
    overrides = get_env_overrides()
    assert overrides["observer_provider"] == "anthropic"
    assert overrides["observer_model"] == "claude-4.5-haiku"
