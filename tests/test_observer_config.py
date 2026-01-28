from pathlib import Path

import pytest

from opencode_mem.observer import _load_opencode_config


def _write_config(tmp_path: Path, name: str, contents: str) -> None:
    config_dir = tmp_path / ".config" / "opencode"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / name).write_text(contents)


def test_load_opencode_config_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    _write_config(
        tmp_path,
        "opencode.json",
        '{"provider": {"openai": {"options": {"baseURL": "https://api.test"}}}}',
    )
    config = _load_opencode_config()
    assert config["provider"]["openai"]["options"]["baseURL"] == "https://api.test"


def test_load_opencode_config_jsonc(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    _write_config(
        tmp_path,
        "opencode.jsonc",
        """
        {
          // comment
          "provider": {
            "openai": {
              "options": {
                "baseURL": "https://api.test",
              },
            },
          },
        }
        """,
    )
    config = _load_opencode_config()
    assert config["provider"]["openai"]["options"]["baseURL"] == "https://api.test"


def test_load_opencode_config_invalid_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    _write_config(tmp_path, "opencode.json", "{not: json}")
    config = _load_opencode_config()
    assert config == {}
