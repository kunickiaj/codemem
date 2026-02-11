from __future__ import annotations

import sqlite3
from pathlib import Path

from codemem import db


def test_migrate_legacy_default_db_moves_main_and_sidecars(tmp_path: Path, monkeypatch) -> None:
    new_default = tmp_path / ".codemem" / "mem.sqlite"
    legacy = tmp_path / ".codemem.sqlite"
    legacy_conn = sqlite3.connect(legacy)
    legacy_conn.execute("CREATE TABLE marker(value TEXT)")
    legacy_conn.execute("INSERT INTO marker(value) VALUES ('legacy')")
    legacy_conn.commit()
    legacy_conn.close()
    Path(f"{legacy}-wal").write_text("legacy-wal")
    Path(f"{legacy}-shm").write_text("legacy-shm")

    monkeypatch.setattr(db, "DEFAULT_DB_PATH", new_default)
    monkeypatch.setattr(db, "LEGACY_DEFAULT_DB_PATHS", (legacy,))

    conn = db.connect(new_default)
    row = conn.execute("SELECT value FROM marker").fetchone()
    conn.close()

    assert new_default.exists()
    assert row is not None
    assert row[0] == "legacy"
    assert not legacy.exists()
    assert not Path(f"{legacy}-wal").exists()
    assert not Path(f"{legacy}-shm").exists()


def test_migrate_legacy_default_db_skips_when_new_exists(tmp_path: Path, monkeypatch) -> None:
    new_default = tmp_path / ".codemem" / "mem.sqlite"
    new_default.parent.mkdir(parents=True, exist_ok=True)
    new_conn = sqlite3.connect(new_default)
    new_conn.execute("CREATE TABLE marker(value TEXT)")
    new_conn.execute("INSERT INTO marker(value) VALUES ('new')")
    new_conn.commit()
    new_conn.close()

    legacy = tmp_path / ".codemem.sqlite"
    legacy_conn = sqlite3.connect(legacy)
    legacy_conn.execute("CREATE TABLE marker(value TEXT)")
    legacy_conn.execute("INSERT INTO marker(value) VALUES ('legacy')")
    legacy_conn.commit()
    legacy_conn.close()

    monkeypatch.setattr(db, "DEFAULT_DB_PATH", new_default)
    monkeypatch.setattr(db, "LEGACY_DEFAULT_DB_PATHS", (legacy,))

    conn = db.connect(new_default)
    row = conn.execute("SELECT value FROM marker").fetchone()
    conn.close()

    assert row is not None
    assert row[0] == "new"
    assert legacy.exists()
