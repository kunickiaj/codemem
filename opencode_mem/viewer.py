from __future__ import annotations

import json
import os
import socket
import threading
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
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
from .store import MemoryStore

DEFAULT_VIEWER_HOST = "127.0.0.1"
DEFAULT_VIEWER_PORT = 38888

VIEWER_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>opencode-mem viewer</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g1' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%231f6f5c'/%3E%3Cstop offset='100%25' style='stop-color:%23e67e4d'/%3E%3C/linearGradient%3E%3Cfilter id='shadow'%3E%3CfeDropShadow dx='0' dy='2' stdDeviation='3' flood-color='%23000' flood-opacity='0.5'/%3E%3C/filter%3E%3C/defs%3E%3Crect x='5' y='5' width='90' height='90' rx='16' fill='%23fff' stroke='%23000' stroke-width='3' filter='url(%23shadow)'/%3E%3Crect x='8' y='8' width='84' height='84' rx='14' fill='url(%23g1)'/%3E%3Cpath d='M20 75V25h15l15 25 15-25h15v50h-15V45l-15 22-15-22v30z' fill='white'/%3E%3C/svg%3E" />
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
          --ink: #e8e4df;
          --muted: #9a9590;
          --card: #252423;
          --accent: #3db89a;
          --accent-2: #f0956a;
          --accent-3: #6b8fc7;
          --border: #3a3836;
          --shadow: 0 18px 40px rgba(0, 0, 0, 0.4);
          --header-bg: rgba(37, 36, 35, 0.92);
          --input-bg: rgba(50, 48, 46, 0.8);
          --item-bg: rgba(45, 43, 41, 0.6);
          --item-hover-bg: rgba(55, 53, 51, 0.85);
          --stat-bg: #2a2827;
          --body-grad-1: rgba(61, 184, 154, 0.12);
          --body-grad-2: rgba(240, 149, 106, 0.12);
          --body-grad-3: rgba(107, 143, 199, 0.1);
          --body-base-start: #1a1918;
          --body-base-mid: #1e1d1c;
          --body-base-end: #222120;
          --dot-color: rgba(255, 255, 255, 0.03);
        }
      }
      [data-theme="dark"] {
        --bg: #1a1918;
        --ink: #e8e4df;
        --muted: #9a9590;
        --card: #252423;
        --accent: #3db89a;
        --accent-2: #f0956a;
        --accent-3: #6b8fc7;
        --border: #3a3836;
        --shadow: 0 18px 40px rgba(0, 0, 0, 0.4);
        --header-bg: rgba(37, 36, 35, 0.92);
        --input-bg: rgba(50, 48, 46, 0.8);
        --item-bg: rgba(45, 43, 41, 0.6);
        --item-hover-bg: rgba(55, 53, 51, 0.85);
        --stat-bg: #2a2827;
        --body-grad-1: rgba(61, 184, 154, 0.12);
        --body-grad-2: rgba(240, 149, 106, 0.12);
        --body-grad-3: rgba(107, 143, 199, 0.1);
        --body-base-start: #1a1918;
        --body-base-mid: #1e1d1c;
        --body-base-end: #222120;
        --dot-color: rgba(255, 255, 255, 0.03);
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
      .kind-pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(31, 111, 92, 0.12);
        color: var(--accent);
        font-size: 11px;
        letter-spacing: 0.3px;
        text-transform: uppercase;
      }
      .kind-pill.feature {
        background: rgba(31, 111, 92, 0.16);
        color: #1f6f5c;
      }
      .kind-pill.change {
        background: rgba(34, 58, 94, 0.16);
        color: #223a5e;
      }
      .kind-pill.bugfix {
        background: rgba(230, 126, 77, 0.18);
        color: #8d451f;
      }
      .kind-pill.refactor {
        background: rgba(127, 89, 193, 0.18);
        color: #5d3aa5;
      }
      .kind-pill.discovery {
        background: rgba(120, 153, 235, 0.18);
        color: #3b55a6;
      }
      .kind-pill.decision {
        background: rgba(94, 129, 172, 0.18);
        color: #3c516f;
      }
      .kind-pill.session_summary {
        background: rgba(70, 150, 140, 0.18);
        color: #2d5f58;
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
      .feed-meta {
        color: var(--muted);
        font-size: 12px;
      }
      .feed-body {
        font-size: 13px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .feed-item.feature { border-left-color: rgba(31, 111, 92, 0.6); }
      .feed-item.change { border-left-color: rgba(34, 58, 94, 0.6); }
      .feed-item.bugfix { border-left-color: rgba(230, 126, 77, 0.7); }
      .feed-item.refactor { border-left-color: rgba(127, 89, 193, 0.6); }
      .feed-item.discovery { border-left-color: rgba(120, 153, 235, 0.6); }
      .feed-item.decision { border-left-color: rgba(94, 129, 172, 0.6); }
      .feed-item.session_summary { border-left-color: rgba(70, 150, 140, 0.6); }
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
          <div class="meta">signal: <strong>memory</strong> · window: <strong>recent</strong></div>
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
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
            <div class="small">Leave blank to use defaults.</div>
          </div>
          <div class="field">
            <label for="observerModel">Observer model</label>
            <input id="observerModel" placeholder="leave empty for default" />
            <div class="small">Override the observer model when set.</div>
          </div>
          <div class="field">
            <label for="observerMaxChars">Observer max chars</label>
            <input id="observerMaxChars" type="number" min="1" />
            <div class="small" id="observerMaxCharsHint"></div>
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
          <h2>Usage (reuse impact)</h2>
          <ul id="usageList"></ul>
        </section>
      </div>
      <section class="feed-section" style="animation-delay: 0.1s;">
        <h2>Memory feed</h2>
        <div class="section-meta" id="feedMeta">Loading memories…</div>
        <div class="feed-list" id="feedList"></div>
      </section>
    </main>
    <script>
      const refreshStatus = document.getElementById("refreshStatus");
      const statsGrid = document.getElementById("statsGrid");
      const metaLine = document.getElementById("metaLine");
      const feedList = document.getElementById("feedList");
      const feedMeta = document.getElementById("feedMeta");
      const usageList = document.getElementById("usageList");
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
      const projectFilter = document.getElementById("projectFilter");
      const themeToggle = document.getElementById("themeToggle");

      let configDefaults = {};
      let configPath = "";
      let currentProject = "";

      // Theme management
      function getTheme() {
        const saved = localStorage.getItem("opencode-mem-theme");
        if (saved) return saved;
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }

      function setTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("opencode-mem-theme", theme);
        themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
        themeToggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
      }

      function toggleTheme() {
        const current = getTheme();
        setTheme(current === "dark" ? "light" : "dark");
      }

      // Initialize theme
      setTheme(getTheme());
      themeToggle?.addEventListener("click", toggleTheme);

      function formatDate(value) {
        if (!value) return "n/a";
        const date = new Date(value);
        return isNaN(date) ? value : date.toLocaleString();
      }

      function normalize(text) {
        return (text || "").replace(/\\s+/g, " ").trim().toLowerCase();
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
          { label: "Reuse savings", value: usage.tokens_saved || 0 },
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
          const header = createElement("div", "feed-header");
          const kindTag = createElement("span", `kind-pill ${kindValue}`, kindValue.replace(/_/g, " "));
          const title = createElement("div", "feed-title", item.title || "Memory entry");
          header.append(kindTag, title);
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
          const body = createElement("div", "feed-body", item.body_text || "");
          feedItem.append(header, meta, body);
          feedList.appendChild(feedItem);
        });
      }

      function setSettingsOpen(isOpen) {
        settingsBackdrop.hidden = !isOpen;
        settingsModal.hidden = !isOpen;
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
          observerProviderInput.value = config.observer_provider ?? "";
          observerModelInput.value = config.observer_model ?? "";
          const defaultMax = configDefaults.observer_max_chars ?? 12000;
          observerMaxCharsInput.value = config.observer_max_chars ?? defaultMax;
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
        let maxChars = null;
        if (maxValue) {
          maxChars = Number(maxValue);
          if (!Number.isInteger(maxChars) || maxChars <= 0) {
            settingsStatus.textContent = "Observer max chars must be a positive integer";
            settingsSave.disabled = false;
            return;
          }
        }
        const payload = {
          config: {
            observer_provider: provider || null,
            observer_model: model || null,
            observer_max_chars: maxChars,
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
            const displayName = project.split("/").pop() || project;
            option.textContent = displayName;
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

      async function refresh() {
        refreshStatus.innerHTML = "<span class='dot'></span>refreshing…";
        try {
          const projectParam = currentProject ? `&project=${encodeURIComponent(currentProject)}` : "";
          const [stats, summaries, observations, usage] = await Promise.all([
            fetch("/api/stats").then(r => r.json()),
            fetch(`/api/memory?kind=session_summary&limit=20${projectParam}`).then(r => r.json()),
            fetch(`/api/observations?limit=40${projectParam}`).then(r => r.json()),
            fetch("/api/usage").then(r => r.json()),
          ]);
          renderStats(stats);
          const summaryItems = summaries.items || [];
          const observationItems = observations.items || [];
          const filteredObservations = observationItems.filter(item => !isLowSignalObservation(item));
          const filteredCount = observationItems.length - filteredObservations.length;
          const feedItems = [...summaryItems, ...filteredObservations].sort((a, b) => {
            const left = new Date(a.created_at || 0).getTime();
            const right = new Date(b.created_at || 0).getTime();
            return right - left;
          });
          feedMeta.textContent = `${feedItems.length} items${filteredCount ? ` · ${filteredCount} observations filtered` : ""}`;
          renderFeed(feedItems);
          renderList(usageList, usage.events || [], item => {
            const li = document.createElement("li");
            const title = createElement("div");
            const strong = document.createElement("strong");
            strong.textContent = item.event;
            title.append(strong, document.createTextNode(` · ${item.count} events`));
            const meta = createElement(
              "div",
              "small",
              `read ~${item.tokens_read.toLocaleString()} · reuse saved ~${item.tokens_saved.toLocaleString()}`
            );
            li.append(title, meta);
            return li;
          });
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
            if parsed.path == "/api/projects":
                sessions = store.all_sessions()
                projects = sorted({s["project"] for s in sessions if s.get("project")})
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
                try:
                    limit = int(params.get("limit", ["8"])[0])
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
                    }
                )
                return
            self.send_response(404)
            self.end_headers()
        finally:
            store.close()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
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
        allowed_keys = {"observer_provider", "observer_model", "observer_max_chars"}
        allowed_providers = {"openai", "anthropic"}
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
                        {"error": "observer_provider must be openai or anthropic"},
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
        try:
            write_config_file(config_data, config_path)
        except OSError:
            self._send_json({"error": "failed to write config"}, status=500)
            return
        self._send_json({"path": str(config_path), "config": config_data})


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
