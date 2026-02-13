from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_sync_keys_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    keys_dir = tmp_path / "keys"
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(keys_dir))
