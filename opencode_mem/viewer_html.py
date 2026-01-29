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
      .sync-section {
        padding: 14px;
      }
      .sync-section h2 {
        margin-bottom: 6px;
      }
      .sync-section .section-meta {
        margin-bottom: 8px;
      }
      .sync-section .grid-2 {
        gap: 10px;
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
      [hidden] {
        display: none !important;
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
            <button class="settings-button" id="syncDetailsToggle">Diagnostics</button>
            <button class="settings-button" id="syncPairingToggle">Pair</button>
            <button class="settings-button" id="syncNowButton">Sync now</button>
          </div>
        </div>
        <div class="section-meta" id="syncMeta">Loading sync status…</div>
        <div class="grid-2" id="syncHealthGrid"></div>
        <div id="syncDiagnostics" hidden>
          <div class="section-meta">
            <label class="small" style="display:flex;align-items:center;gap:8px;">
              <input id="syncRedact" type="checkbox" checked />
              Redact sensitive details
            </label>
          </div>
          <div class="grid-2" id="syncStatusGrid"></div>
          <div class="peer-list" id="syncPeers"></div>
          <div class="attempts-list" id="syncAttempts"></div>
        </div>
        <div class="pairing-card" id="syncPairing" hidden>
          <div class="peer-title">
            <strong>Pairing payload</strong>
            <div class="peer-actions">
              <button id="pairingCopy">Copy pairing command</button>
            </div>
          </div>
          <div class="pairing-body">
            <pre id="pairingPayload">Loading…</pre>
          </div>
          <div class="peer-meta" id="pairingHint">Copy/paste this on the other device to pair.</div>
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
      const syncHealthGrid = document.getElementById("syncHealthGrid");
      const syncStatusGrid = document.getElementById("syncStatusGrid");
      const syncDiagnostics = document.getElementById("syncDiagnostics");
      const syncPeers = document.getElementById("syncPeers");
      const syncAttempts = document.getElementById("syncAttempts");
      const syncNowButton = document.getElementById("syncNowButton");
      const syncDetailsToggle = document.getElementById("syncDetailsToggle");
      const syncPairingToggle = document.getElementById("syncPairingToggle");
      const syncRedact = document.getElementById("syncRedact");
      const pairingPayload = document.getElementById("pairingPayload");
      const pairingCopy = document.getElementById("pairingCopy");
      const pairingHint = document.getElementById("pairingHint");
      const syncPairing = document.getElementById("syncPairing");

      let configDefaults = {};
      let configPath = "";
      let currentProject = "";
      const itemViewState = new Map();
      const FEED_FILTER_KEY = "opencode-mem-feed-filter";
      const FEED_FILTERS = ["all", "observations", "summaries"];

      const SYNC_DIAGNOSTICS_KEY = "opencode-mem-sync-diagnostics";
      const SYNC_PAIRING_KEY = "opencode-mem-sync-pairing";
      const SYNC_REDACT_KEY = "opencode-mem-sync-redact";
      let feedTypeFilter = "all";
      let pairingPayloadRaw = null;
      let pairingCommandRaw = "";
      let lastSyncStatus = null;
      let lastSyncPeers = [];
      let lastSyncAttempts = [];
      let syncPairingOpen = false;

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

      setSyncDiagnosticsOpen(isSyncDiagnosticsOpen());
      try {
        syncPairingOpen = localStorage.getItem(SYNC_PAIRING_KEY) === "1";
      } catch (err) {
        syncPairingOpen = false;
      }
      setSyncPairingOpen(syncPairingOpen);
      setSyncRedactionEnabled(isSyncRedactionEnabled());

      syncDetailsToggle?.addEventListener("click", () => {
        const next = !isSyncDiagnosticsOpen();
        setSyncDiagnosticsOpen(next);
        refresh();
      });

      syncPairingToggle?.addEventListener("click", () => {
        const next = !isSyncPairingOpen();
        setSyncPairingOpen(next);
        if (next) {
          if (pairingPayload) pairingPayload.textContent = "Loading…";
          if (pairingHint) pairingHint.textContent = "Fetching pairing command…";
        }
        refresh();
      });

      syncRedact?.addEventListener("change", () => {
        setSyncRedactionEnabled(Boolean(syncRedact.checked));
        renderSyncStatus(lastSyncStatus);
        renderSyncPeers(lastSyncPeers);
        renderSyncAttempts(lastSyncAttempts);
        renderPairing(pairingPayloadRaw);
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

      function isSyncDiagnosticsOpen() {
        return localStorage.getItem(SYNC_DIAGNOSTICS_KEY) === "1";
      }

      function setSyncDiagnosticsOpen(open) {
        if (syncDiagnostics) {
          syncDiagnostics.hidden = !open;
        }
        if (syncDetailsToggle) {
          syncDetailsToggle.textContent = open ? "Hide diagnostics" : "Diagnostics";
        }
        localStorage.setItem(SYNC_DIAGNOSTICS_KEY, open ? "1" : "0");
      }

      function isSyncPairingOpen() {
        return syncPairingOpen;
      }

      function setSyncPairingOpen(open) {
        syncPairingOpen = open;
        if (syncPairing) {
          syncPairing.hidden = !open;
        }
        if (syncPairingToggle) {
          syncPairingToggle.textContent = open ? "Close" : "Pair";
        }
        try {
          localStorage.setItem(SYNC_PAIRING_KEY, open ? "1" : "0");
        } catch (err) {
          // Ignore persistence errors (private mode / disabled storage).
        }
      }

      function isSyncRedactionEnabled() {
        const raw = localStorage.getItem(SYNC_REDACT_KEY);
        return raw !== "0";
      }

      function setSyncRedactionEnabled(enabled) {
        localStorage.setItem(SYNC_REDACT_KEY, enabled ? "1" : "0");
        if (syncRedact) {
          syncRedact.checked = enabled;
        }
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
        const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
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

      function renderStats(stats, usagePayload, project, rawEvents) {
        const db = stats.database || {};
        const totalsGlobal = usagePayload?.totals_global || usagePayload?.totals || stats.usage?.totals || {};
        const totalsFiltered = usagePayload?.totals_filtered || null;
        const isFiltered = !!(project && totalsFiltered);
        const usage = isFiltered ? totalsFiltered : totalsGlobal;

        const raw = rawEvents && typeof rawEvents === "object" ? rawEvents : {};
        const rawSessions = Number(raw.sessions || 0);
        const rawPending = Number(raw.pending || 0);

        const globalLineWork = isFiltered
          ? `\nGlobal: ${Number(totalsGlobal.work_investment_tokens || 0).toLocaleString()} invested`
          : "";
        const globalLineRead = isFiltered
          ? `\nGlobal: ${Number(totalsGlobal.tokens_read || 0).toLocaleString()} read`
          : "";
        const globalLineSaved = isFiltered
          ? `\nGlobal: ${Number(totalsGlobal.tokens_saved || 0).toLocaleString()} saved`
          : "";

        const items = [
          { label: "Sessions", value: db.sessions || 0, icon: "database" },
          { label: "Memories", value: db.memory_items || 0, icon: "brain" },
          { label: "Active memories", value: db.active_memory_items || 0, icon: "check-circle" },
          { label: "Artifacts", value: db.artifacts || 0, icon: "package" },
          {
            label: "Raw sessions",
            value: rawSessions,
            tooltip: "OpenCode sessions with pending raw events waiting to be flushed",
            icon: "inbox",
          },
          {
            label: "Raw events pending",
            value: rawPending,
            tooltip: "Total pending raw events waiting to be flushed",
            icon: "activity",
          },
          {
            label: isFiltered ? "Work investment (project)" : "Work investment",
            value: Number(usage.work_investment_tokens || 0),
            tooltip: "Token cost of unique discovery groups (avoids double-counting when one response yields multiple memories)" + globalLineWork,
            icon: "pencil",
          },
          {
            label: isFiltered ? "Read cost (project)" : "Read cost",
            value: Number(usage.tokens_read || 0),
            tooltip: "Tokens to read memories when injected into context" + globalLineRead,
            icon: "book-open",
          },
          {
            label: isFiltered ? "Savings (project)" : "Savings",
            value: Number(usage.tokens_saved || 0),
            tooltip: "Tokens saved by reusing compressed memories instead of raw context" + globalLineSaved,
            icon: "trending-up",
          },
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
          const value = createElement("div", "value", Number(item.value || 0).toLocaleString());
          const label = createElement("div", "label", item.label);
          content.append(value, label);
          stat.append(icon, content);
          statsGrid.appendChild(stat);
        });
        if (typeof lucide !== "undefined") lucide.createIcons();
        const projectSuffix = project ? ` · project: ${project}` : "";
        metaLine.textContent = `DB: ${db.path || "unknown"} · ${Math.round((db.size_bytes || 0) / 1024)} KB${projectSuffix}`;
      }

      function formatTimestamp(value) {
        if (!value) return "never";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }

      function redactAddress(address) {
        const raw = String(address || "");
        if (!raw) return "";
        let scheme = "";
        let remainder = raw;
        const schemeMatch = raw.match(/^(\\w+):\\/\\/([^/]+)(.*)$/);
        if (schemeMatch) {
          scheme = schemeMatch[1];
          remainder = schemeMatch[2] + schemeMatch[3];
        }
        const redacted = remainder.replace(/\\d+/g, "#");
        return scheme ? `${scheme}://${redacted}` : redacted;
      }

      function renderSyncStatus(status) {
        if (!syncStatusGrid) return;
        syncStatusGrid.textContent = "";
        if (!status) return;

        const peers = status.peers || {};
        const pingPayload = status.ping || {};
        const syncPayload = status.sync || {};
        const lastSync = status.last_sync_at || status.last_sync_at_utc || null;
        const lastPing = pingPayload.last_ping_at || status.last_ping_at || null;
        const syncError = status.last_sync_error || "";
        const pingError = status.last_ping_error || "";
        const pending = Number(status.pending || 0);

        const items = [
          { label: "Pending events", value: pending },
          { label: "Last sync", value: formatTimestamp(lastSync) },
          { label: "Last ping", value: formatTimestamp(lastPing) },
          { label: "Peers", value: Object.keys(peers).length },
        ];
        items.forEach(item => {
          const block = createElement("div", "stat");
          const value = createElement("div", "value", item.value);
          const label = createElement("div", "label", item.label);
          const content = createElement("div", "stat-content");
          content.append(value, label);
          block.append(content);
          syncStatusGrid.append(block);
        });

        if (syncError || pingError) {
          const block = createElement("div", "stat");
          const value = createElement("div", "value", "Errors");
          const label = createElement("div", "label", [syncError, pingError].filter(Boolean).join(" · "));
          const content = createElement("div", "stat-content");
          content.append(value, label);
          block.append(content);
          syncStatusGrid.append(block);
        }

        if (syncPayload && syncPayload.seconds_since_last) {
          const block = createElement("div", "stat");
          const value = createElement("div", "value", `${syncPayload.seconds_since_last}s`);
          const label = createElement("div", "label", "Since last sync");
          const content = createElement("div", "stat-content");
          content.append(value, label);
          block.append(content);
          syncStatusGrid.append(block);
        }

        if (pingPayload && pingPayload.seconds_since_last) {
          const block = createElement("div", "stat");
          const value = createElement("div", "value", `${pingPayload.seconds_since_last}s`);
          const label = createElement("div", "label", "Since last ping");
          const content = createElement("div", "stat-content");
          content.append(value, label);
          block.append(content);
          syncStatusGrid.append(block);
        }
      }

      function renderSyncPeers(peers) {
        if (!syncPeers) return;
        syncPeers.textContent = "";
        if (!Array.isArray(peers) || !peers.length) return;

        peers.forEach(peer => {
          const card = createElement("div", "peer-card");
          const title = createElement("div", "peer-title");
          const name = createElement("strong", null, peer.name || "unknown");
          const actions = createElement("div", "peer-actions");

          const status = peer.status || {};
          const syncStatus = status.sync_status || "";
          const pingStatus = status.ping_status || "";
          const online = syncStatus === "ok" || pingStatus === "ok";
          const statusBadge = createElement("span", "badge", online ? "Online" : "Offline");
          statusBadge.style.background = online ? "rgba(31, 111, 92, 0.12)" : "rgba(230, 126, 77, 0.15)";
          statusBadge.style.color = online ? "var(--accent)" : "var(--accent-2)";
          name.append(" ", statusBadge);

          const peerAddresses = Array.isArray(peer.addresses) ? peer.addresses : [];
          const addressLine = peerAddresses.length
            ? peerAddresses.map(address => isSyncRedactionEnabled() ? redactAddress(address) : address).join(" · ")
            : "No addresses";
          const addressLabel = createElement("div", "peer-addresses", addressLine);

          const lastSyncAt = status.last_sync_at || status.last_sync_at_utc || "";
          const lastPingAt = status.last_ping_at || status.last_ping_at_utc || "";
          const metaLine = [
            lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : "Sync: never",
            lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : "Ping: never",
          ].join(" · ");
          const meta = createElement("div", "peer-meta", metaLine);

          if (peerAddresses.length) {
            peerAddresses.forEach(address => {
              const button = createElement("button", null, "Sync now");
              button.addEventListener("click", () => syncNow(address));
              actions.appendChild(button);
            });
          }

          title.append(name, actions);
          card.append(title, addressLabel, meta);
          syncPeers.appendChild(card);
        });
      }

      function renderSyncAttempts(attempts) {
        if (!syncAttempts) return;
        syncAttempts.textContent = "";
        if (!Array.isArray(attempts) || !attempts.length) return;

        attempts.forEach(attempt => {
          const line = createElement("div", "diag-line");
          const left = createElement("div", "left");
          const right = createElement("div", "right");

          const attemptStatus = attempt.status || "unknown";
          const status = createElement("div", null, attemptStatus);
          const address = attempt.address ? String(attempt.address) : "";
          const redacted = isSyncRedactionEnabled() ? redactAddress(address) : address;
          const addressLabel = createElement("div", "small", redacted || "n/a");
          left.append(status, addressLabel);

          const time = attempt.started_at || attempt.started_at_utc || "";
          right.textContent = time ? formatTimestamp(time) : "";

          line.append(left, right);
          syncAttempts.appendChild(line);
        });
      }

      function renderSyncHealth(syncHealth) {
        if (!syncHealthGrid) return;
        syncHealthGrid.textContent = "";
        const health = syncHealth || {};
        const title = createElement("div", "stat");
        const value = createElement("div", "value", health.status || "unknown");
        const label = createElement("div", "label", "Sync status");
        const content = createElement("div", "stat-content");
        content.append(value, label);
        title.append(content);
        syncHealthGrid.append(title);
        if (health.details) {
          const detail = createElement("div", "stat");
          const detailValue = createElement("div", "value", health.details);
          const detailLabel = createElement("div", "label", "Details");
          const detailContent = createElement("div", "stat-content");
          detailContent.append(detailValue, detailLabel);
          detail.append(detailContent);
          syncHealthGrid.append(detail);
        }
      }

      function renderPairing(payload) {
        if (!pairingPayload) return;
        if (!payload) {
          pairingPayload.textContent = "No pairing payload available";
          if (pairingHint) pairingHint.textContent = "Pairing will appear after at least one sync scan.";
          return;
        }

        const command = payload.command || "";
        pairingPayload.textContent = command || "Pairing not available";
        pairingCommandRaw = command || "";
        if (pairingHint) {
          pairingHint.textContent = payload.hint || "Copy/paste this on the other device to pair.";
        }
      }

      async function copyPairingCommand() {
        const command = pairingCommandRaw || pairingPayload?.textContent || "";
        if (!command) return;
        try {
          await navigator.clipboard.writeText(command);
          if (pairingCopy) pairingCopy.textContent = "Copied";
          setTimeout(() => {
            if (pairingCopy) pairingCopy.textContent = "Copy pairing command";
          }, 1200);
        } catch (err) {
          if (pairingCopy) pairingCopy.textContent = "Copy failed";
        }
      }

      pairingCopy?.addEventListener("click", copyPairingCommand);

      function renderFeed(items) {
        if (!feedList) return;
        feedList.textContent = "";
        if (!Array.isArray(items) || !items.length) {
          const empty = createElement("div", "small", "No memories yet.");
          feedList.appendChild(empty);
          return;
        }
        items.forEach(item => {
          const card = createElement("div", `feed-item ${String(item.kind || "").toLowerCase()}`.trim());
          const header = createElement("div", "feed-card-header");
          const titleWrap = createElement("div", "feed-header");
          const title = createElement("div", "feed-title title", item.title || "(untitled)");
          titleWrap.appendChild(title);

          const kindRow = createElement("div", "kind-row");
          const kind = createElement("span", `kind-pill ${String(item.kind || "").toLowerCase()}`.trim(), item.kind || "");
          kindRow.appendChild(kind);

          const createdAt = formatDate(item.created_at || item.created_at_utc);
          const age = createElement("div", "small", createdAt);

          header.append(titleWrap, kindRow, age);

          const metaLine = createElement("div", "feed-meta");
          const tags = parseJsonArray(item.tags || []);
          const files = parseJsonArray(item.files || []);
          const project = item.project || "";
          const tagContent = tags.length ? ` · ${tags.map(tag => formatTagLabel(tag)).join(", ")}` : "";
          const fileContent = files.length ? ` · ${formatFileList(files)}` : "";
          const projectContent = project ? `Project: ${project}` : "Project: n/a";
          metaLine.textContent = `${projectContent}${tagContent}${fileContent}`;

          const body = createElement("div", "feed-body");
          const parsedBody = item.body_html || item.body_text || "";
          if (parsedBody) {
            body.innerHTML = marked.parse(parsedBody);
          }

          const footer = createElement("div", "feed-footer");
          const footerLeft = createElement("div", "feed-footer-left");
          const filesWrap = createElement("div", "feed-files");
          const tagsWrap = createElement("div", "feed-tags");

          files.forEach(file => {
            const chip = createElement("span", "feed-file", file);
            filesWrap.appendChild(chip);
          });

          tags.forEach(tag => {
            const chip = createTagChip(tag);
            if (chip) tagsWrap.appendChild(chip);
          });

          if (filesWrap.childElementCount) {
            footerLeft.appendChild(filesWrap);
          }
          if (tagsWrap.childElementCount) {
            footerLeft.appendChild(tagsWrap);
          }
          footer.appendChild(footerLeft);

          card.append(header, metaLine, body, footer);
          feedList.appendChild(card);
        });
        if (typeof lucide !== "undefined") lucide.createIcons();
      }

      function renderSessionSummary(summary) {
        if (!sessionGrid || !sessionMeta) return;
        sessionGrid.textContent = "";
        if (!summary) {
          sessionMeta.textContent = "No injections yet";
          return;
        }

        const total = Number(summary.total || 0);
        sessionMeta.textContent = total
          ? `${total} injections so far`
          : "No injections yet";

        const items = [
          { label: "Memories", value: summary.memories || 0 },
          { label: "Artifacts", value: summary.artifacts || 0 },
          { label: "Prompts", value: summary.prompts || 0 },
          { label: "Observations", value: summary.observations || 0 },
        ];
        items.forEach(item => {
          const block = createElement("div", "stat");
          const value = createElement("div", "value", Number(item.value || 0).toLocaleString());
          const label = createElement("div", "label", item.label);
          const content = createElement("div", "stat-content");
          content.append(value, label);
          block.append(content);
          sessionGrid.appendChild(block);
        });
      }

      function renderConfigModal(defaults, config) {
        if (!defaults || !config) return;
        configDefaults = defaults;
        configPath = config.path || "";

        const observerProvider = config.observer_provider || "";
        const observerModel = config.observer_model || "";
        const observerMaxChars = config.observer_max_chars || "";
        const packObservationLimit = config.pack_observation_limit || "";
        const packSessionLimit = config.pack_session_limit || "";
        const syncEnabled = config.sync_enabled || false;
        const syncHost = config.sync_host || "";
        const syncPort = config.sync_port || "";
        const syncInterval = config.sync_interval_seconds || "";
        const syncMdns = config.sync_mdns || false;

        if (observerProviderInput) observerProviderInput.value = observerProvider;
        if (observerModelInput) observerModelInput.value = observerModel;
        if (observerMaxCharsInput) observerMaxCharsInput.value = observerMaxChars;
        if (packObservationLimitInput) packObservationLimitInput.value = packObservationLimit;
        if (packSessionLimitInput) packSessionLimitInput.value = packSessionLimit;
        if (syncEnabledInput) syncEnabledInput.checked = Boolean(syncEnabled);
        if (syncHostInput) syncHostInput.value = syncHost;
        if (syncPortInput) syncPortInput.value = syncPort;
        if (syncIntervalInput) syncIntervalInput.value = syncInterval;
        if (syncMdnsInput) syncMdnsInput.checked = Boolean(syncMdns);

        if (settingsPath) settingsPath.textContent = configPath ? `Config path: ${configPath}` : "Config path: n/a";
        if (observerMaxCharsHint) {
          const defaultValue = configDefaults?.observer_max_chars || "";
          observerMaxCharsHint.textContent = defaultValue ? `Default: ${defaultValue}` : "";
        }
        if (settingsEffective) settingsEffective.textContent = config.effective ?? "";
      }

      function openSettings() {
        if (settingsBackdrop) settingsBackdrop.hidden = false;
        if (settingsModal) settingsModal.hidden = false;
      }

      function closeSettings() {
        if (settingsBackdrop) settingsBackdrop.hidden = true;
        if (settingsModal) settingsModal.hidden = true;
      }

      settingsButton?.addEventListener("click", openSettings);
      settingsClose?.addEventListener("click", closeSettings);
      settingsBackdrop?.addEventListener("click", closeSettings);

      function renderSummary(summary) {
        if (!summary) return null;
        const container = createElement("div", "feed-body facts");
        const sections = [
          { label: "Outcome", value: summary.outcome },
          { label: "Plan", value: summary.plan },
          { label: "Next", value: summary.next },
          { label: "Notes", value: summary.notes },
        ];
        sections.forEach(section => {
          const content = String(section.value || "").trim();
          if (!content) return;
          const row = createElement("div", "summary-section");
          const label = createElement("div", "summary-section-label", section.label);
          const value = createElement("div", "summary-section-content", content);
          row.append(label, value);
          container.appendChild(row);
        });
        return container;
      }

      function renderObservation(observation) {
        const item = createElement("li");
        const header = createElement("div", "feed-card-header");
        const titleWrap = createElement("div", "feed-header");
        const title = createElement("div", "feed-title title", observation.title || "(untitled)");
        titleWrap.appendChild(title);

        const kindRow = createElement("div", "kind-row");
        const kind = createElement("span", `kind-pill ${String(observation.kind || "").toLowerCase()}`.trim(), observation.kind || "");
        kindRow.appendChild(kind);

        const createdAt = formatDate(observation.created_at || observation.created_at_utc);
        const age = createElement("div", "small", createdAt);

        header.append(titleWrap, kindRow, age);
        item.appendChild(header);

        if (observation.summary) {
          const summary = renderSummary(observation.summary);
          if (summary) item.appendChild(summary);
        } else if (observation.body_html || observation.body_text) {
          const body = createElement("div", "feed-body");
          body.innerHTML = marked.parse(observation.body_html || observation.body_text || "");
          item.appendChild(body);
        }

        const footer = createElement("div", "feed-footer");
        const footerLeft = createElement("div", "feed-footer-left");
        const filesWrap = createElement("div", "feed-files");
        const tagsWrap = createElement("div", "feed-tags");

        const files = parseJsonArray(observation.files || []);
        const tags = parseJsonArray(observation.tags || []);

        files.forEach(file => {
          const chip = createElement("span", "feed-file", file);
          filesWrap.appendChild(chip);
        });

        tags.forEach(tag => {
          const chip = createTagChip(tag);
          if (chip) tagsWrap.appendChild(chip);
        });

        if (filesWrap.childElementCount) {
          footerLeft.appendChild(filesWrap);
        }
        if (tagsWrap.childElementCount) {
          footerLeft.appendChild(tagsWrap);
        }
        footer.appendChild(footerLeft);
        item.appendChild(footer);
        return item;
      }

      function renderObservations(items) {
        if (!feedList) return;
        feedList.textContent = "";
        if (!items.length) {
          feedList.appendChild(createElement("div", "small", "No observations yet."));
          return;
        }
        items.forEach(observation => {
          const item = renderObservation(observation);
          if (item) feedList.appendChild(item);
        });
        if (typeof lucide !== "undefined") lucide.createIcons();
      }

      function renderSummaryCard(summary) {
        if (!summary) return null;
        const item = createElement("li");
        const header = createElement("div", "feed-card-header");
        const titleWrap = createElement("div", "feed-header");
        const title = createElement("div", "feed-title title", summary.title || "(untitled)");
        titleWrap.appendChild(title);

        const kindRow = createElement("div", "kind-row");
        const kind = createElement("span", `kind-pill ${String(summary.kind || "").toLowerCase()}`.trim(), summary.kind || "");
        kindRow.appendChild(kind);

        const createdAt = formatDate(summary.created_at || summary.created_at_utc);
        const age = createElement("div", "small", createdAt);

        header.append(titleWrap, kindRow, age);
        item.appendChild(header);

        const summaryContainer = renderSummary(summary.summary);
        if (summaryContainer) {
          item.appendChild(summaryContainer);
        } else if (summary.body_html || summary.body_text) {
          const body = createElement("div", "feed-body");
          body.innerHTML = marked.parse(summary.body_html || summary.body_text || "");
          item.appendChild(body);
        }

        const footer = createElement("div", "feed-footer");
        const footerLeft = createElement("div", "feed-footer-left");
        const filesWrap = createElement("div", "feed-files");
        const tagsWrap = createElement("div", "feed-tags");

        const files = parseJsonArray(summary.files || []);
        const tags = parseJsonArray(summary.tags || []);

        files.forEach(file => {
          const chip = createElement("span", "feed-file", file);
          filesWrap.appendChild(chip);
        });

        tags.forEach(tag => {
          const chip = createTagChip(tag);
          if (chip) tagsWrap.appendChild(chip);
        });

        if (filesWrap.childElementCount) {
          footerLeft.appendChild(filesWrap);
        }
        if (tagsWrap.childElementCount) {
          footerLeft.appendChild(tagsWrap);
        }
        footer.appendChild(footerLeft);
        item.appendChild(footer);
        return item;
      }

      function renderSummaries(items) {
        if (!feedList) return;
        feedList.textContent = "";
        if (!items.length) {
          feedList.appendChild(createElement("div", "small", "No summaries yet."));
          return;
        }
        items.forEach(summary => {
          const item = renderSummaryCard(summary);
          if (item) feedList.appendChild(item);
        });
        if (typeof lucide !== "undefined") lucide.createIcons();
      }

      async function syncNow(address) {
        if (!syncNowButton) return;
        syncNowButton.disabled = true;
        syncNowButton.textContent = "Syncing...";
        try {
          const payload = address ? { address } : {};
          await fetch("/api/sync/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          refresh();
        } catch (err) {
          // Ignore errors; they will be surfaced via status checks.
        } finally {
          syncNowButton.disabled = false;
          syncNowButton.textContent = "Sync now";
        }
      }

      syncNowButton?.addEventListener("click", () => syncNow(""));

      function hideSettingsOverrideNotice(config) {
        if (!settingsOverrides) return;
        if (config?.has_env_overrides) {
          settingsOverrides.hidden = false;
        } else {
          settingsOverrides.hidden = true;
        }
      }

      async function saveSettings() {
        if (!settingsSave || !settingsStatus) return;
        settingsSave.disabled = true;
        settingsStatus.textContent = "Saving...";
        try {
          const payload = {
            observer_provider: observerProviderInput?.value || "",
            observer_model: observerModelInput?.value || "",
            observer_max_chars: Number(observerMaxCharsInput?.value || 0) || "",
            pack_observation_limit: Number(packObservationLimitInput?.value || 0) || "",
            pack_session_limit: Number(packSessionLimitInput?.value || 0) || "",
            sync_enabled: syncEnabledInput?.checked || false,
            sync_host: syncHostInput?.value || "",
            sync_port: Number(syncPortInput?.value || 0) || "",
            sync_interval_seconds: Number(syncIntervalInput?.value || 0) || "",
            sync_mdns: syncMdnsInput?.checked || false,
          };
          const resp = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!resp.ok) {
            const message = await resp.text();
            throw new Error(message);
          }
          settingsStatus.textContent = "Saved";
          setTimeout(() => {
            settingsStatus.textContent = "Ready";
          }, 1500);
          refresh();
        } catch (err) {
          settingsStatus.textContent = "Save failed";
        } finally {
          settingsSave.disabled = false;
        }
      }

      settingsSave?.addEventListener("click", saveSettings);

      async function loadStats() {
        try {
          const [statsResp, usageResp, sessionsResp, rawEventsResp] = await Promise.all([
            fetch("/api/stats"),
            fetch(`/api/usage?project=${encodeURIComponent(currentProject || "")}`),
            fetch(`/api/session?project=${encodeURIComponent(currentProject || "")}`),
            fetch(`/api/raw-events?project=${encodeURIComponent(currentProject || "")}`),
          ]);

          const statsPayload = await statsResp.json();
          const usagePayload = usageResp.ok ? await usageResp.json() : {};
          const sessionsPayload = sessionsResp.ok ? await sessionsResp.json() : {};
          const rawEventsPayload = rawEventsResp.ok ? await rawEventsResp.json() : {};

          const stats = statsPayload || {};
          const sessions = sessionsPayload || {};
          const rawEvents = rawEventsPayload || {};

          renderStats(stats, usagePayload, currentProject, rawEvents);
          renderSessionSummary(sessions);
          renderSyncHealth(stats.sync_health || {});
        } catch (err) {
          if (metaLine) metaLine.textContent = "Stats unavailable";
        }
      }

      async function loadFeed() {
        try {
          const [observationsResp, summariesResp] = await Promise.all([
            fetch(`/api/memories?project=${encodeURIComponent(currentProject || "")}`),
            fetch(`/api/summaries?project=${encodeURIComponent(currentProject || "")}`),
          ]);

          const observations = await observationsResp.json();
          const summaries = await summariesResp.json();

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

      async function loadConfig() {
        try {
          const resp = await fetch("/api/config");
          if (!resp.ok) return;
          const payload = await resp.json();
          renderConfigModal(payload.defaults || {}, payload.config || {});
          hideSettingsOverrideNotice(payload.config || {});
        } catch (err) {
          // Ignore config load errors.
        }
      }

      async function loadSyncStatus() {
        try {
          const resp = await fetch("/api/sync/status");
          if (!resp.ok) return;
          const payload = await resp.json();
          lastSyncStatus = payload.status || null;
          lastSyncPeers = payload.peers || [];
          lastSyncAttempts = payload.attempts || [];
          renderSyncStatus(lastSyncStatus);
          renderSyncPeers(lastSyncPeers);
          renderSyncAttempts(lastSyncAttempts);
        } catch (err) {
          // Ignore sync status errors.
        }
      }

      async function loadPairing() {
        try {
          const resp = await fetch("/api/sync/pairing");
          if (!resp.ok) return;
          const payload = await resp.json();
          pairingPayloadRaw = payload || null;
          renderPairing(payload || null);
        } catch (err) {
          renderPairing(null);
        }
      }

      async function loadProjects() {
        try {
          const resp = await fetch("/api/projects");
          if (!resp.ok) return;
          const payload = await resp.json();
          const projects = payload.projects || [];
          projectFilter.textContent = "";
          const allOption = createElement("option", null, "All Projects");
          allOption.value = "";
          projectFilter.appendChild(allOption);
          projects.forEach(project => {
            const option = createElement("option", null, project);
            option.value = project;
            projectFilter.appendChild(option);
          });
        } catch (err) {
          // Ignore project load errors.
        }
      }

      projectFilter?.addEventListener("change", () => {
        currentProject = projectFilter.value || "";
        refresh();
      });

      async function refresh() {
        await Promise.all([
          loadStats(),
          loadFeed(),
          loadConfig(),
          loadSyncStatus(),
        ]);

        if (isSyncPairingOpen()) {
          loadPairing();
        } else {
          pairingPayloadRaw = null;
          pairingCommandRaw = "";
          if (syncPairing) syncPairing.hidden = true;
        }
      }

      loadProjects();
      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>
"""
