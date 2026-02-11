from pathlib import Path

from typer.testing import CliRunner

from codemem import db
from codemem.cli import app

runner = CliRunner()


def test_sync_attempts_command(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:01Z",
                1,
                2,
                3,
                None,
            ),
        )
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-2",
                "2026-01-01T00:00:02Z",
                "2026-01-01T00:00:03Z",
                0,
                0,
                0,
                "timed out",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    result = runner.invoke(app, ["sync", "attempts", "--db-path", str(db_path), "--limit", "5"])
    assert result.exit_code == 0
    assert "peer-2|error|in=0|out=0|2026-01-01T00:00:03Z | timed out" in result.stdout
    assert "peer-1|ok|in=2|out=3|2026-01-01T00:00:01Z" in result.stdout


def test_version_command() -> None:
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert result.stdout.strip()
