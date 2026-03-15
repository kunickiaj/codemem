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
  const FEED_SCOPE_KEY = "codemem-feed-scope";
  const SYNC_DIAGNOSTICS_KEY = "codemem-sync-diagnostics";
  const SYNC_PAIRING_KEY = "codemem-sync-pairing";
  const SYNC_REDACT_KEY = "codemem-sync-redact";
  const FEED_FILTERS = ["all", "observations", "summaries"];
  const FEED_SCOPES = ["all", "mine", "theirs"];
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
    feedScopeFilter: "all",
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
    lastSyncActors: [],
    lastSyncPeers: [],
    lastSyncSharingReview: [],
    lastSyncCoordinator: null,
    lastSyncJoinRequests: [],
    lastTeamInvite: null,
    lastTeamJoin: null,
    lastSyncAttempts: [],
    lastSyncLegacyDevices: [],
    pairingPayloadRaw: null,
    pairingCommandRaw: "",
    /* Config */
    configDefaults: {},
    configPath: "",
    settingsDirty: false,
    noticeTimer: null,
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
  function getFeedScopeFilter() {
    const saved = localStorage.getItem(FEED_SCOPE_KEY) || "all";
    return FEED_SCOPES.includes(saved) ? saved : "all";
  }
  function setFeedTypeFilter(value) {
    state.feedTypeFilter = FEED_FILTERS.includes(value) ? value : "all";
    localStorage.setItem(FEED_FILTER_KEY, state.feedTypeFilter);
  }
  function setFeedScopeFilter(value) {
    state.feedScopeFilter = FEED_SCOPES.includes(value) ? value : "all";
    localStorage.setItem(FEED_SCOPE_KEY, state.feedScopeFilter);
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
    state.feedScopeFilter = getFeedScopeFilter();
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
  function buildProjectParams(project, limit, offset, scope) {
    const params = new URLSearchParams();
    params.set("project", project || "");
    if (typeof limit === "number") params.set("limit", String(limit));
    if (typeof offset === "number") params.set("offset", String(offset));
    if (scope) params.set("scope", scope);
    return params.toString();
  }
  async function loadMemoriesPage(project, options) {
    const query = buildProjectParams(project, options?.limit, options?.offset, options?.scope);
    return fetchJson(`/api/memories?${query}`);
  }
  async function updateMemoryVisibility(memoryId, visibility) {
    const resp = await fetch("/api/memories/visibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory_id: memoryId, visibility })
    });
    const text = await resp.text();
    const payload = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(payload?.error || text || "request failed");
    return payload;
  }
  async function loadSummariesPage(project, options) {
    const query = buildProjectParams(project, options?.limit, options?.offset, options?.scope);
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
    const text = await resp.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
      }
    }
    if (!resp.ok) {
      const message = parsed && typeof parsed.error === "string" ? parsed.error : text || "request failed";
      throw new Error(message);
    }
    return parsed;
  }
  async function loadSyncStatus(includeDiagnostics, project = "") {
    const params = new URLSearchParams();
    params.set("includeDiagnostics", "1");
    if (project) params.set("project", project);
    const suffix = params.size ? `?${params.toString()}` : "";
    return fetchJson(`/api/sync/status${suffix}`);
  }
  async function createCoordinatorInvite(payload) {
    const resp = await fetch("/api/sync/invites/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(data?.error || text || "request failed");
    return data;
  }
  async function importCoordinatorInvite(invite) {
    const resp = await fetch("/api/sync/invites/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite })
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(data?.error || text || "request failed");
    return data;
  }
  async function reviewJoinRequest(requestId, action) {
    const resp = await fetch("/api/sync/join-requests/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, action })
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(data?.error || text || "request failed");
    return data;
  }
  async function loadSyncActors() {
    return fetchJson("/api/sync/actors");
  }
  async function loadPairing() {
    return fetchJson("/api/sync/pairing?includeDiagnostics=1");
  }
  async function updatePeerScope(peerDeviceId, include, exclude, inheritGlobal = false) {
    const resp = await fetch("/api/sync/peers/scope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_device_id: peerDeviceId,
        include,
        exclude,
        inherit_global: inheritGlobal
      })
    });
    const text = await resp.text();
    const payload = text ? JSON.parse(text) : {};
    if (!resp.ok) {
      throw new Error(payload?.error || text || "request failed");
    }
    return payload;
  }
  async function assignPeerActor(peerDeviceId, actorId) {
    const resp = await fetch("/api/sync/peers/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_device_id: peerDeviceId,
        actor_id: actorId
      })
    });
    const text = await resp.text();
    const payload = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(payload?.error || text || "request failed");
    return payload;
  }
  async function createActor(displayName) {
    const resp = await fetch("/api/sync/actors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName })
    });
    const text = await resp.text();
    const payload = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(payload?.error || text || "request failed");
    return payload;
  }
  async function renameActor(actorId, displayName) {
    const resp = await fetch("/api/sync/actors/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_id: actorId, display_name: displayName })
    });
    const text = await resp.text();
    const payload = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(payload?.error || text || "request failed");
    return payload;
  }
  async function mergeActor(primaryActorId, secondaryActorId) {
    const resp = await fetch("/api/sync/actors/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        primary_actor_id: primaryActorId,
        secondary_actor_id: secondaryActorId
      })
    });
    const text = await resp.text();
    const payload = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(payload?.error || text || "request failed");
    return payload;
  }
  async function claimLegacyDeviceIdentity(originDeviceId) {
    const resp = await fetch("/api/sync/legacy-devices/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin_device_id: originDeviceId })
    });
    const text = await resp.text();
    const payload = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(payload?.error || text || "request failed");
    return payload;
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
  let hideAbort = null;
  function hideGlobalNotice() {
    const notice = $("globalNotice");
    if (!notice) return;
    if (state.noticeTimer) {
      clearTimeout(state.noticeTimer);
      state.noticeTimer = null;
    }
    if (hideAbort) hideAbort.abort();
    hideAbort = new AbortController();
    notice.classList.add("hiding");
    notice.addEventListener(
      "animationend",
      () => {
        hideAbort = null;
        notice.hidden = true;
        notice.textContent = "";
        notice.classList.remove("success", "warning", "hiding");
      },
      { once: true, signal: hideAbort.signal }
    );
  }
  function showGlobalNotice(message, type = "success") {
    const notice = $("globalNotice");
    if (!notice || !message) return;
    if (hideAbort) {
      hideAbort.abort();
      hideAbort = null;
    }
    notice.classList.remove("hiding");
    notice.textContent = message;
    notice.classList.remove("success", "warning");
    notice.classList.add(type === "warning" ? "warning" : "success");
    notice.hidden = false;
    if (state.noticeTimer) clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(() => {
      hideGlobalNotice();
    }, 12e3);
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
  let lastFeedScope = "all";
  function feedScopeLabel(scope) {
    if (scope === "mine") return " · my memories";
    if (scope === "theirs") return " · other actors";
    return "";
  }
  function provenanceChip(label, variant = "") {
    return el("span", `provenance-chip ${variant}`.trim(), label);
  }
  function trustStateLabel(trustState) {
    if (trustState === "legacy_unknown") return "legacy provenance";
    if (trustState === "unreviewed") return "unreviewed";
    return trustState.replace(/_/g, " ");
  }
  function authorLabel(item) {
    if (item?.owned_by_self === true) return "You";
    const actorId = String(item.actor_id || "").trim();
    const actorName = String(item.actor_display_name || "").trim();
    if (actorId && actorId === state.lastStatsPayload?.identity?.actor_id) return "You";
    return actorName || actorId || "Unknown author";
  }
  function resetPagination(project) {
    lastFeedProject = project;
    lastFeedScope = state.feedScopeFilter;
    feedProjectGeneration += 1;
    observationOffset = 0;
    summaryOffset = 0;
    observationHasMore = true;
    summaryHasMore = true;
    state.lastFeedItems = [];
    state.pendingFeedItems = null;
    state.lastFeedFilteredCount = 0;
    state.lastFeedSignature = "";
    state.newItemKeys.clear();
    state.itemViewState.clear();
    state.itemExpandState.clear();
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
  function replaceFeedItem(updatedItem) {
    const key = itemKey(updatedItem);
    state.lastFeedItems = state.lastFeedItems.map((item) => itemKey(item) === key ? updatedItem : item);
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
  function isSafeHref(value) {
    const href = String(value || "").trim();
    if (!href) return false;
    if (href.startsWith("#") || href.startsWith("/")) return true;
    const lower = href.toLowerCase();
    return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:");
  }
  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    const allowedTags = /* @__PURE__ */ new Set(["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "a", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);
    template.content.querySelectorAll("script, iframe, object, embed, link, style").forEach((node) => {
      node.remove();
    });
    template.content.querySelectorAll("*").forEach((node) => {
      const tag = node.tagName.toLowerCase();
      if (!allowedTags.has(tag)) {
        node.replaceWith(document.createTextNode(node.textContent || ""));
        return;
      }
      const allowedAttrs = tag === "a" ? /* @__PURE__ */ new Set(["href", "title"]) : /* @__PURE__ */ new Set();
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        if (!allowedAttrs.has(name)) {
          node.removeAttribute(attr.name);
        }
      }
      if (tag === "a") {
        const href = node.getAttribute("href") || "";
        if (!isSafeHref(href)) {
          node.removeAttribute("href");
        } else {
          node.setAttribute("rel", "noopener noreferrer");
          node.setAttribute("target", "_blank");
        }
      }
    });
    return template.innerHTML;
  }
  function renderMarkdownSafe(value) {
    const source = String(value || "");
    try {
      const rawHtml = globalThis.marked.parse(source);
      return sanitizeHtml(rawHtml);
    } catch {
      const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return escaped;
    }
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
      value.innerHTML = renderMarkdownSafe(content);
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
    body.innerHTML = renderMarkdownSafe(content);
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
    const actor = authorLabel(item);
    const visibility = String(item.visibility || metadata?.visibility || "private").trim();
    const workspaceKind = String(item.workspace_kind || metadata?.workspace_kind || "").trim();
    const originSource = String(item.origin_source || metadata?.origin_source || "").trim();
    const originDeviceId = String(item.origin_device_id || metadata?.origin_device_id || "").trim();
    const trustState = String(item.trust_state || metadata?.trust_state || "").trim();
    const tagContent = tags.length ? ` · ${tags.map((t) => formatTagLabel(t)).join(", ")}` : "";
    const fileContent = files.length ? ` · ${formatFileList(files)}` : "";
    meta.textContent = `${project ? `Project: ${project}` : "Project: n/a"}${tagContent}${fileContent}`;
    const provenance = el("div", "feed-provenance");
    provenance.appendChild(
      provenanceChip(actor, actor === "You" ? "mine" : "author")
    );
    provenance.appendChild(provenanceChip(visibility || "private", visibility || "private"));
    if (workspaceKind && workspaceKind !== visibility) {
      provenance.appendChild(provenanceChip(workspaceKind, "workspace"));
    }
    if (originSource) provenance.appendChild(provenanceChip(originSource, "source"));
    if (originDeviceId && actor !== "You") {
      provenance.appendChild(provenanceChip(originDeviceId, "device"));
    }
    if (trustState && trustState !== "trusted") {
      provenance.appendChild(provenanceChip(trustStateLabel(trustState), "trust"));
    }
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
    const memoryId = Number(item.id || 0);
    if (Boolean(item.owned_by_self) && memoryId > 0) {
      const visibilityControls = el("div", "feed-visibility-controls");
      const visibilitySelect = document.createElement("select");
      visibilitySelect.className = "feed-visibility-select";
      [
        { value: "private", label: "Only me" },
        { value: "shared", label: "Share with peers" }
      ].forEach((optionData) => {
        const option = document.createElement("option");
        option.value = optionData.value;
        option.textContent = optionData.label;
        option.selected = optionData.value === visibility;
        visibilitySelect.appendChild(option);
      });
      visibilitySelect.setAttribute("aria-label", `Visibility for ${String(item.title || "memory")}`);
      const visibilityNote = el(
        "div",
        "feed-visibility-note",
        visibility === "shared" ? "This memory can sync to peers allowed by your project filters." : "This memory stays local unless the peer is assigned to your local actor."
      );
      visibilitySelect.addEventListener("change", () => {
        visibilityNote.textContent = visibilitySelect.value === "shared" ? "This memory can sync to peers allowed by your project filters." : "This memory stays local unless the peer is assigned to your local actor.";
      });
      visibilitySelect.addEventListener("change", async () => {
        const previousVisibility = visibility;
        visibilitySelect.disabled = true;
        try {
          const payload = await updateMemoryVisibility(memoryId, visibilitySelect.value);
          if (payload?.item) {
            replaceFeedItem(payload.item);
            updateFeedView(true);
          }
          showGlobalNotice(visibilitySelect.value === "shared" ? "Memory will now sync as shared context." : "Memory is private again.");
        } catch (error) {
          visibilitySelect.value = previousVisibility;
          visibilityNote.textContent = previousVisibility === "shared" ? "This memory can sync to peers allowed by your project filters." : "This memory stays local unless the peer is assigned to your local actor.";
          showGlobalNotice(error instanceof Error ? error.message : "Failed to save visibility.", "warning");
        } finally {
          visibilitySelect.disabled = false;
        }
      });
      visibilityControls.append(visibilitySelect, visibilityNote);
      footerLeft.appendChild(visibilityControls);
    }
    footer.append(footerLeft, footerRight);
    card.append(header, provenance, meta, bodyNode, footer);
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
    return `${state.feedTypeFilter}|${state.feedScopeFilter}|${state.currentProject}|${normalize(state.feedQuery)}|${parts.join("|")}`;
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
          offset: startObservationOffset,
          scope: state.feedScopeFilter
        }) : Promise.resolve({ items: [], pagination: { has_more: false, next_offset: startObservationOffset } }),
        summaryHasMore ? loadSummariesPage(requestProject, {
          limit: SUMMARY_PAGE_SIZE,
          offset: startSummaryOffset,
          scope: state.feedScopeFilter
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
  function renderProjectSwitchLoadingState() {
    const feedList = document.getElementById("feedList");
    const feedMeta = document.getElementById("feedMeta");
    if (feedList) {
      feedList.textContent = "";
      feedList.appendChild(el("div", "small", "Loading selected project..."));
    }
    if (feedMeta) {
      feedMeta.textContent = "Loading selected project...";
    }
  }
  function initFeedTab() {
    const feedTypeToggle = document.getElementById("feedTypeToggle");
    const feedScopeToggle = document.getElementById("feedScopeToggle");
    const feedSearch = document.getElementById("feedSearch");
    updateFeedTypeToggle();
    updateFeedScopeToggle();
    feedTypeToggle?.addEventListener("click", (e) => {
      const target = e.target?.closest?.("button");
      if (!target) return;
      setFeedTypeFilter(target.dataset.filter || "all");
      updateFeedTypeToggle();
      updateFeedView();
    });
    feedScopeToggle?.addEventListener("click", (e) => {
      const target = e.target?.closest?.("button");
      if (!target) return;
      setFeedScopeFilter(target.dataset.filter || "all");
      updateFeedScopeToggle();
      void loadFeedData();
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
      const active = value === state.feedTypeFilter;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }
  function updateFeedScopeToggle() {
    const toggle = document.getElementById("feedScopeToggle");
    if (!toggle) return;
    toggle.querySelectorAll(".toggle-button").forEach((btn) => {
      const value = btn.dataset?.filter || "all";
      const active = value === state.feedScopeFilter;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }
  function updateFeedView(force = false) {
    const feedList = document.getElementById("feedList");
    const feedMeta = document.getElementById("feedMeta");
    if (!feedList) return;
    const scrollY = window.scrollY;
    const byType = filterByType(state.lastFeedItems);
    const visible = filterByQuery(byType);
    const filterLabel = state.feedTypeFilter === "observations" ? " · observations" : state.feedTypeFilter === "summaries" ? " · session summaries" : "";
    const scopeLabel = feedScopeLabel(state.feedScopeFilter);
    const sig = computeSignature(visible);
    const changed = force || sig !== state.lastFeedSignature;
    state.lastFeedSignature = sig;
    if (feedMeta) {
      const filteredLabel = !state.feedQuery.trim() && state.lastFeedFilteredCount ? ` · ${state.lastFeedFilteredCount} observations filtered` : "";
      const queryLabel = state.feedQuery.trim() ? ` · matching "${state.feedQuery.trim()}"` : "";
      const moreLabel = hasMorePages() ? " · scroll for more" : "";
      feedMeta.textContent = `${visible.length} items${filterLabel}${scopeLabel}${queryLabel}${filteredLabel}${moreLabel}`;
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
    const scopeChanged = state.feedScopeFilter !== lastFeedScope;
    if (project !== lastFeedProject || scopeChanged) {
      resetPagination(project);
      renderProjectSwitchLoadingState();
    }
    const requestGeneration = feedProjectGeneration;
    const observationsLimit = OBSERVATION_PAGE_SIZE;
    const summariesLimit = SUMMARY_PAGE_SIZE;
    const [observations, summaries] = await Promise.all([
      loadMemoriesPage(project, { limit: observationsLimit, offset: 0, scope: state.feedScopeFilter }),
      loadSummariesPage(project, { limit: summariesLimit, offset: 0, scope: state.feedScopeFilter })
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
    lastFeedScope = state.feedScopeFilter;
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
    const retrievalDetail = `${Number(totals.tokens_saved || 0).toLocaleString()} saved tokens · ${latestPackDeduped.toLocaleString()} deduped in latest pack`;
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
    const previousActorId = state.lastStatsPayload?.identity?.actor_id || null;
    const [statsPayload, usagePayload, sessionsPayload, rawEventsPayload] = await Promise.all([
      loadStats(),
      loadUsage(state.currentProject),
      loadSession(state.currentProject),
      loadRawEvents(state.currentProject)
    ]);
    state.lastStatsPayload = statsPayload || {};
    state.lastUsagePayload = usagePayload || {};
    state.lastRawEventsPayload = rawEventsPayload || {};
    const nextActorId = state.lastStatsPayload?.identity?.actor_id || null;
    renderStats();
    renderSessionSummary();
    renderHealthOverview();
    if (state.activeTab === "feed" && previousActorId !== nextActorId) {
      updateFeedView(true);
    }
  }
  function hideSkeleton(id) {
    const skeleton = document.getElementById(id);
    if (skeleton) skeleton.remove();
  }
  let adminSetupExpanded = false;
  function setAdminSetupExpanded(v) {
    adminSetupExpanded = v;
  }
  let teamInvitePanelOpen = false;
  function setTeamInvitePanelOpen(v) {
    teamInvitePanelOpen = v;
  }
  const openPeerScopeEditors = /* @__PURE__ */ new Set();
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
  function parseScopeList(value) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  function actorLabel(actor) {
    if (!actor || typeof actor !== "object") return "Unknown actor";
    const displayName = String(actor.display_name || "").trim();
    if (!displayName) return String(actor.actor_id || "Unknown actor");
    return displayName;
  }
  function assignedActorCount(actorId) {
    const peers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
    return peers.filter((peer) => String(peer?.actor_id || "") === actorId).length;
  }
  function assignmentNote(actorId) {
    if (!actorId) return "Unassigned devices keep legacy fallback attribution until you choose an actor.";
    const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
    const actor = actors.find((item) => String(item?.actor_id || "") === actorId);
    if (actor?.is_local) {
      return "Local actor assignment keeps this device in your same-person continuity path, including private sync.";
    }
    return "This actor receives memories from allowed projects by default. Use Only me on a memory when it should stay local.";
  }
  function buildActorOptions(selectedActorId) {
    const options = [];
    const unassigned = document.createElement("option");
    unassigned.value = "";
    unassigned.textContent = "No actor assigned";
    options.push(unassigned);
    const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
    actors.forEach((actor) => {
      const option = document.createElement("option");
      option.value = String(actor.actor_id || "");
      option.textContent = actor.is_local ? `${actorLabel(actor)} (local)` : actorLabel(actor);
      option.selected = option.value === selectedActorId;
      options.push(option);
    });
    if (!selectedActorId) options[0].selected = true;
    return options;
  }
  function mergeTargetActors(actorId) {
    const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
    return actors.filter((actor) => String(actor?.actor_id || "") !== actorId);
  }
  function actorMergeNote(targetActorId, secondaryActorId) {
    const target = mergeTargetActors(secondaryActorId).find(
      (actor) => String(actor?.actor_id || "") === targetActorId
    );
    if (!targetActorId || !target) {
      return "Choose where this duplicate actor should collapse.";
    }
    return `Merge into ${actorLabel(target)}. Assigned devices move now; existing memories keep their current provenance.`;
  }
  function createChipEditor(initialValues, placeholder, emptyLabel) {
    let values = [...initialValues];
    const container = el("div", "peer-scope-editor");
    const chips = el("div", "peer-scope-chips");
    const input = el("input", "peer-scope-input");
    input.placeholder = placeholder;
    const syncChips = () => {
      chips.textContent = "";
      if (!values.length) {
        chips.appendChild(el("span", "peer-scope-chip empty", emptyLabel));
        return;
      }
      values.forEach((value, index) => {
        const chip = el("span", "peer-scope-chip");
        const label = el("span", null, value);
        const remove = el("button", "peer-scope-chip-remove", "x");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${value}`);
        remove.addEventListener("click", () => {
          values = values.filter((_, currentIndex) => currentIndex !== index);
          syncChips();
        });
        chip.append(label, remove);
        chips.appendChild(chip);
      });
    };
    const commitInput = () => {
      const incoming = parseScopeList(input.value);
      if (incoming.length) {
        values = Array.from(/* @__PURE__ */ new Set([...values, ...incoming]));
        input.value = "";
        syncChips();
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        commitInput();
      }
      if (event.key === "Backspace" && !input.value && values.length) {
        values = values.slice(0, -1);
        syncChips();
      }
    });
    input.addEventListener("blur", commitInput);
    syncChips();
    container.append(chips, input);
    return {
      element: container,
      values: () => [...values]
    };
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
  let _renderSyncPeers = () => {
  };
  function setRenderSyncPeers(fn) {
    _renderSyncPeers = fn;
  }
  function renderSyncStatus() {
    const syncStatusGrid = document.getElementById("syncStatusGrid");
    const syncMeta = document.getElementById("syncMeta");
    const syncActions = document.getElementById("syncActions");
    if (!syncStatusGrid) return;
    hideSkeleton("syncDiagSkeleton");
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
      if (daemonState === "offline-peers")
        parts.push("All peers are currently offline; sync will resume automatically");
      if (daemonDetail && daemonState === "stopped") parts.push(`Detail: ${daemonDetail}`);
      syncMeta.textContent = parts.join(" · ");
    }
    const diagItems = syncDisabled ? [
      { label: "State", value: "Disabled" },
      { label: "Mode", value: "Optional" },
      { label: "Pending events", value: pending },
      { label: "Last sync", value: "n/a" }
    ] : syncNoPeers ? [
      { label: "State", value: "No peers" },
      { label: "Mode", value: "Idle" },
      { label: "Pending events", value: pending },
      { label: "Last sync", value: "n/a" }
    ] : [
      { label: "State", value: daemonStateLabel },
      { label: "Pending events", value: pending },
      {
        label: "Last sync",
        value: lastSync ? `${formatAgeShort(secondsSince(lastSync))} ago` : "never"
      },
      {
        label: "Last ping",
        value: lastPing ? `${formatAgeShort(secondsSince(lastPing))} ago` : "never"
      }
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
      content.append(
        el("div", "value", "Errors"),
        el("div", "label", [syncError, pingError].filter(Boolean).join(" · "))
      );
      block.appendChild(content);
      syncStatusGrid.appendChild(block);
    }
    if (!syncDisabled && !syncNoPeers && syncPayload?.seconds_since_last) {
      const block = el("div", "stat");
      const content = el("div", "stat-content");
      content.append(
        el("div", "value", `${syncPayload.seconds_since_last}s`),
        el("div", "label", "Since last sync")
      );
      block.appendChild(content);
      syncStatusGrid.appendChild(block);
    }
    if (!syncDisabled && !syncNoPeers && pingPayload?.seconds_since_last) {
      const block = el("div", "stat");
      const content = el("div", "stat-content");
      content.append(
        el("div", "value", `${pingPayload.seconds_since_last}s`),
        el("div", "label", "Since last ping")
      );
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
      actions.push({
        label: "Sync reports errors. Restart now.",
        command: "uv run codemem sync restart && uv run codemem sync once"
      });
      actions.push({
        label: "Then run doctor for root cause.",
        command: "uv run codemem sync doctor"
      });
    } else if (!syncDisabled && !syncNoPeers && pending > 0) {
      actions.push({
        label: "Pending sync work detected. Run one pass now.",
        command: "uv run codemem sync once"
      });
    }
    renderActionList(syncActions, actions);
  }
  function renderSyncAttempts() {
    const syncAttempts = document.getElementById("syncAttempts");
    if (!syncAttempts) return;
    syncAttempts.textContent = "";
    const attempts = state.lastSyncAttempts;
    if (!Array.isArray(attempts) || !attempts.length) return;
    attempts.slice(0, 5).forEach((attempt) => {
      const line = el("div", "diag-line");
      const left = el("div", "left");
      left.append(
        el("div", null, attempt.status || "unknown"),
        el(
          "div",
          "small",
          isSyncRedactionEnabled() ? redactAddress(attempt.address) : attempt.address || "n/a"
        )
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
      if (pairingHint)
        pairingHint.textContent = "Diagnostics are required to view the pairing payload.";
      state.pairingCommandRaw = "";
      return;
    }
    const safePayload = {
      ...payload,
      addresses: Array.isArray(payload.addresses) ? payload.addresses : []
    };
    const compact = JSON.stringify(safePayload);
    const b64 = btoa(compact);
    const command = `echo '${b64}' | base64 -d | codemem sync pair --accept-file -`;
    pairingPayloadEl.textContent = command;
    state.pairingCommandRaw = command;
    if (pairingHint) {
      pairingHint.textContent = "Copy this command and run it on the other device. Use --include/--exclude to control which projects sync.";
    }
  }
  function initDiagnosticsEvents(refreshCallback) {
    const syncPairingToggle = document.getElementById(
      "syncPairingToggle"
    );
    const syncRedact = document.getElementById("syncRedact");
    const pairingCopy = document.getElementById("pairingCopy");
    const syncPairing = document.getElementById("syncPairing");
    if (syncPairing) syncPairing.hidden = !state.syncPairingOpen;
    if (syncPairingToggle) {
      syncPairingToggle.textContent = state.syncPairingOpen ? "Hide pairing" : "Show pairing";
      syncPairingToggle.setAttribute("aria-expanded", String(state.syncPairingOpen));
    }
    if (syncRedact) syncRedact.checked = isSyncRedactionEnabled();
    syncPairingToggle?.addEventListener("click", () => {
      const next = !state.syncPairingOpen;
      setSyncPairingOpen(next);
      if (syncPairing) syncPairing.hidden = !next;
      if (syncPairingToggle) {
        syncPairingToggle.textContent = next ? "Hide pairing" : "Show pairing";
        syncPairingToggle.setAttribute("aria-expanded", String(next));
      }
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
      _renderSyncPeers();
      renderSyncAttempts();
      renderPairing();
    });
    pairingCopy?.addEventListener("click", async () => {
      const text = state.pairingCommandRaw || document.getElementById("pairingPayload")?.textContent || "";
      if (text && pairingCopy) await copyToClipboard(text, pairingCopy);
    });
  }
  function shakeField(input) {
    input.classList.add("sync-shake");
    input.addEventListener("animationend", () => input.classList.remove("sync-shake"), { once: true });
  }
  function markFieldError(input, message) {
    input.classList.add("sync-field-error");
    const existing = input.parentElement?.querySelector(".sync-field-hint");
    if (existing) existing.remove();
    const hint = document.createElement("div");
    hint.className = "sync-field-hint";
    hint.textContent = message;
    input.insertAdjacentElement("afterend", hint);
    shakeField(input);
    input.addEventListener("input", () => clearFieldError(input), { once: true });
    return false;
  }
  function clearFieldError(input) {
    input.classList.remove("sync-field-error");
    const hint = input.parentElement?.querySelector(".sync-field-hint");
    if (hint) hint.remove();
  }
  function friendlyError(error, fallback) {
    if (error instanceof Error) {
      const msg = error.message;
      if (msg.includes("fetch") || msg.includes("network") || msg.includes("Failed to fetch")) {
        return "Network error — check your connection and try again.";
      }
      return msg;
    }
    return fallback;
  }
  function ensureInvitePanelInAdminSection() {
    const invitePanel = document.getElementById("syncInvitePanel");
    const adminSection = document.getElementById("syncAdminSection");
    if (!invitePanel || !adminSection) return;
    if (invitePanel.parentElement !== adminSection) adminSection.appendChild(invitePanel);
  }
  function ensureJoinPanelInSetupSection() {
    const joinPanel = document.getElementById("syncJoinPanel");
    const joinSection = document.getElementById("syncJoinSection");
    if (!joinPanel || !joinSection) return;
    if (joinPanel.parentElement !== joinSection) joinSection.appendChild(joinPanel);
  }
  function setInviteOutputVisibility() {
    const syncInviteOutput = document.getElementById("syncInviteOutput");
    if (!syncInviteOutput) return;
    const encoded = String(state.lastTeamInvite?.encoded || "").trim();
    syncInviteOutput.value = encoded;
    syncInviteOutput.hidden = !encoded;
  }
  function openFeedSharingReview() {
    setFeedScopeFilter("mine");
    state.feedQuery = "";
    window.location.hash = "feed";
  }
  function renderSyncSharingReview() {
    const panel = document.getElementById("syncSharingReview");
    const meta = document.getElementById("syncSharingReviewMeta");
    const list = document.getElementById("syncSharingReviewList");
    if (!panel || !meta || !list) return;
    list.textContent = "";
    const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
    if (!items.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const scopeLabel = state.currentProject ? `current project (${state.currentProject})` : "all allowed projects";
    meta.textContent = `Teammates receive memories from ${scopeLabel} by default. Use Only me on a memory when it should stay local.`;
    items.forEach((item) => {
      const row = el("div", "actor-row");
      const details = el("div", "actor-details");
      const title = el("div", "actor-title");
      title.append(
        el("strong", null, String(item.peer_name || item.peer_device_id || "Device")),
        el(
          "span",
          "badge actor-badge",
          `actor: ${String(item.actor_display_name || item.actor_id || "unknown")}`
        )
      );
      const note = el(
        "div",
        "peer-meta",
        `${Number(item.shareable_count || 0)} share by default · ${Number(item.private_count || 0)} marked Only me · ${String(item.scope_label || "All allowed projects")}`
      );
      details.append(title, note);
      const actions = el("div", "actor-actions");
      const reviewBtn = el("button", "settings-button", "Review my memories in Feed");
      reviewBtn.addEventListener("click", () => openFeedSharingReview());
      actions.appendChild(reviewBtn);
      row.append(details, actions);
      list.appendChild(row);
    });
  }
  let _loadSyncData$1 = async () => {
  };
  function setLoadSyncData$1(fn) {
    _loadSyncData$1 = fn;
  }
  function renderTeamSync() {
    const meta = document.getElementById("syncTeamMeta");
    const setupPanel = document.getElementById("syncSetupPanel");
    const list = document.getElementById("syncTeamStatus");
    const actions = document.getElementById("syncTeamActions");
    const invitePanel = document.getElementById("syncInvitePanel");
    const toggleAdmin = document.getElementById("syncToggleAdmin");
    const joinPanel = document.getElementById("syncJoinPanel");
    const joinRequests = document.getElementById("syncJoinRequests");
    if (!meta || !setupPanel || !list || !actions) return;
    hideSkeleton("syncTeamSkeleton");
    ensureInvitePanelInAdminSection();
    ensureJoinPanelInSetupSection();
    list.textContent = "";
    actions.textContent = "";
    if (joinRequests) joinRequests.textContent = "";
    setInviteOutputVisibility();
    const coordinator = state.lastSyncCoordinator;
    const configured = Boolean(coordinator && coordinator.configured);
    meta.textContent = configured ? `Connected to ${String(coordinator.coordinator_url || "")} · group: ${(coordinator.groups || []).join(", ") || "none"}` : "Create a team invite or join an existing team to start syncing memories with teammates.";
    if (!configured) {
      setupPanel.hidden = false;
      list.hidden = true;
      actions.hidden = true;
      if (joinRequests) joinRequests.hidden = true;
      if (invitePanel) invitePanel.hidden = !adminSetupExpanded;
      if (toggleAdmin) {
        toggleAdmin.textContent = adminSetupExpanded ? "Hide team setup" : "Set up a new team instead…";
      }
      return;
    }
    setupPanel.hidden = true;
    list.hidden = false;
    actions.hidden = false;
    if (joinRequests) joinRequests.hidden = false;
    const presenceLabel = coordinator.presence_status === "posted" ? "Connected" : coordinator.presence_status === "not_enrolled" ? "Not connected — import an invite or ask your admin to enroll this device" : "Connection error";
    const statusRow = el("div", "sync-team-summary");
    const statusLine = el("div", "sync-team-status-row");
    const statusLabel = el("span", "sync-team-status-label", "Status");
    const statusBadge = el(
      "span",
      `pill ${coordinator.presence_status === "posted" ? "pill-success" : coordinator.presence_status === "not_enrolled" ? "pill-warning" : "pill-error"}`,
      presenceLabel
    );
    const metricParts = [
      `Paired devices: ${Number(coordinator.paired_peer_count || 0)}`,
      `Discovered: ${Number(coordinator.fresh_peer_count || 0)}`
    ];
    if (Number(coordinator.stale_peer_count || 0) > 0) {
      metricParts.push(`Inactive: ${Number(coordinator.stale_peer_count || 0)}`);
    }
    statusLine.append(statusLabel, statusBadge);
    statusRow.append(statusLine, el("div", "sync-team-metrics", metricParts.join(" · ")));
    list.appendChild(statusRow);
    const inviteToggleRow = el("div", "sync-action");
    const inviteToggleText = el("div", "sync-action-text");
    inviteToggleText.textContent = "Generate an invite to add another teammate to this team.";
    const inviteToggleBtn = el(
      "button",
      "settings-button",
      "Invite a teammate"
    );
    inviteToggleBtn.addEventListener("click", () => {
      if (!invitePanel) return;
      setTeamInvitePanelOpen(!teamInvitePanelOpen);
      if (invitePanel.parentElement !== actions) actions.appendChild(invitePanel);
      invitePanel.hidden = !teamInvitePanelOpen;
      inviteToggleBtn.textContent = teamInvitePanelOpen ? "Hide invite form" : "Invite a teammate";
    });
    inviteToggleRow.append(inviteToggleText, inviteToggleBtn);
    actions.appendChild(inviteToggleRow);
    if (invitePanel) {
      if (teamInvitePanelOpen) {
        if (invitePanel.parentElement !== actions) actions.appendChild(invitePanel);
        invitePanel.hidden = false;
        inviteToggleBtn.textContent = "Hide invite form";
      } else {
        invitePanel.hidden = true;
      }
    }
    if (coordinator.presence_status === "not_enrolled") {
      if (joinPanel) {
        if (joinPanel.parentElement !== actions) actions.appendChild(joinPanel);
        joinPanel.hidden = false;
      }
      const row = el("div", "sync-action");
      const textWrap = el("div", "sync-action-text");
      textWrap.textContent = "This device is not connected to the team yet.";
      textWrap.appendChild(
        el(
          "span",
          "sync-action-command",
          "Import a team invite or ask your admin to enroll this device"
        )
      );
      actions.appendChild(row);
      row.appendChild(textWrap);
    }
    if (!Number(coordinator.paired_peer_count || 0) && coordinator.presence_status === "posted") {
      const row = el("div", "sync-action");
      const textWrap = el("div", "sync-action-text");
      textWrap.textContent = "No devices are paired yet.";
      textWrap.appendChild(
        el("span", "sync-action-command", "uv run codemem sync pair --payload-only")
      );
      const btn = el("button", "settings-button sync-action-copy", "Copy");
      btn.addEventListener(
        "click",
        () => copyToClipboard("uv run codemem sync pair --payload-only", btn)
      );
      row.append(textWrap, btn);
      actions.appendChild(row);
    }
    const pending = Array.isArray(state.lastSyncJoinRequests) ? state.lastSyncJoinRequests : [];
    if (joinRequests && pending.length) {
      const title = el(
        "div",
        "peer-meta",
        `${pending.length} pending join request${pending.length === 1 ? "" : "s"}`
      );
      joinRequests.appendChild(title);
      pending.forEach((request) => {
        const row = el("div", "actor-row");
        const details = el("div", "actor-details");
        const name = String(request.display_name || request.device_id || "Pending device");
        details.append(
          el("div", "actor-title", name),
          el("div", "peer-meta", `request: ${String(request.request_id || "")}`)
        );
        const rowActions = el("div", "actor-actions");
        const approveBtn = el("button", "settings-button", "Approve");
        const denyBtn = el("button", "settings-button", "Deny");
        approveBtn.addEventListener("click", async () => {
          approveBtn.disabled = true;
          denyBtn.disabled = true;
          approveBtn.textContent = "Approving…";
          try {
            await reviewJoinRequest(String(request.request_id || ""), "approve");
            showGlobalNotice(`Approved ${name}. They can now sync with the team.`);
            await _loadSyncData$1();
          } catch (error) {
            showGlobalNotice(friendlyError(error, "Failed to approve join request."), "warning");
            approveBtn.textContent = "Retry";
          } finally {
            approveBtn.disabled = false;
            denyBtn.disabled = false;
          }
        });
        denyBtn.addEventListener("click", async () => {
          if (!window.confirm(
            `Deny join request from ${name}? They will need a new invite to try again.`
          ))
            return;
          approveBtn.disabled = true;
          denyBtn.disabled = true;
          denyBtn.textContent = "Denying…";
          try {
            await reviewJoinRequest(String(request.request_id || ""), "deny");
            showGlobalNotice(`Denied join request from ${name}.`);
            await _loadSyncData$1();
          } catch (error) {
            showGlobalNotice(friendlyError(error, "Failed to deny join request."), "warning");
            denyBtn.textContent = "Retry deny";
          } finally {
            approveBtn.disabled = false;
            denyBtn.disabled = false;
          }
        });
        rowActions.append(approveBtn, denyBtn);
        row.append(details, rowActions);
        joinRequests.appendChild(row);
      });
    } else if (joinRequests) {
      joinRequests.hidden = true;
    }
  }
  function initTeamSyncEvents(refreshCallback, loadSyncData2) {
    const syncNowButton = document.getElementById("syncNowButton");
    const syncToggleAdmin = document.getElementById("syncToggleAdmin");
    const syncInvitePanel = document.getElementById("syncInvitePanel");
    const syncCreateInviteButton = document.getElementById(
      "syncCreateInviteButton"
    );
    const syncInviteGroup = document.getElementById("syncInviteGroup");
    const syncInvitePolicy = document.getElementById("syncInvitePolicy");
    const syncInviteTtl = document.getElementById("syncInviteTtl");
    const syncInviteOutput = document.getElementById(
      "syncInviteOutput"
    );
    const syncJoinButton = document.getElementById("syncJoinButton");
    const syncJoinInvite = document.getElementById("syncJoinInvite");
    syncToggleAdmin?.addEventListener("click", () => {
      if (!syncInvitePanel) return;
      setAdminSetupExpanded(!adminSetupExpanded);
      syncInvitePanel.hidden = !adminSetupExpanded;
      syncToggleAdmin.setAttribute("aria-expanded", String(adminSetupExpanded));
      syncToggleAdmin.textContent = adminSetupExpanded ? "Hide team setup" : "Set up a new team instead…";
    });
    syncCreateInviteButton?.addEventListener("click", async () => {
      if (!syncCreateInviteButton || !syncInviteGroup || !syncInvitePolicy || !syncInviteTtl || !syncInviteOutput)
        return;
      const groupName = syncInviteGroup.value.trim();
      const ttlValue = Number(syncInviteTtl.value);
      let valid = true;
      if (!groupName) {
        valid = markFieldError(syncInviteGroup, "Team name is required.");
      } else {
        clearFieldError(syncInviteGroup);
      }
      if (!ttlValue || ttlValue < 1) {
        valid = markFieldError(syncInviteTtl, "Must be at least 1 hour.");
      } else {
        clearFieldError(syncInviteTtl);
      }
      if (!valid) return;
      syncCreateInviteButton.disabled = true;
      syncCreateInviteButton.textContent = "Creating…";
      try {
        const result = await createCoordinatorInvite({
          group_id: groupName,
          policy: syncInvitePolicy.value,
          ttl_hours: ttlValue || 24
        });
        state.lastTeamInvite = result;
        syncInviteOutput.value = String(result.encoded || "");
        syncInviteOutput.hidden = false;
        syncInviteOutput.focus();
        syncInviteOutput.select();
        showGlobalNotice("Invite created. Copy the text above and share it with your teammate.");
      } catch (error) {
        showGlobalNotice(friendlyError(error, "Failed to create invite."), "warning");
      } finally {
        syncCreateInviteButton.disabled = false;
        syncCreateInviteButton.textContent = "Create invite";
      }
    });
    syncJoinButton?.addEventListener("click", async () => {
      if (!syncJoinButton || !syncJoinInvite) return;
      const inviteValue = syncJoinInvite.value.trim();
      if (!inviteValue) {
        markFieldError(syncJoinInvite, "Paste a team invite to join.");
        return;
      }
      clearFieldError(syncJoinInvite);
      syncJoinButton.disabled = true;
      syncJoinButton.textContent = "Joining…";
      try {
        const result = await importCoordinatorInvite(inviteValue);
        state.lastTeamJoin = result;
        showGlobalNotice(
          result.status === "pending" ? "Join request submitted — waiting for admin approval." : "Joined team successfully."
        );
        syncJoinInvite.value = "";
        await loadSyncData2();
      } catch (error) {
        showGlobalNotice(friendlyError(error, "Failed to import invite."), "warning");
      } finally {
        syncJoinButton.disabled = false;
        syncJoinButton.textContent = "Join team";
      }
    });
    syncNowButton?.addEventListener("click", async () => {
      if (!syncNowButton) return;
      syncNowButton.disabled = true;
      syncNowButton.textContent = "Syncing…";
      try {
        await triggerSync();
        showGlobalNotice("Sync pass started.");
      } catch (error) {
        showGlobalNotice(friendlyError(error, "Failed to start sync."), "warning");
      }
      syncNowButton.disabled = false;
      syncNowButton.textContent = "Sync now";
      refreshCallback();
    });
  }
  let _loadSyncData = async () => {
  };
  function setLoadSyncData(fn) {
    _loadSyncData = fn;
  }
  function renderSyncActors() {
    const actorList = document.getElementById("syncActorsList");
    const actorMeta = document.getElementById("syncActorsMeta");
    if (!actorList) return;
    hideSkeleton("syncActorsSkeleton");
    actorList.textContent = "";
    const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
    if (actorMeta) {
      actorMeta.textContent = actors.length ? "Create, rename, and merge actors here. Assign each device below. Non-local actors receive memories from allowed projects unless you mark them Only me." : "No named actors yet. Create one here, then assign devices below.";
    }
    if (!actors.length) {
      actorList.appendChild(
        el("div", "sync-empty-state", "No actors yet. Create one to represent yourself or a teammate.")
      );
      return;
    }
    actors.forEach((actor) => {
      const row = el("div", "actor-row");
      const details = el("div", "actor-details");
      const title = el("div", "actor-title");
      const name = el("strong", null, actorLabel(actor));
      const count = assignedActorCount(String(actor.actor_id || ""));
      const badge = el(
        "span",
        `badge actor-badge${actor.is_local ? " local" : ""}`,
        actor.is_local ? "Local" : `${count} device${count === 1 ? "" : "s"}`
      );
      title.append(name, badge);
      const note = el(
        "div",
        "peer-meta",
        actor.is_local ? "Used for this device and same-person devices." : `${count} assigned device${count === 1 ? "" : "s"}`
      );
      details.append(title, note);
      const actions = el("div", "actor-actions");
      if (actor.is_local) {
        actions.appendChild(el("div", "peer-meta", "Rename in config"));
      } else {
        const actorId = String(actor.actor_id || "");
        const input = document.createElement("input");
        input.className = "peer-scope-input actor-name-input";
        input.value = actorLabel(actor);
        input.setAttribute("aria-label", `Rename ${actorLabel(actor)}`);
        const renameBtn = el("button", "settings-button", "Rename");
        renameBtn.addEventListener("click", async () => {
          const nextName = input.value.trim();
          if (!nextName) return;
          renameBtn.disabled = true;
          input.disabled = true;
          renameBtn.textContent = "Saving…";
          try {
            await renameActor(actorId, nextName);
            await _loadSyncData();
          } catch {
            renameBtn.textContent = "Retry rename";
          } finally {
            renameBtn.disabled = false;
            input.disabled = false;
            if (renameBtn.textContent === "Saving…") renameBtn.textContent = "Rename";
          }
        });
        const mergeTargets = mergeTargetActors(actorId);
        const mergeControls = el("div", "actor-merge-controls");
        const mergeSelect = document.createElement("select");
        mergeSelect.className = "sync-actor-select actor-merge-select";
        mergeSelect.setAttribute("aria-label", `Merge ${actorLabel(actor)} into another actor`);
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Merge into actor";
        placeholder.selected = true;
        mergeSelect.appendChild(placeholder);
        mergeTargets.forEach((target) => {
          const option = document.createElement("option");
          option.value = String(target.actor_id || "");
          option.textContent = target.is_local ? `${actorLabel(target)} (local)` : actorLabel(target);
          mergeSelect.appendChild(option);
        });
        const mergeBtn = el(
          "button",
          "settings-button",
          "Merge into selected actor"
        );
        mergeBtn.disabled = mergeTargets.length === 0;
        const mergeNote = el(
          "div",
          "peer-meta actor-merge-note",
          mergeTargets.length ? actorMergeNote("", actorId) : "No merge targets yet. Create another actor or use the local actor."
        );
        mergeSelect.addEventListener("change", () => {
          mergeNote.textContent = actorMergeNote(mergeSelect.value, actorId);
        });
        mergeBtn.addEventListener("click", async () => {
          if (!mergeSelect.value) return;
          const target = mergeTargets.find(
            (candidate) => String(candidate.actor_id || "") === mergeSelect.value
          );
          if (!window.confirm(
            `Merge ${actorLabel(actor)} into ${actorLabel(target)}? Assigned devices move now, but older memories keep their current stamped provenance for now.`
          )) {
            return;
          }
          mergeBtn.disabled = true;
          mergeSelect.disabled = true;
          input.disabled = true;
          renameBtn.disabled = true;
          mergeBtn.textContent = "Merging…";
          try {
            await mergeActor(mergeSelect.value, actorId);
            showGlobalNotice("Actor merged. Assigned devices moved to the selected actor.");
            await _loadSyncData();
          } catch (error) {
            showGlobalNotice(friendlyError(error, "Failed to merge actor."), "warning");
            mergeBtn.textContent = "Retry merge";
          } finally {
            mergeBtn.disabled = mergeTargets.length === 0;
            mergeSelect.disabled = false;
            input.disabled = false;
            renameBtn.disabled = false;
            if (mergeBtn.textContent === "Merging…")
              mergeBtn.textContent = "Merge into selected actor";
          }
        });
        mergeControls.append(mergeSelect, mergeBtn);
        actions.append(input, renameBtn, mergeControls, mergeNote);
      }
      row.append(details, actions);
      actorList.appendChild(row);
    });
  }
  function renderSyncPeers() {
    const syncPeers = document.getElementById("syncPeers");
    if (!syncPeers) return;
    hideSkeleton("syncPeersSkeleton");
    syncPeers.textContent = "";
    const peers = state.lastSyncPeers;
    if (!Array.isArray(peers) || !peers.length) {
      syncPeers.appendChild(
        el(
          "div",
          "sync-empty-state",
          "No devices paired yet. Use the pairing command in Diagnostics to connect another device."
        )
      );
      return;
    }
    peers.forEach((peer) => {
      const card = el("div", "peer-card");
      const titleRow = el("div", "peer-title");
      const peerId = peer.peer_device_id ? String(peer.peer_device_id) : "";
      const displayName = peer.name || (peerId ? peerId.slice(0, 8) : "unknown");
      const name = el("strong", null, displayName);
      if (peerId) name.title = peerId;
      const peerStatus = peer.status || {};
      const online = peerStatus.sync_status === "ok" || peerStatus.ping_status === "ok";
      const badge = el("span", `badge ${online ? "badge-online" : "badge-offline"}`, online ? "Online" : "Offline");
      name.append(" ", badge);
      const actions = el("div", "peer-actions");
      const primaryAddress = pickPrimaryAddress(peer.addresses);
      const syncBtn = el("button", null, "Sync now");
      syncBtn.disabled = !primaryAddress;
      syncBtn.addEventListener("click", async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = "Syncing…";
        try {
          await triggerSync(primaryAddress);
        } catch {
        }
        syncBtn.disabled = false;
        syncBtn.textContent = "Sync now";
      });
      actions.appendChild(syncBtn);
      const toggleScopeBtn = el("button", null, "Edit scope");
      actions.appendChild(toggleScopeBtn);
      const peerAddresses = Array.isArray(peer.addresses) ? Array.from(new Set(peer.addresses.filter(Boolean))) : [];
      const addressLine = peerAddresses.length ? peerAddresses.map((a) => isSyncRedactionEnabled() ? redactAddress(a) : a).join(" · ") : "No addresses";
      const addressLabel = el("div", "peer-addresses", addressLine);
      const lastSyncAt = peerStatus.last_sync_at || peerStatus.last_sync_at_utc || "";
      const lastPingAt = peerStatus.last_ping_at || peerStatus.last_ping_at_utc || "";
      const meta = el(
        "div",
        "peer-meta",
        [
          lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : "Sync: never",
          lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : "Ping: never"
        ].join(" · ")
      );
      const identityMeta = el(
        "div",
        "peer-meta",
        peer.actor_display_name ? `Assigned to ${String(peer.actor_display_name)}${peer.claimed_local_actor ? " · local actor" : ""}` : "Unassigned actor"
      );
      const scope = peer.project_scope || {};
      const includeList = Array.isArray(scope.include) ? scope.include : [];
      const excludeList = Array.isArray(scope.exclude) ? scope.exclude : [];
      const effectiveInclude = Array.isArray(scope.effective_include) ? scope.effective_include : [];
      const effectiveExclude = Array.isArray(scope.effective_exclude) ? scope.effective_exclude : [];
      const inheritsGlobal = Boolean(scope.inherits_global);
      const scopePanel = el("div", "peer-scope");
      const identityRow = el("div", "peer-scope-summary");
      identityRow.textContent = "Assigned actor";
      const actorRow = el("div", "peer-actor-row");
      const actorSelect = document.createElement("select");
      actorSelect.className = "sync-actor-select";
      actorSelect.setAttribute("aria-label", `Assigned actor for ${displayName}`);
      buildActorOptions(String(peer.actor_id || "")).forEach(
        (option) => actorSelect.appendChild(option)
      );
      const applyActorBtn = el("button", "settings-button", "Save actor");
      const actorHint = el(
        "div",
        "peer-scope-effective",
        assignmentNote(String(peer.actor_id || ""))
      );
      actorSelect.addEventListener("change", () => {
        actorHint.textContent = assignmentNote(actorSelect.value);
      });
      applyActorBtn.addEventListener("click", async () => {
        applyActorBtn.disabled = true;
        actorSelect.disabled = true;
        applyActorBtn.textContent = "Applying…";
        try {
          await assignPeerActor(peerId, actorSelect.value || null);
          showGlobalNotice(actorSelect.value ? "Device actor updated." : "Device actor cleared.");
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, "Failed to update device actor."), "warning");
          applyActorBtn.textContent = "Retry";
        } finally {
          actorSelect.disabled = false;
          applyActorBtn.disabled = false;
          if (applyActorBtn.textContent === "Applying…")
            applyActorBtn.textContent = "Save actor";
        }
      });
      actorRow.append(actorSelect, applyActorBtn);
      const scopeSummary = el(
        "div",
        "peer-scope-summary",
        inheritsGlobal ? "Using global sync scope" : `Device override · include: ${includeList.join(", ") || "all"} · exclude: ${excludeList.join(", ") || "none"}`
      );
      const effectiveSummary = el(
        "div",
        "peer-scope-effective",
        `Effective scope · include: ${effectiveInclude.join(", ") || "all"} · exclude: ${effectiveExclude.join(", ") || "none"}`
      );
      const includeEditor = createChipEditor(includeList, "Add included project", "All projects");
      const excludeEditor = createChipEditor(excludeList, "Add excluded project", "No exclusions");
      const scopeEditorOpen = openPeerScopeEditors.has(peerId);
      const editorWrap = el("div", `peer-scope-editor-wrap${scopeEditorOpen ? "" : " collapsed"}`);
      if (!scopeEditorOpen) editorWrap.inert = true;
      const inputRow = el("div", "peer-scope-row");
      inputRow.append(includeEditor.element, excludeEditor.element);
      const scopeActions = el("div", "peer-scope-actions");
      const saveScopeBtn = el("button", "settings-button", "Save scope");
      const inheritBtn = el(
        "button",
        "settings-button",
        "Reset to global scope"
      );
      saveScopeBtn.addEventListener("click", async () => {
        saveScopeBtn.disabled = true;
        saveScopeBtn.textContent = "Saving…";
        try {
          await updatePeerScope(peerId, includeEditor.values(), excludeEditor.values());
          showGlobalNotice("Device sync scope saved.");
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, "Failed to save device scope."), "warning");
          saveScopeBtn.textContent = "Retry save";
        } finally {
          saveScopeBtn.disabled = false;
          if (saveScopeBtn.textContent === "Saving…") saveScopeBtn.textContent = "Save scope";
        }
      });
      inheritBtn.addEventListener("click", async () => {
        inheritBtn.disabled = true;
        inheritBtn.textContent = "Resetting…";
        try {
          await updatePeerScope(peerId, null, null, true);
          showGlobalNotice("Device sync scope reset to global defaults.");
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, "Failed to reset device scope."), "warning");
          inheritBtn.textContent = "Retry reset";
        } finally {
          inheritBtn.disabled = false;
          if (inheritBtn.textContent === "Resetting…")
            inheritBtn.textContent = "Reset to global scope";
        }
      });
      scopeActions.append(saveScopeBtn, inheritBtn);
      editorWrap.append(inputRow, scopeActions);
      toggleScopeBtn.textContent = scopeEditorOpen ? "Hide scope editor" : "Edit scope";
      toggleScopeBtn.setAttribute("aria-expanded", String(scopeEditorOpen));
      toggleScopeBtn.addEventListener("click", () => {
        const isCollapsed = editorWrap.classList.contains("collapsed");
        editorWrap.classList.toggle("collapsed", !isCollapsed);
        editorWrap.inert = !isCollapsed;
        if (!isCollapsed) openPeerScopeEditors.delete(peerId);
        else openPeerScopeEditors.add(peerId);
        toggleScopeBtn.setAttribute("aria-expanded", String(isCollapsed));
        toggleScopeBtn.textContent = isCollapsed ? "Hide scope editor" : "Edit scope";
      });
      scopePanel.append(identityRow, identityMeta, actorRow, actorHint, scopeSummary, effectiveSummary, editorWrap);
      titleRow.append(name, actions);
      card.append(titleRow, addressLabel, meta, scopePanel);
      syncPeers.appendChild(card);
    });
  }
  function renderLegacyDeviceClaims() {
    const panel = document.getElementById("syncLegacyClaims");
    const select = document.getElementById("syncLegacyDeviceSelect");
    const button = document.getElementById("syncLegacyClaimButton");
    const meta = document.getElementById("syncLegacyClaimsMeta");
    if (!panel || !select || !button || !meta) return;
    const devices = Array.isArray(state.lastSyncLegacyDevices) ? state.lastSyncLegacyDevices : [];
    select.textContent = "";
    meta.textContent = "";
    if (!devices.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    devices.forEach((device, index) => {
      const option = document.createElement("option");
      const deviceId = String(device.origin_device_id || "").trim();
      if (!deviceId) return;
      const count = Number(device.memory_count || 0);
      const lastSeen = String(device.last_seen_at || "").trim();
      option.value = deviceId;
      option.textContent = count > 0 ? `${deviceId} (${count} memories)` : deviceId;
      if (index === 0) option.selected = true;
      select.appendChild(option);
      if (!meta.textContent && lastSeen) {
        meta.textContent = `Detected from older synced memories. Latest memory: ${formatTimestamp(lastSeen)}`;
      }
    });
    if (!meta.textContent) {
      meta.textContent = "Detected from older synced memories not yet attached to a current device.";
    }
  }
  function initPeopleEvents(loadSyncData2) {
    const syncActorCreateButton = document.getElementById(
      "syncActorCreateButton"
    );
    const syncActorCreateInput = document.getElementById(
      "syncActorCreateInput"
    );
    const syncLegacyClaimButton = document.getElementById(
      "syncLegacyClaimButton"
    );
    const syncLegacyDeviceSelect = document.getElementById(
      "syncLegacyDeviceSelect"
    );
    syncActorCreateButton?.addEventListener("click", async () => {
      if (!syncActorCreateButton || !syncActorCreateInput) return;
      const displayName = String(syncActorCreateInput.value || "").trim();
      if (!displayName) {
        markFieldError(syncActorCreateInput, "Enter a name for the actor.");
        return;
      }
      clearFieldError(syncActorCreateInput);
      syncActorCreateButton.disabled = true;
      syncActorCreateInput.disabled = true;
      syncActorCreateButton.textContent = "Creating…";
      try {
        await createActor(displayName);
        showGlobalNotice("Actor created.");
        syncActorCreateInput.value = "";
        await loadSyncData2();
      } catch (error) {
        showGlobalNotice(friendlyError(error, "Failed to create actor."), "warning");
        syncActorCreateButton.textContent = "Retry";
        syncActorCreateButton.disabled = false;
        syncActorCreateInput.disabled = false;
        return;
      }
      syncActorCreateButton.textContent = "Create actor";
      syncActorCreateButton.disabled = false;
      syncActorCreateInput.disabled = false;
    });
    syncLegacyClaimButton?.addEventListener("click", async () => {
      const originDeviceId = String(syncLegacyDeviceSelect?.value || "").trim();
      if (!originDeviceId || !syncLegacyClaimButton) return;
      if (!window.confirm(
        `Attach old device history from ${originDeviceId} to your local actor? This updates legacy provenance for that device.`
      ))
        return;
      syncLegacyClaimButton.disabled = true;
      const originalText = syncLegacyClaimButton.textContent || "Attach device history";
      syncLegacyClaimButton.textContent = "Attaching…";
      try {
        await claimLegacyDeviceIdentity(originDeviceId);
        showGlobalNotice("Old device history attached to your local actor.");
        await loadSyncData2();
      } catch (error) {
        showGlobalNotice(friendlyError(error, "Failed to attach old device history."), "warning");
        syncLegacyClaimButton.textContent = "Retry";
        syncLegacyClaimButton.disabled = false;
        return;
      }
      syncLegacyClaimButton.textContent = originalText;
      syncLegacyClaimButton.disabled = false;
    });
  }
  let lastSyncHash = "";
  async function loadSyncData() {
    try {
      const payload = await loadSyncStatus(true, state.currentProject || "");
      let actorsPayload = null;
      let actorLoadError = false;
      try {
        actorsPayload = await loadSyncActors();
      } catch {
        actorLoadError = true;
      }
      const hash = JSON.stringify([payload, actorsPayload]);
      if (hash === lastSyncHash) return;
      lastSyncHash = hash;
      const statusPayload = payload.status && typeof payload.status === "object" ? payload.status : null;
      if (statusPayload) state.lastSyncStatus = statusPayload;
      state.lastSyncActors = Array.isArray(actorsPayload?.items) ? actorsPayload.items : [];
      state.lastSyncPeers = payload.peers || [];
      state.lastSyncSharingReview = payload.sharing_review || [];
      state.lastSyncCoordinator = payload.coordinator || null;
      state.lastSyncJoinRequests = payload.join_requests || [];
      state.lastSyncAttempts = payload.attempts || [];
      state.lastSyncLegacyDevices = payload.legacy_devices || [];
      renderSyncStatus();
      renderTeamSync();
      renderSyncActors();
      renderSyncSharingReview();
      renderSyncPeers();
      renderLegacyDeviceClaims();
      renderSyncAttempts();
      renderHealthOverview();
      if (actorLoadError) {
        const actorMeta = document.getElementById("syncActorsMeta");
        if (actorMeta)
          actorMeta.textContent = "Actor controls are temporarily unavailable. Peer status and sync health still loaded.";
      }
    } catch {
      hideSkeleton("syncTeamSkeleton");
      hideSkeleton("syncActorsSkeleton");
      hideSkeleton("syncPeersSkeleton");
      hideSkeleton("syncDiagSkeleton");
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
    setLoadSyncData$1(loadSyncData);
    setLoadSyncData(loadSyncData);
    setRenderSyncPeers(renderSyncPeers);
    initTeamSyncEvents(refreshCallback, loadSyncData);
    initPeopleEvents(loadSyncData);
    initDiagnosticsEvents(refreshCallback);
  }
  let settingsOpen = false;
  let previouslyFocused = null;
  let settingsActiveTab = "observer";
  let settingsBaseline = {};
  let settingsEnvOverrides = {};
  let settingsTouchedKeys = /* @__PURE__ */ new Set();
  let helpTooltipEl = null;
  let helpTooltipAnchor = null;
  let helpTooltipBound = false;
  const SETTINGS_ADVANCED_KEY = "codemem-settings-advanced";
  let settingsShowAdvanced = loadAdvancedPreference();
  const DEFAULT_OPENAI_MODEL = "gpt-5.1-codex-mini";
  const DEFAULT_ANTHROPIC_MODEL = "claude-4.5-haiku";
  const INPUT_TO_CONFIG_KEY = {
    claudeCommand: "claude_command",
    observerProvider: "observer_provider",
    observerModel: "observer_model",
    observerRuntime: "observer_runtime",
    observerAuthSource: "observer_auth_source",
    observerAuthFile: "observer_auth_file",
    observerAuthCommand: "observer_auth_command",
    observerAuthTimeoutMs: "observer_auth_timeout_ms",
    observerAuthCacheTtlS: "observer_auth_cache_ttl_s",
    observerHeaders: "observer_headers",
    observerMaxChars: "observer_max_chars",
    packObservationLimit: "pack_observation_limit",
    packSessionLimit: "pack_session_limit",
    rawEventsSweeperIntervalS: "raw_events_sweeper_interval_s",
    syncEnabled: "sync_enabled",
    syncHost: "sync_host",
    syncPort: "sync_port",
    syncInterval: "sync_interval_s",
    syncMdns: "sync_mdns",
    syncCoordinatorUrl: "sync_coordinator_url",
    syncCoordinatorGroup: "sync_coordinator_group",
    syncCoordinatorTimeout: "sync_coordinator_timeout_s",
    syncCoordinatorPresenceTtl: "sync_coordinator_presence_ttl_s"
  };
  function loadAdvancedPreference() {
    try {
      return globalThis.localStorage?.getItem(SETTINGS_ADVANCED_KEY) === "1";
    } catch {
      return false;
    }
  }
  function persistAdvancedPreference(show2) {
    try {
      globalThis.localStorage?.setItem(SETTINGS_ADVANCED_KEY, show2 ? "1" : "0");
    } catch {
    }
  }
  function hasOwn(obj, key) {
    return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
  }
  function effectiveOrConfigured(config, effective, key) {
    if (hasOwn(effective, key)) return effective[key];
    if (hasOwn(config, key)) return config[key];
    return void 0;
  }
  function asInputString(value) {
    if (value === void 0 || value === null) return "";
    return String(value);
  }
  function toProviderList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === "string" && item.trim().length > 0);
  }
  function isEqualValue(left, right) {
    if (left === right) return true;
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function normalizeTextValue(value) {
    const trimmed = value.trim();
    return trimmed === "" ? "" : trimmed;
  }
  function inferObserverModel(runtime, provider, configuredModel) {
    if (configuredModel) return { model: configuredModel, source: "Configured" };
    if (runtime === "claude_sidecar") {
      return { model: DEFAULT_ANTHROPIC_MODEL, source: "Recommended (local Claude session)" };
    }
    if (provider === "anthropic") {
      return { model: DEFAULT_ANTHROPIC_MODEL, source: "Recommended (Anthropic provider)" };
    }
    if (provider && provider !== "openai") {
      return { model: "provider default", source: "Recommended (provider default)" };
    }
    return { model: DEFAULT_OPENAI_MODEL, source: "Recommended (direct API)" };
  }
  function configuredValueForKey(config, key) {
    switch (key) {
      case "claude_command": {
        const value = config?.claude_command;
        if (!Array.isArray(value)) return [];
        const normalized = [];
        value.forEach((item) => {
          if (typeof item !== "string") return;
          const token = item.trim();
          if (token) normalized.push(token);
        });
        return normalized;
      }
      case "observer_provider":
      case "observer_model":
      case "observer_auth_file":
      case "sync_host":
      case "sync_coordinator_url":
      case "sync_coordinator_group":
        return normalizeTextValue(asInputString(config?.[key]));
      case "observer_runtime":
        return normalizeTextValue(asInputString(config?.observer_runtime));
      case "observer_auth_source":
        return normalizeTextValue(asInputString(config?.observer_auth_source));
      case "observer_auth_command": {
        const value = config?.observer_auth_command;
        if (!Array.isArray(value)) return [];
        return value.filter((item) => typeof item === "string");
      }
      case "observer_headers": {
        const value = config?.observer_headers;
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        const headers = {};
        Object.entries(value).forEach(([header, headerValue]) => {
          if (typeof header === "string" && header.trim() && typeof headerValue === "string") {
            headers[header.trim()] = headerValue;
          }
        });
        return headers;
      }
      case "observer_auth_timeout_ms":
      case "observer_max_chars":
      case "pack_observation_limit":
      case "pack_session_limit":
      case "raw_events_sweeper_interval_s":
      case "sync_port":
      case "sync_interval_s": {
        if (!hasOwn(config, key)) return "";
        const parsed = Number(config[key]);
        return Number.isFinite(parsed) && parsed !== 0 ? parsed : "";
      }
      case "sync_coordinator_timeout_s":
      case "sync_coordinator_presence_ttl_s": {
        if (!hasOwn(config, key)) return "";
        const parsed = Number(config[key]);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : "";
      }
      case "observer_auth_cache_ttl_s": {
        if (!hasOwn(config, key)) return "";
        const parsed = Number(config[key]);
        return Number.isFinite(parsed) ? parsed : "";
      }
      case "sync_enabled":
      case "sync_mdns":
        return Boolean(config?.[key]);
      default:
        return hasOwn(config, key) ? config[key] : "";
    }
  }
  function mergeOverrideBaseline(baseline, config, envOverrides) {
    const next = { ...baseline };
    Object.keys(envOverrides).forEach((key) => {
      if (hasOwn(next, key)) {
        next[key] = configuredValueForKey(config, key);
      }
    });
    return next;
  }
  function renderObserverModelHint() {
    const hint = $("observerModelHint");
    if (!hint) return;
    const runtime = ($select("observerRuntime")?.value || "api_http").trim();
    const provider = ($select("observerProvider")?.value || "").trim();
    const configuredModel = normalizeTextValue($input("observerModel")?.value || "");
    const inferred = inferObserverModel(runtime, provider, configuredModel);
    const overrideActive = ["observer_model", "observer_provider", "observer_runtime"].some(
      (key) => hasOwn(settingsEnvOverrides, key)
    );
    const source = overrideActive ? "Env override" : inferred.source;
    hint.textContent = `${source}: ${inferred.model}`;
  }
  function setAdvancedVisibility(show2) {
    settingsShowAdvanced = show2;
    const toggle = $input("settingsAdvancedToggle");
    if (toggle) {
      toggle.checked = show2;
    }
    document.querySelectorAll(".settings-advanced").forEach((node) => {
      const el2 = node;
      el2.hidden = !show2;
    });
  }
  function ensureHelpTooltipElement() {
    if (helpTooltipEl) return helpTooltipEl;
    const el2 = document.createElement("div");
    el2.className = "help-tooltip";
    el2.hidden = true;
    document.body.appendChild(el2);
    helpTooltipEl = el2;
    return el2;
  }
  function positionHelpTooltip(anchor) {
    const el2 = ensureHelpTooltipElement();
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const width = el2.offsetWidth;
    const height = el2.offsetHeight;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, globalThis.innerWidth - width - margin));
    let top = rect.bottom + gap;
    if (top + height > globalThis.innerHeight - margin) {
      top = rect.top - height - gap;
    }
    top = Math.max(margin, top);
    el2.style.left = `${Math.round(left)}px`;
    el2.style.top = `${Math.round(top)}px`;
  }
  function showHelpTooltip(anchor) {
    const content = anchor.dataset.tooltip?.trim();
    if (!content) return;
    const el2 = ensureHelpTooltipElement();
    helpTooltipAnchor = anchor;
    el2.textContent = content;
    el2.hidden = false;
    requestAnimationFrame(() => {
      positionHelpTooltip(anchor);
      el2.classList.add("visible");
    });
  }
  function hideHelpTooltip() {
    if (!helpTooltipEl) return;
    helpTooltipEl.classList.remove("visible");
    helpTooltipEl.hidden = true;
    helpTooltipAnchor = null;
  }
  function bindHelpTooltips() {
    if (helpTooltipBound) return;
    helpTooltipBound = true;
    document.querySelectorAll(".help-icon[data-tooltip]").forEach((node) => {
      const button = node;
      button.addEventListener("mouseenter", () => showHelpTooltip(button));
      button.addEventListener("mouseleave", () => hideHelpTooltip());
      button.addEventListener("focus", () => showHelpTooltip(button));
      button.addEventListener("blur", () => hideHelpTooltip());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (helpTooltipAnchor === button && helpTooltipEl && !helpTooltipEl.hidden) {
          hideHelpTooltip();
          return;
        }
        showHelpTooltip(button);
      });
    });
    globalThis.addEventListener("resize", () => {
      if (helpTooltipAnchor) {
        positionHelpTooltip(helpTooltipAnchor);
      }
    });
    document.addEventListener("scroll", () => {
      if (helpTooltipAnchor) {
        positionHelpTooltip(helpTooltipAnchor);
      }
    }, true);
  }
  function markFieldTouched(inputId) {
    const key = INPUT_TO_CONFIG_KEY[inputId];
    if (!key) return;
    settingsTouchedKeys.add(key);
  }
  function setProviderOptions(selectEl, providers, currentValue) {
    if (!selectEl) return;
    const values = new Set(providers);
    if (currentValue) values.add(currentValue);
    selectEl.innerHTML = "";
    const autoOption = document.createElement("option");
    autoOption.value = "";
    autoOption.textContent = "auto (default)";
    selectEl.append(autoOption);
    Array.from(values).sort((a, b) => a.localeCompare(b)).forEach((provider) => {
      const option = document.createElement("option");
      option.value = provider;
      option.textContent = provider;
      selectEl.append(option);
    });
    selectEl.value = currentValue;
  }
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
  function formatSettingsKey(key) {
    return String(key || "").replace(/_/g, " ");
  }
  function joinPhrases(values) {
    const items = values.filter((value) => typeof value === "string" && value.trim());
    if (items.length === 0) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }
  function buildSettingsNotice(payload) {
    const effects = payload?.effects && typeof payload.effects === "object" ? payload.effects : {};
    const hotReloaded = Array.isArray(effects.hot_reloaded_keys) ? effects.hot_reloaded_keys.map(formatSettingsKey) : [];
    const liveApplied = Array.isArray(effects.live_applied_keys) ? effects.live_applied_keys.map(formatSettingsKey) : [];
    const restartRequired = Array.isArray(effects.restart_required_keys) ? effects.restart_required_keys.map(formatSettingsKey) : [];
    const warnings = Array.isArray(effects.warnings) ? effects.warnings.filter(
      (value) => typeof value === "string" && value.trim().length > 0
    ) : [];
    const manualActions = Array.isArray(effects.manual_actions) ? effects.manual_actions : [];
    const sync = effects.sync && typeof effects.sync === "object" ? effects.sync : {};
    const lines = [];
    if (hotReloaded.length) {
      lines.push(`Applied now: ${joinPhrases(hotReloaded)}.`);
    }
    if (liveApplied.length) {
      lines.push(`Live settings updated: ${joinPhrases(liveApplied)}.`);
    }
    if (sync.attempted && typeof sync.message === "string" && sync.message) {
      lines.push(`Sync: ${sync.message}.`);
    } else if (Array.isArray(sync.affected_keys) && sync.affected_keys.length && typeof sync.reason === "string" && sync.reason) {
      lines.push(`Sync: ${sync.reason}.`);
    }
    if (restartRequired.length) {
      lines.push(`Manual restart required: ${joinPhrases(restartRequired)}.`);
    }
    warnings.forEach((warning) => {
      lines.push(warning);
    });
    manualActions.forEach((action) => {
      if (action && typeof action.command === "string" && action.command.trim()) {
        lines.push(`If needed: ${action.command}.`);
      }
    });
    if (!lines.length) {
      lines.push("Saved.");
    }
    const hasWarning = restartRequired.length > 0 || warnings.length > 0 || sync.ok === false;
    return { message: lines.join(" "), type: hasWarning ? "warning" : "success" };
  }
  function renderConfigModal(payload) {
    if (!payload || typeof payload !== "object") return;
    const defaults = payload.defaults || {};
    const config = payload.config || {};
    const effective = payload.effective || {};
    const envOverrides = payload.env_overrides && typeof payload.env_overrides === "object" ? payload.env_overrides : {};
    settingsEnvOverrides = envOverrides;
    const providers = toProviderList(payload.providers);
    state.configDefaults = defaults;
    state.configPath = payload.path || "";
    const observerProvider = $select("observerProvider");
    const claudeCommand = document.getElementById("claudeCommand");
    const observerModel = $input("observerModel");
    const observerRuntime = $select("observerRuntime");
    const observerAuthSource = $select("observerAuthSource");
    const observerAuthFile = $input("observerAuthFile");
    const observerAuthCommand = document.getElementById("observerAuthCommand");
    const observerAuthTimeoutMs = $input("observerAuthTimeoutMs");
    const observerAuthCacheTtlS = $input("observerAuthCacheTtlS");
    const observerHeaders = document.getElementById("observerHeaders");
    const observerMaxChars = $input("observerMaxChars");
    const packObservationLimit = $input("packObservationLimit");
    const packSessionLimit = $input("packSessionLimit");
    const rawEventsSweeperIntervalS = $input("rawEventsSweeperIntervalS");
    const syncEnabled = $input("syncEnabled");
    const syncHost = $input("syncHost");
    const syncPort = $input("syncPort");
    const syncInterval = $input("syncInterval");
    const syncMdns = $input("syncMdns");
    const syncCoordinatorUrl = $input("syncCoordinatorUrl");
    const syncCoordinatorGroup = $input("syncCoordinatorGroup");
    const syncCoordinatorTimeout = $input("syncCoordinatorTimeout");
    const syncCoordinatorPresenceTtl = $input("syncCoordinatorPresenceTtl");
    const settingsPath = $("settingsPath");
    const observerModelHint = $("observerModelHint");
    const observerMaxCharsHint = $("observerMaxCharsHint");
    const settingsEffective = $("settingsEffective");
    const observerProviderValue = asInputString(effectiveOrConfigured(config, effective, "observer_provider"));
    setProviderOptions(observerProvider, providers, observerProviderValue);
    if (claudeCommand) {
      const value = effectiveOrConfigured(config, effective, "claude_command");
      const argv = Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
      claudeCommand.value = argv.length ? JSON.stringify(argv, null, 2) : "";
    }
    const observerModelValue = asInputString(effectiveOrConfigured(config, effective, "observer_model"));
    if (observerModel) observerModel.value = observerModelValue;
    if (observerRuntime) observerRuntime.value = asInputString(effectiveOrConfigured(config, effective, "observer_runtime")) || "api_http";
    if (observerAuthSource) observerAuthSource.value = asInputString(effectiveOrConfigured(config, effective, "observer_auth_source")) || "auto";
    if (observerAuthFile) observerAuthFile.value = asInputString(effectiveOrConfigured(config, effective, "observer_auth_file"));
    if (observerAuthCommand) {
      const argv = effectiveOrConfigured(config, effective, "observer_auth_command");
      const command = Array.isArray(argv) ? argv : [];
      const commandStrings = command.filter((item) => typeof item === "string");
      observerAuthCommand.value = commandStrings.length ? JSON.stringify(commandStrings, null, 2) : "";
    }
    if (observerAuthTimeoutMs) {
      observerAuthTimeoutMs.value = asInputString(effectiveOrConfigured(config, effective, "observer_auth_timeout_ms"));
    }
    if (observerAuthCacheTtlS) {
      observerAuthCacheTtlS.value = asInputString(effectiveOrConfigured(config, effective, "observer_auth_cache_ttl_s"));
    }
    if (observerHeaders) {
      const headerValue = effectiveOrConfigured(config, effective, "observer_headers");
      const headers = headerValue && typeof headerValue === "object" ? headerValue : {};
      const normalized = {};
      Object.entries(headers).forEach(([key, value]) => {
        if (typeof key === "string" && key.trim() && typeof value === "string") {
          normalized[key] = value;
        }
      });
      observerHeaders.value = Object.keys(normalized).length ? JSON.stringify(normalized, null, 2) : "";
    }
    if (observerMaxChars) observerMaxChars.value = asInputString(effectiveOrConfigured(config, effective, "observer_max_chars"));
    if (packObservationLimit) packObservationLimit.value = asInputString(effectiveOrConfigured(config, effective, "pack_observation_limit"));
    if (packSessionLimit) packSessionLimit.value = asInputString(effectiveOrConfigured(config, effective, "pack_session_limit"));
    if (rawEventsSweeperIntervalS) {
      rawEventsSweeperIntervalS.value = asInputString(effectiveOrConfigured(config, effective, "raw_events_sweeper_interval_s"));
    }
    if (syncEnabled) syncEnabled.checked = Boolean(effectiveOrConfigured(config, effective, "sync_enabled"));
    if (syncHost) syncHost.value = asInputString(effectiveOrConfigured(config, effective, "sync_host"));
    if (syncPort) syncPort.value = asInputString(effectiveOrConfigured(config, effective, "sync_port"));
    if (syncInterval) syncInterval.value = asInputString(effectiveOrConfigured(config, effective, "sync_interval_s"));
    if (syncMdns) syncMdns.checked = Boolean(effectiveOrConfigured(config, effective, "sync_mdns"));
    if (syncCoordinatorUrl) syncCoordinatorUrl.value = asInputString(effectiveOrConfigured(config, effective, "sync_coordinator_url"));
    if (syncCoordinatorGroup) syncCoordinatorGroup.value = asInputString(effectiveOrConfigured(config, effective, "sync_coordinator_group"));
    if (syncCoordinatorTimeout) syncCoordinatorTimeout.value = asInputString(effectiveOrConfigured(config, effective, "sync_coordinator_timeout_s"));
    if (syncCoordinatorPresenceTtl) syncCoordinatorPresenceTtl.value = asInputString(effectiveOrConfigured(config, effective, "sync_coordinator_presence_ttl_s"));
    if (settingsPath) settingsPath.textContent = state.configPath ? `Config path: ${state.configPath}` : "Config path: n/a";
    if (observerModelHint) renderObserverModelHint();
    if (observerMaxCharsHint) {
      const def = defaults?.observer_max_chars || "";
      observerMaxCharsHint.textContent = def ? `Default: ${def}` : "";
    }
    if (settingsEffective) {
      settingsEffective.textContent = Object.keys(envOverrides).length > 0 ? "Some fields are managed by environment settings." : "";
    }
    const overrides = $("settingsOverrides");
    if (overrides) {
      overrides.hidden = Object.keys(envOverrides).length === 0;
    }
    updateAuthSourceVisibility();
    setAdvancedVisibility(settingsShowAdvanced);
    setSettingsTab(settingsActiveTab);
    settingsTouchedKeys = /* @__PURE__ */ new Set();
    try {
      const baseline = collectSettingsPayload();
      settingsBaseline = mergeOverrideBaseline(baseline, config, envOverrides);
    } catch {
      settingsBaseline = {};
    }
    setDirty(false);
    const settingsStatus = $("settingsStatus");
    if (settingsStatus) settingsStatus.textContent = "Ready";
  }
  function parseCommandArgv(raw, options) {
    const text = raw.trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`${options.label} must be a JSON string array`);
    }
    if (!options.normalize && !options.requireNonEmpty) {
      return parsed;
    }
    const values = options.normalize ? parsed.map((item) => item.trim()) : parsed;
    if (options.requireNonEmpty && values.some((item) => item.trim() === "")) {
      throw new Error(`${options.label} cannot contain empty command tokens`);
    }
    return values;
  }
  function parseObserverHeaders(raw) {
    const text = raw.trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("observer headers must be a JSON object");
    }
    const headers = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== "string" || !key.trim() || typeof value !== "string") {
        throw new Error("observer headers must map string keys to string values");
      }
      headers[key.trim()] = value;
    }
    return headers;
  }
  function collectSettingsPayload(options = {}) {
    const allowUntouchedParseErrors = options.allowUntouchedParseErrors === true;
    const claudeCommandInput = document.getElementById("claudeCommand")?.value || "";
    const authCommandInput = document.getElementById("observerAuthCommand")?.value || "";
    const observerHeadersInput = document.getElementById("observerHeaders")?.value || "";
    const authCacheTtlInput = ($input("observerAuthCacheTtlS")?.value || "").trim();
    const sweeperIntervalInput = ($input("rawEventsSweeperIntervalS")?.value || "").trim();
    let claudeCommand = [];
    try {
      claudeCommand = parseCommandArgv(claudeCommandInput, {
        label: "claude command",
        normalize: true,
        requireNonEmpty: true
      });
    } catch (error) {
      if (!allowUntouchedParseErrors || settingsTouchedKeys.has("claude_command")) {
        throw error;
      }
      const baseline = settingsBaseline.claude_command;
      claudeCommand = Array.isArray(baseline) ? baseline.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0) : [];
    }
    let authCommand = [];
    try {
      authCommand = parseCommandArgv(authCommandInput, { label: "observer auth command" });
    } catch (error) {
      if (!allowUntouchedParseErrors || settingsTouchedKeys.has("observer_auth_command")) {
        throw error;
      }
      const baseline = settingsBaseline.observer_auth_command;
      authCommand = Array.isArray(baseline) ? baseline.filter((item) => typeof item === "string") : [];
    }
    let headers = {};
    try {
      headers = parseObserverHeaders(observerHeadersInput);
    } catch (error) {
      if (!allowUntouchedParseErrors || settingsTouchedKeys.has("observer_headers")) {
        throw error;
      }
      const baseline = settingsBaseline.observer_headers;
      if (baseline && typeof baseline === "object" && !Array.isArray(baseline)) {
        Object.entries(baseline).forEach(([key, value]) => {
          if (typeof key === "string" && key.trim() && typeof value === "string") {
            headers[key] = value;
          }
        });
      }
    }
    const authCacheTtl = authCacheTtlInput === "" ? "" : Number(authCacheTtlInput);
    const sweeperIntervalNum = Number(sweeperIntervalInput);
    const sweeperInterval = sweeperIntervalInput === "" ? "" : sweeperIntervalNum;
    if (authCacheTtlInput !== "" && !Number.isFinite(authCacheTtl)) {
      throw new Error("observer auth cache ttl must be a number");
    }
    if (sweeperIntervalInput !== "" && (!Number.isFinite(sweeperIntervalNum) || sweeperIntervalNum <= 0)) {
      throw new Error("raw-event sweeper interval must be a positive number");
    }
    return {
      claude_command: claudeCommand,
      observer_provider: normalizeTextValue($select("observerProvider")?.value || ""),
      observer_model: normalizeTextValue($input("observerModel")?.value || ""),
      observer_runtime: normalizeTextValue($select("observerRuntime")?.value || "api_http") || "api_http",
      observer_auth_source: normalizeTextValue($select("observerAuthSource")?.value || "auto") || "auto",
      observer_auth_file: normalizeTextValue($input("observerAuthFile")?.value || ""),
      observer_auth_command: authCommand,
      observer_auth_timeout_ms: Number($input("observerAuthTimeoutMs")?.value || 0) || "",
      observer_auth_cache_ttl_s: authCacheTtl,
      observer_headers: headers,
      observer_max_chars: Number($input("observerMaxChars")?.value || 0) || "",
      pack_observation_limit: Number($input("packObservationLimit")?.value || 0) || "",
      pack_session_limit: Number($input("packSessionLimit")?.value || 0) || "",
      raw_events_sweeper_interval_s: sweeperInterval,
      sync_enabled: $input("syncEnabled")?.checked || false,
      sync_host: normalizeTextValue($input("syncHost")?.value || ""),
      sync_port: Number($input("syncPort")?.value || 0) || "",
      sync_interval_s: Number($input("syncInterval")?.value || 0) || "",
      sync_mdns: $input("syncMdns")?.checked || false,
      sync_coordinator_url: normalizeTextValue($input("syncCoordinatorUrl")?.value || ""),
      sync_coordinator_group: normalizeTextValue($input("syncCoordinatorGroup")?.value || ""),
      sync_coordinator_timeout_s: Number($input("syncCoordinatorTimeout")?.value || 0) || "",
      sync_coordinator_presence_ttl_s: Number($input("syncCoordinatorPresenceTtl")?.value || 0) || ""
    };
  }
  function updateAuthSourceVisibility() {
    const source = $select("observerAuthSource")?.value || "auto";
    const fileField = document.getElementById("observerAuthFileField");
    const commandField = document.getElementById("observerAuthCommandField");
    const commandNote = document.getElementById("observerAuthCommandNote");
    if (fileField) fileField.hidden = source !== "file";
    if (commandField) commandField.hidden = source !== "command";
    if (commandNote) commandNote.hidden = source !== "command";
  }
  function setSettingsTab(tab) {
    const next = ["observer", "queue", "sync"].includes(tab) ? tab : "observer";
    settingsActiveTab = next;
    document.querySelectorAll("[data-settings-tab]").forEach((node) => {
      const button = node;
      const active = button.dataset.settingsTab === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-settings-panel]").forEach((node) => {
      const panel = node;
      const active = panel.dataset.settingsPanel === next;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
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
    hideHelpTooltip();
    const restoreTarget = previouslyFocused && typeof previouslyFocused.focus === "function" ? previouslyFocused : $button("settingsButton");
    restoreTarget?.focus();
    previouslyFocused = null;
    settingsTouchedKeys = /* @__PURE__ */ new Set();
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
      const current = collectSettingsPayload({ allowUntouchedParseErrors: true });
      const changed = {};
      Object.entries(current).forEach(([key, value]) => {
        if (hasOwn(settingsEnvOverrides, key) && !settingsTouchedKeys.has(key)) {
          return;
        }
        if (!isEqualValue(value, settingsBaseline[key])) {
          changed[key] = value;
        }
      });
      if (Object.keys(changed).length === 0) {
        status.textContent = "No changes";
        setDirty(false);
        closeSettings(startPolling2, refreshCallback);
        return;
      }
      const result = await saveConfig(changed);
      const notice = buildSettingsNotice(result);
      status.textContent = "Saved";
      setDirty(false);
      closeSettings(startPolling2, refreshCallback);
      showGlobalNotice(notice.message, notice.type);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      status.textContent = `Save failed: ${message}`;
    } finally {
      saveBtn.disabled = !state.settingsDirty;
    }
  }
  async function loadConfigData() {
    if (settingsOpen) return;
    try {
      const payload = await loadConfig();
      renderConfigModal(payload);
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
    bindHelpTooltips();
    document.addEventListener("keydown", (e) => {
      trapModalFocus(e);
      if (e.key === "Escape" && settingsOpen) closeSettings(startPolling2, refreshCallback);
    });
    const inputs = [
      "claudeCommand",
      "observerProvider",
      "observerModel",
      "observerRuntime",
      "observerAuthSource",
      "observerAuthFile",
      "observerAuthCommand",
      "observerAuthTimeoutMs",
      "observerAuthCacheTtlS",
      "observerHeaders",
      "observerMaxChars",
      "packObservationLimit",
      "packSessionLimit",
      "rawEventsSweeperIntervalS",
      "syncEnabled",
      "syncHost",
      "syncPort",
      "syncInterval",
      "syncMdns",
      "syncCoordinatorUrl",
      "syncCoordinatorGroup",
      "syncCoordinatorTimeout",
      "syncCoordinatorPresenceTtl"
    ];
    inputs.forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener("input", () => {
        markFieldTouched(id);
        setDirty(true);
      });
      input.addEventListener("change", () => {
        markFieldTouched(id);
        setDirty(true);
      });
    });
    $select("observerAuthSource")?.addEventListener("change", () => updateAuthSourceVisibility());
    $select("observerProvider")?.addEventListener("change", () => renderObserverModelHint());
    $select("observerRuntime")?.addEventListener("change", () => renderObserverModelHint());
    $input("observerModel")?.addEventListener("input", () => renderObserverModelHint());
    $input("settingsAdvancedToggle")?.addEventListener("change", () => {
      const checked = Boolean($input("settingsAdvancedToggle")?.checked);
      setAdvancedVisibility(checked);
      persistAdvancedPreference(checked);
    });
    document.querySelectorAll("[data-settings-tab]").forEach((node) => {
      node.addEventListener("click", () => {
        const tab = node.dataset.settingsTab || "observer";
        setSettingsTab(tab);
      });
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
  let refreshDebounceTimer = null;
  async function refresh() {
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => doRefresh(), 80);
  }
  async function doRefresh() {
    if (state.refreshInFlight) {
      state.refreshQueued = true;
      return;
    }
    state.refreshInFlight = true;
    try {
      setRefreshStatus("refreshing");
      const promises = [
        loadHealthData(),
        loadConfigData()
      ];
      if (state.activeTab === "feed") {
        promises.push(loadFeedData());
      }
      if (state.activeTab === "sync" || state.activeTab === "health") {
        promises.push(loadSyncData());
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
        doRefresh();
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
