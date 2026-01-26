from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import socket
import threading
import time
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config import (
    OpencodeMemConfig,
    get_config_path,
    get_env_overrides,
    load_config,
    read_config_file,
    write_config_file,
)
from .db import DEFAULT_DB_PATH, from_json
from .net import pick_advertise_host, pick_advertise_hosts
from .observer import _load_opencode_config
from .raw_event_flush import flush_raw_events
from .store import MemoryStore
from .sync_daemon import sync_once
from .sync_discovery import load_peer_addresses
from .sync_identity import ensure_device_identity, load_public_key

DEFAULT_VIEWER_HOST = "127.0.0.1"
DEFAULT_VIEWER_PORT = 38888
DEFAULT_PROVIDER_OPTIONS = ("openai", "anthropic")


def _strip_private(text: str) -> str:
    if not text:
        return ""
    return re.sub(r"<private>.*?</private>", "", text, flags=re.DOTALL | re.IGNORECASE)


def _strip_private_obj(value: Any) -> Any:
    if isinstance(value, str):
        return _strip_private(value)
    if isinstance(value, list):
        return [_strip_private_obj(item) for item in value]
    if isinstance(value, dict):
        return {k: _strip_private_obj(v) for k, v in value.items()}
    return value


class RawEventAutoFlusher:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._timers: dict[str, threading.Timer] = {}
        self._flushing: set[str] = set()

    def enabled(self) -> bool:
        return os.environ.get("OPENCODE_MEM_RAW_EVENTS_AUTO_FLUSH") == "1"

    def debounce_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_DEBOUNCE_MS", "60000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 60000

    def note_activity(self, opencode_session_id: str) -> None:
        if not opencode_session_id:
            return
        if not self.enabled():
            return
        delay_ms = self.debounce_ms()
        if delay_ms <= 0:
            self.flush_now(opencode_session_id)
            return
        with self._lock:
            existing = self._timers.pop(opencode_session_id, None)
            if existing:
                existing.cancel()
            timer = threading.Timer(delay_ms / 1000.0, self.flush_now, args=(opencode_session_id,))
            timer.daemon = True
            self._timers[opencode_session_id] = timer
            timer.start()

    def flush_now(self, opencode_session_id: str) -> None:
        if not opencode_session_id:
            return
        with self._lock:
            if opencode_session_id in self._flushing:
                return
            self._flushing.add(opencode_session_id)
            timer = self._timers.pop(opencode_session_id, None)
        if timer:
            timer.cancel()
        try:
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            try:
                flush_raw_events(
                    store,
                    opencode_session_id=opencode_session_id,
                    cwd=None,
                    project=None,
                    started_at=None,
                    max_events=None,
                )
            finally:
                store.close()
        finally:
            with self._lock:
                self._flushing.discard(opencode_session_id)


RAW_EVENT_FLUSHER = RawEventAutoFlusher()


class RawEventSweeper:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def enabled(self) -> bool:
        value = (os.environ.get("OPENCODE_MEM_RAW_EVENTS_SWEEPER") or "1").strip().lower()
        return value not in {"0", "false", "off"}

    def interval_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_SWEEPER_INTERVAL_MS", "30000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 30000

    def idle_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_SWEEPER_IDLE_MS", "120000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 120000

    def limit(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_SWEEPER_LIMIT", "25")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 25

    def retention_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_RETENTION_MS", "0")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def stuck_batch_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_STUCK_BATCH_MS", "300000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 300000

    def tick(self) -> None:
        if not self.enabled():
            return
        now_ms = int(time.time() * 1000)
        idle_before = now_ms - self.idle_ms()
        store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
        try:
            retention_ms = self.retention_ms()
            if retention_ms > 0:
                store.purge_raw_events(retention_ms)

            stuck_ms = self.stuck_batch_ms()
            if stuck_ms > 0:
                cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(milliseconds=stuck_ms)
                store.mark_stuck_raw_event_batches_as_error(
                    older_than_iso=cutoff.isoformat(),
                    limit=100,
                )

            session_ids = store.raw_event_sessions_pending_idle_flush(
                idle_before_ts_wall_ms=idle_before,
                limit=self.limit(),
            )
            for opencode_session_id in session_ids:
                try:
                    flush_raw_events(
                        store,
                        opencode_session_id=opencode_session_id,
                        cwd=None,
                        project=None,
                        started_at=None,
                        max_events=None,
                    )
                except Exception:
                    continue
        finally:
            store.close()

    def start(self) -> None:
        if not self.enabled():
            return
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        interval_ms = max(1000, self.interval_ms())
        while not self._stop.wait(interval_ms / 1000.0):
            self.tick()


RAW_EVENT_SWEEPER = RawEventSweeper()


def _load_provider_options() -> list[str]:
    config = _load_opencode_config()
    provider_config = config.get("provider", {})
    providers: list[str] = []
    if isinstance(provider_config, dict):
        providers = [key for key in provider_config if isinstance(key, str) and key]
    if not providers:
        return list(DEFAULT_PROVIDER_OPTIONS)
    combined = sorted(set(providers) | set(DEFAULT_PROVIDER_OPTIONS))
    return combined


VIEWER_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>opencode-mem viewer</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g1' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%231f6f5c'/%3E%3Cstop offset='100%25' style='stop-color:%23e67e4d'/%3E%3C/linearGradient%3E%3Cfilter id='shadow'%3E%3CfeDropShadow dx='0' dy='2' stdDeviation='3' flood-color='%23000' flood-opacity='0.5'/%3E%3C/filter%3E%3C/defs%3E%3Crect x='5' y='5' width='90' height='90' rx='16' fill='%23fff' stroke='%23000' stroke-width='3' filter='url(%23shadow)'/%3E%3Crect x='8' y='8' width='84' height='84' rx='14' fill='url(%23g1)'/%3E%3Cpath d='M20 75V25h15l15 25 15-25h15v50h-15V45l-15 22-15-22v30z' fill='white'/%3E%3C/svg%3E" />
    <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
      :root {
        --bg: #f7f1e7;
        --ink: #191817;
        --muted: #6f6254;
        --card: #fffaf3;
        --accent: #1f6f5c;
        --accent-2: #e67e4d;
        --accent-3: #223a5e;
        --border: #e0d4c3;
        --shadow: 0 18px 40px rgba(24, 23, 18, 0.12);
        --header-bg: rgba(255, 250, 243, 0.86);
        --input-bg: rgba(255, 255, 255, 0.7);
        --item-bg: rgba(255, 255, 255, 0.6);
        --item-hover-bg: rgba(255, 255, 255, 0.85);
        --stat-bg: #fffdf7;
        --body-grad-1: rgba(31, 111, 92, 0.16);
        --body-grad-2: rgba(230, 126, 77, 0.2);
        --body-grad-3: rgba(34, 58, 94, 0.12);
        --body-base-start: #fff6ea;
        --body-base-mid: #f3eadc;
        --body-base-end: #efe3d2;
        --dot-color: rgba(0, 0, 0, 0.03);
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) {
          --bg: #1a1918;
          --ink: #f0ebe6;
          --muted: #b8b3ae;
          --card: #2a2827;
          --accent: #4dd4b4;
          --accent-2: #ffad7a;
          --accent-3: #8bb3ff;
          --border: #4a4745;
          --shadow: 0 18px 40px rgba(0, 0, 0, 0.6);
          --header-bg: rgba(42, 40, 39, 0.95);
          --input-bg: rgba(60, 58, 56, 1);
          --item-bg: rgba(50, 48, 46, 1);
          --item-hover-bg: rgba(60, 58, 56, 1);
          --stat-bg: #323130;
          --body-grad-1: rgba(77, 212, 180, 0.08);
          --body-grad-2: rgba(255, 173, 122, 0.08);
          --body-grad-3: rgba(139, 179, 255, 0.06);
          --body-base-start: #1a1918;
          --body-base-mid: #1f1e1d;
          --body-base-end: #242322;
          --dot-color: rgba(255, 255, 255, 0.04);
        }
      }
      [data-theme="dark"] {
        --bg: #1a1918;
        --ink: #f0ebe6;
        --muted: #b8b3ae;
        --card: #2a2827;
        --accent: #4dd4b4;
        --accent-2: #ffad7a;
        --accent-3: #8bb3ff;
        --border: #4a4745;
        --shadow: 0 18px 40px rgba(0, 0, 0, 0.6);
        --header-bg: rgba(42, 40, 39, 0.95);
        --input-bg: rgba(60, 58, 56, 1);
        --item-bg: rgba(50, 48, 46, 1);
        --item-hover-bg: rgba(60, 58, 56, 1);
        --stat-bg: #323130;
        --body-grad-1: rgba(77, 212, 180, 0.08);
        --body-grad-2: rgba(255, 173, 122, 0.08);
        --body-grad-3: rgba(139, 179, 255, 0.06);
        --body-base-start: #1a1918;
        --body-base-mid: #1f1e1d;
        --body-base-end: #242322;
        --dot-color: rgba(255, 255, 255, 0.04);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", "Avenir Next", "Avenir", "Futura", "Gill Sans", "Optima", "Trebuchet MS", sans-serif;
        background:
          radial-gradient(circle at 12% 12%, var(--body-grad-1), transparent 45%),
          radial-gradient(circle at 82% 18%, var(--body-grad-2), transparent 42%),
          radial-gradient(circle at 70% 85%, var(--body-grad-3), transparent 40%),
          linear-gradient(180deg, var(--body-base-start) 0%, var(--body-base-mid) 65%, var(--body-base-end) 100%);
        color: var(--ink);
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background-image: radial-gradient(var(--dot-color) 1px, transparent 0);
        background-size: 18px 18px;
        opacity: 0.35;
        pointer-events: none;
        z-index: 0;
      }
      body::after {
        content: "";
        position: fixed;
        inset: 0;
        background: conic-gradient(from 120deg at 50% 20%, var(--body-grad-1), transparent 40%, var(--body-grad-2));
        opacity: 0.35;
        pointer-events: none;
        z-index: 0;
      }
      header {
        position: sticky;
        top: 0;
        z-index: 2;
        padding: 26px 28px 18px;
        border-bottom: 1px solid var(--border);
        background: var(--header-bg);
        backdrop-filter: blur(6px);
      }
      .header-grid {
        display: grid;
        grid-template-columns: minmax(240px, 1.3fr) minmax(200px, 1fr);
        gap: 12px;
        align-items: center;
      }
      .project-filter {
        padding: 6px 10px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--input-bg);
        color: var(--ink);
        font-size: 13px;
        cursor: pointer;
        transition: border-color 0.2s ease, background 0.2s ease;
      }
      .project-filter:hover {
        border-color: var(--accent);
        background: var(--item-hover-bg);
      }
      .project-filter:focus {
        outline: none;
        border-color: var(--accent);
      }
      h1 {
        margin: 0 0 8px;
        font-family: "Fraunces", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        font-size: 32px;
        letter-spacing: 0.6px;
      }
      .meta {
        color: var(--muted);
        font-size: 14px;
      }
      .meta strong { color: var(--ink); }
      .header-left {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .header-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .header-right {
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-end;
        text-align: right;
      }
      main {
        position: relative;
        z-index: 1;
        padding: 24px 28px 48px;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .summary-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 20px;
      }
      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .section-header h2 {
        margin: 0;
      }
      .diag-list {
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .diag-line {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 10px 12px;
        background: var(--item-bg);
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      .diag-line .left {
        min-width: 0;
      }
      .diag-line .right {
        flex-shrink: 0;
        color: var(--muted);
      }
      section {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 18px;
        box-shadow: var(--shadow);
        transform: translateY(10px);
        opacity: 0;
        animation: liftIn 0.7s ease forwards;
      }
      .feed-section {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      section h2 {
        margin: 0 0 10px;
        font-size: 18px;
        letter-spacing: 0.4px;
      }
      .pill {
        display: inline-block;
        padding: 2px 10px;
        border-radius: 999px;
        background: rgba(31, 111, 92, 0.12);
        color: var(--accent);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.3px;
      }
      .pill.alt {
        background: rgba(230, 126, 77, 0.15);
        color: var(--accent-2);
      }
      [data-theme="dark"] .pill {
        background: rgba(77, 212, 180, 0.2);
      }
      [data-theme="dark"] .pill.alt {
        background: rgba(255, 173, 122, 0.2);
      }
      ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      li {
        padding: 10px 12px;
        border: 1px solid transparent;
        border-radius: 12px;
        margin-bottom: 8px;
        background: var(--item-bg);
        transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
        font-size: 14px;
      }
      li:last-child { margin-bottom: 0; }
      li:hover {
        transform: translateY(-1px);
        border-color: var(--accent);
        background: var(--item-hover-bg);
      }
      .small { color: var(--muted); font-size: 12px; }
      .mono { font-family: "SF Mono", "Menlo", "Courier New", monospace; font-size: 12px; }
      .grid-2 {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 8px;
      }
      .stat {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px;
        background: var(--stat-bg);
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .stat-icon {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        stroke: var(--accent);
        opacity: 0.7;
      }
      .stat-content {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .stat .value {
        font-weight: 600;
        font-size: 18px;
        color: var(--accent-3);
      }
      .stat .label { color: var(--muted); font-size: 12px; }
      .refresh {
        margin-left: auto;
        font-size: 12px;
        color: var(--muted);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--accent-2);
        box-shadow: 0 0 0 4px rgba(230, 126, 77, 0.18);
        animation: pulse 2.4s ease infinite;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(34, 58, 94, 0.12);
        color: var(--accent-3);
        font-size: 12px;
        font-weight: 600;
      }
      [data-theme="dark"] .badge {
        background: rgba(139, 179, 255, 0.2);
      }
      .section-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
        color: var(--muted);
        font-size: 12px;
      }
      .sync-section .section-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .peer-list {
        display: grid;
        gap: 12px;
      }
      .peer-card {
        border: 1px solid rgba(25, 24, 23, 0.12);
        border-radius: 14px;
        padding: 14px 16px;
        background: rgba(255, 250, 243, 0.9);
        display: grid;
        gap: 8px;
      }
      [data-theme="dark"] .peer-card {
        background: rgba(24, 28, 32, 0.75);
        border-color: rgba(255, 255, 255, 0.08);
      }
      .peer-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .peer-title strong {
        font-size: 1rem;
      }
      .peer-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .peer-actions button {
        border: 1px solid rgba(25, 24, 23, 0.15);
        background: transparent;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .peer-actions button:hover {
        border-color: rgba(25, 24, 23, 0.35);
      }
      [data-theme="dark"] .peer-actions button {
        border-color: rgba(255, 255, 255, 0.14);
        color: rgba(233, 238, 245, 0.9);
      }
      [data-theme="dark"] .peer-actions button:hover {
        border-color: rgba(255, 255, 255, 0.24);
        background: rgba(255, 255, 255, 0.06);
      }
      .peer-meta {
        font-size: 0.85rem;
        color: var(--muted);
      }
      .peer-addresses {
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 0.8rem;
        color: var(--ink);
        opacity: 0.7;
      }
      .attempts-list {
        margin-top: 12px;
        display: grid;
        gap: 6px;
        font-size: 0.85rem;
        color: var(--muted);
      }
      .pairing-card {
        margin-top: 14px;
        border: 1px dashed rgba(25, 24, 23, 0.2);
        border-radius: 16px;
        padding: 14px 16px;
        display: grid;
        gap: 10px;
        background: rgba(255, 250, 243, 0.7);
      }
      [data-theme="dark"] .pairing-card {
        border-color: rgba(255, 255, 255, 0.12);
        background: rgba(20, 24, 28, 0.6);
      }
      .pairing-body {
        display: grid;
        gap: 12px;
        grid-template-columns: 1.4fr 1fr;
        align-items: start;
      }
      .pairing-body pre {
        margin: 0;
        font-size: 12px;
        background: rgba(0, 0, 0, 0.04);
        padding: 10px;
        border-radius: 12px;
        white-space: pre-wrap;
        word-break: break-all;
      }
      [data-theme="dark"] .pairing-body pre {
        background: rgba(255, 255, 255, 0.06);
      }
      @media (max-width: 900px) {
        .pairing-body {
          grid-template-columns: 1fr;
        }
      }
      .section-meta .badge {
        background: rgba(31, 111, 92, 0.12);
        color: var(--accent);
      }
      [data-theme="dark"] .section-meta .badge {
        background: rgba(77, 212, 180, 0.2);
      }
      .kind-pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--pill-bg, rgba(31, 111, 92, 0.12));
        color: var(--pill-color, var(--accent));
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.3px;
        text-transform: uppercase;
      }
      .kind-pill.feature {
        --pill-bg: rgba(31, 111, 92, 0.16);
        --pill-color: #1a5a4d;
      }
      .kind-pill.change {
        --pill-bg: rgba(34, 58, 94, 0.16);
        --pill-color: #223a5e;
      }
      .kind-pill.bugfix {
        --pill-bg: rgba(230, 126, 77, 0.18);
        --pill-color: #8d451f;
      }
      .kind-pill.refactor {
        --pill-bg: rgba(127, 89, 193, 0.18);
        --pill-color: #5d3aa5;
      }
      .kind-pill.discovery {
        --pill-bg: rgba(120, 153, 235, 0.18);
        --pill-color: #3b55a6;
      }
      .kind-pill.decision {
        --pill-bg: rgba(94, 129, 172, 0.18);
        --pill-color: #3c516f;
      }
      .kind-pill.session_summary {
        --pill-bg: rgba(70, 150, 200, 0.18);
        --pill-color: #2b5f7a;
      }
      .kind-pill.exploration {
        --pill-bg: rgba(140, 140, 140, 0.18);
        --pill-color: #5a5a5a;
      }
      /* Dark mode pill overrides - high contrast, vibrant colors */
      [data-theme="dark"] .kind-pill.feature { --pill-bg: rgba(77, 255, 200, 0.25); --pill-color: #4dffb8; }
      [data-theme="dark"] .kind-pill.change { --pill-bg: rgba(120, 180, 255, 0.20); --pill-color: #78b4ff; }
      [data-theme="dark"] .kind-pill.bugfix { --pill-bg: rgba(255, 150, 100, 0.25); --pill-color: #ff9664; }
      [data-theme="dark"] .kind-pill.refactor { --pill-bg: rgba(180, 120, 255, 0.18); --pill-color: #d4a0ff; }
      [data-theme="dark"] .kind-pill.discovery { --pill-bg: rgba(255, 210, 80, 0.25); --pill-color: #ffd250; }
      [data-theme="dark"] .kind-pill.decision { --pill-bg: rgba(255, 160, 160, 0.20); --pill-color: #ffa0a0; }
      [data-theme="dark"] .kind-pill.session_summary { --pill-bg: rgba(100, 220, 255, 0.20); --pill-color: #64dcff; }
      [data-theme="dark"] .kind-pill.exploration { --pill-bg: rgba(180, 180, 180, 0.18); --pill-color: #b0b0b0; }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) .kind-pill.feature { --pill-bg: rgba(77, 255, 200, 0.25); --pill-color: #4dffb8; }
        :root:not([data-theme="light"]) .kind-pill.change { --pill-bg: rgba(120, 180, 255, 0.20); --pill-color: #78b4ff; }
        :root:not([data-theme="light"]) .kind-pill.bugfix { --pill-bg: rgba(255, 150, 100, 0.25); --pill-color: #ff9664; }
        :root:not([data-theme="light"]) .kind-pill.refactor { --pill-bg: rgba(180, 120, 255, 0.18); --pill-color: #d4a0ff; }
        :root:not([data-theme="light"]) .kind-pill.discovery { --pill-bg: rgba(255, 210, 80, 0.25); --pill-color: #ffd250; }
        :root:not([data-theme="light"]) .kind-pill.decision { --pill-bg: rgba(255, 160, 160, 0.20); --pill-color: #ffa0a0; }
        :root:not([data-theme="light"]) .kind-pill.session_summary { --pill-bg: rgba(100, 220, 255, 0.20); --pill-color: #64dcff; }
        :root:not([data-theme="light"]) .kind-pill.exploration { --pill-bg: rgba(180, 180, 180, 0.18); --pill-color: #b0b0b0; }
      }
      .kind-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .settings-button {
        border: 1px solid rgba(31, 111, 92, 0.3);
        background: rgba(31, 111, 92, 0.12);
        color: var(--accent);
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        cursor: pointer;
        transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
      }
      .settings-button:hover {
        transform: translateY(-1px);
        border-color: rgba(31, 111, 92, 0.5);
        background: rgba(31, 111, 92, 0.18);
      }
      [data-theme="dark"] .settings-button {
        border-color: rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.06);
        color: rgba(233, 238, 245, 0.9);
      }
      [data-theme="dark"] .settings-button:hover {
        border-color: rgba(255, 255, 255, 0.24);
        background: rgba(255, 255, 255, 0.10);
      }
      /* Theme toggle icon sizing */
      #themeToggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 6px 8px;
      }
      #themeToggle svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(25, 24, 23, 0.4);
        backdrop-filter: blur(4px);
        z-index: 3;
      }
      .modal {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 4;
        padding: 24px;
      }
      .modal-backdrop[hidden],
      .modal[hidden] {
        display: none;
      }
      .modal-card {
        width: min(520px, 100%);
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 20px;
        box-shadow: var(--shadow);
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .modal-header h2 {
        margin: 0;
        font-size: 20px;
      }
      .modal-close {
        border: none;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        font-size: 12px;
      }
      .modal-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 13px;
      }
      .field input,
      .field select {
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.7);
        font-size: 13px;
      }
      .modal-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .settings-save {
        border: none;
        background: var(--accent);
        color: #fffaf3;
        padding: 8px 14px;
        border-radius: 12px;
        font-size: 12px;
        cursor: pointer;
      }
      .settings-save:hover {
        background: #1a5e4f;
      }
      .settings-save:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .settings-note {
        color: var(--muted);
        font-size: 12px;
      }
      .title {
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .feed-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .feed-item {
        border: 1px solid var(--border);
        border-left: 6px solid var(--accent);
        border-radius: 16px;
        padding: 14px 16px;
        background: var(--input-bg);
        display: flex;
        flex-direction: column;
        gap: 8px;
        transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
      }
      .feed-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .feed-item:hover {
        transform: translateY(-1px);
        border-left-color: var(--accent-2);
        background: var(--item-hover-bg);
      }
      .feed-header {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .feed-title {
        font-weight: 600;
        font-size: 15px;
      }
      .feed-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .feed-controls .section-meta {
        margin: 0;
      }
      .feed-project {
        color: var(--muted);
        font-size: 12px;
      }
      .feed-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(0, 0, 0, 0.02);
      }
      [data-theme="dark"] .feed-toggle {
        background: rgba(255, 255, 255, 0.04);
      }
      .toggle-button {
        border: none;
        background: transparent;
        color: var(--muted);
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 999px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: background 0.2s ease, color 0.2s ease;
      }
      .toggle-button.active {
        background: rgba(31, 111, 92, 0.18);
        color: var(--accent);
        font-weight: 600;
      }
      [data-theme="dark"] .toggle-button.active {
        background: rgba(77, 212, 180, 0.25);
      }
      .feed-meta {
        color: var(--muted);
        font-size: 12px;
      }
      .feed-body {
        font-size: 13px;
        line-height: 1.5;
      }
      .feed-body.facts {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .feed-body p { margin: 0 0 0.5em; }
      .feed-body p:last-child { margin-bottom: 0; }
      .feed-body ul, .feed-body ol { margin: 0.3em 0; padding-left: 1.3em; list-style: revert; }
      .feed-body li {
        margin: 0.15em 0;
        padding: 0;
        border: none;
        border-radius: 0;
        background: none;
        font-size: inherit;
      }
      .feed-body li:hover {
        transform: none;
        border-color: transparent;
        background: none;
      }
      .feed-body code {
        background: var(--stat-bg);
        padding: 0.15em 0.35em;
        border-radius: 4px;
        font-family: "SF Mono", "Menlo", "Courier New", monospace;
        font-size: 0.9em;
      }
      .feed-body pre {
        background: var(--stat-bg);
        padding: 0.6em 0.8em;
        border-radius: 8px;
        overflow-x: auto;
        margin: 0.5em 0;
      }
      .feed-body pre code {
        background: none;
        padding: 0;
      }
      .feed-body strong { font-weight: 600; }
      .feed-body em { font-style: italic; }
      .feed-body a { color: var(--accent); text-decoration: underline; }
      .feed-body h1, .feed-body h2, .feed-body h3, .feed-body h4 {
        font-size: 1em;
        font-weight: 600;
        margin: 0.6em 0 0.3em;
      }
      .feed-body blockquote {
        border-left: 3px solid var(--border);
        margin: 0.5em 0;
        padding-left: 0.8em;
        color: var(--muted);
      }
      .summary-section {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px 0;
        border-bottom: 1px solid var(--border);
      }
      .summary-section:last-child {
        border-bottom: none;
      }
      .summary-section-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--muted);
      }
      .summary-section-content {
        font-size: 13px;
        line-height: 1.5;
        color: var(--text);
      }
      .feed-footer {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: flex-start;
        justify-content: space-between;
      }
      .feed-footer-left {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .feed-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .feed-files {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        font-size: 10px;
        color: var(--muted);
        opacity: 0.85;
      }
      [data-theme="dark"] .feed-files {
        opacity: 0.7;
      }
      .feed-file {
        white-space: nowrap;
      }
      .tag-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border-radius: 999px;
        background: rgba(34, 58, 94, 0.12);
        color: var(--accent-3);
        font-size: 11px;
        font-weight: 600;
      }
      [data-theme="dark"] .tag-chip {
        background: rgba(139, 179, 255, 0.2);
      }
      .feed-item.feature { border-left-color: rgba(31, 111, 92, 0.6); }
      .feed-item.change { border-left-color: rgba(34, 58, 94, 0.6); }
      .feed-item.bugfix { border-left-color: rgba(230, 126, 77, 0.7); }
      .feed-item.refactor { border-left-color: rgba(127, 89, 193, 0.6); }
      .feed-item.discovery { border-left-color: rgba(120, 153, 235, 0.6); }
      .feed-item.decision { border-left-color: rgba(94, 129, 172, 0.6); }
      .feed-item.session_summary { border-left-color: rgba(70, 150, 200, 0.6); }
      .feed-item.exploration { border-left-color: rgba(140, 140, 140, 0.6); }
      /* Dark mode border overrides - vibrant, high contrast */
      [data-theme="dark"] .feed-item.feature { border-left-color: rgba(77, 255, 200, 0.9); }
      [data-theme="dark"] .feed-item.change { border-left-color: rgba(120, 180, 255, 0.9); }
      [data-theme="dark"] .feed-item.bugfix { border-left-color: rgba(255, 150, 100, 0.9); }
      [data-theme="dark"] .feed-item.refactor { border-left-color: rgba(200, 150, 255, 0.9); }
      [data-theme="dark"] .feed-item.discovery { border-left-color: rgba(255, 210, 80, 0.9); }
      [data-theme="dark"] .feed-item.decision { border-left-color: rgba(255, 180, 180, 0.9); }
      [data-theme="dark"] .feed-item.session_summary { border-left-color: rgba(100, 220, 255, 0.9); }
      [data-theme="dark"] .feed-item.exploration { border-left-color: rgba(180, 180, 180, 0.7); }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) .feed-item.feature { border-left-color: rgba(77, 255, 200, 0.9); }
        :root:not([data-theme="light"]) .feed-item.change { border-left-color: rgba(120, 180, 255, 0.9); }
        :root:not([data-theme="light"]) .feed-item.bugfix { border-left-color: rgba(255, 150, 100, 0.9); }
        :root:not([data-theme="light"]) .feed-item.refactor { border-left-color: rgba(200, 150, 255, 0.9); }
        :root:not([data-theme="light"]) .feed-item.discovery { border-left-color: rgba(255, 210, 80, 0.9); }
        :root:not([data-theme="light"]) .feed-item.decision { border-left-color: rgba(255, 180, 180, 0.9); }
        :root:not([data-theme="light"]) .feed-item.session_summary { border-left-color: rgba(100, 220, 255, 0.9); }
        :root:not([data-theme="light"]) .feed-item.exploration { border-left-color: rgba(180, 180, 180, 0.7); }
      }
      section:hover {
        transform: translateY(0);
        box-shadow: 0 22px 50px rgba(18, 25, 33, 0.16);
      }
      @keyframes liftIn {
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
      @keyframes pulse {
        0%, 100% { transform: scale(1); opacity: 0.9; }
        50% { transform: scale(1.3); opacity: 0.5; }
      }
      @media (max-width: 900px) {
        header {
          padding: 22px 20px 16px;
        }
        main {
          padding: 18px 20px 40px;
          gap: 16px;
        }
        .summary-row {
          grid-template-columns: 1fr;
        }
        .header-grid {
          grid-template-columns: 1fr;
        }
        .header-right {
          align-items: flex-start;
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="header-grid">
        <div class="header-left">
          <h1>opencode-mem viewer</h1>
          <div class="header-tags">
            <span class="pill alt">auto-refresh</span>
            <span class="refresh" id="refreshStatus"><span class="dot"></span>refreshing…</span>
          </div>
        </div>
        <div class="header-right">
          <div class="meta" id="metaLine">Loading stats…</div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <select class="project-filter" id="projectFilter">
              <option value="">All Projects</option>
            </select>
            <button class="settings-button" id="themeToggle" title="Toggle dark/light mode">☀️</button>
            <button class="settings-button" id="settingsButton">Settings</button>
          </div>
        </div>
      </div>
    </header>
    <div class="modal-backdrop" id="settingsBackdrop" hidden></div>
    <div class="modal" id="settingsModal" hidden>
      <div class="modal-card">
        <div class="modal-header">
          <h2>Observer settings</h2>
          <button class="modal-close" id="settingsClose">close</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label for="observerProvider">Observer provider</label>
            <select id="observerProvider">
              <option value="">auto (default)</option>
            </select>
            <div class="small">Leave blank to use defaults.</div>
          </div>
          <div class="field">
            <label for="observerModel">Observer model</label>
            <input id="observerModel" placeholder="leave empty for default" />
            <div class="small">Override the observer model. For custom providers, use provider/model (or set provider explicitly).</div>
          </div>
          <div class="field">
            <label for="observerMaxChars">Observer max chars</label>
            <input id="observerMaxChars" type="number" min="1" />
            <div class="small" id="observerMaxCharsHint"></div>
          </div>
          <div class="field">
            <label for="packObservationLimit">Pack observation limit</label>
            <input id="packObservationLimit" type="number" min="1" />
            <div class="small">Default number of observations to include in a pack.</div>
          </div>
          <div class="field">
            <label for="packSessionLimit">Pack session limit</label>
            <input id="packSessionLimit" type="number" min="1" />
            <div class="small">Default number of session summaries to include in a pack.</div>
          </div>
          <div class="field">
            <label>Sync settings</label>
            <div class="small">Configure peer sync. Environment variables override these values.</div>
          </div>
          <div class="field">
            <label for="syncEnabled">Sync enabled</label>
            <input id="syncEnabled" type="checkbox" />
          </div>
          <div class="field">
            <label for="syncHost">Sync host</label>
            <input id="syncHost" placeholder="127.0.0.1" />
          </div>
          <div class="field">
            <label for="syncPort">Sync port</label>
            <input id="syncPort" type="number" min="1" />
          </div>
          <div class="field">
            <label for="syncInterval">Sync interval (seconds)</label>
            <input id="syncInterval" type="number" min="10" />
          </div>
          <div class="field">
            <label for="syncMdns">mDNS discovery</label>
            <input id="syncMdns" type="checkbox" />
          </div>
          <div class="small mono" id="settingsPath"></div>
          <div class="small" id="settingsEffective"></div>
          <div class="settings-note" id="settingsOverrides">Environment variables override file settings.</div>
        </div>
        <div class="modal-footer">
          <div class="small" id="settingsStatus">Ready</div>
          <button class="settings-save" id="settingsSave">Save</button>
        </div>
      </div>
    </div>
    <main>
      <div class="summary-row">
        <section>
          <h2>Stats</h2>
          <div class="grid-2" id="statsGrid"></div>
        </section>
        <section>
          <h2>Current session</h2>
          <div class="section-meta" id="sessionMeta">No injections yet</div>
          <div class="grid-2" id="sessionGrid"></div>
        </section>
      </div>
      <section class="sync-section" style="animation-delay: 0.04s;">
        <div class="section-header">
          <h2>Sync</h2>
          <div class="section-actions">
            <button class="settings-button" id="syncNowButton">Sync now</button>
          </div>
        </div>
        <div class="section-meta" id="syncMeta">Loading sync status…</div>
        <div class="grid-2" id="syncStatusGrid"></div>
        <div class="peer-list" id="syncPeers"></div>
        <div class="attempts-list" id="syncAttempts"></div>
        <div class="pairing-card" id="syncPairing">
          <div class="peer-title">
            <strong>Pairing payload</strong>
            <div class="peer-actions">
              <button id="pairingCopy">Copy pairing command</button>
            </div>
          </div>
          <div class="pairing-body">
            <pre id="pairingPayload">Loading…</pre>
          </div>
          <div class="peer-meta" id="pairingHint">Run the command on the other machine to pair.</div>
        </div>
      </section>
      <section style="animation-delay: 0.06s;">
        <div class="section-header">
          <h2>Diagnostics</h2>
          <button class="settings-button" id="diagnosticsToggle">Show</button>
        </div>
        <div id="diagnosticsBody" hidden>
          <div class="section-meta" id="rawEventsMeta">Loading raw event backlog…</div>
          <div class="grid-2" id="rawEventsGrid"></div>
          <div class="diag-list" id="rawEventsList"></div>
        </div>
      </section>
        <section class="feed-section" style="animation-delay: 0.1s;">
          <h2>Memory feed</h2>
          <div class="feed-controls">
            <div class="section-meta" id="feedMeta">Loading memories…</div>
            <div class="feed-toggle" id="feedTypeToggle">
              <button class="toggle-button" data-filter="all">All</button>
              <button class="toggle-button" data-filter="observations">Observations</button>
              <button class="toggle-button" data-filter="summaries">Summaries</button>
            </div>
          </div>
          <div class="feed-list" id="feedList"></div>
        </section>
    </main>
    <script>
      const refreshStatus = document.getElementById("refreshStatus");
      const statsGrid = document.getElementById("statsGrid");
      const metaLine = document.getElementById("metaLine");
      const feedList = document.getElementById("feedList");
      const feedMeta = document.getElementById("feedMeta");
      const feedTypeToggle = document.getElementById("feedTypeToggle");
      const sessionGrid = document.getElementById("sessionGrid");
      const sessionMeta = document.getElementById("sessionMeta");
      const diagnosticsToggle = document.getElementById("diagnosticsToggle");
      const diagnosticsBody = document.getElementById("diagnosticsBody");
      const rawEventsMeta = document.getElementById("rawEventsMeta");
      const rawEventsGrid = document.getElementById("rawEventsGrid");
      const rawEventsList = document.getElementById("rawEventsList");
      const settingsButton = document.getElementById("settingsButton");
      const settingsBackdrop = document.getElementById("settingsBackdrop");
      const settingsModal = document.getElementById("settingsModal");
      const settingsClose = document.getElementById("settingsClose");
      const settingsSave = document.getElementById("settingsSave");
      const settingsStatus = document.getElementById("settingsStatus");
      const settingsPath = document.getElementById("settingsPath");
      const settingsEffective = document.getElementById("settingsEffective");
      const settingsOverrides = document.getElementById("settingsOverrides");
      const observerProviderInput = document.getElementById("observerProvider");
      const observerModelInput = document.getElementById("observerModel");
      const observerMaxCharsInput = document.getElementById("observerMaxChars");
      const observerMaxCharsHint = document.getElementById("observerMaxCharsHint");
      const packObservationLimitInput = document.getElementById("packObservationLimit");
      const packSessionLimitInput = document.getElementById("packSessionLimit");
      const syncEnabledInput = document.getElementById("syncEnabled");
      const syncHostInput = document.getElementById("syncHost");
      const syncPortInput = document.getElementById("syncPort");
      const syncIntervalInput = document.getElementById("syncInterval");
      const syncMdnsInput = document.getElementById("syncMdns");
      const projectFilter = document.getElementById("projectFilter");
      const themeToggle = document.getElementById("themeToggle");
      const syncMeta = document.getElementById("syncMeta");
      const syncStatusGrid = document.getElementById("syncStatusGrid");
      const syncPeers = document.getElementById("syncPeers");
      const syncAttempts = document.getElementById("syncAttempts");
      const syncNowButton = document.getElementById("syncNowButton");
      const pairingPayload = document.getElementById("pairingPayload");
      const pairingCopy = document.getElementById("pairingCopy");
      const pairingHint = document.getElementById("pairingHint");

      let configDefaults = {};
      let configPath = "";
      let currentProject = "";
      const itemViewState = new Map();
      const FEED_FILTER_KEY = "opencode-mem-feed-filter";
      const FEED_FILTERS = ["all", "observations", "summaries"];
      const DIAGNOSTICS_KEY = "opencode-mem-diagnostics";
      let feedTypeFilter = "all";

      // Theme management
      function getTheme() {
        const saved = localStorage.getItem("opencode-mem-theme");
        if (saved) return saved;
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }

      function setTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("opencode-mem-theme", theme);
        themeToggle.innerHTML = theme === "dark"
          ? '<i data-lucide="sun"></i>'
          : '<i data-lucide="moon"></i>';
        themeToggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
        if (typeof lucide !== "undefined") lucide.createIcons();
      }

      function toggleTheme() {
        const current = getTheme();
        setTheme(current === "dark" ? "light" : "dark");
      }

      // Initialize theme
      setTheme(getTheme());
      themeToggle?.addEventListener("click", toggleTheme);

      setDiagnosticsOpen(isDiagnosticsOpen());
      diagnosticsToggle?.addEventListener("click", () => {
        const next = !isDiagnosticsOpen();
        setDiagnosticsOpen(next);
        if (next) {
          refresh();
        }
      });

      feedTypeFilter = getFeedTypeFilter();
      updateFeedTypeToggle();
      feedTypeToggle?.addEventListener("click", event => {
        const target = event.target.closest("button");
        if (!target) return;
        const value = target.dataset.filter || "all";
        setFeedTypeFilter(value);
      });

      function formatDate(value) {
        if (!value) return "n/a";
        const date = new Date(value);
        return isNaN(date) ? value : date.toLocaleString();
      }

      function normalize(text) {
        return (text || "").replace(/\\s+/g, " ").trim().toLowerCase();
      }

      function parseJsonArray(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch (e) {
            return [];
          }
        }
        return [];
      }

      function getFeedTypeFilter() {
        const saved = localStorage.getItem(FEED_FILTER_KEY) || "all";
        return FEED_FILTERS.includes(saved) ? saved : "all";
      }

      function isDiagnosticsOpen() {
        return localStorage.getItem(DIAGNOSTICS_KEY) === "1";
      }

      function setDiagnosticsOpen(open) {
        if (!diagnosticsBody) return;
        diagnosticsBody.hidden = !open;
        if (diagnosticsToggle) {
          diagnosticsToggle.textContent = open ? "Hide" : "Show";
        }
        localStorage.setItem(DIAGNOSTICS_KEY, open ? "1" : "0");
      }

      function setFeedTypeFilter(value) {
        feedTypeFilter = FEED_FILTERS.includes(value) ? value : "all";
        localStorage.setItem(FEED_FILTER_KEY, feedTypeFilter);
        updateFeedTypeToggle();
        refresh();
      }

      function updateFeedTypeToggle() {
        if (!feedTypeToggle) return;
        const buttons = Array.from(feedTypeToggle.querySelectorAll(".toggle-button"));
        buttons.forEach(button => {
          const value = button.dataset.filter || "all";
          button.classList.toggle("active", value === feedTypeFilter);
        });
      }

      function filterFeedItems(items) {
        if (feedTypeFilter === "observations") {
          return items.filter(item => (item.kind || "").toLowerCase() !== "session_summary");
        }
        if (feedTypeFilter === "summaries") {
          return items.filter(item => (item.kind || "").toLowerCase() === "session_summary");
        }
        return items;
      }

      function formatFeedFilterLabel() {
        if (feedTypeFilter === "observations") return " · observations";
        if (feedTypeFilter === "summaries") return " · session summaries";
        return "";
      }

      function extractFactsFromBody(text) {
        if (!text) return [];
        const lines = text.split("\\n").map(line => line.trim()).filter(Boolean);
        const bulletLines = lines.filter(line => /^[-*•]\\s+/.test(line) || /^\\d+\\./.test(line));
        if (!bulletLines.length) return [];
        return bulletLines.map(line => line.replace(/^[-*•]\\s+/, "").replace(/^\\d+\\.\\s+/, ""));
      }

      function isLowSignalObservation(item) {
        const title = normalize(item.title);
        const body = normalize(item.body_text);
        if (!title && !body) return true;

        const combined = body || title;
        if (combined.length < 10) return true;
        if (title && body && title === body && combined.length < 40) return true;

        const leadGlyph = title.charAt(0);
        const isPrompty = leadGlyph === "\u2514" || leadGlyph === "\u203a";
        if (isPrompty && combined.length < 40) return true;

        if (title.startsWith("list ") && combined.length < 20) return true;
        if (combined === "ls" || combined === "list ls") return true;

        return false;
      }

      function createElement(tag, className, text) {
        const el = document.createElement(tag);
        if (className) {
          el.className = className;
        }
        if (text !== undefined && text !== null) {
          el.textContent = text;
        }
        return el;
      }

      function formatTagLabel(tag) {
        if (!tag) return "";
        const trimmed = tag.trim();
        const colonIndex = trimmed.indexOf(":");
        if (colonIndex === -1) return trimmed;
        return trimmed.slice(0, colonIndex).trim();
      }

      function createTagChip(tag) {
        const display = formatTagLabel(tag);
        if (!display) return null;
        const chip = createElement("span", "tag-chip", display);
        chip.title = tag;
        return chip;
      }

      function mergeMetadata(metadata) {
        if (!metadata || typeof metadata !== "object") {
          return {};
        }
        const importMetadata = metadata.import_metadata;
        if (importMetadata && typeof importMetadata === "object") {
          return { ...importMetadata, ...metadata };
        }
        return metadata;
      }

      function formatFileList(files, limit = 2) {
        if (!files.length) return "";
        const trimmed = files.map(file => file.trim()).filter(Boolean);
        const slice = trimmed.slice(0, limit);
        const suffix = trimmed.length > limit ? ` +${trimmed.length - limit}` : "";
        return `${slice.join(", ")}${suffix}`.trim();
      }

      function renderStats(stats) {
        const db = stats.database || {};
        const usage = stats.usage?.totals || {};
        const items = [
          { label: "Sessions", value: db.sessions || 0, icon: "database" },
          { label: "Memories", value: db.memory_items || 0, icon: "brain" },
          { label: "Active memories", value: db.active_memory_items || 0, icon: "check-circle" },
          { label: "Artifacts", value: db.artifacts || 0, icon: "package" },
          { label: "Work investment", value: usage.work_investment_tokens || 0, tooltip: "Token cost of unique discovery groups (avoids double-counting when one response yields multiple memories)", icon: "pencil" },
          { label: "Read cost", value: usage.tokens_read || 0, tooltip: "Tokens to read memories when injected into context", icon: "book-open" },
          { label: "Savings", value: usage.tokens_saved || 0, tooltip: "Tokens saved by reusing compressed memories instead of raw context", icon: "trending-up" },
        ];
        statsGrid.textContent = "";
        items.forEach(item => {
          const stat = createElement("div", "stat");
          if (item.tooltip) {
            stat.title = item.tooltip;
            stat.style.cursor = "help";
          }
          const icon = document.createElement("i");
          icon.setAttribute("data-lucide", item.icon);
          icon.className = "stat-icon";
          const content = createElement("div", "stat-content");
          const value = createElement("div", "value", item.value.toLocaleString());
          const label = createElement("div", "label", item.label);
          content.append(value, label);
          stat.append(icon, content);
          statsGrid.appendChild(stat);
        });
        if (typeof lucide !== "undefined") lucide.createIcons();
        metaLine.textContent = `DB: ${db.path || "unknown"} · ${Math.round((db.size_bytes || 0) / 1024)} KB`;
      }

      function formatTimestamp(value) {
        if (!value) return "never";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }

      function renderSyncStatus(status) {
        if (!syncMeta || !syncStatusGrid) return;
        if (!status || typeof status !== "object") {
          syncMeta.textContent = "Sync status unavailable";
          syncStatusGrid.textContent = "";
          return;
        }
        const peerCount = status.peer_count || 0;
        const enabledLabel = status.enabled ? "enabled" : "disabled";
        syncMeta.textContent = `${enabledLabel} · ${peerCount} peers`;
        const items = [
          { label: "Device", value: status.device_id || "unpaired" },
          { label: "Bind", value: status.bind || "n/a" },
          { label: "Interval", value: status.interval_s ? `${status.interval_s}s` : "n/a" },
          { label: "Last sync", value: formatTimestamp(status.last_sync_at) },
        ];
        syncStatusGrid.textContent = "";
        items.forEach(item => {
          const stat = createElement("div", "stat");
          const content = createElement("div", "stat-content");
          const value = createElement("div", "value", item.value);
          const label = createElement("div", "label", item.label);
          content.append(value, label);
          stat.append(content);
          syncStatusGrid.appendChild(stat);
        });
      }

      async function syncPeerNow(peerDeviceId) {
        if (syncNowButton) syncNowButton.disabled = true;
        try {
          const payload = peerDeviceId ? { peer_device_id: peerDeviceId } : {};
          const response = await fetch("/api/sync/actions/sync-now", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            console.warn("Sync now failed");
          }
        } catch (err) {
          console.warn("Sync now error", err);
        } finally {
          if (syncNowButton) syncNowButton.disabled = false;
          refresh();
        }
      }

      async function renamePeer(peerDeviceId) {
        const name = window.prompt("Rename peer", "");
        if (!name) return;
        try {
          const response = await fetch("/api/sync/peers/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ peer_device_id: peerDeviceId, name }),
          });
          if (!response.ok) {
            console.warn("Rename peer failed");
          }
        } catch (err) {
          console.warn("Rename peer error", err);
        } finally {
          refresh();
        }
      }

      async function removePeer(peerDeviceId) {
        const confirmRemove = window.confirm("Remove this peer?");
        if (!confirmRemove) return;
        try {
          const response = await fetch(`/api/sync/peers/${peerDeviceId}`, { method: "DELETE" });
          if (!response.ok) {
            console.warn("Remove peer failed");
          }
        } catch (err) {
          console.warn("Remove peer error", err);
        } finally {
          refresh();
        }
      }

      function renderSyncPeers(items) {
        if (!syncPeers) return;
        syncPeers.textContent = "";
        if (!items || !items.length) {
          syncPeers.appendChild(createElement("div", "peer-meta", "No peers configured"));
          return;
        }
        items.forEach(peer => {
          const card = createElement("div", "peer-card");
          const titleRow = createElement("div", "peer-title");
          const name = peer.name || peer.peer_device_id || "peer";
          titleRow.appendChild(createElement("strong", "", name));
          const actions = createElement("div", "peer-actions");
          const syncButton = createElement("button", "", "Sync");
          syncButton.addEventListener("click", () => syncPeerNow(peer.peer_device_id));
          const renameButton = createElement("button", "", "Rename");
          renameButton.addEventListener("click", () => renamePeer(peer.peer_device_id));
          const removeButton = createElement("button", "", "Remove");
          removeButton.addEventListener("click", () => removePeer(peer.peer_device_id));
          actions.append(syncButton, renameButton, removeButton);
          titleRow.appendChild(actions);
          const meta = createElement(
            "div",
            "peer-meta",
            `last sync: ${formatTimestamp(peer.last_sync_at)} · status: ${peer.last_error || "ok"}`
          );
          const addresses = createElement(
            "div",
            "peer-addresses",
            (peer.addresses || []).join(", ") || "no addresses"
          );
          card.append(titleRow, meta, addresses);
          syncPeers.appendChild(card);
        });
      }

      function renderSyncAttempts(items) {
        if (!syncAttempts) return;
        syncAttempts.textContent = "";
        if (!items || !items.length) {
          syncAttempts.appendChild(createElement("div", "peer-meta", "No sync attempts yet"));
          return;
        }
        items.slice(0, 6).forEach(attempt => {
          const label = `${attempt.peer_device_id} · ${attempt.ok ? "ok" : "error"} · ${formatTimestamp(attempt.finished_at)}`;
          syncAttempts.appendChild(createElement("div", "peer-meta", label));
        });
      }

      async function renderPairing(payload) {
        if (!pairingPayload) return;
        if (!payload || typeof payload !== "object") {
          pairingPayload.textContent = "Pairing payload unavailable";
          if (pairingHint) pairingHint.textContent = "Generate a device identity first.";
          return;
        }
        const text = JSON.stringify(payload);
        const escaped = text.replace(/'/g, `'\\''`);
        const command = `opencode-mem sync pair --accept '${escaped}'`;
        pairingPayload.textContent = command;
        if (pairingHint) pairingHint.textContent = "Run the command on the other machine to pair.";
      }

      async function loadPairing() {
        try {
          const response = await fetch("/api/sync/pairing");
          const data = await response.json();
          if (!response.ok) {
            renderPairing(null);
            return;
          }
          await renderPairing(data);
        } catch (err) {
          renderPairing(null);
        }
      }

      function renderList(el, rows, formatter) {
        el.textContent = "";
        if (!rows.length) {
          el.appendChild(createElement("li", "small", "No data yet"));
          return;
        }
        rows.forEach(row => {
          const item = formatter(row);
          if (!item) {
            return;
          }
          if (item.nodeType !== Node.ELEMENT_NODE) {
            el.appendChild(createElement("li", "", String(item)));
            return;
          }
          if (item.tagName === "LI") {
            el.appendChild(item);
            return;
          }
          const wrapper = document.createElement("li");
          wrapper.appendChild(item);
          el.appendChild(wrapper);
        });
      }

      function renderFeed(items) {
        feedList.textContent = "";
        if (!items.length) {
          const empty = createElement("div", "small", "No memory items yet");
          feedList.appendChild(empty);
          return;
        }
        items.forEach(item => {
          const kindValue = (item.kind || "session_summary").toLowerCase();
          const feedItem = createElement("div", `feed-item ${kindValue}`);
          const headerRow = createElement("div", "feed-card-header");
          const header = createElement("div", "feed-header");
          const kindTag = createElement("span", `kind-pill ${kindValue}`, kindValue.replace(/_/g, " "));
          const metadata = mergeMetadata(item.metadata_json);
          const isSessionSummary = kindValue === "session_summary";
          const defaultTitle = item.title || "Memory entry";
          const displayTitle = isSessionSummary && metadata.request ? metadata.request : defaultTitle;
          const title = createElement("div", "feed-title", displayTitle);
          header.append(kindTag, title);
          if (item.project) {
            header.append(createElement("span", "feed-project", item.project));
          }
          const toggle = createElement("div", "feed-toggle");
          const summaryButton = createElement("button", "toggle-button", "summary");
          const factsButton = createElement("button", "toggle-button", "facts");
          const narrativeButton = createElement("button", "toggle-button", "narrative");
          headerRow.append(header, toggle);
          const metaParts = [];
          if (item.session_id) {
            metaParts.push(`session #${item.session_id}`);
          }
          if (item.id) {
            metaParts.push(`memory #${item.id}`);
          }
          if (item.created_at) {
            metaParts.push(formatDate(item.created_at));
          }
          const meta = createElement("div", "feed-meta", metaParts.join(" · "));
          const body = createElement("div", "feed-body");
          const facts = parseJsonArray(item.facts);
          const summary = (item.subtitle || item.body_text || "").trim();
          const narrative = (item.narrative || "").trim();
          const normalizedSummary = normalize(summary);
          const normalizedNarrative = normalize(narrative);
          const narrativeDistinct = Boolean(narrative) && normalizedNarrative !== normalizedSummary;
          const fallbackFacts = facts.length ? facts : extractFactsFromBody(summary || narrative);
          const hasFacts = fallbackFacts.length > 0;
          const hasSummary = Boolean(summary);
          const hasNarrative = narrativeDistinct;
          const availableViews = [];
          if (hasSummary) availableViews.push("summary");
          if (hasFacts) availableViews.push("facts");
          if (hasNarrative) availableViews.push("narrative");
          const defaultView = hasSummary ? "summary" : hasFacts ? "facts" : "narrative";

          function renderNarrative() {
            body.classList.remove("facts");
            body.textContent = "";
            if (typeof marked !== "undefined" && narrative) {
              try {
                body.innerHTML = marked.parse(narrative);
              } catch (e) {
                body.textContent = narrative;
              }
            } else {
              body.textContent = narrative || "No narrative available";
            }
          }

          function renderSummary() {
            body.classList.remove("facts");
            body.textContent = "";
            if (typeof marked !== "undefined" && summary) {
              try {
                body.innerHTML = marked.parse(summary);
              } catch (e) {
                body.textContent = summary;
              }
            } else {
              body.textContent = summary || "No summary available";
            }
          }

          function renderFacts() {
            body.classList.add("facts");
            body.textContent = "";
            if (!fallbackFacts.length) {
              body.textContent = "No facts captured";
              return;
            }
            const list = document.createElement("ul");
            fallbackFacts.forEach(fact => {
              const li = document.createElement("li");
              li.textContent = fact;
              list.appendChild(li);
            });
            body.appendChild(list);
          }

          const itemId = item.id || item.session_id || `${kindValue}-${title.textContent}`;
          const storedView = itemViewState.get(itemId);

          function setActive(view) {
            if (!availableViews.includes(view)) {
              view = defaultView;
            }
            summaryButton.classList.toggle("active", view === "summary");
            factsButton.classList.toggle("active", view === "facts");
            narrativeButton.classList.toggle("active", view === "narrative");
            if (view === "facts") {
              renderFacts();
            } else if (view === "narrative") {
              renderNarrative();
            } else {
              renderSummary();
            }
            itemViewState.set(itemId, view);
          }

          if (isSessionSummary) {
            toggle.style.display = "none";
            body.classList.remove("facts");
            body.textContent = "";
            const summarySections = [
              ["Investigated", metadata.investigated],
              ["Learned", metadata.learned],
              ["Completed", metadata.completed],
              ["Next steps", metadata.next_steps],
              ["Notes", metadata.notes],
            ];
            const fragment = document.createDocumentFragment();
            summarySections.forEach(([label, content]) => {
              if (!content) {
                return;
              }
              const section = createElement("div", "summary-section");
              const header = createElement("div", "summary-section-header");
              header.append(createElement("span", "summary-section-label", label));
              const bodyText = createElement("div", "summary-section-content");
              if (typeof marked !== "undefined") {
                try {
                  bodyText.innerHTML = marked.parse(content);
                } catch (e) {
                  bodyText.textContent = content;
                }
              } else {
                bodyText.textContent = content;
              }
              section.append(header, bodyText);
              fragment.appendChild(section);
            });
            if (!fragment.childNodes.length) {
              body.textContent = summary || "No summary available";
            } else {
              body.appendChild(fragment);
            }
          } else {
            toggle.textContent = "";
            if (hasSummary) toggle.appendChild(summaryButton);
            if (hasFacts) toggle.appendChild(factsButton);
            if (hasNarrative) toggle.appendChild(narrativeButton);
            if (!availableViews.length || availableViews.length === 1) {
              toggle.style.display = "none";
            }
            summaryButton.addEventListener("click", () => setActive("summary"));
            factsButton.addEventListener("click", () => setActive("facts"));
            narrativeButton.addEventListener("click", () => setActive("narrative"));
            setActive(storedView || defaultView);
          }

          const footer = createElement("div", "feed-footer");
          const footerLeft = createElement("div", "feed-footer-left");
          const tagRow = createElement("div", "feed-tags");
          const fileRow = createElement("div", "feed-files");
          const tags = (item.tags_text || "").split(/\\s+/).filter(Boolean);
          const concepts = parseJsonArray(metadata.concepts);
          const filesRead = parseJsonArray(metadata.files_read);
          const filesModified = parseJsonArray(metadata.files_modified);
          const combinedTags = [...tags, ...concepts];
          combinedTags.slice(0, 4).forEach(tag => {
            const chip = createTagChip(tag);
            if (chip) tagRow.appendChild(chip);
          });
          if (combinedTags.length > 4) {
            tagRow.appendChild(createElement("span", "tag-chip", `+${combinedTags.length - 4}`));
          }
          if (tagRow.childNodes.length) {
            footerLeft.appendChild(tagRow);
          }

          if (filesModified.length) {
            const summary = formatFileList(filesModified);
            if (summary) {
              fileRow.appendChild(createElement("span", "feed-file", `Modified: ${summary}`));
            }
          }
          if (filesRead.length) {
            const summary = formatFileList(filesRead);
            if (summary) {
              fileRow.appendChild(createElement("span", "feed-file", `Read: ${summary}`));
            }
          }
          if (fileRow.childNodes.length) {
            footerLeft.appendChild(fileRow);
          }

          footer.append(footerLeft, meta);

          feedItem.append(headerRow, body, footer);
          feedList.appendChild(feedItem);
        });
      }

      function renderSessionStats(recentPacks, isAllProjects) {
        sessionGrid.textContent = "";
        if (!recentPacks || !recentPacks.length) {
          sessionMeta.textContent = "No injections yet";
          return;
        }
        let items, workTokens, packTokens, savedTokens, semanticCandidates, semanticHits, timeAgo;
        let workSource = "estimate";
        let workUsageItems = 0;
        let workEstimateItems = 0;
        if (isAllProjects) {
          // Aggregate stats across latest pack per project
          items = recentPacks.reduce((sum, p) => sum + ((p.metadata_json || {}).items || 0), 0);
          workTokens = recentPacks.reduce((sum, p) => {
            const meta = (p.metadata_json || {});
            return sum + (meta.work_tokens_unique || meta.work_tokens || 0);
          }, 0);
          packTokens = recentPacks.reduce((sum, p) => sum + (p.tokens_read || 0), 0);
          savedTokens = recentPacks.reduce((sum, p) => sum + (p.tokens_saved || 0), 0);
          semanticCandidates = recentPacks.reduce((sum, p) => sum + ((p.metadata_json || {}).semantic_candidates || 0), 0);
          semanticHits = recentPacks.reduce((sum, p) => sum + ((p.metadata_json || {}).semantic_hits || 0), 0);
          workUsageItems = recentPacks.reduce((sum, p) => sum + ((p.metadata_json || {}).work_usage_items || 0), 0);
          workEstimateItems = recentPacks.reduce((sum, p) => sum + ((p.metadata_json || {}).work_estimate_items || 0), 0);
          if (workUsageItems && workEstimateItems) {
            workSource = "mixed";
          } else if (workUsageItems) {
            workSource = "usage";
          }
          timeAgo = recentPacks.length === 1 ? "1 project" : `${recentPacks.length} projects`;
        } else {
          const latest = recentPacks[0];
          const metadata = latest.metadata_json || {};
          items = metadata.items || 0;
          workTokens = metadata.work_tokens_unique || metadata.work_tokens || 0;
          packTokens = latest.tokens_read || 0;
          savedTokens = latest.tokens_saved || 0;
          semanticCandidates = metadata.semantic_candidates || 0;
          semanticHits = metadata.semantic_hits || 0;
          workSource = metadata.work_source || "estimate";
          workUsageItems = metadata.work_usage_items || 0;
          workEstimateItems = metadata.work_estimate_items || 0;
          timeAgo = latest.created_at ? formatDate(latest.created_at) : "recently";
        }
        const savingsPercent = workTokens > 0 ? Math.round((savedTokens / workTokens) * 100) : 0;
        const semanticRate = semanticCandidates > 0
          ? Math.round((semanticHits / semanticCandidates) * 100)
          : 0;
        sessionMeta.textContent = `Last injection: ${timeAgo}`;
        const workLabel = workSource === "usage"
          ? "Work saved (usage)"
          : workSource === "mixed"
            ? "Work saved (mixed)"
            : "Work saved (estimate)";
        let workTooltip = "Tokens you'd have spent rediscovering this context.";
        if (workSource === "usage") {
          workTooltip = `Tokens you'd have spent rediscovering this context (usage-based, ${workUsageItems} items).`;
        } else if (workSource === "mixed") {
          workTooltip = `Tokens you'd have spent rediscovering this context (${workUsageItems} usage, ${workEstimateItems} estimated).`;
        } else {
          workTooltip = "Tokens you'd have spent rediscovering this context (estimated from memory length).";
        }
        const stats = [
          { label: "Memories packed", value: items, icon: "layers" },
          { label: "Pack size", value: packTokens.toLocaleString(), tooltip: "Token cost to inject memories into context", icon: "file-text" },
          { label: workLabel, value: workTokens.toLocaleString(), tooltip: workTooltip, icon: "zap" },
          { label: "Savings", value: `${savedTokens.toLocaleString()} (${savingsPercent}%)`, tooltip: "Net savings from reusing compressed memories", icon: "arrow-down-circle" },
        ];
        if (semanticCandidates > 0) {
          stats.push(
            { label: "Semantic candidates", value: semanticCandidates.toLocaleString(), tooltip: "Vector search results considered for this pack", icon: "scan-search" },
            { label: "Semantic hits", value: `${semanticHits.toLocaleString()} (${semanticRate}%)`, tooltip: "Vector matches that made it into the final pack", icon: "sparkles" },
          );
        }
        stats.forEach(item => {
          const stat = createElement("div", "stat");
          if (item.tooltip) {
            stat.title = item.tooltip;
            stat.style.cursor = "help";
          }
          const icon = document.createElement("i");
          icon.setAttribute("data-lucide", item.icon);
          icon.className = "stat-icon";
          const content = createElement("div", "stat-content");
          const value = createElement("div", "value", item.value);
          const label = createElement("div", "label", item.label);
          content.append(value, label);
          stat.append(icon, content);
          sessionGrid.appendChild(stat);
        });
        if (typeof lucide !== "undefined") lucide.createIcons();
      }

      function renderRawEventsStatus(items) {
        if (!rawEventsGrid || !rawEventsMeta || !rawEventsList) {
          return;
        }
        rawEventsGrid.textContent = "";
        rawEventsList.textContent = "";
        const list = Array.isArray(items) ? items : [];
        const sessions = list.length;
        const pendingTotal = list.reduce((sum, item) => sum + (Number(item.pending) || 0), 0);
        rawEventsMeta.textContent = sessions
          ? `Pending: ${sessions} sessions, ${pendingTotal} events`
          : "No pending raw events";

        const stats = [
          { label: "Pending sessions", value: sessions, icon: "inbox" },
          { label: "Pending events", value: pendingTotal.toLocaleString(), icon: "activity" },
        ];
        stats.forEach(item => {
          const stat = createElement("div", "stat");
          const icon = document.createElement("i");
          icon.setAttribute("data-lucide", item.icon);
          icon.className = "stat-icon";
          const content = createElement("div", "stat-content");
          const value = createElement("div", "value", String(item.value));
          const label = createElement("div", "label", item.label);
          content.append(value, label);
          stat.append(icon, content);
          rawEventsGrid.appendChild(stat);
        });

        list.slice(0, 10).forEach(item => {
          const line = createElement("div", "diag-line");
          const left = createElement("div", "left");
          const right = createElement("div", "right mono");
          const sid = String(item.opencode_session_id || "");
          const shortId = sid.length > 10 ? `…${sid.slice(-10)}` : sid;
          const project = String(item.project || "");
          left.appendChild(createElement("div", "mono", `${shortId} · pending ${item.pending}`));
          if (project) {
            left.appendChild(createElement("div", "small", project));
          }
          const lastSeen = item.last_seen_ts_wall_ms
            ? new Date(Number(item.last_seen_ts_wall_ms)).toLocaleString()
            : "";
          right.textContent = lastSeen;
          line.append(left, right);
          rawEventsList.appendChild(line);
        });
        if (typeof lucide !== "undefined") lucide.createIcons();
      }

      function setSettingsOpen(isOpen) {
        settingsBackdrop.hidden = !isOpen;
        settingsModal.hidden = !isOpen;
      }

      function renderProviderOptions(providers) {
        if (!observerProviderInput) {
          return;
        }
        const options = ["", ...(providers || [])];
        observerProviderInput.innerHTML = "";
        options.forEach(provider => {
          const option = document.createElement("option");
          option.value = provider;
          option.textContent = provider || "auto (default)";
          observerProviderInput.appendChild(option);
        });
      }

      async function loadSettings() {
        settingsStatus.textContent = "Loading…";
        try {
          const response = await fetch("/api/config");
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || "Failed to load config");
          }
          configDefaults = data.defaults || {};
          configPath = data.path || "";
          const config = data.config || {};
          const effective = data.effective || {};
          const overrides = data.env_overrides || {};
          renderProviderOptions(data.providers || []);
          observerProviderInput.value = config.observer_provider ?? "";
          observerModelInput.value = config.observer_model ?? "";
          const defaultMax = configDefaults.observer_max_chars ?? 12000;
          const defaultPackObservationLimit = configDefaults.pack_observation_limit ?? 50;
          const defaultPackSessionLimit = configDefaults.pack_session_limit ?? 10;
          const defaultSyncHost = configDefaults.sync_host ?? "127.0.0.1";
          const defaultSyncPort = configDefaults.sync_port ?? 7337;
          const defaultSyncInterval = configDefaults.sync_interval_s ?? 120;
          const defaultSyncMdns = configDefaults.sync_mdns ?? true;
          observerMaxCharsInput.value = config.observer_max_chars ?? defaultMax;
          packObservationLimitInput.value = config.pack_observation_limit ?? defaultPackObservationLimit;
          packSessionLimitInput.value = config.pack_session_limit ?? defaultPackSessionLimit;
          if (syncEnabledInput) {
            syncEnabledInput.checked = config.sync_enabled ?? false;
          }
          if (syncHostInput) {
            syncHostInput.value = config.sync_host ?? defaultSyncHost;
          }
          if (syncPortInput) {
            syncPortInput.value = config.sync_port ?? defaultSyncPort;
          }
          if (syncIntervalInput) {
            syncIntervalInput.value = config.sync_interval_s ?? defaultSyncInterval;
          }
          if (syncMdnsInput) {
            syncMdnsInput.checked = config.sync_mdns ?? defaultSyncMdns;
          }
          observerMaxCharsHint.textContent = `Default: ${defaultMax.toLocaleString()} characters.`;
          settingsPath.textContent = configPath ? `config: ${configPath}` : "config path unavailable";
          const effectiveProvider = effective.observer_provider || "auto";
          const effectiveModel = effective.observer_model || "default";
          const effectiveMax = effective.observer_max_chars || defaultMax;
          settingsEffective.textContent = `effective: ${effectiveProvider} · ${effectiveModel} · ${Number(effectiveMax).toLocaleString()} chars`;
          const overrideKeys = Object.keys(overrides);
          settingsOverrides.textContent = overrideKeys.length
            ? `Env overrides active: ${overrideKeys.join(", ")}`
            : "Environment variables override file settings.";
          settingsStatus.textContent = "Ready";
        } catch (err) {
          settingsStatus.textContent = err?.message || "Failed to load config";
          settingsEffective.textContent = "";
          settingsOverrides.textContent = "Environment variables override file settings.";
        }
      }

      async function saveSettings() {
        settingsSave.disabled = true;
        const provider = observerProviderInput.value.trim();
        const model = observerModelInput.value.trim();
        const maxValue = observerMaxCharsInput.value.trim();
        const packObservationValue = packObservationLimitInput.value.trim();
        const packSessionValue = packSessionLimitInput.value.trim();
        const syncHostValue = syncHostInput?.value.trim() || "";
        const syncPortValue = syncPortInput?.value.trim() || "";
        const syncIntervalValue = syncIntervalInput?.value.trim() || "";
        let maxChars = null;
        if (maxValue) {
          maxChars = Number(maxValue);
          if (!Number.isInteger(maxChars) || maxChars <= 0) {
            settingsStatus.textContent = "Observer max chars must be a positive integer";
            settingsSave.disabled = false;
            return;
          }
        }
        let packObservationLimit = null;
        if (packObservationValue) {
          packObservationLimit = Number(packObservationValue);
          if (!Number.isInteger(packObservationLimit) || packObservationLimit <= 0) {
            settingsStatus.textContent = "Pack observation limit must be a positive integer";
            settingsSave.disabled = false;
            return;
          }
        }
        let packSessionLimit = null;
        if (packSessionValue) {
          packSessionLimit = Number(packSessionValue);
          if (!Number.isInteger(packSessionLimit) || packSessionLimit <= 0) {
            settingsStatus.textContent = "Pack session limit must be a positive integer";
            settingsSave.disabled = false;
            return;
          }
        }
        let syncPort = null;
        if (syncPortValue) {
          syncPort = Number(syncPortValue);
          if (!Number.isInteger(syncPort) || syncPort <= 0) {
            settingsStatus.textContent = "Sync port must be a positive integer";
            settingsSave.disabled = false;
            return;
          }
        }
        let syncInterval = null;
        if (syncIntervalValue) {
          syncInterval = Number(syncIntervalValue);
          if (!Number.isInteger(syncInterval) || syncInterval <= 0) {
            settingsStatus.textContent = "Sync interval must be a positive integer";
            settingsSave.disabled = false;
            return;
          }
        }
        const payload = {
          config: {
            observer_provider: provider || null,
            observer_model: model || null,
            observer_max_chars: maxChars,
            pack_observation_limit: packObservationLimit,
            pack_session_limit: packSessionLimit,
            sync_enabled: syncEnabledInput ? syncEnabledInput.checked : null,
            sync_host: syncHostValue || null,
            sync_port: syncPort,
            sync_interval_s: syncInterval,
            sync_mdns: syncMdnsInput ? syncMdnsInput.checked : null,
          },
        };
        settingsStatus.textContent = "Saving…";
        try {
          const response = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await response.json();
          if (!response.ok) {
            settingsStatus.textContent = data.error ? `Error: ${data.error}` : "Save failed";
            return;
          }
          await loadSettings();
          settingsStatus.textContent = "Saved";
          setSettingsOpen(false);
        } catch (err) {
          settingsStatus.textContent = "Save failed";
        } finally {
          settingsSave.disabled = false;
        }
      }

      settingsButton?.addEventListener("click", async () => {
        setSettingsOpen(true);
        await loadSettings();
        observerProviderInput?.focus();
      });
      settingsClose?.addEventListener("click", () => setSettingsOpen(false));
      settingsBackdrop?.addEventListener("click", () => setSettingsOpen(false));
      settingsModal?.addEventListener("click", event => {
        if (event.target === settingsModal) {
          setSettingsOpen(false);
        }
      });
      settingsSave?.addEventListener("click", saveSettings);
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !settingsModal.hidden) {
          setSettingsOpen(false);
        }
      });

      async function loadProjects() {
        try {
          const response = await fetch("/api/projects");
          const data = await response.json();
          const projects = data.projects || [];
          projectFilter.innerHTML = '<option value="">All Projects</option>';
          projects.forEach(project => {
            const option = document.createElement("option");
            option.value = project;
            option.textContent = project;
            option.title = project;
            if (project === currentProject) {
              option.selected = true;
            }
            projectFilter.appendChild(option);
          });
        } catch (err) {
          console.error("Failed to load projects:", err);
        }
      }

      projectFilter?.addEventListener("change", () => {
        currentProject = projectFilter.value;
        refresh();
      });

      syncNowButton?.addEventListener("click", () => syncPeerNow());
      pairingCopy?.addEventListener("click", async () => {
        const command = pairingPayload?.textContent || "";
        if (!command) return;
        try {
          await navigator.clipboard.writeText(command);
          if (pairingHint) pairingHint.textContent = "Copied pairing command.";
        } catch (err) {
          if (pairingHint) pairingHint.textContent = "Copy failed.";
        }
      });

      async function refresh() {
        refreshStatus.innerHTML = "<span class='dot'></span>refreshing…";
        try {
          const projectParam = currentProject ? `&project=${encodeURIComponent(currentProject)}` : "";
          const usageProjectParam = currentProject ? `?project=${encodeURIComponent(currentProject)}` : "";
          const [stats, summaries, observations, usage, syncStatus, syncPeersData, syncAttemptsData] = await Promise.all([
            fetch("/api/stats").then(r => r.json()),
            fetch(`/api/memory?kind=session_summary&limit=20${projectParam}`).then(r => r.json()),
            fetch(`/api/observations?limit=40${projectParam}`).then(r => r.json()),
            fetch(`/api/usage${usageProjectParam}`).then(r => r.json()),
            fetch("/api/sync/status").then(r => r.json()),
            fetch("/api/sync/peers").then(r => r.json()),
            fetch("/api/sync/attempts?limit=8").then(r => r.json()),
          ]);
          renderStats(stats);
          renderSessionStats(usage.recent_packs || [], !currentProject);
          renderSyncStatus(syncStatus);
          renderSyncPeers(syncPeersData.items || []);
          renderSyncAttempts(syncAttemptsData.items || []);
          loadPairing();

          if (isDiagnosticsOpen()) {
            try {
              const raw = await fetch("/api/raw-events/status?limit=25").then(r => r.json());
              renderRawEventsStatus(raw.items || []);
            } catch (err) {
              if (rawEventsMeta) {
                rawEventsMeta.textContent = "Failed to load raw event status";
              }
            }
          }
          const summaryItems = summaries.items || [];
          const observationItems = observations.items || [];
          const filteredObservations = observationItems.filter(item => !isLowSignalObservation(item));
          const filteredCount = observationItems.length - filteredObservations.length;
          const feedItems = [...summaryItems, ...filteredObservations].sort((a, b) => {
            const left = new Date(a.created_at || 0).getTime();
            const right = new Date(b.created_at || 0).getTime();
            return right - left;
          });
          const visibleItems = filterFeedItems(feedItems);
          const filterLabel = formatFeedFilterLabel();
          feedMeta.textContent = `${visibleItems.length} items${filterLabel}${filteredCount ? " · " + filteredCount + " observations filtered" : ""}`;
          renderFeed(visibleItems);
          refreshStatus.innerHTML = "<span class='dot'></span>updated " + new Date().toLocaleTimeString();
        } catch (err) {
          refreshStatus.innerHTML = "<span class='dot'></span>refresh failed";
        }
      }

      loadProjects();
      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>
"""


class ViewerHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self) -> None:
        body = VIEWER_HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any] | None:
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    def _reject_cross_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return False
        allowed = (
            origin.startswith("http://127.0.0.1")
            or origin.startswith("http://localhost")
            or origin.startswith("http://[::1]")
        )
        if allowed:
            return False
        self._send_json({"error": "forbidden"}, status=403)
        return True

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        if os.environ.get("OPENCODE_MEM_VIEWER_LOGS") == "1":
            super().log_message(format, *args)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html()
            return

        is_api = parsed.path.startswith("/api/")
        store: MemoryStore | None = None
        try:
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            if parsed.path == "/api/stats":
                self._send_json(store.stats())
                return
            if parsed.path == "/api/usage":
                params = parse_qs(parsed.query)
                project_filter = params.get("project", [None])[0]
                if project_filter:
                    # For specific project: get recent packs for that project
                    recent_packs = store.recent_pack_events(limit=10, project=project_filter)
                else:
                    # For all projects: get latest pack per project (for aggregation)
                    recent_packs = store.latest_pack_per_project()
                self._send_json(
                    {
                        "events": store.usage_summary(),
                        "totals": store.stats()["usage"]["totals"],
                        "recent_packs": recent_packs,
                    }
                )
                return
            if parsed.path == "/api/raw-events/status":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["25"])[0])
                self._send_json({"items": store.raw_event_backlog(limit=limit)})
                return
            if parsed.path == "/api/sessions":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["20"])[0])
                sessions = store.all_sessions()[:limit]
                for item in sessions:
                    item["metadata_json"] = from_json(item.get("metadata_json"))
                self._send_json({"items": sessions})
                return
            if parsed.path == "/api/projects":
                sessions = store.all_sessions()
                projects = sorted(
                    {
                        p.strip()
                        for s in sessions
                        if (p := s.get("project"))
                        and isinstance(p, str)
                        and p.strip()
                        and not p.strip().lower().startswith("fatal:")
                    }
                )
                self._send_json({"projects": projects})
                return
            if parsed.path == "/api/observations":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["20"])[0])
                project = params.get("project", [None])[0]
                kinds = [
                    "bugfix",
                    "change",
                    "decision",
                    "discovery",
                    "exploration",
                    "feature",
                    "refactor",
                ]
                filters = {"project": project} if project else None
                items = store.recent_by_kinds(limit=limit, kinds=kinds, filters=filters)
                self._send_json({"items": items})
                return
            if parsed.path == "/api/pack":
                params = parse_qs(parsed.query)
                context = params.get("context", [""])[0]
                if not context:
                    self._send_json({"error": "context required"}, status=400)
                    return
                config = load_config()
                try:
                    limit = int(params.get("limit", [str(config.pack_observation_limit)])[0])
                except ValueError:
                    self._send_json({"error": "limit must be int"}, status=400)
                    return
                token_budget = params.get("token_budget", [None])[0]
                if token_budget in (None, ""):
                    token_budget_value = None
                else:
                    try:
                        token_budget_value = int(token_budget)
                    except ValueError:
                        self._send_json({"error": "token_budget must be int"}, status=400)
                        return
                project = params.get("project", [None])[0]
                filters = {"project": project} if project else None
                pack = store.build_memory_pack(
                    context=context,
                    limit=limit,
                    token_budget=token_budget_value,
                    filters=filters,
                )
                self._send_json(pack)
                return
            if parsed.path == "/api/memory":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["20"])[0])
                kind = params.get("kind", [None])[0]
                project = params.get("project", [None])[0]
                filters = {}
                if kind:
                    filters["kind"] = kind
                if project:
                    filters["project"] = project
                items = store.recent(limit=limit, filters=filters if filters else None)
                self._send_json({"items": items})
                return
            if parsed.path == "/api/artifacts":
                params = parse_qs(parsed.query)
                session_id = params.get("session_id", [None])[0]
                if not session_id:
                    self._send_json({"error": "session_id required"}, status=400)
                    return
                items = store.session_artifacts(int(session_id))
                self._send_json({"items": items})
                return
            if parsed.path == "/api/config":
                config_path = get_config_path()
                try:
                    config_data = read_config_file(config_path)
                except ValueError as exc:
                    self._send_json({"error": str(exc), "path": str(config_path)}, status=500)
                    return
                effective = asdict(load_config(config_path))
                self._send_json(
                    {
                        "path": str(config_path),
                        "config": config_data,
                        "defaults": asdict(OpencodeMemConfig()),
                        "effective": effective,
                        "env_overrides": get_env_overrides(),
                        "providers": _load_provider_options(),
                    }
                )
                return
            if parsed.path == "/api/sync/status":
                config = load_config()
                device_row = store.conn.execute(
                    "SELECT device_id, fingerprint FROM sync_device LIMIT 1"
                ).fetchone()
                peer_count = store.conn.execute(
                    "SELECT COUNT(1) AS total FROM sync_peers"
                ).fetchone()
                last_attempt = store.conn.execute(
                    """
                    SELECT peer_device_id, ok, error, finished_at
                    FROM sync_attempts
                    ORDER BY finished_at DESC
                    LIMIT 1
                    """
                ).fetchone()
                last_sync = store.conn.execute(
                    "SELECT MAX(last_sync_at) AS last_sync_at FROM sync_peers"
                ).fetchone()
                self._send_json(
                    {
                        "enabled": config.sync_enabled,
                        "device_id": device_row["device_id"] if device_row else None,
                        "fingerprint": device_row["fingerprint"] if device_row else None,
                        "bind": f"{config.sync_host}:{config.sync_port}",
                        "interval_s": config.sync_interval_s,
                        "peer_count": int(peer_count["total"]) if peer_count else 0,
                        "last_sync_at": last_sync["last_sync_at"] if last_sync else None,
                        "last_attempt": dict(last_attempt) if last_attempt else None,
                    }
                )
                return
            if parsed.path == "/api/sync/peers":
                rows = store.conn.execute(
                    """
                    SELECT peer_device_id, name, pinned_fingerprint, addresses_json,
                           last_seen_at, last_sync_at, last_error
                    FROM sync_peers
                    ORDER BY name, peer_device_id
                    """
                ).fetchall()
                peers = []
                for row in rows:
                    addresses = load_peer_addresses(store.conn, row["peer_device_id"])
                    peers.append(
                        {
                            "peer_device_id": row["peer_device_id"],
                            "name": row["name"],
                            "fingerprint": row["pinned_fingerprint"],
                            "addresses": addresses,
                            "last_seen_at": row["last_seen_at"],
                            "last_sync_at": row["last_sync_at"],
                            "last_error": row["last_error"],
                        }
                    )
                self._send_json({"items": peers})
                return
            if parsed.path == "/api/sync/attempts":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["25"])[0])
                rows = store.conn.execute(
                    """
                    SELECT peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out
                    FROM sync_attempts
                    ORDER BY finished_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                self._send_json({"items": [dict(row) for row in rows]})
                return
            if parsed.path == "/api/sync/pairing":
                config = load_config()
                keys_dir_value = os.environ.get("OPENCODE_MEM_KEYS_DIR")
                keys_dir = Path(keys_dir_value).expanduser() if keys_dir_value else None
                device_row = store.conn.execute(
                    "SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 1"
                ).fetchone()
                if device_row:
                    device_id = device_row["device_id"]
                    public_key = device_row["public_key"]
                    fingerprint = device_row["fingerprint"]
                else:
                    device_id, fingerprint = ensure_device_identity(store.conn, keys_dir=keys_dir)
                    public_key = load_public_key(keys_dir)
                if not public_key or not device_id or not fingerprint:
                    self._send_json({"error": "public key missing"}, status=500)
                    return
                payload = {
                    "device_id": device_id,
                    "fingerprint": fingerprint,
                    "public_key": public_key,
                    "addresses": [
                        f"{host}:{config.sync_port}"
                        for host in pick_advertise_hosts(config.sync_advertise)
                        if host and host != "0.0.0.0"
                    ]
                    or [
                        f"{pick_advertise_host(config.sync_advertise) or config.sync_host}:{config.sync_port}"
                    ],
                }
                payload["address"] = payload["addresses"][0]
                self._send_json(payload)
                return
            self.send_response(404)
            self.end_headers()
        except Exception as exc:  # pragma: no cover
            if is_api:
                payload: dict[str, Any] = {"error": "internal server error"}
                if os.environ.get("OPENCODE_MEM_VIEWER_DEBUG") == "1":
                    payload["detail"] = str(exc)
                self._send_json(payload, status=500)
                return
            self.send_response(500)
            self.end_headers()
        finally:
            if store is not None:
                store.close()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._reject_cross_origin():
            return
        if parsed.path == "/api/sync/peers/rename":
            payload = self._read_json()
            if payload is None:
                self._send_json({"error": "invalid json"}, status=400)
                return
            peer_device_id = payload.get("peer_device_id")
            name = payload.get("name")
            if not isinstance(peer_device_id, str) or not peer_device_id:
                self._send_json({"error": "peer_device_id required"}, status=400)
                return
            if not isinstance(name, str) or not name.strip():
                self._send_json({"error": "name required"}, status=400)
                return
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            try:
                row = store.conn.execute(
                    "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
                    (peer_device_id,),
                ).fetchone()
                if row is None:
                    self._send_json({"error": "peer not found"}, status=404)
                    return
                store.conn.execute(
                    "UPDATE sync_peers SET name = ? WHERE peer_device_id = ?",
                    (name.strip(), peer_device_id),
                )
                store.conn.commit()
                self._send_json({"ok": True})
                return
            finally:
                store.close()
        if parsed.path == "/api/sync/actions/sync-now":
            payload = self._read_json() or {}
            peer_device_id = payload.get("peer_device_id")
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            try:
                config = load_config()
                if not config.sync_enabled:
                    self._send_json({"error": "sync_disabled"}, status=403)
                    return
                rows = []
                if isinstance(peer_device_id, str) and peer_device_id:
                    rows = store.conn.execute(
                        "SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?",
                        (peer_device_id,),
                    ).fetchall()
                else:
                    rows = store.conn.execute("SELECT peer_device_id FROM sync_peers").fetchall()
                results = []
                for row in rows:
                    peer_id = row["peer_device_id"]
                    addresses = load_peer_addresses(store.conn, peer_id)
                    results.append(sync_once(store, peer_id, addresses))
                self._send_json({"items": results})
                return
            finally:
                store.close()
        if parsed.path == "/api/raw-events":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, status=400)
                return
            if not isinstance(payload, dict):
                self._send_json({"error": "payload must be an object"}, status=400)
                return

            try:
                store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            except Exception as exc:  # pragma: no cover
                response: dict[str, Any] = {"error": "internal server error"}
                if os.environ.get("OPENCODE_MEM_VIEWER_DEBUG") == "1":
                    response["detail"] = str(exc)
                self._send_json(response, status=500)
                return
            try:
                cwd = payload.get("cwd")
                if cwd is not None and not isinstance(cwd, str):
                    self._send_json({"error": "cwd must be string"}, status=400)
                    return
                project = payload.get("project")
                if project is not None and not isinstance(project, str):
                    self._send_json({"error": "project must be string"}, status=400)
                    return
                started_at = payload.get("started_at")
                if started_at is not None and not isinstance(started_at, str):
                    self._send_json({"error": "started_at must be string"}, status=400)
                    return

                items = payload.get("events")
                if items is None:
                    items = [payload]
                if not isinstance(items, list):
                    self._send_json({"error": "events must be a list"}, status=400)
                    return

                default_session_id = str(payload.get("opencode_session_id") or "")
                if default_session_id.startswith("msg_"):
                    self._send_json({"error": "invalid opencode_session_id"}, status=400)
                    return

                inserted = 0
                last_seen_by_session: dict[str, int] = {}
                meta_by_session: dict[str, dict[str, str]] = {}
                session_ids: set[str] = set()
                batch: list[dict[str, Any]] = []
                batch_by_session: dict[str, list[dict[str, Any]]] = {}
                for item in items:
                    if not isinstance(item, dict):
                        self._send_json({"error": "event must be an object"}, status=400)
                        return
                    opencode_session_id = str(
                        item.get("opencode_session_id") or default_session_id or ""
                    )
                    if not opencode_session_id:
                        self._send_json({"error": "opencode_session_id required"}, status=400)
                        return
                    if opencode_session_id.startswith("msg_"):
                        self._send_json({"error": "invalid opencode_session_id"}, status=400)
                        return
                    event_id = str(item.get("event_id") or "")
                    event_type = str(item.get("event_type") or "")
                    if not event_type:
                        self._send_json({"error": "event_type required"}, status=400)
                        return
                    event_seq_value = item.get("event_seq")
                    if event_seq_value is not None:
                        try:
                            int(str(event_seq_value))
                        except (TypeError, ValueError):
                            self._send_json({"error": "event_seq must be int"}, status=400)
                            return

                    ts_wall_ms = item.get("ts_wall_ms")
                    if ts_wall_ms is not None:
                        try:
                            ts_wall_ms = int(ts_wall_ms)
                        except (TypeError, ValueError):
                            self._send_json({"error": "ts_wall_ms must be int"}, status=400)
                            return
                        last_seen_by_session[opencode_session_id] = max(
                            last_seen_by_session.get(opencode_session_id, ts_wall_ms),
                            ts_wall_ms,
                        )
                    ts_mono_ms = item.get("ts_mono_ms")
                    if ts_mono_ms is not None:
                        try:
                            ts_mono_ms = float(ts_mono_ms)
                        except (TypeError, ValueError):
                            self._send_json({"error": "ts_mono_ms must be number"}, status=400)
                            return
                    event_payload = item.get("payload")
                    if event_payload is None:
                        event_payload = {}
                    if not isinstance(event_payload, dict):
                        self._send_json({"error": "payload must be an object"}, status=400)
                        return

                    item_cwd = item.get("cwd")
                    if item_cwd is not None and not isinstance(item_cwd, str):
                        self._send_json({"error": "cwd must be string"}, status=400)
                        return
                    item_project = item.get("project")
                    if item_project is not None and not isinstance(item_project, str):
                        self._send_json({"error": "project must be string"}, status=400)
                        return
                    item_started_at = item.get("started_at")
                    if item_started_at is not None and not isinstance(item_started_at, str):
                        self._send_json({"error": "started_at must be string"}, status=400)
                        return

                    event_payload = _strip_private_obj(event_payload)

                    if not event_id:
                        # Backwards-compat: derive a stable id for legacy senders.
                        if event_seq_value is not None:
                            raw_id = json.dumps(
                                {"s": event_seq_value, "t": event_type, "p": event_payload},
                                sort_keys=True,
                                ensure_ascii=False,
                            )
                            event_hash = hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:16]
                            event_id = f"legacy-seq-{event_seq_value}-{event_hash}"
                        else:
                            raw_id = json.dumps(
                                {
                                    "t": event_type,
                                    "p": event_payload,
                                    "w": ts_wall_ms,
                                    "m": ts_mono_ms,
                                },
                                sort_keys=True,
                                ensure_ascii=False,
                            )
                            event_id = (
                                "legacy-" + hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:16]
                            )
                    event_entry = {
                        "event_id": event_id,
                        "event_type": event_type,
                        "payload": event_payload,
                        "ts_wall_ms": ts_wall_ms,
                        "ts_mono_ms": ts_mono_ms,
                    }
                    batch.append(event_entry)

                    session_ids.add(opencode_session_id)
                    batch_by_session.setdefault(opencode_session_id, []).append(dict(event_entry))

                    if item_cwd or item_project or item_started_at:
                        per_session = meta_by_session.setdefault(opencode_session_id, {})
                        if item_cwd:
                            per_session["cwd"] = item_cwd
                        if item_project:
                            per_session["project"] = item_project
                        if item_started_at:
                            per_session["started_at"] = item_started_at

                if len(session_ids) == 1:
                    single_session_id = next(iter(session_ids))
                    result = store.record_raw_events_batch(
                        opencode_session_id=single_session_id,
                        events=batch,
                    )
                    inserted = int(result["inserted"])
                else:
                    # Fallback: handle multiple sessions individually.
                    for sid, sid_events in batch_by_session.items():
                        result = store.record_raw_events_batch(
                            opencode_session_id=sid,
                            events=sid_events,
                        )
                        inserted += int(result["inserted"])

                for meta_session_id in session_ids:
                    session_meta = meta_by_session.get(meta_session_id, {})
                    apply_request_meta = (
                        len(session_ids) == 1 or meta_session_id == default_session_id
                    )
                    store.update_raw_event_session_meta(
                        opencode_session_id=meta_session_id,
                        cwd=session_meta.get("cwd") or (cwd if apply_request_meta else None),
                        project=session_meta.get("project")
                        or (project if apply_request_meta else None),
                        started_at=session_meta.get("started_at")
                        or (started_at if apply_request_meta else None),
                        last_seen_ts_wall_ms=last_seen_by_session.get(meta_session_id),
                    )
                    RAW_EVENT_FLUSHER.note_activity(meta_session_id)
                self._send_json({"inserted": inserted, "received": len(items)})
                return
            except Exception as exc:  # pragma: no cover
                response: dict[str, Any] = {"error": "internal server error"}
                if os.environ.get("OPENCODE_MEM_VIEWER_DEBUG") == "1":
                    response["detail"] = str(exc)
                self._send_json(response, status=500)
            finally:
                store.close()

        if parsed.path != "/api/config":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, status=400)
            return
        if not isinstance(payload, dict):
            self._send_json({"error": "payload must be an object"}, status=400)
            return
        updates = payload.get("config") if "config" in payload else payload
        if not isinstance(updates, dict):
            self._send_json({"error": "config must be an object"}, status=400)
            return
        allowed_keys = {
            "observer_provider",
            "observer_model",
            "observer_max_chars",
            "pack_observation_limit",
            "pack_session_limit",
            "sync_enabled",
            "sync_host",
            "sync_port",
            "sync_interval_s",
            "sync_mdns",
        }
        allowed_providers = set(_load_provider_options())
        config_path = get_config_path()
        try:
            config_data = read_config_file(config_path)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=500)
            return
        for key in allowed_keys:
            if key not in updates:
                continue
            value = updates[key]
            if value in (None, ""):
                config_data.pop(key, None)
                continue
            if key == "observer_provider":
                if not isinstance(value, str):
                    self._send_json({"error": "observer_provider must be string"}, status=400)
                    return
                provider = value.strip().lower()
                if provider not in allowed_providers:
                    self._send_json(
                        {"error": "observer_provider must match a configured provider"},
                        status=400,
                    )
                    return
                config_data[key] = provider
                continue
            if key == "observer_model":
                if not isinstance(value, str):
                    self._send_json({"error": "observer_model must be string"}, status=400)
                    return
                model_value = value.strip()
                if not model_value:
                    config_data.pop(key, None)
                    continue
                config_data[key] = model_value
                continue
            if key == "observer_max_chars":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    self._send_json({"error": "observer_max_chars must be int"}, status=400)
                    return
                if value <= 0:
                    self._send_json({"error": "observer_max_chars must be positive"}, status=400)
                    return
                config_data[key] = value
                continue
            if key in {"pack_observation_limit", "pack_session_limit"}:
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    self._send_json({"error": f"{key} must be int"}, status=400)
                    return
                if value <= 0:
                    self._send_json({"error": f"{key} must be positive"}, status=400)
                    return
                config_data[key] = value
                continue
            if key in {"sync_enabled", "sync_mdns"}:
                if not isinstance(value, bool):
                    self._send_json({"error": f"{key} must be boolean"}, status=400)
                    return
                config_data[key] = value
                continue
            if key == "sync_host":
                if not isinstance(value, str):
                    self._send_json({"error": "sync_host must be string"}, status=400)
                    return
                host_value = value.strip()
                if not host_value:
                    config_data.pop(key, None)
                    continue
                config_data[key] = host_value
                continue
            if key in {"sync_port", "sync_interval_s"}:
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    self._send_json({"error": f"{key} must be int"}, status=400)
                    return
                if value <= 0:
                    self._send_json({"error": f"{key} must be positive"}, status=400)
                    return
                config_data[key] = value
                continue
        try:
            write_config_file(config_data, config_path)
        except OSError:
            self._send_json({"error": "failed to write config"}, status=500)
            return
        self._send_json({"path": str(config_path), "config": config_data})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._reject_cross_origin():
            return
        if not parsed.path.startswith("/api/sync/peers/"):
            self.send_response(404)
            self.end_headers()
            return
        peer_device_id = parsed.path.split("/api/sync/peers/", 1)[1].strip()
        if not peer_device_id:
            self._send_json({"error": "peer_device_id required"}, status=400)
            return
        store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
        try:
            row = store.conn.execute(
                "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
                (peer_device_id,),
            ).fetchone()
            if row is None:
                self._send_json({"error": "peer not found"}, status=404)
                return
            store.conn.execute(
                "DELETE FROM sync_peers WHERE peer_device_id = ?",
                (peer_device_id,),
            )
            store.conn.commit()
            self._send_json({"ok": True})
        finally:
            store.close()


def _serve(host: str, port: int) -> None:
    RAW_EVENT_SWEEPER.start()
    server = HTTPServer((host, port), ViewerHandler)
    server.serve_forever()


def start_viewer(
    host: str = DEFAULT_VIEWER_HOST,
    port: int = DEFAULT_VIEWER_PORT,
    background: bool = False,
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        try:
            if sock.connect_ex((host, port)) == 0:
                return
        except OSError:
            pass
    if background:
        thread = threading.Thread(target=_serve, args=(host, port), daemon=True)
        thread.start()
    else:
        _serve(host, port)
