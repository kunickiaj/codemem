from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

from codemem import db
from codemem.sync_identity import ensure_device_identity


def _load_bootstrap_module():
    path = (
        Path(__file__).resolve().parents[1] / "examples" / "cloudflare-coordinator" / "bootstrap.py"
    )
    spec = importlib.util.spec_from_file_location("cloudflare_bootstrap", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cloudflare_bootstrap_script_outputs_json(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        device_id, fingerprint = ensure_device_identity(conn, keys_dir=keys_dir)
    finally:
        conn.close()

    result = subprocess.run(
        [
            "uv",
            "run",
            "python",
            "examples/cloudflare-coordinator/bootstrap.py",
            "--db-path",
            str(db_path),
            "--keys-dir",
            str(keys_dir),
            "--group",
            "nerdworld",
            "--worker-url",
            "https://coord.example.workers.dev",
            "--device-name",
            "laptop",
            "--non-interactive",
            "--format",
            "json",
        ],
        cwd=Path(__file__).resolve().parents[1],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)

    assert payload["group"] == "nerdworld"
    assert payload["device_id"] == device_id
    assert payload["fingerprint"] == fingerprint
    assert payload["config_snippet"]["sync_coordinator_group"] == "nerdworld"
    assert payload["config_snippet"]["sync_coordinator_url"] == "https://coord.example.workers.dev"
    assert "INSERT INTO groups" in payload["enrollment_sql"]
    assert any("wrangler d1 create" in command for command in payload["wrangler_commands"])


def test_cloudflare_bootstrap_script_supports_full_dry_run_flow(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        device_id, _fingerprint = ensure_device_identity(conn, keys_dir=keys_dir)
    finally:
        conn.close()

    result = subprocess.run(
        [
            "uv",
            "run",
            "python",
            "examples/cloudflare-coordinator/bootstrap.py",
            "--db-path",
            str(db_path),
            "--keys-dir",
            str(keys_dir),
            "--group",
            "nerdworld",
            "--worker-url",
            "https://coord.example.workers.dev",
            "--device-name",
            "laptop",
            "--create-d1",
            "--apply-schema",
            "--deploy",
            "--enroll-local",
            "--dry-run",
            "--non-interactive",
            "--format",
            "json",
        ],
        cwd=Path(__file__).resolve().parents[1],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)

    assert payload["device_id"] == device_id
    assert payload["dry_run"] is True
    assert payload["needs_wrangler"] is True
    assert payload["wrangler_ready"]["command"] == ["wrangler", "whoami"]
    assert payload["d1_create"]["command"][:3] == ["wrangler", "d1", "create"]
    assert payload["schema_apply"]["command"][:3] == ["wrangler", "d1", "execute"]
    assert payload["deploy"]["command"] == ["wrangler", "deploy"]
    assert payload["enroll_local"]["command"][:3] == ["wrangler", "d1", "execute"]
    assert "--remote" in payload["schema_apply"]["command"]
    assert "--remote" in payload["enroll_local"]["command"]


def test_create_d1_database_reuses_existing_database_id() -> None:
    module = _load_bootstrap_module()

    def fake_run_command(command, *, dry_run, cwd, capture_output=True):
        if command[:3] == ["wrangler", "d1", "create"]:
            raise module.CommandFailure(command, stderr="A database with that name already exists")
        if command[:4] == ["wrangler", "d1", "list", "--json"]:
            return subprocess.CompletedProcess(
                command,
                0,
                stdout='[{"name": "codemem-coordinator", "uuid": "784d138d-ab3c-4f5c-9464-cf45c5b69af3"}]',
                stderr="",
            )
        raise AssertionError(command)

    module.__dict__["run_command"] = fake_run_command
    result = module.create_d1_database(
        database_name="codemem-coordinator",
        dry_run=False,
        cwd=Path("."),
    )

    assert result["database_id"] == "784d138d-ab3c-4f5c-9464-cf45c5b69af3"
    assert result["reused_existing"] is True
