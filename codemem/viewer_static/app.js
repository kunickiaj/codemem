(function() {
  "use strict";
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0 && text !== null) node.textContent = String(text);
    return node;
  }
  function $(id) {
    return document.getElementById(id);
  }
  function $input(id) {
    return document.getElementById(id);
  }
  function $select(id) {
    return document.getElementById(id);
  }
  function $button(id) {
    return document.getElementById(id);
  }
  function hide(element) {
    if (element) element.hidden = true;
  }
  function show(element) {
    if (element) element.hidden = false;
  }
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function highlightText(text, query) {
    const q = query.trim();
    if (!q) return escapeHtml(text);
    const safe = escapeHtml(text);
    try {
      const re = new RegExp(`(${escapeRegExp(q)})`, "ig");
      return safe.replace(re, '<mark class="match">$1</mark>');
    } catch {
      return safe;
    }
  }
  async function copyToClipboard(text, button) {
    const prev = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = prev || "Copy";
    }, 1200);
  }
  const THEME_OPTIONS = [
    { id: "light", label: "Light", mode: "light" },
    { id: "dark", label: "Dark", mode: "dark" }
  ];
  const THEME_STORAGE_KEY = "codemem-theme";
  function resolveTheme(themeId) {
    const exact = THEME_OPTIONS.find((t) => t.id === themeId);
    if (exact) return exact;
    const fallback = themeId.startsWith("dark") ? "dark" : "light";
    return THEME_OPTIONS.find((t) => t.id === fallback) || THEME_OPTIONS[0];
  }
  function getTheme() {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) return resolveTheme(saved).id;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function setTheme(theme) {
    const selected = resolveTheme(theme);
    document.documentElement.setAttribute("data-theme", selected.mode);
    document.documentElement.setAttribute("data-color-mode", selected.mode);
    if (selected.id === selected.mode) {
      document.documentElement.removeAttribute("data-theme-variant");
    } else {
      document.documentElement.setAttribute("data-theme-variant", selected.id);
    }
    localStorage.setItem(THEME_STORAGE_KEY, selected.id);
  }
  function initThemeSelect(select) {
    if (!select) return;
    select.textContent = "";
    THEME_OPTIONS.forEach((theme) => {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.label;
      select.appendChild(option);
    });
    select.value = getTheme();
    select.addEventListener("change", () => {
      setTheme(select.value || "dark");
    });
  }
  const TAB_KEY = "codemem-tab";
  const FEED_FILTER_KEY = "codemem-feed-filter";
  const SYNC_DIAGNOSTICS_KEY = "codemem-sync-diagnostics";
  const SYNC_PAIRING_KEY = "codemem-sync-pairing";
  const SYNC_REDACT_KEY = "codemem-sync-redact";
  const FEED_FILTERS = ["all", "observations", "summaries"];
  const state = {
    /* Tab */
    activeTab: "feed",
    /* Project filter */
    currentProject: "",
    /* Refresh */
    refreshState: "idle",
    refreshInFlight: false,
    refreshQueued: false,
    refreshTimer: null,
    /* Feed */
    feedTypeFilter: "all",
    feedQuery: "",
    lastFeedItems: [],
    lastFeedFilteredCount: 0,
    lastFeedSignature: "",
    pendingFeedItems: null,
    /* Feed item view state */
    itemViewState: /* @__PURE__ */ new Map(),
    itemExpandState: /* @__PURE__ */ new Map(),
    newItemKeys: /* @__PURE__ */ new Set(),
    /* Cached payloads */
    lastStatsPayload: null,
    lastUsagePayload: null,
    lastRawEventsPayload: null,
    lastSyncStatus: null,
    lastSyncPeers: [],
    lastSyncAttempts: [],
    pairingPayloadRaw: null,
    pairingCommandRaw: "",
    /* Config */
    configDefaults: {},
    configPath: "",
    settingsDirty: false,
    /* Sync UI toggles */
    syncDiagnosticsOpen: false,
    syncPairingOpen: false
  };
  function getActiveTab() {
    const hash = window.location.hash.replace("#", "");
    if (["feed", "health", "sync"].includes(hash)) return hash;
    const saved = localStorage.getItem(TAB_KEY);
    if (saved && ["feed", "health", "sync"].includes(saved)) return saved;
    return "feed";
  }
  function setActiveTab(tab) {
    state.activeTab = tab;
    window.location.hash = tab;
    localStorage.setItem(TAB_KEY, tab);
  }
  function getFeedTypeFilter() {
    const saved = localStorage.getItem(FEED_FILTER_KEY) || "all";
    return FEED_FILTERS.includes(saved) ? saved : "all";
  }
  function setFeedTypeFilter(value) {
    state.feedTypeFilter = FEED_FILTERS.includes(value) ? value : "all";
    localStorage.setItem(FEED_FILTER_KEY, state.feedTypeFilter);
  }
  function isSyncDiagnosticsOpen() {
    return localStorage.getItem(SYNC_DIAGNOSTICS_KEY) === "1";
  }
  function setSyncPairingOpen(open) {
    state.syncPairingOpen = open;
    try {
      localStorage.setItem(SYNC_PAIRING_KEY, open ? "1" : "0");
    } catch {
    }
  }
  function isSyncRedactionEnabled() {
    return localStorage.getItem(SYNC_REDACT_KEY) !== "0";
  }
  function setSyncRedactionEnabled(enabled) {
    localStorage.setItem(SYNC_REDACT_KEY, enabled ? "1" : "0");
  }
  function initState() {
    state.activeTab = getActiveTab();
    state.feedTypeFilter = getFeedTypeFilter();
    state.syncDiagnosticsOpen = isSyncDiagnosticsOpen();
    try {
      state.syncPairingOpen = localStorage.getItem(SYNC_PAIRING_KEY) === "1";
    } catch {
      state.syncPairingOpen = false;
    }
  }
  async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url}: ${resp.status} ${resp.statusText}`);
    return resp.json();
  }
  async function loadStats() {
    return fetchJson("/api/stats");
  }
  async function loadUsage(project) {
    return fetchJson(`/api/usage?project=${encodeURIComponent(project)}`);
  }
  async function loadSession(project) {
    return fetchJson(`/api/session?project=${encodeURIComponent(project)}`);
  }
  async function loadRawEvents(project) {
    return fetchJson(`/api/raw-events?project=${encodeURIComponent(project)}`);
  }
  function buildProjectParams(project, limit, offset) {
    const params = new URLSearchParams();
    params.set("project", project || "");
    if (typeof limit === "number") params.set("limit", String(limit));
    if (typeof offset === "number") params.set("offset", String(offset));
    return params.toString();
  }
  async function loadMemoriesPage(project, options) {
    const query = buildProjectParams(project, options?.limit, options?.offset);
    return fetchJson(`/api/memories?${query}`);
  }
  async function loadSummariesPage(project, options) {
    const query = buildProjectParams(project, options?.limit, options?.offset);
    return fetchJson(`/api/summaries?${query}`);
  }
  async function loadConfig() {
    return fetchJson("/api/config");
  }
  async function saveConfig(payload) {
    const resp = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const msg = await resp.text();
      throw new Error(msg);
    }
  }
  async function loadSyncStatus(includeDiagnostics) {
    const param = "?includeDiagnostics=1";
    return fetchJson(`/api/sync/status${param}`);
  }
  async function loadPairing() {
    return fetchJson("/api/sync/pairing?includeDiagnostics=1");
  }
  async function loadProjects$1() {
    const payload = await fetchJson("/api/projects");
    return payload.projects || [];
  }
  async function triggerSync(address) {
    const payload = address ? { address } : {};
    await fetch("/api/sync/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
  function formatDate(value) {
    if (!value) return "n/a";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  function formatTimestamp(value) {
    if (!value) return "never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }
  function formatRelativeTime(value) {
    if (!value) return "n/a";
    const date = new Date(value);
    const ms = date.getTime();
    if (Number.isNaN(ms)) return String(value);
    const diff = Date.now() - ms;
    const seconds = Math.round(diff / 1e3);
    if (seconds < 10) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 14) return `${days}d ago`;
    return date.toLocaleDateString();
  }
  function secondsSince(value) {
    if (!value) return null;
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts)) return null;
    const delta = Math.floor((Date.now() - ts) / 1e3);
    return delta >= 0 ? delta : 0;
  }
  function formatAgeShort(seconds) {
    if (seconds === null || seconds === void 0) return "n/a";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }
  function formatPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "n/a";
    return `${Math.round(num * 100)}%`;
  }
  function formatMultiplier(saved, read) {
    const savedNum = Number(saved || 0);
    const readNum = Number(read || 0);
    if (!Number.isFinite(savedNum) || !Number.isFinite(readNum) || readNum <= 0) return "n/a";
    const factor = (savedNum + readNum) / readNum;
    if (!Number.isFinite(factor) || factor <= 0) return "n/a";
    return `${factor.toFixed(factor >= 10 ? 0 : 1)}x`;
  }
  function formatReductionPercent(saved, read) {
    const savedNum = Number(saved || 0);
    const readNum = Number(read || 0);
    if (!Number.isFinite(savedNum) || !Number.isFinite(readNum)) return "n/a";
    const total = savedNum + readNum;
    if (total <= 0) return "n/a";
    const pct = savedNum / total;
    if (!Number.isFinite(pct)) return "n/a";
    return `${Math.round(pct * 100)}%`;
  }
  function parsePercentValue(label) {
    const text = String(label || "").trim();
    if (!text.endsWith("%")) return null;
    const raw = Number(text.replace("%", ""));
    if (!Number.isFinite(raw)) return null;
    return raw;
  }
  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function parseJsonArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
  function titleCase(value) {
    const text = String(value || "").trim();
    if (!text) return "Unknown";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function toTitleLabel(value) {
    return value.replace(/_/g, " ").split(" ").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ").trim();
  }
  function formatFileList(files, limit = 2) {
    if (!files.length) return "";
    const trimmed = files.map((f) => String(f).trim()).filter(Boolean);
    const slice = trimmed.slice(0, limit);
    const suffix = trimmed.length > limit ? ` +${trimmed.length - limit}` : "";
    return `${slice.join(", ")}${suffix}`.trim();
  }
  function formatTagLabel(tag) {
    if (!tag) return "";
    const trimmed = String(tag).trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) return trimmed;
    return trimmed.slice(0, colonIndex).trim();
  }
  function mergeMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") return {};
    const importMeta = metadata.import_metadata;
    if (importMeta && typeof importMeta === "object") {
      return { ...importMeta, ...metadata };
    }
    return metadata;
  }
  function extractFactsFromBody(text) {
    if (!text) return [];
    const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
    const bullets = lines.filter((l) => /^[-*\u2022]\s+/.test(l) || /^\d+\./.test(l));
    if (!bullets.length) return [];
    return bullets.map((l) => l.replace(/^[-*\u2022]\s+/, "").replace(/^\d+\.\s+/, ""));
  }
  function sentenceFacts(text, limit = 6) {
    const raw = String(text || "").trim();
    if (!raw) return [];
    const collapsed = raw.replace(/\s+/g, " ").trim();
    const parts = collapsed.split(new RegExp("(?<=[.!?])\\s+")).map((p) => p.trim()).filter(Boolean);
    const facts = [];
    for (const part of parts) {
      if (part.length < 18) continue;
      facts.push(part);
      if (facts.length >= limit) break;
    }
    return facts;
  }
  function isLowSignalObservation(item) {
    const title = normalize(item.title);
    const body = normalize(item.body_text);
    if (!title && !body) return true;
    const combined = body || title;
    if (combined.length < 10) return true;
    if (title && body && title === body && combined.length < 40) return true;
    const lead = title.charAt(0);
    if ((lead === "└" || lead === "›") && combined.length < 40) return true;
    if (title.startsWith("list ") && combined.length < 20) return true;
    if (combined === "ls" || combined === "list ls") return true;
    return false;
  }
  function itemSignature(item) {
    return String(item.id ?? item.memory_id ?? item.observation_id ?? item.session_id ?? item.created_at_utc ?? item.created_at ?? "");
  }
  function itemKey(item) {
    return `${String(item.kind || "").toLowerCase()}:${itemSignature(item)}`;
  }
  const OBSERVATION_PAGE_SIZE = 20;
  const SUMMARY_PAGE_SIZE = 50;
  const FEED_SCROLL_THRESHOLD_PX = 560;
  let lastFeedProject = "";
  let observationOffset = 0;
  let summaryOffset = 0;
  let observationHasMore = true;
  let summaryHasMore = true;
  let loadMoreInFlight = false;
  let feedScrollHandlerBound = false;
  let feedProjectGeneration = 0;
  function resetPagination(project) {
    lastFeedProject = project;
    feedProjectGeneration += 1;
    observationOffset = 0;
    summaryOffset = 0;
    observationHasMore = true;
    summaryHasMore = true;
  }
  function isNearFeedBottom() {
    const root = document.documentElement;
    const height = Math.max(root.scrollHeight, document.body.scrollHeight);
    return window.innerHeight + window.scrollY >= height - FEED_SCROLL_THRESHOLD_PX;
  }
  function pageHasMore(payload, count, limit) {
    const value = payload?.pagination?.has_more;
    if (typeof value === "boolean") return value;
    return count >= limit;
  }
  function pageNextOffset(payload, count) {
    const value = payload?.pagination?.next_offset;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    return count;
  }
  function hasMorePages() {
    return observationHasMore || summaryHasMore;
  }
  function mergeFeedItems(currentItems, incomingItems) {
    const byKey = /* @__PURE__ */ new Map();
    currentItems.forEach((item) => byKey.set(itemKey(item), item));
    incomingItems.forEach((item) => byKey.set(itemKey(item), item));
    return Array.from(byKey.values()).sort((a, b) => {
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
  }
  function mergeRefreshFeedItems(currentItems, firstPageItems) {
    const firstPageKeys = new Set(firstPageItems.map(itemKey));
    const olderItems = currentItems.filter((item) => !firstPageKeys.has(itemKey(item)));
    return mergeFeedItems(olderItems, firstPageItems);
  }
  function getSummaryObject(item) {
    const preferredKeys = ["request", "outcome", "plan", "completed", "learned", "investigated", "next", "next_steps", "notes"];
    const looksLikeSummary = (v) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      return preferredKeys.some((k) => typeof v[k] === "string" && v[k].trim().length > 0);
    };
    if (item?.summary && typeof item.summary === "object" && !Array.isArray(item.summary)) return item.summary;
    if (item?.summary?.summary && typeof item.summary.summary === "object") return item.summary.summary;
    const metadata = item?.metadata_json;
    if (looksLikeSummary(metadata)) return metadata;
    if (looksLikeSummary(metadata?.summary)) return metadata.summary;
    return null;
  }
  function observationViewData(item) {
    const metadata = mergeMetadata(item?.metadata_json);
    const summary = String(item?.subtitle || item?.body_text || "").trim();
    const narrative = String(item?.narrative || metadata?.narrative || "").trim();
    const normSummary = normalize(summary);
    const normNarrative = normalize(narrative);
    const narrativeDistinct = Boolean(narrative) && normNarrative !== normSummary;
    const explicitFacts = parseJsonArray(item?.facts || metadata?.facts || []);
    const fallbackFacts = explicitFacts.length ? explicitFacts : extractFactsFromBody(summary || narrative);
    const derivedFacts = fallbackFacts.length ? fallbackFacts : sentenceFacts(summary);
    return { summary, narrative, facts: derivedFacts, hasSummary: Boolean(summary), hasFacts: derivedFacts.length > 0, hasNarrative: narrativeDistinct };
  }
  function observationViewModes(data) {
    const modes = [];
    if (data.hasSummary) modes.push({ id: "summary", label: "Summary" });
    if (data.hasFacts) modes.push({ id: "facts", label: "Facts" });
    if (data.hasNarrative) modes.push({ id: "narrative", label: "Narrative" });
    return modes;
  }
  function defaultObservationView(data) {
    if (data.hasSummary) return "summary";
    if (data.hasFacts) return "facts";
    return "narrative";
  }
  function shouldClampBody(mode, data) {
    if (mode === "facts") return false;
    if (mode === "summary") return data.summary.length > 260;
    return data.narrative.length > 320;
  }
  function clampClass(mode) {
    return mode === "summary" ? ["clamp", "clamp-3"] : ["clamp", "clamp-5"];
  }
  function renderSummaryObject(summary) {
    const preferred = ["request", "outcome", "plan", "completed", "learned", "investigated", "next", "next_steps", "notes"];
    const keys = Object.keys(summary);
    const ordered = preferred.filter((k) => keys.includes(k));
    const container = el("div", "feed-body facts");
    let wrote = false;
    ordered.forEach((key) => {
      const content = String(summary[key] || "").trim();
      if (!content) return;
      wrote = true;
      const row = el("div", "summary-section");
      const label = el("div", "summary-section-label", toTitleLabel(key));
      const value = el("div", "summary-section-content");
      try {
        value.innerHTML = globalThis.marked.parse(content);
      } catch {
        value.textContent = content;
      }
      row.append(label, value);
      container.appendChild(row);
    });
    return wrote ? container : null;
  }
  function renderFacts(facts) {
    const trimmed = facts.map((f) => String(f || "").trim()).filter(Boolean);
    if (!trimmed.length) return null;
    const container = el("div", "feed-body");
    const list = document.createElement("ul");
    trimmed.forEach((f) => {
      const li = document.createElement("li");
      li.textContent = f;
      list.appendChild(li);
    });
    container.appendChild(list);
    return container;
  }
  function renderNarrative(narrative) {
    const content = String(narrative || "").trim();
    if (!content) return null;
    const body = el("div", "feed-body");
    try {
      body.innerHTML = globalThis.marked.parse(content);
    } catch {
      body.textContent = content;
    }
    return body;
  }
  function renderObservationBody(data, mode) {
    if (mode === "facts") return renderFacts(data.facts) || el("div", "feed-body");
    if (mode === "narrative") return renderNarrative(data.narrative) || el("div", "feed-body");
    return renderNarrative(data.summary) || el("div", "feed-body");
  }
  function renderViewToggle(modes, active, onSelect) {
    if (modes.length <= 1) return null;
    const toggle = el("div", "feed-toggle");
    modes.forEach((mode) => {
      const btn = el("button", "toggle-button", mode.label);
      btn.dataset.filter = mode.id;
      btn.classList.toggle("active", mode.id === active);
      btn.addEventListener("click", () => onSelect(mode.id));
      toggle.appendChild(btn);
    });
    return toggle;
  }
  function createTagChip(tag) {
    const display = formatTagLabel(tag);
    if (!display) return null;
    const chip = el("span", "tag-chip", display);
    chip.title = String(tag);
    return chip;
  }
  function renderFeedItem(item) {
    const kindValue = String(item.kind || "session_summary").toLowerCase();
    const isSessionSummary = kindValue === "session_summary";
    const metadata = mergeMetadata(item?.metadata_json);
    const card = el("div", `feed-item ${kindValue}`.trim());
    const rowKey = itemKey(item);
    card.dataset.key = rowKey;
    if (state.newItemKeys.has(rowKey)) {
      card.classList.add("new-item");
      setTimeout(() => {
        card.classList.remove("new-item");
        state.newItemKeys.delete(rowKey);
      }, 700);
    }
    const header = el("div", "feed-card-header");
    const titleWrap = el("div", "feed-header");
    const defaultTitle = item.title || "(untitled)";
    const displayTitle = isSessionSummary && metadata?.request ? metadata.request : defaultTitle;
    const title = el("div", "feed-title title");
    title.innerHTML = highlightText(displayTitle, state.feedQuery);
    const kind = el("span", `kind-pill ${kindValue}`.trim(), kindValue.replace(/_/g, " "));
    titleWrap.append(kind, title);
    const rightWrap = el("div", "feed-actions");
    const createdAtRaw = item.created_at || item.created_at_utc;
    const relative = formatRelativeTime(createdAtRaw);
    const age = el("div", "small feed-age", relative);
    age.title = formatDate(createdAtRaw);
    const footerRight = el("div", "feed-footer-right");
    let bodyNode = el("div", "feed-body");
    if (isSessionSummary) {
      const summaryObj = getSummaryObject({ metadata_json: metadata });
      const rendered = summaryObj ? renderSummaryObject(summaryObj) : null;
      bodyNode = rendered || renderNarrative(String(item.body_text || "")) || bodyNode;
    } else {
      const data = observationViewData({ ...item, metadata_json: metadata });
      const modes = observationViewModes(data);
      const defaultView = defaultObservationView(data);
      const key = itemKey(item);
      const stored = state.itemViewState.get(key);
      let activeMode = stored && modes.some((m) => m.id === stored) ? stored : defaultView;
      state.itemViewState.set(key, activeMode);
      bodyNode = renderObservationBody(data, activeMode);
      const setExpandControl = (mode) => {
        footerRight.textContent = "";
        const expandKey2 = `${key}:${mode}`;
        const expanded2 = state.itemExpandState.get(expandKey2) === true;
        const canClamp = shouldClampBody(mode, data);
        if (!canClamp) return;
        const btn = el("button", "feed-expand", expanded2 ? "Collapse" : "Expand");
        btn.addEventListener("click", () => {
          const next = !(state.itemExpandState.get(expandKey2) === true);
          state.itemExpandState.set(expandKey2, next);
          if (next) {
            bodyNode.classList.remove("clamp", "clamp-3", "clamp-5");
            btn.textContent = "Collapse";
          } else {
            bodyNode.classList.add(...clampClass(mode));
            btn.textContent = "Expand";
          }
        });
        footerRight.appendChild(btn);
      };
      const expandKey = `${key}:${activeMode}`;
      const expanded = state.itemExpandState.get(expandKey) === true;
      if (shouldClampBody(activeMode, data) && !expanded) bodyNode.classList.add(...clampClass(activeMode));
      setExpandControl(activeMode);
      const toggle = renderViewToggle(modes, activeMode, (mode) => {
        activeMode = mode;
        state.itemViewState.set(key, mode);
        const nextBody = renderObservationBody(data, mode);
        const nextExpandKey = `${key}:${mode}`;
        const nextExpanded = state.itemExpandState.get(nextExpandKey) === true;
        if (shouldClampBody(mode, data) && !nextExpanded) nextBody.classList.add(...clampClass(mode));
        card.replaceChild(nextBody, bodyNode);
        bodyNode = nextBody;
        setExpandControl(mode);
        if (toggle) {
          toggle.querySelectorAll(".toggle-button").forEach((b) => {
            b.classList.toggle("active", b.dataset.filter === mode);
          });
        }
      });
      if (toggle) rightWrap.appendChild(toggle);
    }
    rightWrap.appendChild(age);
    header.append(titleWrap, rightWrap);
    const meta = el("div", "feed-meta");
    const tags = parseJsonArray(item.tags || []);
    const files = parseJsonArray(item.files || []);
    const project = item.project || "";
    const tagContent = tags.length ? ` · ${tags.map((t) => formatTagLabel(t)).join(", ")}` : "";
    const fileContent = files.length ? ` · ${formatFileList(files)}` : "";
    meta.textContent = `${project ? `Project: ${project}` : "Project: n/a"}${tagContent}${fileContent}`;
    const footer = el("div", "feed-footer");
    const footerLeft = el("div", "feed-footer-left");
    const filesWrap = el("div", "feed-files");
    const tagsWrap = el("div", "feed-tags");
    files.forEach((f) => filesWrap.appendChild(el("span", "feed-file", f)));
    tags.forEach((t) => {
      const chip = createTagChip(t);
      if (chip) tagsWrap.appendChild(chip);
    });
    if (filesWrap.childElementCount) footerLeft.appendChild(filesWrap);
    if (tagsWrap.childElementCount) footerLeft.appendChild(tagsWrap);
    footer.append(footerLeft, footerRight);
    card.append(header, meta, bodyNode, footer);
    return card;
  }
  function filterByType(items) {
    if (state.feedTypeFilter === "observations") return items.filter((i) => String(i.kind || "").toLowerCase() !== "session_summary");
    if (state.feedTypeFilter === "summaries") return items.filter((i) => String(i.kind || "").toLowerCase() === "session_summary");
    return items;
  }
  function filterByQuery(items) {
    const query = normalize(state.feedQuery);
    if (!query) return items;
    return items.filter((item) => {
      const hay = [normalize(item?.title), normalize(item?.body_text), normalize(item?.kind), parseJsonArray(item?.tags || []).map((t) => normalize(t)).join(" "), normalize(item?.project)].join(" ").trim();
      return hay.includes(query);
    });
  }
  function computeSignature(items) {
    const parts = items.map((i) => `${itemSignature(i)}:${i.kind || ""}:${i.created_at_utc || i.created_at || ""}`);
    return `${state.feedTypeFilter}|${state.currentProject}|${parts.join("|")}`;
  }
  function countNewItems(nextItems, currentItems) {
    const seen = new Set(currentItems.map(itemKey));
    return nextItems.filter((i) => !seen.has(itemKey(i))).length;
  }
  async function loadMoreFeedPage() {
    if (loadMoreInFlight || !hasMorePages()) return;
    const requestProject = state.currentProject || "";
    const requestGeneration = feedProjectGeneration;
    const startObservationOffset = observationOffset;
    const startSummaryOffset = summaryOffset;
    loadMoreInFlight = true;
    try {
      const [observations, summaries] = await Promise.all([
        observationHasMore ? loadMemoriesPage(requestProject, {
          limit: OBSERVATION_PAGE_SIZE,
          offset: startObservationOffset
        }) : Promise.resolve({ items: [], pagination: { has_more: false, next_offset: startObservationOffset } }),
        summaryHasMore ? loadSummariesPage(requestProject, {
          limit: SUMMARY_PAGE_SIZE,
          offset: startSummaryOffset
        }) : Promise.resolve({ items: [], pagination: { has_more: false, next_offset: startSummaryOffset } })
      ]);
      if (requestGeneration !== feedProjectGeneration || requestProject !== (state.currentProject || "")) {
        return;
      }
      const summaryItems = summaries.items || [];
      const observationItems = observations.items || [];
      const filtered = observationItems.filter((i) => !isLowSignalObservation(i));
      state.lastFeedFilteredCount += observationItems.length - filtered.length;
      summaryHasMore = pageHasMore(summaries, summaryItems.length, SUMMARY_PAGE_SIZE);
      observationHasMore = pageHasMore(observations, observationItems.length, OBSERVATION_PAGE_SIZE);
      summaryOffset = pageNextOffset(summaries, startSummaryOffset + summaryItems.length);
      observationOffset = pageNextOffset(observations, startObservationOffset + observationItems.length);
      const incoming = [...summaryItems, ...filtered];
      const feedItems = mergeFeedItems(state.lastFeedItems, incoming);
      const newCount = countNewItems(feedItems, state.lastFeedItems);
      if (newCount) {
        const seen = new Set(state.lastFeedItems.map(itemKey));
        feedItems.forEach((item) => {
          if (!seen.has(itemKey(item))) state.newItemKeys.add(itemKey(item));
        });
      }
      state.lastFeedItems = feedItems;
      updateFeedView();
    } finally {
      loadMoreInFlight = false;
    }
  }
  function maybeLoadMoreFeedPage() {
    if (state.activeTab !== "feed") return;
    if (!hasMorePages()) return;
    if (!isNearFeedBottom()) return;
    void loadMoreFeedPage();
  }
  function initFeedTab() {
    const feedTypeToggle = document.getElementById("feedTypeToggle");
    const feedSearch = document.getElementById("feedSearch");
    updateFeedTypeToggle();
    feedTypeToggle?.addEventListener("click", (e) => {
      const target = e.target?.closest?.("button");
      if (!target) return;
      setFeedTypeFilter(target.dataset.filter || "all");
      updateFeedTypeToggle();
      updateFeedView();
    });
    feedSearch?.addEventListener("input", () => {
      state.feedQuery = feedSearch.value || "";
      updateFeedView();
    });
    if (!feedScrollHandlerBound) {
      window.addEventListener("scroll", () => {
        maybeLoadMoreFeedPage();
      }, { passive: true });
      feedScrollHandlerBound = true;
    }
  }
  function updateFeedTypeToggle() {
    const toggle = document.getElementById("feedTypeToggle");
    if (!toggle) return;
    toggle.querySelectorAll(".toggle-button").forEach((btn) => {
      const value = btn.dataset?.filter || "all";
      btn.classList.toggle("active", value === state.feedTypeFilter);
    });
  }
  function updateFeedView() {
    const feedList = document.getElementById("feedList");
    const feedMeta = document.getElementById("feedMeta");
    if (!feedList) return;
    const scrollY = window.scrollY;
    const byType = filterByType(state.lastFeedItems);
    const visible = filterByQuery(byType);
    const filterLabel = state.feedTypeFilter === "observations" ? " · observations" : state.feedTypeFilter === "summaries" ? " · session summaries" : "";
    const sig = computeSignature(visible);
    const changed = sig !== state.lastFeedSignature;
    state.lastFeedSignature = sig;
    if (feedMeta) {
      const filteredLabel = !state.feedQuery.trim() && state.lastFeedFilteredCount ? ` · ${state.lastFeedFilteredCount} observations filtered` : "";
      const queryLabel = state.feedQuery.trim() ? ` · matching "${state.feedQuery.trim()}"` : "";
      const moreLabel = hasMorePages() ? " · scroll for more" : "";
      feedMeta.textContent = `${visible.length} items${filterLabel}${queryLabel}${filteredLabel}${moreLabel}`;
    }
    if (changed) {
      feedList.textContent = "";
      if (!visible.length) {
        feedList.appendChild(el("div", "small", "No memories yet."));
      } else {
        visible.forEach((item) => feedList.appendChild(renderFeedItem(item)));
      }
      if (typeof globalThis.lucide !== "undefined") globalThis.lucide.createIcons();
    }
    window.scrollTo({ top: scrollY });
    maybeLoadMoreFeedPage();
  }
  async function loadFeedData() {
    const project = state.currentProject || "";
    if (project !== lastFeedProject) {
      resetPagination(project);
    }
    const requestGeneration = feedProjectGeneration;
    const observationsLimit = OBSERVATION_PAGE_SIZE;
    const summariesLimit = SUMMARY_PAGE_SIZE;
    const [observations, summaries] = await Promise.all([
      loadMemoriesPage(project, { limit: observationsLimit, offset: 0 }),
      loadSummariesPage(project, { limit: summariesLimit, offset: 0 })
    ]);
    if (requestGeneration !== feedProjectGeneration || project !== (state.currentProject || "")) {
      return;
    }
    const summaryItems = summaries.items || [];
    const observationItems = observations.items || [];
    const filtered = observationItems.filter((i) => !isLowSignalObservation(i));
    const filteredCount = observationItems.length - filtered.length;
    const firstPageFeedItems = [...summaryItems, ...filtered].sort((a, b) => {
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
    const feedItems = mergeRefreshFeedItems(state.lastFeedItems, firstPageFeedItems);
    const newCount = countNewItems(feedItems, state.lastFeedItems);
    if (newCount) {
      const seen = new Set(state.lastFeedItems.map(itemKey));
      feedItems.forEach((item) => {
        if (!seen.has(itemKey(item))) state.newItemKeys.add(itemKey(item));
      });
    }
    state.pendingFeedItems = null;
    state.lastFeedItems = feedItems;
    state.lastFeedFilteredCount = Math.max(state.lastFeedFilteredCount, filteredCount);
    summaryHasMore = pageHasMore(summaries, summaryItems.length, summariesLimit);
    observationHasMore = pageHasMore(observations, observationItems.length, observationsLimit);
    summaryOffset = Math.max(summaryOffset, pageNextOffset(summaries, summaryItems.length));
    observationOffset = Math.max(observationOffset, pageNextOffset(observations, observationItems.length));
    updateFeedView();
  }
  function buildHealthCard({ label, value, detail, icon, className, title }) {
    const card = el("div", `stat${className ? ` ${className}` : ""}`);
    if (title) {
      card.title = title;
      card.style.cursor = "help";
    }
    if (icon) {
      const iconNode = document.createElement("i");
      iconNode.setAttribute("data-lucide", icon);
      iconNode.className = "stat-icon";
      card.appendChild(iconNode);
    }
    const content = el("div", "stat-content");
    content.append(el("div", "value", value), el("div", "label", label));
    if (detail) content.appendChild(el("div", "small", detail));
    card.appendChild(content);
    return card;
  }
  function renderActionList$1(container, actions) {
    if (!container) return;
    container.textContent = "";
    if (!actions.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    actions.slice(0, 3).forEach((item) => {
      const row = el("div", "health-action");
      const textWrap = el("div", "health-action-text");
      textWrap.textContent = item.label;
      if (item.command) textWrap.appendChild(el("span", "health-action-command", item.command));
      const btnWrap = el("div", "health-action-buttons");
      if (item.action) {
        const actionBtn = el("button", "settings-button", item.actionLabel || "Run");
        actionBtn.addEventListener("click", async () => {
          actionBtn.disabled = true;
          actionBtn.textContent = "Running…";
          try {
            await item.action();
          } catch {
          }
          actionBtn.disabled = false;
          actionBtn.textContent = item.actionLabel || "Run";
        });
        btnWrap.appendChild(actionBtn);
      }
      if (item.command) {
        const copyBtn = el("button", "settings-button health-action-copy", "Copy");
        copyBtn.addEventListener("click", () => copyToClipboard(item.command, copyBtn));
        btnWrap.appendChild(copyBtn);
      }
      row.append(textWrap, btnWrap);
      container.appendChild(row);
    });
  }
  function renderHealthOverview() {
    const healthGrid = document.getElementById("healthGrid");
    const healthMeta = document.getElementById("healthMeta");
    const healthActions = document.getElementById("healthActions");
    const healthDot = document.getElementById("healthDot");
    if (!healthGrid || !healthMeta) return;
    healthGrid.textContent = "";
    const stats = state.lastStatsPayload || {};
    const usagePayload = state.lastUsagePayload || {};
    const raw = state.lastRawEventsPayload && typeof state.lastRawEventsPayload === "object" ? state.lastRawEventsPayload : {};
    const syncStatus = state.lastSyncStatus || {};
    const reliability = stats.reliability || {};
    const counts = reliability.counts || {};
    const rates = reliability.rates || {};
    const dbStats = stats.database || {};
    const totals = usagePayload.totals_filtered || usagePayload.totals || usagePayload.totals_global || stats.usage?.totals || {};
    const recentPacks = Array.isArray(usagePayload.recent_packs) ? usagePayload.recent_packs : [];
    const lastPackAt = recentPacks.length ? recentPacks[0]?.created_at : null;
    const latestPackMeta = recentPacks.length ? recentPacks[0]?.metadata_json || {} : {};
    const latestPackDeduped = Number(latestPackMeta?.exact_duplicates_collapsed || 0);
    const latestPackNudges = Number(
      latestPackMeta?.procedure_nudges_applied_count ?? latestPackMeta?.procedure_nudges_count ?? 0
    );
    const rawPending = Number(raw.pending || 0);
    const erroredBatches = Number(counts.errored_batches || 0);
    const flushSuccessRate = Number(rates.flush_success_rate ?? 1);
    const droppedRate = Number(rates.dropped_event_rate || 0);
    const reductionLabel = formatReductionPercent(totals.tokens_saved, totals.tokens_read);
    const reductionPercent = parsePercentValue(reductionLabel);
    const tagCoverage = Number(dbStats.tags_coverage || 0);
    const syncState = String(syncStatus.daemon_state || "unknown");
    const syncStateLabel = syncState === "offline-peers" ? "Offline peers" : titleCase(syncState);
    const peerCount = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers.length : 0;
    const syncDisabled = syncState === "disabled" || syncStatus.enabled === false;
    const syncOfflinePeers = syncState === "offline-peers";
    const syncNoPeers = !syncDisabled && peerCount === 0;
    const syncCardValue = syncDisabled ? "Disabled" : syncNoPeers ? "No peers" : syncStateLabel;
    const lastSyncAt = syncStatus.last_sync_at || syncStatus.last_sync_at_utc || null;
    const syncAgeSeconds = secondsSince(lastSyncAt);
    const packAgeSeconds = secondsSince(lastPackAt);
    const syncLooksStale = syncAgeSeconds !== null && syncAgeSeconds > 7200;
    const hasBacklog = rawPending >= 200;
    let riskScore = 0;
    const drivers = [];
    if (rawPending >= 1e3) {
      riskScore += 40;
      drivers.push("high raw-event backlog");
    } else if (rawPending >= 200) {
      riskScore += 24;
      drivers.push("growing raw-event backlog");
    }
    if (erroredBatches > 0 && rawPending >= 200) {
      riskScore += erroredBatches >= 5 ? 10 : 6;
      drivers.push("batch errors during backlog pressure");
    }
    if (flushSuccessRate < 0.95) {
      riskScore += 20;
      drivers.push("lower flush success");
    }
    if (droppedRate > 0.02) {
      riskScore += 24;
      drivers.push("high dropped-event rate");
    } else if (droppedRate > 5e-3) {
      riskScore += 10;
      drivers.push("non-trivial dropped-event rate");
    }
    if (!syncDisabled && !syncNoPeers) {
      if (syncState === "error") {
        riskScore += 36;
        drivers.push("sync daemon reports errors");
      } else if (syncState === "stopped") {
        riskScore += 22;
        drivers.push("sync daemon stopped");
      } else if (syncState === "degraded") {
        riskScore += 20;
        drivers.push("sync daemon degraded");
      }
      if (syncOfflinePeers) {
        riskScore += 4;
        drivers.push("all peers currently offline");
        if (syncLooksStale) {
          riskScore += 4;
          drivers.push("offline peers and sync not recent");
        }
      } else {
        if (syncLooksStale) {
          riskScore += 26;
          drivers.push("sync looks stale");
        } else if (syncAgeSeconds !== null && syncAgeSeconds > 1800) {
          riskScore += 12;
          drivers.push("sync not recent");
        }
      }
    }
    if (reductionPercent !== null && reductionPercent < 10) {
      riskScore += 8;
      drivers.push("low retrieval reduction");
    }
    if (packAgeSeconds !== null && packAgeSeconds > 86400) {
      riskScore += 12;
      drivers.push("memory pack activity is old");
    }
    let statusLabel = "Healthy";
    let statusClass = "status-healthy";
    if (riskScore >= 60) {
      statusLabel = "Attention";
      statusClass = "status-attention";
    } else if (riskScore >= 25) {
      statusLabel = "Degraded";
      statusClass = "status-degraded";
    }
    if (healthDot) {
      healthDot.className = `health-dot ${statusClass}`;
      healthDot.title = statusLabel;
    }
    const retrievalDetail = `${Number(totals.tokens_saved || 0).toLocaleString()} saved tokens · ${latestPackDeduped.toLocaleString()} deduped · ${latestPackNudges.toLocaleString()} nudges`;
    const pipelineDetail = rawPending > 0 ? "Queue is actively draining" : "Queue is clear";
    const syncDetail = syncDisabled ? "Sync disabled" : syncNoPeers ? "No peers configured" : syncOfflinePeers ? `${peerCount} peers offline · last sync ${formatAgeShort(syncAgeSeconds)} ago` : `${peerCount} peers · last sync ${formatAgeShort(syncAgeSeconds)} ago`;
    const freshnessDetail = `last pack ${formatAgeShort(packAgeSeconds)} ago`;
    const cards = [
      buildHealthCard({ label: "Overall health", value: statusLabel, detail: `Weighted score ${riskScore}`, icon: "heart-pulse", className: `health-primary ${statusClass}`, title: drivers.length ? `Main signals: ${drivers.join(", ")}` : "No major risk signals detected" }),
      buildHealthCard({ label: "Pipeline health", value: `${rawPending.toLocaleString()} pending`, detail: pipelineDetail, icon: "workflow", title: "Raw-event queue pressure and flush reliability" }),
      buildHealthCard({ label: "Retrieval impact", value: reductionLabel, detail: retrievalDetail, icon: "sparkles", title: "Reduction from memory reuse across recent usage" }),
      buildHealthCard({ label: "Sync health", value: syncCardValue, detail: syncDetail, icon: "refresh-cw", title: "Daemon state and sync recency" }),
      buildHealthCard({ label: "Data freshness", value: formatAgeShort(packAgeSeconds), detail: freshnessDetail, icon: "clock-3", title: "Recency of last memory pack activity" })
    ];
    cards.forEach((c) => healthGrid.appendChild(c));
    const triggerSync$1 = () => triggerSync();
    const recommendations = [];
    if (hasBacklog) {
      recommendations.push({ label: "Pipeline needs attention. Check queue health first.", command: "uv run codemem raw-events-status" });
      recommendations.push({ label: "Then retry failed batches for impacted sessions.", command: "uv run codemem raw-events-retry <opencode_session_id>" });
    } else if (syncState === "stopped") {
      recommendations.push({ label: "Sync daemon is stopped. Start the background service.", command: "uv run codemem sync start" });
    } else if (!syncDisabled && !syncNoPeers && (syncState === "error" || syncState === "degraded")) {
      recommendations.push({ label: "Sync is unhealthy. Restart and run one immediate pass.", command: "uv run codemem sync restart", action: triggerSync$1, actionLabel: "Sync now" });
      recommendations.push({ label: "Then run doctor to see root cause details.", command: "uv run codemem sync doctor" });
    } else if (!syncDisabled && !syncNoPeers && syncLooksStale) {
      recommendations.push({ label: "Sync is stale. Run one immediate sync pass.", command: "uv run codemem sync once", action: triggerSync$1, actionLabel: "Sync now" });
    }
    if (tagCoverage > 0 && tagCoverage < 0.7 && recommendations.length < 2) {
      recommendations.push({ label: "Tag coverage is low. Preview backfill impact.", command: "uv run codemem backfill-tags --dry-run" });
    }
    renderActionList$1(healthActions, recommendations);
    healthMeta.textContent = drivers.length ? `Why this status: ${drivers.join(", ")}.` : "Healthy right now. Diagnostics stay available if you want details.";
    if (typeof globalThis.lucide !== "undefined") globalThis.lucide.createIcons();
  }
  function renderStats() {
    const statsGrid = document.getElementById("statsGrid");
    const metaLine = document.getElementById("metaLine");
    if (!statsGrid) return;
    const stats = state.lastStatsPayload || {};
    const usagePayload = state.lastUsagePayload || {};
    const raw = state.lastRawEventsPayload && typeof state.lastRawEventsPayload === "object" ? state.lastRawEventsPayload : {};
    const db = stats.database || {};
    const project = state.currentProject;
    const totalsGlobal = usagePayload?.totals_global || usagePayload?.totals || stats.usage?.totals || {};
    const totalsFiltered = usagePayload?.totals_filtered || null;
    const isFiltered = !!(project && totalsFiltered);
    const usage = isFiltered ? totalsFiltered : totalsGlobal;
    const rawSessions = Number(raw.sessions || 0);
    const rawPending = Number(raw.pending || 0);
    const globalLineWork = isFiltered ? `
Global: ${Number(totalsGlobal.work_investment_tokens || 0).toLocaleString()} invested` : "";
    const globalLineRead = isFiltered ? `
Global: ${Number(totalsGlobal.tokens_read || 0).toLocaleString()} read` : "";
    const globalLineSaved = isFiltered ? `
Global: ${Number(totalsGlobal.tokens_saved || 0).toLocaleString()} saved` : "";
    const items = [
      { label: isFiltered ? "Savings (project)" : "Savings", value: Number(usage.tokens_saved || 0), tooltip: "Tokens saved by reusing compressed memories" + globalLineSaved, icon: "trending-up" },
      { label: isFiltered ? "Injected (project)" : "Injected", value: Number(usage.tokens_read || 0), tooltip: "Tokens injected into context (pack size)" + globalLineRead, icon: "book-open" },
      { label: isFiltered ? "Reduction (project)" : "Reduction", value: formatReductionPercent(usage.tokens_saved, usage.tokens_read), tooltip: `Percent reduction from reuse. Factor: ${formatMultiplier(usage.tokens_saved, usage.tokens_read)}.` + globalLineRead + globalLineSaved, icon: "percent" },
      { label: isFiltered ? "Work investment (project)" : "Work investment", value: Number(usage.work_investment_tokens || 0), tooltip: "Token cost of unique discovery groups" + globalLineWork, icon: "pencil" },
      { label: "Active memories", value: db.active_memory_items || 0, icon: "check-circle" },
      { label: "Embedding coverage", value: formatPercent(db.vector_coverage), tooltip: "Share of active memories with embeddings", icon: "layers" },
      { label: "Tag coverage", value: formatPercent(db.tags_coverage), tooltip: "Share of active memories with tags", icon: "tag" }
    ];
    if (rawPending > 0) items.push({ label: "Raw events pending", value: rawPending, tooltip: "Pending raw events waiting to be flushed", icon: "activity" });
    else if (rawSessions > 0) items.push({ label: "Raw sessions", value: rawSessions, tooltip: "Sessions with pending raw events", icon: "inbox" });
    statsGrid.textContent = "";
    items.forEach((item) => {
      const stat = el("div", "stat");
      if (item.tooltip) {
        stat.title = item.tooltip;
        stat.style.cursor = "help";
      }
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", item.icon);
      icon.className = "stat-icon";
      const content = el("div", "stat-content");
      const displayValue = typeof item.value === "number" ? item.value.toLocaleString() : item.value == null ? "n/a" : String(item.value);
      content.append(el("div", "value", displayValue), el("div", "label", item.label));
      stat.append(icon, content);
      statsGrid.appendChild(stat);
    });
    if (metaLine) {
      const projectSuffix = project ? ` · project: ${project}` : "";
      metaLine.textContent = `DB: ${db.path || "unknown"} · ${Math.round((db.size_bytes || 0) / 1024)} KB${projectSuffix}`;
    }
    if (typeof globalThis.lucide !== "undefined") globalThis.lucide.createIcons();
  }
  function renderSessionSummary() {
    const sessionGrid = document.getElementById("sessionGrid");
    const sessionMeta = document.getElementById("sessionMeta");
    if (!sessionGrid || !sessionMeta) return;
    sessionGrid.textContent = "";
    const usagePayload = state.lastUsagePayload || {};
    const project = state.currentProject;
    usagePayload?.totals_global || usagePayload?.totals || {};
    const totalsFiltered = usagePayload?.totals_filtered || null;
    const isFiltered = !!(project && totalsFiltered);
    const events = Array.isArray(usagePayload?.events) ? usagePayload.events : [];
    const packEvent = events.find((e) => e?.event === "pack") || null;
    const recentPacks = Array.isArray(usagePayload?.recent_packs) ? usagePayload.recent_packs : [];
    const latestPack = recentPacks.length ? recentPacks[0] : null;
    const latestPackMeta = latestPack?.metadata_json || {};
    const lastPackAt = latestPack?.created_at || "";
    const packCount = Number(packEvent?.count || 0);
    const packTokens = Number(latestPack?.tokens_read || 0);
    const savedTokens = Number(latestPack?.tokens_saved || 0);
    const dedupedCount = Number(latestPackMeta?.exact_duplicates_collapsed || 0);
    const dedupeEnabled = !!latestPackMeta?.exact_dedupe_enabled;
    const nudgeCount = Number(
      latestPackMeta?.procedure_nudges_applied_count ?? latestPackMeta?.procedure_nudges_count ?? 0
    );
    const driftDetected = !!latestPackMeta?.procedure_drift_detected;
    const driftLabel = driftDetected ? nudgeCount > 0 ? "Detected" : "Detected (not applied: budget)" : "Clear";
    const reductionPercent = formatReductionPercent(savedTokens, packTokens);
    const packLine = packCount ? `${packCount} packs` : "No packs yet";
    const lastPackLine = lastPackAt ? `Last pack: ${formatTimestamp(lastPackAt)}` : "";
    const scopeLabel = isFiltered ? "Project" : "All projects";
    sessionMeta.textContent = [scopeLabel, packLine, lastPackLine].filter(Boolean).join(" · ");
    const items = [
      { label: "Last pack savings", value: latestPack ? `${savedTokens.toLocaleString()} (${reductionPercent})` : "n/a", icon: "trending-up" },
      { label: "Last pack size", value: latestPack ? packTokens.toLocaleString() : "n/a", icon: "package" },
      { label: "Last pack deduped", value: latestPack ? dedupedCount.toLocaleString() : "n/a", icon: "copy-check" },
      { label: "Exact dedupe", value: latestPack ? dedupeEnabled ? "On" : "Off" : "n/a", icon: "shield-check" },
      { label: "Last pack nudges", value: latestPack ? nudgeCount.toLocaleString() : "n/a", icon: "siren" },
      { label: "Procedure drift", value: latestPack ? driftLabel : "n/a", icon: "shield-alert" },
      { label: "Packs", value: packCount || 0, icon: "archive" }
    ];
    items.forEach((item) => {
      const block = el("div", "stat");
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", item.icon);
      icon.className = "stat-icon";
      const displayValue = typeof item.value === "number" ? item.value.toLocaleString() : item.value == null ? "n/a" : String(item.value);
      const content = el("div", "stat-content");
      content.append(el("div", "value", displayValue), el("div", "label", item.label));
      block.append(icon, content);
      sessionGrid.appendChild(block);
    });
    if (typeof globalThis.lucide !== "undefined") globalThis.lucide.createIcons();
  }
  async function loadHealthData() {
    const [statsPayload, usagePayload, sessionsPayload, rawEventsPayload] = await Promise.all([
      loadStats(),
      loadUsage(state.currentProject),
      loadSession(state.currentProject),
      loadRawEvents(state.currentProject)
    ]);
    state.lastStatsPayload = statsPayload || {};
    state.lastUsagePayload = usagePayload || {};
    state.lastRawEventsPayload = rawEventsPayload || {};
    renderStats();
    renderSessionSummary();
    renderHealthOverview();
  }
  function redactIpOctets(text) {
    return text.replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.#.#");
  }
  function redactAddress(address) {
    const raw = String(address || "");
    if (!raw) return "";
    return redactIpOctets(raw);
  }
  function pickPrimaryAddress(addresses) {
    if (!Array.isArray(addresses)) return "";
    const unique = Array.from(new Set(addresses.filter(Boolean)));
    return typeof unique[0] === "string" ? unique[0] : "";
  }
  function renderActionList(container, actions) {
    if (!container) return;
    container.textContent = "";
    if (!actions.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    actions.slice(0, 2).forEach((item) => {
      const row = el("div", "sync-action");
      const textWrap = el("div", "sync-action-text");
      textWrap.textContent = item.label;
      textWrap.appendChild(el("span", "sync-action-command", item.command));
      const btn = el("button", "settings-button sync-action-copy", "Copy");
      btn.addEventListener("click", () => copyToClipboard(item.command, btn));
      row.append(textWrap, btn);
      container.appendChild(row);
    });
  }
  function renderSyncStatus() {
    const syncStatusGrid = document.getElementById("syncStatusGrid");
    const syncMeta = document.getElementById("syncMeta");
    const syncActions = document.getElementById("syncActions");
    if (!syncStatusGrid) return;
    syncStatusGrid.textContent = "";
    const status = state.lastSyncStatus;
    if (!status) {
      renderActionList(syncActions, []);
      if (syncMeta) syncMeta.textContent = "Loading sync status…";
      return;
    }
    const peers = status.peers || {};
    const pingPayload = status.ping || {};
    const syncPayload = status.sync || {};
    const lastSync = status.last_sync_at || status.last_sync_at_utc || null;
    const lastPing = pingPayload.last_ping_at || status.last_ping_at || null;
    const syncError = status.last_sync_error || "";
    const pingError = status.last_ping_error || "";
    const pending = Number(status.pending || 0);
    const daemonDetail = String(status.daemon_detail || "");
    const daemonState = String(status.daemon_state || "unknown");
    const daemonStateLabel = daemonState === "offline-peers" ? "Offline peers" : titleCase(daemonState);
    const syncDisabled = daemonState === "disabled" || status.enabled === false;
    const peerCount = Object.keys(peers).length;
    const syncNoPeers = !syncDisabled && peerCount === 0;
    if (syncMeta) {
      const parts = syncDisabled ? ["State: Disabled", "Sync is optional and currently off"] : syncNoPeers ? ["State: No peers", "Add peers to enable replication"] : [
        `State: ${daemonStateLabel}`,
        `Peers: ${peerCount}`,
        lastSync ? `Last sync: ${formatAgeShort(secondsSince(lastSync))} ago` : "Last sync: never"
      ];
      if (daemonState === "offline-peers") parts.push("All peers are currently offline; sync will resume automatically");
      if (daemonDetail && daemonState === "stopped") parts.push(`Detail: ${daemonDetail}`);
      syncMeta.textContent = parts.join(" · ");
    }
    const diagItems = syncDisabled ? [{ label: "State", value: "Disabled" }, { label: "Mode", value: "Optional" }, { label: "Pending events", value: pending }, { label: "Last sync", value: "n/a" }] : syncNoPeers ? [{ label: "State", value: "No peers" }, { label: "Mode", value: "Idle" }, { label: "Pending events", value: pending }, { label: "Last sync", value: "n/a" }] : [
      { label: "State", value: daemonStateLabel },
      { label: "Pending events", value: pending },
      { label: "Last sync", value: lastSync ? `${formatAgeShort(secondsSince(lastSync))} ago` : "never" },
      { label: "Last ping", value: lastPing ? `${formatAgeShort(secondsSince(lastPing))} ago` : "never" }
    ];
    diagItems.forEach((item) => {
      const block = el("div", "stat");
      const content = el("div", "stat-content");
      content.append(el("div", "value", item.value), el("div", "label", item.label));
      block.appendChild(content);
      syncStatusGrid.appendChild(block);
    });
    if (!syncDisabled && !syncNoPeers && (syncError || pingError)) {
      const block = el("div", "stat");
      const content = el("div", "stat-content");
      content.append(el("div", "value", "Errors"), el("div", "label", [syncError, pingError].filter(Boolean).join(" · ")));
      block.appendChild(content);
      syncStatusGrid.appendChild(block);
    }
    if (!syncDisabled && !syncNoPeers && syncPayload?.seconds_since_last) {
      const block = el("div", "stat");
      const content = el("div", "stat-content");
      content.append(el("div", "value", `${syncPayload.seconds_since_last}s`), el("div", "label", "Since last sync"));
      block.appendChild(content);
      syncStatusGrid.appendChild(block);
    }
    if (!syncDisabled && !syncNoPeers && pingPayload?.seconds_since_last) {
      const block = el("div", "stat");
      const content = el("div", "stat-content");
      content.append(el("div", "value", `${pingPayload.seconds_since_last}s`), el("div", "label", "Since last ping"));
      block.appendChild(content);
      syncStatusGrid.appendChild(block);
    }
    const actions = [];
    if (syncNoPeers) ;
    else if (daemonState === "offline-peers") ;
    else if (daemonState === "stopped") {
      actions.push({ label: "Sync daemon is stopped. Start it.", command: "uv run codemem sync start" });
      actions.push({ label: "Then run one immediate sync pass.", command: "uv run codemem sync once" });
    } else if (syncError || pingError || daemonState === "error") {
      actions.push({ label: "Sync reports errors. Restart now.", command: "uv run codemem sync restart && uv run codemem sync once" });
      actions.push({ label: "Then run doctor for root cause.", command: "uv run codemem sync doctor" });
    } else if (!syncDisabled && !syncNoPeers && pending > 0) {
      actions.push({ label: "Pending sync work detected. Run one pass now.", command: "uv run codemem sync once" });
    }
    renderActionList(syncActions, actions);
  }
  function renderSyncPeers() {
    const syncPeers = document.getElementById("syncPeers");
    if (!syncPeers) return;
    syncPeers.textContent = "";
    const peers = state.lastSyncPeers;
    if (!Array.isArray(peers) || !peers.length) return;
    peers.forEach((peer) => {
      const card = el("div", "peer-card");
      const titleRow = el("div", "peer-title");
      const peerId = peer.peer_device_id ? String(peer.peer_device_id) : "";
      const displayName = peer.name || (peerId ? peerId.slice(0, 8) : "unknown");
      const name = el("strong", null, displayName);
      if (peerId) name.title = peerId;
      const peerStatus = peer.status || {};
      const online = peerStatus.sync_status === "ok" || peerStatus.ping_status === "ok";
      const badge = el("span", "badge", online ? "Online" : "Offline");
      badge.style.background = online ? "rgba(31, 111, 92, 0.12)" : "rgba(230, 126, 77, 0.15)";
      badge.style.color = online ? "var(--accent)" : "var(--accent-warm)";
      name.append(" ", badge);
      const actions = el("div", "peer-actions");
      const primaryAddress = pickPrimaryAddress(peer.addresses);
      const syncBtn = el("button", null, "Sync now");
      syncBtn.disabled = !primaryAddress;
      syncBtn.addEventListener("click", async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = "Syncing...";
        try {
          await triggerSync(primaryAddress);
        } catch {
        }
        syncBtn.disabled = false;
        syncBtn.textContent = "Sync now";
      });
      actions.appendChild(syncBtn);
      const peerAddresses = Array.isArray(peer.addresses) ? Array.from(new Set(peer.addresses.filter(Boolean))) : [];
      const addressLine = peerAddresses.length ? peerAddresses.map((a) => isSyncRedactionEnabled() ? redactAddress(a) : a).join(" · ") : "No addresses";
      const addressLabel = el("div", "peer-addresses", addressLine);
      const lastSyncAt = peerStatus.last_sync_at || peerStatus.last_sync_at_utc || "";
      const lastPingAt = peerStatus.last_ping_at || peerStatus.last_ping_at_utc || "";
      const meta = el("div", "peer-meta", [
        lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : "Sync: never",
        lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : "Ping: never"
      ].join(" · "));
      titleRow.append(name, actions);
      card.append(titleRow, addressLabel, meta);
      syncPeers.appendChild(card);
    });
  }
  function renderSyncAttempts() {
    const syncAttempts = document.getElementById("syncAttempts");
    if (!syncAttempts) return;
    syncAttempts.textContent = "";
    const attempts = state.lastSyncAttempts;
    if (!Array.isArray(attempts) || !attempts.length) return;
    attempts.forEach((attempt) => {
      const line = el("div", "diag-line");
      const left = el("div", "left");
      left.append(
        el("div", null, attempt.status || "unknown"),
        el("div", "small", isSyncRedactionEnabled() ? redactAddress(attempt.address) : attempt.address || "n/a")
      );
      const right = el("div", "right");
      const time = attempt.started_at || attempt.started_at_utc || "";
      right.textContent = time ? formatTimestamp(time) : "";
      line.append(left, right);
      syncAttempts.appendChild(line);
    });
  }
  function renderPairing() {
    const pairingPayloadEl = document.getElementById("pairingPayload");
    const pairingHint = document.getElementById("pairingHint");
    if (!pairingPayloadEl) return;
    const payload = state.pairingPayloadRaw;
    if (!payload || typeof payload !== "object") {
      pairingPayloadEl.textContent = "Pairing not available";
      if (pairingHint) pairingHint.textContent = "Enable sync and retry.";
      state.pairingCommandRaw = "";
      return;
    }
    if (payload.redacted) {
      pairingPayloadEl.textContent = "Pairing payload hidden";
      if (pairingHint) pairingHint.textContent = "Diagnostics are required to view the pairing payload.";
      state.pairingCommandRaw = "";
      return;
    }
    const safePayload = { ...payload, addresses: Array.isArray(payload.addresses) ? payload.addresses : [] };
    const compact = JSON.stringify(safePayload);
    const b64 = btoa(compact);
    const command = `echo '${b64}' | base64 -d | codemem sync pair --accept-file -`;
    pairingPayloadEl.textContent = command;
    state.pairingCommandRaw = command;
    if (pairingHint) {
      pairingHint.textContent = "Copy this command and run it on the other device. Use --include/--exclude to control which projects sync.";
    }
  }
  async function loadSyncData() {
    try {
      const payload = await loadSyncStatus(true);
      const statusPayload = payload.status && typeof payload.status === "object" ? payload.status : null;
      if (statusPayload) state.lastSyncStatus = statusPayload;
      state.lastSyncPeers = payload.peers || [];
      state.lastSyncAttempts = payload.attempts || [];
      renderSyncStatus();
      renderSyncPeers();
      renderSyncAttempts();
      renderHealthOverview();
    } catch {
      const syncMeta = document.getElementById("syncMeta");
      if (syncMeta) syncMeta.textContent = "Sync unavailable";
    }
  }
  async function loadPairingData() {
    try {
      const payload = await loadPairing();
      state.pairingPayloadRaw = payload || null;
      renderPairing();
    } catch {
      renderPairing();
    }
  }
  function initSyncTab(refreshCallback) {
    const syncPairingToggle = document.getElementById("syncPairingToggle");
    const syncNowButton = document.getElementById("syncNowButton");
    const syncRedact = document.getElementById("syncRedact");
    const pairingCopy = document.getElementById("pairingCopy");
    const syncPairing = document.getElementById("syncPairing");
    if (syncPairing) syncPairing.hidden = !state.syncPairingOpen;
    if (syncPairingToggle) syncPairingToggle.textContent = state.syncPairingOpen ? "Close" : "Pair";
    if (syncRedact) syncRedact.checked = isSyncRedactionEnabled();
    syncPairingToggle?.addEventListener("click", () => {
      const next = !state.syncPairingOpen;
      setSyncPairingOpen(next);
      if (syncPairing) syncPairing.hidden = !next;
      if (syncPairingToggle) syncPairingToggle.textContent = next ? "Close" : "Pair";
      if (next) {
        const pairingPayloadEl = document.getElementById("pairingPayload");
        const pairingHint = document.getElementById("pairingHint");
        if (pairingPayloadEl) pairingPayloadEl.textContent = "Loading…";
        if (pairingHint) pairingHint.textContent = "Fetching pairing payload…";
      }
      refreshCallback();
    });
    syncRedact?.addEventListener("change", () => {
      setSyncRedactionEnabled(Boolean(syncRedact.checked));
      renderSyncStatus();
      renderSyncPeers();
      renderSyncAttempts();
      renderPairing();
    });
    syncNowButton?.addEventListener("click", async () => {
      if (!syncNowButton) return;
      syncNowButton.disabled = true;
      syncNowButton.textContent = "Syncing...";
      try {
        await triggerSync();
      } catch {
      }
      syncNowButton.disabled = false;
      syncNowButton.textContent = "Sync now";
      refreshCallback();
    });
    pairingCopy?.addEventListener("click", async () => {
      const text = state.pairingCommandRaw || document.getElementById("pairingPayload")?.textContent || "";
      if (text && pairingCopy) await copyToClipboard(text, pairingCopy);
    });
  }
  let settingsOpen = false;
  let previouslyFocused = null;
  function getFocusableNodes(container) {
    if (!container) return [];
    const selector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[href]",
      '[tabindex]:not([tabindex="-1"])'
    ].join(",");
    return Array.from(container.querySelectorAll(selector)).filter((node) => {
      const el2 = node;
      return !el2.hidden && el2.offsetParent !== null;
    });
  }
  function trapModalFocus(event) {
    if (!settingsOpen || event.key !== "Tab") return;
    const modal = $("settingsModal");
    const focusable = getFocusableNodes(modal);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (!active || active === first || !modal?.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!active || active === last || !modal?.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }
  function isSettingsOpen() {
    return settingsOpen;
  }
  function renderConfigModal(payload) {
    if (!payload || typeof payload !== "object") return;
    const defaults = payload.defaults || {};
    const config = payload.config || {};
    state.configDefaults = defaults;
    state.configPath = payload.path || "";
    const observerProvider = $select("observerProvider");
    const observerModel = $input("observerModel");
    const observerMaxChars = $input("observerMaxChars");
    const packObservationLimit = $input("packObservationLimit");
    const packSessionLimit = $input("packSessionLimit");
    const syncEnabled = $input("syncEnabled");
    const syncHost = $input("syncHost");
    const syncPort = $input("syncPort");
    const syncInterval = $input("syncInterval");
    const syncMdns = $input("syncMdns");
    const settingsPath = $("settingsPath");
    const observerMaxCharsHint = $("observerMaxCharsHint");
    const settingsEffective = $("settingsEffective");
    if (observerProvider) observerProvider.value = config.observer_provider || "";
    if (observerModel) observerModel.value = config.observer_model || "";
    if (observerMaxChars) observerMaxChars.value = config.observer_max_chars || "";
    if (packObservationLimit) packObservationLimit.value = config.pack_observation_limit || "";
    if (packSessionLimit) packSessionLimit.value = config.pack_session_limit || "";
    if (syncEnabled) syncEnabled.checked = Boolean(config.sync_enabled);
    if (syncHost) syncHost.value = config.sync_host || "";
    if (syncPort) syncPort.value = config.sync_port || "";
    if (syncInterval) syncInterval.value = config.sync_interval_s || "";
    if (syncMdns) syncMdns.checked = Boolean(config.sync_mdns);
    if (settingsPath) settingsPath.textContent = state.configPath ? `Config path: ${state.configPath}` : "Config path: n/a";
    if (observerMaxCharsHint) {
      const def = defaults?.observer_max_chars || "";
      observerMaxCharsHint.textContent = def ? `Default: ${def}` : "";
    }
    if (settingsEffective) {
      settingsEffective.textContent = payload.env_overrides ? "Effective config differs (env overrides active)" : "";
    }
    setDirty(false);
    const settingsStatus = $("settingsStatus");
    if (settingsStatus) settingsStatus.textContent = "Ready";
  }
  function setDirty(dirty) {
    state.settingsDirty = dirty;
    const saveBtn = $button("settingsSave");
    if (saveBtn) saveBtn.disabled = !dirty;
  }
  function openSettings(stopPolling2) {
    settingsOpen = true;
    previouslyFocused = document.activeElement;
    stopPolling2();
    show($("settingsBackdrop"));
    show($("settingsModal"));
    const modal = $("settingsModal");
    const firstFocusable = getFocusableNodes(modal)[0];
    (firstFocusable || modal)?.focus();
  }
  function closeSettings(startPolling2, refreshCallback) {
    if (state.settingsDirty) {
      if (!globalThis.confirm("Discard unsaved changes?")) return;
    }
    settingsOpen = false;
    hide($("settingsBackdrop"));
    hide($("settingsModal"));
    const restoreTarget = previouslyFocused && typeof previouslyFocused.focus === "function" ? previouslyFocused : $button("settingsButton");
    restoreTarget?.focus();
    previouslyFocused = null;
    startPolling2();
    refreshCallback();
  }
  async function saveSettings(startPolling2, refreshCallback) {
    const saveBtn = $button("settingsSave");
    const status = $("settingsStatus");
    if (!saveBtn || !status) return;
    saveBtn.disabled = true;
    status.textContent = "Saving...";
    try {
      await saveConfig({
        observer_provider: $select("observerProvider")?.value || "",
        observer_model: $input("observerModel")?.value || "",
        observer_max_chars: Number($input("observerMaxChars")?.value || 0) || "",
        pack_observation_limit: Number($input("packObservationLimit")?.value || 0) || "",
        pack_session_limit: Number($input("packSessionLimit")?.value || 0) || "",
        sync_enabled: $input("syncEnabled")?.checked || false,
        sync_host: $input("syncHost")?.value || "",
        sync_port: Number($input("syncPort")?.value || 0) || "",
        sync_interval_s: Number($input("syncInterval")?.value || 0) || "",
        sync_mdns: $input("syncMdns")?.checked || false
      });
      status.textContent = "Saved";
      setDirty(false);
      closeSettings(startPolling2, refreshCallback);
    } catch {
      status.textContent = "Save failed";
    } finally {
      saveBtn.disabled = !state.settingsDirty;
    }
  }
  async function loadConfigData() {
    if (settingsOpen) return;
    try {
      const payload = await loadConfig();
      renderConfigModal(payload);
      const overrides = $("settingsOverrides");
      if (overrides) overrides.hidden = !payload?.config?.has_env_overrides;
    } catch {
    }
  }
  function initSettings(stopPolling2, startPolling2, refreshCallback) {
    const settingsButton = $button("settingsButton");
    const settingsClose = $button("settingsClose");
    const settingsBackdrop = $("settingsBackdrop");
    const settingsModal = $("settingsModal");
    const settingsSave = $button("settingsSave");
    settingsButton?.addEventListener("click", () => openSettings(stopPolling2));
    settingsClose?.addEventListener("click", () => closeSettings(startPolling2, refreshCallback));
    settingsBackdrop?.addEventListener("click", () => closeSettings(startPolling2, refreshCallback));
    settingsModal?.addEventListener("click", (e) => {
      if (e.target === settingsModal) closeSettings(startPolling2, refreshCallback);
    });
    settingsSave?.addEventListener("click", () => saveSettings(startPolling2, refreshCallback));
    document.addEventListener("keydown", (e) => {
      trapModalFocus(e);
      if (e.key === "Escape" && settingsOpen) closeSettings(startPolling2, refreshCallback);
    });
    const inputs = ["observerProvider", "observerModel", "observerMaxChars", "packObservationLimit", "packSessionLimit", "syncEnabled", "syncHost", "syncPort", "syncInterval", "syncMdns"];
    inputs.forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener("input", () => setDirty(true));
      input.addEventListener("change", () => setDirty(true));
    });
  }
  let lastAnnouncedRefreshState = null;
  function setRefreshStatus(rs, detail) {
    state.refreshState = rs;
    const el2 = $("refreshStatus");
    if (!el2) return;
    const announce = (msg) => {
      const announcer = $("refreshAnnouncer");
      if (!announcer || lastAnnouncedRefreshState === rs) return;
      announcer.textContent = msg;
      lastAnnouncedRefreshState = rs;
    };
    if (rs === "refreshing") {
      el2.textContent = "refreshing…";
      return;
    }
    if (rs === "paused") {
      el2.textContent = "paused";
      announce("Auto refresh paused.");
      return;
    }
    if (rs === "error") {
      el2.textContent = "refresh failed";
      announce("Refresh failed.");
      return;
    }
    const suffix = detail ? ` ${detail}` : "";
    el2.textContent = "updated " + (/* @__PURE__ */ new Date()).toLocaleTimeString() + suffix;
    lastAnnouncedRefreshState = null;
  }
  function stopPolling() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }
  function startPolling() {
    if (state.refreshTimer) return;
    state.refreshTimer = setInterval(() => refresh(), 5e3);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopPolling();
      setRefreshStatus("paused", "(tab hidden)");
    } else if (!isSettingsOpen()) {
      startPolling();
      refresh();
    }
  });
  const TAB_IDS = ["feed", "health", "sync"];
  function switchTab(tab) {
    setActiveTab(tab);
    TAB_IDS.forEach((id) => {
      const panel = $(`tab-${id}`);
      if (panel) panel.hidden = id !== tab;
    });
    TAB_IDS.forEach((id) => {
      const btn = $(`tabBtn-${id}`);
      if (btn) btn.classList.toggle("active", id === tab);
    });
    refresh();
  }
  function initTabs() {
    TAB_IDS.forEach((id) => {
      const btn = $(`tabBtn-${id}`);
      btn?.addEventListener("click", () => switchTab(id));
    });
    window.addEventListener("hashchange", () => {
      const hash = window.location.hash.replace("#", "");
      if (TAB_IDS.includes(hash) && hash !== state.activeTab) {
        switchTab(hash);
      }
    });
    switchTab(state.activeTab);
  }
  async function loadProjects() {
    try {
      const projects = await loadProjects$1();
      const projectFilter = $select("projectFilter");
      if (!projectFilter) return;
      projectFilter.textContent = "";
      const allOpt = document.createElement("option");
      allOpt.value = "";
      allOpt.textContent = "All Projects";
      projectFilter.appendChild(allOpt);
      projects.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        projectFilter.appendChild(opt);
      });
    } catch {
    }
  }
  $select("projectFilter")?.addEventListener("change", () => {
    state.currentProject = $select("projectFilter")?.value || "";
    refresh();
  });
  async function refresh() {
    if (state.refreshInFlight) {
      state.refreshQueued = true;
      return;
    }
    state.refreshInFlight = true;
    try {
      setRefreshStatus("refreshing");
      const promises = [
        loadHealthData(),
        loadConfigData(),
        loadSyncData()
      ];
      if (state.activeTab === "feed") {
        promises.push(loadFeedData());
      }
      if (state.syncPairingOpen) {
        promises.push(loadPairingData());
      }
      await Promise.all(promises);
      setRefreshStatus("idle");
    } catch {
      setRefreshStatus("error");
    } finally {
      state.refreshInFlight = false;
      if (state.refreshQueued) {
        state.refreshQueued = false;
        refresh();
      }
    }
  }
  initState();
  initThemeSelect($select("themeSelect"));
  setTheme(getTheme());
  initTabs();
  initFeedTab();
  initSyncTab(() => refresh());
  initSettings(stopPolling, startPolling, () => refresh());
  loadProjects();
  refresh();
  startPolling();
})();
