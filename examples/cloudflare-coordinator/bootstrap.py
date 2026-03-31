from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from rich.syntax import Syntax

from codemem import db
from codemem.config import get_config_path, read_config_file, write_config_file
from codemem.sync_identity import ensure_device_identity, fingerprint_public_key, load_public_key

app = typer.Typer(add_completion=False, help="Bootstrap the Cloudflare coordinator example")
console = Console()
WRANGLER_TOML_TEMPLATE = Path(__file__).with_name("wrangler.toml.example")
SCHEMA_SQL_PATH = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "cloudflare-coordinator-worker"
    / "schema.sql"
)
DRY_RUN_DATABASE_ID = "00000000-0000-0000-0000-000000000000"


class CommandFailure(RuntimeError):
    def __init__(self, command: list[str], *, stdout: str = "", stderr: str = "") -> None:
        self.command = command
        self.stdout = stdout
        self.stderr = stderr
        detail = "\n".join(part for part in [stdout, stderr] if part).strip()
        super().__init__(detail or f"command failed: {' '.join(command)}")


def _load_local_identity(db_path: Path, keys_dir: Path | None) -> dict[str, str]:
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        device_id, fingerprint = ensure_device_identity(conn, keys_dir=keys_dir)
    finally:
        conn.close()
    public_key = load_public_key(keys_dir)
    if not public_key:
        raise typer.BadParameter("public key missing")
    return {
        "device_id": device_id,
        "fingerprint": fingerprint or fingerprint_public_key(public_key),
        "public_key": public_key.strip(),
    }


def _sql_escape(value: str) -> str:
    return value.replace("'", "''")


def build_enrollment_sql(
    *,
    group: str,
    device_id: str,
    fingerprint: str,
    public_key: str,
    device_name: str,
) -> str:
    return (
        "INSERT INTO groups(group_id, display_name, created_at)\n"
        f"VALUES ('{_sql_escape(group)}', '{_sql_escape(group)}', CURRENT_TIMESTAMP)\n"
        "ON CONFLICT(group_id) DO NOTHING;\n\n"
        "INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, display_name, created_at)\n"
        "VALUES (\n"
        f"  '{_sql_escape(group)}',\n"
        f"  '{_sql_escape(device_id)}',\n"
        f"  '{_sql_escape(public_key)}',\n"
        f"  '{_sql_escape(fingerprint)}',\n"
        f"  '{_sql_escape(device_name)}',\n"
        "  CURRENT_TIMESTAMP\n"
        ");"
    )


def build_config_snippet(*, worker_url: str, group: str) -> dict[str, str]:
    return {
        "sync_coordinator_url": worker_url.rstrip("/"),
        "sync_coordinator_group": group,
    }


def write_config_snippet(
    *, config_path: Path, snippet: dict[str, str], dry_run: bool
) -> dict[str, Any]:
    if dry_run:
        return {"path": str(config_path), "written": False, "dry_run": True}
    data = read_config_file(config_path)
    data.update(snippet)
    write_config_file(data, config_path)
    return {"path": str(config_path), "written": True, "dry_run": False}


def build_wrangle_commands(*, database_name: str) -> list[str]:
    return [
        f"wrangler d1 create {database_name}",
        f"wrangler d1 execute {database_name} --file {SCHEMA_SQL_PATH.as_posix()}",
    ]


def parse_d1_create_output(output: str) -> str | None:
    patterns = [
        re.compile(r"database_id\s*=\s*([0-9a-f-]{16,})", re.IGNORECASE),
        re.compile(r"database id[:\s]+([0-9a-f-]{16,})", re.IGNORECASE),
        re.compile(r'"uuid"\s*:\s*"([0-9a-f-]{16,})"', re.IGNORECASE),
        re.compile(
            r"\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b", re.IGNORECASE
        ),
    ]
    for pattern in patterns:
        match = pattern.search(output)
        if match:
            return match.group(1)
    return None


def parse_worker_url_output(output: str) -> str | None:
    match = re.search(r"https://[a-z0-9.-]+\.workers\.dev", output, re.IGNORECASE)
    return match.group(0) if match else None


def render_wrangler_toml(*, database_id: str) -> str:
    template = WRANGLER_TOML_TEMPLATE.read_text()
    return template.replace("REPLACE_WITH_D1_DATABASE_ID", database_id)


def write_wrangler_toml(*, wrangler_toml: Path, database_id: str) -> None:
    wrangler_toml.parent.mkdir(parents=True, exist_ok=True)
    wrangler_toml.write_text(render_wrangler_toml(database_id=database_id))


def read_database_id_from_wrangler_toml(wrangler_toml: Path) -> str | None:
    if not wrangler_toml.exists():
        return None
    return parse_d1_create_output(wrangler_toml.read_text())


def parse_d1_list_output(output: str) -> list[dict[str, str]]:
    text = output.strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        results: list[dict[str, str]] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("database_name") or "").strip()
            uuid = str(item.get("uuid") or item.get("database_id") or "").strip()
            if name and uuid:
                results.append({"name": name, "uuid": uuid})
        return results
    results = []
    for line in text.splitlines():
        match = re.search(
            r"(?P<name>[A-Za-z0-9._-]+).*?(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
            line,
            re.IGNORECASE,
        )
        if match:
            results.append({"name": match.group("name"), "uuid": match.group("uuid")})
    return results


def list_d1_databases(*, dry_run: bool, cwd: Path) -> dict[str, Any]:
    command = ["wrangler", "d1", "list", "--json"]
    result = run_command(command, dry_run=dry_run, cwd=cwd)
    output = "\n".join(part for part in [result.stdout, result.stderr] if part)
    return {
        "command": command,
        "databases": parse_d1_list_output(output),
        "output": output,
        "dry_run": dry_run,
    }


def find_existing_database_id(
    *, database_name: str, dry_run: bool, cwd: Path
) -> tuple[str | None, dict[str, Any] | None]:
    listing = list_d1_databases(dry_run=dry_run, cwd=cwd)
    for item in listing["databases"]:
        if str(item.get("name") or "").strip() == database_name:
            return str(item.get("uuid") or "").strip() or None, listing
    return None, listing


def run_command(
    command: list[str],
    *,
    dry_run: bool,
    cwd: Path,
    capture_output: bool = True,
) -> subprocess.CompletedProcess[str]:
    if dry_run:
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            check=True,
            capture_output=capture_output,
            text=True,
        )
    except FileNotFoundError as exc:
        raise typer.BadParameter(f"missing required command: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise CommandFailure(command, stdout=exc.stdout or "", stderr=exc.stderr or "") from exc


def ensure_wrangler_ready(*, dry_run: bool, cwd: Path) -> dict[str, Any]:
    command = ["wrangler", "whoami"]
    result = run_command(command, dry_run=dry_run, cwd=cwd)
    return {"command": command, "stdout": result.stdout, "stderr": result.stderr}


def create_d1_database(*, database_name: str, dry_run: bool, cwd: Path) -> dict[str, Any]:
    command = ["wrangler", "d1", "create", database_name]
    reused_existing = False
    list_result = None
    if dry_run:
        return {
            "command": command,
            "database_id": DRY_RUN_DATABASE_ID,
            "output": "",
            "reused_existing": False,
            "list_result": None,
            "dry_run": True,
        }
    try:
        result = run_command(command, dry_run=dry_run, cwd=cwd)
        output = "\n".join(part for part in [result.stdout, result.stderr] if part)
        database_id = parse_d1_create_output(output)
    except CommandFailure as exc:
        output = str(exc)
        if "already exists" not in output.lower():
            raise
        database_id, list_result = find_existing_database_id(
            database_name=database_name,
            dry_run=dry_run,
            cwd=cwd,
        )
        if not database_id:
            raise typer.BadParameter(
                f"D1 database '{database_name}' already exists but its database id could not be discovered automatically. Run 'wrangler d1 list' and rerun the script with that id."
            ) from exc
        reused_existing = True
    return {
        "command": command,
        "database_id": database_id,
        "output": output,
        "reused_existing": reused_existing,
        "list_result": list_result,
        "dry_run": dry_run,
    }


def apply_schema(*, database_name: str, dry_run: bool, cwd: Path) -> dict[str, Any]:
    command = [
        "wrangler",
        "d1",
        "execute",
        database_name,
        "--remote",
        "--file",
        str(SCHEMA_SQL_PATH),
    ]
    result = run_command(command, dry_run=dry_run, cwd=cwd)
    return {
        "command": command,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "dry_run": dry_run,
    }


def deploy_worker(*, dry_run: bool, cwd: Path) -> dict[str, Any]:
    command = ["wrangler", "deploy"]
    result = run_command(command, dry_run=dry_run, cwd=cwd)
    output = "\n".join(part for part in [result.stdout, result.stderr] if part)
    return {
        "command": command,
        "worker_url": parse_worker_url_output(output),
        "output": output,
        "dry_run": dry_run,
    }


def apply_enrollment_sql(
    *, database_name: str, sql: str, dry_run: bool, cwd: Path
) -> dict[str, Any]:
    command = ["wrangler", "d1", "execute", database_name, "--remote", "--command", sql]
    result = run_command(command, dry_run=dry_run, cwd=cwd)
    return {
        "command": command,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "dry_run": dry_run,
    }


def _run_smoke_check(
    *, db_path: Path, worker_url: str, group: str, keys_dir: Path | None
) -> tuple[int, str, str]:
    command = [
        "uv",
        "run",
        "python",
        "examples/cloudflare-coordinator/smoke_check.py",
        "--db",
        str(db_path),
        "--url",
        worker_url,
        "--group",
        group,
    ]
    if keys_dir is not None:
        command.extend(["--keys-dir", str(keys_dir)])
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    return int(result.returncode), (result.stdout or ""), (result.stderr or "")


def _smoke_check_guidance(stderr_text: str) -> str | None:
    text = stderr_text.strip()
    lowered = text.lower()
    if "error code: 1010" in lowered:
        return (
            "Cloudflare blocked the request before it reached the coordinator. Check Browser Integrity Check or WAF rules "
            "for the Worker hostname/custom domain."
        )
    if "unknown_device" in lowered:
        return "The device is not enrolled in the coordinator group yet. Apply the enrollment SQL remotely and retry."
    if "invalid_admin_secret" in lowered:
        return "The configured remote admin secret is wrong for this coordinator."
    return None


def _step_status(selected: bool, *, result: dict[str, Any] | None = None) -> dict[str, Any]:
    if not selected:
        return {"status": "skipped"}
    if result is None:
        return {"status": "failed"}
    return {"status": "dry_run" if result.get("dry_run") else "executed", **result}


@app.command()
def main(
    db_path: Path = typer.Option(
        Path("~/.codemem/mem.sqlite").expanduser(), help="Path to local codemem DB"
    ),
    group: str | None = typer.Option(None, help="Coordinator group ID"),
    worker_url: str | None = typer.Option(None, help="Deployed Worker URL"),
    keys_dir: Path | None = typer.Option(None, help="Optional CODEMEM_KEYS_DIR override"),
    device_name: str | None = typer.Option(None, help="Optional display name for enrolled device"),
    database_name: str = typer.Option(
        "codemem-coordinator", help="Suggested Cloudflare D1 database name"
    ),
    wrangler_toml: Path = typer.Option(
        Path(__file__).with_name("wrangler.toml"),
        help="Path to generated wrangler.toml",
    ),
    config_path: Path | None = typer.Option(None, help="Path to codemem config file to update"),
    create_d1: bool = typer.Option(False, help="Create the D1 database with wrangler"),
    apply_schema_sql: bool = typer.Option(
        False, "--apply-schema", help="Apply schema.sql with wrangler"
    ),
    deploy: bool = typer.Option(False, help="Deploy the Worker with wrangler"),
    enroll_local: bool = typer.Option(False, help="Apply generated enrollment SQL with wrangler"),
    dry_run: bool = typer.Option(False, help="Print commands without executing them"),
    non_interactive: bool = typer.Option(
        False, "--non-interactive", help="Disable prompts and require all needed values via flags"
    ),
    format: str = typer.Option("text", help="Output format: text or json"),
    print_sql: bool = typer.Option(True, help="Include bootstrap SQL in the output"),
    print_config: bool = typer.Option(True, help="Include config snippet in the output"),
    write_config: bool = typer.Option(False, help="Write coordinator config into config.json"),
    run_smoke_check: bool = typer.Option(
        False, help="Run smoke_check.py after printing bootstrap info"
    ),
) -> None:
    if format not in {"text", "json"}:
        raise typer.BadParameter("format must be 'text' or 'json'")
    resolved_db_path = db_path.expanduser()
    resolved_keys_dir = keys_dir.expanduser() if keys_dir is not None else None
    resolved_wrangler_toml = wrangler_toml.expanduser()
    resolved_config_path = get_config_path(
        config_path.expanduser() if config_path is not None else None
    )
    script_dir = Path(__file__).resolve().parent
    identity = _load_local_identity(resolved_db_path, resolved_keys_dir)

    if not non_interactive:
        create_d1 = create_d1 or Confirm.ask("Create the D1 database with wrangler?", default=True)
        apply_schema_sql = apply_schema_sql or Confirm.ask(
            "Apply schema.sql with wrangler?", default=True
        )
        deploy = deploy or Confirm.ask("Deploy the Worker with wrangler?", default=True)
        enroll_local = enroll_local or Confirm.ask(
            "Apply enrollment SQL with wrangler?", default=True
        )

    if not group:
        if non_interactive:
            raise typer.BadParameter("--group is required in non-interactive mode")
        group = Prompt.ask("Coordinator group", default="team-alpha")
    if not device_name:
        if non_interactive:
            device_name = identity["device_id"]
        else:
            device_name = Prompt.ask("Device display name", default=identity["device_id"])
    if not non_interactive:
        write_config = write_config or Confirm.ask(
            f"Write coordinator settings to {resolved_config_path}?",
            default=True,
        )

    needs_wrangler = create_d1 or apply_schema_sql or deploy or enroll_local
    try:
        wrangler_ready = (
            ensure_wrangler_ready(dry_run=dry_run, cwd=script_dir) if needs_wrangler else None
        )
    except CommandFailure as exc:
        raise typer.BadParameter(
            f"wrangler is not ready. Run 'wrangler login' first.\n\n{exc}"
        ) from exc

    database_id = read_database_id_from_wrangler_toml(resolved_wrangler_toml)
    d1_create = None
    if create_d1:
        d1_create = create_d1_database(database_name=database_name, dry_run=dry_run, cwd=script_dir)
        database_id = d1_create.get("database_id") or database_id
    elif not database_id and needs_wrangler:
        database_id, list_result = find_existing_database_id(
            database_name=database_name,
            dry_run=dry_run,
            cwd=script_dir,
        )
        if list_result is not None:
            d1_create = {
                "command": ["wrangler", "d1", "list", "--json"],
                "database_id": database_id,
                "output": list_result.get("output", ""),
                "reused_existing": bool(database_id),
                "list_result": list_result,
            }
    if not database_id and not non_interactive:
        database_id = Prompt.ask("Cloudflare D1 database id", default="") or None
    if dry_run and not database_id and needs_wrangler:
        database_id = DRY_RUN_DATABASE_ID
    if needs_wrangler and not database_id:
        raise typer.BadParameter(
            f"No D1 database id is configured for '{database_name}'. Create it first or provide its id."
        )
    if database_id:
        if not dry_run:
            write_wrangler_toml(wrangler_toml=resolved_wrangler_toml, database_id=database_id)
    elif not dry_run and resolved_wrangler_toml.exists():
        console.print(f"[yellow]Keeping existing {resolved_wrangler_toml}[/yellow]")

    try:
        schema_result = (
            apply_schema(database_name=database_name, dry_run=dry_run, cwd=script_dir)
            if apply_schema_sql
            else None
        )
        deploy_result = deploy_worker(dry_run=dry_run, cwd=script_dir) if deploy else None
    except CommandFailure as exc:
        raise typer.BadParameter(str(exc)) from exc
    if not worker_url:
        worker_url = (deploy_result or {}).get("worker_url") if deploy_result else None
    if not worker_url:
        if non_interactive:
            raise typer.BadParameter("--worker-url is required unless --deploy discovers it")
        worker_url = Prompt.ask("Worker URL", default="https://your-worker.example.workers.dev")

    sql = build_enrollment_sql(
        group=str(group),
        device_id=identity["device_id"],
        fingerprint=identity["fingerprint"],
        public_key=identity["public_key"],
        device_name=str(device_name),
    )
    config_snippet = build_config_snippet(worker_url=str(worker_url), group=str(group))
    config_write_result = (
        write_config_snippet(
            config_path=resolved_config_path,
            snippet=config_snippet,
            dry_run=dry_run,
        )
        if write_config
        else None
    )
    try:
        enrollment_result = (
            apply_enrollment_sql(
                database_name=database_name,
                sql=sql,
                dry_run=dry_run,
                cwd=script_dir,
            )
            if enroll_local
            else None
        )
    except CommandFailure as exc:
        raise typer.BadParameter(str(exc)) from exc
    payload = {
        "group": group,
        "device_id": identity["device_id"],
        "fingerprint": identity["fingerprint"],
        "device_name": device_name,
        "public_key": identity["public_key"],
        "wrangler_ready": wrangler_ready,
        "database_id": database_id,
        "wrangler_toml": str(resolved_wrangler_toml),
        "config_path": str(resolved_config_path),
        "needs_wrangler": needs_wrangler,
        "wrangler_commands": build_wrangle_commands(database_name=database_name),
        "d1_create": d1_create,
        "schema_apply": schema_result,
        "deploy": deploy_result,
        "enroll_local": enrollment_result,
        "config_write": config_write_result,
        "enrollment_sql": sql if print_sql else None,
        "config_snippet": config_snippet if print_config else None,
        "dry_run": dry_run,
        "steps": {
            "wrangler_ready": _step_status(needs_wrangler, result=wrangler_ready),
            "create_d1": _step_status(create_d1, result=d1_create),
            "apply_schema": _step_status(apply_schema_sql, result=schema_result),
            "deploy": _step_status(deploy, result=deploy_result),
            "enroll_local": _step_status(enroll_local, result=enrollment_result),
            "write_config": _step_status(write_config, result=config_write_result),
        },
    }

    should_run_smoke = run_smoke_check
    if not non_interactive and not should_run_smoke:
        should_run_smoke = Confirm.ask("Run smoke check now?", default=False)

    if format == "json" and not should_run_smoke:
        console.print_json(data=payload)
    elif format != "json":
        console.print(Panel.fit("Cloudflare coordinator bootstrap", style="cyan"))
        console.print(f"[bold]Device ID:[/bold] {identity['device_id']}")
        console.print(f"[bold]Fingerprint:[/bold] {identity['fingerprint']}")
        console.print(f"[bold]Group:[/bold] {group}")
        console.print(f"[bold]Worker URL:[/bold] {worker_url}")
        if database_id:
            console.print(f"[bold]D1 database id:[/bold] {database_id}")
        console.print(f"[bold]wrangler.toml:[/bold] {resolved_wrangler_toml}")
        console.print(f"[bold]config.json:[/bold] {resolved_config_path}")
        console.print("\n[bold]Step status[/bold]")
        for name, item in payload["steps"].items():
            console.print(f"- {name}: {item['status']}")
        console.print("\n[bold]Wrangler setup commands[/bold]")
        for command in payload["wrangler_commands"]:
            console.print(f"- {command}")
        if print_sql:
            console.print("\n[bold]Enrollment SQL[/bold]")
            console.print(Syntax(sql, "sql", word_wrap=True))
        if print_config:
            console.print("\n[bold]Config snippet[/bold]")
            console.print(Syntax(json.dumps(config_snippet, indent=2), "json", word_wrap=True))
        console.print("\n[bold]Next steps[/bold]")
        console.print("1. Review any failed step above")
        console.print("2. If config was not written, add the config snippet manually")
        console.print("3. Run the smoke check if remote steps succeeded")

    if should_run_smoke:
        exit_code, stdout_text, stderr_text = _run_smoke_check(
            db_path=resolved_db_path,
            worker_url=str(worker_url),
            group=str(group),
            keys_dir=resolved_keys_dir,
        )
        payload["steps"]["smoke_check"] = {
            "status": "executed" if exit_code == 0 else "failed",
            "exit_code": exit_code,
            "stdout": stdout_text,
            "stderr": stderr_text,
            "guidance": _smoke_check_guidance(stderr_text),
        }
        if format == "json":
            console.print_json(data=payload)
            if exit_code != 0:
                raise typer.Exit(code=exit_code)
            return
        if stdout_text.strip():
            console.print("\n[bold]Smoke check output[/bold]")
            console.print(stdout_text.rstrip())
        if stderr_text.strip():
            console.print("\n[bold red]Smoke check error[/bold red]")
            console.print(stderr_text.rstrip())
        guidance = _smoke_check_guidance(stderr_text)
        if guidance:
            console.print(f"\n[yellow]{guidance}[/yellow]")
        if exit_code != 0:
            raise typer.Exit(code=exit_code)


if __name__ == "__main__":
    app()
