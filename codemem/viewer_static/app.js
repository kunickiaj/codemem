(function() {
  "use strict";
  const refreshStatus = document.getElementById("refreshStatus");
  const refreshAnnouncer = document.getElementById("refreshAnnouncer");
  const statsGrid = document.getElementById("statsGrid");
  const metaLine = document.getElementById("metaLine");
  const feedList = document.getElementById("feedList");
  const feedMeta = document.getElementById("feedMeta");
  const feedTypeToggle = document.getElementById("feedTypeToggle");
  const feedSearch = document.getElementById("feedSearch");
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
  const observerProviderInput = document.getElementById(
    "observerProvider"
  );
  const observerModelInput = document.getElementById(
    "observerModel"
  );
  const observerMaxCharsInput = document.getElementById(
    "observerMaxChars"
  );
  const observerMaxCharsHint = document.getElementById("observerMaxCharsHint");
  const packObservationLimitInput = document.getElementById(
    "packObservationLimit"
  );
  const packSessionLimitInput = document.getElementById(
    "packSessionLimit"
  );
  const syncEnabledInput = document.getElementById(
    "syncEnabled"
  );
  const syncHostInput = document.getElementById(
    "syncHost"
  );
  const syncPortInput = document.getElementById(
    "syncPort"
  );
  const syncIntervalInput = document.getElementById(
    "syncInterval"
  );
  const syncMdnsInput = document.getElementById(
    "syncMdns"
  );
  const projectFilter = document.getElementById(
    "projectFilter"
  );
  const themeSelect = document.getElementById(
    "themeSelect"
  );
  const syncMeta = document.getElementById("syncMeta");
  const syncHealthGrid = document.getElementById("syncHealthGrid");
  const healthGrid = document.getElementById("healthGrid");
  const healthMeta = document.getElementById("healthMeta");
  const healthActions = document.getElementById("healthActions");
  const syncActions = document.getElementById("syncActions");
  const syncStatusGrid = document.getElementById("syncStatusGrid");
  const syncDiagnostics = document.getElementById("syncDiagnostics");
  const syncPeers = document.getElementById("syncPeers");
  const syncAttempts = document.getElementById("syncAttempts");
  const syncNowButton = document.getElementById(
    "syncNowButton"
  );
  const syncDetailsToggle = document.getElementById(
    "syncDetailsToggle"
  );
  const syncPairingToggle = document.getElementById(
    "syncPairingToggle"
  );
  const syncRedact = document.getElementById(
    "syncRedact"
  );
  const pairingPayload = document.getElementById("pairingPayload");
  const pairingCopy = document.getElementById(
    "pairingCopy"
  );
  const pairingHint = document.getElementById("pairingHint");
  const syncPairing = document.getElementById("syncPairing");
  const detailsToggle = document.getElementById("detailsToggle");
  const detailsRow = document.getElementById("detailsRow");
  let configDefaults = {};
  let configPath = "";
  let currentProject = "";
  const itemViewState = /* @__PURE__ */ new Map();
  const itemExpandState = /* @__PURE__ */ new Map();
  const FEED_FILTER_KEY = "codemem-feed-filter";
  const FEED_FILTERS = ["all", "observations", "summaries"];
  const DETAILS_OPEN_KEY = "codemem-details-open";
  const SYNC_DIAGNOSTICS_KEY = "codemem-sync-diagnostics";
  const SYNC_PAIRING_KEY = "codemem-sync-pairing";
  const SYNC_REDACT_KEY = "codemem-sync-redact";
  const THEME_OPTIONS = [
    { id: "light", label: "Light (Classic)", mode: "light" },
    { id: "dark", label: "Dark (Classic)", mode: "dark" },
    { id: "dark-violet", label: "Dark (Violet)", mode: "dark" },
    { id: "dark-aurora", label: "Dark (Aurora)", mode: "dark" }
  ];
  let feedTypeFilter = "all";
  let pairingPayloadRaw = null;
  let pairingCommandRaw = "";
  const PAIRING_FILTER_HINT = "Run this on another device with codemem sync pair --accept '<payload>'. On that accepting device, --include/--exclude only control what it sends to peers. This device does not yet enforce incoming project filters.";
  let lastSyncStatus = null;
  let lastSyncPeers = [];
  let lastSyncAttempts = [];
  let syncPairingOpen = false;
  let refreshInFlight = false;
  let refreshQueued = false;
  let refreshTimer = null;
  let lastStatsPayload = null;
  let lastUsagePayload = null;
  let lastRawEventsPayload = null;
  let lastFeedSignature = "";
  let lastFeedItems = [];
  let lastFeedFilteredCount = 0;
  let feedQuery = "";
  let pendingFeedItems = null;
  let lastAnnouncedRefreshState = null;
  const newItemKeys = /* @__PURE__ */ new Set();
  let settingsDirty = false;
  function setSettingsDirty(next) {
    settingsDirty = next;
    if (settingsSave) {
      settingsSave.disabled = !next;
    }
  }
  function isSettingsOpen() {
    return Boolean(settingsModal && !settingsModal.hasAttribute("hidden"));
  }
  function setRefreshStatus(state, detail) {
    if (!refreshStatus) return;
    const announce = (message) => {
      if (!refreshAnnouncer) return;
      if (lastAnnouncedRefreshState === state) return;
      refreshAnnouncer.textContent = message;
      lastAnnouncedRefreshState = state;
    };
    if (state === "refreshing") {
      refreshStatus.innerHTML = "<span class='dot'></span>refreshing…";
      return;
    }
    if (state === "paused") {
      refreshStatus.innerHTML = "<span class='dot'></span>paused";
      announce("Auto refresh paused.");
      return;
    }
    if (state === "error") {
      refreshStatus.innerHTML = "<span class='dot'></span>refresh failed";
      announce("Refresh failed.");
      return;
    }
    const suffix = detail ? ` ${detail}` : "";
    refreshStatus.innerHTML = "<span class='dot'></span>updated " + (/* @__PURE__ */ new Date()).toLocaleTimeString() + suffix;
    lastAnnouncedRefreshState = null;
  }
  function stopPolling() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }
  function startPolling() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      refresh();
    }, 5e3);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopPolling();
      setRefreshStatus("paused", "(tab hidden)");
      return;
    }
    if (!isSettingsOpen()) {
      startPolling();
      refresh();
    }
  });
  function resolveTheme(themeId) {
    const aliases = {
      "light-warm": "light",
      "dark-nocturne": "dark-violet"
    };
    const normalized = aliases[themeId] || themeId;
    const exact = THEME_OPTIONS.find((theme) => theme.id === normalized);
    if (exact) return exact;
    const fallback = normalized.startsWith("dark") ? "dark" : "light";
    return THEME_OPTIONS.find((theme) => theme.id === fallback) || THEME_OPTIONS[0];
  }
  function getTheme() {
    const saved = localStorage.getItem("codemem-theme");
    if (saved) return resolveTheme(saved).id;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function setTheme(theme) {
    const selectedTheme = resolveTheme(theme);
    document.documentElement.setAttribute("data-theme", selectedTheme.mode);
    document.documentElement.setAttribute("data-color-mode", selectedTheme.mode);
    if (selectedTheme.id === selectedTheme.mode) {
      document.documentElement.removeAttribute("data-theme-variant");
    } else {
      document.documentElement.setAttribute("data-theme-variant", selectedTheme.id);
    }
    localStorage.setItem("codemem-theme", selectedTheme.id);
    if (themeSelect) {
      themeSelect.value = selectedTheme.id;
    }
  }
  function initThemeSelect() {
    if (!themeSelect) return;
    themeSelect.textContent = "";
    THEME_OPTIONS.forEach((theme) => {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.label;
      themeSelect.appendChild(option);
    });
    themeSelect.value = getTheme();
    themeSelect.addEventListener("change", () => {
      setTheme(themeSelect.value || "dark");
    });
  }
  initThemeSelect();
  setTheme(getTheme());
  setDetailsOpen(isDetailsOpen());
  detailsToggle?.addEventListener("click", () => {
    setDetailsOpen(!isDetailsOpen());
  });
  setSyncDiagnosticsOpen(isSyncDiagnosticsOpen());
  try {
    syncPairingOpen = localStorage.getItem(SYNC_PAIRING_KEY) === "1";
  } catch {
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
      if (pairingHint) pairingHint.textContent = "Fetching pairing payload…";
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
  feedTypeToggle?.addEventListener("click", (event) => {
    const target = event.target?.closest?.("button");
    if (!target) return;
    const value = target.dataset.filter || "all";
    setFeedTypeFilter(value);
  });
  feedSearch?.addEventListener("input", () => {
    feedQuery = feedSearch.value || "";
    updateFeedView();
  });
  function formatDate(value) {
    if (!value) return "n/a";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  function formatPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "n/a";
    return `${Math.round(num * 100)}%`;
  }
  function formatMultiplier(saved, read) {
    const savedNum = Number(saved || 0);
    const readNum = Number(read || 0);
    if (!Number.isFinite(savedNum) || !Number.isFinite(readNum) || readNum <= 0)
      return "n/a";
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
  function getFeedTypeFilter() {
    const saved = localStorage.getItem(FEED_FILTER_KEY) || "all";
    return FEED_FILTERS.includes(saved) ? saved : "all";
  }
  function isSyncDiagnosticsOpen() {
    return localStorage.getItem(SYNC_DIAGNOSTICS_KEY) === "1";
  }
  function isDetailsOpen() {
    return localStorage.getItem(DETAILS_OPEN_KEY) === "1";
  }
  function setDetailsOpen(open) {
    if (detailsRow) {
      detailsRow.hidden = !open;
    }
    if (detailsToggle) {
      detailsToggle.textContent = open ? "Hide details" : "Details";
    }
    localStorage.setItem(DETAILS_OPEN_KEY, open ? "1" : "0");
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
    } catch {
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
    if (lastFeedItems.length) {
      updateFeedView();
    } else {
      refresh();
    }
  }
  function updateFeedTypeToggle() {
    if (!feedTypeToggle) return;
    const buttons = Array.from(feedTypeToggle.querySelectorAll(".toggle-button"));
    buttons.forEach((button) => {
      const value = button.dataset?.filter || "all";
      button.classList.toggle("active", value === feedTypeFilter);
    });
  }
  function filterFeedItems(items) {
    if (feedTypeFilter === "observations") {
      return items.filter(
        (item) => String(item.kind || "").toLowerCase() !== "session_summary"
      );
    }
    if (feedTypeFilter === "summaries") {
      return items.filter(
        (item) => String(item.kind || "").toLowerCase() === "session_summary"
      );
    }
    return items;
  }
  function filterFeedQuery(items) {
    const query = normalize(feedQuery);
    if (!query) return items;
    return items.filter((item) => {
      const title = normalize(item?.title);
      const body = normalize(item?.body_text);
      const kind = normalize(item?.kind);
      const tags = parseJsonArray(item?.tags || []).map((t) => normalize(t)).join(" ");
      const project = normalize(item?.project);
      const hay = `${title} ${body} ${kind} ${tags} ${project}`.trim();
      return hay.includes(query);
    });
  }
  function updateFeedView() {
    const scrollY = window.scrollY;
    const filteredByType = filterFeedItems(lastFeedItems);
    const visibleItems = filterFeedQuery(filteredByType);
    const filterLabel = formatFeedFilterLabel();
    const signature = computeFeedSignature(visibleItems);
    const changed = signature !== lastFeedSignature;
    lastFeedSignature = signature;
    if (feedMeta) {
      const filteredLabel = !feedQuery.trim() && lastFeedFilteredCount ? ` · ${lastFeedFilteredCount} observations filtered` : "";
      const queryLabel = feedQuery.trim() ? ` · matching "${feedQuery.trim()}"` : "";
      feedMeta.textContent = `${visibleItems.length} items${filterLabel}${queryLabel}${filteredLabel}`;
    }
    if (changed) {
      renderFeed(visibleItems);
    }
    window.scrollTo({ top: scrollY });
  }
  function formatFeedFilterLabel() {
    if (feedTypeFilter === "observations") return " · observations";
    if (feedTypeFilter === "summaries") return " · session summaries";
    return "";
  }
  function extractFactsFromBody(text) {
    if (!text) return [];
    const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean);
    const bulletLines = lines.filter(
      (line) => /^[-*\u2022]\s+/.test(line) || /^\d+\./.test(line)
    );
    if (!bulletLines.length) return [];
    return bulletLines.map(
      (line) => line.replace(/^[-*\u2022]\s+/, "").replace(/^\d+\.\s+/, "")
    );
  }
  function isLowSignalObservation(item) {
    const title = normalize(item.title);
    const body = normalize(item.body_text);
    if (!title && !body) return true;
    const combined = body || title;
    if (combined.length < 10) return true;
    if (title && body && title === body && combined.length < 40) return true;
    const leadGlyph = title.charAt(0);
    const isPrompty = leadGlyph === "└" || leadGlyph === "›";
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
    if (text !== void 0 && text !== null) {
      el.textContent = String(text);
    }
    return el;
  }
  function formatTagLabel(tag) {
    if (!tag) return "";
    const trimmed = String(tag).trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) return trimmed;
    return trimmed.slice(0, colonIndex).trim();
  }
  function createTagChip(tag) {
    const display = formatTagLabel(tag);
    if (!display) return null;
    const chip = createElement("span", "tag-chip", display);
    chip.title = String(tag);
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
    const trimmed = files.map((file) => String(file).trim()).filter(Boolean);
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
    const globalLineWork = isFiltered ? `
Global: ${Number(totalsGlobal.work_investment_tokens || 0).toLocaleString()} invested` : "";
    const globalLineRead = isFiltered ? `
Global: ${Number(totalsGlobal.tokens_read || 0).toLocaleString()} read` : "";
    const globalLineSaved = isFiltered ? `
Global: ${Number(totalsGlobal.tokens_saved || 0).toLocaleString()} saved` : "";
    const items = [
      {
        label: isFiltered ? "Savings (project)" : "Savings",
        value: Number(usage.tokens_saved || 0),
        tooltip: "Tokens saved by reusing compressed memories instead of raw context" + globalLineSaved,
        icon: "trending-up"
      },
      {
        label: isFiltered ? "Injected (project)" : "Injected",
        value: Number(usage.tokens_read || 0),
        tooltip: "Tokens injected into context (pack size)" + globalLineRead,
        icon: "book-open"
      },
      {
        label: isFiltered ? "Reduction (project)" : "Reduction",
        value: formatReductionPercent(usage.tokens_saved, usage.tokens_read),
        tooltip: `Percent reduction from reuse (claude-mem style). Factor: ${formatMultiplier(usage.tokens_saved, usage.tokens_read)}.` + globalLineRead + globalLineSaved,
        icon: "percent"
      },
      {
        label: isFiltered ? "Work investment (project)" : "Work investment",
        value: Number(usage.work_investment_tokens || 0),
        tooltip: "Token cost of unique discovery groups (avoids double-counting when one response yields multiple memories)" + globalLineWork,
        icon: "pencil"
      },
      {
        label: "Active memories",
        value: db.active_memory_items || 0,
        icon: "check-circle"
      },
      {
        label: "Embedding coverage",
        value: formatPercent(db.vector_coverage),
        tooltip: "Share of active memories with embeddings",
        icon: "layers"
      },
      {
        label: "Tag coverage",
        value: formatPercent(db.tags_coverage),
        tooltip: "Share of active memories with tags",
        icon: "tag"
      }
    ];
    if (rawPending > 0) {
      items.push({
        label: "Raw events pending",
        value: rawPending,
        tooltip: "Pending raw events waiting to be flushed",
        icon: "activity"
      });
    } else if (rawSessions > 0) {
      items.push({
        label: "Raw sessions",
        value: rawSessions,
        tooltip: "OpenCode sessions with pending raw events waiting to be flushed",
        icon: "inbox"
      });
    }
    if (statsGrid) {
      statsGrid.textContent = "";
      items.forEach((item) => {
        const stat = createElement("div", "stat");
        if (item.tooltip) {
          stat.title = item.tooltip;
          stat.style.cursor = "help";
        }
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", item.icon);
        icon.className = "stat-icon";
        const content = createElement("div", "stat-content");
        const rawValue = item.value;
        const displayValue = typeof rawValue === "number" ? rawValue.toLocaleString() : rawValue === null || rawValue === void 0 ? "n/a" : String(rawValue);
        const value = createElement(
          "div",
          "value",
          displayValue
        );
        const label = createElement("div", "label", item.label);
        content.append(value, label);
        stat.append(icon, content);
        statsGrid.appendChild(stat);
      });
    }
    if (typeof globalThis.lucide !== "undefined")
      globalThis.lucide.createIcons();
    const projectSuffix = project ? ` · project: ${project}` : "";
    if (metaLine) {
      metaLine.textContent = `DB: ${db.path || "unknown"} · ${Math.round(
        (db.size_bytes || 0) / 1024
      )} KB${projectSuffix}`;
    }
  }
  function formatTimestamp(value) {
    if (!value) return "never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
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
  function parsePercentValue(label) {
    const text = String(label || "").trim();
    if (!text.endsWith("%")) return null;
    const raw = Number(text.replace("%", ""));
    if (!Number.isFinite(raw)) return null;
    return raw;
  }
  function titleCase(value) {
    const text = String(value || "").trim();
    if (!text) return "Unknown";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function buildHealthCard({
    label,
    value,
    detail,
    icon,
    className,
    title
  }) {
    const card = createElement("div", `stat${className ? ` ${className}` : ""}`);
    if (title) {
      card.title = title;
      card.style.cursor = "help";
    }
    if (icon) {
      const iconNode = document.createElement("i");
      iconNode.setAttribute("data-lucide", String(icon));
      iconNode.className = "stat-icon";
      card.appendChild(iconNode);
    }
    const content = createElement("div", "stat-content");
    const valueNode = createElement("div", "value", value);
    const labelNode = createElement("div", "label", label);
    content.append(valueNode, labelNode);
    if (detail) {
      content.appendChild(createElement("div", "small", detail));
    }
    card.appendChild(content);
    return card;
  }
  async function copyCommand(command, button) {
    if (!command || !button) return;
    const previous = button.textContent;
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = previous || "Copy";
    }, 1200);
  }
  function renderActionList(container, actions) {
    if (!container) return;
    container.textContent = "";
    const list = Array.isArray(actions) ? actions.filter((item) => item && item.command) : [];
    if (!list.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    list.slice(0, 2).forEach((item) => {
      const isSync = container === syncActions;
      const row = createElement("div", isSync ? "sync-action" : "health-action");
      const textWrap = createElement(
        "div",
        isSync ? "sync-action-text" : "health-action-text"
      );
      textWrap.textContent = item.label;
      const command = createElement(
        "span",
        isSync ? "sync-action-command" : "health-action-command",
        item.command
      );
      textWrap.appendChild(command);
      const button = createElement(
        "button",
        `settings-button ${isSync ? "sync-action-copy" : "health-action-copy"}`,
        "Copy"
      );
      button.addEventListener("click", () => copyCommand(String(item.command), button));
      row.append(textWrap, button);
      container.appendChild(row);
    });
  }
  function renderHealthOverview() {
    if (!healthGrid || !healthMeta) return;
    healthGrid.textContent = "";
    const stats = lastStatsPayload || {};
    const usagePayload = lastUsagePayload || {};
    const raw = lastRawEventsPayload && typeof lastRawEventsPayload === "object" ? lastRawEventsPayload : {};
    const syncStatus = lastSyncStatus || {};
    const reliability = stats.reliability || {};
    const counts = reliability.counts || {};
    const rates = reliability.rates || {};
    const dbStats = stats.database || {};
    const totals = usagePayload.totals_filtered || usagePayload.totals || usagePayload.totals_global || stats.usage?.totals || {};
    const recentPacks = Array.isArray(usagePayload.recent_packs) ? usagePayload.recent_packs : [];
    const lastPackAt = recentPacks.length ? recentPacks[0]?.created_at : null;
    const rawPending = Number(raw.pending || 0);
    const erroredBatches = Number(counts.errored_batches || 0);
    const flushSuccessRate = Number(rates.flush_success_rate ?? 1);
    const droppedRate = Number(rates.dropped_event_rate || 0);
    const reductionLabel = formatReductionPercent(totals.tokens_saved, totals.tokens_read);
    const reductionPercent = parsePercentValue(reductionLabel);
    const tagCoverage = Number(dbStats.tags_coverage || 0);
    const syncState = String(syncStatus.daemon_state || "unknown");
    const syncStateLabel = syncState === "offline-peers" ? "Offline peers" : titleCase(syncState);
    const peerCount = Array.isArray(lastSyncPeers) ? lastSyncPeers.length : 0;
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
    const retrievalDetail = `${Number(totals.tokens_saved || 0).toLocaleString()} saved tokens`;
    const pipelineDetail = rawPending > 0 ? "Queue is actively draining" : "Queue is clear";
    const syncDetail = syncDisabled ? "Sync disabled" : syncNoPeers ? "No peers configured" : syncOfflinePeers ? `${peerCount} peers offline · last sync ${formatAgeShort(syncAgeSeconds)} ago` : `${peerCount} peers · last sync ${formatAgeShort(syncAgeSeconds)} ago`;
    const freshnessDetail = `last pack ${formatAgeShort(packAgeSeconds)} ago`;
    const cards = [
      buildHealthCard({
        label: "Overall health",
        value: statusLabel,
        detail: `Weighted score ${riskScore}`,
        icon: "heart-pulse",
        className: `health-primary ${statusClass}`,
        title: drivers.length ? `Main signals: ${drivers.join(", ")}` : "No major risk signals detected"
      }),
      buildHealthCard({
        label: "Pipeline health",
        value: `${rawPending.toLocaleString()} pending`,
        detail: pipelineDetail,
        icon: "workflow",
        title: "Raw-event queue pressure and flush reliability"
      }),
      buildHealthCard({
        label: "Retrieval impact",
        value: reductionLabel,
        detail: retrievalDetail,
        icon: "sparkles",
        title: "Reduction from memory reuse across recent usage"
      }),
      buildHealthCard({
        label: "Sync health",
        value: syncCardValue,
        detail: syncDetail,
        icon: "refresh-cw",
        title: "Daemon state and sync recency"
      }),
      buildHealthCard({
        label: "Data freshness",
        value: formatAgeShort(packAgeSeconds),
        detail: freshnessDetail,
        icon: "clock-3",
        title: "Recency of last memory pack activity"
      })
    ];
    cards.forEach((card) => healthGrid.appendChild(card));
    const recommendations = [];
    if (hasBacklog) {
      recommendations.push({
        label: "Pipeline needs attention. Check queue health first.",
        command: "uv run codemem raw-events-status"
      });
      recommendations.push({
        label: "Then retry failed batches for impacted sessions.",
        command: "uv run codemem raw-events-retry <opencode_session_id>"
      });
    } else if (syncState === "stopped") {
      recommendations.push({
        label: "Sync daemon is stopped. Start the background service.",
        command: "uv run codemem sync start"
      });
    } else if (!syncDisabled && !syncNoPeers && (syncState === "error" || syncState === "degraded")) {
      recommendations.push({
        label: "Sync is unhealthy. Restart now and run one immediate pass.",
        command: "uv run codemem sync restart && uv run codemem sync once"
      });
      recommendations.push({
        label: "Then run doctor to see root cause details.",
        command: "uv run codemem sync doctor"
      });
    } else if (!syncDisabled && !syncNoPeers && syncState === "offline-peers") ;
    else if (!syncDisabled && !syncNoPeers && syncLooksStale) {
      recommendations.push({
        label: "Sync is stale. Run one immediate sync pass.",
        command: "uv run codemem sync once"
      });
    }
    if (tagCoverage > 0 && tagCoverage < 0.7 && recommendations.length < 2) {
      recommendations.push({
        label: "Tag coverage is low. Preview backfill impact.",
        command: "uv run codemem backfill-tags --dry-run"
      });
    }
    renderActionList(healthActions, recommendations);
    healthMeta.textContent = drivers.length ? `Why this status: ${drivers.join(", ")}.` : "Healthy right now. Diagnostics stay available if you want details.";
    if (typeof globalThis.lucide !== "undefined") {
      globalThis.lucide.createIcons();
    }
  }
  function redactAddress(address) {
    const raw = String(address || "");
    if (!raw) return "";
    let scheme = "";
    let remainder = raw;
    const schemeMatch = raw.match(/^(\w+):\/\/([^/]+)(.*)$/);
    if (schemeMatch) {
      scheme = schemeMatch[1];
      remainder = schemeMatch[2] + schemeMatch[3];
    }
    const redacted = remainder.replace(/\d+/g, "#");
    return scheme ? `${scheme}://${redacted}` : redacted;
  }
  function renderSyncStatus(status) {
    if (!syncStatusGrid) return;
    syncStatusGrid.textContent = "";
    if (!status) {
      renderActionList(syncActions, []);
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
      if (daemonState === "offline-peers") {
        parts.push("All peers are currently offline; sync will resume automatically");
      }
      if (daemonDetail && daemonState === "stopped") {
        parts.push(`Detail: ${daemonDetail}`);
      }
      syncMeta.textContent = parts.join(" · ");
    }
    const items = syncDisabled ? [
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
    items.forEach((item) => {
      const block = createElement("div", "stat");
      const value = createElement("div", "value", item.value);
      const label = createElement("div", "label", item.label);
      const content = createElement("div", "stat-content");
      content.append(value, label);
      block.append(content);
      syncStatusGrid.appendChild(block);
    });
    if (!syncDisabled && !syncNoPeers && (syncError || pingError)) {
      const block = createElement("div", "stat");
      const value = createElement("div", "value", "Errors");
      const label = createElement(
        "div",
        "label",
        [syncError, pingError].filter(Boolean).join(" · ")
      );
      const content = createElement("div", "stat-content");
      content.append(value, label);
      block.append(content);
      syncStatusGrid.appendChild(block);
    }
    if (!syncDisabled && !syncNoPeers && syncPayload && syncPayload.seconds_since_last) {
      const block = createElement("div", "stat");
      const value = createElement(
        "div",
        "value",
        `${syncPayload.seconds_since_last}s`
      );
      const label = createElement("div", "label", "Since last sync");
      const content = createElement("div", "stat-content");
      content.append(value, label);
      block.append(content);
      syncStatusGrid.appendChild(block);
    }
    if (!syncDisabled && !syncNoPeers && pingPayload && pingPayload.seconds_since_last) {
      const block = createElement("div", "stat");
      const value = createElement(
        "div",
        "value",
        `${pingPayload.seconds_since_last}s`
      );
      const label = createElement("div", "label", "Since last ping");
      const content = createElement("div", "stat-content");
      content.append(value, label);
      block.append(content);
      syncStatusGrid.appendChild(block);
    }
    const actions = [];
    if (syncNoPeers) ;
    else if (daemonState === "offline-peers") ;
    else if (daemonState === "stopped") {
      actions.push({
        label: "Sync daemon is stopped. Start it.",
        command: "uv run codemem sync start"
      });
      actions.push({
        label: "Then run one immediate sync pass.",
        command: "uv run codemem sync once"
      });
    } else if (syncError || pingError || daemonState === "error") {
      actions.push({
        label: "Sync reports errors. Restart now and run one immediate pass.",
        command: "uv run codemem sync restart && uv run codemem sync once"
      });
      actions.push({
        label: "Then run doctor for root cause details.",
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
  function pickPrimaryAddress(addresses) {
    if (!Array.isArray(addresses)) return "";
    const unique = Array.from(new Set(addresses.filter(Boolean)));
    const first = unique[0];
    return typeof first === "string" ? first : "";
  }
  async function syncNow(address, button) {
    const targetButton = button || syncNowButton;
    if (!targetButton) return;
    targetButton.disabled = true;
    const prevLabel = targetButton.textContent;
    targetButton.textContent = "Syncing...";
    try {
      const payload = address ? { address } : {};
      await fetch("/api/sync/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      refresh();
    } catch {
    } finally {
      targetButton.disabled = false;
      targetButton.textContent = prevLabel || "Sync now";
    }
  }
  function renderSyncPeers(peers) {
    if (!syncPeers) return;
    syncPeers.textContent = "";
    if (!Array.isArray(peers) || !peers.length) return;
    peers.forEach((peer) => {
      const card = createElement("div", "peer-card");
      const title = createElement("div", "peer-title");
      const peerId = peer.peer_device_id ? String(peer.peer_device_id) : "";
      const displayName = peer.name || (peerId ? peerId.slice(0, 8) : "unknown");
      const name = createElement("strong", null, displayName);
      if (peerId) name.title = peerId;
      const actions = createElement("div", "peer-actions");
      const status = peer.status || {};
      const syncStatus = status.sync_status || "";
      const pingStatus = status.ping_status || "";
      const online = syncStatus === "ok" || pingStatus === "ok";
      const statusBadge = createElement(
        "span",
        "badge",
        online ? "Online" : "Offline"
      );
      statusBadge.style.background = online ? "rgba(31, 111, 92, 0.12)" : "rgba(230, 126, 77, 0.15)";
      statusBadge.style.color = online ? "var(--accent)" : "var(--accent-2)";
      name.append(" ", statusBadge);
      const peerAddresses = Array.isArray(peer.addresses) ? Array.from(new Set(peer.addresses.filter(Boolean))) : [];
      const addressLine = peerAddresses.length ? peerAddresses.map(
        (address) => isSyncRedactionEnabled() ? redactAddress(address) : address
      ).join(" · ") : "No addresses";
      const addressLabel = createElement("div", "peer-addresses", addressLine);
      const lastSyncAt = status.last_sync_at || status.last_sync_at_utc || "";
      const lastPingAt = status.last_ping_at || status.last_ping_at_utc || "";
      const metaLine2 = [
        lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : "Sync: never",
        lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : "Ping: never"
      ].join(" · ");
      const meta = createElement("div", "peer-meta", metaLine2);
      const primaryAddress = pickPrimaryAddress(peer.addresses);
      const button = createElement("button", null, "Sync now");
      button.disabled = !primaryAddress;
      button.addEventListener("click", () => syncNow(primaryAddress, button));
      actions.appendChild(button);
      title.append(name, actions);
      card.append(title, addressLabel, meta);
      syncPeers.appendChild(card);
    });
  }
  function renderSyncAttempts(attempts) {
    if (!syncAttempts) return;
    syncAttempts.textContent = "";
    if (!Array.isArray(attempts) || !attempts.length) return;
    attempts.forEach((attempt) => {
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
    if (!payload || typeof payload !== "object") {
      pairingPayload.textContent = "Pairing not available";
      if (pairingHint)
        pairingHint.textContent = "Enable sync and retry. (If you just enabled sync, wait a moment and refresh.)";
      pairingCommandRaw = "";
      return;
    }
    if (payload.redacted) {
      pairingPayload.textContent = "Pairing payload hidden";
      if (pairingHint)
        pairingHint.textContent = "Diagnostics are required to view the pairing payload.";
      pairingCommandRaw = "";
      return;
    }
    const addresses = Array.isArray(payload.addresses) ? payload.addresses : [];
    const safePayload = {
      ...payload,
      addresses
    };
    const pretty = JSON.stringify(safePayload, null, 2);
    pairingPayload.textContent = pretty;
    pairingCommandRaw = pretty;
    if (pairingHint) {
      pairingHint.textContent = typeof payload.pairing_filter_hint === "string" && payload.pairing_filter_hint.trim() ? payload.pairing_filter_hint : PAIRING_FILTER_HINT;
    }
  }
  async function copyPairingCommand() {
    const command = pairingCommandRaw || pairingPayload?.textContent || "";
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      if (pairingCopy) pairingCopy.textContent = "Copied";
      setTimeout(() => {
        if (pairingCopy) pairingCopy.textContent = "Copy pairing payload";
      }, 1200);
    } catch {
      if (pairingCopy) pairingCopy.textContent = "Copy failed";
    }
  }
  pairingCopy?.addEventListener("click", copyPairingCommand);
  function itemSignature(item) {
    return String(
      item.id ?? item.memory_id ?? item.observation_id ?? item.session_id ?? item.created_at_utc ?? item.created_at ?? ""
    );
  }
  function itemKey(item) {
    return `${String(item.kind || "").toLowerCase()}:${itemSignature(item)}`;
  }
  function toTitleLabel(value) {
    return value.replace(/_/g, " ").split(" ").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ").trim();
  }
  function getSummaryObject(item) {
    const preferredKeys = [
      "request",
      "outcome",
      "plan",
      "completed",
      "learned",
      "investigated",
      "next",
      "next_steps",
      "notes"
    ];
    const looksLikeSummary = (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return preferredKeys.some((key) => {
        const raw = value[key];
        return typeof raw === "string" && raw.trim().length > 0;
      });
    };
    const candidate = item?.summary;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate;
    }
    const nested = item?.summary?.summary;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested;
    }
    const metadata = item?.metadata_json;
    if (looksLikeSummary(metadata)) {
      return metadata;
    }
    const metadataNested = metadata?.summary;
    if (looksLikeSummary(metadataNested)) {
      return metadataNested;
    }
    return null;
  }
  function renderSummaryObject(summary) {
    const preferred = [
      "request",
      "outcome",
      "plan",
      "completed",
      "learned",
      "investigated",
      "next",
      "next_steps",
      "notes"
    ];
    const keys = Object.keys(summary || {});
    const ordered = preferred.filter((key) => keys.includes(key));
    const container = createElement("div", "feed-body facts");
    let wrote = false;
    ordered.forEach((key) => {
      const raw = summary[key];
      const content = String(raw || "").trim();
      if (!content) return;
      wrote = true;
      const row = createElement("div", "summary-section");
      const label = createElement("div", "summary-section-label", toTitleLabel(key));
      const value = createElement("div", "summary-section-content");
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
    const trimmed = facts.map((fact) => String(fact || "").trim()).filter(Boolean);
    if (!trimmed.length) return null;
    const container = createElement("div", "feed-body");
    const list = document.createElement("ul");
    trimmed.forEach((fact) => {
      const li = document.createElement("li");
      li.textContent = fact;
      list.appendChild(li);
    });
    container.appendChild(list);
    return container;
  }
  function renderNarrative(narrative) {
    const content = String(narrative || "").trim();
    if (!content) return null;
    const body = createElement("div", "feed-body");
    body.innerHTML = globalThis.marked.parse(content);
    return body;
  }
  function _sentenceFacts(text, limit = 6) {
    const raw = String(text || "").trim();
    if (!raw) return [];
    const collapsed = raw.replace(/\s+/g, " ").trim();
    const parts = collapsed.split(new RegExp("(?<=[.!?])\\s+")).map((part) => part.trim()).filter(Boolean);
    const facts = [];
    for (const part of parts) {
      if (part.length < 18) continue;
      facts.push(part);
      if (facts.length >= limit) break;
    }
    return facts;
  }
  function _observationViewData(item) {
    const metadata = mergeMetadata(item?.metadata_json);
    const summary = String(item?.subtitle || item?.body_text || "").trim();
    const narrative = String(item?.narrative || metadata?.narrative || "").trim();
    const normalizedSummary = normalize(summary);
    const normalizedNarrative = normalize(narrative);
    const narrativeDistinct = Boolean(narrative) && normalizedNarrative !== normalizedSummary;
    const explicitFacts = parseJsonArray(item?.facts || metadata?.facts || []);
    const fallbackFacts = explicitFacts.length ? explicitFacts : extractFactsFromBody(summary || narrative);
    const derivedFacts = fallbackFacts.length ? fallbackFacts : _sentenceFacts(summary);
    return {
      summary,
      narrative,
      facts: derivedFacts,
      hasSummary: Boolean(summary),
      hasFacts: derivedFacts.length > 0,
      hasNarrative: narrativeDistinct
    };
  }
  function _observationViewModes(data) {
    const modes = [];
    if (data.hasSummary) modes.push({ id: "summary", label: "Summary" });
    if (data.hasFacts) modes.push({ id: "facts", label: "Facts" });
    if (data.hasNarrative) modes.push({ id: "narrative", label: "Narrative" });
    return modes;
  }
  function _defaultObservationView(data) {
    if (data.hasSummary) return "summary";
    if (data.hasFacts) return "facts";
    return "narrative";
  }
  function _renderObservationBody(data, mode) {
    if (mode === "facts") {
      return renderFacts(data.facts) || createElement("div", "feed-body");
    }
    if (mode === "narrative") {
      return renderNarrative(data.narrative) || createElement("div", "feed-body");
    }
    return renderNarrative(data.summary) || createElement("div", "feed-body");
  }
  function renderItemViewToggle(modes, active, onSelect) {
    if (modes.length <= 1) return null;
    const toggle = createElement("div", "feed-toggle");
    modes.forEach((mode) => {
      const button = createElement(
        "button",
        "toggle-button",
        mode.label
      );
      button.dataset.filter = mode.id;
      button.classList.toggle("active", mode.id === active);
      button.addEventListener("click", () => onSelect(mode.id));
      toggle.appendChild(button);
    });
    return toggle;
  }
  function shouldClampBody(mode, data) {
    if (mode === "facts") return false;
    if (mode === "summary") return data.summary.length > 260;
    return data.narrative.length > 320;
  }
  function clampClass(mode) {
    if (mode === "summary") return ["clamp", "clamp-3"];
    return ["clamp", "clamp-5"];
  }
  function computeFeedSignature(items) {
    const parts = items.map(
      (item) => `${itemSignature(item)}:${item.kind || ""}:${item.created_at_utc || item.created_at || ""}`
    );
    return `${feedTypeFilter}|${currentProject}|${parts.join("|")}`;
  }
  function countNewItems(nextItems, currentItems) {
    const seen = new Set(currentItems.map(itemKey));
    let count = 0;
    nextItems.forEach((item) => {
      if (!seen.has(itemKey(item))) count += 1;
    });
    return count;
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
  function renderFeed(items) {
    if (!feedList) return;
    feedList.textContent = "";
    if (!Array.isArray(items) || !items.length) {
      const empty = createElement("div", "small", "No memories yet.");
      feedList.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const kindValue = String(item.kind || "session_summary").toLowerCase();
      const isSessionSummary = kindValue === "session_summary";
      const metadata = mergeMetadata(item?.metadata_json);
      const card = createElement(
        "div",
        `feed-item ${kindValue}`.trim()
      );
      const rowKey = itemKey(item);
      card.dataset.key = rowKey;
      if (newItemKeys.has(rowKey)) {
        card.classList.add("new-item");
        setTimeout(() => {
          card.classList.remove("new-item");
          newItemKeys.delete(rowKey);
        }, 700);
      }
      const header = createElement("div", "feed-card-header");
      const titleWrap = createElement("div", "feed-header");
      const defaultTitle = item.title || "(untitled)";
      const displayTitle = isSessionSummary && metadata?.request ? metadata.request : defaultTitle;
      const title = createElement("div", "feed-title title");
      title.innerHTML = highlightText(displayTitle, feedQuery);
      const kind = createElement(
        "span",
        `kind-pill ${kindValue}`.trim(),
        kindValue.replace(/_/g, " ")
      );
      titleWrap.append(kind, title);
      const rightWrap = createElement("div", "feed-actions");
      const createdAtRaw = item.created_at || item.created_at_utc;
      const createdAt = formatDate(createdAtRaw);
      const relative = formatRelativeTime(createdAtRaw);
      const age = createElement("div", "small feed-age", relative);
      age.title = createdAt;
      const footerRight = createElement("div", "feed-footer-right");
      let bodyNode = createElement("div", "feed-body");
      if (isSessionSummary) {
        const summaryObject = getSummaryObject({ metadata_json: metadata });
        const rendered = summaryObject ? renderSummaryObject(summaryObject) : null;
        bodyNode = rendered || renderNarrative(String(item.body_text || "")) || bodyNode;
      } else {
        const data = _observationViewData({ ...item, metadata_json: metadata });
        const modes = _observationViewModes(data);
        const defaultView = _defaultObservationView(data);
        const key = itemKey(item);
        const stored = itemViewState.get(key);
        let activeMode = stored && modes.some((m) => m.id === stored) ? stored : defaultView;
        itemViewState.set(key, activeMode);
        bodyNode = _renderObservationBody(data, activeMode);
        const setExpandControl = (mode) => {
          footerRight.textContent = "";
          const expandKey2 = `${key}:${mode}`;
          const expanded2 = itemExpandState.get(expandKey2) === true;
          const canClamp2 = shouldClampBody(mode, data);
          if (!canClamp2) return;
          const button = createElement(
            "button",
            "feed-expand",
            expanded2 ? "Collapse" : "Expand"
          );
          button.addEventListener("click", () => {
            const next = !(itemExpandState.get(expandKey2) === true);
            itemExpandState.set(expandKey2, next);
            if (next) {
              bodyNode.classList.remove("clamp", "clamp-3", "clamp-5");
              button.textContent = "Collapse";
            } else {
              bodyNode.classList.add(...clampClass(mode));
              button.textContent = "Expand";
            }
          });
          footerRight.appendChild(button);
        };
        const expandKey = `${key}:${activeMode}`;
        const expanded = itemExpandState.get(expandKey) === true;
        const canClamp = shouldClampBody(activeMode, data);
        if (canClamp && !expanded) {
          bodyNode.classList.add(...clampClass(activeMode));
        }
        setExpandControl(activeMode);
        const toggle = renderItemViewToggle(modes, activeMode, (mode) => {
          activeMode = mode;
          itemViewState.set(key, mode);
          const nextBody = _renderObservationBody(data, mode);
          const nextExpandKey = `${key}:${mode}`;
          const nextExpanded = itemExpandState.get(nextExpandKey) === true;
          const nextCanClamp = shouldClampBody(mode, data);
          if (nextCanClamp && !nextExpanded) {
            nextBody.classList.add(...clampClass(mode));
          }
          card.replaceChild(nextBody, bodyNode);
          bodyNode = nextBody;
          setExpandControl(mode);
          if (toggle) {
            const buttons = Array.from(toggle.querySelectorAll(".toggle-button"));
            buttons.forEach((button) => {
              const value = button.dataset.filter;
              button.classList.toggle("active", value === mode);
            });
          }
        });
        if (toggle) rightWrap.appendChild(toggle);
      }
      rightWrap.appendChild(age);
      header.append(titleWrap, rightWrap);
      const meta = createElement("div", "feed-meta");
      const tags = parseJsonArray(item.tags || []);
      const files = parseJsonArray(item.files || []);
      const project = item.project || "";
      const tagContent = tags.length ? ` · ${tags.map((tag) => formatTagLabel(tag)).join(", ")}` : "";
      const fileContent = files.length ? ` · ${formatFileList(files)}` : "";
      const projectContent = project ? `Project: ${project}` : "Project: n/a";
      meta.textContent = `${projectContent}${tagContent}${fileContent}`;
      const footer = createElement("div", "feed-footer");
      const footerLeft = createElement("div", "feed-footer-left");
      const filesWrap = createElement("div", "feed-files");
      const tagsWrap = createElement("div", "feed-tags");
      files.forEach((file) => {
        const chip = createElement("span", "feed-file", file);
        filesWrap.appendChild(chip);
      });
      tags.forEach((tag) => {
        const chip = createTagChip(tag);
        if (chip) tagsWrap.appendChild(chip);
      });
      if (filesWrap.childElementCount) {
        footerLeft.appendChild(filesWrap);
      }
      if (tagsWrap.childElementCount) {
        footerLeft.appendChild(tagsWrap);
      }
      footer.append(footerLeft, footerRight);
      card.append(header, meta, bodyNode, footer);
      feedList.appendChild(card);
    });
    if (typeof globalThis.lucide !== "undefined")
      globalThis.lucide.createIcons();
  }
  function renderSessionSummary(summary, usagePayload, project) {
    if (!sessionGrid || !sessionMeta) return;
    sessionGrid.textContent = "";
    if (!summary) {
      sessionMeta.textContent = "No injections yet";
      return;
    }
    Number(summary.total || 0);
    usagePayload?.totals_global || usagePayload?.totals || {};
    const totalsFiltered = usagePayload?.totals_filtered || null;
    const isFiltered = !!(project && totalsFiltered);
    const events = Array.isArray(usagePayload?.events) ? usagePayload.events : [];
    const packEvent = events.find((evt) => String(evt?.event || "") === "pack") || null;
    const recentEvent = events.find((evt) => String(evt?.event || "") === "recent") || null;
    const recentKindsEvent = events.find((evt) => String(evt?.event || "") === "recent_kinds") || null;
    const searchEvent = events.find((evt) => String(evt?.event || "") === "search") || null;
    const packCount = Number(packEvent?.count || 0);
    const recentPacks = Array.isArray(usagePayload?.recent_packs) ? usagePayload.recent_packs : [];
    const latestPack = recentPacks.length ? recentPacks[0] : null;
    const lastPackAt = latestPack?.created_at || "";
    const packTokens = Number(latestPack?.tokens_read || 0);
    const savedTokens = Number(latestPack?.tokens_saved || 0);
    const reductionPercent = formatReductionPercent(savedTokens, packTokens);
    const packLine = packCount ? `${packCount} packs` : "No packs yet";
    const lastPackLine = lastPackAt ? `Last pack: ${formatTimestamp(lastPackAt)}` : "";
    const scopeLabel = isFiltered ? "Project" : "All projects";
    sessionMeta.textContent = [scopeLabel, packLine, lastPackLine].filter(Boolean).join(" · ");
    const scopeSuffix = isFiltered ? " (project)" : "";
    const usageDetails = [
      packEvent ? `pack${scopeSuffix}: ${Number(packEvent.count || 0)} events` : null,
      searchEvent ? `search${scopeSuffix}: ${Number(searchEvent.count || 0)} events` : null,
      recentEvent ? `recent${scopeSuffix}: ${Number(recentEvent.count || 0)} gets` : null,
      recentKindsEvent ? `recent_kinds${scopeSuffix}: ${Number(recentKindsEvent.count || 0)} gets` : null
    ].filter(Boolean).join(" · ");
    const items = [
      {
        label: "Last pack savings",
        value: latestPack ? `${savedTokens.toLocaleString()} (${reductionPercent})` : "n/a",
        icon: "trending-up"
      },
      {
        label: "Last pack size",
        value: latestPack ? packTokens.toLocaleString() : "n/a",
        icon: "package"
      },
      {
        label: "Packs",
        value: packCount || 0,
        icon: "archive"
      }
    ];
    if (sessionGrid && usageDetails) {
      sessionGrid.title = usageDetails;
      sessionGrid.style.cursor = "help";
    }
    items.forEach((item) => {
      const block = createElement("div", "stat");
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", item.icon);
      icon.className = "stat-icon";
      const rawValue = item.value;
      const displayValue = typeof rawValue === "number" ? rawValue.toLocaleString() : rawValue === null || rawValue === void 0 ? "n/a" : String(rawValue);
      const value = createElement(
        "div",
        "value",
        displayValue
      );
      const label = createElement("div", "label", item.label);
      const content = createElement("div", "stat-content");
      content.append(value, label);
      block.append(icon, content);
      sessionGrid.appendChild(block);
    });
    if (typeof globalThis.lucide !== "undefined")
      globalThis.lucide.createIcons();
  }
  function renderConfigModal(payload) {
    if (!payload || typeof payload !== "object") return;
    const defaults = payload.defaults || {};
    const config = payload.config || {};
    configDefaults = defaults;
    configPath = payload.path || "";
    const observerProvider = config.observer_provider || "";
    const observerModel = config.observer_model || "";
    const observerMaxChars = config.observer_max_chars || "";
    const packObservationLimit = config.pack_observation_limit || "";
    const packSessionLimit = config.pack_session_limit || "";
    const syncEnabled = config.sync_enabled || false;
    const syncHost = config.sync_host || "";
    const syncPort = config.sync_port || "";
    const syncInterval = config.sync_interval_s || "";
    const syncMdns = config.sync_mdns || false;
    if (observerProviderInput) observerProviderInput.value = observerProvider;
    if (observerModelInput) observerModelInput.value = observerModel;
    if (observerMaxCharsInput) observerMaxCharsInput.value = observerMaxChars;
    if (packObservationLimitInput)
      packObservationLimitInput.value = packObservationLimit;
    if (packSessionLimitInput) packSessionLimitInput.value = packSessionLimit;
    if (syncEnabledInput) syncEnabledInput.checked = Boolean(syncEnabled);
    if (syncHostInput) syncHostInput.value = syncHost;
    if (syncPortInput) syncPortInput.value = syncPort;
    if (syncIntervalInput) syncIntervalInput.value = syncInterval;
    if (syncMdnsInput) syncMdnsInput.checked = Boolean(syncMdns);
    if (settingsPath)
      settingsPath.textContent = configPath ? `Config path: ${configPath}` : "Config path: n/a";
    if (observerMaxCharsHint) {
      const defaultValue = configDefaults?.observer_max_chars || "";
      observerMaxCharsHint.textContent = defaultValue ? `Default: ${defaultValue}` : "";
    }
    if (settingsEffective) {
      const hasOverrides = Boolean(payload.env_overrides);
      settingsEffective.textContent = hasOverrides ? "Effective config differs (env overrides active)" : "";
    }
    setSettingsDirty(false);
    if (settingsStatus) settingsStatus.textContent = "Ready";
  }
  function openSettings() {
    stopPolling();
    setRefreshStatus("paused", "(settings)");
    if (settingsBackdrop) settingsBackdrop.hidden = false;
    if (settingsModal) settingsModal.hidden = false;
  }
  function closeSettings() {
    if (settingsDirty) {
      const ok = globalThis.confirm("Discard unsaved changes?");
      if (!ok) return;
    }
    if (settingsBackdrop) settingsBackdrop.hidden = true;
    if (settingsModal) settingsModal.hidden = true;
    startPolling();
    refresh();
  }
  settingsButton?.addEventListener("click", openSettings);
  settingsClose?.addEventListener("click", closeSettings);
  settingsBackdrop?.addEventListener("click", closeSettings);
  settingsModal?.addEventListener("click", (event) => {
    if (event.target === settingsModal) {
      closeSettings();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isSettingsOpen()) {
      closeSettings();
    }
  });
  [
    observerProviderInput,
    observerModelInput,
    observerMaxCharsInput,
    packObservationLimitInput,
    packSessionLimitInput,
    syncEnabledInput,
    syncHostInput,
    syncPortInput,
    syncIntervalInput,
    syncMdnsInput
  ].forEach((input) => {
    if (!input) return;
    input.addEventListener("input", () => setSettingsDirty(true));
    input.addEventListener("change", () => setSettingsDirty(true));
  });
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
        sync_interval_s: Number(syncIntervalInput?.value || 0) || "",
        sync_mdns: syncMdnsInput?.checked || false
      };
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const message = await resp.text();
        throw new Error(message);
      }
      settingsStatus.textContent = "Saved";
      setSettingsDirty(false);
      closeSettings();
    } catch {
      settingsStatus.textContent = "Save failed";
    } finally {
      settingsSave.disabled = !settingsDirty;
    }
  }
  settingsSave?.addEventListener("click", saveSettings);
  async function loadStats() {
    try {
      const [statsResp, usageResp, sessionsResp, rawEventsResp] = await Promise.all([
        fetch("/api/stats"),
        fetch(`/api/usage?project=${encodeURIComponent(currentProject || "")}`),
        fetch(
          `/api/session?project=${encodeURIComponent(currentProject || "")}`
        ),
        fetch(
          `/api/raw-events?project=${encodeURIComponent(currentProject || "")}`
        )
      ]);
      const statsPayload = await statsResp.json();
      const usagePayload = usageResp.ok ? await usageResp.json() : {};
      const sessionsPayload = sessionsResp.ok ? await sessionsResp.json() : {};
      const rawEventsPayload = rawEventsResp.ok ? await rawEventsResp.json() : {};
      const stats = statsPayload || {};
      const sessions = sessionsPayload || {};
      const rawEvents = rawEventsPayload || {};
      lastStatsPayload = stats;
      lastUsagePayload = usagePayload || {};
      lastRawEventsPayload = rawEvents;
      renderStats(stats, usagePayload, currentProject, rawEvents);
      renderSessionSummary(sessions, usagePayload, currentProject);
      if (!lastSyncStatus) {
        renderSyncHealth(stats.sync_health || {});
      }
      renderHealthOverview();
    } catch {
      if (metaLine) metaLine.textContent = "Stats unavailable";
    }
  }
  async function loadFeed() {
    try {
      setRefreshStatus("refreshing");
      const [observationsResp, summariesResp] = await Promise.all([
        fetch(
          `/api/memories?project=${encodeURIComponent(currentProject || "")}`
        ),
        fetch(
          `/api/summaries?project=${encodeURIComponent(currentProject || "")}`
        )
      ]);
      const observations = await observationsResp.json();
      const summaries = await summariesResp.json();
      const summaryItems = summaries.items || [];
      const observationItems = observations.items || [];
      const filteredObservations = observationItems.filter(
        (item) => !isLowSignalObservation(item)
      );
      const filteredCount = observationItems.length - filteredObservations.length;
      const feedItems = [...summaryItems, ...filteredObservations].sort(
        (a, b) => {
          const left = new Date(a.created_at || 0).getTime();
          const right = new Date(b.created_at || 0).getTime();
          return right - left;
        }
      );
      const incomingNewCount = countNewItems(feedItems, lastFeedItems);
      if (incomingNewCount) {
        const seen = new Set(lastFeedItems.map(itemKey));
        feedItems.forEach((item) => {
          const key = itemKey(item);
          if (!seen.has(key)) newItemKeys.add(key);
        });
      }
      pendingFeedItems = null;
      lastFeedItems = feedItems;
      lastFeedFilteredCount = filteredCount;
      updateFeedView();
      setRefreshStatus("idle");
    } catch {
      setRefreshStatus("error");
    }
  }
  async function loadConfig() {
    if (isSettingsOpen()) {
      return;
    }
    try {
      const resp = await fetch("/api/config");
      if (!resp.ok) return;
      const payload = await resp.json();
      renderConfigModal(payload);
      hideSettingsOverrideNotice(payload.config || {});
    } catch {
    }
  }
  async function loadSyncStatus() {
    try {
      const diag = isSyncDiagnosticsOpen();
      const diagParam = diag ? "?includeDiagnostics=1" : "";
      const resp = await fetch(`/api/sync/status${diagParam}`);
      if (!resp.ok) return;
      const payload = await resp.json();
      const statusPayload = payload.status && typeof payload.status === "object" ? payload.status : null;
      if (statusPayload) {
        lastSyncStatus = statusPayload;
      }
      lastSyncPeers = payload.peers || [];
      lastSyncAttempts = payload.attempts || [];
      renderSyncStatus(lastSyncStatus);
      renderSyncPeers(lastSyncPeers);
      renderSyncAttempts(lastSyncAttempts);
      renderHealthOverview();
      renderSyncHealth({
        status: lastSyncStatus?.daemon_state || "unknown",
        details: lastSyncStatus?.daemon_state === "error" ? "daemon error" : ""
      });
    } catch {
      if (syncMeta) syncMeta.textContent = "Sync unavailable";
    }
  }
  async function loadPairing() {
    try {
      const resp = await fetch("/api/sync/pairing?includeDiagnostics=1");
      if (!resp.ok) return;
      const payload = await resp.json();
      pairingPayloadRaw = payload || null;
      renderPairing(payload || null);
    } catch {
      renderPairing(null);
    }
  }
  async function loadProjects() {
    try {
      const resp = await fetch("/api/projects");
      if (!resp.ok) return;
      const payload = await resp.json();
      const projects = payload.projects || [];
      if (!projectFilter) return;
      projectFilter.textContent = "";
      const allOption = createElement(
        "option",
        null,
        "All Projects"
      );
      allOption.value = "";
      projectFilter.appendChild(allOption);
      projects.forEach((project) => {
        const option = createElement(
          "option",
          null,
          project
        );
        option.value = project;
        projectFilter.appendChild(option);
      });
    } catch {
    }
  }
  projectFilter?.addEventListener("change", () => {
    currentProject = projectFilter.value || "";
    refresh();
  });
  async function refresh() {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    try {
      await Promise.all([
        loadStats(),
        loadFeed(),
        loadConfig(),
        loadSyncStatus()
      ]);
      if (isSyncPairingOpen()) {
        loadPairing();
      } else {
        pairingPayloadRaw = null;
        pairingCommandRaw = "";
        if (syncPairing) syncPairing.hidden = true;
      }
    } finally {
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        refresh();
      }
    }
  }
  loadProjects();
  refresh();
  startPolling();
})();
