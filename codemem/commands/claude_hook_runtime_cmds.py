from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from codemem.commands.claude_integration_cmds import ingest_claude_hook_payload
from codemem.utils import resolve_project


def _env_truthy(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed <= 0:
        return default
    return parsed


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _normalize_payload_ts(payload: dict[str, Any]) -> None:
    ts = payload.get("ts")
    if isinstance(ts, str) and ts.strip():
        return
    timestamp = payload.get("timestamp")
    if isinstance(timestamp, str) and timestamp.strip():
        payload["ts"] = timestamp
        return
    payload["ts"] = _now_iso()


def _read_stdin_payload() -> dict[str, Any] | None:
    raw = sys.stdin.read()
    if not raw.strip():
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def _normalize_project_label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _resolve_project_for_injection(payload: dict[str, Any]) -> str | None:
    env_project = _normalize_project_label(os.getenv("CODEMEM_PROJECT"))
    if env_project:
        return env_project

    payload_project = _normalize_project_label(payload.get("project"))
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd.strip():
        cwd_project = _normalize_project_label(resolve_project(cwd))
        if cwd_project:
            return cwd_project

    return payload_project


def _print_continue() -> None:
    print(json.dumps({"continue": True}))


def _log_path() -> Path:
    env_value = os.getenv("CODEMEM_PLUGIN_LOG_PATH") or os.getenv("CODEMEM_PLUGIN_LOG")
    normalized = (env_value or "").strip().lower()
    if normalized in {"", "0", "false", "off", "1", "true", "yes"}:
        return Path("~/.codemem/plugin.log").expanduser()
    return Path(env_value).expanduser()  # type: ignore[arg-type]


def _log_line(message: str) -> None:
    path = _log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{_now_iso()} {message}\n")
    except OSError:
        return


def _http_enqueue(payload: dict[str, Any]) -> bool:
    viewer_host = os.getenv("CODEMEM_VIEWER_HOST", "127.0.0.1")
    viewer_port = os.getenv("CODEMEM_VIEWER_PORT", "38888")
    max_timeout_s = _env_float("CODEMEM_CLAUDE_HOOK_HTTP_MAX_TIME_S", 2.0)
    url = f"http://{viewer_host}:{viewer_port}/api/claude-hooks"
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=max_timeout_s) as response:
            status = response.getcode()
            raw_response = response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError):
        return False

    if status < 200 or status >= 300:
        return False

    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError:
        _log_line("codemem claude-hook-ingest HTTP accepted with invalid response body")
        return False

    if not isinstance(parsed, dict):
        _log_line("codemem claude-hook-ingest HTTP accepted with invalid response type")
        return False
    inserted = parsed.get("inserted")
    skipped = parsed.get("skipped")
    if not isinstance(inserted, int) or not isinstance(skipped, int):
        _log_line("codemem claude-hook-ingest HTTP accepted with unexpected response body")
        return False
    if skipped > 0:
        _log_line("codemem claude-hook-ingest HTTP accepted but skipped payload")
        return False
    return True


def _should_force_boundary_flush(payload: dict[str, Any]) -> bool:
    hook_event_name = str(payload.get("hook_event_name") or "").strip()
    if hook_event_name not in {"Stop", "SessionEnd"}:
        return False
    if not _env_truthy("CODEMEM_CLAUDE_HOOK_FLUSH", False):
        return False
    if hook_event_name == "SessionEnd":
        return True
    return _env_truthy("CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP", False)


def _run_cli_ingest_payload(payload: dict[str, Any], *, flush_default: bool) -> bool:
    try:
        ingest_claude_hook_payload(payload, flush_default=flush_default)
    except Exception as exc:  # pragma: no cover
        _log_line(f"codemem claude-hook-ingest fallback ingest failed: {exc}")
        return False
    return True


@dataclass(frozen=True)
class _LockConfig:
    lock_dir: Path
    lock_ttl_s: int
    lock_grace_s: int


def _lock_config() -> _LockConfig:
    return _LockConfig(
        lock_dir=Path(
            os.getenv("CODEMEM_CLAUDE_HOOK_LOCK_DIR", "~/.codemem/claude-hook-ingest.lock")
        ).expanduser(),
        lock_ttl_s=max(1, _env_int("CODEMEM_CLAUDE_HOOK_LOCK_TTL_S", 300)),
        lock_grace_s=max(1, _env_int("CODEMEM_CLAUDE_HOOK_LOCK_GRACE_S", 2)),
    )


def _read_lock_metadata(lock_dir: Path) -> tuple[str, int | None, str]:
    pid_text = (
        (lock_dir / "pid").read_text(encoding="utf-8").strip()
        if (lock_dir / "pid").exists()
        else ""
    )
    ts_text = (
        (lock_dir / "ts").read_text(encoding="utf-8").strip() if (lock_dir / "ts").exists() else ""
    )
    owner = (
        (lock_dir / "owner").read_text(encoding="utf-8").strip()
        if (lock_dir / "owner").exists()
        else ""
    )
    try:
        ts_value = int(ts_text)
    except (TypeError, ValueError):
        ts_value = None
    return pid_text, ts_value, owner


def _is_pid_alive(pid_text: str) -> bool:
    try:
        pid = int(pid_text)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _lock_is_stale(cfg: _LockConfig) -> tuple[bool, tuple[str, int | None, str]]:
    pid_text, ts_value, owner = _read_lock_metadata(cfg.lock_dir)
    now = int(time.time())
    if pid_text:
        if _is_pid_alive(pid_text):
            if ts_value is None:
                return False, (pid_text, ts_value, owner)
            return (now - ts_value > cfg.lock_ttl_s), (pid_text, ts_value, owner)
        return True, (pid_text, ts_value, owner)
    if ts_value is not None:
        return (now - ts_value > cfg.lock_grace_s), (pid_text, ts_value, owner)
    try:
        age = now - int(cfg.lock_dir.stat().st_mtime)
    except OSError:
        return True, (pid_text, ts_value, owner)
    return (age > cfg.lock_grace_s), (pid_text, ts_value, owner)


def _cleanup_lock_dir(lock_dir: Path) -> None:
    for name in ("pid", "ts", "owner"):
        try:
            (lock_dir / name).unlink()
        except OSError:
            continue
    try:
        lock_dir.rmdir()
    except OSError:
        return


def _cleanup_lock_dir_if_unchanged(lock_dir: Path, snapshot: tuple[str, int | None, str]) -> None:
    current = _read_lock_metadata(lock_dir)
    if current == snapshot:
        _cleanup_lock_dir(lock_dir)


@contextmanager
def _acquire_lock() -> Any:
    cfg = _lock_config()
    cfg.lock_dir.parent.mkdir(parents=True, exist_ok=True)
    owner_token = f"{os.getpid()}-{int(time.time())}-{random.randint(1000, 9999)}"

    for _ in range(100):
        try:
            cfg.lock_dir.mkdir()
        except FileExistsError:
            stale, snapshot = _lock_is_stale(cfg)
            if stale:
                _cleanup_lock_dir_if_unchanged(cfg.lock_dir, snapshot)
            time.sleep(0.05)
            continue
        except OSError:
            time.sleep(0.05)
            continue

        try:
            (cfg.lock_dir / "ts").write_text(str(int(time.time())), encoding="utf-8")
            (cfg.lock_dir / "pid").write_text(str(os.getpid()), encoding="utf-8")
            (cfg.lock_dir / "owner").write_text(owner_token, encoding="utf-8")
            break
        except OSError:
            _cleanup_lock_dir(cfg.lock_dir)
            time.sleep(0.05)
    else:
        raise TimeoutError("lock busy")

    try:
        yield cfg
    finally:
        try:
            current_owner = (cfg.lock_dir / "owner").read_text(encoding="utf-8").strip()
        except OSError:
            current_owner = ""
        if current_owner == owner_token:
            _cleanup_lock_dir(cfg.lock_dir)


def _spool_dir() -> Path:
    return Path(
        os.getenv("CODEMEM_CLAUDE_HOOK_SPOOL_DIR", "~/.codemem/claude-hook-spool")
    ).expanduser()


def _spool_payload(payload: dict[str, Any]) -> bool:
    spool_dir = _spool_dir()
    spool_dir.mkdir(parents=True, exist_ok=True)
    payload_text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    try:
        with NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=spool_dir,
            prefix=".hook-tmp-",
            suffix=".json",
            delete=False,
        ) as handle:
            handle.write(payload_text)
            tmp_path = Path(handle.name)
    except OSError:
        _log_line("codemem claude-hook-ingest failed to allocate spool temp file")
        return False

    final_path = (
        spool_dir / f"hook-{int(time.time())}-{os.getpid()}-{random.randint(1000, 9999)}.json"
    )
    try:
        tmp_path.replace(final_path)
    except OSError:
        with suppress(OSError):
            tmp_path.unlink()
        _log_line("codemem claude-hook-ingest failed to spool payload")
        return False
    _log_line(f"codemem claude-hook-ingest spooled payload: {final_path}")
    return True


def _recover_stale_tmp_spool(lock_ttl_s: int) -> None:
    spool_dir = _spool_dir()
    spool_dir.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for tmp_path in spool_dir.glob(".hook-tmp-*.json"):
        try:
            age = now - tmp_path.stat().st_mtime
        except OSError:
            continue
        if age <= lock_ttl_s:
            continue
        recovered = (
            spool_dir
            / f"hook-recovered-{int(time.time())}-{os.getpid()}-{random.randint(1000, 9999)}.json"
        )
        try:
            tmp_path.replace(recovered)
            _log_line(f"codemem claude-hook-ingest recovered stale temp spool payload: {recovered}")
        except OSError:
            continue


def _drain_spool() -> None:
    spool_dir = _spool_dir()
    spool_dir.mkdir(parents=True, exist_ok=True)
    for queued_file in sorted(spool_dir.glob("*.json")):
        try:
            payload = json.loads(queued_file.read_text(encoding="utf-8"))
        except Exception:
            _log_line(f"codemem claude-hook-ingest failed reading spooled payload: {queued_file}")
            continue
        if not isinstance(payload, dict):
            continue
        if _http_enqueue(payload) or _run_cli_ingest_payload(payload, flush_default=True):
            try:
                queued_file.unlink()
            except OSError:
                continue
            continue
        _log_line(f"codemem claude-hook-ingest failed processing spooled payload: {queued_file}")


def claude_hook_ingest_cmd() -> None:
    payload = _read_stdin_payload()
    if payload is None:
        return
    if _env_truthy("CODEMEM_PLUGIN_IGNORE", False):
        return

    _normalize_payload_ts(payload)
    if _http_enqueue(payload):
        if _should_force_boundary_flush(payload):
            _run_cli_ingest_payload(payload, flush_default=False)
        return

    try:
        with _acquire_lock() as cfg:
            _recover_stale_tmp_spool(cfg.lock_ttl_s)
            _drain_spool()
            if _http_enqueue(payload):
                if _should_force_boundary_flush(payload):
                    _run_cli_ingest_payload(payload, flush_default=False)
                return
            if _run_cli_ingest_payload(payload, flush_default=True):
                return
            if _spool_payload(payload):
                return
            _log_line("codemem claude-hook-ingest failed: fallback and spool failed")
            raise SystemExit(1)
    except TimeoutError:
        _log_line("codemem claude-hook-ingest lock busy; trying unlocked fallback")
        if _run_cli_ingest_payload(payload, flush_default=True):
            return
        if _spool_payload(payload):
            return
        _log_line("codemem claude-hook-ingest failed: fallback and spool failed")
        raise SystemExit(1) from None


def _pack_query(prompt: str, project: str | None, limit: int, token_budget: int) -> str:
    params: dict[str, str] = {
        "context": prompt,
        "limit": str(limit),
        "token_budget": str(token_budget),
    }
    if project:
        params["project"] = project
    return urllib.parse.urlencode(params)


def _fetch_pack_text(
    *, prompt: str, project: str | None, limit: int, token_budget: int
) -> str | None:
    viewer_host = os.getenv("CODEMEM_VIEWER_HOST", "127.0.0.1")
    viewer_port = os.getenv("CODEMEM_VIEWER_PORT", "38888")
    timeout_s = _env_float("CODEMEM_INJECT_HTTP_MAX_TIME_S", 2.0)
    query = _pack_query(prompt, project, limit, token_budget)
    url = f"http://{viewer_host}:{viewer_port}/api/pack?{query}"
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            if response.getcode() < 200 or response.getcode() >= 300:
                return None
            raw = response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError):
        return None

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    pack_text = payload.get("pack_text")
    if not isinstance(pack_text, str):
        return None
    text = pack_text.strip()
    return text or None


def _truncate_pack_text(text: str, max_chars: int) -> str:
    if max_chars > 0 and len(text) > max_chars:
        return text[:max_chars].rstrip() + "\n\n[pack truncated]"
    return text


def claude_hook_inject_cmd() -> None:
    payload = _read_stdin_payload()
    if payload is None:
        _print_continue()
        return
    if _env_truthy("CODEMEM_PLUGIN_IGNORE", False):
        _print_continue()
        return
    if not _env_truthy("CODEMEM_INJECT_CONTEXT", True):
        _print_continue()
        return

    prompt_raw = payload.get("prompt")
    prompt = prompt_raw.strip().replace("\n", " ") if isinstance(prompt_raw, str) else ""
    if not prompt:
        _print_continue()
        return

    project = _resolve_project_for_injection(payload)
    limit = max(1, _env_int("CODEMEM_INJECT_LIMIT", 8))
    token_budget = max(1, _env_int("CODEMEM_INJECT_TOKEN_BUDGET", 800))
    pack_text = _fetch_pack_text(
        prompt=prompt,
        project=project,
        limit=limit,
        token_budget=token_budget,
    )
    if not pack_text:
        _print_continue()
        return

    max_chars = _env_int("CODEMEM_INJECT_MAX_CHARS", 16000)
    output = {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": _truncate_pack_text(pack_text, max_chars),
        },
    }
    print(json.dumps(output, ensure_ascii=False))
