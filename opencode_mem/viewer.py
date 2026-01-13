from __future__ import annotations

import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from .db import DEFAULT_DB_PATH, from_json
from .store import MemoryStore

DEFAULT_VIEWER_HOST = "127.0.0.1"
DEFAULT_VIEWER_PORT = 37777

VIEWER_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>opencode-mem viewer</title>
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
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", "Avenir Next", "Avenir", "Futura", "Gill Sans", "Optima", "Trebuchet MS", sans-serif;
        background:
          radial-gradient(circle at 12% 12%, rgba(31, 111, 92, 0.16), transparent 45%),
          radial-gradient(circle at 82% 18%, rgba(230, 126, 77, 0.2), transparent 42%),
          radial-gradient(circle at 70% 85%, rgba(34, 58, 94, 0.12), transparent 40%),
          linear-gradient(180deg, #fff6ea 0%, #f3eadc 65%, #efe3d2 100%);
        color: var(--ink);
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background-image: radial-gradient(rgba(0, 0, 0, 0.03) 1px, transparent 0);
        background-size: 18px 18px;
        opacity: 0.35;
        pointer-events: none;
        z-index: 0;
      }
      body::after {
        content: "";
        position: fixed;
        inset: 0;
        background: conic-gradient(from 120deg at 50% 20%, rgba(31, 111, 92, 0.08), transparent 40%, rgba(230, 126, 77, 0.08));
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
        background: rgba(255, 250, 243, 0.86);
        backdrop-filter: blur(6px);
      }
      .header-grid {
        display: grid;
        grid-template-columns: minmax(240px, 1.3fr) minmax(200px, 1fr);
        gap: 12px;
        align-items: center;
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
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 20px;
      }
      section {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 18px;
        box-shadow: var(--shadow);
        min-height: 180px;
        transform: translateY(10px);
        opacity: 0;
        animation: liftIn 0.7s ease forwards;
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
        letter-spacing: 0.3px;
      }
      .pill.alt {
        background: rgba(230, 126, 77, 0.15);
        color: #8d451f;
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
        background: rgba(255, 255, 255, 0.6);
        transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
        font-size: 14px;
      }
      li:last-child { margin-bottom: 0; }
      li:hover {
        transform: translateY(-1px);
        border-color: rgba(31, 111, 92, 0.2);
        background: rgba(255, 255, 255, 0.85);
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
        background: #fffdf7;
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
        color: #24324b;
        font-size: 12px;
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
      .section-meta .badge {
        background: rgba(31, 111, 92, 0.12);
        color: var(--accent);
      }
      .title {
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .truncate {
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
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
            <span class="pill">read-only</span>
            <span class="pill alt">auto-refresh</span>
            <span class="refresh" id="refreshStatus"><span class="dot"></span>refreshing…</span>
          </div>
        </div>
        <div class="header-right">
          <div class="meta" id="metaLine">Loading stats…</div>
          <div class="meta">signal: <strong>memory</strong> · window: <strong>recent</strong></div>
        </div>
      </div>
    </header>
    <main>
      <section>
        <h2>Stats</h2>
        <div class="grid-2" id="statsGrid"></div>
      </section>
      <section style="animation-delay: 0.05s;">
        <h2>Recent Sessions</h2>
        <ul id="sessionsList"></ul>
      </section>
      <section style="animation-delay: 0.1s;">
        <h2>Session Summaries</h2>
        <ul id="summariesList"></ul>
      </section>
      <section style="animation-delay: 0.15s;">
        <h2>Observations</h2>
        <div class="section-meta" id="observationsMeta">
          <span>Loading observations…</span>
          <span class="badge">signal filter</span>
        </div>
        <ul id="observationsList"></ul>
      </section>
      <section style="animation-delay: 0.2s;">
        <h2>Usage (token impact)</h2>
        <ul id="usageList"></ul>
      </section>
    </main>
    <script>
      const refreshStatus = document.getElementById("refreshStatus");
      const statsGrid = document.getElementById("statsGrid");
      const metaLine = document.getElementById("metaLine");
      const sessionsList = document.getElementById("sessionsList");
      const summariesList = document.getElementById("summariesList");
      const observationsMeta = document.getElementById("observationsMeta");
      const observationsList = document.getElementById("observationsList");
      const usageList = document.getElementById("usageList");

      function formatDate(value) {
        if (!value) return "n/a";
        const date = new Date(value);
        return isNaN(date) ? value : date.toLocaleString();
      }

      function normalize(text) {
        return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
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

      function renderStats(stats) {
        const db = stats.database || {};
        const usage = stats.usage?.totals || {};
        const items = [
          { label: "Sessions", value: db.sessions || 0 },
          { label: "Memory items", value: db.memory_items || 0 },
          { label: "Active items", value: db.active_memory_items || 0 },
          { label: "Artifacts", value: db.artifacts || 0 },
          { label: "Tokens read", value: usage.tokens_read || 0 },
          { label: "Est. savings", value: usage.tokens_saved || 0 },
        ];
        statsGrid.textContent = "";
        items.forEach(item => {
          const stat = createElement("div", "stat");
          const value = createElement("div", "value", item.value.toLocaleString());
          const label = createElement("div", "label", item.label);
          stat.append(value, label);
          statsGrid.appendChild(stat);
        });
        metaLine.textContent = `DB: ${db.path || "unknown"} · ${Math.round((db.size_bytes || 0) / 1024)} KB`;
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

      async function refresh() {
        refreshStatus.innerHTML = "<span class='dot'></span>refreshing…";
        try {
          const [stats, sessions, summaries, observations, usage] = await Promise.all([
            fetch("/api/stats").then(r => r.json()),
            fetch("/api/sessions?limit=8").then(r => r.json()),
            fetch("/api/memory?kind=session_summary&limit=8").then(r => r.json()),
            fetch("/api/memory?kind=observation&limit=10").then(r => r.json()),
            fetch("/api/usage").then(r => r.json()),
          ]);
          renderStats(stats);
          renderList(sessionsList, sessions.items || [], item => {
            const li = document.createElement("li");
            const title = createElement("div", "title");
            const strong = document.createElement("strong");
            strong.textContent = `#${item.id}`;
            title.append(strong);
            if (item.cwd) {
              title.append(document.createTextNode(` ${item.cwd}`));
            }
            const meta = createElement(
              "div",
              "small",
              `started ${formatDate(item.started_at)} · user ${item.user || "n/a"}`
            );
            li.append(title, meta);
            return li;
          });
          renderList(summariesList, summaries.items || [], item => {
            const li = document.createElement("li");
            const title = createElement("div", "title");
            const strong = document.createElement("strong");
            strong.textContent = item.title || "";
            title.appendChild(strong);
            const meta = createElement(
              "div",
              "small",
              `session #${item.session_id ?? "n/a"} · memory #${item.id ?? "n/a"}`
            );
            const body = createElement("div", "small truncate", item.body_text || "");
            li.append(title, meta, body);
            return li;
          });
          const observationItems = observations.items || [];
          const filteredObservations = observationItems.filter(item => !isLowSignalObservation(item));
          const filteredCount = observationItems.length - filteredObservations.length;
          observationsMeta.textContent = "";
          observationsMeta.append(
            createElement(
              "span",
              "",
              `${filteredObservations.length} showing${filteredCount ? ` · ${filteredCount} filtered` : ""}`
            ),
            createElement("span", "badge", "signal filter")
          );
          renderList(observationsList, filteredObservations, item => {
            const li = document.createElement("li");
            const title = createElement("div", "title");
            const strong = document.createElement("strong");
            strong.textContent = item.title || "";
            title.appendChild(strong);
            const meta = createElement(
              "div",
              "small",
              `session #${item.session_id ?? "n/a"} · memory #${item.id ?? "n/a"}`
            );
            const body = createElement("div", "small truncate", item.body_text || "");
            li.append(title, meta, body);
            return li;
          });
          renderList(usageList, usage.events || [], item => {
            const li = document.createElement("li");
            const title = createElement("div");
            const strong = document.createElement("strong");
            strong.textContent = item.event;
            title.append(strong, document.createTextNode(` · ${item.count} events`));
            const meta = createElement(
              "div",
              "small",
              `read ~${item.tokens_read.toLocaleString()} · est. saved ~${item.tokens_saved.toLocaleString()}`
            );
            li.append(title, meta);
            return li;
          });
          refreshStatus.innerHTML = "<span class='dot'></span>updated " + new Date().toLocaleTimeString();
        } catch (err) {
          refreshStatus.innerHTML = "<span class='dot'></span>refresh failed";
        }
      }

      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>
"""


class ViewerHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
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

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        if os.environ.get("OPENCODE_MEM_VIEWER_LOGS") == "1":
            super().log_message(format, *args)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html()
            return

        store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
        try:
            if parsed.path == "/api/stats":
                self._send_json(store.stats())
                return
            if parsed.path == "/api/usage":
                self._send_json(
                    {
                        "events": store.usage_summary(),
                        "totals": store.stats()["usage"]["totals"],
                    }
                )
                return
            if parsed.path == "/api/sessions":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["20"])[0])
                sessions = store.all_sessions()[:limit]
                for item in sessions:
                    item["metadata_json"] = from_json(item.get("metadata_json"))
                self._send_json({"items": sessions})
                return
            if parsed.path == "/api/memory":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["20"])[0])
                kind = params.get("kind", [None])[0]
                items = store.recent(
                    limit=limit, filters={"kind": kind} if kind else None
                )
                self._send_json({"items": items})
                return
            if parsed.path == "/api/artifacts":
                params = parse_qs(parsed.query)
                session_id = params.get("session_id", [None])[0]
                if not session_id:
                    self._send_json({"error": "session_id required"})
                    return
                items = store.session_artifacts(int(session_id))
                self._send_json({"items": items})
                return
            self.send_response(404)
            self.end_headers()
        finally:
            store.close()


def _serve(host: str, port: int) -> None:
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
