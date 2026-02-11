from __future__ import annotations

import json
import time
import urllib.request
from contextlib import closing
from typing import Any


def _wait_for_http_json(url: str, *, timeout_s: float = 3.0) -> Any:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with closing(urllib.request.urlopen(url, timeout=1)) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.05)
    raise AssertionError(f"failed to fetch JSON from {url}: {last_error!r}")


def _wait_for_http_text(url: str, *, timeout_s: float = 3.0) -> str:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with closing(urllib.request.urlopen(url, timeout=1)) as resp:
                return resp.read().decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.05)
    raise AssertionError(f"failed to fetch text from {url}: {last_error!r}")


def test_viewer_api_contract_smoke(tmp_path, monkeypatch) -> None:
    """Contract test between viewer HTML and backend routes.

    This intentionally runs the viewer server and performs a small set of
    requests that the bundled UI relies on. If a refactor changes route paths or
    response shapes, this should fail fast.
    """

    monkeypatch.setenv("CODEMEM_DB", str(tmp_path / "mem.sqlite"))

    from codemem.viewer import start_viewer

    host = "127.0.0.1"
    port = 38891
    start_viewer(host=host, port=port, background=True)

    base = f"http://{host}:{port}"

    html = _wait_for_http_text(base + "/")
    assert "codemem viewer" in html

    js = _wait_for_http_text(base + "/assets/app.js")
    assert "fetch(" in js
    assert 'public_key: isSyncRedactionEnabled() ? "[redacted]" : payload.public_key' not in js
    assert "addresses: isSyncRedactionEnabled()" not in js

    favicon = _wait_for_http_text(base + "/assets/favicon.svg")
    assert "<svg" in favicon

    stats = _wait_for_http_json(base + "/api/stats")
    assert isinstance(stats, dict)
    assert "database" in stats

    memories = _wait_for_http_json(base + "/api/memories")
    assert isinstance(memories, dict)
    assert isinstance(memories.get("items"), list)
    if memories["items"]:
        assert "project" in memories["items"][0]

    config = _wait_for_http_json(base + "/api/config")
    assert isinstance(config, dict)
    assert "effective" in config

    usage = _wait_for_http_json(base + "/api/usage")
    assert isinstance(usage, dict)
    assert "totals" in usage

    projects = _wait_for_http_json(base + "/api/projects")
    assert isinstance(projects, dict)
    assert "projects" in projects

    # UI contract: these endpoints are used by the bundled viewer_html.
    for path in [
        "/api/session?project=",
        "/api/raw-events?project=",
        "/api/memories?project=",
        "/api/summaries?project=",
        "/api/sync/status",
    ]:
        payload = _wait_for_http_json(base + path)
        assert isinstance(payload, dict)

    sync_status = _wait_for_http_json(base + "/api/sync/status")
    assert isinstance(sync_status, dict)
    assert "status" in sync_status
    assert "peers" in sync_status
    assert "attempts" in sync_status

    # Viewer runs in a daemon thread; no explicit stop hook.


def test_cli_entrypoints_import() -> None:
    """Ensure refactors don't break the CLI import surface."""

    import codemem.cli  # noqa: F401
    import codemem.cli_app  # noqa: F401
