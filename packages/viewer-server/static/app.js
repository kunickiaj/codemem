(function() {
	//#region \0rolldown/runtime.js
	var __defProp = Object.defineProperty;
	var __exportAll = (all, no_symbols) => {
		let target = {};
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
		if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
		return target;
	};
	//#endregion
	//#region src/lib/dom.ts
	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== void 0 && text !== null) node.textContent = String(text);
		return node;
	}
	function $$2(id) {
		return document.getElementById(id);
	}
	function $select(id) {
		return document.getElementById(id);
	}
	function $button(id) {
		return document.getElementById(id);
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
			return safe.replace(re, "<mark class=\"match\">$1</mark>");
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
	//#endregion
	//#region src/lib/theme.ts
	var THEME_OPTIONS = [{
		id: "light",
		label: "Light",
		mode: "light"
	}, {
		id: "dark",
		label: "Dark",
		mode: "dark"
	}];
	var THEME_STORAGE_KEY = "codemem-theme";
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
		if (selected.id === selected.mode) document.documentElement.removeAttribute("data-theme-variant");
		else document.documentElement.setAttribute("data-theme-variant", selected.id);
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
	//#endregion
	//#region src/lib/state.ts
	var TAB_KEY = "codemem-tab";
	var FEED_FILTER_KEY = "codemem-feed-filter";
	var FEED_SCOPE_KEY = "codemem-feed-scope";
	var SYNC_DIAGNOSTICS_KEY = "codemem-sync-diagnostics";
	var SYNC_PAIRING_KEY = "codemem-sync-pairing";
	var SYNC_REDACT_KEY = "codemem-sync-redact";
	var FEED_FILTERS = [
		"all",
		"observations",
		"summaries"
	];
	var FEED_SCOPES = [
		"all",
		"mine",
		"theirs"
	];
	var state = {
		activeTab: "feed",
		currentProject: "",
		refreshState: "idle",
		refreshInFlight: false,
		refreshQueued: false,
		refreshTimer: null,
		feedTypeFilter: "all",
		feedScopeFilter: "all",
		feedQuery: "",
		lastFeedItems: [],
		lastFeedFilteredCount: 0,
		lastFeedSignature: "",
		pendingFeedItems: null,
		itemViewState: /* @__PURE__ */ new Map(),
		itemExpandState: /* @__PURE__ */ new Map(),
		newItemKeys: /* @__PURE__ */ new Set(),
		lastStatsPayload: null,
		lastUsagePayload: null,
		lastRawEventsPayload: null,
		lastSyncStatus: null,
		lastSyncActors: [],
		lastSyncPeers: [],
		pendingAcceptedSyncPeers: [],
		lastSyncSharingReview: [],
		lastSyncCoordinator: null,
		lastSyncJoinRequests: [],
		lastTeamInvite: null,
		lastTeamJoin: null,
		syncJoinFlowFeedback: null,
		syncPeerFeedbackById: /* @__PURE__ */ new Map(),
		syncPeersSectionFeedback: null,
		syncJoinRequestsFeedback: null,
		syncDiscoveredFeedback: null,
		lastSyncAttempts: [],
		lastSyncLegacyDevices: [],
		lastSyncViewModel: null,
		lastSyncDuplicatePersonDecisions: {},
		pairingPayloadRaw: null,
		pairingCommandRaw: "",
		configDefaults: {},
		configPath: "",
		settingsDirty: false,
		noticeTimer: null,
		syncDiagnosticsOpen: false,
		syncPairingOpen: false
	};
	function getActiveTab() {
		const hash = window.location.hash.replace("#", "");
		if ([
			"feed",
			"health",
			"sync"
		].includes(hash)) return hash;
		const saved = localStorage.getItem(TAB_KEY);
		if (saved && [
			"feed",
			"health",
			"sync"
		].includes(saved)) return saved;
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
		} catch {}
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
	//#endregion
	//#region src/lib/api.ts
	function payloadError(payload) {
		if (!payload || typeof payload !== "object") return void 0;
		const maybeError = payload.error;
		return typeof maybeError === "string" ? maybeError : void 0;
	}
	async function fetchJson(url) {
		const resp = await fetch(url);
		if (!resp.ok) throw new Error(`${url}: ${resp.status} ${resp.statusText}`);
		return resp.json();
	}
	async function pingViewerReady(timeoutMs = 1200) {
		const controller = new AbortController();
		const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
		try {
			const resp = await fetch("/api/stats", {
				cache: "no-store",
				signal: controller.signal
			});
			if (!resp.ok) throw new Error(`/api/stats: ${resp.status} ${resp.statusText}`);
		} finally {
			window.clearTimeout(timeoutId);
		}
	}
	async function readJsonPayload(resp) {
		const text = await resp.text();
		try {
			return {
				text,
				payload: text ? JSON.parse(text) : {}
			};
		} catch {
			return {
				text,
				payload: {}
			};
		}
	}
	async function loadStats() {
		return fetchJson("/api/stats");
	}
	async function loadRuntimeInfo() {
		return fetchJson("/api/runtime");
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
		return fetchJson(`/api/observations?${buildProjectParams(project, options?.limit, options?.offset, options?.scope)}`);
	}
	async function updateMemoryVisibility(memoryId, visibility) {
		const resp = await fetch("/api/memories/visibility", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				memory_id: memoryId,
				visibility
			})
		});
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
		return payload;
	}
	async function loadSummariesPage(project, options) {
		return fetchJson(`/api/summaries?${buildProjectParams(project, options?.limit, options?.offset, options?.scope)}`);
	}
	async function tracePack(payload) {
		const resp = await fetch("/api/pack/trace", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		});
		const { text, payload: data } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
		return data;
	}
	async function loadObserverStatus() {
		return fetchJson("/api/observer-status");
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
		if (text) try {
			parsed = JSON.parse(text);
		} catch {}
		if (!resp.ok) {
			const message = parsed && typeof parsed.error === "string" ? parsed.error : text || "request failed";
			throw new Error(message);
		}
		return parsed;
	}
	async function loadSyncStatus(includeDiagnostics, project = "", options) {
		const params = new URLSearchParams();
		if (includeDiagnostics) params.set("includeDiagnostics", "1");
		if (project) params.set("project", project);
		if (options?.includeJoinRequests) params.set("includeJoinRequests", "1");
		return fetchJson(`/api/sync/status${params.size ? `?${params.toString()}` : ""}`);
	}
	async function createCoordinatorInvite(payload) {
		const resp = await fetch("/api/sync/invites/create", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		});
		const { text, payload: data } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
		return data;
	}
	async function importCoordinatorInvite(invite) {
		const resp = await fetch("/api/sync/invites/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ invite })
		});
		const { text, payload: data } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
		return data;
	}
	async function reviewJoinRequest(requestId, action) {
		const resp = await fetch("/api/sync/join-requests/review", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				request_id: requestId,
				action
			})
		});
		const { text, payload: data } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
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
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
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
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
		return payload;
	}
	async function deletePeer(peerDeviceId) {
		const resp = await fetch(`/api/sync/peers/${encodeURIComponent(peerDeviceId)}`, { method: "DELETE" });
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
		return payload;
	}
	async function renamePeer(peerDeviceId, name) {
		const resp = await fetch("/api/sync/peers/rename", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				peer_device_id: peerDeviceId,
				name
			})
		});
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
		return payload;
	}
	async function acceptDiscoveredPeer(peerDeviceId, fingerprint) {
		const resp = await fetch("/api/sync/peers/accept-discovered", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				peer_device_id: peerDeviceId,
				fingerprint
			})
		});
		const text = await resp.text();
		let payload = {};
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			payload = {};
		}
		const detail = typeof payload?.detail === "string" ? payload.detail : void 0;
		if (!resp.ok) throw new Error(detail || payloadError(payload) || text || "request failed");
		return payload;
	}
	async function createActor(displayName) {
		const resp = await fetch("/api/sync/actors", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ display_name: displayName })
		});
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
		return payload;
	}
	async function renameActor(actorId, displayName) {
		const resp = await fetch("/api/sync/actors/rename", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				actor_id: actorId,
				display_name: displayName
			})
		});
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
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
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
		return payload;
	}
	async function deactivateActor(actorId) {
		const resp = await fetch("/api/sync/actors/deactivate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ actor_id: actorId })
		});
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
		return payload;
	}
	async function claimLegacyDeviceIdentity(originDeviceId) {
		const resp = await fetch("/api/sync/legacy-devices/claim", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ origin_device_id: originDeviceId })
		});
		const { text, payload } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
		return payload;
	}
	async function loadProjects$1() {
		return (await fetchJson("/api/projects")).projects || [];
	}
	async function triggerSync(address) {
		const payload = address ? { address } : {};
		const resp = await fetch("/api/sync/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		});
		const { text, payload: body } = await readJsonPayload(resp);
		if (!resp.ok) throw new Error(payloadError(body) || text || "request failed");
		if (!text) throw new Error("empty sync response");
		if (!Array.isArray(body?.items)) throw new Error(text || "invalid sync response");
		return body;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/preact@10.29.0/node_modules/preact/dist/preact.module.js
	var n, l$1, u$2, i$2, r$1, o$2, e$1, f$2, c$1, s$1, a$1, h$1, p$1 = {}, v$1 = [], y$1 = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i, d$1 = Array.isArray;
	function w$2(n, l) {
		for (var u in l) n[u] = l[u];
		return n;
	}
	function g$2(n) {
		n && n.parentNode && n.parentNode.removeChild(n);
	}
	function _$1(l, u, t) {
		var i, r, o, e = {};
		for (o in u) "key" == o ? i = u[o] : "ref" == o ? r = u[o] : e[o] = u[o];
		if (arguments.length > 2 && (e.children = arguments.length > 3 ? n.call(arguments, 2) : t), "function" == typeof l && null != l.defaultProps) for (o in l.defaultProps) void 0 === e[o] && (e[o] = l.defaultProps[o]);
		return m$1(l, e, i, r, null);
	}
	function m$1(n, t, i, r, o) {
		var e = {
			type: n,
			props: t,
			key: i,
			ref: r,
			__k: null,
			__: null,
			__b: 0,
			__e: null,
			__c: null,
			constructor: void 0,
			__v: null == o ? ++u$2 : o,
			__i: -1,
			__u: 0
		};
		return null == o && null != l$1.vnode && l$1.vnode(e), e;
	}
	function b$1() {
		return { current: null };
	}
	function k$2(n) {
		return n.children;
	}
	function x$2(n, l) {
		this.props = n, this.context = l;
	}
	function S(n, l) {
		if (null == l) return n.__ ? S(n.__, n.__i + 1) : null;
		for (var u; l < n.__k.length; l++) if (null != (u = n.__k[l]) && null != u.__e) return u.__e;
		return "function" == typeof n.type ? S(n) : null;
	}
	function C$2(n) {
		if (n.__P && n.__d) {
			var u = n.__v, t = u.__e, i = [], r = [], o = w$2({}, u);
			o.__v = u.__v + 1, l$1.vnode && l$1.vnode(o), z$2(n.__P, o, u, n.__n, n.__P.namespaceURI, 32 & u.__u ? [t] : null, i, null == t ? S(u) : t, !!(32 & u.__u), r), o.__v = u.__v, o.__.__k[o.__i] = o, V$1(i, o, r), u.__e = u.__ = null, o.__e != t && M$1(o);
		}
	}
	function M$1(n) {
		if (null != (n = n.__) && null != n.__c) return n.__e = n.__c.base = null, n.__k.some(function(l) {
			if (null != l && null != l.__e) return n.__e = n.__c.base = l.__e;
		}), M$1(n);
	}
	function $$1(n) {
		(!n.__d && (n.__d = !0) && i$2.push(n) && !I$1.__r++ || r$1 != l$1.debounceRendering) && ((r$1 = l$1.debounceRendering) || o$2)(I$1);
	}
	function I$1() {
		try {
			for (var n, l = 1; i$2.length;) i$2.length > l && i$2.sort(e$1), n = i$2.shift(), l = i$2.length, C$2(n);
		} finally {
			i$2.length = I$1.__r = 0;
		}
	}
	function P$2(n, l, u, t, i, r, o, e, f, c, s) {
		var a, h, y, d, w, g, _, m = t && t.__k || v$1, b = l.length;
		for (f = A$2(u, l, m, f, b), a = 0; a < b; a++) null != (y = u.__k[a]) && (h = -1 != y.__i && m[y.__i] || p$1, y.__i = a, g = z$2(n, y, h, i, r, o, e, f, c, s), d = y.__e, y.ref && h.ref != y.ref && (h.ref && D$2(h.ref, null, y), s.push(y.ref, y.__c || d, y)), null == w && null != d && (w = d), (_ = !!(4 & y.__u)) || h.__k === y.__k ? f = H$1(y, f, n, _) : "function" == typeof y.type && void 0 !== g ? f = g : d && (f = d.nextSibling), y.__u &= -7);
		return u.__e = w, f;
	}
	function A$2(n, l, u, t, i) {
		var r, o, e, f, c, s = u.length, a = s, h = 0;
		for (n.__k = new Array(i), r = 0; r < i; r++) null != (o = l[r]) && "boolean" != typeof o && "function" != typeof o ? ("string" == typeof o || "number" == typeof o || "bigint" == typeof o || o.constructor == String ? o = n.__k[r] = m$1(null, o, null, null, null) : d$1(o) ? o = n.__k[r] = m$1(k$2, { children: o }, null, null, null) : void 0 === o.constructor && o.__b > 0 ? o = n.__k[r] = m$1(o.type, o.props, o.key, o.ref ? o.ref : null, o.__v) : n.__k[r] = o, f = r + h, o.__ = n, o.__b = n.__b + 1, e = null, -1 != (c = o.__i = T$2(o, u, f, a)) && (a--, (e = u[c]) && (e.__u |= 2)), null == e || null == e.__v ? (-1 == c && (i > s ? h-- : i < s && h++), "function" != typeof o.type && (o.__u |= 4)) : c != f && (c == f - 1 ? h-- : c == f + 1 ? h++ : (c > f ? h-- : h++, o.__u |= 4))) : n.__k[r] = null;
		if (a) for (r = 0; r < s; r++) null != (e = u[r]) && 0 == (2 & e.__u) && (e.__e == t && (t = S(e)), E$1(e, e));
		return t;
	}
	function H$1(n, l, u, t) {
		var i, r;
		if ("function" == typeof n.type) {
			for (i = n.__k, r = 0; i && r < i.length; r++) i[r] && (i[r].__ = n, l = H$1(i[r], l, u, t));
			return l;
		}
		n.__e != l && (t && (l && n.type && !l.parentNode && (l = S(n)), u.insertBefore(n.__e, l || null)), l = n.__e);
		do
			l = l && l.nextSibling;
		while (null != l && 8 == l.nodeType);
		return l;
	}
	function L$1(n, l) {
		return l = l || [], null == n || "boolean" == typeof n || (d$1(n) ? n.some(function(n) {
			L$1(n, l);
		}) : l.push(n)), l;
	}
	function T$2(n, l, u, t) {
		var i, r, o, e = n.key, f = n.type, c = l[u], s = null != c && 0 == (2 & c.__u);
		if (null === c && null == e || s && e == c.key && f == c.type) return u;
		if (t > (s ? 1 : 0)) {
			for (i = u - 1, r = u + 1; i >= 0 || r < l.length;) if (null != (c = l[o = i >= 0 ? i-- : r++]) && 0 == (2 & c.__u) && e == c.key && f == c.type) return o;
		}
		return -1;
	}
	function j$2(n, l, u) {
		"-" == l[0] ? n.setProperty(l, null == u ? "" : u) : n[l] = null == u ? "" : "number" != typeof u || y$1.test(l) ? u : u + "px";
	}
	function F$2(n, l, u, t, i) {
		var r, o;
		n: if ("style" == l) if ("string" == typeof u) n.style.cssText = u;
		else {
			if ("string" == typeof t && (n.style.cssText = t = ""), t) for (l in t) u && l in u || j$2(n.style, l, "");
			if (u) for (l in u) t && u[l] == t[l] || j$2(n.style, l, u[l]);
		}
		else if ("o" == l[0] && "n" == l[1]) r = l != (l = l.replace(f$2, "$1")), o = l.toLowerCase(), l = o in n || "onFocusOut" == l || "onFocusIn" == l ? o.slice(2) : l.slice(2), n.l || (n.l = {}), n.l[l + r] = u, u ? t ? u.u = t.u : (u.u = c$1, n.addEventListener(l, r ? a$1 : s$1, r)) : n.removeEventListener(l, r ? a$1 : s$1, r);
		else {
			if ("http://www.w3.org/2000/svg" == i) l = l.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
			else if ("width" != l && "height" != l && "href" != l && "list" != l && "form" != l && "tabIndex" != l && "download" != l && "rowSpan" != l && "colSpan" != l && "role" != l && "popover" != l && l in n) try {
				n[l] = null == u ? "" : u;
				break n;
			} catch (n) {}
			"function" == typeof u || (null == u || !1 === u && "-" != l[4] ? n.removeAttribute(l) : n.setAttribute(l, "popover" == l && 1 == u ? "" : u));
		}
	}
	function O$1(n) {
		return function(u) {
			if (this.l) {
				var t = this.l[u.type + n];
				if (null == u.t) u.t = c$1++;
				else if (u.t < t.u) return;
				return t(l$1.event ? l$1.event(u) : u);
			}
		};
	}
	function z$2(n, u, t, i, r, o, e, f, c, s) {
		var a, h, p, y, _, m, b, S, C, M, $, I, A, H, L, T = u.type;
		if (void 0 !== u.constructor) return null;
		128 & t.__u && (c = !!(32 & t.__u), o = [f = u.__e = t.__e]), (a = l$1.__b) && a(u);
		n: if ("function" == typeof T) try {
			if (S = u.props, C = T.prototype && T.prototype.render, M = (a = T.contextType) && i[a.__c], $ = a ? M ? M.props.value : a.__ : i, t.__c ? b = (h = u.__c = t.__c).__ = h.__E : (C ? u.__c = h = new T(S, $) : (u.__c = h = new x$2(S, $), h.constructor = T, h.render = G$1), M && M.sub(h), h.state || (h.state = {}), h.__n = i, p = h.__d = !0, h.__h = [], h._sb = []), C && null == h.__s && (h.__s = h.state), C && null != T.getDerivedStateFromProps && (h.__s == h.state && (h.__s = w$2({}, h.__s)), w$2(h.__s, T.getDerivedStateFromProps(S, h.__s))), y = h.props, _ = h.state, h.__v = u, p) C && null == T.getDerivedStateFromProps && null != h.componentWillMount && h.componentWillMount(), C && null != h.componentDidMount && h.__h.push(h.componentDidMount);
			else {
				if (C && null == T.getDerivedStateFromProps && S !== y && null != h.componentWillReceiveProps && h.componentWillReceiveProps(S, $), u.__v == t.__v || !h.__e && null != h.shouldComponentUpdate && !1 === h.shouldComponentUpdate(S, h.__s, $)) {
					u.__v != t.__v && (h.props = S, h.state = h.__s, h.__d = !1), u.__e = t.__e, u.__k = t.__k, u.__k.some(function(n) {
						n && (n.__ = u);
					}), v$1.push.apply(h.__h, h._sb), h._sb = [], h.__h.length && e.push(h);
					break n;
				}
				null != h.componentWillUpdate && h.componentWillUpdate(S, h.__s, $), C && null != h.componentDidUpdate && h.__h.push(function() {
					h.componentDidUpdate(y, _, m);
				});
			}
			if (h.context = $, h.props = S, h.__P = n, h.__e = !1, I = l$1.__r, A = 0, C) h.state = h.__s, h.__d = !1, I && I(u), a = h.render(h.props, h.state, h.context), v$1.push.apply(h.__h, h._sb), h._sb = [];
			else do
				h.__d = !1, I && I(u), a = h.render(h.props, h.state, h.context), h.state = h.__s;
			while (h.__d && ++A < 25);
			h.state = h.__s, null != h.getChildContext && (i = w$2(w$2({}, i), h.getChildContext())), C && !p && null != h.getSnapshotBeforeUpdate && (m = h.getSnapshotBeforeUpdate(y, _)), H = null != a && a.type === k$2 && null == a.key ? q$2(a.props.children) : a, f = P$2(n, d$1(H) ? H : [H], u, t, i, r, o, e, f, c, s), h.base = u.__e, u.__u &= -161, h.__h.length && e.push(h), b && (h.__E = h.__ = null);
		} catch (n) {
			if (u.__v = null, c || null != o) if (n.then) {
				for (u.__u |= c ? 160 : 128; f && 8 == f.nodeType && f.nextSibling;) f = f.nextSibling;
				o[o.indexOf(f)] = null, u.__e = f;
			} else {
				for (L = o.length; L--;) g$2(o[L]);
				N$1(u);
			}
			else u.__e = t.__e, u.__k = t.__k, n.then || N$1(u);
			l$1.__e(n, u, t);
		}
		else null == o && u.__v == t.__v ? (u.__k = t.__k, u.__e = t.__e) : f = u.__e = B$2(t.__e, u, t, i, r, o, e, c, s);
		return (a = l$1.diffed) && a(u), 128 & u.__u ? void 0 : f;
	}
	function N$1(n) {
		n && (n.__c && (n.__c.__e = !0), n.__k && n.__k.some(N$1));
	}
	function V$1(n, u, t) {
		for (var i = 0; i < t.length; i++) D$2(t[i], t[++i], t[++i]);
		l$1.__c && l$1.__c(u, n), n.some(function(u) {
			try {
				n = u.__h, u.__h = [], n.some(function(n) {
					n.call(u);
				});
			} catch (n) {
				l$1.__e(n, u.__v);
			}
		});
	}
	function q$2(n) {
		return "object" != typeof n || null == n || n.__b > 0 ? n : d$1(n) ? n.map(q$2) : w$2({}, n);
	}
	function B$2(u, t, i, r, o, e, f, c, s) {
		var a, h, v, y, w, _, m, b = i.props || p$1, k = t.props, x = t.type;
		if ("svg" == x ? o = "http://www.w3.org/2000/svg" : "math" == x ? o = "http://www.w3.org/1998/Math/MathML" : o || (o = "http://www.w3.org/1999/xhtml"), null != e) {
			for (a = 0; a < e.length; a++) if ((w = e[a]) && "setAttribute" in w == !!x && (x ? w.localName == x : 3 == w.nodeType)) {
				u = w, e[a] = null;
				break;
			}
		}
		if (null == u) {
			if (null == x) return document.createTextNode(k);
			u = document.createElementNS(o, x, k.is && k), c && (l$1.__m && l$1.__m(t, e), c = !1), e = null;
		}
		if (null == x) b === k || c && u.data == k || (u.data = k);
		else {
			if (e = e && n.call(u.childNodes), !c && null != e) for (b = {}, a = 0; a < u.attributes.length; a++) b[(w = u.attributes[a]).name] = w.value;
			for (a in b) w = b[a], "dangerouslySetInnerHTML" == a ? v = w : "children" == a || a in k || "value" == a && "defaultValue" in k || "checked" == a && "defaultChecked" in k || F$2(u, a, null, w, o);
			for (a in k) w = k[a], "children" == a ? y = w : "dangerouslySetInnerHTML" == a ? h = w : "value" == a ? _ = w : "checked" == a ? m = w : c && "function" != typeof w || b[a] === w || F$2(u, a, w, b[a], o);
			if (h) c || v && (h.__html == v.__html || h.__html == u.innerHTML) || (u.innerHTML = h.__html), t.__k = [];
			else if (v && (u.innerHTML = ""), P$2("template" == t.type ? u.content : u, d$1(y) ? y : [y], t, i, r, "foreignObject" == x ? "http://www.w3.org/1999/xhtml" : o, e, f, e ? e[0] : i.__k && S(i, 0), c, s), null != e) for (a = e.length; a--;) g$2(e[a]);
			c || (a = "value", "progress" == x && null == _ ? u.removeAttribute("value") : null != _ && (_ !== u[a] || "progress" == x && !_ || "option" == x && _ != b[a]) && F$2(u, a, _, b[a], o), a = "checked", null != m && m != u[a] && F$2(u, a, m, b[a], o));
		}
		return u;
	}
	function D$2(n, u, t) {
		try {
			if ("function" == typeof n) {
				var i = "function" == typeof n.__u;
				i && n.__u(), i && null == u || (n.__u = n(u));
			} else n.current = u;
		} catch (n) {
			l$1.__e(n, t);
		}
	}
	function E$1(n, u, t) {
		var i, r;
		if (l$1.unmount && l$1.unmount(n), (i = n.ref) && (i.current && i.current != n.__e || D$2(i, null, u)), null != (i = n.__c)) {
			if (i.componentWillUnmount) try {
				i.componentWillUnmount();
			} catch (n) {
				l$1.__e(n, u);
			}
			i.base = i.__P = null;
		}
		if (i = n.__k) for (r = 0; r < i.length; r++) i[r] && E$1(i[r], u, t || "function" != typeof n.type);
		t || g$2(n.__e), n.__c = n.__ = n.__e = void 0;
	}
	function G$1(n, l, u) {
		return this.constructor(n, u);
	}
	function J$1(u, t, i) {
		var r, o, e, f;
		t == document && (t = document.documentElement), l$1.__ && l$1.__(u, t), o = (r = "function" == typeof i) ? null : i && i.__k || t.__k, e = [], f = [], z$2(t, u = (!r && i || t).__k = _$1(k$2, null, [u]), o || p$1, p$1, t.namespaceURI, !r && i ? [i] : o ? null : t.firstChild ? n.call(t.childNodes) : null, e, !r && i ? i : o ? o.__e : t.firstChild, r, f), V$1(e, u, f);
	}
	function K$1(n, l) {
		J$1(n, l, K$1);
	}
	function Q$1(l, u, t) {
		var i, r, o, e, f = w$2({}, l.props);
		for (o in l.type && l.type.defaultProps && (e = l.type.defaultProps), u) "key" == o ? i = u[o] : "ref" == o ? r = u[o] : f[o] = void 0 === u[o] && null != e ? e[o] : u[o];
		return arguments.length > 2 && (f.children = arguments.length > 3 ? n.call(arguments, 2) : t), m$1(l.type, f, i || l.key, r || l.ref, null);
	}
	function R$1(n) {
		function l(n) {
			var u, t;
			return this.getChildContext || (u = /* @__PURE__ */ new Set(), (t = {})[l.__c] = this, this.getChildContext = function() {
				return t;
			}, this.componentWillUnmount = function() {
				u = null;
			}, this.shouldComponentUpdate = function(n) {
				this.props.value != n.value && u.forEach(function(n) {
					n.__e = !0, $$1(n);
				});
			}, this.sub = function(n) {
				u.add(n);
				var l = n.componentWillUnmount;
				n.componentWillUnmount = function() {
					u && u.delete(n), l && l.call(n);
				};
			}), n.children;
		}
		return l.__c = "__cC" + h$1++, l.__ = n, l.Provider = l.__l = (l.Consumer = function(n, l) {
			return n.children(l);
		}).contextType = l, l;
	}
	n = v$1.slice, l$1 = { __e: function(n, l, u, t) {
		for (var i, r, o; l = l.__;) if ((i = l.__c) && !i.__) try {
			if ((r = i.constructor) && null != r.getDerivedStateFromError && (i.setState(r.getDerivedStateFromError(n)), o = i.__d), null != i.componentDidCatch && (i.componentDidCatch(n, t || {}), o = i.__d), o) return i.__E = i;
		} catch (l) {
			n = l;
		}
		throw n;
	} }, u$2 = 0, x$2.prototype.setState = function(n, l) {
		var u = null != this.__s && this.__s != this.state ? this.__s : this.__s = w$2({}, this.state);
		"function" == typeof n && (n = n(w$2({}, u), this.props)), n && w$2(u, n), null != n && this.__v && (l && this._sb.push(l), $$1(this));
	}, x$2.prototype.forceUpdate = function(n) {
		this.__v && (this.__e = !0, n && this.__h.push(n), $$1(this));
	}, x$2.prototype.render = k$2, i$2 = [], o$2 = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e$1 = function(n, l) {
		return n.__v.__b - l.__v.__b;
	}, I$1.__r = 0, f$2 = /(PointerCapture)$|Capture$/i, c$1 = 0, s$1 = O$1(!1), a$1 = O$1(!0), h$1 = 0;
	//#endregion
	//#region ../../node_modules/.pnpm/preact@10.29.0/node_modules/preact/hooks/dist/hooks.module.js
	var t, r, u$1, i$1, o$1 = 0, f$1 = [], c = l$1, e = c.__b, a = c.__r, v = c.diffed, l = c.__c, m = c.unmount, s = c.__;
	function p(n, t) {
		c.__h && c.__h(r, n, o$1 || t), o$1 = 0;
		var u = r.__H || (r.__H = {
			__: [],
			__h: []
		});
		return n >= u.__.length && u.__.push({}), u.__[n];
	}
	function d(n) {
		return o$1 = 1, h(D$1, n);
	}
	function h(n, u, i) {
		var o = p(t++, 2);
		if (o.t = n, !o.__c && (o.__ = [i ? i(u) : D$1(void 0, u), function(n) {
			var t = o.__N ? o.__N[0] : o.__[0], r = o.t(t, n);
			t !== r && (o.__N = [r, o.__[1]], o.__c.setState({}));
		}], o.__c = r, !r.__f)) {
			var f = function(n, t, r) {
				if (!o.__c.__H) return !0;
				var u = o.__c.__H.__.filter(function(n) {
					return n.__c;
				});
				if (u.every(function(n) {
					return !n.__N;
				})) return !c || c.call(this, n, t, r);
				var i = o.__c.props !== n;
				return u.some(function(n) {
					if (n.__N) {
						var t = n.__[0];
						n.__ = n.__N, n.__N = void 0, t !== n.__[0] && (i = !0);
					}
				}), c && c.call(this, n, t, r) || i;
			};
			r.__f = !0;
			var c = r.shouldComponentUpdate, e = r.componentWillUpdate;
			r.componentWillUpdate = function(n, t, r) {
				if (this.__e) {
					var u = c;
					c = void 0, f(n, t, r), c = u;
				}
				e && e.call(this, n, t, r);
			}, r.shouldComponentUpdate = f;
		}
		return o.__N || o.__;
	}
	function y(n, u) {
		var i = p(t++, 3);
		!c.__s && C$1(i.__H, u) && (i.__ = n, i.u = u, r.__H.__h.push(i));
	}
	function _(n, u) {
		var i = p(t++, 4);
		!c.__s && C$1(i.__H, u) && (i.__ = n, i.u = u, r.__h.push(i));
	}
	function A$1(n) {
		return o$1 = 5, T$1(function() {
			return { current: n };
		}, []);
	}
	function F$1(n, t, r) {
		o$1 = 6, _(function() {
			if ("function" == typeof n) {
				var r = n(t());
				return function() {
					n(null), r && "function" == typeof r && r();
				};
			}
			if (n) return n.current = t(), function() {
				return n.current = null;
			};
		}, null == r ? r : r.concat(n));
	}
	function T$1(n, r) {
		var u = p(t++, 7);
		return C$1(u.__H, r) && (u.__ = n(), u.__H = r, u.__h = n), u.__;
	}
	function q$1(n, t) {
		return o$1 = 8, T$1(function() {
			return n;
		}, t);
	}
	function x$1(n) {
		var u = r.context[n.__c], i = p(t++, 9);
		return i.c = n, u ? (i.__ ?? (i.__ = !0, u.sub(r)), u.props.value) : n.__;
	}
	function P$1(n, t) {
		c.useDebugValue && c.useDebugValue(t ? t(n) : n);
	}
	function b(n) {
		var u = p(t++, 10), i = d();
		return u.__ = n, r.componentDidCatch || (r.componentDidCatch = function(n, t) {
			u.__ && u.__(n, t), i[1](n);
		}), [i[0], function() {
			i[1](void 0);
		}];
	}
	function g$1() {
		var n = p(t++, 11);
		if (!n.__) {
			for (var u = r.__v; null !== u && !u.__m && null !== u.__;) u = u.__;
			var i = u.__m || (u.__m = [0, 0]);
			n.__ = "P" + i[0] + "-" + i[1]++;
		}
		return n.__;
	}
	function j$1() {
		for (var n; n = f$1.shift();) {
			var t = n.__H;
			if (n.__P && t) try {
				t.__h.some(z$1), t.__h.some(B$1), t.__h = [];
			} catch (r) {
				t.__h = [], c.__e(r, n.__v);
			}
		}
	}
	c.__b = function(n) {
		r = null, e && e(n);
	}, c.__ = function(n, t) {
		n && t.__k && t.__k.__m && (n.__m = t.__k.__m), s && s(n, t);
	}, c.__r = function(n) {
		a && a(n), t = 0;
		var i = (r = n.__c).__H;
		i && (u$1 === r ? (i.__h = [], r.__h = [], i.__.some(function(n) {
			n.__N && (n.__ = n.__N), n.u = n.__N = void 0;
		})) : (i.__h.some(z$1), i.__h.some(B$1), i.__h = [], t = 0)), u$1 = r;
	}, c.diffed = function(n) {
		v && v(n);
		var t = n.__c;
		t && t.__H && (t.__H.__h.length && (1 !== f$1.push(t) && i$1 === c.requestAnimationFrame || ((i$1 = c.requestAnimationFrame) || w$1)(j$1)), t.__H.__.some(function(n) {
			n.u && (n.__H = n.u), n.u = void 0;
		})), u$1 = r = null;
	}, c.__c = function(n, t) {
		t.some(function(n) {
			try {
				n.__h.some(z$1), n.__h = n.__h.filter(function(n) {
					return !n.__ || B$1(n);
				});
			} catch (r) {
				t.some(function(n) {
					n.__h && (n.__h = []);
				}), t = [], c.__e(r, n.__v);
			}
		}), l && l(n, t);
	}, c.unmount = function(n) {
		m && m(n);
		var t, r = n.__c;
		r && r.__H && (r.__H.__.some(function(n) {
			try {
				z$1(n);
			} catch (n) {
				t = n;
			}
		}), r.__H = void 0, t && c.__e(t, r.__v));
	};
	var k$1 = "function" == typeof requestAnimationFrame;
	function w$1(n) {
		var t, r = function() {
			clearTimeout(u), k$1 && cancelAnimationFrame(t), setTimeout(n);
		}, u = setTimeout(r, 35);
		k$1 && (t = requestAnimationFrame(r));
	}
	function z$1(n) {
		var t = r, u = n.__c;
		"function" == typeof u && (n.__c = void 0, u()), r = t;
	}
	function B$1(n) {
		var t = r;
		n.__c = n.__(), r = t;
	}
	function C$1(n, t) {
		return !n || n.length !== t.length || t.some(function(t, r) {
			return t !== n[r];
		});
	}
	function D$1(n, t) {
		return "function" == typeof t ? t(n) : t;
	}
	//#endregion
	//#region src/lib/format.ts
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
		if (typeof value === "string") try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
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
	//#endregion
	//#region src/lib/notice.ts
	var hideAbort = null;
	function hideGlobalNotice() {
		const notice = $$2("globalNotice");
		if (!notice) return;
		if (state.noticeTimer) {
			clearTimeout(state.noticeTimer);
			state.noticeTimer = null;
		}
		if (hideAbort) hideAbort.abort();
		hideAbort = new AbortController();
		notice.classList.add("hiding");
		notice.addEventListener("animationend", () => {
			hideAbort = null;
			notice.hidden = true;
			notice.textContent = "";
			notice.classList.remove("success", "warning", "hiding");
		}, {
			once: true,
			signal: hideAbort.signal
		});
	}
	function showGlobalNotice(message, type = "success") {
		const notice = $$2("globalNotice");
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
	//#endregion
	//#region src/tabs/feed.ts
	function mergeMetadata(metadata) {
		if (!metadata || typeof metadata !== "object") return {};
		const importMeta = metadata.import_metadata;
		if (importMeta && typeof importMeta === "object") return {
			...importMeta,
			...metadata
		};
		return metadata;
	}
	function extractFactsFromBody(text) {
		if (!text) return [];
		const bullets = String(text).split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => /^[-*\u2022]\s+/.test(l) || /^\d+\./.test(l));
		if (!bullets.length) return [];
		return bullets.map((l) => l.replace(/^[-*\u2022]\s+/, "").replace(/^\d+\.\s+/, ""));
	}
	function sentenceFacts(text, limit = 6) {
		const raw = String(text || "").trim();
		if (!raw) return [];
		const parts = raw.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
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
	var OBSERVATION_PAGE_SIZE = 20;
	var SUMMARY_PAGE_SIZE = 50;
	var FEED_SCROLL_THRESHOLD_PX = 560;
	var lastFeedProject = "";
	var observationOffset = 0;
	var summaryOffset = 0;
	var observationHasMore = true;
	var summaryHasMore = true;
	var loadMoreInFlight = false;
	var feedScrollHandlerBound = false;
	var feedProjectGeneration = 0;
	var lastFeedScope = "all";
	function markFeedMount(mount) {
		mount.dataset.feedRenderRoot = "preact";
	}
	function ensureFeedRenderBoundary() {
		const feedTab = document.getElementById("tab-feed");
		if (!feedTab) return;
		feedTab.dataset.feedRenderBoundary = "preact-hybrid";
	}
	function renderIntoFeedMount(mount, content) {
		markFeedMount(mount);
		J$1(content, mount);
	}
	function feedScopeLabel(scope) {
		if (scope === "mine") return " · my memories";
		if (scope === "theirs") return " · other people";
		return "";
	}
	function ProvenanceChip({ label, variant = "" }) {
		return _$1("span", { className: `provenance-chip ${variant}`.trim() }, label);
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
		return mergeFeedItems(currentItems.filter((item) => !firstPageKeys.has(itemKey(item))), firstPageItems);
	}
	function replaceFeedItem(updatedItem) {
		const key = itemKey(updatedItem);
		state.lastFeedItems = state.lastFeedItems.map((item) => itemKey(item) === key ? updatedItem : item);
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
		const looksLikeSummary = (v) => {
			if (!v || typeof v !== "object" || Array.isArray(v)) return false;
			return preferredKeys.some((k) => typeof v[k] === "string" && v[k].trim().length > 0);
		};
		if (item?.summary && typeof item.summary === "object" && !Array.isArray(item.summary)) return item.summary;
		if (item?.summary?.summary && typeof item.summary.summary === "object") return item.summary.summary;
		const metadata = item?.metadata_json;
		if (looksLikeSummary(metadata)) return metadata;
		if (looksLikeSummary(metadata?.summary)) return metadata.summary;
		const bodyText = String(item?.body_text || "").trim();
		if (bodyText.includes("## ")) {
			const headingMap = {
				request: "request",
				completed: "completed",
				learned: "learned",
				investigated: "investigated",
				"next steps": "next_steps",
				notes: "notes"
			};
			const parsed = {};
			const sectionRe = /(?:^|\n)##\s+([^\n]+)\n([\s\S]*?)(?=\n##\s+|$)/g;
			for (let match = sectionRe.exec(bodyText); match; match = sectionRe.exec(bodyText)) {
				const key = headingMap[String(match[1] || "").trim().toLowerCase()];
				const content = String(match[2] || "").trim();
				if (key && content) parsed[key] = content;
			}
			if (looksLikeSummary(parsed)) return parsed;
		}
		return null;
	}
	function isSummaryLikeItem(item, metadata) {
		if (String(item?.kind || "").toLowerCase() === "session_summary") return true;
		if (metadata?.is_summary === true) return true;
		return String(metadata?.source || "").trim().toLowerCase() === "observer_summary";
	}
	function canonicalKind(item, metadata) {
		const kindValue = String(item?.kind || "").trim().toLowerCase();
		return isSummaryLikeItem(item, metadata) ? "session_summary" : kindValue || "change";
	}
	function observationViewData(item) {
		const metadata = mergeMetadata(item?.metadata_json);
		const summary = String(item?.subtitle || metadata?.subtitle || "").trim();
		const narrative = String(item?.narrative || metadata?.narrative || item?.body_text || "").trim();
		const normSummary = normalize(summary);
		const normNarrative = normalize(narrative);
		const narrativeDistinct = Boolean(narrative) && normNarrative !== normSummary;
		const explicitFacts = parseJsonArray(item?.facts || metadata?.facts || []);
		const fallbackFacts = explicitFacts.length ? explicitFacts : extractFactsFromBody(narrative || summary);
		const derivedFacts = fallbackFacts.length ? fallbackFacts : sentenceFacts(narrative || summary);
		return {
			summary,
			narrative,
			facts: derivedFacts,
			hasSummary: Boolean(summary),
			hasFacts: derivedFacts.length > 0,
			hasNarrative: narrativeDistinct
		};
	}
	function observationViewModes(data) {
		const modes = [];
		if (data.hasSummary) modes.push({
			id: "summary",
			label: "Summary"
		});
		if (data.hasFacts) modes.push({
			id: "facts",
			label: "Facts"
		});
		if (data.hasNarrative) modes.push({
			id: "narrative",
			label: "Narrative"
		});
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
		const allowedTags = new Set([
			"p",
			"br",
			"strong",
			"em",
			"code",
			"pre",
			"ul",
			"ol",
			"li",
			"blockquote",
			"a",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"hr"
		]);
		template.content.querySelectorAll("script, iframe, object, embed, link, style").forEach((node) => {
			node.remove();
		});
		template.content.querySelectorAll("*").forEach((node) => {
			const tag = node.tagName.toLowerCase();
			if (!allowedTags.has(tag)) {
				node.replaceWith(document.createTextNode(node.textContent || ""));
				return;
			}
			const allowedAttrs = tag === "a" ? new Set(["href", "title"]) : /* @__PURE__ */ new Set();
			for (const attr of Array.from(node.attributes)) {
				const name = attr.name.toLowerCase();
				if (!allowedAttrs.has(name)) node.removeAttribute(attr.name);
			}
			if (tag === "a") if (!isSafeHref(node.getAttribute("href") || "")) node.removeAttribute("href");
			else {
				node.setAttribute("rel", "noopener noreferrer");
				node.setAttribute("target", "_blank");
			}
		});
		return template.innerHTML;
	}
	function renderMarkdownSafe(value) {
		const source = String(value || "");
		try {
			return sanitizeHtml(globalThis.marked.parse(source));
		} catch {
			return source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		}
	}
	function renderSummarySections(summary) {
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
		const keys = Object.keys(summary);
		return preferred.filter((k) => keys.includes(k)).map((key) => {
			const content = String(summary[key] || "").trim();
			if (!content) return null;
			return _$1("div", {
				className: "summary-section",
				key
			}, _$1("div", { className: "summary-section-label" }, toTitleLabel(key)), _$1("div", {
				className: "summary-section-content",
				dangerouslySetInnerHTML: { __html: renderMarkdownSafe(content) }
			}));
		}).filter(Boolean);
	}
	function renderFactsContent(facts) {
		const trimmed = facts.map((f) => String(f || "").trim()).filter(Boolean);
		if (!trimmed.length) return null;
		if (trimmed.every((f) => /.+?:\s+.+/.test(f))) {
			const rows = trimmed.map((fact, index) => {
				const splitAt = fact.indexOf(":");
				const labelText = fact.slice(0, splitAt).trim();
				const contentText = fact.slice(splitAt + 1).trim();
				if (!labelText || !contentText) return null;
				return _$1("div", {
					className: "summary-section",
					key: `${labelText}-${index}`
				}, _$1("div", { className: "summary-section-label" }, labelText), _$1("div", {
					className: "summary-section-content",
					dangerouslySetInnerHTML: { __html: renderMarkdownSafe(contentText) }
				}));
			}).filter(Boolean);
			if (rows.length) return _$1("div", { className: "feed-body facts" }, rows);
		}
		return _$1("div", { className: "feed-body" }, _$1("ul", null, trimmed.map((fact, index) => _$1("li", { key: `${fact}-${index}` }, fact))));
	}
	function renderNarrativeContent(narrative, className = "feed-body") {
		const content = String(narrative || "").trim();
		if (!content) return null;
		return _$1("div", {
			className,
			dangerouslySetInnerHTML: { __html: renderMarkdownSafe(content) }
		});
	}
	function FeedViewToggle({ modes, active, onSelect }) {
		if (modes.length <= 1) return null;
		return _$1("div", { className: "feed-toggle" }, modes.map((mode) => _$1("button", {
			key: mode.id,
			className: `toggle-button${mode.id === active ? " active" : ""}`,
			"data-filter": mode.id,
			onClick: () => onSelect(mode.id),
			type: "button"
		}, mode.label)));
	}
	function TagChip({ tag }) {
		const display = formatTagLabel(tag);
		if (!display) return null;
		return _$1("span", {
			className: "tag-chip",
			title: String(tag)
		}, display);
	}
	function FeedItemCard({ item }) {
		const metadata = mergeMetadata(item?.metadata_json);
		const isSessionSummary = isSummaryLikeItem(item, metadata);
		const displayKindValue = canonicalKind(item, metadata);
		const rowKey = itemKey(item);
		const defaultTitle = item.title || "(untitled)";
		const displayTitle = isSessionSummary && metadata?.request ? metadata.request : defaultTitle;
		const createdAtRaw = item.created_at || item.created_at_utc;
		const relative = formatRelativeTime(createdAtRaw);
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
		const memoryId = Number(item.id || 0);
		const [isNew, setIsNew] = d(state.newItemKeys.has(rowKey));
		const summaryObj = isSessionSummary ? getSummaryObject({
			...item,
			metadata_json: metadata
		}) : null;
		const observationData = !isSessionSummary ? observationViewData({
			...item,
			metadata_json: metadata
		}) : null;
		const modes = observationData ? observationViewModes(observationData) : [];
		const fallbackMode = observationData ? defaultObservationView(observationData) : "summary";
		const storedMode = state.itemViewState.get(rowKey);
		const [activeMode, setActiveMode] = d(observationData && storedMode && modes.some((mode) => mode.id === storedMode) ? storedMode : fallbackMode);
		const activeExpandKey = `${rowKey}:${activeMode}`;
		const [expanded, setExpanded] = d(state.itemExpandState.get(activeExpandKey) === true);
		const [selectedVisibility, setSelectedVisibility] = d(visibility === "shared" ? "shared" : "private");
		const [savingVisibility, setSavingVisibility] = d(false);
		const summarySections = summaryObj ? renderSummarySections(summaryObj) : [];
		y(() => {
			if (!observationData) return;
			if (modes.some((mode) => mode.id === activeMode)) return;
			setActiveMode(fallbackMode);
		}, [
			activeMode,
			fallbackMode,
			modes,
			observationData
		]);
		y(() => {
			state.itemViewState.set(rowKey, activeMode);
		}, [activeMode, rowKey]);
		y(() => {
			const nextExpandKey = `${rowKey}:${activeMode}`;
			setExpanded(state.itemExpandState.get(nextExpandKey) === true);
		}, [activeMode, rowKey]);
		y(() => {
			setSelectedVisibility(visibility === "shared" ? "shared" : "private");
		}, [visibility]);
		y(() => {
			if (!isNew) return;
			const timer = window.setTimeout(() => {
				state.newItemKeys.delete(rowKey);
				setIsNew(false);
			}, 700);
			return () => window.clearTimeout(timer);
		}, [isNew, rowKey]);
		const currentVisibility = selectedVisibility;
		const visibilityNote = currentVisibility === "shared" ? "This memory can sync to peers allowed by your project filters." : "This memory stays local unless the peer is assigned to your local actor.";
		const canClamp = Boolean(observationData) && shouldClampBody(activeMode, observationData);
		const bodyClassName = [activeMode === "facts" ? "feed-body facts" : "feed-body", canClamp && !expanded ? clampClass(activeMode).join(" ") : ""].filter(Boolean).join(" ");
		const bodyContent = isSessionSummary ? summarySections.length ? _$1("div", { className: "feed-body facts" }, summarySections) : renderNarrativeContent(String(item.body_text || "")) || _$1("div", { className: "feed-body" }) : observationData ? activeMode === "facts" ? renderFactsContent(observationData.facts) || _$1("div", { className: bodyClassName }) : renderNarrativeContent(activeMode === "narrative" ? observationData.narrative : observationData.summary, bodyClassName) || _$1("div", { className: bodyClassName }) : _$1("div", { className: "feed-body" });
		async function saveVisibility(nextVisibility) {
			const previousVisibility = currentVisibility;
			setSelectedVisibility(nextVisibility);
			setSavingVisibility(true);
			try {
				const payload = await updateMemoryVisibility(memoryId, nextVisibility);
				if (payload?.item) {
					replaceFeedItem(payload.item);
					updateFeedView(true);
				}
				showGlobalNotice(nextVisibility === "shared" ? "Memory will now sync as shared context." : "Memory is private again.");
			} catch (error) {
				setSelectedVisibility(previousVisibility);
				showGlobalNotice(error instanceof Error ? error.message : "Failed to save visibility.", "warning");
			} finally {
				setSavingVisibility(false);
			}
		}
		return _$1("div", {
			className: `feed-item ${displayKindValue}${isNew ? " new-item" : ""}`.trim(),
			"data-key": rowKey
		}, _$1("div", { className: "feed-card-header" }, _$1("div", { className: "feed-header" }, _$1("span", { className: `kind-pill ${displayKindValue}`.trim() }, displayKindValue.replace(/_/g, " ")), _$1("div", {
			className: "feed-title title",
			dangerouslySetInnerHTML: { __html: highlightText(displayTitle, state.feedQuery) }
		})), _$1("div", { className: "feed-actions" }, observationData ? _$1(FeedViewToggle, {
			active: activeMode,
			modes,
			onSelect: (mode) => setActiveMode(mode)
		}) : null, _$1("div", {
			className: "small feed-age",
			title: formatDate(createdAtRaw)
		}, relative))), _$1("div", { className: "feed-provenance" }, _$1(ProvenanceChip, {
			label: actor,
			variant: actor === "You" ? "mine" : "author"
		}), _$1(ProvenanceChip, {
			label: visibility || "private",
			variant: visibility || "private"
		}), workspaceKind && workspaceKind !== visibility ? _$1(ProvenanceChip, {
			label: workspaceKind,
			variant: "workspace"
		}) : null, originSource ? _$1(ProvenanceChip, {
			label: originSource,
			variant: "source"
		}) : null, originDeviceId && actor !== "You" ? _$1(ProvenanceChip, {
			label: originDeviceId,
			variant: "device"
		}) : null, trustState && trustState !== "trusted" ? _$1(ProvenanceChip, {
			label: trustStateLabel(trustState),
			variant: "trust"
		}) : null), _$1("div", { className: "feed-meta" }, `${project ? `Project: ${project}` : "Project: n/a"}${tagContent}${fileContent}`), bodyContent, _$1("div", { className: "feed-footer" }, _$1("div", { className: "feed-footer-left" }, files.length ? _$1("div", { className: "feed-files" }, files.map((file, index) => _$1("span", {
			className: "feed-file",
			key: `${file}-${index}`
		}, file))) : null, tags.length ? _$1("div", { className: "feed-tags" }, tags.map((tag, index) => _$1(TagChip, {
			key: `${String(tag)}-${index}`,
			tag
		}))) : null, Boolean(item.owned_by_self) && memoryId > 0 ? _$1("div", { className: "feed-visibility-controls" }, _$1("select", {
			"aria-label": `Visibility for ${String(item.title || "memory")}`,
			className: "feed-visibility-select",
			disabled: savingVisibility,
			onChange: (event) => {
				saveVisibility(String(event.currentTarget.value) === "shared" ? "shared" : "private");
			},
			value: currentVisibility
		}, _$1("option", { value: "private" }, "Only me"), _$1("option", { value: "shared" }, "Share with peers")), _$1("div", { className: "feed-visibility-note" }, visibilityNote)) : null), _$1("div", { className: "feed-footer-right" }, canClamp ? _$1("button", {
			className: "feed-expand",
			onClick: () => {
				const nextValue = !expanded;
				state.itemExpandState.set(activeExpandKey, nextValue);
				setExpanded(nextValue);
			},
			type: "button"
		}, expanded ? "Collapse" : "Expand") : null)));
	}
	function FeedList({ items, loadingText }) {
		if (loadingText) return _$1("div", { className: "small" }, loadingText);
		if (!items.length) return _$1("div", { className: "small" }, "No memories yet.");
		return _$1(k$2, null, items.map((item) => _$1(FeedItemCard, {
			item,
			key: itemKey(item)
		})));
	}
	function filterByType(items) {
		if (state.feedTypeFilter === "observations") return items.filter((i) => !isSummaryLikeItem(i, mergeMetadata(i?.metadata_json)));
		if (state.feedTypeFilter === "summaries") return items.filter((i) => isSummaryLikeItem(i, mergeMetadata(i?.metadata_json)));
		return items;
	}
	function filterByQuery(items) {
		const query = normalize(state.feedQuery);
		if (!query) return items;
		return items.filter((item) => {
			return [
				normalize(item?.title),
				normalize(item?.body_text),
				normalize(item?.kind),
				parseJsonArray(item?.tags || []).map((t) => normalize(t)).join(" "),
				normalize(item?.project)
			].join(" ").trim().includes(query);
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
			const [observations, summaries] = await Promise.all([observationHasMore ? loadMemoriesPage(requestProject, {
				limit: OBSERVATION_PAGE_SIZE,
				offset: startObservationOffset,
				scope: state.feedScopeFilter
			}) : Promise.resolve({
				items: [],
				pagination: {
					has_more: false,
					next_offset: startObservationOffset
				}
			}), summaryHasMore ? loadSummariesPage(requestProject, {
				limit: SUMMARY_PAGE_SIZE,
				offset: startSummaryOffset,
				scope: state.feedScopeFilter
			}) : Promise.resolve({
				items: [],
				pagination: {
					has_more: false,
					next_offset: startSummaryOffset
				}
			})]);
			if (requestGeneration !== feedProjectGeneration || requestProject !== (state.currentProject || "")) return;
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
			if (countNewItems(feedItems, state.lastFeedItems)) {
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
		loadMoreFeedPage();
	}
	function feedMetaText(visibleCount) {
		const filterLabel = state.feedTypeFilter === "observations" ? " · observations" : state.feedTypeFilter === "summaries" ? " · session summaries" : "";
		const scopeLabel = feedScopeLabel(state.feedScopeFilter);
		const filteredLabel = !state.feedQuery.trim() && state.lastFeedFilteredCount ? ` · ${state.lastFeedFilteredCount} observations filtered` : "";
		return `${visibleCount} items${filterLabel}${scopeLabel}${state.feedQuery.trim() ? ` · matching "${state.feedQuery.trim()}"` : ""}${filteredLabel}${hasMorePages() ? " · scroll for more" : ""}`;
	}
	function FeedToggle({ id, active, options, onSelect }) {
		return _$1("div", {
			className: "feed-toggle",
			id
		}, options.map(({ value, label }) => {
			const selected = value === active;
			return _$1("button", {
				"aria-pressed": selected ? "true" : "false",
				className: `toggle-button${selected ? " active" : ""}`,
				"data-filter": value,
				key: value,
				onClick: () => onSelect(value),
				type: "button"
			}, label);
		}));
	}
	function TraceCandidateGroup({ label, candidates }) {
		if (candidates.length === 0) return null;
		return _$1("div", { className: "trace-group" }, _$1("div", { className: "section-meta" }, label), _$1("div", { className: "feed-list" }, candidates.map((candidate) => _$1("div", {
			className: "feed-card",
			key: `${label}:${candidate.id}`
		}, _$1("div", { className: "feed-card-header" }, [_$1("div", { className: "feed-card-title" }, `${candidate.rank}. ${candidate.title}`), _$1("div", { className: "feed-card-meta" }, `#${candidate.id} · ${candidate.kind}${candidate.section ? ` · ${candidate.section}` : ""}`)]), _$1("div", { className: "feed-card-body" }, [_$1("div", null, candidate.preview || "No preview available."), candidate.reasons.length ? _$1("div", { className: "section-meta" }, `Reasons: ${candidate.reasons.join(", ")}`) : null])))));
	}
	function ContextInspectorPanel() {
		const [open, setOpen] = d(false);
		const [workingSetText, setWorkingSetText] = d("");
		const [loading, setLoading] = d(false);
		const [error, setError] = d("");
		const [errorContextKey, setErrorContextKey] = d("");
		const [trace, setTrace] = d(null);
		const currentQuery = String(state.feedQuery || "").trim();
		const currentProject = state.currentProject || null;
		const currentContextKey = JSON.stringify([currentProject, currentQuery]);
		const visibleTrace = trace && trace.inputs.query === currentQuery && trace.inputs.project === currentProject ? trace : null;
		const visibleError = error && errorContextKey === currentContextKey ? error : "";
		y(() => {
			setError("");
			setErrorContextKey("");
			setTrace((currentTrace) => {
				if (!currentTrace) return null;
				if (currentTrace.inputs.query !== currentQuery || currentTrace.inputs.project !== currentProject) return null;
				return currentTrace;
			});
		}, [currentProject, currentQuery]);
		const runTrace = async () => {
			const context = currentQuery;
			const project = currentProject;
			const contextKey = JSON.stringify([project, context]);
			if (!context) {
				setError("Enter a query to inspect.");
				setErrorContextKey(contextKey);
				setTrace(null);
				return;
			}
			setLoading(true);
			setError("");
			setErrorContextKey("");
			try {
				const nextTrace = await tracePack({
					context,
					project,
					working_set_files: workingSetText.split(/\n|,/).map((value) => value.trim()).filter(Boolean)
				});
				if (String(state.feedQuery || "").trim() !== context || (state.currentProject || null) !== project) return;
				setTrace(nextTrace);
			} catch (err) {
				if (String(state.feedQuery || "").trim() !== context || (state.currentProject || null) !== project) return;
				setError(err instanceof Error ? err.message : String(err));
				setErrorContextKey(contextKey);
				setTrace(null);
			} finally {
				setLoading(false);
			}
		};
		const selected = visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "selected") || [];
		const dropped = visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "dropped") || [];
		const deduped = visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "deduped") || [];
		const trimmed = visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "trimmed") || [];
		return _$1("div", { className: "feed-inspector" }, _$1("button", {
			className: "toggle-button",
			onClick: () => setOpen(!open),
			type: "button"
		}, open ? "Hide Context Inspector" : "Open Context Inspector"), open ? _$1("div", {
			className: "feed-card",
			style: "margin-top:12px;"
		}, [
			_$1("div", { className: "feed-card-header" }, [_$1("div", { className: "feed-card-title" }, "Context Inspector"), _$1("div", { className: "feed-card-meta" }, "Tracing the current Search query")]),
			_$1("div", { className: "feed-card-body" }, [
				_$1("input", {
					className: "feed-search",
					onInput: (event) => {
						state.feedQuery = String(event.currentTarget.value || "");
						setTrace(null);
						setError("");
						setErrorContextKey("");
						updateFeedView();
					},
					placeholder: "Trace a pack query…",
					value: state.feedQuery
				}),
				_$1("textarea", {
					onInput: (event) => setWorkingSetText(String(event.currentTarget.value || "")),
					placeholder: "Optional working-set files, one per line",
					rows: 3,
					style: "margin-top:8px; width:100%;",
					value: workingSetText
				}),
				_$1("div", { style: "display:flex; gap:8px; margin-top:8px; align-items:center;" }, _$1("button", {
					className: "toggle-button active",
					disabled: loading,
					onClick: () => void runTrace(),
					type: "button"
				}, loading ? "Tracing…" : "Run trace"), visibleTrace ? _$1("span", { className: "section-meta" }, `mode=${visibleTrace.mode.selected} · candidates=${visibleTrace.retrieval.candidate_count} · tokens=${visibleTrace.output.estimated_tokens}`) : null),
				trace && !visibleTrace ? _$1("div", {
					className: "section-meta",
					style: "margin-top:8px;"
				}, "Search context changed. Run trace again for the current query and project.") : null,
				visibleError ? _$1("div", {
					className: "section-meta",
					style: "margin-top:8px; color:#d96c6c;"
				}, visibleError) : null
			]),
			visibleTrace ? _$1(k$2, null, [
				_$1(TraceCandidateGroup, {
					label: "Selected",
					candidates: selected
				}),
				_$1(TraceCandidateGroup, {
					label: "Dropped",
					candidates: dropped
				}),
				_$1(TraceCandidateGroup, {
					label: "Deduped",
					candidates: deduped
				}),
				_$1(TraceCandidateGroup, {
					label: "Trimmed",
					candidates: trimmed
				}),
				_$1("div", { className: "feed-card-body" }, [
					visibleTrace.assembly.collapsed_groups.length ? _$1("div", { className: "section-meta" }, `Collapsed duplicates: ${visibleTrace.assembly.collapsed_groups.map((group) => `kept #${group.kept} from [${group.dropped.join(", ")}]`).join(" · ")}`) : null,
					visibleTrace.assembly.trim_reasons.length ? _$1("div", { className: "section-meta" }, `Trim reasons: ${visibleTrace.assembly.trim_reasons.join(", ")}`) : null,
					_$1("div", { className: "section-meta" }, "Final pack"),
					_$1("pre", { style: "white-space:pre-wrap; overflow:auto;" }, visibleTrace.output.pack_text)
				])
			]) : null
		]) : null);
	}
	function FeedTabView({ items, loadingText }) {
		return _$1(k$2, null, _$1("div", { className: "feed-controls" }, _$1("div", {
			className: "section-meta",
			id: "feedMeta"
		}, loadingText || feedMetaText(items.length)), _$1("div", { className: "feed-controls-right" }, _$1("input", {
			className: "feed-search",
			id: "feedSearch",
			onInput: (event) => {
				state.feedQuery = String(event.currentTarget.value || "");
				updateFeedView();
			},
			placeholder: "Search title, body, tags…",
			value: state.feedQuery
		}), _$1(ContextInspectorPanel, {}), _$1(FeedToggle, {
			active: state.feedScopeFilter,
			id: "feedScopeToggle",
			onSelect: (value) => {
				if (value === state.feedScopeFilter) return;
				setFeedScopeFilter(value);
				loadFeedData();
			},
			options: [
				{
					value: "all",
					label: "All"
				},
				{
					value: "mine",
					label: "My memories"
				},
				{
					value: "theirs",
					label: "Other people"
				}
			]
		}), _$1(FeedToggle, {
			active: state.feedTypeFilter,
			id: "feedTypeToggle",
			onSelect: (value) => {
				if (value === state.feedTypeFilter) return;
				setFeedTypeFilter(value);
				updateFeedView();
			},
			options: [
				{
					value: "all",
					label: "All"
				},
				{
					value: "observations",
					label: "Observations"
				},
				{
					value: "summaries",
					label: "Summaries"
				}
			]
		}))), _$1("div", {
			className: "feed-list",
			id: "feedList"
		}, _$1(FeedList, {
			items,
			loadingText
		})));
	}
	function renderFeedTab(items, options) {
		const feedTab = document.getElementById("tab-feed");
		if (!feedTab) return false;
		renderIntoFeedMount(feedTab, _$1(FeedTabView, {
			items,
			loadingText: options?.loadingText
		}));
		if (typeof globalThis.lucide !== "undefined" && !options?.loadingText) globalThis.lucide.createIcons();
		return true;
	}
	function renderProjectSwitchLoadingState() {
		renderFeedTab([], { loadingText: "Loading selected project..." });
	}
	function initFeedTab() {
		ensureFeedRenderBoundary();
		renderFeedTab(state.lastFeedItems, state.lastFeedItems.length || state.lastFeedSignature ? void 0 : { loadingText: "Loading memories…" });
		if (!feedScrollHandlerBound) {
			window.addEventListener("scroll", () => {
				maybeLoadMoreFeedPage();
			}, { passive: true });
			feedScrollHandlerBound = true;
		}
	}
	function updateFeedView(force = false) {
		if (!document.getElementById("tab-feed")) return;
		const scrollY = window.scrollY;
		const visible = filterByQuery(filterByType(state.lastFeedItems));
		const sig = computeSignature(visible);
		const changed = force || sig !== state.lastFeedSignature;
		state.lastFeedSignature = sig;
		if (changed) renderFeedTab(visible);
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
		const [observations, summaries] = await Promise.all([loadMemoriesPage(project, {
			limit: observationsLimit,
			offset: 0,
			scope: state.feedScopeFilter
		}), loadSummariesPage(project, {
			limit: summariesLimit,
			offset: 0,
			scope: state.feedScopeFilter
		})]);
		if (requestGeneration !== feedProjectGeneration || project !== (state.currentProject || "")) return;
		const summaryItems = summaries.items || [];
		const observationItems = observations.items || [];
		const filtered = observationItems.filter((i) => !isLowSignalObservation(i));
		const filteredCount = observationItems.length - filtered.length;
		const firstPageFeedItems = [...summaryItems, ...filtered].sort((a, b) => {
			return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
		});
		const feedItems = mergeRefreshFeedItems(state.lastFeedItems, firstPageFeedItems);
		if (countNewItems(feedItems, state.lastFeedItems)) {
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
	//#endregion
	//#region src/tabs/health.ts
	function buildHealthCard(input) {
		return input;
	}
	function HealthCard({ label, value, detail, icon, className, title }) {
		return _$1("div", {
			class: `stat${className ? ` ${className}` : ""}`,
			title,
			style: title ? "cursor: help;" : void 0
		}, icon ? _$1("i", {
			"data-lucide": icon,
			class: "stat-icon"
		}) : null, _$1("div", { class: "stat-content" }, _$1("div", { class: "value" }, value), _$1("div", { class: "label" }, label), detail ? _$1("div", { class: "small" }, detail) : null));
	}
	function HealthActionRow({ item }) {
		let actionButton = null;
		let copyButton = null;
		const actionLabel = item.actionLabel || "Run";
		async function handleAction() {
			if (!item.action || !actionButton) return;
			actionButton.disabled = true;
			actionButton.textContent = "Running…";
			try {
				await item.action();
			} catch {}
			actionButton.disabled = false;
			actionButton.textContent = actionLabel;
		}
		function handleCopy() {
			if (!item.command || !copyButton) return;
			copyToClipboard(item.command, copyButton);
		}
		return _$1("div", { class: "health-action" }, _$1("div", { class: "health-action-text" }, item.label, item.command ? _$1("span", { class: "health-action-command" }, item.command) : null), _$1("div", { class: "health-action-buttons" }, item.action ? _$1("button", {
			class: "settings-button",
			onClick: handleAction,
			ref: (node) => {
				actionButton = node;
			}
		}, actionLabel) : null, item.command ? _$1("button", {
			class: "settings-button health-action-copy",
			onClick: handleCopy,
			ref: (node) => {
				copyButton = node;
			}
		}, "Copy") : null));
	}
	function formatStatValue(value) {
		if (typeof value === "number") return value.toLocaleString();
		if (value == null) return "n/a";
		return String(value);
	}
	function StatBlock({ label, value, icon, tooltip }) {
		return _$1("div", {
			class: "stat",
			title: tooltip,
			style: tooltip ? "cursor: help;" : void 0
		}, _$1("i", {
			"data-lucide": icon,
			class: "stat-icon"
		}), _$1("div", { class: "stat-content" }, _$1("div", { class: "value" }, formatStatValue(value)), _$1("div", { class: "label" }, label)));
	}
	function renderStatBlocks(container, items) {
		if (!container) return;
		J$1(_$1(k$2, null, items.map((item) => _$1(StatBlock, {
			...item,
			key: `${item.label}-${item.icon}`
		}))), container);
	}
	function renderText(container, value) {
		if (!container) return;
		J$1(_$1(k$2, null, value), container);
	}
	function renderIcons() {
		const lucide = globalThis.lucide;
		if (lucide && typeof lucide.createIcons === "function") lucide.createIcons();
	}
	function renderHealthCards(container, cards) {
		if (!container) return;
		J$1(_$1(k$2, null, cards.map((card) => _$1(HealthCard, {
			...card,
			key: `${card.label}-${card.value}`
		}))), container);
	}
	function renderActionList$1(container, actions) {
		if (!container) return;
		if (!actions.length) {
			container.hidden = true;
			J$1(null, container);
			return;
		}
		container.hidden = false;
		J$1(_$1(k$2, null, actions.slice(0, 3).map((item, index) => _$1(HealthActionRow, {
			item,
			key: `${item.label}-${index}`
		}))), container);
	}
	function renderHealthOverview() {
		const healthGrid = document.getElementById("healthGrid");
		const healthMeta = document.getElementById("healthMeta");
		const healthActions = document.getElementById("healthActions");
		const healthDot = document.getElementById("healthDot");
		if (!healthGrid || !healthMeta) return;
		const stats = state.lastStatsPayload || {};
		const usagePayload = state.lastUsagePayload || {};
		const raw = state.lastRawEventsPayload && typeof state.lastRawEventsPayload === "object" ? state.lastRawEventsPayload : {};
		const syncStatus = state.lastSyncStatus || {};
		const maintenanceJobs = Array.isArray(stats.maintenance_jobs) ? stats.maintenance_jobs : [];
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
		const syncStateLabel = syncState === "offline-peers" ? "Offline peers" : syncState === "needs_attention" ? "Needs attention" : syncState === "rebootstrapping" ? "Rebootstrapping" : titleCase(syncState);
		const peerCount = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers.length : 0;
		const syncDisabled = syncState === "disabled" || syncStatus.enabled === false;
		const syncOfflinePeers = syncState === "offline-peers";
		const syncNoPeers = !syncDisabled && peerCount === 0;
		const syncCardValue = syncDisabled ? "Disabled" : syncNoPeers ? "No peers" : syncStateLabel;
		const syncAgeSeconds = secondsSince(syncStatus.last_sync_at || syncStatus.last_sync_at_utc || null);
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
		if (flushSuccessRate < .95) {
			riskScore += 20;
			drivers.push("lower flush success");
		}
		if (droppedRate > .02) {
			riskScore += 24;
			drivers.push("high dropped-event rate");
		} else if (droppedRate > .005) {
			riskScore += 10;
			drivers.push("non-trivial dropped-event rate");
		}
		if (!syncDisabled && !syncNoPeers) {
			if (syncState === "error") {
				riskScore += 36;
				drivers.push("sync daemon reports errors");
			} else if (syncState === "needs_attention") {
				riskScore += 40;
				drivers.push("sync needs manual attention");
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
			} else if (syncLooksStale) {
				riskScore += 26;
				drivers.push("sync looks stale");
			} else if (syncAgeSeconds !== null && syncAgeSeconds > 1800) {
				riskScore += 12;
				drivers.push("sync not recent");
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
		const maintenanceCards = maintenanceJobs.map((job) => {
			const current = Number(job.progress?.current || 0);
			const total = typeof job.progress?.total === "number" ? job.progress.total : null;
			const unit = String(job.progress?.unit || "items");
			const pct = total && total > 0 ? ` (${Math.round(100 * current / total)}%)` : "";
			const progress = total && total > 0 ? `${current.toLocaleString()}/${total.toLocaleString()} ${unit}${pct}` : `${current.toLocaleString()} ${unit}`;
			const isFailed = job.status === "failed";
			const detail = isFailed ? String(job.error || "unknown error").trim() : void 0;
			return buildHealthCard({
				label: String(job.title || job.kind || "Background maintenance"),
				value: isFailed ? "Failed" : progress,
				detail,
				icon: isFailed ? "alert-triangle" : "loader",
				className: isFailed ? "status-attention" : void 0,
				title: isFailed ? `Error: ${job.error || "unknown"}` : `${String(job.title || "Maintenance")} in progress`
			});
		});
		renderHealthCards(healthGrid, [
			buildHealthCard({
				label: "Overall health",
				value: statusLabel,
				detail: `Weighted score ${riskScore}`,
				icon: "heart-pulse",
				className: `health-primary ${statusClass}`,
				title: drivers.length ? `Main signals: ${drivers.join(", ")}` : "No major risk signals detected"
			}),
			...maintenanceCards,
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
		]);
		const triggerSync$1 = async () => {
			await triggerSync();
		};
		const recommendations = [];
		if (hasBacklog) {
			recommendations.push({
				label: "Pipeline needs attention. Check queue health first.",
				command: "codemem db raw-events-status"
			});
			recommendations.push({
				label: "Then retry failed batches for impacted sessions.",
				command: "codemem db raw-events-retry <opencode_session_id>"
			});
		} else if (syncState === "stopped") recommendations.push({
			label: "Sync daemon is stopped. Start the background service.",
			command: "codemem sync start"
		});
		else if (!syncDisabled && !syncNoPeers && (syncState === "error" || syncState === "degraded")) {
			recommendations.push({
				label: "Sync is unhealthy. Restart and run one immediate pass.",
				command: "codemem sync restart",
				action: triggerSync$1,
				actionLabel: "Sync now"
			});
			recommendations.push({
				label: "Then run doctor to see root cause details.",
				command: "codemem sync doctor"
			});
		} else if (!syncDisabled && !syncNoPeers && syncLooksStale) recommendations.push({
			label: "Sync is stale. Run one immediate sync pass.",
			command: "codemem sync once",
			action: triggerSync$1,
			actionLabel: "Sync now"
		});
		if (tagCoverage > 0 && tagCoverage < .7 && recommendations.length < 2) recommendations.push({
			label: "Tag coverage is low. Preview backfill impact.",
			command: "codemem db backfill-tags --dry-run"
		});
		renderActionList$1(healthActions, recommendations);
		healthMeta.textContent = drivers.length ? `Why this status: ${drivers.join(", ")}.` : "Healthy right now. Diagnostics stay available if you want details.";
		renderIcons();
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
		const globalLineWork = isFiltered ? `\nGlobal: ${Number(totalsGlobal.work_investment_tokens || 0).toLocaleString()} invested` : "";
		const globalLineRead = isFiltered ? `\nGlobal: ${Number(totalsGlobal.tokens_read || 0).toLocaleString()} read` : "";
		const globalLineSaved = isFiltered ? `\nGlobal: ${Number(totalsGlobal.tokens_saved || 0).toLocaleString()} saved` : "";
		const items = [
			{
				label: isFiltered ? "Savings (project)" : "Savings",
				value: Number(usage.tokens_saved || 0),
				tooltip: "Tokens saved by reusing compressed memories" + globalLineSaved,
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
				tooltip: `Percent reduction from reuse. Factor: ${formatMultiplier(usage.tokens_saved, usage.tokens_read)}.` + globalLineRead + globalLineSaved,
				icon: "percent"
			},
			{
				label: isFiltered ? "Work investment (project)" : "Work investment",
				value: Number(usage.work_investment_tokens || 0),
				tooltip: "Token cost of unique discovery groups" + globalLineWork,
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
		if (rawPending > 0) items.push({
			label: "Raw events pending",
			value: rawPending,
			tooltip: "Pending raw events waiting to be flushed",
			icon: "activity"
		});
		else if (rawSessions > 0) items.push({
			label: "Raw sessions",
			value: rawSessions,
			tooltip: "Sessions with pending raw events",
			icon: "inbox"
		});
		renderStatBlocks(statsGrid, items);
		if (metaLine) {
			const projectSuffix = project ? ` · project: ${project}` : "";
			renderText(metaLine, `DB: ${db.path || "unknown"} · ${Math.round((db.size_bytes || 0) / 1024)} KB${projectSuffix}`);
		}
		renderIcons();
	}
	function renderSessionSummary() {
		const sessionGrid = document.getElementById("sessionGrid");
		const sessionMeta = document.getElementById("sessionMeta");
		if (!sessionGrid || !sessionMeta) return;
		const usagePayload = state.lastUsagePayload || {};
		const project = state.currentProject;
		usagePayload?.totals_global || usagePayload?.totals;
		const totalsFiltered = usagePayload?.totals_filtered || null;
		const isFiltered = !!(project && totalsFiltered);
		const packEvent = (Array.isArray(usagePayload?.events) ? usagePayload.events : []).find((event) => event.event === "pack") || null;
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
				label: "Last pack deduped",
				value: latestPack ? dedupedCount.toLocaleString() : "n/a",
				icon: "copy-check"
			},
			{
				label: "Exact dedupe",
				value: latestPack ? dedupeEnabled ? "On" : "Off" : "n/a",
				icon: "shield-check"
			},
			{
				label: "Packs",
				value: packCount || 0,
				icon: "archive"
			}
		];
		renderText(sessionMeta, [
			scopeLabel,
			packLine,
			lastPackLine
		].filter(Boolean).join(" · "));
		renderStatBlocks(sessionGrid, items);
		renderIcons();
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
		if (state.activeTab === "feed" && previousActorId !== nextActorId) updateFeedView(true);
	}
	//#endregion
	//#region src/tabs/sync/view-model.ts
	var SYNC_TERMINOLOGY = {
		actor: "person",
		actors: "people",
		actorAssignment: "person assignment",
		localActor: "you",
		peer: "device",
		peers: "devices",
		pairedLocally: "Connected on this device",
		discovered: "Seen on team",
		conflicts: "Needs repair"
	};
	function cleanText(value) {
		return String(value ?? "").trim();
	}
	function normalizeDisplayName(value) {
		return cleanText(value).replace(/\s+/g, " ").toLowerCase();
	}
	function friendlyDeviceFallback(deviceId) {
		const cleanId = cleanText(deviceId);
		return cleanId ? cleanId.slice(0, 8) : "Unnamed device";
	}
	function resolveFriendlyDeviceName(input) {
		const localName = cleanText(input.localName);
		if (localName) return localName;
		const coordinatorName = cleanText(input.coordinatorName);
		if (coordinatorName) return coordinatorName;
		return friendlyDeviceFallback(cleanText(input.deviceId));
	}
	function deviceNeedsFriendlyName(input) {
		const localName = cleanText(input.localName);
		const coordinatorName = cleanText(input.coordinatorName);
		if (localName || coordinatorName) return false;
		return Boolean(cleanText(input.deviceId));
	}
	function derivePeerUiStatus(peer) {
		const peerState = cleanText(peer?.status?.peer_state);
		if (peer?.has_error || peerState === "degraded") return "needs-repair";
		if (peerState === "online") return "connected";
		if (peerState === "offline" || peerState === "stale") return "offline";
		if (peer?.status?.fresh) return "connected";
		return "waiting";
	}
	function isOfflineTeamDevice(device) {
		if (!device.discovered?.stale) return false;
		return device.peer ? derivePeerUiStatus(device.peer) !== "connected" : true;
	}
	function peerErrorText(peer) {
		return cleanText(peer?.last_error).toLowerCase();
	}
	function derivePeerTrustSummary(peer) {
		const peerStatus = peer?.status || {};
		const peerState = cleanText(peerStatus.peer_state);
		const lastError = peerErrorText(peer);
		const syncOk = cleanText(peerStatus.sync_status) === "ok" || cleanText(peerStatus.ping_status) === "ok";
		if (peerState === "offline" || peerState === "stale") return {
			state: "offline",
			badgeLabel: "Offline",
			description: "This device is known locally, but it is not reachable right now.",
			isWarning: true
		};
		if (lastError.includes("401") && lastError.includes("unauthorized")) return {
			state: "trusted-by-you",
			badgeLabel: "Waiting for other device",
			description: "You accepted this device, but the other device still needs to trust this one before sync can work.",
			isWarning: true
		};
		if (syncOk || peerState === "online") return {
			state: "mutual-trust",
			badgeLabel: "Two-way trust",
			description: "Both devices trust each other and sync can run in both directions.",
			isWarning: false
		};
		if (peer?.has_error || peerState === "degraded") return {
			state: "needs-repair",
			badgeLabel: "Needs repair",
			description: "This device has a sync problem that needs review before trust can be relied on.",
			isWarning: true
		};
		return {
			state: "trusted-by-you",
			badgeLabel: "Trusted on this device",
			description: "This device is trusted locally. Finish onboarding on the other device if sync is still blocked.",
			isWarning: false
		};
	}
	function deriveCoordinatorApprovalSummary(input) {
		if (Boolean(input.device?.needs_local_approval) && !input.pairedLocally) return {
			state: "needs-your-approval",
			badgeLabel: "Needs your approval",
			description: "Another device already trusted this one. Approve it on this device to finish reciprocal onboarding.",
			actionLabel: "Approve on this device"
		};
		if (Boolean(input.device?.waiting_for_peer_approval)) return {
			state: "waiting-for-other-device",
			badgeLabel: "Waiting on other device",
			description: "You already trusted this device here. The other device still needs to approve this one before sync can work both ways.",
			actionLabel: null
		};
		return {
			state: "none",
			badgeLabel: null,
			description: null,
			actionLabel: null
		};
	}
	function summarizeSyncRunResult(payload) {
		const items = Array.isArray(payload?.items) ? payload.items : [];
		if (!items.length) return {
			ok: true,
			message: "Sync pass completed with no eligible devices.",
			warning: false
		};
		const failedItems = items.filter((item) => item && item.ok === false);
		if (!failedItems.length) return {
			ok: true,
			message: `Sync pass finished for ${items.length} device${items.length === 1 ? "" : "s"}.`,
			warning: false
		};
		if (failedItems.filter((item) => cleanText(item.error).toLowerCase().includes("401") && cleanText(item.error).toLowerCase().includes("unauthorized")).length === failedItems.length) return {
			ok: false,
			message: "This device trusts the peer, but the other device still needs to trust this one before sync can work.",
			warning: true
		};
		if (failedItems.length < items.length) return {
			ok: false,
			message: `${failedItems.length} of ${items.length} device sync attempts failed. Review device details for the specific errors.`,
			warning: true
		};
		return {
			ok: false,
			message: cleanText(failedItems[0]?.error) || "Sync failed for at least one device.",
			warning: true
		};
	}
	function deriveDuplicatePeople(actors) {
		const groups = /* @__PURE__ */ new Map();
		(Array.isArray(actors) ? actors : []).forEach((actor) => {
			const displayName = cleanText(actor?.display_name);
			const actorId = cleanText(actor?.actor_id);
			const normalized = normalizeDisplayName(displayName);
			if (!displayName || !actorId || !normalized) return;
			const current = groups.get(normalized) ?? {
				displayName,
				actorIds: [],
				includesLocal: false
			};
			current.actorIds = [...current.actorIds, actorId];
			current.includesLocal = current.includesLocal || Boolean(actor?.is_local);
			groups.set(normalized, current);
		});
		return [...groups.values()].filter((item) => item.actorIds.length > 1).sort((a, b) => a.displayName.localeCompare(b.displayName));
	}
	function deriveVisiblePeopleActors(input) {
		const actors = Array.isArray(input.actors) ? input.actors : [];
		const peers = Array.isArray(input.peers) ? input.peers : [];
		const duplicatePeople = Array.isArray(input.duplicatePeople) ? input.duplicatePeople : [];
		const assignedCounts = /* @__PURE__ */ new Map();
		peers.forEach((peer) => {
			const actorId = cleanText(peer?.actor_id);
			if (!actorId) return;
			assignedCounts.set(actorId, (assignedCounts.get(actorId) ?? 0) + 1);
		});
		const hiddenIds = /* @__PURE__ */ new Set();
		duplicatePeople.forEach((candidate) => {
			if (!candidate.includesLocal) return;
			candidate.actorIds.forEach((actorId) => {
				const actor = actors.find((item) => cleanText(item?.actor_id) === actorId);
				if (!actor || actor.is_local) return;
				if ((assignedCounts.get(actorId) ?? 0) > 0) return;
				hiddenIds.add(actorId);
			});
		});
		return {
			visibleActors: actors.filter((actor) => !hiddenIds.has(cleanText(actor?.actor_id))),
			hiddenLocalDuplicateCount: hiddenIds.size
		};
	}
	function createRepairItem(device) {
		return {
			id: `repair:${device.id}`,
			kind: "device-needs-repair",
			priority: 10,
			title: `${device.name} needs repair`,
			summary: device.summary,
			actionLabel: "Open device",
			deviceId: device.id
		};
	}
	function createReviewItem(device) {
		return {
			id: `review:${device.id}:${device.key || "default"}`,
			kind: "review-team-device",
			priority: 20,
			title: `${device.name} is available to review`,
			summary: device.summary,
			actionLabel: "Open device",
			deviceId: device.id
		};
	}
	function createNamingItem(device) {
		return {
			id: `name:${device.id}`,
			kind: "name-device",
			priority: 30,
			title: `Name ${device.name}`,
			summary: device.summary,
			actionLabel: "Go to name field",
			deviceId: device.id
		};
	}
	function mergeDevices(peers, discoveredDevices) {
		const devices = /* @__PURE__ */ new Map();
		const getOrCreate = (deviceId) => {
			const current = devices.get(deviceId) ?? {
				deviceId,
				localName: "",
				coordinatorName: "",
				peer: null,
				discovered: null
			};
			devices.set(deviceId, current);
			return current;
		};
		peers.forEach((peer) => {
			const deviceId = cleanText(peer?.peer_device_id);
			if (!deviceId) return;
			const current = getOrCreate(deviceId);
			current.peer = peer;
			current.localName = cleanText(peer?.name);
		});
		discoveredDevices.forEach((device) => {
			const deviceId = cleanText(device?.device_id);
			if (!deviceId) return;
			const current = getOrCreate(deviceId);
			current.discovered = device;
			current.coordinatorName = cleanText(device?.display_name);
		});
		return [...devices.values()];
	}
	function deriveSyncViewModel(input) {
		const actors = Array.isArray(input.actors) ? input.actors : [];
		const peers = Array.isArray(input.peers) ? input.peers : [];
		const discoveredDevices = Array.isArray(input.coordinator?.discovered_devices) ? input.coordinator.discovered_devices : [];
		const mergedDevices = mergeDevices(peers, discoveredDevices);
		const duplicateDecisions = input.duplicatePersonDecisions ?? {};
		const duplicatePeople = deriveDuplicatePeople(actors).filter((candidate) => !duplicateDecisions[[...candidate.actorIds].sort().join("::")]);
		const attentionItems = [];
		duplicatePeople.forEach((candidate) => {
			attentionItems.push({
				id: `duplicate:${candidate.actorIds.join(":")}`,
				kind: "possible-duplicate-person",
				priority: candidate.includesLocal ? 5 : 15,
				title: `Possible duplicate person: ${candidate.displayName}`,
				summary: candidate.includesLocal ? "At least one entry is marked as you. Confirm whether these records represent the same person." : "Multiple people share this name. Confirm whether they should stay separate or be combined.",
				actionLabel: "Go to people",
				actorIds: candidate.actorIds
			});
		});
		mergedDevices.forEach((device) => {
			const name = resolveFriendlyDeviceName({
				localName: device.localName,
				coordinatorName: device.coordinatorName,
				deviceId: device.deviceId
			});
			const peerStatus = device.peer ? derivePeerUiStatus(device.peer) : "waiting";
			const trustSummary = device.peer ? derivePeerTrustSummary(device.peer) : null;
			const discoveredFingerprint = cleanText(device.discovered?.fingerprint);
			const peerFingerprint = cleanText(device.peer?.fingerprint);
			if (Boolean(device.peer) && Boolean(discoveredFingerprint) && Boolean(peerFingerprint) && discoveredFingerprint !== peerFingerprint) {
				attentionItems.push(createRepairItem({
					id: device.deviceId,
					name,
					summary: "This device identity changed. Repair or remove the older local record before reconnecting it."
				}));
				return;
			}
			if (device.peer && peerStatus === "needs-repair") {
				const detail = trustSummary?.state === "trusted-by-you" ? trustSummary.description : cleanText(device.peer?.last_error) || "Sync health is degraded or broken.";
				attentionItems.push(createRepairItem({
					id: device.deviceId,
					name,
					summary: detail
				}));
			} else if (device.peer && peerStatus === "offline") attentionItems.push(createRepairItem({
				id: device.deviceId,
				name,
				summary: "This device is offline or stale. Review it before re-pairing or retrying sync."
			}));
			if (device.peer && trustSummary?.state === "trusted-by-you") attentionItems.push(createReviewItem({
				id: device.deviceId,
				key: "other-device-trust",
				name,
				summary: "You accepted this device. Finish onboarding on the other device so it trusts this one too."
			}));
			if (!device.peer && device.discovered?.stale) attentionItems.push(createReviewItem({
				id: device.deviceId,
				key: "stale-discovery",
				name,
				summary: "This device is no longer advertising fresh coordinator presence. Wait for it to check in again before connecting it here."
			}));
			if (!device.peer && Array.isArray(device.discovered?.groups) && device.discovered.groups.length > 1) attentionItems.push(createReviewItem({
				id: device.deviceId,
				key: "ambiguous-groups",
				name,
				summary: "This device appears in multiple coordinator groups. Review the team setup before approving it here."
			}));
			if (device.peer && deviceNeedsFriendlyName({
				localName: device.localName,
				coordinatorName: device.coordinatorName,
				deviceId: device.deviceId
			})) attentionItems.push(createNamingItem({
				id: device.deviceId,
				name,
				summary: "Give this device a friendly name so it is easier to recognize later."
			}));
		});
		return {
			summary: {
				connectedDeviceCount: peers.filter((peer) => derivePeerUiStatus(peer) === "connected").length,
				seenOnTeamCount: discoveredDevices.length,
				offlineTeamDeviceCount: mergedDevices.filter((device) => isOfflineTeamDevice(device)).length
			},
			duplicatePeople,
			attentionItems: attentionItems.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title))
		};
	}
	//#endregion
	//#region ../../node_modules/.pnpm/preact@10.29.0/node_modules/preact/compat/dist/compat.module.js
	var compat_module_exports = /* @__PURE__ */ __exportAll({
		Children: () => L,
		Component: () => x$2,
		Fragment: () => k$2,
		PureComponent: () => M,
		StrictMode: () => k$2,
		Suspense: () => P,
		SuspenseList: () => B,
		__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: () => fn,
		cloneElement: () => mn,
		createContext: () => R$1,
		createElement: () => _$1,
		createFactory: () => sn,
		createPortal: () => $,
		createRef: () => b$1,
		default: () => gn,
		findDOMNode: () => yn,
		flushSync: () => bn,
		forwardRef: () => D,
		hydrate: () => tn,
		isElement: () => Sn,
		isFragment: () => vn,
		isMemo: () => dn,
		isValidElement: () => hn,
		lazy: () => z,
		memo: () => N,
		render: () => nn,
		startTransition: () => x,
		unmountComponentAtNode: () => pn,
		unstable_batchedUpdates: () => _n,
		useCallback: () => q$1,
		useContext: () => x$1,
		useDebugValue: () => P$1,
		useDeferredValue: () => w,
		useEffect: () => y,
		useErrorBoundary: () => b,
		useId: () => g$1,
		useImperativeHandle: () => F$1,
		useInsertionEffect: () => I,
		useLayoutEffect: () => _,
		useMemo: () => T$1,
		useReducer: () => h,
		useRef: () => A$1,
		useState: () => d,
		useSyncExternalStore: () => C,
		useTransition: () => k,
		version: () => an
	});
	function g(n, t) {
		for (var e in t) n[e] = t[e];
		return n;
	}
	function E(n, t) {
		for (var e in n) if ("__source" !== e && !(e in t)) return !0;
		for (var r in t) if ("__source" !== r && n[r] !== t[r]) return !0;
		return !1;
	}
	function C(n, t) {
		var e = t(), r = d({ t: {
			__: e,
			u: t
		} }), u = r[0].t, o = r[1];
		return _(function() {
			u.__ = e, u.u = t, R(u) && o({ t: u });
		}, [
			n,
			e,
			t
		]), y(function() {
			return R(u) && o({ t: u }), n(function() {
				R(u) && o({ t: u });
			});
		}, [n]), e;
	}
	function R(n) {
		try {
			return !((t = n.__) === (e = n.u()) && (0 !== t || 1 / t == 1 / e) || t != t && e != e);
		} catch (n) {
			return !0;
		}
		var t, e;
	}
	function x(n) {
		n();
	}
	function w(n) {
		return n;
	}
	function k() {
		return [!1, x];
	}
	var I = _;
	function M(n, t) {
		this.props = n, this.context = t;
	}
	function N(n, e) {
		function r(n) {
			var t = this.props.ref;
			return t != n.ref && t && ("function" == typeof t ? t(null) : t.current = null), e ? !e(this.props, n) || t != n.ref : E(this.props, n);
		}
		function u(e) {
			return this.shouldComponentUpdate = r, _$1(n, e);
		}
		return u.displayName = "Memo(" + (n.displayName || n.name) + ")", u.__f = u.prototype.isReactComponent = !0, u.type = n, u;
	}
	(M.prototype = new x$2()).isPureReactComponent = !0, M.prototype.shouldComponentUpdate = function(n, t) {
		return E(this.props, n) || E(this.state, t);
	};
	var T = l$1.__b;
	l$1.__b = function(n) {
		n.type && n.type.__f && n.ref && (n.props.ref = n.ref, n.ref = null), T && T(n);
	};
	var A = "undefined" != typeof Symbol && Symbol.for && Symbol.for("react.forward_ref") || 3911;
	function D(n) {
		function t(t) {
			var e = g({}, t);
			return delete e.ref, n(e, t.ref || null);
		}
		return t.$$typeof = A, t.render = n, t.prototype.isReactComponent = t.__f = !0, t.displayName = "ForwardRef(" + (n.displayName || n.name) + ")", t;
	}
	var F = function(n, t) {
		return null == n ? null : L$1(L$1(n).map(t));
	}, L = {
		map: F,
		forEach: F,
		count: function(n) {
			return n ? L$1(n).length : 0;
		},
		only: function(n) {
			var t = L$1(n);
			if (1 !== t.length) throw "Children.only";
			return t[0];
		},
		toArray: L$1
	}, O = l$1.__e;
	l$1.__e = function(n, t, e, r) {
		if (n.then) {
			for (var u, o = t; o = o.__;) if ((u = o.__c) && u.__c) return t.__e ?? (t.__e = e.__e, t.__k = e.__k), u.__c(n, t);
		}
		O(n, t, e, r);
	};
	var U = l$1.unmount;
	function V(n, t, e) {
		return n && (n.__c && n.__c.__H && (n.__c.__H.__.forEach(function(n) {
			"function" == typeof n.__c && n.__c();
		}), n.__c.__H = null), null != (n = g({}, n)).__c && (n.__c.__P === e && (n.__c.__P = t), n.__c.__e = !0, n.__c = null), n.__k = n.__k && n.__k.map(function(n) {
			return V(n, t, e);
		})), n;
	}
	function W(n, t, e) {
		return n && e && (n.__v = null, n.__k = n.__k && n.__k.map(function(n) {
			return W(n, t, e);
		}), n.__c && n.__c.__P === t && (n.__e && e.appendChild(n.__e), n.__c.__e = !0, n.__c.__P = e)), n;
	}
	function P() {
		this.__u = 0, this.o = null, this.__b = null;
	}
	function j(n) {
		var t = n.__ && n.__.__c;
		return t && t.__a && t.__a(n);
	}
	function z(n) {
		var e, r, u, o = null;
		function i(i) {
			if (e || (e = n()).then(function(n) {
				n && (o = n.default || n), u = !0;
			}, function(n) {
				r = n, u = !0;
			}), r) throw r;
			if (!u) throw e;
			return o ? _$1(o, i) : null;
		}
		return i.displayName = "Lazy", i.__f = !0, i;
	}
	function B() {
		this.i = null, this.l = null;
	}
	l$1.unmount = function(n) {
		var t = n.__c;
		t && (t.__z = !0), t && t.__R && t.__R(), t && 32 & n.__u && (n.type = null), U && U(n);
	}, (P.prototype = new x$2()).__c = function(n, t) {
		var e = t.__c, r = this;
		r.o ??= [], r.o.push(e);
		var u = j(r.__v), o = !1, i = function() {
			o || r.__z || (o = !0, e.__R = null, u ? u(c) : c());
		};
		e.__R = i;
		var l = e.__P;
		e.__P = null;
		var c = function() {
			if (!--r.__u) {
				if (r.state.__a) {
					var n = r.state.__a;
					r.__v.__k[0] = W(n, n.__c.__P, n.__c.__O);
				}
				var t;
				for (r.setState({ __a: r.__b = null }); t = r.o.pop();) t.__P = l, t.forceUpdate();
			}
		};
		r.__u++ || 32 & t.__u || r.setState({ __a: r.__b = r.__v.__k[0] }), n.then(i, i);
	}, P.prototype.componentWillUnmount = function() {
		this.o = [];
	}, P.prototype.render = function(n, e) {
		if (this.__b) {
			if (this.__v.__k) {
				var r = document.createElement("div"), o = this.__v.__k[0].__c;
				this.__v.__k[0] = V(this.__b, r, o.__O = o.__P);
			}
			this.__b = null;
		}
		var i = e.__a && _$1(k$2, null, n.fallback);
		return i && (i.__u &= -33), [_$1(k$2, null, e.__a ? null : n.children), i];
	};
	var H = function(n, t, e) {
		if (++e[1] === e[0] && n.l.delete(t), n.props.revealOrder && ("t" !== n.props.revealOrder[0] || !n.l.size)) for (e = n.i; e;) {
			for (; e.length > 3;) e.pop()();
			if (e[1] < e[0]) break;
			n.i = e = e[2];
		}
	};
	function Z(n) {
		return this.getChildContext = function() {
			return n.context;
		}, n.children;
	}
	function Y(n) {
		var e = this, r = n.h;
		if (e.componentWillUnmount = function() {
			J$1(null, e.v), e.v = null, e.h = null;
		}, e.h && e.h !== r && e.componentWillUnmount(), !e.v) {
			for (var u = e.__v; null !== u && !u.__m && null !== u.__;) u = u.__;
			e.h = r, e.v = {
				nodeType: 1,
				parentNode: r,
				childNodes: [],
				__k: { __m: u.__m },
				contains: function() {
					return !0;
				},
				namespaceURI: r.namespaceURI,
				insertBefore: function(n, t) {
					this.childNodes.push(n), e.h.insertBefore(n, t);
				},
				removeChild: function(n) {
					this.childNodes.splice(this.childNodes.indexOf(n) >>> 1, 1), e.h.removeChild(n);
				}
			};
		}
		J$1(_$1(Z, { context: e.context }, n.__v), e.v);
	}
	function $(n, e) {
		var r = _$1(Y, {
			__v: n,
			h: e
		});
		return r.containerInfo = e, r;
	}
	(B.prototype = new x$2()).__a = function(n) {
		var t = this, e = j(t.__v), r = t.l.get(n);
		return r[0]++, function(u) {
			var o = function() {
				t.props.revealOrder ? (r.push(u), H(t, n, r)) : u();
			};
			e ? e(o) : o();
		};
	}, B.prototype.render = function(n) {
		this.i = null, this.l = /* @__PURE__ */ new Map();
		var t = L$1(n.children);
		n.revealOrder && "b" === n.revealOrder[0] && t.reverse();
		for (var e = t.length; e--;) this.l.set(t[e], this.i = [
			1,
			0,
			this.i
		]);
		return n.children;
	}, B.prototype.componentDidUpdate = B.prototype.componentDidMount = function() {
		var n = this;
		this.l.forEach(function(t, e) {
			H(n, e, t);
		});
	};
	var q = "undefined" != typeof Symbol && Symbol.for && Symbol.for("react.element") || 60103, G = /^(?:accent|alignment|arabic|baseline|cap|clip(?!PathU)|color|dominant|fill|flood|font|glyph(?!R)|horiz|image(!S)|letter|lighting|marker(?!H|W|U)|overline|paint|pointer|shape|stop|strikethrough|stroke|text(?!L)|transform|underline|unicode|units|v|vector|vert|word|writing|x(?!C))[A-Z]/, J = /^on(Ani|Tra|Tou|BeforeInp|Compo)/, K = /[A-Z0-9]/g, Q = "undefined" != typeof document, X = function(n) {
		return ("undefined" != typeof Symbol && "symbol" == typeof Symbol() ? /fil|che|rad/ : /fil|che|ra/).test(n);
	};
	function nn(n, t, e) {
		return t.__k ?? (t.textContent = ""), J$1(n, t), "function" == typeof e && e(), n ? n.__c : null;
	}
	function tn(n, t, e) {
		return K$1(n, t), "function" == typeof e && e(), n ? n.__c : null;
	}
	x$2.prototype.isReactComponent = !0, [
		"componentWillMount",
		"componentWillReceiveProps",
		"componentWillUpdate"
	].forEach(function(t) {
		Object.defineProperty(x$2.prototype, t, {
			configurable: !0,
			get: function() {
				return this["UNSAFE_" + t];
			},
			set: function(n) {
				Object.defineProperty(this, t, {
					configurable: !0,
					writable: !0,
					value: n
				});
			}
		});
	});
	var en = l$1.event;
	l$1.event = function(n) {
		return en && (n = en(n)), n.persist = function() {}, n.isPropagationStopped = function() {
			return this.cancelBubble;
		}, n.isDefaultPrevented = function() {
			return this.defaultPrevented;
		}, n.nativeEvent = n;
	};
	var rn, un = {
		configurable: !0,
		get: function() {
			return this.class;
		}
	}, on = l$1.vnode;
	l$1.vnode = function(n) {
		"string" == typeof n.type && function(n) {
			var t = n.props, e = n.type, u = {}, o = -1 == e.indexOf("-");
			for (var i in t) {
				var l = t[i];
				if (!("value" === i && "defaultValue" in t && null == l || Q && "children" === i && "noscript" === e || "class" === i || "className" === i)) {
					var c = i.toLowerCase();
					"defaultValue" === i && "value" in t && null == t.value ? i = "value" : "download" === i && !0 === l ? l = "" : "translate" === c && "no" === l ? l = !1 : "o" === c[0] && "n" === c[1] ? "ondoubleclick" === c ? i = "ondblclick" : "onchange" !== c || "input" !== e && "textarea" !== e || X(t.type) ? "onfocus" === c ? i = "onfocusin" : "onblur" === c ? i = "onfocusout" : J.test(i) && (i = c) : c = i = "oninput" : o && G.test(i) ? i = i.replace(K, "-$&").toLowerCase() : null === l && (l = void 0), "oninput" === c && u[i = c] && (i = "oninputCapture"), u[i] = l;
				}
			}
			"select" == e && (u.multiple && Array.isArray(u.value) && (u.value = L$1(t.children).forEach(function(n) {
				n.props.selected = -1 != u.value.indexOf(n.props.value);
			})), null != u.defaultValue && (u.value = L$1(t.children).forEach(function(n) {
				n.props.selected = u.multiple ? -1 != u.defaultValue.indexOf(n.props.value) : u.defaultValue == n.props.value;
			}))), t.class && !t.className ? (u.class = t.class, Object.defineProperty(u, "className", un)) : t.className && (u.class = u.className = t.className), n.props = u;
		}(n), n.$$typeof = q, on && on(n);
	};
	var ln = l$1.__r;
	l$1.__r = function(n) {
		ln && ln(n), rn = n.__c;
	};
	var cn = l$1.diffed;
	l$1.diffed = function(n) {
		cn && cn(n);
		var t = n.props, e = n.__e;
		null != e && "textarea" === n.type && "value" in t && t.value !== e.value && (e.value = null == t.value ? "" : t.value), rn = null;
	};
	var fn = { ReactCurrentDispatcher: { current: {
		readContext: function(n) {
			return rn.__n[n.__c].props.value;
		},
		useCallback: q$1,
		useContext: x$1,
		useDebugValue: P$1,
		useDeferredValue: w,
		useEffect: y,
		useId: g$1,
		useImperativeHandle: F$1,
		useInsertionEffect: I,
		useLayoutEffect: _,
		useMemo: T$1,
		useReducer: h,
		useRef: A$1,
		useState: d,
		useSyncExternalStore: C,
		useTransition: k
	} } }, an = "18.3.1";
	function sn(n) {
		return _$1.bind(null, n);
	}
	function hn(n) {
		return !!n && n.$$typeof === q;
	}
	function vn(n) {
		return hn(n) && n.type === k$2;
	}
	function dn(n) {
		return !!n && "string" == typeof n.displayName && 0 == n.displayName.indexOf("Memo(");
	}
	function mn(n) {
		return hn(n) ? Q$1.apply(null, arguments) : n;
	}
	function pn(n) {
		return !!n.__k && (J$1(null, n), !0);
	}
	function yn(n) {
		return n && (n.base || 1 === n.nodeType && n) || null;
	}
	var _n = function(n, t) {
		return n(t);
	}, bn = function(n, t) {
		var r = l$1.debounceRendering;
		l$1.debounceRendering = function(n) {
			return n();
		};
		var u = n(t);
		return l$1.debounceRendering = r, u;
	}, Sn = hn, gn = {
		useState: d,
		useId: g$1,
		useReducer: h,
		useEffect: y,
		useLayoutEffect: _,
		useInsertionEffect: I,
		useTransition: k,
		useDeferredValue: w,
		useSyncExternalStore: C,
		startTransition: x,
		useRef: A$1,
		useImperativeHandle: F$1,
		useMemo: T$1,
		useCallback: q$1,
		useContext: x$1,
		useDebugValue: P$1,
		version: "18.3.1",
		Children: L,
		render: nn,
		hydrate: tn,
		unmountComponentAtNode: pn,
		createPortal: $,
		createElement: _$1,
		createContext: R$1,
		createFactory: sn,
		cloneElement: mn,
		createRef: b$1,
		Fragment: k$2,
		isValidElement: hn,
		isElement: Sn,
		isFragment: vn,
		isMemo: dn,
		findDOMNode: yn,
		Component: x$2,
		PureComponent: M,
		memo: N,
		forwardRef: D,
		flushSync: bn,
		unstable_batchedUpdates: _n,
		StrictMode: k$2,
		Suspense: P,
		SuspenseList: B,
		lazy: z,
		__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: fn
	};
	typeof window !== "undefined" && window.document && window.document.createElement;
	function composeEventHandlers(originalEventHandler, ourEventHandler, { checkForDefaultPrevented = true } = {}) {
		return function handleEvent(event) {
			originalEventHandler?.(event);
			if (checkForDefaultPrevented === false || !event.defaultPrevented) return ourEventHandler?.(event);
		};
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-compose-refs@1.1.2_react@19.2.4/node_modules/@radix-ui/react-compose-refs/dist/index.mjs
	function setRef(ref, value) {
		if (typeof ref === "function") return ref(value);
		else if (ref !== null && ref !== void 0) ref.current = value;
	}
	function composeRefs(...refs) {
		return (node) => {
			let hasCleanup = false;
			const cleanups = refs.map((ref) => {
				const cleanup = setRef(ref, node);
				if (!hasCleanup && typeof cleanup == "function") hasCleanup = true;
				return cleanup;
			});
			if (hasCleanup) return () => {
				for (let i = 0; i < cleanups.length; i++) {
					const cleanup = cleanups[i];
					if (typeof cleanup == "function") cleanup();
					else setRef(refs[i], null);
				}
			};
		};
	}
	function useComposedRefs(...refs) {
		return q$1(composeRefs(...refs), refs);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/preact@10.29.0/node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js
	var f = 0;
	Array.isArray;
	function u(e, t, n, o, i, u) {
		t || (t = {});
		var a, c, p = t;
		if ("ref" in p) for (c in p = {}, t) "ref" == c ? a = t[c] : p[c] = t[c];
		var l = {
			type: e,
			props: p,
			key: n,
			ref: a,
			__k: null,
			__: null,
			__b: 0,
			__e: null,
			__c: null,
			constructor: void 0,
			__v: --f,
			__i: -1,
			__u: 0,
			__source: i,
			__self: u
		};
		if ("function" == typeof e && (a = e.defaultProps)) for (c in a) void 0 === p[c] && (p[c] = a[c]);
		return l$1.vnode && l$1.vnode(l), l;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-context@1.1.2_react@19.2.4/node_modules/@radix-ui/react-context/dist/index.mjs
	function createContext2(rootComponentName, defaultContext) {
		const Context = R$1(defaultContext);
		const Provider = (props) => {
			const { children, ...context } = props;
			const value = T$1(() => context, Object.values(context));
			return /* @__PURE__ */ u(Context.Provider, {
				value,
				children
			});
		};
		Provider.displayName = rootComponentName + "Provider";
		function useContext2(consumerName) {
			const context = x$1(Context);
			if (context) return context;
			if (defaultContext !== void 0) return defaultContext;
			throw new Error(`\`${consumerName}\` must be used within \`${rootComponentName}\``);
		}
		return [Provider, useContext2];
	}
	function createContextScope(scopeName, createContextScopeDeps = []) {
		let defaultContexts = [];
		function createContext3(rootComponentName, defaultContext) {
			const BaseContext = R$1(defaultContext);
			const index = defaultContexts.length;
			defaultContexts = [...defaultContexts, defaultContext];
			const Provider = (props) => {
				const { scope, children, ...context } = props;
				const Context = scope?.[scopeName]?.[index] || BaseContext;
				const value = T$1(() => context, Object.values(context));
				return /* @__PURE__ */ u(Context.Provider, {
					value,
					children
				});
			};
			Provider.displayName = rootComponentName + "Provider";
			function useContext2(consumerName, scope) {
				const context = x$1(scope?.[scopeName]?.[index] || BaseContext);
				if (context) return context;
				if (defaultContext !== void 0) return defaultContext;
				throw new Error(`\`${consumerName}\` must be used within \`${rootComponentName}\``);
			}
			return [Provider, useContext2];
		}
		const createScope = () => {
			const scopeContexts = defaultContexts.map((defaultContext) => {
				return R$1(defaultContext);
			});
			return function useScope(scope) {
				const contexts = scope?.[scopeName] || scopeContexts;
				return T$1(() => ({ [`__scope${scopeName}`]: {
					...scope,
					[scopeName]: contexts
				} }), [scope, contexts]);
			};
		};
		createScope.scopeName = scopeName;
		return [createContext3, composeContextScopes(createScope, ...createContextScopeDeps)];
	}
	function composeContextScopes(...scopes) {
		const baseScope = scopes[0];
		if (scopes.length === 1) return baseScope;
		const createScope = () => {
			const scopeHooks = scopes.map((createScope2) => ({
				useScope: createScope2(),
				scopeName: createScope2.scopeName
			}));
			return function useComposedScopes(overrideScopes) {
				const nextScopes = scopeHooks.reduce((nextScopes2, { useScope, scopeName }) => {
					const currentScope = useScope(overrideScopes)[`__scope${scopeName}`];
					return {
						...nextScopes2,
						...currentScope
					};
				}, {});
				return T$1(() => ({ [`__scope${baseScope.scopeName}`]: nextScopes }), [nextScopes]);
			};
		};
		createScope.scopeName = baseScope.scopeName;
		return createScope;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-use-layout-effect@1.1.1_react@19.2.4/node_modules/@radix-ui/react-use-layout-effect/dist/index.mjs
	var useLayoutEffect2 = globalThis?.document ? _ : () => {};
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-use-controllable-state@1.2.2_react@19.2.4/node_modules/@radix-ui/react-use-controllable-state/dist/index.mjs
	var useInsertionEffect = compat_module_exports[" useInsertionEffect ".trim().toString()] || useLayoutEffect2;
	function useControllableState({ prop, defaultProp, onChange = () => {}, caller }) {
		const [uncontrolledProp, setUncontrolledProp, onChangeRef] = useUncontrolledState({
			defaultProp,
			onChange
		});
		const isControlled = prop !== void 0;
		const value = isControlled ? prop : uncontrolledProp;
		{
			const isControlledRef = A$1(prop !== void 0);
			y(() => {
				const wasControlled = isControlledRef.current;
				if (wasControlled !== isControlled) console.warn(`${caller} is changing from ${wasControlled ? "controlled" : "uncontrolled"} to ${isControlled ? "controlled" : "uncontrolled"}. Components should not switch from controlled to uncontrolled (or vice versa). Decide between using a controlled or uncontrolled value for the lifetime of the component.`);
				isControlledRef.current = isControlled;
			}, [isControlled, caller]);
		}
		return [value, q$1((nextValue) => {
			if (isControlled) {
				const value2 = isFunction(nextValue) ? nextValue(prop) : nextValue;
				if (value2 !== prop) onChangeRef.current?.(value2);
			} else setUncontrolledProp(nextValue);
		}, [
			isControlled,
			prop,
			setUncontrolledProp,
			onChangeRef
		])];
	}
	function useUncontrolledState({ defaultProp, onChange }) {
		const [value, setValue] = d(defaultProp);
		const prevValueRef = A$1(value);
		const onChangeRef = A$1(onChange);
		useInsertionEffect(() => {
			onChangeRef.current = onChange;
		}, [onChange]);
		y(() => {
			if (prevValueRef.current !== value) {
				onChangeRef.current?.(value);
				prevValueRef.current = value;
			}
		}, [value, prevValueRef]);
		return [
			value,
			setValue,
			onChangeRef
		];
	}
	function isFunction(value) {
		return typeof value === "function";
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-use-previous@1.1.1_react@19.2.4/node_modules/@radix-ui/react-use-previous/dist/index.mjs
	function usePrevious(value) {
		const ref = A$1({
			value,
			previous: value
		});
		return T$1(() => {
			if (ref.current.value !== value) {
				ref.current.previous = ref.current.value;
				ref.current.value = value;
			}
			return ref.current.previous;
		}, [value]);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-use-size@1.1.1_react@19.2.4/node_modules/@radix-ui/react-use-size/dist/index.mjs
	function useSize(element) {
		const [size, setSize] = d(void 0);
		useLayoutEffect2(() => {
			if (element) {
				setSize({
					width: element.offsetWidth,
					height: element.offsetHeight
				});
				const resizeObserver = new ResizeObserver((entries) => {
					if (!Array.isArray(entries)) return;
					if (!entries.length) return;
					const entry = entries[0];
					let width;
					let height;
					if ("borderBoxSize" in entry) {
						const borderSizeEntry = entry["borderBoxSize"];
						const borderSize = Array.isArray(borderSizeEntry) ? borderSizeEntry[0] : borderSizeEntry;
						width = borderSize["inlineSize"];
						height = borderSize["blockSize"];
					} else {
						width = element.offsetWidth;
						height = element.offsetHeight;
					}
					setSize({
						width,
						height
					});
				});
				resizeObserver.observe(element, { box: "border-box" });
				return () => resizeObserver.unobserve(element);
			} else setSize(void 0);
		}, [element]);
		return size;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-slot@1.2.3_react@19.2.4/node_modules/@radix-ui/react-slot/dist/index.mjs
	/* @__NO_SIDE_EFFECTS__ */
	function createSlot(ownerName) {
		const SlotClone = /* @__PURE__ */ createSlotClone(ownerName);
		const Slot2 = D((props, forwardedRef) => {
			const { children, ...slotProps } = props;
			const childrenArray = L.toArray(children);
			const slottable = childrenArray.find(isSlottable);
			if (slottable) {
				const newElement = slottable.props.children;
				const newChildren = childrenArray.map((child) => {
					if (child === slottable) {
						if (L.count(newElement) > 1) return L.only(null);
						return hn(newElement) ? newElement.props.children : null;
					} else return child;
				});
				return /* @__PURE__ */ u(SlotClone, {
					...slotProps,
					ref: forwardedRef,
					children: hn(newElement) ? mn(newElement, void 0, newChildren) : null
				});
			}
			return /* @__PURE__ */ u(SlotClone, {
				...slotProps,
				ref: forwardedRef,
				children
			});
		});
		Slot2.displayName = `${ownerName}.Slot`;
		return Slot2;
	}
	/* @__NO_SIDE_EFFECTS__ */
	function createSlotClone(ownerName) {
		const SlotClone = D((props, forwardedRef) => {
			const { children, ...slotProps } = props;
			if (hn(children)) {
				const childrenRef = getElementRef$1(children);
				const props2 = mergeProps(slotProps, children.props);
				if (children.type !== k$2) props2.ref = forwardedRef ? composeRefs(forwardedRef, childrenRef) : childrenRef;
				return mn(children, props2);
			}
			return L.count(children) > 1 ? L.only(null) : null;
		});
		SlotClone.displayName = `${ownerName}.SlotClone`;
		return SlotClone;
	}
	var SLOTTABLE_IDENTIFIER = Symbol("radix.slottable");
	function isSlottable(child) {
		return hn(child) && typeof child.type === "function" && "__radixId" in child.type && child.type.__radixId === SLOTTABLE_IDENTIFIER;
	}
	function mergeProps(slotProps, childProps) {
		const overrideProps = { ...childProps };
		for (const propName in childProps) {
			const slotPropValue = slotProps[propName];
			const childPropValue = childProps[propName];
			if (/^on[A-Z]/.test(propName)) {
				if (slotPropValue && childPropValue) overrideProps[propName] = (...args) => {
					const result = childPropValue(...args);
					slotPropValue(...args);
					return result;
				};
				else if (slotPropValue) overrideProps[propName] = slotPropValue;
			} else if (propName === "style") overrideProps[propName] = {
				...slotPropValue,
				...childPropValue
			};
			else if (propName === "className") overrideProps[propName] = [slotPropValue, childPropValue].filter(Boolean).join(" ");
		}
		return {
			...slotProps,
			...overrideProps
		};
	}
	function getElementRef$1(element) {
		let getter = Object.getOwnPropertyDescriptor(element.props, "ref")?.get;
		let mayWarn = getter && "isReactWarning" in getter && getter.isReactWarning;
		if (mayWarn) return element.ref;
		getter = Object.getOwnPropertyDescriptor(element, "ref")?.get;
		mayWarn = getter && "isReactWarning" in getter && getter.isReactWarning;
		if (mayWarn) return element.props.ref;
		return element.props.ref || element.ref;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-primitive@2.1.3_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-primitive/dist/index.mjs
	var Primitive = [
		"a",
		"button",
		"div",
		"form",
		"h2",
		"h3",
		"img",
		"input",
		"label",
		"li",
		"nav",
		"ol",
		"p",
		"select",
		"span",
		"svg",
		"ul"
	].reduce((primitive, node) => {
		const Slot = /* @__PURE__ */ createSlot(`Primitive.${node}`);
		const Node = D((props, forwardedRef) => {
			const { asChild, ...primitiveProps } = props;
			const Comp = asChild ? Slot : node;
			if (typeof window !== "undefined") window[Symbol.for("radix-ui")] = true;
			return /* @__PURE__ */ u(Comp, {
				...primitiveProps,
				ref: forwardedRef
			});
		});
		Node.displayName = `Primitive.${node}`;
		return {
			...primitive,
			[node]: Node
		};
	}, {});
	function dispatchDiscreteCustomEvent(target, event) {
		if (target) bn(() => target.dispatchEvent(event));
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-switch@1.2.6_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-switch/dist/index.mjs
	var SWITCH_NAME = "Switch";
	var [createSwitchContext, createSwitchScope] = createContextScope(SWITCH_NAME);
	var [SwitchProvider, useSwitchContext] = createSwitchContext(SWITCH_NAME);
	var Switch = D((props, forwardedRef) => {
		const { __scopeSwitch, name, checked: checkedProp, defaultChecked, required, disabled, value = "on", onCheckedChange, form, ...switchProps } = props;
		const [button, setButton] = d(null);
		const composedRefs = useComposedRefs(forwardedRef, (node) => setButton(node));
		const hasConsumerStoppedPropagationRef = A$1(false);
		const isFormControl = button ? form || !!button.closest("form") : true;
		const [checked, setChecked] = useControllableState({
			prop: checkedProp,
			defaultProp: defaultChecked ?? false,
			onChange: onCheckedChange,
			caller: SWITCH_NAME
		});
		return /* @__PURE__ */ u(SwitchProvider, {
			scope: __scopeSwitch,
			checked,
			disabled,
			children: [/* @__PURE__ */ u(Primitive.button, {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-required": required,
				"data-state": getState$2(checked),
				"data-disabled": disabled ? "" : void 0,
				disabled,
				value,
				...switchProps,
				ref: composedRefs,
				onClick: composeEventHandlers(props.onClick, (event) => {
					setChecked((prevChecked) => !prevChecked);
					if (isFormControl) {
						hasConsumerStoppedPropagationRef.current = event.isPropagationStopped();
						if (!hasConsumerStoppedPropagationRef.current) event.stopPropagation();
					}
				})
			}), isFormControl && /* @__PURE__ */ u(SwitchBubbleInput, {
				control: button,
				bubbles: !hasConsumerStoppedPropagationRef.current,
				name,
				value,
				checked,
				required,
				disabled,
				form,
				style: { transform: "translateX(-100%)" }
			})]
		});
	});
	Switch.displayName = SWITCH_NAME;
	var THUMB_NAME = "SwitchThumb";
	var SwitchThumb = D((props, forwardedRef) => {
		const { __scopeSwitch, ...thumbProps } = props;
		const context = useSwitchContext(THUMB_NAME, __scopeSwitch);
		return /* @__PURE__ */ u(Primitive.span, {
			"data-state": getState$2(context.checked),
			"data-disabled": context.disabled ? "" : void 0,
			...thumbProps,
			ref: forwardedRef
		});
	});
	SwitchThumb.displayName = THUMB_NAME;
	var BUBBLE_INPUT_NAME$1 = "SwitchBubbleInput";
	var SwitchBubbleInput = D(({ __scopeSwitch, control, checked, bubbles = true, ...props }, forwardedRef) => {
		const ref = A$1(null);
		const composedRefs = useComposedRefs(ref, forwardedRef);
		const prevChecked = usePrevious(checked);
		const controlSize = useSize(control);
		y(() => {
			const input = ref.current;
			if (!input) return;
			const inputProto = window.HTMLInputElement.prototype;
			const setChecked = Object.getOwnPropertyDescriptor(inputProto, "checked").set;
			if (prevChecked !== checked && setChecked) {
				const event = new Event("click", { bubbles });
				setChecked.call(input, checked);
				input.dispatchEvent(event);
			}
		}, [
			prevChecked,
			checked,
			bubbles
		]);
		return /* @__PURE__ */ u("input", {
			type: "checkbox",
			"aria-hidden": true,
			defaultChecked: checked,
			...props,
			tabIndex: -1,
			ref: composedRefs,
			style: {
				...props.style,
				...controlSize,
				position: "absolute",
				pointerEvents: "none",
				opacity: 0,
				margin: 0
			}
		});
	});
	SwitchBubbleInput.displayName = BUBBLE_INPUT_NAME$1;
	function getState$2(checked) {
		return checked ? "checked" : "unchecked";
	}
	var Root$3 = Switch;
	var Thumb = SwitchThumb;
	//#endregion
	//#region src/components/primitives/radix-switch.tsx
	function RadixSwitch({ "aria-labelledby": ariaLabelledBy, checked, className, disabled = false, id, name, onCheckedChange, thumbClassName }) {
		return /* @__PURE__ */ u(Root$3, {
			"aria-labelledby": ariaLabelledBy,
			checked,
			className,
			disabled,
			id,
			name,
			onCheckedChange,
			children: /* @__PURE__ */ u(Thumb, { className: thumbClassName })
		});
	}
	//#endregion
	//#region src/tabs/sync/components/render-root.tsx
	function markMount(mount) {
		mount.dataset.syncRenderRoot = "preact";
	}
	function ensureSyncRenderBoundary() {
		const syncTab = document.getElementById("tab-sync");
		if (!syncTab) return;
		syncTab.dataset.syncRenderBoundary = "preact-hybrid";
	}
	function renderIntoSyncMount(mount, content) {
		markMount(mount);
		J$1(content, mount);
	}
	function clearSyncMount(mount) {
		if (mount.dataset.syncRenderRoot !== "preact") return;
		J$1(null, mount);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-presence@1.1.5_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-presence/dist/index.mjs
	function useStateMachine(initialState, machine) {
		return h((state, event) => {
			return machine[state][event] ?? state;
		}, initialState);
	}
	var Presence = (props) => {
		const { present, children } = props;
		const presence = usePresence(present);
		const child = typeof children === "function" ? children({ present: presence.isPresent }) : L.only(children);
		const ref = useComposedRefs(presence.ref, getElementRef(child));
		return typeof children === "function" || presence.isPresent ? mn(child, { ref }) : null;
	};
	Presence.displayName = "Presence";
	function usePresence(present) {
		const [node, setNode] = d();
		const stylesRef = A$1(null);
		const prevPresentRef = A$1(present);
		const prevAnimationNameRef = A$1("none");
		const [state, send] = useStateMachine(present ? "mounted" : "unmounted", {
			mounted: {
				UNMOUNT: "unmounted",
				ANIMATION_OUT: "unmountSuspended"
			},
			unmountSuspended: {
				MOUNT: "mounted",
				ANIMATION_END: "unmounted"
			},
			unmounted: { MOUNT: "mounted" }
		});
		y(() => {
			const currentAnimationName = getAnimationName(stylesRef.current);
			prevAnimationNameRef.current = state === "mounted" ? currentAnimationName : "none";
		}, [state]);
		useLayoutEffect2(() => {
			const styles = stylesRef.current;
			const wasPresent = prevPresentRef.current;
			if (wasPresent !== present) {
				const prevAnimationName = prevAnimationNameRef.current;
				const currentAnimationName = getAnimationName(styles);
				if (present) send("MOUNT");
				else if (currentAnimationName === "none" || styles?.display === "none") send("UNMOUNT");
				else if (wasPresent && prevAnimationName !== currentAnimationName) send("ANIMATION_OUT");
				else send("UNMOUNT");
				prevPresentRef.current = present;
			}
		}, [present, send]);
		useLayoutEffect2(() => {
			if (node) {
				let timeoutId;
				const ownerWindow = node.ownerDocument.defaultView ?? window;
				const handleAnimationEnd = (event) => {
					const isCurrentAnimation = getAnimationName(stylesRef.current).includes(CSS.escape(event.animationName));
					if (event.target === node && isCurrentAnimation) {
						send("ANIMATION_END");
						if (!prevPresentRef.current) {
							const currentFillMode = node.style.animationFillMode;
							node.style.animationFillMode = "forwards";
							timeoutId = ownerWindow.setTimeout(() => {
								if (node.style.animationFillMode === "forwards") node.style.animationFillMode = currentFillMode;
							});
						}
					}
				};
				const handleAnimationStart = (event) => {
					if (event.target === node) prevAnimationNameRef.current = getAnimationName(stylesRef.current);
				};
				node.addEventListener("animationstart", handleAnimationStart);
				node.addEventListener("animationcancel", handleAnimationEnd);
				node.addEventListener("animationend", handleAnimationEnd);
				return () => {
					ownerWindow.clearTimeout(timeoutId);
					node.removeEventListener("animationstart", handleAnimationStart);
					node.removeEventListener("animationcancel", handleAnimationEnd);
					node.removeEventListener("animationend", handleAnimationEnd);
				};
			} else send("ANIMATION_END");
		}, [node, send]);
		return {
			isPresent: ["mounted", "unmountSuspended"].includes(state),
			ref: q$1((node2) => {
				stylesRef.current = node2 ? getComputedStyle(node2) : null;
				setNode(node2);
			}, [])
		};
	}
	function getAnimationName(styles) {
		return styles?.animationName || "none";
	}
	function getElementRef(element) {
		let getter = Object.getOwnPropertyDescriptor(element.props, "ref")?.get;
		let mayWarn = getter && "isReactWarning" in getter && getter.isReactWarning;
		if (mayWarn) return element.ref;
		getter = Object.getOwnPropertyDescriptor(element, "ref")?.get;
		mayWarn = getter && "isReactWarning" in getter && getter.isReactWarning;
		if (mayWarn) return element.props.ref;
		return element.props.ref || element.ref;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-id@1.1.1_react@19.2.4/node_modules/@radix-ui/react-id/dist/index.mjs
	var useReactId = compat_module_exports[" useId ".trim().toString()] || (() => void 0);
	var count$1 = 0;
	function useId(deterministicId) {
		const [id, setId] = d(useReactId());
		useLayoutEffect2(() => {
			if (!deterministicId) setId((reactId) => reactId ?? String(count$1++));
		}, [deterministicId]);
		return deterministicId || (id ? `radix-${id}` : "");
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-collapsible@1.1.12_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-collapsible/dist/index.mjs
	var COLLAPSIBLE_NAME = "Collapsible";
	var [createCollapsibleContext, createCollapsibleScope] = createContextScope(COLLAPSIBLE_NAME);
	var [CollapsibleProvider, useCollapsibleContext] = createCollapsibleContext(COLLAPSIBLE_NAME);
	var Collapsible = D((props, forwardedRef) => {
		const { __scopeCollapsible, open: openProp, defaultOpen, disabled, onOpenChange, ...collapsibleProps } = props;
		const [open, setOpen] = useControllableState({
			prop: openProp,
			defaultProp: defaultOpen ?? false,
			onChange: onOpenChange,
			caller: COLLAPSIBLE_NAME
		});
		return /* @__PURE__ */ u(CollapsibleProvider, {
			scope: __scopeCollapsible,
			disabled,
			contentId: useId(),
			open,
			onOpenToggle: q$1(() => setOpen((prevOpen) => !prevOpen), [setOpen]),
			children: /* @__PURE__ */ u(Primitive.div, {
				"data-state": getState$1(open),
				"data-disabled": disabled ? "" : void 0,
				...collapsibleProps,
				ref: forwardedRef
			})
		});
	});
	Collapsible.displayName = COLLAPSIBLE_NAME;
	var TRIGGER_NAME$2 = "CollapsibleTrigger";
	var CollapsibleTrigger = D((props, forwardedRef) => {
		const { __scopeCollapsible, ...triggerProps } = props;
		const context = useCollapsibleContext(TRIGGER_NAME$2, __scopeCollapsible);
		return /* @__PURE__ */ u(Primitive.button, {
			type: "button",
			"aria-controls": context.contentId,
			"aria-expanded": context.open || false,
			"data-state": getState$1(context.open),
			"data-disabled": context.disabled ? "" : void 0,
			disabled: context.disabled,
			...triggerProps,
			ref: forwardedRef,
			onClick: composeEventHandlers(props.onClick, context.onOpenToggle)
		});
	});
	CollapsibleTrigger.displayName = TRIGGER_NAME$2;
	var CONTENT_NAME$3 = "CollapsibleContent";
	var CollapsibleContent = D((props, forwardedRef) => {
		const { forceMount, ...contentProps } = props;
		const context = useCollapsibleContext(CONTENT_NAME$3, props.__scopeCollapsible);
		return /* @__PURE__ */ u(Presence, {
			present: forceMount || context.open,
			children: ({ present }) => /* @__PURE__ */ u(CollapsibleContentImpl, {
				...contentProps,
				ref: forwardedRef,
				present
			})
		});
	});
	CollapsibleContent.displayName = CONTENT_NAME$3;
	var CollapsibleContentImpl = D((props, forwardedRef) => {
		const { __scopeCollapsible, present, children, ...contentProps } = props;
		const context = useCollapsibleContext(CONTENT_NAME$3, __scopeCollapsible);
		const [isPresent, setIsPresent] = d(present);
		const ref = A$1(null);
		const composedRefs = useComposedRefs(forwardedRef, ref);
		const heightRef = A$1(0);
		const height = heightRef.current;
		const widthRef = A$1(0);
		const width = widthRef.current;
		const isOpen = context.open || isPresent;
		const isMountAnimationPreventedRef = A$1(isOpen);
		const originalStylesRef = A$1(void 0);
		y(() => {
			const rAF = requestAnimationFrame(() => isMountAnimationPreventedRef.current = false);
			return () => cancelAnimationFrame(rAF);
		}, []);
		useLayoutEffect2(() => {
			const node = ref.current;
			if (node) {
				originalStylesRef.current = originalStylesRef.current || {
					transitionDuration: node.style.transitionDuration,
					animationName: node.style.animationName
				};
				node.style.transitionDuration = "0s";
				node.style.animationName = "none";
				const rect = node.getBoundingClientRect();
				heightRef.current = rect.height;
				widthRef.current = rect.width;
				if (!isMountAnimationPreventedRef.current) {
					node.style.transitionDuration = originalStylesRef.current.transitionDuration;
					node.style.animationName = originalStylesRef.current.animationName;
				}
				setIsPresent(present);
			}
		}, [context.open, present]);
		return /* @__PURE__ */ u(Primitive.div, {
			"data-state": getState$1(context.open),
			"data-disabled": context.disabled ? "" : void 0,
			id: context.contentId,
			hidden: !isOpen,
			...contentProps,
			ref: composedRefs,
			style: {
				[`--radix-collapsible-content-height`]: height ? `${height}px` : void 0,
				[`--radix-collapsible-content-width`]: width ? `${width}px` : void 0,
				...props.style
			},
			children: isOpen && children
		});
	});
	function getState$1(open) {
		return open ? "open" : "closed";
	}
	var Root$2 = Collapsible;
	var Trigger$1 = CollapsibleTrigger;
	var Content$2 = CollapsibleContent;
	//#endregion
	//#region src/tabs/sync/components/sync-disclosure.tsx
	function SyncDisclosure({ open, onOpenChange, triggerId, triggerClassName, closedLabel, openLabel, contentId, contentClassName, contentHost = null, children }) {
		const triggerRef = A$1(null);
		const contentRef = A$1(null);
		_(() => {
			if (triggerRef.current) {
				triggerRef.current.id = triggerId;
				triggerRef.current.setAttribute("aria-controls", contentId);
			}
			if (contentRef.current) contentRef.current.id = contentId;
		}, [
			contentId,
			triggerId,
			open
		]);
		const content = /* @__PURE__ */ u(Content$2, {
			asChild: true,
			children: /* @__PURE__ */ u("div", {
				ref: contentRef,
				id: contentId,
				className: contentClassName,
				hidden: !open,
				children
			})
		});
		return /* @__PURE__ */ u(Root$2, {
			open,
			onOpenChange,
			children: [/* @__PURE__ */ u(Trigger$1, {
				asChild: true,
				children: /* @__PURE__ */ u("button", {
					ref: triggerRef,
					type: "button",
					className: triggerClassName,
					id: triggerId,
					"aria-controls": contentId,
					children: open ? openLabel : closedLabel
				})
			}), contentHost ? $(content, contentHost) : content]
		});
	}
	function TeamSetupDisclosure({ open, onOpenChange }) {
		return /* @__PURE__ */ u(SyncDisclosure, {
			open,
			onOpenChange,
			triggerId: "syncToggleAdmin",
			triggerClassName: "sync-toggle-admin",
			closedLabel: "Set up a new team instead…",
			openLabel: "Hide team setup",
			contentId: "syncInvitePanel",
			children: [
				/* @__PURE__ */ u("h3", {
					className: "settings-group-title",
					style: { marginTop: "12px" },
					children: "Create a team"
				}),
				/* @__PURE__ */ u("div", {
					className: "section-meta",
					children: "Generate an invite to share with teammates."
				}),
				/* @__PURE__ */ u("div", {
					className: "actor-create-row",
					children: [
						/* @__PURE__ */ u("label", {
							htmlFor: "syncInviteGroup",
							className: "sr-only",
							children: "Team name"
						}),
						/* @__PURE__ */ u("input", {
							className: "peer-scope-input",
							id: "syncInviteGroup",
							placeholder: "Team name (e.g. my-team)"
						}),
						/* @__PURE__ */ u("label", {
							htmlFor: "syncInvitePolicy",
							className: "sr-only",
							children: "Join policy"
						}),
						/* @__PURE__ */ u("div", {
							className: "sync-radix-select-host sync-actor-select-host",
							id: "syncInvitePolicyMount"
						}),
						/* @__PURE__ */ u("div", {
							className: "sync-ttl-group",
							children: [
								/* @__PURE__ */ u("label", {
									htmlFor: "syncInviteTtl",
									children: "Expires in"
								}),
								/* @__PURE__ */ u("input", {
									className: "peer-scope-input",
									defaultValue: "24",
									id: "syncInviteTtl",
									min: "1",
									style: { width: "64px" },
									type: "number"
								}),
								/* @__PURE__ */ u("label", { children: "hours" })
							]
						}),
						/* @__PURE__ */ u("button", {
							className: "settings-button",
							id: "syncCreateInviteButton",
							type: "button",
							children: "Create invite"
						})
					]
				}),
				/* @__PURE__ */ u("label", {
					htmlFor: "syncInviteOutput",
					className: "sr-only",
					children: "Generated invite"
				}),
				/* @__PURE__ */ u("textarea", {
					className: "feed-search",
					id: "syncInviteOutput",
					placeholder: "Invite will appear here",
					readOnly: true,
					hidden: true
				}),
				/* @__PURE__ */ u("div", {
					className: "peer-meta",
					id: "syncInviteWarnings",
					hidden: true
				})
			]
		});
	}
	function PairingDisclosure({ contentHost, open, onOpenChange }) {
		return /* @__PURE__ */ u(SyncDisclosure, {
			open,
			onOpenChange,
			triggerId: "syncPairingToggle",
			triggerClassName: "settings-button",
			closedLabel: "Show pairing",
			openLabel: "Hide pairing",
			contentId: "syncPairing",
			contentClassName: "pairing-card",
			contentHost,
			children: [
				/* @__PURE__ */ u("div", {
					className: "peer-title",
					children: [/* @__PURE__ */ u("strong", { children: "Pairing command" }), /* @__PURE__ */ u("div", {
						className: "peer-actions",
						children: /* @__PURE__ */ u("button", {
							id: "pairingCopy",
							type: "button",
							children: "Copy command"
						})
					})]
				}),
				/* @__PURE__ */ u("div", {
					className: "pairing-body",
					children: /* @__PURE__ */ u("pre", {
						id: "pairingPayload",
						style: { userSelect: "all" }
					})
				}),
				/* @__PURE__ */ u("div", {
					className: "peer-meta",
					id: "pairingHint"
				})
			]
		});
	}
	function renderTeamSetupDisclosure(mount, props) {
		renderIntoSyncMount(mount, /* @__PURE__ */ u(TeamSetupDisclosure, { ...props }));
	}
	function renderPairingDisclosure(mount, props) {
		renderIntoSyncMount(mount, /* @__PURE__ */ u(PairingDisclosure, { ...props }));
	}
	//#endregion
	//#region src/tabs/sync/components/sync-diagnostics.tsx
	function DiagnosticsGrid({ items }) {
		return /* @__PURE__ */ u(k$2, { children: items.map((item, index) => /* @__PURE__ */ u("div", {
			class: "stat",
			children: /* @__PURE__ */ u("div", {
				class: "stat-content",
				children: [/* @__PURE__ */ u("div", {
					class: "value",
					children: item.value
				}), /* @__PURE__ */ u("div", {
					class: "label",
					children: item.label
				})]
			})
		}, `${item.label}-${index}`)) });
	}
	function AttemptsList({ attempts }) {
		return /* @__PURE__ */ u(k$2, { children: attempts.map((attempt, index) => /* @__PURE__ */ u("div", {
			class: "diag-line",
			children: [/* @__PURE__ */ u("div", {
				class: "left",
				children: [/* @__PURE__ */ u("div", { children: [
					attempt.peerLabel,
					" — ",
					attempt.status
				] }), attempt.detail ? /* @__PURE__ */ u("div", {
					class: "small",
					children: attempt.detail
				}) : null]
			}), /* @__PURE__ */ u("div", {
				class: "right",
				children: attempt.startedAt
			})]
		}, `${attempt.startedAt}-${attempt.peerLabel}-${index}`)) });
	}
	function PairingText({ text }) {
		return /* @__PURE__ */ u(k$2, { children: text });
	}
	function SyncEmptyState({ title, detail }) {
		return /* @__PURE__ */ u("div", {
			class: "sync-empty-state",
			children: [/* @__PURE__ */ u("strong", { children: title }), /* @__PURE__ */ u("span", { children: detail })]
		});
	}
	function renderDiagnosticsGrid(mount, items) {
		if (!items.length) {
			clearSyncMount(mount);
			return;
		}
		renderIntoSyncMount(mount, /* @__PURE__ */ u(DiagnosticsGrid, { items }));
	}
	function renderAttemptsList(mount, attempts) {
		if (!attempts.length) {
			clearSyncMount(mount);
			return;
		}
		renderIntoSyncMount(mount, /* @__PURE__ */ u(AttemptsList, { attempts }));
	}
	function renderSyncEmptyState(mount, view) {
		renderIntoSyncMount(mount, /* @__PURE__ */ u(SyncEmptyState, { ...view }));
	}
	function renderPairingView(payloadMount, hintMount, view) {
		renderIntoSyncMount(payloadMount, /* @__PURE__ */ u(PairingText, { text: view.payloadText }));
		if (hintMount) renderIntoSyncMount(hintMount, /* @__PURE__ */ u(PairingText, { text: view.hintText }));
	}
	//#endregion
	//#region src/tabs/sync/helpers.ts
	function hideSkeleton(id) {
		const skeleton = document.getElementById(id);
		if (skeleton) skeleton.remove();
	}
	var adminSetupExpanded = false;
	function setAdminSetupExpanded(v) {
		adminSetupExpanded = v;
	}
	var teamInvitePanelOpen = false;
	function setTeamInvitePanelOpen(v) {
		teamInvitePanelOpen = v;
	}
	var openPeerScopeEditors = /* @__PURE__ */ new Set();
	var pendingPeerScopeReviewIds = /* @__PURE__ */ new Set();
	var freshPeerScopeReviewIds = /* @__PURE__ */ new Set();
	var DUPLICATE_PERSON_DECISIONS_KEY = "codemem-sync-duplicate-person-decisions";
	function requestPeerScopeReview(peerDeviceId) {
		const value = String(peerDeviceId || "").trim();
		if (!value) return;
		pendingPeerScopeReviewIds.add(value);
		freshPeerScopeReviewIds.add(value);
		openPeerScopeEditors.add(value);
	}
	function isPeerScopeReviewPending(peerDeviceId) {
		const value = String(peerDeviceId || "").trim();
		return Boolean(value) && pendingPeerScopeReviewIds.has(value);
	}
	function clearPeerScopeReview(peerDeviceId) {
		const value = String(peerDeviceId || "").trim();
		if (!value) return;
		pendingPeerScopeReviewIds.delete(value);
	}
	function consumePeerScopeReviewRequest(peerDeviceId) {
		const value = String(peerDeviceId || "").trim();
		if (!value || !freshPeerScopeReviewIds.has(value)) return false;
		freshPeerScopeReviewIds.delete(value);
		return true;
	}
	function readDuplicatePersonDecisionStore() {
		try {
			const raw = localStorage.getItem(DUPLICATE_PERSON_DECISIONS_KEY);
			if (!raw) return {};
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	function writeDuplicatePersonDecisionStore(value) {
		try {
			localStorage.setItem(DUPLICATE_PERSON_DECISIONS_KEY, JSON.stringify(value));
		} catch {}
	}
	function duplicatePersonDecisionKey(actorIds) {
		return [...actorIds].map((value) => String(value || "").trim()).filter(Boolean).sort().join("::");
	}
	function readDuplicatePersonDecisions() {
		return readDuplicatePersonDecisionStore();
	}
	function saveDuplicatePersonDecision(actorIds, decision) {
		const key = duplicatePersonDecisionKey(actorIds);
		if (!key) return;
		const next = readDuplicatePersonDecisionStore();
		next[key] = decision;
		writeDuplicatePersonDecisionStore(next);
	}
	function clearDuplicatePersonDecision(actorIds) {
		const key = duplicatePersonDecisionKey(actorIds);
		if (!key) return;
		const next = readDuplicatePersonDecisionStore();
		delete next[key];
		writeDuplicatePersonDecisionStore(next);
	}
	/** Redact the last two octets of IPv4 addresses. */
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
		if (!actor || typeof actor !== "object") return "Unknown person";
		const displayName = String(actor.display_name || "").trim();
		if (!displayName) return String(actor.actor_id || "Unknown person");
		return displayName;
	}
	function actorDisplayLabel(actor) {
		if (!actor || typeof actor !== "object") return "Unknown person";
		return actor.is_local ? "You" : actorLabel(actor);
	}
	function assignedActorCount(actorId) {
		return (Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : []).filter((peer) => String(peer?.actor_id || "") === actorId).length;
	}
	function visibleSyncActors() {
		return deriveVisiblePeopleActors({
			actors: state.lastSyncActors,
			peers: state.lastSyncPeers,
			duplicatePeople: state.lastSyncViewModel?.duplicatePeople
		}).visibleActors;
	}
	function buildActorSelectOptions(selectedActorId = "") {
		const options = [{
			value: "",
			label: "No person assigned"
		}];
		const visibleActors = visibleSyncActors();
		const selectedActor = (Array.isArray(state.lastSyncActors) ? state.lastSyncActors : []).find((actor) => String(actor?.actor_id || "") === selectedActorId);
		(selectedActor && !visibleActors.some((actor) => String(actor?.actor_id || "") === selectedActorId) ? [...visibleActors, selectedActor] : visibleActors).forEach((actor) => {
			const actorId = String(actor?.actor_id || "").trim();
			if (!actorId) return;
			options.push({
				value: actorId,
				label: actorDisplayLabel(actor)
			});
		});
		return options.filter((option, index, all) => index === all.findIndex((candidate) => candidate.value === option.value));
	}
	function mergeTargetActors(actorId) {
		return visibleSyncActors().filter((actor) => String(actor?.actor_id || "") !== actorId);
	}
	function actorMergeNote(targetActorId, secondaryActorId) {
		const target = mergeTargetActors(secondaryActorId).find((actor) => String(actor?.actor_id || "") === targetActorId);
		if (!targetActorId || !target) return "Choose which person should keep these devices.";
		return `Merge into ${actorDisplayLabel(target)}. Assigned devices move now; existing memories keep their current provenance.`;
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
				values = Array.from(new Set([...values, ...incoming]));
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
	//#endregion
	//#region src/tabs/sync/diagnostics.ts
	var SYNC_REDACT_MOUNT_ID = "syncRedactMount";
	var SYNC_REDACT_LABEL_ID = "syncRedactLabel";
	function newestPeerPing(peers) {
		const timestamps = Object.values(peers || {}).map((peer) => {
			if (!peer || typeof peer !== "object") return "";
			return String(peer.last_ping_at || "").trim();
		}).filter(Boolean).sort();
		return timestamps.length ? timestamps[timestamps.length - 1] : null;
	}
	var _renderSyncPeers = () => {};
	function setRenderSyncPeers(fn) {
		_renderSyncPeers = fn;
	}
	var _refreshPairing = () => {};
	function isRecord(value) {
		return typeof value === "object" && value !== null;
	}
	function pairingView(payload) {
		if (!isRecord(payload)) {
			state.pairingCommandRaw = "";
			return {
				payloadText: "Pairing not available",
				hintText: "Enable sync and retry."
			};
		}
		const pairingPayload = payload;
		if (pairingPayload.redacted) {
			state.pairingCommandRaw = "";
			return {
				payloadText: "Pairing payload hidden",
				hintText: "Diagnostics are required to view the pairing payload."
			};
		}
		const safePayload = {
			...pairingPayload,
			addresses: Array.isArray(pairingPayload.addresses) ? pairingPayload.addresses : []
		};
		const compact = JSON.stringify(safePayload);
		const command = `echo '${btoa(compact)}' | base64 -d | codemem sync pair --accept-file -`;
		state.pairingCommandRaw = command;
		return {
			payloadText: command,
			hintText: "Copy this command and run it on the other device. Use --include/--exclude to control which projects sync."
		};
	}
	function diagnosticsLoadingState() {
		return {
			title: "Diagnostics still loading.",
			detail: "Wait a moment for local sync status. If it stays blank, refresh the page or check whether sync is enabled on this device."
		};
	}
	function diagnosticsUnavailableState() {
		return {
			title: "Diagnostics unavailable right now.",
			detail: "The viewer could not load sync status. Refresh this page, or check that the local codemem sync service is reachable before retrying."
		};
	}
	function noAttemptsState() {
		const syncStatus = state.lastSyncStatus;
		return {
			title: "No recent sync attempts yet.",
			detail: syncStatus?.daemon_state === "disabled" || syncStatus?.enabled === false ? "Turn on sync in Settings → Device Sync first. Recent attempts will appear here after this device can actually run sync work." : "Trigger a sync pass or pair another device to generate activity here when you need low-level troubleshooting."
		};
	}
	function unavailableAttemptsState() {
		return {
			title: "Recent attempts unavailable right now.",
			detail: "Attempt history could not be loaded because sync diagnostics failed. Refresh the page after local sync status is reachable again."
		};
	}
	function renderSyncStatus() {
		const syncStatusGrid = document.getElementById("syncStatusGrid");
		const syncMeta = document.getElementById("syncMeta");
		const syncActions = document.getElementById("syncActions");
		if (!syncStatusGrid) return;
		hideSkeleton("syncDiagSkeleton");
		const status = state.lastSyncStatus;
		if (!status) {
			renderSyncEmptyState(syncStatusGrid, diagnosticsLoadingState());
			renderActionList(syncActions, []);
			if (syncMeta) syncMeta.textContent = "Loading advanced sync diagnostics…";
			return;
		}
		const peers = status.peers || {};
		const pingPayload = status.ping || {};
		const syncPayload = status.sync || {};
		const lastSync = status.last_sync_at || status.last_sync_at_utc || null;
		const lastPing = pingPayload.last_ping_at || status.last_ping_at || newestPeerPing(peers) || null;
		const syncError = status.last_sync_error || "";
		const pingError = status.last_ping_error || "";
		const pending = Number(status.pending || 0);
		const daemonDetail = String(status.daemon_detail || "");
		const daemonState = String(status.daemon_state || "unknown");
		const retention = status.retention || {};
		const retentionEnabled = retention.enabled === true;
		const retentionDeleted = Number(retention.last_deleted_ops || 0);
		const retentionLastRunAt = retention.last_run_at || null;
		const retentionLastError = String(retention.last_error || "");
		const daemonStateLabel = daemonState === "offline-peers" ? "Offline peers" : daemonState === "needs_attention" ? "Needs attention" : daemonState === "rebootstrapping" ? "Rebootstrapping" : titleCase(daemonState);
		const syncDisabled = daemonState === "disabled" || status.enabled === false;
		const peerCount = Object.keys(peers).length;
		const syncNoPeers = !syncDisabled && peerCount === 0;
		if (syncMeta) {
			const parts = syncDisabled ? ["Advanced sync is off on this device", "Turn on sync in Settings → Device Sync when you want pairing payloads, peer status, and recent attempt details here"] : syncNoPeers ? ["Advanced sync is ready but idle", "Use Show pairing to connect another device, then this panel will start showing live peer status and recent attempts"] : [
				`Advanced state: ${daemonStateLabel}`,
				`Peers: ${peerCount}`,
				lastSync ? `Last sync: ${formatAgeShort(secondsSince(lastSync))} ago` : "Last sync: never"
			];
			if (daemonState === "offline-peers") parts.push("All peers are currently offline; sync will resume automatically");
			if (daemonDetail && daemonState === "stopped") parts.push(`Detail: ${daemonDetail}`);
			if (daemonDetail && (daemonState === "needs_attention" || daemonState === "rebootstrapping")) parts.push(`Detail: ${daemonDetail}`);
			if (retentionEnabled) parts.push(retentionLastRunAt ? `Retention last ran ${formatAgeShort(secondsSince(retentionLastRunAt))} ago (approx oldest-first)` : "Retention enabled");
			syncMeta.textContent = parts.join(" · ");
		}
		const items = syncDisabled ? [
			{
				label: "State",
				value: "Disabled"
			},
			{
				label: "Mode",
				value: "Optional"
			},
			{
				label: "Pending events",
				value: pending
			},
			{
				label: "Last sync",
				value: "Not running"
			}
		] : syncNoPeers ? [
			{
				label: "State",
				value: "No peers"
			},
			{
				label: "Mode",
				value: "Ready to pair"
			},
			{
				label: "Pending events",
				value: pending
			},
			{
				label: "Last sync",
				value: "Waiting for first peer"
			}
		] : [
			{
				label: "State",
				value: daemonStateLabel
			},
			{
				label: "Pending events",
				value: pending
			},
			{
				label: "Last sync",
				value: lastSync ? `${formatAgeShort(secondsSince(lastSync))} ago` : "never"
			},
			{
				label: "Last peer ping",
				value: lastPing ? `${formatAgeShort(secondsSince(lastPing))} ago` : "never"
			},
			{
				label: "Retention",
				value: retentionEnabled ? retentionLastRunAt ? `${retentionDeleted.toLocaleString()} ops last run (approx)` : "Enabled" : "Disabled"
			}
		];
		if (!syncDisabled && !syncNoPeers && (syncError || pingError)) items.push({
			label: [syncError, pingError].filter(Boolean).join(" · "),
			value: "Errors"
		});
		if (!syncDisabled && !syncNoPeers && syncPayload.seconds_since_last) items.push({
			label: "Since last sync",
			value: `${syncPayload.seconds_since_last}s`
		});
		if (!syncDisabled && !syncNoPeers && pingPayload.seconds_since_last) items.push({
			label: "Since last peer ping",
			value: `${pingPayload.seconds_since_last}s`
		});
		if (!syncDisabled && retentionEnabled && retentionLastError) items.push({
			label: retentionLastError,
			value: "Retention"
		});
		renderDiagnosticsGrid(syncStatusGrid, items);
		const actions = [];
		if (syncNoPeers) {} else if (daemonState === "offline-peers") {} else if (daemonState === "stopped") {
			actions.push({
				label: "Sync daemon is stopped. Start it.",
				command: "codemem sync start"
			});
			actions.push({
				label: "Run one sync pass now.",
				command: "codemem sync once"
			});
		} else if (daemonState === "needs_attention") actions.push({
			label: "Sync needs manual attention before reset can continue.",
			command: "codemem sync doctor"
		});
		else if (daemonState === "rebootstrapping") actions.push({
			label: "Sync is rebuilding state in the background.",
			command: "codemem sync status"
		});
		else if (syncError || pingError || daemonState === "error") {
			actions.push({
				label: "Sync reports errors. Restart now.",
				command: "codemem sync restart && codemem sync once"
			});
			actions.push({
				label: "Run doctor for the root cause.",
				command: "codemem sync doctor"
			});
		} else if (!syncDisabled && !syncNoPeers && pending > 0) actions.push({
			label: "Pending sync work detected. Run one pass now.",
			command: "codemem sync once"
		});
		renderActionList(syncActions, actions);
	}
	function renderSyncAttempts() {
		const syncAttempts = document.getElementById("syncAttempts");
		if (!syncAttempts) return;
		const attempts = state.lastSyncAttempts;
		if (!Array.isArray(attempts) || !attempts.length) {
			renderSyncEmptyState(syncAttempts, noAttemptsState());
			return;
		}
		renderAttemptsList(syncAttempts, attempts.slice(0, 5).map((attempt) => {
			const time = attempt.started_at || attempt.started_at_utc || "";
			const peerId = String(attempt.peer_device_id || "").trim();
			const matchedPeer = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers.find((p) => String(p?.peer_device_id || "") === peerId) : null;
			const peerLabel = String(matchedPeer?.name || "").trim() || (peerId ? peerId.slice(0, 8) : "unknown");
			const isError = attempt.status === "error";
			const detailParts = [];
			if (isError && attempt.error) detailParts.push(String(attempt.error));
			if (!isError && (attempt.ops_in || attempt.ops_out)) detailParts.push(`${attempt.ops_in ?? 0} in · ${attempt.ops_out ?? 0} out`);
			if (!isSyncRedactionEnabled() && attempt.address) detailParts.push(attempt.address);
			return {
				status: attempt.status || "unknown",
				peerLabel,
				detail: detailParts.join(" · "),
				startedAt: time ? formatTimestamp(time) : ""
			};
		}));
	}
	function renderSyncDiagnosticsUnavailable() {
		const syncStatusGrid = document.getElementById("syncStatusGrid");
		const syncAttempts = document.getElementById("syncAttempts");
		const syncMeta = document.getElementById("syncMeta");
		const syncActions = document.getElementById("syncActions");
		if (syncStatusGrid) renderSyncEmptyState(syncStatusGrid, diagnosticsUnavailableState());
		if (syncAttempts) renderSyncEmptyState(syncAttempts, unavailableAttemptsState());
		if (syncMeta) syncMeta.textContent = "Advanced diagnostics are unavailable right now. Refresh the page, or verify the local sync service before retrying.";
		renderActionList(syncActions, []);
	}
	function renderPairingCollapsible() {
		const mount = document.getElementById("syncPairingDisclosureMount");
		const contentHost = document.getElementById("syncPairingPanelMount");
		if (!mount || !contentHost) return;
		renderPairingDisclosure(mount, {
			contentHost,
			open: state.syncPairingOpen,
			onOpenChange: (open) => {
				setSyncPairingOpen(open);
				renderPairingCollapsible();
				if (open) {
					const pairingPayloadEl = document.getElementById("pairingPayload");
					const pairingHint = document.getElementById("pairingHint");
					if (pairingPayloadEl) renderPairingView(pairingPayloadEl, pairingHint, {
						payloadText: "Loading…",
						hintText: "Fetching pairing payload…"
					});
				}
				_refreshPairing();
			}
		});
		const pairingCopy = document.getElementById("pairingCopy");
		if (pairingCopy) pairingCopy.onclick = async () => {
			const text = state.pairingCommandRaw || document.getElementById("pairingPayload")?.textContent || "";
			if (text) await copyToClipboard(text, pairingCopy);
		};
	}
	function renderPairing() {
		renderPairingCollapsible();
		const pairingPayloadEl = document.getElementById("pairingPayload");
		const pairingHint = document.getElementById("pairingHint");
		if (!pairingPayloadEl) return;
		renderPairingView(pairingPayloadEl, pairingHint, pairingView(state.pairingPayloadRaw));
	}
	function renderRedactControl() {
		const mount = document.getElementById(SYNC_REDACT_MOUNT_ID);
		if (!mount) return;
		renderIntoSyncMount(mount, _$1(RadixSwitch, {
			"aria-labelledby": SYNC_REDACT_LABEL_ID,
			checked: isSyncRedactionEnabled(),
			className: "sync-redact-switch",
			id: "syncRedact",
			onCheckedChange: (checked) => {
				setSyncRedactionEnabled(checked);
				renderRedactControl();
				renderSyncStatus();
				_renderSyncPeers();
				renderSyncAttempts();
				renderPairing();
			},
			thumbClassName: "sync-redact-switch-thumb"
		}));
	}
	function initDiagnosticsEvents(refreshCallback) {
		_refreshPairing = refreshCallback;
		renderPairingCollapsible();
		renderRedactControl();
	}
	//#endregion
	//#region src/lib/form.ts
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
			if (msg.includes("fetch") || msg.includes("network") || msg.includes("Failed to fetch")) return "Network error — check your connection and try again.";
			return msg;
		}
		return fallback;
	}
	//#endregion
	//#region src/tabs/sync/components/sync-invite-join-panels.tsx
	function ExistingElementSlot$1({ element, hidden = false, restoreParent = null }) {
		const hostRef = A$1(null);
		_(() => {
			if (!element) return;
			element.hidden = hidden;
		}, [element, hidden]);
		_(() => {
			const host = hostRef.current;
			if (!host || !element) return;
			if (element.parentElement !== host) host.appendChild(element);
			return () => {
				if (!restoreParent || element.parentElement !== host) return;
				restoreParent.appendChild(element);
			};
		}, [element, restoreParent]);
		return /* @__PURE__ */ u("div", { ref: hostRef });
	}
	function InviteToggleRow({ invitePanel, invitePanelOpen, inviteRestoreParent, onToggle }) {
		return /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u("div", {
			className: "sync-action",
			children: [/* @__PURE__ */ u("div", {
				className: "sync-action-text",
				children: ["Add another teammate.", /* @__PURE__ */ u("span", {
					className: "sync-action-command",
					children: "Generate an invite when you are ready to bring another device into this team."
				})]
			}), /* @__PURE__ */ u("button", {
				type: "button",
				className: "settings-button",
				onClick: onToggle,
				children: invitePanelOpen ? "Hide invite form" : "Invite a teammate"
			})]
		}), invitePanel ? /* @__PURE__ */ u(ExistingElementSlot$1, {
			element: invitePanel,
			hidden: !invitePanelOpen,
			restoreParent: inviteRestoreParent
		}) : null] });
	}
	function PairingCopyRow() {
		return /* @__PURE__ */ u("div", {
			className: "sync-action",
			children: [/* @__PURE__ */ u("div", {
				className: "sync-action-text",
				children: ["Pair another device.", /* @__PURE__ */ u("span", {
					className: "sync-action-command",
					children: "Use the pairing command in Advanced diagnostics when you are ready to connect one."
				})]
			}), /* @__PURE__ */ u("button", {
				type: "button",
				className: "settings-button sync-action-copy",
				onClick: (event) => copyToClipboard("codemem sync pair --payload-only", event.currentTarget),
				children: "Copy"
			})]
		});
	}
	function SyncInviteJoinPanels({ invitePanel, invitePanelOpen, inviteRestoreParent, joinPanel, joinRestoreParent, onToggleInvitePanel, pairedPeerCount, presenceStatus }) {
		return /* @__PURE__ */ u(k$2, { children: [
			presenceStatus === "not_enrolled" ? /* @__PURE__ */ u(k$2, { children: [
				joinPanel ? /* @__PURE__ */ u(ExistingElementSlot$1, {
					element: joinPanel,
					hidden: false,
					restoreParent: joinRestoreParent
				}) : null,
				/* @__PURE__ */ u("div", {
					className: "peer-meta",
					id: "syncJoinFeedback",
					hidden: true
				}),
				/* @__PURE__ */ u("div", {
					className: "sync-action",
					children: /* @__PURE__ */ u("div", {
						className: "sync-action-text",
						children: ["This device is not on the team yet.", /* @__PURE__ */ u("span", {
							className: "sync-action-command",
							children: "Import an invite or ask an admin to enroll it first."
						})]
					})
				})
			] }) : null,
			presenceStatus !== "not_enrolled" ? /* @__PURE__ */ u(InviteToggleRow, {
				invitePanel,
				invitePanelOpen,
				inviteRestoreParent,
				onToggle: onToggleInvitePanel
			}) : null,
			!pairedPeerCount && presenceStatus === "posted" ? /* @__PURE__ */ u(PairingCopyRow, {}) : null
		] });
	}
	//#endregion
	//#region src/tabs/sync/components/sync-sharing-review.tsx
	function SharingReviewRow({ item, onReview }) {
		return /* @__PURE__ */ u("div", {
			className: "actor-row",
			children: [/* @__PURE__ */ u("div", {
				className: "actor-details",
				children: [/* @__PURE__ */ u("div", {
					className: "actor-title",
					children: [/* @__PURE__ */ u("strong", { children: item.peerName }), /* @__PURE__ */ u("span", {
						className: "badge actor-badge",
						children: ["person: ", item.actorDisplayName || item.actorId]
					})]
				}), /* @__PURE__ */ u("div", {
					className: "peer-meta",
					children: [
						item.shareableCount,
						" share by default · ",
						item.privateCount,
						" marked Only me · ",
						item.scopeLabel
					]
				})]
			}), /* @__PURE__ */ u("div", {
				className: "actor-actions",
				children: /* @__PURE__ */ u("button", {
					type: "button",
					className: "settings-button",
					onClick: onReview,
					children: "Review my memories in Feed"
				})
			})]
		});
	}
	function SyncSharingReview({ items, onReview }) {
		return /* @__PURE__ */ u(k$2, { children: items.map((item) => /* @__PURE__ */ u(SharingReviewRow, {
			item,
			onReview
		}, `${item.peerName}:${item.actorId}:${item.scopeLabel}`)) });
	}
	//#endregion
	//#region src/tabs/sync/components/sync-inline-feedback.tsx
	function SyncInlineFeedback({ feedback }) {
		if (!feedback?.message) return null;
		return /* @__PURE__ */ u("div", {
			className: `sync-inline-feedback ${feedback.tone}`,
			role: feedback.tone === "warning" ? "alert" : "status",
			"aria-live": feedback.tone === "warning" ? "assertive" : "polite",
			children: feedback.message
		});
	}
	//#endregion
	//#region src/tabs/sync/components/team-sync-panel.tsx
	function SectionHeading({ count, label }) {
		return /* @__PURE__ */ u("div", {
			className: "sync-section-heading",
			children: [/* @__PURE__ */ u("div", {
				className: "sync-action-text sync-section-label",
				children: label
			}), count ? /* @__PURE__ */ u("span", {
				className: "badge actor-badge sync-section-count",
				children: count
			}) : null]
		});
	}
	function AttentionRow({ item, onAction }) {
		const [busy, setBusy] = d(false);
		return /* @__PURE__ */ u("div", {
			className: "sync-action",
			children: [/* @__PURE__ */ u("div", {
				className: "sync-action-text",
				children: [item.title, /* @__PURE__ */ u("span", {
					className: "sync-action-command",
					children: item.summary
				})]
			}), /* @__PURE__ */ u("button", {
				type: "button",
				className: "settings-button",
				disabled: busy,
				onClick: async () => {
					setBusy(true);
					try {
						await onAction(item);
					} finally {
						setBusy(false);
					}
				},
				children: item.actionLabel || "Review"
			})]
		});
	}
	function PendingJoinRequestRow({ request, onApprove, onDeny }) {
		const [busyAction, setBusyAction] = d(null);
		const [feedback, setFeedback] = d(null);
		const [approveLabel, setApproveLabel] = d("Approve");
		const [denyLabel, setDenyLabel] = d("Deny");
		return /* @__PURE__ */ u("div", {
			className: "actor-row",
			children: [
				/* @__PURE__ */ u("div", {
					className: "actor-details",
					children: /* @__PURE__ */ u("div", {
						className: "actor-title",
						title: request.requestId || void 0,
						children: request.displayName
					})
				}),
				/* @__PURE__ */ u("div", {
					className: "actor-actions",
					children: [/* @__PURE__ */ u("button", {
						type: "button",
						className: "settings-button",
						disabled: busyAction !== null,
						onClick: async () => {
							setBusyAction("approve");
							setApproveLabel("Approving…");
							try {
								setFeedback(await onApprove(request) || null);
								setApproveLabel("Approve");
							} catch {
								setApproveLabel("Retry");
							} finally {
								setBusyAction(null);
							}
						},
						children: approveLabel
					}), /* @__PURE__ */ u("button", {
						type: "button",
						className: "settings-button",
						disabled: busyAction !== null,
						onClick: async () => {
							setBusyAction("deny");
							setDenyLabel("Denying…");
							try {
								setFeedback(await onDeny(request) || null);
								setDenyLabel("Deny");
							} catch {
								setDenyLabel("Retry");
							} finally {
								setBusyAction(null);
							}
						},
						children: denyLabel
					})]
				}),
				/* @__PURE__ */ u(SyncInlineFeedback, { feedback })
			]
		});
	}
	function DiscoveredDeviceRow({ row, onInspectConflict, onRemoveConflict, onReview }) {
		const [busy, setBusy] = d(null);
		const [feedback, setFeedback] = d(null);
		const [reviewLabel, setReviewLabel] = d(row.actionLabel || "Review device");
		const [removeLabel, setRemoveLabel] = d("Remove broken device record");
		return /* @__PURE__ */ u("div", {
			className: "actor-row",
			"data-discovered-device-id": row.deviceId,
			children: [
				/* @__PURE__ */ u("div", {
					className: "actor-details",
					children: [/* @__PURE__ */ u("div", {
						className: "actor-title",
						children: [
							/* @__PURE__ */ u("strong", {
								title: row.displayTitle || void 0,
								children: row.displayName
							}),
							/* @__PURE__ */ u("span", {
								className: `badge actor-badge${row.availabilityLabel === "Offline" ? "" : " local"}`,
								children: row.availabilityLabel
							}),
							/* @__PURE__ */ u("span", {
								className: "badge actor-badge",
								children: row.connectionLabel
							}),
							row.approvalBadgeLabel ? /* @__PURE__ */ u("span", {
								className: "badge actor-badge",
								children: row.approvalBadgeLabel
							}) : null
						]
					}), /* @__PURE__ */ u("div", {
						className: "peer-meta",
						children: row.note
					})]
				}),
				/* @__PURE__ */ u("div", {
					className: "actor-actions",
					children: [
						row.mode === "accept" ? /* @__PURE__ */ u("button", {
							type: "button",
							className: "settings-button",
							disabled: busy !== null,
							onClick: async () => {
								setBusy("review");
								setReviewLabel("Reviewing…");
								try {
									setFeedback(await onReview(row) || null);
									setReviewLabel(row.actionLabel || "Review device");
								} catch {
									setReviewLabel("Retry");
								} finally {
									setBusy(null);
								}
							},
							children: reviewLabel
						}) : null,
						(row.mode === "stale" || row.mode === "ambiguous" || row.mode === "scope-pending") && row.actionMessage ? /* @__PURE__ */ u("div", {
							className: "peer-meta",
							children: row.actionMessage
						}) : null,
						row.mode === "paired" && row.pairedMessage ? /* @__PURE__ */ u("div", {
							className: "peer-meta",
							children: row.pairedMessage
						}) : null,
						row.mode === "conflict" ? /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u("button", {
							type: "button",
							className: "settings-button",
							disabled: busy !== null,
							onClick: () => onInspectConflict(row),
							children: "Open device details"
						}), /* @__PURE__ */ u("button", {
							type: "button",
							className: "settings-button",
							disabled: busy !== null,
							onClick: async () => {
								setBusy("remove");
								setRemoveLabel("Removing…");
								try {
									setFeedback(await onRemoveConflict(row) || null);
									setRemoveLabel("Remove broken device record");
								} catch {
									setRemoveLabel("Retry");
								} finally {
									setBusy(null);
								}
							},
							children: removeLabel
						})] }) : null
					]
				}),
				/* @__PURE__ */ u(SyncInlineFeedback, { feedback })
			]
		});
	}
	function ActionContent(props) {
		const hasAttentionItems = props.actionItems.length > 0;
		const hasOtherActionableWork = props.actionableCount > props.actionItems.length;
		return /* @__PURE__ */ u(k$2, { children: [
			hasAttentionItems || hasOtherActionableWork || props.presenceStatus !== "posted" ? /* @__PURE__ */ u(SectionHeading, { label: "Next steps" }) : null,
			hasAttentionItems ? props.actionItems.map((item) => /* @__PURE__ */ u(AttentionRow, {
				item,
				onAction: props.onAttentionAction
			}, item.id)) : null,
			!hasAttentionItems && !hasOtherActionableWork && props.presenceStatus === "posted" ? /* @__PURE__ */ u("div", {
				className: "sync-action",
				children: /* @__PURE__ */ u("div", {
					className: "sync-action-text",
					children: "Everything is healthy."
				})
			}) : null,
			!hasAttentionItems && hasOtherActionableWork && props.presenceStatus === "posted" ? /* @__PURE__ */ u("div", {
				className: "sync-action",
				children: /* @__PURE__ */ u("div", {
					className: "sync-action-text",
					children: "Review the team items below when you are ready."
				})
			}) : null,
			!hasAttentionItems && props.presenceStatus === "not_enrolled" ? /* @__PURE__ */ u("div", {
				className: "sync-action",
				children: /* @__PURE__ */ u("div", {
					className: "sync-action-text",
					children: ["This device needs team enrollment", /* @__PURE__ */ u("span", {
						className: "sync-action-command",
						children: "Import an invite or ask an admin to enroll it."
					})]
				})
			}) : null
		] });
	}
	function TeamActionsContent({ children }) {
		if (!children) return null;
		return /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u(SectionHeading, { label: "Keep the team moving" }), children] });
	}
	function TeamStatusPortal({ mount, statusSummary }) {
		return $(/* @__PURE__ */ u("div", {
			className: "sync-team-summary",
			children: [
				/* @__PURE__ */ u("div", {
					className: "sync-team-status-row",
					children: [/* @__PURE__ */ u("span", {
						className: "sync-team-status-label",
						children: "Team status"
					}), /* @__PURE__ */ u("span", {
						className: statusSummary.badgeClassName,
						children: statusSummary.presenceLabel
					})]
				}),
				statusSummary.headline ? /* @__PURE__ */ u("div", {
					className: "sync-team-headline",
					children: statusSummary.headline
				}) : null,
				/* @__PURE__ */ u("div", {
					className: "sync-team-metrics sync-team-metrics-secondary",
					children: statusSummary.metricsText
				})
			]
		}), mount);
	}
	function DiscoveredPortal({ mount, rows, onInspectConflict, onRemoveConflict, onReview }) {
		if (!mount || !rows.length && !state.syncDiscoveredFeedback) return null;
		return $(/* @__PURE__ */ u(k$2, { children: [
			/* @__PURE__ */ u(SectionHeading, {
				count: rows.length || void 0,
				label: "Devices seen on team"
			}),
			/* @__PURE__ */ u(SyncInlineFeedback, { feedback: state.syncDiscoveredFeedback }),
			rows.map((row) => /* @__PURE__ */ u(DiscoveredDeviceRow, {
				row,
				onInspectConflict,
				onRemoveConflict,
				onReview
			}, row.deviceId))
		] }), mount);
	}
	function PendingRequestsPortal({ mount, requests, onApprove, onDeny }) {
		if (!mount || !requests.length && !state.syncJoinRequestsFeedback) return null;
		return $(/* @__PURE__ */ u(k$2, { children: [
			/* @__PURE__ */ u(SectionHeading, {
				count: requests.length || void 0,
				label: "Pending join requests"
			}),
			/* @__PURE__ */ u(SyncInlineFeedback, { feedback: state.syncJoinRequestsFeedback }),
			requests.map((request) => /* @__PURE__ */ u(PendingJoinRequestRow, {
				request,
				onApprove,
				onDeny
			}, request.requestId))
		] }), mount);
	}
	function TeamSyncPanel(props) {
		return /* @__PURE__ */ u(k$2, { children: [
			/* @__PURE__ */ u(ActionContent, { ...props }),
			/* @__PURE__ */ u(TeamActionsContent, { children: props.children }),
			/* @__PURE__ */ u(TeamStatusPortal, {
				mount: props.listMount,
				statusSummary: props.statusSummary
			}),
			/* @__PURE__ */ u(PendingRequestsPortal, {
				mount: props.joinRequestsMount,
				requests: props.pendingJoinRequests,
				onApprove: props.onApproveJoinRequest,
				onDeny: props.onDenyJoinRequest
			}),
			/* @__PURE__ */ u(DiscoveredPortal, {
				mount: props.discoveredListMount,
				rows: props.discoveredRows,
				onInspectConflict: props.onInspectConflict,
				onRemoveConflict: props.onRemoveConflict,
				onReview: props.onReviewDiscoveredDevice
			})
		] });
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-use-callback-ref@1.1.1_react@19.2.4/node_modules/@radix-ui/react-use-callback-ref/dist/index.mjs
	function useCallbackRef$1(callback) {
		const callbackRef = A$1(callback);
		y(() => {
			callbackRef.current = callback;
		});
		return T$1(() => (...args) => callbackRef.current?.(...args), []);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-use-escape-keydown@1.1.1_react@19.2.4/node_modules/@radix-ui/react-use-escape-keydown/dist/index.mjs
	function useEscapeKeydown(onEscapeKeyDownProp, ownerDocument = globalThis?.document) {
		const onEscapeKeyDown = useCallbackRef$1(onEscapeKeyDownProp);
		y(() => {
			const handleKeyDown = (event) => {
				if (event.key === "Escape") onEscapeKeyDown(event);
			};
			ownerDocument.addEventListener("keydown", handleKeyDown, { capture: true });
			return () => ownerDocument.removeEventListener("keydown", handleKeyDown, { capture: true });
		}, [onEscapeKeyDown, ownerDocument]);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-dismissable-layer@1.1.11_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs
	var DISMISSABLE_LAYER_NAME = "DismissableLayer";
	var CONTEXT_UPDATE = "dismissableLayer.update";
	var POINTER_DOWN_OUTSIDE = "dismissableLayer.pointerDownOutside";
	var FOCUS_OUTSIDE = "dismissableLayer.focusOutside";
	var originalBodyPointerEvents;
	var DismissableLayerContext = R$1({
		layers: /* @__PURE__ */ new Set(),
		layersWithOutsidePointerEventsDisabled: /* @__PURE__ */ new Set(),
		branches: /* @__PURE__ */ new Set()
	});
	var DismissableLayer = D((props, forwardedRef) => {
		const { disableOutsidePointerEvents = false, onEscapeKeyDown, onPointerDownOutside, onFocusOutside, onInteractOutside, onDismiss, ...layerProps } = props;
		const context = x$1(DismissableLayerContext);
		const [node, setNode] = d(null);
		const ownerDocument = node?.ownerDocument ?? globalThis?.document;
		const [, force] = d({});
		const composedRefs = useComposedRefs(forwardedRef, (node2) => setNode(node2));
		const layers = Array.from(context.layers);
		const [highestLayerWithOutsidePointerEventsDisabled] = [...context.layersWithOutsidePointerEventsDisabled].slice(-1);
		const highestLayerWithOutsidePointerEventsDisabledIndex = layers.indexOf(highestLayerWithOutsidePointerEventsDisabled);
		const index = node ? layers.indexOf(node) : -1;
		const isBodyPointerEventsDisabled = context.layersWithOutsidePointerEventsDisabled.size > 0;
		const isPointerEventsEnabled = index >= highestLayerWithOutsidePointerEventsDisabledIndex;
		const pointerDownOutside = usePointerDownOutside((event) => {
			const target = event.target;
			const isPointerDownOnBranch = [...context.branches].some((branch) => branch.contains(target));
			if (!isPointerEventsEnabled || isPointerDownOnBranch) return;
			onPointerDownOutside?.(event);
			onInteractOutside?.(event);
			if (!event.defaultPrevented) onDismiss?.();
		}, ownerDocument);
		const focusOutside = useFocusOutside((event) => {
			const target = event.target;
			if ([...context.branches].some((branch) => branch.contains(target))) return;
			onFocusOutside?.(event);
			onInteractOutside?.(event);
			if (!event.defaultPrevented) onDismiss?.();
		}, ownerDocument);
		useEscapeKeydown((event) => {
			if (!(index === context.layers.size - 1)) return;
			onEscapeKeyDown?.(event);
			if (!event.defaultPrevented && onDismiss) {
				event.preventDefault();
				onDismiss();
			}
		}, ownerDocument);
		y(() => {
			if (!node) return;
			if (disableOutsidePointerEvents) {
				if (context.layersWithOutsidePointerEventsDisabled.size === 0) {
					originalBodyPointerEvents = ownerDocument.body.style.pointerEvents;
					ownerDocument.body.style.pointerEvents = "none";
				}
				context.layersWithOutsidePointerEventsDisabled.add(node);
			}
			context.layers.add(node);
			dispatchUpdate();
			return () => {
				if (disableOutsidePointerEvents && context.layersWithOutsidePointerEventsDisabled.size === 1) ownerDocument.body.style.pointerEvents = originalBodyPointerEvents;
			};
		}, [
			node,
			ownerDocument,
			disableOutsidePointerEvents,
			context
		]);
		y(() => {
			return () => {
				if (!node) return;
				context.layers.delete(node);
				context.layersWithOutsidePointerEventsDisabled.delete(node);
				dispatchUpdate();
			};
		}, [node, context]);
		y(() => {
			const handleUpdate = () => force({});
			document.addEventListener(CONTEXT_UPDATE, handleUpdate);
			return () => document.removeEventListener(CONTEXT_UPDATE, handleUpdate);
		}, []);
		return /* @__PURE__ */ u(Primitive.div, {
			...layerProps,
			ref: composedRefs,
			style: {
				pointerEvents: isBodyPointerEventsDisabled ? isPointerEventsEnabled ? "auto" : "none" : void 0,
				...props.style
			},
			onFocusCapture: composeEventHandlers(props.onFocusCapture, focusOutside.onFocusCapture),
			onBlurCapture: composeEventHandlers(props.onBlurCapture, focusOutside.onBlurCapture),
			onPointerDownCapture: composeEventHandlers(props.onPointerDownCapture, pointerDownOutside.onPointerDownCapture)
		});
	});
	DismissableLayer.displayName = DISMISSABLE_LAYER_NAME;
	var BRANCH_NAME = "DismissableLayerBranch";
	var DismissableLayerBranch = D((props, forwardedRef) => {
		const context = x$1(DismissableLayerContext);
		const ref = A$1(null);
		const composedRefs = useComposedRefs(forwardedRef, ref);
		y(() => {
			const node = ref.current;
			if (node) {
				context.branches.add(node);
				return () => {
					context.branches.delete(node);
				};
			}
		}, [context.branches]);
		return /* @__PURE__ */ u(Primitive.div, {
			...props,
			ref: composedRefs
		});
	});
	DismissableLayerBranch.displayName = BRANCH_NAME;
	function usePointerDownOutside(onPointerDownOutside, ownerDocument = globalThis?.document) {
		const handlePointerDownOutside = useCallbackRef$1(onPointerDownOutside);
		const isPointerInsideReactTreeRef = A$1(false);
		const handleClickRef = A$1(() => {});
		y(() => {
			const handlePointerDown = (event) => {
				if (event.target && !isPointerInsideReactTreeRef.current) {
					let handleAndDispatchPointerDownOutsideEvent2 = function() {
						handleAndDispatchCustomEvent(POINTER_DOWN_OUTSIDE, handlePointerDownOutside, eventDetail, { discrete: true });
					};
					const eventDetail = { originalEvent: event };
					if (event.pointerType === "touch") {
						ownerDocument.removeEventListener("click", handleClickRef.current);
						handleClickRef.current = handleAndDispatchPointerDownOutsideEvent2;
						ownerDocument.addEventListener("click", handleClickRef.current, { once: true });
					} else handleAndDispatchPointerDownOutsideEvent2();
				} else ownerDocument.removeEventListener("click", handleClickRef.current);
				isPointerInsideReactTreeRef.current = false;
			};
			const timerId = window.setTimeout(() => {
				ownerDocument.addEventListener("pointerdown", handlePointerDown);
			}, 0);
			return () => {
				window.clearTimeout(timerId);
				ownerDocument.removeEventListener("pointerdown", handlePointerDown);
				ownerDocument.removeEventListener("click", handleClickRef.current);
			};
		}, [ownerDocument, handlePointerDownOutside]);
		return { onPointerDownCapture: () => isPointerInsideReactTreeRef.current = true };
	}
	function useFocusOutside(onFocusOutside, ownerDocument = globalThis?.document) {
		const handleFocusOutside = useCallbackRef$1(onFocusOutside);
		const isFocusInsideReactTreeRef = A$1(false);
		y(() => {
			const handleFocus = (event) => {
				if (event.target && !isFocusInsideReactTreeRef.current) handleAndDispatchCustomEvent(FOCUS_OUTSIDE, handleFocusOutside, { originalEvent: event }, { discrete: false });
			};
			ownerDocument.addEventListener("focusin", handleFocus);
			return () => ownerDocument.removeEventListener("focusin", handleFocus);
		}, [ownerDocument, handleFocusOutside]);
		return {
			onFocusCapture: () => isFocusInsideReactTreeRef.current = true,
			onBlurCapture: () => isFocusInsideReactTreeRef.current = false
		};
	}
	function dispatchUpdate() {
		const event = new CustomEvent(CONTEXT_UPDATE);
		document.dispatchEvent(event);
	}
	function handleAndDispatchCustomEvent(name, handler, detail, { discrete }) {
		const target = detail.originalEvent.target;
		const event = new CustomEvent(name, {
			bubbles: false,
			cancelable: true,
			detail
		});
		if (handler) target.addEventListener(name, handler, { once: true });
		if (discrete) dispatchDiscreteCustomEvent(target, event);
		else target.dispatchEvent(event);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-focus-scope@1.1.7_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-focus-scope/dist/index.mjs
	var AUTOFOCUS_ON_MOUNT = "focusScope.autoFocusOnMount";
	var AUTOFOCUS_ON_UNMOUNT = "focusScope.autoFocusOnUnmount";
	var EVENT_OPTIONS = {
		bubbles: false,
		cancelable: true
	};
	var FOCUS_SCOPE_NAME = "FocusScope";
	var FocusScope = D((props, forwardedRef) => {
		const { loop = false, trapped = false, onMountAutoFocus: onMountAutoFocusProp, onUnmountAutoFocus: onUnmountAutoFocusProp, ...scopeProps } = props;
		const [container, setContainer] = d(null);
		const onMountAutoFocus = useCallbackRef$1(onMountAutoFocusProp);
		const onUnmountAutoFocus = useCallbackRef$1(onUnmountAutoFocusProp);
		const lastFocusedElementRef = A$1(null);
		const composedRefs = useComposedRefs(forwardedRef, (node) => setContainer(node));
		const focusScope = A$1({
			paused: false,
			pause() {
				this.paused = true;
			},
			resume() {
				this.paused = false;
			}
		}).current;
		y(() => {
			if (trapped) {
				let handleFocusIn2 = function(event) {
					if (focusScope.paused || !container) return;
					const target = event.target;
					if (container.contains(target)) lastFocusedElementRef.current = target;
					else focus(lastFocusedElementRef.current, { select: true });
				}, handleFocusOut2 = function(event) {
					if (focusScope.paused || !container) return;
					const relatedTarget = event.relatedTarget;
					if (relatedTarget === null) return;
					if (!container.contains(relatedTarget)) focus(lastFocusedElementRef.current, { select: true });
				}, handleMutations2 = function(mutations) {
					if (document.activeElement !== document.body) return;
					for (const mutation of mutations) if (mutation.removedNodes.length > 0) focus(container);
				};
				document.addEventListener("focusin", handleFocusIn2);
				document.addEventListener("focusout", handleFocusOut2);
				const mutationObserver = new MutationObserver(handleMutations2);
				if (container) mutationObserver.observe(container, {
					childList: true,
					subtree: true
				});
				return () => {
					document.removeEventListener("focusin", handleFocusIn2);
					document.removeEventListener("focusout", handleFocusOut2);
					mutationObserver.disconnect();
				};
			}
		}, [
			trapped,
			container,
			focusScope.paused
		]);
		y(() => {
			if (container) {
				focusScopesStack.add(focusScope);
				const previouslyFocusedElement = document.activeElement;
				if (!container.contains(previouslyFocusedElement)) {
					const mountEvent = new CustomEvent(AUTOFOCUS_ON_MOUNT, EVENT_OPTIONS);
					container.addEventListener(AUTOFOCUS_ON_MOUNT, onMountAutoFocus);
					container.dispatchEvent(mountEvent);
					if (!mountEvent.defaultPrevented) {
						focusFirst(removeLinks(getTabbableCandidates(container)), { select: true });
						if (document.activeElement === previouslyFocusedElement) focus(container);
					}
				}
				return () => {
					container.removeEventListener(AUTOFOCUS_ON_MOUNT, onMountAutoFocus);
					setTimeout(() => {
						const unmountEvent = new CustomEvent(AUTOFOCUS_ON_UNMOUNT, EVENT_OPTIONS);
						container.addEventListener(AUTOFOCUS_ON_UNMOUNT, onUnmountAutoFocus);
						container.dispatchEvent(unmountEvent);
						if (!unmountEvent.defaultPrevented) focus(previouslyFocusedElement ?? document.body, { select: true });
						container.removeEventListener(AUTOFOCUS_ON_UNMOUNT, onUnmountAutoFocus);
						focusScopesStack.remove(focusScope);
					}, 0);
				};
			}
		}, [
			container,
			onMountAutoFocus,
			onUnmountAutoFocus,
			focusScope
		]);
		const handleKeyDown = q$1((event) => {
			if (!loop && !trapped) return;
			if (focusScope.paused) return;
			const isTabKey = event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey;
			const focusedElement = document.activeElement;
			if (isTabKey && focusedElement) {
				const container2 = event.currentTarget;
				const [first, last] = getTabbableEdges(container2);
				if (!(first && last)) {
					if (focusedElement === container2) event.preventDefault();
				} else if (!event.shiftKey && focusedElement === last) {
					event.preventDefault();
					if (loop) focus(first, { select: true });
				} else if (event.shiftKey && focusedElement === first) {
					event.preventDefault();
					if (loop) focus(last, { select: true });
				}
			}
		}, [
			loop,
			trapped,
			focusScope.paused
		]);
		return /* @__PURE__ */ u(Primitive.div, {
			tabIndex: -1,
			...scopeProps,
			ref: composedRefs,
			onKeyDown: handleKeyDown
		});
	});
	FocusScope.displayName = FOCUS_SCOPE_NAME;
	function focusFirst(candidates, { select = false } = {}) {
		const previouslyFocusedElement = document.activeElement;
		for (const candidate of candidates) {
			focus(candidate, { select });
			if (document.activeElement !== previouslyFocusedElement) return;
		}
	}
	function getTabbableEdges(container) {
		const candidates = getTabbableCandidates(container);
		return [findVisible(candidates, container), findVisible(candidates.reverse(), container)];
	}
	function getTabbableCandidates(container) {
		const nodes = [];
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, { acceptNode: (node) => {
			const isHiddenInput = node.tagName === "INPUT" && node.type === "hidden";
			if (node.disabled || node.hidden || isHiddenInput) return NodeFilter.FILTER_SKIP;
			return node.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		} });
		while (walker.nextNode()) nodes.push(walker.currentNode);
		return nodes;
	}
	function findVisible(elements, container) {
		for (const element of elements) if (!isHidden(element, { upTo: container })) return element;
	}
	function isHidden(node, { upTo }) {
		if (getComputedStyle(node).visibility === "hidden") return true;
		while (node) {
			if (upTo !== void 0 && node === upTo) return false;
			if (getComputedStyle(node).display === "none") return true;
			node = node.parentElement;
		}
		return false;
	}
	function isSelectableInput(element) {
		return element instanceof HTMLInputElement && "select" in element;
	}
	function focus(element, { select = false } = {}) {
		if (element && element.focus) {
			const previouslyFocusedElement = document.activeElement;
			element.focus({ preventScroll: true });
			if (element !== previouslyFocusedElement && isSelectableInput(element) && select) element.select();
		}
	}
	var focusScopesStack = createFocusScopesStack();
	function createFocusScopesStack() {
		let stack = [];
		return {
			add(focusScope) {
				const activeFocusScope = stack[0];
				if (focusScope !== activeFocusScope) activeFocusScope?.pause();
				stack = arrayRemove(stack, focusScope);
				stack.unshift(focusScope);
			},
			remove(focusScope) {
				stack = arrayRemove(stack, focusScope);
				stack[0]?.resume();
			}
		};
	}
	function arrayRemove(array, item) {
		const updatedArray = [...array];
		const index = updatedArray.indexOf(item);
		if (index !== -1) updatedArray.splice(index, 1);
		return updatedArray;
	}
	function removeLinks(items) {
		return items.filter((item) => item.tagName !== "A");
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-portal@1.1.9_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-portal/dist/index.mjs
	var PORTAL_NAME$2 = "Portal";
	var Portal$2 = D((props, forwardedRef) => {
		const { container: containerProp, ...portalProps } = props;
		const [mounted, setMounted] = d(false);
		useLayoutEffect2(() => setMounted(true), []);
		const container = containerProp || mounted && globalThis?.document?.body;
		return container ? gn.createPortal(/* @__PURE__ */ u(Primitive.div, {
			...portalProps,
			ref: forwardedRef
		}), container) : null;
	});
	Portal$2.displayName = PORTAL_NAME$2;
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-focus-guards@1.1.3_react@19.2.4/node_modules/@radix-ui/react-focus-guards/dist/index.mjs
	var count = 0;
	function useFocusGuards() {
		y(() => {
			const edgeGuards = document.querySelectorAll("[data-radix-focus-guard]");
			document.body.insertAdjacentElement("afterbegin", edgeGuards[0] ?? createFocusGuard());
			document.body.insertAdjacentElement("beforeend", edgeGuards[1] ?? createFocusGuard());
			count++;
			return () => {
				if (count === 1) document.querySelectorAll("[data-radix-focus-guard]").forEach((node) => node.remove());
				count--;
			};
		}, []);
	}
	function createFocusGuard() {
		const element = document.createElement("span");
		element.setAttribute("data-radix-focus-guard", "");
		element.tabIndex = 0;
		element.style.outline = "none";
		element.style.opacity = "0";
		element.style.position = "fixed";
		element.style.pointerEvents = "none";
		return element;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs
	var __assign = function() {
		__assign = Object.assign || function __assign(t) {
			for (var s, i = 1, n = arguments.length; i < n; i++) {
				s = arguments[i];
				for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
			}
			return t;
		};
		return __assign.apply(this, arguments);
	};
	function __rest(s, e) {
		var t = {};
		for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];
		if (s != null && typeof Object.getOwnPropertySymbols === "function") {
			for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i])) t[p[i]] = s[p[i]];
		}
		return t;
	}
	function __spreadArray(to, from, pack) {
		if (pack || arguments.length === 2) {
			for (var i = 0, l = from.length, ar; i < l; i++) if (ar || !(i in from)) {
				if (!ar) ar = Array.prototype.slice.call(from, 0, i);
				ar[i] = from[i];
			}
		}
		return to.concat(ar || Array.prototype.slice.call(from));
	}
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll-bar@2.3.8_react@19.2.4/node_modules/react-remove-scroll-bar/dist/es2015/constants.js
	var zeroRightClassName = "right-scroll-bar-position";
	var fullWidthClassName = "width-before-scroll-bar";
	var noScrollbarsClassName = "with-scroll-bars-hidden";
	/**
	* Name of a CSS variable containing the amount of "hidden" scrollbar
	* ! might be undefined ! use will fallback!
	*/
	var removedBarSizeVariable = "--removed-body-scroll-bar-size";
	//#endregion
	//#region ../../node_modules/.pnpm/use-callback-ref@1.3.3_react@19.2.4/node_modules/use-callback-ref/dist/es2015/assignRef.js
	/**
	* Assigns a value for a given ref, no matter of the ref format
	* @param {RefObject} ref - a callback function or ref object
	* @param value - a new value
	*
	* @see https://github.com/theKashey/use-callback-ref#assignref
	* @example
	* const refObject = useRef();
	* const refFn = (ref) => {....}
	*
	* assignRef(refObject, "refValue");
	* assignRef(refFn, "refValue");
	*/
	function assignRef(ref, value) {
		if (typeof ref === "function") ref(value);
		else if (ref) ref.current = value;
		return ref;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/use-callback-ref@1.3.3_react@19.2.4/node_modules/use-callback-ref/dist/es2015/useRef.js
	/**
	* creates a MutableRef with ref change callback
	* @param initialValue - initial ref value
	* @param {Function} callback - a callback to run when value changes
	*
	* @example
	* const ref = useCallbackRef(0, (newValue, oldValue) => console.log(oldValue, '->', newValue);
	* ref.current = 1;
	* // prints 0 -> 1
	*
	* @see https://reactjs.org/docs/hooks-reference.html#useref
	* @see https://github.com/theKashey/use-callback-ref#usecallbackref---to-replace-reactuseref
	* @returns {MutableRefObject}
	*/
	function useCallbackRef(initialValue, callback) {
		var ref = d(function() {
			return {
				value: initialValue,
				callback,
				facade: {
					get current() {
						return ref.value;
					},
					set current(value) {
						var last = ref.value;
						if (last !== value) {
							ref.value = value;
							ref.callback(value, last);
						}
					}
				}
			};
		})[0];
		ref.callback = callback;
		return ref.facade;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/use-callback-ref@1.3.3_react@19.2.4/node_modules/use-callback-ref/dist/es2015/useMergeRef.js
	var useIsomorphicLayoutEffect = typeof window !== "undefined" ? _ : y;
	var currentValues = /* @__PURE__ */ new WeakMap();
	/**
	* Merges two or more refs together providing a single interface to set their value
	* @param {RefObject|Ref} refs
	* @returns {MutableRefObject} - a new ref, which translates all changes to {refs}
	*
	* @see {@link mergeRefs} a version without buit-in memoization
	* @see https://github.com/theKashey/use-callback-ref#usemergerefs
	* @example
	* const Component = React.forwardRef((props, ref) => {
	*   const ownRef = useRef();
	*   const domRef = useMergeRefs([ref, ownRef]); // 👈 merge together
	*   return <div ref={domRef}>...</div>
	* }
	*/
	function useMergeRefs(refs, defaultValue) {
		var callbackRef = useCallbackRef(defaultValue || null, function(newValue) {
			return refs.forEach(function(ref) {
				return assignRef(ref, newValue);
			});
		});
		useIsomorphicLayoutEffect(function() {
			var oldValue = currentValues.get(callbackRef);
			if (oldValue) {
				var prevRefs_1 = new Set(oldValue);
				var nextRefs_1 = new Set(refs);
				var current_1 = callbackRef.current;
				prevRefs_1.forEach(function(ref) {
					if (!nextRefs_1.has(ref)) assignRef(ref, null);
				});
				nextRefs_1.forEach(function(ref) {
					if (!prevRefs_1.has(ref)) assignRef(ref, current_1);
				});
			}
			currentValues.set(callbackRef, refs);
		}, [refs]);
		return callbackRef;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/use-sidecar@1.1.3_react@19.2.4/node_modules/use-sidecar/dist/es2015/medium.js
	function ItoI(a) {
		return a;
	}
	function innerCreateMedium(defaults, middleware) {
		if (middleware === void 0) middleware = ItoI;
		var buffer = [];
		var assigned = false;
		return {
			read: function() {
				if (assigned) throw new Error("Sidecar: could not `read` from an `assigned` medium. `read` could be used only with `useMedium`.");
				if (buffer.length) return buffer[buffer.length - 1];
				return defaults;
			},
			useMedium: function(data) {
				var item = middleware(data, assigned);
				buffer.push(item);
				return function() {
					buffer = buffer.filter(function(x) {
						return x !== item;
					});
				};
			},
			assignSyncMedium: function(cb) {
				assigned = true;
				while (buffer.length) {
					var cbs = buffer;
					buffer = [];
					cbs.forEach(cb);
				}
				buffer = {
					push: function(x) {
						return cb(x);
					},
					filter: function() {
						return buffer;
					}
				};
			},
			assignMedium: function(cb) {
				assigned = true;
				var pendingQueue = [];
				if (buffer.length) {
					var cbs = buffer;
					buffer = [];
					cbs.forEach(cb);
					pendingQueue = buffer;
				}
				var executeQueue = function() {
					var cbs = pendingQueue;
					pendingQueue = [];
					cbs.forEach(cb);
				};
				var cycle = function() {
					return Promise.resolve().then(executeQueue);
				};
				cycle();
				buffer = {
					push: function(x) {
						pendingQueue.push(x);
						cycle();
					},
					filter: function(filter) {
						pendingQueue = pendingQueue.filter(filter);
						return buffer;
					}
				};
			}
		};
	}
	function createSidecarMedium(options) {
		if (options === void 0) options = {};
		var medium = innerCreateMedium(null);
		medium.options = __assign({
			async: true,
			ssr: false
		}, options);
		return medium;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/use-sidecar@1.1.3_react@19.2.4/node_modules/use-sidecar/dist/es2015/exports.js
	var SideCar = function(_a) {
		var sideCar = _a.sideCar, rest = __rest(_a, ["sideCar"]);
		if (!sideCar) throw new Error("Sidecar: please provide `sideCar` property to import the right car");
		var Target = sideCar.read();
		if (!Target) throw new Error("Sidecar medium not found");
		return _$1(Target, __assign({}, rest));
	};
	SideCar.isSideCarExport = true;
	function exportSidecar(medium, exported) {
		medium.useMedium(exported);
		return SideCar;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll@2.7.2_react@19.2.4/node_modules/react-remove-scroll/dist/es2015/medium.js
	var effectCar = createSidecarMedium();
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll@2.7.2_react@19.2.4/node_modules/react-remove-scroll/dist/es2015/UI.js
	var nothing = function() {};
	/**
	* Removes scrollbar from the page and contain the scroll within the Lock
	*/
	var RemoveScroll = D(function(props, parentRef) {
		var ref = A$1(null);
		var _a = d({
			onScrollCapture: nothing,
			onWheelCapture: nothing,
			onTouchMoveCapture: nothing
		}), callbacks = _a[0], setCallbacks = _a[1];
		var forwardProps = props.forwardProps, children = props.children, className = props.className, removeScrollBar = props.removeScrollBar, enabled = props.enabled, shards = props.shards, sideCar = props.sideCar, noRelative = props.noRelative, noIsolation = props.noIsolation, inert = props.inert, allowPinchZoom = props.allowPinchZoom, _b = props.as, Container = _b === void 0 ? "div" : _b, gapMode = props.gapMode, rest = __rest(props, [
			"forwardProps",
			"children",
			"className",
			"removeScrollBar",
			"enabled",
			"shards",
			"sideCar",
			"noRelative",
			"noIsolation",
			"inert",
			"allowPinchZoom",
			"as",
			"gapMode"
		]);
		var SideCar = sideCar;
		var containerRef = useMergeRefs([ref, parentRef]);
		var containerProps = __assign(__assign({}, rest), callbacks);
		return _$1(k$2, null, enabled && _$1(SideCar, {
			sideCar: effectCar,
			removeScrollBar,
			shards,
			noRelative,
			noIsolation,
			inert,
			setCallbacks,
			allowPinchZoom: !!allowPinchZoom,
			lockRef: ref,
			gapMode
		}), forwardProps ? mn(L.only(children), __assign(__assign({}, containerProps), { ref: containerRef })) : _$1(Container, __assign({}, containerProps, {
			className,
			ref: containerRef
		}), children));
	});
	RemoveScroll.defaultProps = {
		enabled: true,
		removeScrollBar: true,
		inert: false
	};
	RemoveScroll.classNames = {
		fullWidth: fullWidthClassName,
		zeroRight: zeroRightClassName
	};
	//#endregion
	//#region ../../node_modules/.pnpm/get-nonce@1.0.1/node_modules/get-nonce/dist/es2015/index.js
	var currentNonce;
	var getNonce = function() {
		if (currentNonce) return currentNonce;
		if (typeof __webpack_nonce__ !== "undefined") return __webpack_nonce__;
	};
	//#endregion
	//#region ../../node_modules/.pnpm/react-style-singleton@2.2.3_react@19.2.4/node_modules/react-style-singleton/dist/es2015/singleton.js
	function makeStyleTag() {
		if (!document) return null;
		var tag = document.createElement("style");
		tag.type = "text/css";
		var nonce = getNonce();
		if (nonce) tag.setAttribute("nonce", nonce);
		return tag;
	}
	function injectStyles(tag, css) {
		if (tag.styleSheet) tag.styleSheet.cssText = css;
		else tag.appendChild(document.createTextNode(css));
	}
	function insertStyleTag(tag) {
		(document.head || document.getElementsByTagName("head")[0]).appendChild(tag);
	}
	var stylesheetSingleton = function() {
		var counter = 0;
		var stylesheet = null;
		return {
			add: function(style) {
				if (counter == 0) {
					if (stylesheet = makeStyleTag()) {
						injectStyles(stylesheet, style);
						insertStyleTag(stylesheet);
					}
				}
				counter++;
			},
			remove: function() {
				counter--;
				if (!counter && stylesheet) {
					stylesheet.parentNode && stylesheet.parentNode.removeChild(stylesheet);
					stylesheet = null;
				}
			}
		};
	};
	//#endregion
	//#region ../../node_modules/.pnpm/react-style-singleton@2.2.3_react@19.2.4/node_modules/react-style-singleton/dist/es2015/hook.js
	/**
	* creates a hook to control style singleton
	* @see {@link styleSingleton} for a safer component version
	* @example
	* ```tsx
	* const useStyle = styleHookSingleton();
	* ///
	* useStyle('body { overflow: hidden}');
	*/
	var styleHookSingleton = function() {
		var sheet = stylesheetSingleton();
		return function(styles, isDynamic) {
			y(function() {
				sheet.add(styles);
				return function() {
					sheet.remove();
				};
			}, [styles && isDynamic]);
		};
	};
	//#endregion
	//#region ../../node_modules/.pnpm/react-style-singleton@2.2.3_react@19.2.4/node_modules/react-style-singleton/dist/es2015/component.js
	/**
	* create a Component to add styles on demand
	* - styles are added when first instance is mounted
	* - styles are removed when the last instance is unmounted
	* - changing styles in runtime does nothing unless dynamic is set. But with multiple components that can lead to the undefined behavior
	*/
	var styleSingleton = function() {
		var useStyle = styleHookSingleton();
		var Sheet = function(_a) {
			var styles = _a.styles, dynamic = _a.dynamic;
			useStyle(styles, dynamic);
			return null;
		};
		return Sheet;
	};
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll-bar@2.3.8_react@19.2.4/node_modules/react-remove-scroll-bar/dist/es2015/utils.js
	var zeroGap = {
		left: 0,
		top: 0,
		right: 0,
		gap: 0
	};
	var parse = function(x) {
		return parseInt(x || "", 10) || 0;
	};
	var getOffset = function(gapMode) {
		var cs = window.getComputedStyle(document.body);
		var left = cs[gapMode === "padding" ? "paddingLeft" : "marginLeft"];
		var top = cs[gapMode === "padding" ? "paddingTop" : "marginTop"];
		var right = cs[gapMode === "padding" ? "paddingRight" : "marginRight"];
		return [
			parse(left),
			parse(top),
			parse(right)
		];
	};
	var getGapWidth = function(gapMode) {
		if (gapMode === void 0) gapMode = "margin";
		if (typeof window === "undefined") return zeroGap;
		var offsets = getOffset(gapMode);
		var documentWidth = document.documentElement.clientWidth;
		var windowWidth = window.innerWidth;
		return {
			left: offsets[0],
			top: offsets[1],
			right: offsets[2],
			gap: Math.max(0, windowWidth - documentWidth + offsets[2] - offsets[0])
		};
	};
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll-bar@2.3.8_react@19.2.4/node_modules/react-remove-scroll-bar/dist/es2015/component.js
	var Style = styleSingleton();
	var lockAttribute = "data-scroll-locked";
	var getStyles = function(_a, allowRelative, gapMode, important) {
		var left = _a.left, top = _a.top, right = _a.right, gap = _a.gap;
		if (gapMode === void 0) gapMode = "margin";
		return "\n  .".concat(noScrollbarsClassName, " {\n   overflow: hidden ").concat(important, ";\n   padding-right: ").concat(gap, "px ").concat(important, ";\n  }\n  body[").concat(lockAttribute, "] {\n    overflow: hidden ").concat(important, ";\n    overscroll-behavior: contain;\n    ").concat([
			allowRelative && "position: relative ".concat(important, ";"),
			gapMode === "margin" && "\n    padding-left: ".concat(left, "px;\n    padding-top: ").concat(top, "px;\n    padding-right: ").concat(right, "px;\n    margin-left:0;\n    margin-top:0;\n    margin-right: ").concat(gap, "px ").concat(important, ";\n    "),
			gapMode === "padding" && "padding-right: ".concat(gap, "px ").concat(important, ";")
		].filter(Boolean).join(""), "\n  }\n  \n  .").concat(zeroRightClassName, " {\n    right: ").concat(gap, "px ").concat(important, ";\n  }\n  \n  .").concat(fullWidthClassName, " {\n    margin-right: ").concat(gap, "px ").concat(important, ";\n  }\n  \n  .").concat(zeroRightClassName, " .").concat(zeroRightClassName, " {\n    right: 0 ").concat(important, ";\n  }\n  \n  .").concat(fullWidthClassName, " .").concat(fullWidthClassName, " {\n    margin-right: 0 ").concat(important, ";\n  }\n  \n  body[").concat(lockAttribute, "] {\n    ").concat(removedBarSizeVariable, ": ").concat(gap, "px;\n  }\n");
	};
	var getCurrentUseCounter = function() {
		var counter = parseInt(document.body.getAttribute("data-scroll-locked") || "0", 10);
		return isFinite(counter) ? counter : 0;
	};
	var useLockAttribute = function() {
		y(function() {
			document.body.setAttribute(lockAttribute, (getCurrentUseCounter() + 1).toString());
			return function() {
				var newCounter = getCurrentUseCounter() - 1;
				if (newCounter <= 0) document.body.removeAttribute(lockAttribute);
				else document.body.setAttribute(lockAttribute, newCounter.toString());
			};
		}, []);
	};
	/**
	* Removes page scrollbar and blocks page scroll when mounted
	*/
	var RemoveScrollBar = function(_a) {
		var noRelative = _a.noRelative, noImportant = _a.noImportant, _b = _a.gapMode, gapMode = _b === void 0 ? "margin" : _b;
		useLockAttribute();
		return _$1(Style, { styles: getStyles(T$1(function() {
			return getGapWidth(gapMode);
		}, [gapMode]), !noRelative, gapMode, !noImportant ? "!important" : "") });
	};
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll@2.7.2_react@19.2.4/node_modules/react-remove-scroll/dist/es2015/aggresiveCapture.js
	var passiveSupported = false;
	if (typeof window !== "undefined") try {
		var options = Object.defineProperty({}, "passive", { get: function() {
			passiveSupported = true;
			return true;
		} });
		window.addEventListener("test", options, options);
		window.removeEventListener("test", options, options);
	} catch (err) {
		passiveSupported = false;
	}
	var nonPassive = passiveSupported ? { passive: false } : false;
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll@2.7.2_react@19.2.4/node_modules/react-remove-scroll/dist/es2015/handleScroll.js
	var alwaysContainsScroll = function(node) {
		return node.tagName === "TEXTAREA";
	};
	var elementCanBeScrolled = function(node, overflow) {
		if (!(node instanceof Element)) return false;
		var styles = window.getComputedStyle(node);
		return styles[overflow] !== "hidden" && !(styles.overflowY === styles.overflowX && !alwaysContainsScroll(node) && styles[overflow] === "visible");
	};
	var elementCouldBeVScrolled = function(node) {
		return elementCanBeScrolled(node, "overflowY");
	};
	var elementCouldBeHScrolled = function(node) {
		return elementCanBeScrolled(node, "overflowX");
	};
	var locationCouldBeScrolled = function(axis, node) {
		var ownerDocument = node.ownerDocument;
		var current = node;
		do {
			if (typeof ShadowRoot !== "undefined" && current instanceof ShadowRoot) current = current.host;
			if (elementCouldBeScrolled(axis, current)) {
				var _a = getScrollVariables(axis, current);
				if (_a[1] > _a[2]) return true;
			}
			current = current.parentNode;
		} while (current && current !== ownerDocument.body);
		return false;
	};
	var getVScrollVariables = function(_a) {
		return [
			_a.scrollTop,
			_a.scrollHeight,
			_a.clientHeight
		];
	};
	var getHScrollVariables = function(_a) {
		return [
			_a.scrollLeft,
			_a.scrollWidth,
			_a.clientWidth
		];
	};
	var elementCouldBeScrolled = function(axis, node) {
		return axis === "v" ? elementCouldBeVScrolled(node) : elementCouldBeHScrolled(node);
	};
	var getScrollVariables = function(axis, node) {
		return axis === "v" ? getVScrollVariables(node) : getHScrollVariables(node);
	};
	var getDirectionFactor = function(axis, direction) {
		/**
		* If the element's direction is rtl (right-to-left), then scrollLeft is 0 when the scrollbar is at its rightmost position,
		* and then increasingly negative as you scroll towards the end of the content.
		* @see https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollLeft
		*/
		return axis === "h" && direction === "rtl" ? -1 : 1;
	};
	var handleScroll = function(axis, endTarget, event, sourceDelta, noOverscroll) {
		var directionFactor = getDirectionFactor(axis, window.getComputedStyle(endTarget).direction);
		var delta = directionFactor * sourceDelta;
		var target = event.target;
		var targetInLock = endTarget.contains(target);
		var shouldCancelScroll = false;
		var isDeltaPositive = delta > 0;
		var availableScroll = 0;
		var availableScrollTop = 0;
		do {
			if (!target) break;
			var _a = getScrollVariables(axis, target), position = _a[0];
			var elementScroll = _a[1] - _a[2] - directionFactor * position;
			if (position || elementScroll) {
				if (elementCouldBeScrolled(axis, target)) {
					availableScroll += elementScroll;
					availableScrollTop += position;
				}
			}
			var parent_1 = target.parentNode;
			target = parent_1 && parent_1.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? parent_1.host : parent_1;
		} while (!targetInLock && target !== document.body || targetInLock && (endTarget.contains(target) || endTarget === target));
		if (isDeltaPositive && (noOverscroll && Math.abs(availableScroll) < 1 || !noOverscroll && delta > availableScroll)) shouldCancelScroll = true;
		else if (!isDeltaPositive && (noOverscroll && Math.abs(availableScrollTop) < 1 || !noOverscroll && -delta > availableScrollTop)) shouldCancelScroll = true;
		return shouldCancelScroll;
	};
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll@2.7.2_react@19.2.4/node_modules/react-remove-scroll/dist/es2015/SideEffect.js
	var getTouchXY = function(event) {
		return "changedTouches" in event ? [event.changedTouches[0].clientX, event.changedTouches[0].clientY] : [0, 0];
	};
	var getDeltaXY = function(event) {
		return [event.deltaX, event.deltaY];
	};
	var extractRef = function(ref) {
		return ref && "current" in ref ? ref.current : ref;
	};
	var deltaCompare = function(x, y) {
		return x[0] === y[0] && x[1] === y[1];
	};
	var generateStyle = function(id) {
		return "\n  .block-interactivity-".concat(id, " {pointer-events: none;}\n  .allow-interactivity-").concat(id, " {pointer-events: all;}\n");
	};
	var idCounter = 0;
	var lockStack = [];
	function RemoveScrollSideCar(props) {
		var shouldPreventQueue = A$1([]);
		var touchStartRef = A$1([0, 0]);
		var activeAxis = A$1();
		var id = d(idCounter++)[0];
		var Style = d(styleSingleton)[0];
		var lastProps = A$1(props);
		y(function() {
			lastProps.current = props;
		}, [props]);
		y(function() {
			if (props.inert) {
				document.body.classList.add("block-interactivity-".concat(id));
				var allow_1 = __spreadArray([props.lockRef.current], (props.shards || []).map(extractRef), true).filter(Boolean);
				allow_1.forEach(function(el) {
					return el.classList.add("allow-interactivity-".concat(id));
				});
				return function() {
					document.body.classList.remove("block-interactivity-".concat(id));
					allow_1.forEach(function(el) {
						return el.classList.remove("allow-interactivity-".concat(id));
					});
				};
			}
		}, [
			props.inert,
			props.lockRef.current,
			props.shards
		]);
		var shouldCancelEvent = q$1(function(event, parent) {
			if ("touches" in event && event.touches.length === 2 || event.type === "wheel" && event.ctrlKey) return !lastProps.current.allowPinchZoom;
			var touch = getTouchXY(event);
			var touchStart = touchStartRef.current;
			var deltaX = "deltaX" in event ? event.deltaX : touchStart[0] - touch[0];
			var deltaY = "deltaY" in event ? event.deltaY : touchStart[1] - touch[1];
			var currentAxis;
			var target = event.target;
			var moveDirection = Math.abs(deltaX) > Math.abs(deltaY) ? "h" : "v";
			if ("touches" in event && moveDirection === "h" && target.type === "range") return false;
			var selection = window.getSelection();
			var anchorNode = selection && selection.anchorNode;
			if (anchorNode ? anchorNode === target || anchorNode.contains(target) : false) return false;
			var canBeScrolledInMainDirection = locationCouldBeScrolled(moveDirection, target);
			if (!canBeScrolledInMainDirection) return true;
			if (canBeScrolledInMainDirection) currentAxis = moveDirection;
			else {
				currentAxis = moveDirection === "v" ? "h" : "v";
				canBeScrolledInMainDirection = locationCouldBeScrolled(moveDirection, target);
			}
			if (!canBeScrolledInMainDirection) return false;
			if (!activeAxis.current && "changedTouches" in event && (deltaX || deltaY)) activeAxis.current = currentAxis;
			if (!currentAxis) return true;
			var cancelingAxis = activeAxis.current || currentAxis;
			return handleScroll(cancelingAxis, parent, event, cancelingAxis === "h" ? deltaX : deltaY, true);
		}, []);
		var shouldPrevent = q$1(function(_event) {
			var event = _event;
			if (!lockStack.length || lockStack[lockStack.length - 1] !== Style) return;
			var delta = "deltaY" in event ? getDeltaXY(event) : getTouchXY(event);
			var sourceEvent = shouldPreventQueue.current.filter(function(e) {
				return e.name === event.type && (e.target === event.target || event.target === e.shadowParent) && deltaCompare(e.delta, delta);
			})[0];
			if (sourceEvent && sourceEvent.should) {
				if (event.cancelable) event.preventDefault();
				return;
			}
			if (!sourceEvent) {
				var shardNodes = (lastProps.current.shards || []).map(extractRef).filter(Boolean).filter(function(node) {
					return node.contains(event.target);
				});
				if (shardNodes.length > 0 ? shouldCancelEvent(event, shardNodes[0]) : !lastProps.current.noIsolation) {
					if (event.cancelable) event.preventDefault();
				}
			}
		}, []);
		var shouldCancel = q$1(function(name, delta, target, should) {
			var event = {
				name,
				delta,
				target,
				should,
				shadowParent: getOutermostShadowParent(target)
			};
			shouldPreventQueue.current.push(event);
			setTimeout(function() {
				shouldPreventQueue.current = shouldPreventQueue.current.filter(function(e) {
					return e !== event;
				});
			}, 1);
		}, []);
		var scrollTouchStart = q$1(function(event) {
			touchStartRef.current = getTouchXY(event);
			activeAxis.current = void 0;
		}, []);
		var scrollWheel = q$1(function(event) {
			shouldCancel(event.type, getDeltaXY(event), event.target, shouldCancelEvent(event, props.lockRef.current));
		}, []);
		var scrollTouchMove = q$1(function(event) {
			shouldCancel(event.type, getTouchXY(event), event.target, shouldCancelEvent(event, props.lockRef.current));
		}, []);
		y(function() {
			lockStack.push(Style);
			props.setCallbacks({
				onScrollCapture: scrollWheel,
				onWheelCapture: scrollWheel,
				onTouchMoveCapture: scrollTouchMove
			});
			document.addEventListener("wheel", shouldPrevent, nonPassive);
			document.addEventListener("touchmove", shouldPrevent, nonPassive);
			document.addEventListener("touchstart", scrollTouchStart, nonPassive);
			return function() {
				lockStack = lockStack.filter(function(inst) {
					return inst !== Style;
				});
				document.removeEventListener("wheel", shouldPrevent, nonPassive);
				document.removeEventListener("touchmove", shouldPrevent, nonPassive);
				document.removeEventListener("touchstart", scrollTouchStart, nonPassive);
			};
		}, []);
		var removeScrollBar = props.removeScrollBar, inert = props.inert;
		return _$1(k$2, null, inert ? _$1(Style, { styles: generateStyle(id) }) : null, removeScrollBar ? _$1(RemoveScrollBar, {
			noRelative: props.noRelative,
			gapMode: props.gapMode
		}) : null);
	}
	function getOutermostShadowParent(node) {
		var shadowParent = null;
		while (node !== null) {
			if (node instanceof ShadowRoot) {
				shadowParent = node.host;
				node = node.host;
			}
			node = node.parentNode;
		}
		return shadowParent;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll@2.7.2_react@19.2.4/node_modules/react-remove-scroll/dist/es2015/sidecar.js
	var sidecar_default = exportSidecar(effectCar, RemoveScrollSideCar);
	//#endregion
	//#region ../../node_modules/.pnpm/react-remove-scroll@2.7.2_react@19.2.4/node_modules/react-remove-scroll/dist/es2015/Combination.js
	var ReactRemoveScroll = D(function(props, ref) {
		return _$1(RemoveScroll, __assign({}, props, {
			ref,
			sideCar: sidecar_default
		}));
	});
	ReactRemoveScroll.classNames = RemoveScroll.classNames;
	//#endregion
	//#region ../../node_modules/.pnpm/aria-hidden@1.2.6/node_modules/aria-hidden/dist/es2015/index.js
	var getDefaultParent = function(originalTarget) {
		if (typeof document === "undefined") return null;
		return (Array.isArray(originalTarget) ? originalTarget[0] : originalTarget).ownerDocument.body;
	};
	var counterMap = /* @__PURE__ */ new WeakMap();
	var uncontrolledNodes = /* @__PURE__ */ new WeakMap();
	var markerMap = {};
	var lockCount = 0;
	var unwrapHost = function(node) {
		return node && (node.host || unwrapHost(node.parentNode));
	};
	var correctTargets = function(parent, targets) {
		return targets.map(function(target) {
			if (parent.contains(target)) return target;
			var correctedTarget = unwrapHost(target);
			if (correctedTarget && parent.contains(correctedTarget)) return correctedTarget;
			console.error("aria-hidden", target, "in not contained inside", parent, ". Doing nothing");
			return null;
		}).filter(function(x) {
			return Boolean(x);
		});
	};
	/**
	* Marks everything except given node(or nodes) as aria-hidden
	* @param {Element | Element[]} originalTarget - elements to keep on the page
	* @param [parentNode] - top element, defaults to document.body
	* @param {String} [markerName] - a special attribute to mark every node
	* @param {String} [controlAttribute] - html Attribute to control
	* @return {Undo} undo command
	*/
	var applyAttributeToOthers = function(originalTarget, parentNode, markerName, controlAttribute) {
		var targets = correctTargets(parentNode, Array.isArray(originalTarget) ? originalTarget : [originalTarget]);
		if (!markerMap[markerName]) markerMap[markerName] = /* @__PURE__ */ new WeakMap();
		var markerCounter = markerMap[markerName];
		var hiddenNodes = [];
		var elementsToKeep = /* @__PURE__ */ new Set();
		var elementsToStop = new Set(targets);
		var keep = function(el) {
			if (!el || elementsToKeep.has(el)) return;
			elementsToKeep.add(el);
			keep(el.parentNode);
		};
		targets.forEach(keep);
		var deep = function(parent) {
			if (!parent || elementsToStop.has(parent)) return;
			Array.prototype.forEach.call(parent.children, function(node) {
				if (elementsToKeep.has(node)) deep(node);
				else try {
					var attr = node.getAttribute(controlAttribute);
					var alreadyHidden = attr !== null && attr !== "false";
					var counterValue = (counterMap.get(node) || 0) + 1;
					var markerValue = (markerCounter.get(node) || 0) + 1;
					counterMap.set(node, counterValue);
					markerCounter.set(node, markerValue);
					hiddenNodes.push(node);
					if (counterValue === 1 && alreadyHidden) uncontrolledNodes.set(node, true);
					if (markerValue === 1) node.setAttribute(markerName, "true");
					if (!alreadyHidden) node.setAttribute(controlAttribute, "true");
				} catch (e) {
					console.error("aria-hidden: cannot operate on ", node, e);
				}
			});
		};
		deep(parentNode);
		elementsToKeep.clear();
		lockCount++;
		return function() {
			hiddenNodes.forEach(function(node) {
				var counterValue = counterMap.get(node) - 1;
				var markerValue = markerCounter.get(node) - 1;
				counterMap.set(node, counterValue);
				markerCounter.set(node, markerValue);
				if (!counterValue) {
					if (!uncontrolledNodes.has(node)) node.removeAttribute(controlAttribute);
					uncontrolledNodes.delete(node);
				}
				if (!markerValue) node.removeAttribute(markerName);
			});
			lockCount--;
			if (!lockCount) {
				counterMap = /* @__PURE__ */ new WeakMap();
				counterMap = /* @__PURE__ */ new WeakMap();
				uncontrolledNodes = /* @__PURE__ */ new WeakMap();
				markerMap = {};
			}
		};
	};
	/**
	* Marks everything except given node(or nodes) as aria-hidden
	* @param {Element | Element[]} originalTarget - elements to keep on the page
	* @param [parentNode] - top element, defaults to document.body
	* @param {String} [markerName] - a special attribute to mark every node
	* @return {Undo} undo command
	*/
	var hideOthers = function(originalTarget, parentNode, markerName) {
		if (markerName === void 0) markerName = "data-aria-hidden";
		var targets = Array.from(Array.isArray(originalTarget) ? originalTarget : [originalTarget]);
		var activeParentNode = parentNode || getDefaultParent(originalTarget);
		if (!activeParentNode) return function() {
			return null;
		};
		targets.push.apply(targets, Array.from(activeParentNode.querySelectorAll("[aria-live], script")));
		return applyAttributeToOthers(targets, activeParentNode, markerName, "aria-hidden");
	};
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-dialog@1.1.15_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-dialog/dist/index.mjs
	var DIALOG_NAME = "Dialog";
	var [createDialogContext, createDialogScope] = createContextScope(DIALOG_NAME);
	var [DialogProvider, useDialogContext] = createDialogContext(DIALOG_NAME);
	var Dialog = (props) => {
		const { __scopeDialog, children, open: openProp, defaultOpen, onOpenChange, modal = true } = props;
		const triggerRef = A$1(null);
		const contentRef = A$1(null);
		const [open, setOpen] = useControllableState({
			prop: openProp,
			defaultProp: defaultOpen ?? false,
			onChange: onOpenChange,
			caller: DIALOG_NAME
		});
		return /* @__PURE__ */ u(DialogProvider, {
			scope: __scopeDialog,
			triggerRef,
			contentRef,
			contentId: useId(),
			titleId: useId(),
			descriptionId: useId(),
			open,
			onOpenChange: setOpen,
			onOpenToggle: q$1(() => setOpen((prevOpen) => !prevOpen), [setOpen]),
			modal,
			children
		});
	};
	Dialog.displayName = DIALOG_NAME;
	var TRIGGER_NAME$1 = "DialogTrigger";
	var DialogTrigger = D((props, forwardedRef) => {
		const { __scopeDialog, ...triggerProps } = props;
		const context = useDialogContext(TRIGGER_NAME$1, __scopeDialog);
		const composedTriggerRef = useComposedRefs(forwardedRef, context.triggerRef);
		return /* @__PURE__ */ u(Primitive.button, {
			type: "button",
			"aria-haspopup": "dialog",
			"aria-expanded": context.open,
			"aria-controls": context.contentId,
			"data-state": getState(context.open),
			...triggerProps,
			ref: composedTriggerRef,
			onClick: composeEventHandlers(props.onClick, context.onOpenToggle)
		});
	});
	DialogTrigger.displayName = TRIGGER_NAME$1;
	var PORTAL_NAME$1 = "DialogPortal";
	var [PortalProvider, usePortalContext] = createDialogContext(PORTAL_NAME$1, { forceMount: void 0 });
	var DialogPortal = (props) => {
		const { __scopeDialog, forceMount, children, container } = props;
		const context = useDialogContext(PORTAL_NAME$1, __scopeDialog);
		return /* @__PURE__ */ u(PortalProvider, {
			scope: __scopeDialog,
			forceMount,
			children: L.map(children, (child) => /* @__PURE__ */ u(Presence, {
				present: forceMount || context.open,
				children: /* @__PURE__ */ u(Portal$2, {
					asChild: true,
					container,
					children: child
				})
			}))
		});
	};
	DialogPortal.displayName = PORTAL_NAME$1;
	var OVERLAY_NAME = "DialogOverlay";
	var DialogOverlay = D((props, forwardedRef) => {
		const portalContext = usePortalContext(OVERLAY_NAME, props.__scopeDialog);
		const { forceMount = portalContext.forceMount, ...overlayProps } = props;
		const context = useDialogContext(OVERLAY_NAME, props.__scopeDialog);
		return context.modal ? /* @__PURE__ */ u(Presence, {
			present: forceMount || context.open,
			children: /* @__PURE__ */ u(DialogOverlayImpl, {
				...overlayProps,
				ref: forwardedRef
			})
		}) : null;
	});
	DialogOverlay.displayName = OVERLAY_NAME;
	var Slot$1 = /* @__PURE__ */ createSlot("DialogOverlay.RemoveScroll");
	var DialogOverlayImpl = D((props, forwardedRef) => {
		const { __scopeDialog, ...overlayProps } = props;
		const context = useDialogContext(OVERLAY_NAME, __scopeDialog);
		return /* @__PURE__ */ u(ReactRemoveScroll, {
			as: Slot$1,
			allowPinchZoom: true,
			shards: [context.contentRef],
			children: /* @__PURE__ */ u(Primitive.div, {
				"data-state": getState(context.open),
				...overlayProps,
				ref: forwardedRef,
				style: {
					pointerEvents: "auto",
					...overlayProps.style
				}
			})
		});
	});
	var CONTENT_NAME$2 = "DialogContent";
	var DialogContent = D((props, forwardedRef) => {
		const portalContext = usePortalContext(CONTENT_NAME$2, props.__scopeDialog);
		const { forceMount = portalContext.forceMount, ...contentProps } = props;
		const context = useDialogContext(CONTENT_NAME$2, props.__scopeDialog);
		return /* @__PURE__ */ u(Presence, {
			present: forceMount || context.open,
			children: context.modal ? /* @__PURE__ */ u(DialogContentModal, {
				...contentProps,
				ref: forwardedRef
			}) : /* @__PURE__ */ u(DialogContentNonModal, {
				...contentProps,
				ref: forwardedRef
			})
		});
	});
	DialogContent.displayName = CONTENT_NAME$2;
	var DialogContentModal = D((props, forwardedRef) => {
		const context = useDialogContext(CONTENT_NAME$2, props.__scopeDialog);
		const contentRef = A$1(null);
		const composedRefs = useComposedRefs(forwardedRef, context.contentRef, contentRef);
		y(() => {
			const content = contentRef.current;
			if (content) return hideOthers(content);
		}, []);
		return /* @__PURE__ */ u(DialogContentImpl, {
			...props,
			ref: composedRefs,
			trapFocus: context.open,
			disableOutsidePointerEvents: true,
			onCloseAutoFocus: composeEventHandlers(props.onCloseAutoFocus, (event) => {
				event.preventDefault();
				context.triggerRef.current?.focus();
			}),
			onPointerDownOutside: composeEventHandlers(props.onPointerDownOutside, (event) => {
				const originalEvent = event.detail.originalEvent;
				const ctrlLeftClick = originalEvent.button === 0 && originalEvent.ctrlKey === true;
				if (originalEvent.button === 2 || ctrlLeftClick) event.preventDefault();
			}),
			onFocusOutside: composeEventHandlers(props.onFocusOutside, (event) => event.preventDefault())
		});
	});
	var DialogContentNonModal = D((props, forwardedRef) => {
		const context = useDialogContext(CONTENT_NAME$2, props.__scopeDialog);
		const hasInteractedOutsideRef = A$1(false);
		const hasPointerDownOutsideRef = A$1(false);
		return /* @__PURE__ */ u(DialogContentImpl, {
			...props,
			ref: forwardedRef,
			trapFocus: false,
			disableOutsidePointerEvents: false,
			onCloseAutoFocus: (event) => {
				props.onCloseAutoFocus?.(event);
				if (!event.defaultPrevented) {
					if (!hasInteractedOutsideRef.current) context.triggerRef.current?.focus();
					event.preventDefault();
				}
				hasInteractedOutsideRef.current = false;
				hasPointerDownOutsideRef.current = false;
			},
			onInteractOutside: (event) => {
				props.onInteractOutside?.(event);
				if (!event.defaultPrevented) {
					hasInteractedOutsideRef.current = true;
					if (event.detail.originalEvent.type === "pointerdown") hasPointerDownOutsideRef.current = true;
				}
				const target = event.target;
				if (context.triggerRef.current?.contains(target)) event.preventDefault();
				if (event.detail.originalEvent.type === "focusin" && hasPointerDownOutsideRef.current) event.preventDefault();
			}
		});
	});
	var DialogContentImpl = D((props, forwardedRef) => {
		const { __scopeDialog, trapFocus, onOpenAutoFocus, onCloseAutoFocus, ...contentProps } = props;
		const context = useDialogContext(CONTENT_NAME$2, __scopeDialog);
		const contentRef = A$1(null);
		const composedRefs = useComposedRefs(forwardedRef, contentRef);
		useFocusGuards();
		return /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u(FocusScope, {
			asChild: true,
			loop: true,
			trapped: trapFocus,
			onMountAutoFocus: onOpenAutoFocus,
			onUnmountAutoFocus: onCloseAutoFocus,
			children: /* @__PURE__ */ u(DismissableLayer, {
				role: "dialog",
				id: context.contentId,
				"aria-describedby": context.descriptionId,
				"aria-labelledby": context.titleId,
				"data-state": getState(context.open),
				...contentProps,
				ref: composedRefs,
				onDismiss: () => context.onOpenChange(false)
			})
		}), /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u(TitleWarning, { titleId: context.titleId }), /* @__PURE__ */ u(DescriptionWarning, {
			contentRef,
			descriptionId: context.descriptionId
		})] })] });
	});
	var TITLE_NAME = "DialogTitle";
	var DialogTitle = D((props, forwardedRef) => {
		const { __scopeDialog, ...titleProps } = props;
		const context = useDialogContext(TITLE_NAME, __scopeDialog);
		return /* @__PURE__ */ u(Primitive.h2, {
			id: context.titleId,
			...titleProps,
			ref: forwardedRef
		});
	});
	DialogTitle.displayName = TITLE_NAME;
	var DESCRIPTION_NAME = "DialogDescription";
	var DialogDescription = D((props, forwardedRef) => {
		const { __scopeDialog, ...descriptionProps } = props;
		const context = useDialogContext(DESCRIPTION_NAME, __scopeDialog);
		return /* @__PURE__ */ u(Primitive.p, {
			id: context.descriptionId,
			...descriptionProps,
			ref: forwardedRef
		});
	});
	DialogDescription.displayName = DESCRIPTION_NAME;
	var CLOSE_NAME = "DialogClose";
	var DialogClose = D((props, forwardedRef) => {
		const { __scopeDialog, ...closeProps } = props;
		const context = useDialogContext(CLOSE_NAME, __scopeDialog);
		return /* @__PURE__ */ u(Primitive.button, {
			type: "button",
			...closeProps,
			ref: forwardedRef,
			onClick: composeEventHandlers(props.onClick, () => context.onOpenChange(false))
		});
	});
	DialogClose.displayName = CLOSE_NAME;
	function getState(open) {
		return open ? "open" : "closed";
	}
	var TITLE_WARNING_NAME = "DialogTitleWarning";
	var [WarningProvider, useWarningContext] = createContext2(TITLE_WARNING_NAME, {
		contentName: CONTENT_NAME$2,
		titleName: TITLE_NAME,
		docsSlug: "dialog"
	});
	var TitleWarning = ({ titleId }) => {
		const titleWarningContext = useWarningContext(TITLE_WARNING_NAME);
		const MESSAGE = `\`${titleWarningContext.contentName}\` requires a \`${titleWarningContext.titleName}\` for the component to be accessible for screen reader users.

If you want to hide the \`${titleWarningContext.titleName}\`, you can wrap it with our VisuallyHidden component.

For more information, see https://radix-ui.com/primitives/docs/components/${titleWarningContext.docsSlug}`;
		y(() => {
			if (titleId) {
				if (!document.getElementById(titleId)) console.error(MESSAGE);
			}
		}, [MESSAGE, titleId]);
		return null;
	};
	var DESCRIPTION_WARNING_NAME = "DialogDescriptionWarning";
	var DescriptionWarning = ({ contentRef, descriptionId }) => {
		const MESSAGE = `Warning: Missing \`Description\` or \`aria-describedby={undefined}\` for {${useWarningContext(DESCRIPTION_WARNING_NAME).contentName}}.`;
		y(() => {
			const describedById = contentRef.current?.getAttribute("aria-describedby");
			if (descriptionId && describedById) {
				if (!document.getElementById(descriptionId)) console.warn(MESSAGE);
			}
		}, [
			MESSAGE,
			contentRef,
			descriptionId
		]);
		return null;
	};
	var Root$1 = Dialog;
	var Portal$1 = DialogPortal;
	var Overlay = DialogOverlay;
	var Content$1 = DialogContent;
	//#endregion
	//#region src/components/primitives/radix-dialog.tsx
	function RadixDialog({ ariaDescribedby, ariaLabelledby, children, contentClassName, contentId, modal = true, onCloseAutoFocus, onEscapeKeyDown, onInteractOutside, onOpenAutoFocus, onOpenChange, open, overlayClassName, overlayId, slotId }) {
		return /* @__PURE__ */ u(Root$1, {
			modal,
			open,
			onOpenChange,
			children: open ? /* @__PURE__ */ u(Portal$1, { children: [/* @__PURE__ */ u(Overlay, {
				asChild: true,
				children: /* @__PURE__ */ u("div", {
					className: overlayClassName,
					id: overlayId
				})
			}), /* @__PURE__ */ u(Content$1, {
				"aria-describedby": ariaDescribedby,
				"aria-labelledby": ariaLabelledby,
				asChild: true,
				onCloseAutoFocus,
				onEscapeKeyDown,
				onInteractOutside,
				onOpenAutoFocus,
				children: /* @__PURE__ */ u("div", {
					className: contentClassName,
					id: contentId,
					onClick: (event) => {
						if (event.target !== event.currentTarget) return;
						onOpenChange(false);
					},
					tabIndex: -1,
					children: children ?? (slotId ? /* @__PURE__ */ u("div", { id: slotId }) : null)
				})
			})] }) : null
		});
	}
	//#endregion
	//#region src/tabs/sync/sync-dialogs.tsx
	var dialogMount = null;
	var currentRequest = null;
	var resolveDialog = null;
	var setHostRequest = null;
	function fallbackResult(request) {
		if (!request) return null;
		if (request.kind === "confirm") return false;
		if (request.kind === "input") return null;
		return { action: "cancel" };
	}
	function ensureDialogAvailable(requestKind) {
		if (!currentRequest || !resolveDialog) return true;
		console.warn(`Ignored sync ${requestKind} dialog request because another sync dialog is already open.`);
		return false;
	}
	function setRequest(nextRequest) {
		currentRequest = nextRequest;
		setHostRequest?.(nextRequest);
	}
	function resolveCurrentDialog(value) {
		const resolver = resolveDialog;
		resolveDialog = null;
		setRequest(null);
		resolver?.(value);
	}
	function dialogToneClassName(tone) {
		return tone === "danger" ? "sync-dialog-confirm danger" : "sync-dialog-confirm";
	}
	function SyncDialogHost() {
		const [request, setDialogState] = d(currentRequest);
		y(() => {
			setHostRequest = setDialogState;
			return () => {
				if (setHostRequest === setDialogState) setHostRequest = null;
			};
		}, []);
		const open = Boolean(request);
		const titleId = T$1(() => `sync-dialog-title-${request?.kind || "none"}`, [request?.kind]);
		const descriptionId = T$1(() => `sync-dialog-description-${request?.kind || "none"}`, [request?.kind]);
		if (!request) return null;
		const handleOpenChange = (nextOpen) => {
			if (nextOpen) return;
			resolveCurrentDialog(request?.kind === "confirm" ? false : null);
		};
		const handleOpenAutoFocus = (event) => {
			const primary = document.querySelector("#syncDialog [data-sync-primary-action=\"true\"]");
			if (!primary) return;
			event.preventDefault();
			primary.focus();
		};
		return /* @__PURE__ */ u(RadixDialog, {
			ariaDescribedby: descriptionId,
			ariaLabelledby: titleId,
			contentClassName: "modal",
			contentId: "syncDialog",
			onOpenAutoFocus: handleOpenAutoFocus,
			onOpenChange: handleOpenChange,
			open,
			overlayClassName: "modal-backdrop",
			overlayId: "syncDialogBackdrop",
			children: request ? /* @__PURE__ */ u(SyncDialogBody, {
				descriptionId,
				request,
				titleId
			}) : null
		});
	}
	function SyncDialogBody({ descriptionId, request, titleId }) {
		const [inputValue, setInputValue] = d(request.kind === "input" ? request.initialValue || "" : "");
		const [errorText, setErrorText] = d(null);
		const supportsLabels = request.kind !== "duplicate-person";
		const inputErrorId = "syncDialogInputError";
		y(() => {
			if (request.kind === "input") {
				setInputValue(request.initialValue || "");
				setErrorText(null);
			}
		}, [request]);
		const cancelLabel = supportsLabels ? request.cancelLabel || "Cancel" : "Cancel";
		const confirmLabel = supportsLabels ? request.confirmLabel || (request.kind === "confirm" ? "Confirm" : "Save") : "Confirm";
		const submit = () => {
			if (request.kind === "confirm") {
				resolveCurrentDialog(true);
				return;
			}
			if (request.kind === "duplicate-person") return;
			const trimmed = inputValue.trim();
			const validation = request.validate?.(trimmed) || null;
			if (validation) {
				setErrorText(validation);
				return;
			}
			resolveCurrentDialog(trimmed);
		};
		return /* @__PURE__ */ u("div", {
			className: "modal-card sync-dialog-card",
			children: [
				/* @__PURE__ */ u("div", {
					className: "modal-header",
					children: [/* @__PURE__ */ u("h2", {
						id: titleId,
						children: request.title
					}), /* @__PURE__ */ u("button", {
						className: "modal-close",
						onClick: () => resolveCurrentDialog(request.kind === "confirm" ? false : null),
						type: "button",
						children: "close"
					})]
				}),
				/* @__PURE__ */ u("div", {
					className: "modal-body",
					children: [
						request.kind !== "duplicate-person" ? /* @__PURE__ */ u("div", {
							className: "small",
							id: descriptionId,
							children: request.description
						}) : null,
						request.kind === "duplicate-person" ? /* @__PURE__ */ u("div", {
							className: "small",
							id: descriptionId,
							children: request.summary
						}) : null,
						request.kind === "input" ? /* @__PURE__ */ u("div", {
							className: "field",
							children: [/* @__PURE__ */ u("input", {
								"aria-describedby": errorText ? `${descriptionId} ${inputErrorId}` : descriptionId,
								autoFocus: true,
								className: errorText ? "sync-dialog-input sync-field-error" : "sync-dialog-input",
								"data-sync-primary-action": "true",
								onInput: (event) => {
									setInputValue(event.currentTarget.value);
									if (errorText) setErrorText(null);
								},
								onKeyDown: (event) => {
									if (event.key !== "Enter") return;
									event.preventDefault();
									submit();
								},
								placeholder: request.placeholder,
								type: "text",
								value: inputValue
							}), errorText ? /* @__PURE__ */ u("div", {
								className: "sync-field-hint",
								id: inputErrorId,
								children: errorText
							}) : null]
						}) : null,
						request.kind === "duplicate-person" ? /* @__PURE__ */ u(DuplicatePersonDialogContent, {
							descriptionId,
							request
						}) : null
					]
				}),
				/* @__PURE__ */ u("div", {
					className: "modal-footer",
					children: [/* @__PURE__ */ u("div", { className: "small" }), /* @__PURE__ */ u("div", {
						className: "sync-dialog-actions",
						children: [/* @__PURE__ */ u("button", {
							className: "settings-button",
							onClick: () => resolveCurrentDialog(request.kind === "confirm" ? false : null),
							type: "button",
							children: cancelLabel
						}), request.kind !== "duplicate-person" ? /* @__PURE__ */ u("button", {
							autoFocus: true,
							className: `settings-button ${dialogToneClassName(request.kind === "confirm" ? request.tone : void 0)}`,
							"data-sync-primary-action": "true",
							onClick: submit,
							type: "button",
							children: confirmLabel
						}) : null]
					})]
				})
			]
		});
	}
	function DuplicatePersonDialogContent({ descriptionId, request }) {
		const [step, setStep] = d("choice");
		const [primaryActorId, setPrimaryActorId] = d(request.actors.find((actor) => actor.isLocal)?.actorId || request.actors[0]?.actorId || "");
		const [secondaryActorId, setSecondaryActorId] = d("");
		y(() => {
			setStep("choice");
			const nextPrimaryActorId = request.actors.find((actor) => actor.isLocal)?.actorId || request.actors[0]?.actorId || "";
			const nextSecondaryActorId = request.actors.find((actor) => actor.actorId !== nextPrimaryActorId)?.actorId || "";
			setPrimaryActorId(nextPrimaryActorId);
			setSecondaryActorId(nextSecondaryActorId);
		}, [request]);
		const primary = request.actors.find((actor) => actor.actorId === primaryActorId) || request.actors[0];
		const mergeCandidates = request.actors.filter((actor) => actor.actorId !== primaryActorId);
		const secondary = mergeCandidates.find((actor) => actor.actorId === secondaryActorId) || mergeCandidates[0];
		return step === "choice" ? /* @__PURE__ */ u("div", {
			className: "sync-dialog-stack",
			children: /* @__PURE__ */ u("div", {
				className: "sync-dialog-choice-list",
				role: "list",
				children: [
					/* @__PURE__ */ u("button", {
						autoFocus: true,
						className: "settings-button",
						"data-sync-primary-action": "true",
						onClick: () => setStep("merge"),
						type: "button",
						children: "These are both me"
					}),
					/* @__PURE__ */ u("button", {
						className: "settings-button",
						onClick: () => resolveCurrentDialog({ action: "different-people" }),
						type: "button",
						children: "These are different people"
					}),
					/* @__PURE__ */ u("button", {
						className: "settings-button",
						onClick: () => resolveCurrentDialog({ action: "cancel" }),
						type: "button",
						children: "Decide later"
					})
				]
			})
		}) : /* @__PURE__ */ u("div", {
			className: "sync-dialog-stack",
			children: [
				/* @__PURE__ */ u("div", {
					className: "small",
					id: descriptionId,
					children: "Choose which person should remain after combining these duplicates."
				}),
				/* @__PURE__ */ u("div", {
					className: "sync-dialog-radio-list",
					role: "radiogroup",
					"aria-describedby": descriptionId,
					"aria-label": "Person to keep after combining duplicates",
					children: request.actors.map((actor) => /* @__PURE__ */ u("label", {
						className: "sync-dialog-radio-option",
						children: [/* @__PURE__ */ u("input", {
							autoFocus: primaryActorId === actor.actorId,
							checked: primaryActorId === actor.actorId,
							"data-sync-primary-action": primaryActorId === actor.actorId ? "true" : void 0,
							name: "syncDuplicatePrimaryActor",
							onChange: () => setPrimaryActorId(actor.actorId),
							type: "radio",
							value: actor.actorId
						}), /* @__PURE__ */ u("span", { children: [actor.label, actor.isLocal ? " (You)" : ""] })]
					}, actor.actorId))
				}),
				/* @__PURE__ */ u("div", {
					className: "field",
					children: [/* @__PURE__ */ u("label", {
						className: "small",
						htmlFor: "syncDuplicateSecondaryActor",
						children: "Person to combine into the selected record"
					}), /* @__PURE__ */ u("select", {
						className: "sync-dialog-input",
						"data-sync-primary-action": "true",
						id: "syncDuplicateSecondaryActor",
						value: secondary?.actorId || "",
						onChange: (event) => setSecondaryActorId(event.currentTarget.value),
						children: mergeCandidates.map((actor) => /* @__PURE__ */ u("option", {
							value: actor.actorId,
							children: [actor.label, actor.isLocal ? " (You)" : ""]
						}, actor.actorId))
					})]
				}),
				/* @__PURE__ */ u("div", {
					className: "sync-dialog-actions",
					children: [/* @__PURE__ */ u("button", {
						className: "settings-button",
						onClick: () => setStep("choice"),
						type: "button",
						children: "Back"
					}), /* @__PURE__ */ u("button", {
						className: "settings-button",
						disabled: !primary?.actorId || !secondary?.actorId,
						onClick: () => {
							if (!primary?.actorId || !secondary?.actorId) return;
							resolveCurrentDialog({
								action: "merge",
								primaryActorId: primary.actorId,
								secondaryActorId: secondary.actorId
							});
						},
						type: "button",
						children: "Combine people"
					})]
				})
			]
		});
	}
	function ensureSyncDialogHost() {
		if (dialogMount && dialogMount.isConnected) return;
		dialogMount = document.getElementById("syncDialogMount");
		if (!dialogMount) {
			dialogMount = document.createElement("div");
			dialogMount.id = "syncDialogMount";
			document.body.appendChild(dialogMount);
		}
		J$1(/* @__PURE__ */ u(SyncDialogHost, {}), dialogMount);
	}
	function openSyncConfirmDialog(request) {
		ensureSyncDialogHost();
		if (!ensureDialogAvailable("confirm")) return Promise.resolve(false);
		return new Promise((resolve) => {
			resolveDialog = (value) => resolve(Boolean(value));
			setRequest({
				kind: "confirm",
				...request
			});
		});
	}
	function openSyncInputDialog(request) {
		ensureSyncDialogHost();
		if (!ensureDialogAvailable("input")) return Promise.resolve(null);
		return new Promise((resolve) => {
			resolveDialog = (value) => resolve(typeof value === "string" ? value : null);
			setRequest({
				kind: "input",
				...request
			});
		});
	}
	function openDuplicatePersonDialog(request) {
		ensureSyncDialogHost();
		if (!ensureDialogAvailable("duplicate-person")) return Promise.resolve(fallbackResult({
			kind: "duplicate-person",
			...request
		}));
		return new Promise((resolve) => {
			resolveDialog = (value) => resolve(value || { action: "cancel" });
			setRequest({
				kind: "duplicate-person",
				...request
			});
		});
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+number@1.1.1/node_modules/@radix-ui/number/dist/index.mjs
	function clamp$1(value, [min, max]) {
		return Math.min(max, Math.max(min, value));
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-collection@1.1.7_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-collection/dist/index.mjs
	function createCollection(name) {
		const PROVIDER_NAME = name + "CollectionProvider";
		const [createCollectionContext, createCollectionScope] = createContextScope(PROVIDER_NAME);
		const [CollectionProviderImpl, useCollectionContext] = createCollectionContext(PROVIDER_NAME, {
			collectionRef: { current: null },
			itemMap: /* @__PURE__ */ new Map()
		});
		const CollectionProvider = (props) => {
			const { scope, children } = props;
			const ref = gn.useRef(null);
			const itemMap = gn.useRef(/* @__PURE__ */ new Map()).current;
			return /* @__PURE__ */ u(CollectionProviderImpl, {
				scope,
				itemMap,
				collectionRef: ref,
				children
			});
		};
		CollectionProvider.displayName = PROVIDER_NAME;
		const COLLECTION_SLOT_NAME = name + "CollectionSlot";
		const CollectionSlotImpl = /* @__PURE__ */ createSlot(COLLECTION_SLOT_NAME);
		const CollectionSlot = gn.forwardRef((props, forwardedRef) => {
			const { scope, children } = props;
			return /* @__PURE__ */ u(CollectionSlotImpl, {
				ref: useComposedRefs(forwardedRef, useCollectionContext(COLLECTION_SLOT_NAME, scope).collectionRef),
				children
			});
		});
		CollectionSlot.displayName = COLLECTION_SLOT_NAME;
		const ITEM_SLOT_NAME = name + "CollectionItemSlot";
		const ITEM_DATA_ATTR = "data-radix-collection-item";
		const CollectionItemSlotImpl = /* @__PURE__ */ createSlot(ITEM_SLOT_NAME);
		const CollectionItemSlot = gn.forwardRef((props, forwardedRef) => {
			const { scope, children, ...itemData } = props;
			const ref = gn.useRef(null);
			const composedRefs = useComposedRefs(forwardedRef, ref);
			const context = useCollectionContext(ITEM_SLOT_NAME, scope);
			gn.useEffect(() => {
				context.itemMap.set(ref, {
					ref,
					...itemData
				});
				return () => void context.itemMap.delete(ref);
			});
			return /* @__PURE__ */ u(CollectionItemSlotImpl, {
				[ITEM_DATA_ATTR]: "",
				ref: composedRefs,
				children
			});
		});
		CollectionItemSlot.displayName = ITEM_SLOT_NAME;
		function useCollection(scope) {
			const context = useCollectionContext(name + "CollectionConsumer", scope);
			return gn.useCallback(() => {
				const collectionNode = context.collectionRef.current;
				if (!collectionNode) return [];
				const orderedNodes = Array.from(collectionNode.querySelectorAll(`[${ITEM_DATA_ATTR}]`));
				return Array.from(context.itemMap.values()).sort((a, b) => orderedNodes.indexOf(a.ref.current) - orderedNodes.indexOf(b.ref.current));
			}, [context.collectionRef, context.itemMap]);
		}
		return [
			{
				Provider: CollectionProvider,
				Slot: CollectionSlot,
				ItemSlot: CollectionItemSlot
			},
			useCollection,
			createCollectionScope
		];
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-direction@1.1.1_react@19.2.4/node_modules/@radix-ui/react-direction/dist/index.mjs
	var DirectionContext = R$1(void 0);
	function useDirection(localDir) {
		const globalDir = x$1(DirectionContext);
		return localDir || globalDir || "ltr";
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@floating-ui+utils@0.2.11/node_modules/@floating-ui/utils/dist/floating-ui.utils.mjs
	/**
	* Custom positioning reference element.
	* @see https://floating-ui.com/docs/virtual-elements
	*/
	var sides = [
		"top",
		"right",
		"bottom",
		"left"
	];
	var min = Math.min;
	var max = Math.max;
	var round = Math.round;
	var floor = Math.floor;
	var createCoords = (v) => ({
		x: v,
		y: v
	});
	var oppositeSideMap = {
		left: "right",
		right: "left",
		bottom: "top",
		top: "bottom"
	};
	function clamp(start, value, end) {
		return max(start, min(value, end));
	}
	function evaluate(value, param) {
		return typeof value === "function" ? value(param) : value;
	}
	function getSide(placement) {
		return placement.split("-")[0];
	}
	function getAlignment(placement) {
		return placement.split("-")[1];
	}
	function getOppositeAxis(axis) {
		return axis === "x" ? "y" : "x";
	}
	function getAxisLength(axis) {
		return axis === "y" ? "height" : "width";
	}
	function getSideAxis(placement) {
		const firstChar = placement[0];
		return firstChar === "t" || firstChar === "b" ? "y" : "x";
	}
	function getAlignmentAxis(placement) {
		return getOppositeAxis(getSideAxis(placement));
	}
	function getAlignmentSides(placement, rects, rtl) {
		if (rtl === void 0) rtl = false;
		const alignment = getAlignment(placement);
		const alignmentAxis = getAlignmentAxis(placement);
		const length = getAxisLength(alignmentAxis);
		let mainAlignmentSide = alignmentAxis === "x" ? alignment === (rtl ? "end" : "start") ? "right" : "left" : alignment === "start" ? "bottom" : "top";
		if (rects.reference[length] > rects.floating[length]) mainAlignmentSide = getOppositePlacement(mainAlignmentSide);
		return [mainAlignmentSide, getOppositePlacement(mainAlignmentSide)];
	}
	function getExpandedPlacements(placement) {
		const oppositePlacement = getOppositePlacement(placement);
		return [
			getOppositeAlignmentPlacement(placement),
			oppositePlacement,
			getOppositeAlignmentPlacement(oppositePlacement)
		];
	}
	function getOppositeAlignmentPlacement(placement) {
		return placement.includes("start") ? placement.replace("start", "end") : placement.replace("end", "start");
	}
	var lrPlacement = ["left", "right"];
	var rlPlacement = ["right", "left"];
	var tbPlacement = ["top", "bottom"];
	var btPlacement = ["bottom", "top"];
	function getSideList(side, isStart, rtl) {
		switch (side) {
			case "top":
			case "bottom":
				if (rtl) return isStart ? rlPlacement : lrPlacement;
				return isStart ? lrPlacement : rlPlacement;
			case "left":
			case "right": return isStart ? tbPlacement : btPlacement;
			default: return [];
		}
	}
	function getOppositeAxisPlacements(placement, flipAlignment, direction, rtl) {
		const alignment = getAlignment(placement);
		let list = getSideList(getSide(placement), direction === "start", rtl);
		if (alignment) {
			list = list.map((side) => side + "-" + alignment);
			if (flipAlignment) list = list.concat(list.map(getOppositeAlignmentPlacement));
		}
		return list;
	}
	function getOppositePlacement(placement) {
		const side = getSide(placement);
		return oppositeSideMap[side] + placement.slice(side.length);
	}
	function expandPaddingObject(padding) {
		return {
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
			...padding
		};
	}
	function getPaddingObject(padding) {
		return typeof padding !== "number" ? expandPaddingObject(padding) : {
			top: padding,
			right: padding,
			bottom: padding,
			left: padding
		};
	}
	function rectToClientRect(rect) {
		const { x, y, width, height } = rect;
		return {
			width,
			height,
			top: y,
			left: x,
			right: x + width,
			bottom: y + height,
			x,
			y
		};
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@floating-ui+core@1.7.5/node_modules/@floating-ui/core/dist/floating-ui.core.mjs
	function computeCoordsFromPlacement(_ref, placement, rtl) {
		let { reference, floating } = _ref;
		const sideAxis = getSideAxis(placement);
		const alignmentAxis = getAlignmentAxis(placement);
		const alignLength = getAxisLength(alignmentAxis);
		const side = getSide(placement);
		const isVertical = sideAxis === "y";
		const commonX = reference.x + reference.width / 2 - floating.width / 2;
		const commonY = reference.y + reference.height / 2 - floating.height / 2;
		const commonAlign = reference[alignLength] / 2 - floating[alignLength] / 2;
		let coords;
		switch (side) {
			case "top":
				coords = {
					x: commonX,
					y: reference.y - floating.height
				};
				break;
			case "bottom":
				coords = {
					x: commonX,
					y: reference.y + reference.height
				};
				break;
			case "right":
				coords = {
					x: reference.x + reference.width,
					y: commonY
				};
				break;
			case "left":
				coords = {
					x: reference.x - floating.width,
					y: commonY
				};
				break;
			default: coords = {
				x: reference.x,
				y: reference.y
			};
		}
		switch (getAlignment(placement)) {
			case "start":
				coords[alignmentAxis] -= commonAlign * (rtl && isVertical ? -1 : 1);
				break;
			case "end":
				coords[alignmentAxis] += commonAlign * (rtl && isVertical ? -1 : 1);
				break;
		}
		return coords;
	}
	/**
	* Resolves with an object of overflow side offsets that determine how much the
	* element is overflowing a given clipping boundary on each side.
	* - positive = overflowing the boundary by that number of pixels
	* - negative = how many pixels left before it will overflow
	* - 0 = lies flush with the boundary
	* @see https://floating-ui.com/docs/detectOverflow
	*/
	async function detectOverflow(state, options) {
		var _await$platform$isEle;
		if (options === void 0) options = {};
		const { x, y, platform, rects, elements, strategy } = state;
		const { boundary = "clippingAncestors", rootBoundary = "viewport", elementContext = "floating", altBoundary = false, padding = 0 } = evaluate(options, state);
		const paddingObject = getPaddingObject(padding);
		const element = elements[altBoundary ? elementContext === "floating" ? "reference" : "floating" : elementContext];
		const clippingClientRect = rectToClientRect(await platform.getClippingRect({
			element: ((_await$platform$isEle = await (platform.isElement == null ? void 0 : platform.isElement(element))) != null ? _await$platform$isEle : true) ? element : element.contextElement || await (platform.getDocumentElement == null ? void 0 : platform.getDocumentElement(elements.floating)),
			boundary,
			rootBoundary,
			strategy
		}));
		const rect = elementContext === "floating" ? {
			x,
			y,
			width: rects.floating.width,
			height: rects.floating.height
		} : rects.reference;
		const offsetParent = await (platform.getOffsetParent == null ? void 0 : platform.getOffsetParent(elements.floating));
		const offsetScale = await (platform.isElement == null ? void 0 : platform.isElement(offsetParent)) ? await (platform.getScale == null ? void 0 : platform.getScale(offsetParent)) || {
			x: 1,
			y: 1
		} : {
			x: 1,
			y: 1
		};
		const elementClientRect = rectToClientRect(platform.convertOffsetParentRelativeRectToViewportRelativeRect ? await platform.convertOffsetParentRelativeRectToViewportRelativeRect({
			elements,
			rect,
			offsetParent,
			strategy
		}) : rect);
		return {
			top: (clippingClientRect.top - elementClientRect.top + paddingObject.top) / offsetScale.y,
			bottom: (elementClientRect.bottom - clippingClientRect.bottom + paddingObject.bottom) / offsetScale.y,
			left: (clippingClientRect.left - elementClientRect.left + paddingObject.left) / offsetScale.x,
			right: (elementClientRect.right - clippingClientRect.right + paddingObject.right) / offsetScale.x
		};
	}
	var MAX_RESET_COUNT = 50;
	/**
	* Computes the `x` and `y` coordinates that will place the floating element
	* next to a given reference element.
	*
	* This export does not have any `platform` interface logic. You will need to
	* write one for the platform you are using Floating UI with.
	*/
	var computePosition$1 = async (reference, floating, config) => {
		const { placement = "bottom", strategy = "absolute", middleware = [], platform } = config;
		const platformWithDetectOverflow = platform.detectOverflow ? platform : {
			...platform,
			detectOverflow
		};
		const rtl = await (platform.isRTL == null ? void 0 : platform.isRTL(floating));
		let rects = await platform.getElementRects({
			reference,
			floating,
			strategy
		});
		let { x, y } = computeCoordsFromPlacement(rects, placement, rtl);
		let statefulPlacement = placement;
		let resetCount = 0;
		const middlewareData = {};
		for (let i = 0; i < middleware.length; i++) {
			const currentMiddleware = middleware[i];
			if (!currentMiddleware) continue;
			const { name, fn } = currentMiddleware;
			const { x: nextX, y: nextY, data, reset } = await fn({
				x,
				y,
				initialPlacement: placement,
				placement: statefulPlacement,
				strategy,
				middlewareData,
				rects,
				platform: platformWithDetectOverflow,
				elements: {
					reference,
					floating
				}
			});
			x = nextX != null ? nextX : x;
			y = nextY != null ? nextY : y;
			middlewareData[name] = {
				...middlewareData[name],
				...data
			};
			if (reset && resetCount < MAX_RESET_COUNT) {
				resetCount++;
				if (typeof reset === "object") {
					if (reset.placement) statefulPlacement = reset.placement;
					if (reset.rects) rects = reset.rects === true ? await platform.getElementRects({
						reference,
						floating,
						strategy
					}) : reset.rects;
					({x, y} = computeCoordsFromPlacement(rects, statefulPlacement, rtl));
				}
				i = -1;
			}
		}
		return {
			x,
			y,
			placement: statefulPlacement,
			strategy,
			middlewareData
		};
	};
	/**
	* Provides data to position an inner element of the floating element so that it
	* appears centered to the reference element.
	* @see https://floating-ui.com/docs/arrow
	*/
	var arrow$3 = (options) => ({
		name: "arrow",
		options,
		async fn(state) {
			const { x, y, placement, rects, platform, elements, middlewareData } = state;
			const { element, padding = 0 } = evaluate(options, state) || {};
			if (element == null) return {};
			const paddingObject = getPaddingObject(padding);
			const coords = {
				x,
				y
			};
			const axis = getAlignmentAxis(placement);
			const length = getAxisLength(axis);
			const arrowDimensions = await platform.getDimensions(element);
			const isYAxis = axis === "y";
			const minProp = isYAxis ? "top" : "left";
			const maxProp = isYAxis ? "bottom" : "right";
			const clientProp = isYAxis ? "clientHeight" : "clientWidth";
			const endDiff = rects.reference[length] + rects.reference[axis] - coords[axis] - rects.floating[length];
			const startDiff = coords[axis] - rects.reference[axis];
			const arrowOffsetParent = await (platform.getOffsetParent == null ? void 0 : platform.getOffsetParent(element));
			let clientSize = arrowOffsetParent ? arrowOffsetParent[clientProp] : 0;
			if (!clientSize || !await (platform.isElement == null ? void 0 : platform.isElement(arrowOffsetParent))) clientSize = elements.floating[clientProp] || rects.floating[length];
			const centerToReference = endDiff / 2 - startDiff / 2;
			const largestPossiblePadding = clientSize / 2 - arrowDimensions[length] / 2 - 1;
			const minPadding = min(paddingObject[minProp], largestPossiblePadding);
			const maxPadding = min(paddingObject[maxProp], largestPossiblePadding);
			const min$1 = minPadding;
			const max = clientSize - arrowDimensions[length] - maxPadding;
			const center = clientSize / 2 - arrowDimensions[length] / 2 + centerToReference;
			const offset = clamp(min$1, center, max);
			const shouldAddOffset = !middlewareData.arrow && getAlignment(placement) != null && center !== offset && rects.reference[length] / 2 - (center < min$1 ? minPadding : maxPadding) - arrowDimensions[length] / 2 < 0;
			const alignmentOffset = shouldAddOffset ? center < min$1 ? center - min$1 : center - max : 0;
			return {
				[axis]: coords[axis] + alignmentOffset,
				data: {
					[axis]: offset,
					centerOffset: center - offset - alignmentOffset,
					...shouldAddOffset && { alignmentOffset }
				},
				reset: shouldAddOffset
			};
		}
	});
	/**
	* Optimizes the visibility of the floating element by flipping the `placement`
	* in order to keep it in view when the preferred placement(s) will overflow the
	* clipping boundary. Alternative to `autoPlacement`.
	* @see https://floating-ui.com/docs/flip
	*/
	var flip$2 = function(options) {
		if (options === void 0) options = {};
		return {
			name: "flip",
			options,
			async fn(state) {
				var _middlewareData$arrow, _middlewareData$flip;
				const { placement, middlewareData, rects, initialPlacement, platform, elements } = state;
				const { mainAxis: checkMainAxis = true, crossAxis: checkCrossAxis = true, fallbackPlacements: specifiedFallbackPlacements, fallbackStrategy = "bestFit", fallbackAxisSideDirection = "none", flipAlignment = true, ...detectOverflowOptions } = evaluate(options, state);
				if ((_middlewareData$arrow = middlewareData.arrow) != null && _middlewareData$arrow.alignmentOffset) return {};
				const side = getSide(placement);
				const initialSideAxis = getSideAxis(initialPlacement);
				const isBasePlacement = getSide(initialPlacement) === initialPlacement;
				const rtl = await (platform.isRTL == null ? void 0 : platform.isRTL(elements.floating));
				const fallbackPlacements = specifiedFallbackPlacements || (isBasePlacement || !flipAlignment ? [getOppositePlacement(initialPlacement)] : getExpandedPlacements(initialPlacement));
				const hasFallbackAxisSideDirection = fallbackAxisSideDirection !== "none";
				if (!specifiedFallbackPlacements && hasFallbackAxisSideDirection) fallbackPlacements.push(...getOppositeAxisPlacements(initialPlacement, flipAlignment, fallbackAxisSideDirection, rtl));
				const placements = [initialPlacement, ...fallbackPlacements];
				const overflow = await platform.detectOverflow(state, detectOverflowOptions);
				const overflows = [];
				let overflowsData = ((_middlewareData$flip = middlewareData.flip) == null ? void 0 : _middlewareData$flip.overflows) || [];
				if (checkMainAxis) overflows.push(overflow[side]);
				if (checkCrossAxis) {
					const sides = getAlignmentSides(placement, rects, rtl);
					overflows.push(overflow[sides[0]], overflow[sides[1]]);
				}
				overflowsData = [...overflowsData, {
					placement,
					overflows
				}];
				if (!overflows.every((side) => side <= 0)) {
					var _middlewareData$flip2, _overflowsData$filter;
					const nextIndex = (((_middlewareData$flip2 = middlewareData.flip) == null ? void 0 : _middlewareData$flip2.index) || 0) + 1;
					const nextPlacement = placements[nextIndex];
					if (nextPlacement) {
						if (!(checkCrossAxis === "alignment" ? initialSideAxis !== getSideAxis(nextPlacement) : false) || overflowsData.every((d) => getSideAxis(d.placement) === initialSideAxis ? d.overflows[0] > 0 : true)) return {
							data: {
								index: nextIndex,
								overflows: overflowsData
							},
							reset: { placement: nextPlacement }
						};
					}
					let resetPlacement = (_overflowsData$filter = overflowsData.filter((d) => d.overflows[0] <= 0).sort((a, b) => a.overflows[1] - b.overflows[1])[0]) == null ? void 0 : _overflowsData$filter.placement;
					if (!resetPlacement) switch (fallbackStrategy) {
						case "bestFit": {
							var _overflowsData$filter2;
							const placement = (_overflowsData$filter2 = overflowsData.filter((d) => {
								if (hasFallbackAxisSideDirection) {
									const currentSideAxis = getSideAxis(d.placement);
									return currentSideAxis === initialSideAxis || currentSideAxis === "y";
								}
								return true;
							}).map((d) => [d.placement, d.overflows.filter((overflow) => overflow > 0).reduce((acc, overflow) => acc + overflow, 0)]).sort((a, b) => a[1] - b[1])[0]) == null ? void 0 : _overflowsData$filter2[0];
							if (placement) resetPlacement = placement;
							break;
						}
						case "initialPlacement":
							resetPlacement = initialPlacement;
							break;
					}
					if (placement !== resetPlacement) return { reset: { placement: resetPlacement } };
				}
				return {};
			}
		};
	};
	function getSideOffsets(overflow, rect) {
		return {
			top: overflow.top - rect.height,
			right: overflow.right - rect.width,
			bottom: overflow.bottom - rect.height,
			left: overflow.left - rect.width
		};
	}
	function isAnySideFullyClipped(overflow) {
		return sides.some((side) => overflow[side] >= 0);
	}
	/**
	* Provides data to hide the floating element in applicable situations, such as
	* when it is not in the same clipping context as the reference element.
	* @see https://floating-ui.com/docs/hide
	*/
	var hide$2 = function(options) {
		if (options === void 0) options = {};
		return {
			name: "hide",
			options,
			async fn(state) {
				const { rects, platform } = state;
				const { strategy = "referenceHidden", ...detectOverflowOptions } = evaluate(options, state);
				switch (strategy) {
					case "referenceHidden": {
						const offsets = getSideOffsets(await platform.detectOverflow(state, {
							...detectOverflowOptions,
							elementContext: "reference"
						}), rects.reference);
						return { data: {
							referenceHiddenOffsets: offsets,
							referenceHidden: isAnySideFullyClipped(offsets)
						} };
					}
					case "escaped": {
						const offsets = getSideOffsets(await platform.detectOverflow(state, {
							...detectOverflowOptions,
							altBoundary: true
						}), rects.floating);
						return { data: {
							escapedOffsets: offsets,
							escaped: isAnySideFullyClipped(offsets)
						} };
					}
					default: return {};
				}
			}
		};
	};
	var originSides = /* @__PURE__ */ new Set(["left", "top"]);
	async function convertValueToCoords(state, options) {
		const { placement, platform, elements } = state;
		const rtl = await (platform.isRTL == null ? void 0 : platform.isRTL(elements.floating));
		const side = getSide(placement);
		const alignment = getAlignment(placement);
		const isVertical = getSideAxis(placement) === "y";
		const mainAxisMulti = originSides.has(side) ? -1 : 1;
		const crossAxisMulti = rtl && isVertical ? -1 : 1;
		const rawValue = evaluate(options, state);
		let { mainAxis, crossAxis, alignmentAxis } = typeof rawValue === "number" ? {
			mainAxis: rawValue,
			crossAxis: 0,
			alignmentAxis: null
		} : {
			mainAxis: rawValue.mainAxis || 0,
			crossAxis: rawValue.crossAxis || 0,
			alignmentAxis: rawValue.alignmentAxis
		};
		if (alignment && typeof alignmentAxis === "number") crossAxis = alignment === "end" ? alignmentAxis * -1 : alignmentAxis;
		return isVertical ? {
			x: crossAxis * crossAxisMulti,
			y: mainAxis * mainAxisMulti
		} : {
			x: mainAxis * mainAxisMulti,
			y: crossAxis * crossAxisMulti
		};
	}
	/**
	* Modifies the placement by translating the floating element along the
	* specified axes.
	* A number (shorthand for `mainAxis` or distance), or an axes configuration
	* object may be passed.
	* @see https://floating-ui.com/docs/offset
	*/
	var offset$2 = function(options) {
		if (options === void 0) options = 0;
		return {
			name: "offset",
			options,
			async fn(state) {
				var _middlewareData$offse, _middlewareData$arrow;
				const { x, y, placement, middlewareData } = state;
				const diffCoords = await convertValueToCoords(state, options);
				if (placement === ((_middlewareData$offse = middlewareData.offset) == null ? void 0 : _middlewareData$offse.placement) && (_middlewareData$arrow = middlewareData.arrow) != null && _middlewareData$arrow.alignmentOffset) return {};
				return {
					x: x + diffCoords.x,
					y: y + diffCoords.y,
					data: {
						...diffCoords,
						placement
					}
				};
			}
		};
	};
	/**
	* Optimizes the visibility of the floating element by shifting it in order to
	* keep it in view when it will overflow the clipping boundary.
	* @see https://floating-ui.com/docs/shift
	*/
	var shift$2 = function(options) {
		if (options === void 0) options = {};
		return {
			name: "shift",
			options,
			async fn(state) {
				const { x, y, placement, platform } = state;
				const { mainAxis: checkMainAxis = true, crossAxis: checkCrossAxis = false, limiter = { fn: (_ref) => {
					let { x, y } = _ref;
					return {
						x,
						y
					};
				} }, ...detectOverflowOptions } = evaluate(options, state);
				const coords = {
					x,
					y
				};
				const overflow = await platform.detectOverflow(state, detectOverflowOptions);
				const crossAxis = getSideAxis(getSide(placement));
				const mainAxis = getOppositeAxis(crossAxis);
				let mainAxisCoord = coords[mainAxis];
				let crossAxisCoord = coords[crossAxis];
				if (checkMainAxis) {
					const minSide = mainAxis === "y" ? "top" : "left";
					const maxSide = mainAxis === "y" ? "bottom" : "right";
					const min = mainAxisCoord + overflow[minSide];
					const max = mainAxisCoord - overflow[maxSide];
					mainAxisCoord = clamp(min, mainAxisCoord, max);
				}
				if (checkCrossAxis) {
					const minSide = crossAxis === "y" ? "top" : "left";
					const maxSide = crossAxis === "y" ? "bottom" : "right";
					const min = crossAxisCoord + overflow[minSide];
					const max = crossAxisCoord - overflow[maxSide];
					crossAxisCoord = clamp(min, crossAxisCoord, max);
				}
				const limitedCoords = limiter.fn({
					...state,
					[mainAxis]: mainAxisCoord,
					[crossAxis]: crossAxisCoord
				});
				return {
					...limitedCoords,
					data: {
						x: limitedCoords.x - x,
						y: limitedCoords.y - y,
						enabled: {
							[mainAxis]: checkMainAxis,
							[crossAxis]: checkCrossAxis
						}
					}
				};
			}
		};
	};
	/**
	* Built-in `limiter` that will stop `shift()` at a certain point.
	*/
	var limitShift$2 = function(options) {
		if (options === void 0) options = {};
		return {
			options,
			fn(state) {
				const { x, y, placement, rects, middlewareData } = state;
				const { offset = 0, mainAxis: checkMainAxis = true, crossAxis: checkCrossAxis = true } = evaluate(options, state);
				const coords = {
					x,
					y
				};
				const crossAxis = getSideAxis(placement);
				const mainAxis = getOppositeAxis(crossAxis);
				let mainAxisCoord = coords[mainAxis];
				let crossAxisCoord = coords[crossAxis];
				const rawOffset = evaluate(offset, state);
				const computedOffset = typeof rawOffset === "number" ? {
					mainAxis: rawOffset,
					crossAxis: 0
				} : {
					mainAxis: 0,
					crossAxis: 0,
					...rawOffset
				};
				if (checkMainAxis) {
					const len = mainAxis === "y" ? "height" : "width";
					const limitMin = rects.reference[mainAxis] - rects.floating[len] + computedOffset.mainAxis;
					const limitMax = rects.reference[mainAxis] + rects.reference[len] - computedOffset.mainAxis;
					if (mainAxisCoord < limitMin) mainAxisCoord = limitMin;
					else if (mainAxisCoord > limitMax) mainAxisCoord = limitMax;
				}
				if (checkCrossAxis) {
					var _middlewareData$offse, _middlewareData$offse2;
					const len = mainAxis === "y" ? "width" : "height";
					const isOriginSide = originSides.has(getSide(placement));
					const limitMin = rects.reference[crossAxis] - rects.floating[len] + (isOriginSide ? ((_middlewareData$offse = middlewareData.offset) == null ? void 0 : _middlewareData$offse[crossAxis]) || 0 : 0) + (isOriginSide ? 0 : computedOffset.crossAxis);
					const limitMax = rects.reference[crossAxis] + rects.reference[len] + (isOriginSide ? 0 : ((_middlewareData$offse2 = middlewareData.offset) == null ? void 0 : _middlewareData$offse2[crossAxis]) || 0) - (isOriginSide ? computedOffset.crossAxis : 0);
					if (crossAxisCoord < limitMin) crossAxisCoord = limitMin;
					else if (crossAxisCoord > limitMax) crossAxisCoord = limitMax;
				}
				return {
					[mainAxis]: mainAxisCoord,
					[crossAxis]: crossAxisCoord
				};
			}
		};
	};
	/**
	* Provides data that allows you to change the size of the floating element —
	* for instance, prevent it from overflowing the clipping boundary or match the
	* width of the reference element.
	* @see https://floating-ui.com/docs/size
	*/
	var size$2 = function(options) {
		if (options === void 0) options = {};
		return {
			name: "size",
			options,
			async fn(state) {
				var _state$middlewareData, _state$middlewareData2;
				const { placement, rects, platform, elements } = state;
				const { apply = () => {}, ...detectOverflowOptions } = evaluate(options, state);
				const overflow = await platform.detectOverflow(state, detectOverflowOptions);
				const side = getSide(placement);
				const alignment = getAlignment(placement);
				const isYAxis = getSideAxis(placement) === "y";
				const { width, height } = rects.floating;
				let heightSide;
				let widthSide;
				if (side === "top" || side === "bottom") {
					heightSide = side;
					widthSide = alignment === (await (platform.isRTL == null ? void 0 : platform.isRTL(elements.floating)) ? "start" : "end") ? "left" : "right";
				} else {
					widthSide = side;
					heightSide = alignment === "end" ? "top" : "bottom";
				}
				const maximumClippingHeight = height - overflow.top - overflow.bottom;
				const maximumClippingWidth = width - overflow.left - overflow.right;
				const overflowAvailableHeight = min(height - overflow[heightSide], maximumClippingHeight);
				const overflowAvailableWidth = min(width - overflow[widthSide], maximumClippingWidth);
				const noShift = !state.middlewareData.shift;
				let availableHeight = overflowAvailableHeight;
				let availableWidth = overflowAvailableWidth;
				if ((_state$middlewareData = state.middlewareData.shift) != null && _state$middlewareData.enabled.x) availableWidth = maximumClippingWidth;
				if ((_state$middlewareData2 = state.middlewareData.shift) != null && _state$middlewareData2.enabled.y) availableHeight = maximumClippingHeight;
				if (noShift && !alignment) {
					const xMin = max(overflow.left, 0);
					const xMax = max(overflow.right, 0);
					const yMin = max(overflow.top, 0);
					const yMax = max(overflow.bottom, 0);
					if (isYAxis) availableWidth = width - 2 * (xMin !== 0 || xMax !== 0 ? xMin + xMax : max(overflow.left, overflow.right));
					else availableHeight = height - 2 * (yMin !== 0 || yMax !== 0 ? yMin + yMax : max(overflow.top, overflow.bottom));
				}
				await apply({
					...state,
					availableWidth,
					availableHeight
				});
				const nextDimensions = await platform.getDimensions(elements.floating);
				if (width !== nextDimensions.width || height !== nextDimensions.height) return { reset: { rects: true } };
				return {};
			}
		};
	};
	//#endregion
	//#region ../../node_modules/.pnpm/@floating-ui+utils@0.2.11/node_modules/@floating-ui/utils/dist/floating-ui.utils.dom.mjs
	function hasWindow() {
		return typeof window !== "undefined";
	}
	function getNodeName(node) {
		if (isNode(node)) return (node.nodeName || "").toLowerCase();
		return "#document";
	}
	function getWindow(node) {
		var _node$ownerDocument;
		return (node == null || (_node$ownerDocument = node.ownerDocument) == null ? void 0 : _node$ownerDocument.defaultView) || window;
	}
	function getDocumentElement(node) {
		var _ref;
		return (_ref = (isNode(node) ? node.ownerDocument : node.document) || window.document) == null ? void 0 : _ref.documentElement;
	}
	function isNode(value) {
		if (!hasWindow()) return false;
		return value instanceof Node || value instanceof getWindow(value).Node;
	}
	function isElement(value) {
		if (!hasWindow()) return false;
		return value instanceof Element || value instanceof getWindow(value).Element;
	}
	function isHTMLElement(value) {
		if (!hasWindow()) return false;
		return value instanceof HTMLElement || value instanceof getWindow(value).HTMLElement;
	}
	function isShadowRoot(value) {
		if (!hasWindow() || typeof ShadowRoot === "undefined") return false;
		return value instanceof ShadowRoot || value instanceof getWindow(value).ShadowRoot;
	}
	function isOverflowElement(element) {
		const { overflow, overflowX, overflowY, display } = getComputedStyle$1(element);
		return /auto|scroll|overlay|hidden|clip/.test(overflow + overflowY + overflowX) && display !== "inline" && display !== "contents";
	}
	function isTableElement(element) {
		return /^(table|td|th)$/.test(getNodeName(element));
	}
	function isTopLayer(element) {
		try {
			if (element.matches(":popover-open")) return true;
		} catch (_e) {}
		try {
			return element.matches(":modal");
		} catch (_e) {
			return false;
		}
	}
	var willChangeRe = /transform|translate|scale|rotate|perspective|filter/;
	var containRe = /paint|layout|strict|content/;
	var isNotNone = (value) => !!value && value !== "none";
	var isWebKitValue;
	function isContainingBlock(elementOrCss) {
		const css = isElement(elementOrCss) ? getComputedStyle$1(elementOrCss) : elementOrCss;
		return isNotNone(css.transform) || isNotNone(css.translate) || isNotNone(css.scale) || isNotNone(css.rotate) || isNotNone(css.perspective) || !isWebKit() && (isNotNone(css.backdropFilter) || isNotNone(css.filter)) || willChangeRe.test(css.willChange || "") || containRe.test(css.contain || "");
	}
	function getContainingBlock(element) {
		let currentNode = getParentNode(element);
		while (isHTMLElement(currentNode) && !isLastTraversableNode(currentNode)) {
			if (isContainingBlock(currentNode)) return currentNode;
			else if (isTopLayer(currentNode)) return null;
			currentNode = getParentNode(currentNode);
		}
		return null;
	}
	function isWebKit() {
		if (isWebKitValue == null) isWebKitValue = typeof CSS !== "undefined" && CSS.supports && CSS.supports("-webkit-backdrop-filter", "none");
		return isWebKitValue;
	}
	function isLastTraversableNode(node) {
		return /^(html|body|#document)$/.test(getNodeName(node));
	}
	function getComputedStyle$1(element) {
		return getWindow(element).getComputedStyle(element);
	}
	function getNodeScroll(element) {
		if (isElement(element)) return {
			scrollLeft: element.scrollLeft,
			scrollTop: element.scrollTop
		};
		return {
			scrollLeft: element.scrollX,
			scrollTop: element.scrollY
		};
	}
	function getParentNode(node) {
		if (getNodeName(node) === "html") return node;
		const result = node.assignedSlot || node.parentNode || isShadowRoot(node) && node.host || getDocumentElement(node);
		return isShadowRoot(result) ? result.host : result;
	}
	function getNearestOverflowAncestor(node) {
		const parentNode = getParentNode(node);
		if (isLastTraversableNode(parentNode)) return node.ownerDocument ? node.ownerDocument.body : node.body;
		if (isHTMLElement(parentNode) && isOverflowElement(parentNode)) return parentNode;
		return getNearestOverflowAncestor(parentNode);
	}
	function getOverflowAncestors(node, list, traverseIframes) {
		var _node$ownerDocument2;
		if (list === void 0) list = [];
		if (traverseIframes === void 0) traverseIframes = true;
		const scrollableAncestor = getNearestOverflowAncestor(node);
		const isBody = scrollableAncestor === ((_node$ownerDocument2 = node.ownerDocument) == null ? void 0 : _node$ownerDocument2.body);
		const win = getWindow(scrollableAncestor);
		if (isBody) {
			const frameElement = getFrameElement(win);
			return list.concat(win, win.visualViewport || [], isOverflowElement(scrollableAncestor) ? scrollableAncestor : [], frameElement && traverseIframes ? getOverflowAncestors(frameElement) : []);
		} else return list.concat(scrollableAncestor, getOverflowAncestors(scrollableAncestor, [], traverseIframes));
	}
	function getFrameElement(win) {
		return win.parent && Object.getPrototypeOf(win.parent) ? win.frameElement : null;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@floating-ui+dom@1.7.6/node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs
	function getCssDimensions(element) {
		const css = getComputedStyle$1(element);
		let width = parseFloat(css.width) || 0;
		let height = parseFloat(css.height) || 0;
		const hasOffset = isHTMLElement(element);
		const offsetWidth = hasOffset ? element.offsetWidth : width;
		const offsetHeight = hasOffset ? element.offsetHeight : height;
		const shouldFallback = round(width) !== offsetWidth || round(height) !== offsetHeight;
		if (shouldFallback) {
			width = offsetWidth;
			height = offsetHeight;
		}
		return {
			width,
			height,
			$: shouldFallback
		};
	}
	function unwrapElement(element) {
		return !isElement(element) ? element.contextElement : element;
	}
	function getScale(element) {
		const domElement = unwrapElement(element);
		if (!isHTMLElement(domElement)) return createCoords(1);
		const rect = domElement.getBoundingClientRect();
		const { width, height, $ } = getCssDimensions(domElement);
		let x = ($ ? round(rect.width) : rect.width) / width;
		let y = ($ ? round(rect.height) : rect.height) / height;
		if (!x || !Number.isFinite(x)) x = 1;
		if (!y || !Number.isFinite(y)) y = 1;
		return {
			x,
			y
		};
	}
	var noOffsets = /* @__PURE__ */ createCoords(0);
	function getVisualOffsets(element) {
		const win = getWindow(element);
		if (!isWebKit() || !win.visualViewport) return noOffsets;
		return {
			x: win.visualViewport.offsetLeft,
			y: win.visualViewport.offsetTop
		};
	}
	function shouldAddVisualOffsets(element, isFixed, floatingOffsetParent) {
		if (isFixed === void 0) isFixed = false;
		if (!floatingOffsetParent || isFixed && floatingOffsetParent !== getWindow(element)) return false;
		return isFixed;
	}
	function getBoundingClientRect(element, includeScale, isFixedStrategy, offsetParent) {
		if (includeScale === void 0) includeScale = false;
		if (isFixedStrategy === void 0) isFixedStrategy = false;
		const clientRect = element.getBoundingClientRect();
		const domElement = unwrapElement(element);
		let scale = createCoords(1);
		if (includeScale) if (offsetParent) {
			if (isElement(offsetParent)) scale = getScale(offsetParent);
		} else scale = getScale(element);
		const visualOffsets = shouldAddVisualOffsets(domElement, isFixedStrategy, offsetParent) ? getVisualOffsets(domElement) : createCoords(0);
		let x = (clientRect.left + visualOffsets.x) / scale.x;
		let y = (clientRect.top + visualOffsets.y) / scale.y;
		let width = clientRect.width / scale.x;
		let height = clientRect.height / scale.y;
		if (domElement) {
			const win = getWindow(domElement);
			const offsetWin = offsetParent && isElement(offsetParent) ? getWindow(offsetParent) : offsetParent;
			let currentWin = win;
			let currentIFrame = getFrameElement(currentWin);
			while (currentIFrame && offsetParent && offsetWin !== currentWin) {
				const iframeScale = getScale(currentIFrame);
				const iframeRect = currentIFrame.getBoundingClientRect();
				const css = getComputedStyle$1(currentIFrame);
				const left = iframeRect.left + (currentIFrame.clientLeft + parseFloat(css.paddingLeft)) * iframeScale.x;
				const top = iframeRect.top + (currentIFrame.clientTop + parseFloat(css.paddingTop)) * iframeScale.y;
				x *= iframeScale.x;
				y *= iframeScale.y;
				width *= iframeScale.x;
				height *= iframeScale.y;
				x += left;
				y += top;
				currentWin = getWindow(currentIFrame);
				currentIFrame = getFrameElement(currentWin);
			}
		}
		return rectToClientRect({
			width,
			height,
			x,
			y
		});
	}
	function getWindowScrollBarX(element, rect) {
		const leftScroll = getNodeScroll(element).scrollLeft;
		if (!rect) return getBoundingClientRect(getDocumentElement(element)).left + leftScroll;
		return rect.left + leftScroll;
	}
	function getHTMLOffset(documentElement, scroll) {
		const htmlRect = documentElement.getBoundingClientRect();
		return {
			x: htmlRect.left + scroll.scrollLeft - getWindowScrollBarX(documentElement, htmlRect),
			y: htmlRect.top + scroll.scrollTop
		};
	}
	function convertOffsetParentRelativeRectToViewportRelativeRect(_ref) {
		let { elements, rect, offsetParent, strategy } = _ref;
		const isFixed = strategy === "fixed";
		const documentElement = getDocumentElement(offsetParent);
		const topLayer = elements ? isTopLayer(elements.floating) : false;
		if (offsetParent === documentElement || topLayer && isFixed) return rect;
		let scroll = {
			scrollLeft: 0,
			scrollTop: 0
		};
		let scale = createCoords(1);
		const offsets = createCoords(0);
		const isOffsetParentAnElement = isHTMLElement(offsetParent);
		if (isOffsetParentAnElement || !isOffsetParentAnElement && !isFixed) {
			if (getNodeName(offsetParent) !== "body" || isOverflowElement(documentElement)) scroll = getNodeScroll(offsetParent);
			if (isOffsetParentAnElement) {
				const offsetRect = getBoundingClientRect(offsetParent);
				scale = getScale(offsetParent);
				offsets.x = offsetRect.x + offsetParent.clientLeft;
				offsets.y = offsetRect.y + offsetParent.clientTop;
			}
		}
		const htmlOffset = documentElement && !isOffsetParentAnElement && !isFixed ? getHTMLOffset(documentElement, scroll) : createCoords(0);
		return {
			width: rect.width * scale.x,
			height: rect.height * scale.y,
			x: rect.x * scale.x - scroll.scrollLeft * scale.x + offsets.x + htmlOffset.x,
			y: rect.y * scale.y - scroll.scrollTop * scale.y + offsets.y + htmlOffset.y
		};
	}
	function getClientRects(element) {
		return Array.from(element.getClientRects());
	}
	function getDocumentRect(element) {
		const html = getDocumentElement(element);
		const scroll = getNodeScroll(element);
		const body = element.ownerDocument.body;
		const width = max(html.scrollWidth, html.clientWidth, body.scrollWidth, body.clientWidth);
		const height = max(html.scrollHeight, html.clientHeight, body.scrollHeight, body.clientHeight);
		let x = -scroll.scrollLeft + getWindowScrollBarX(element);
		const y = -scroll.scrollTop;
		if (getComputedStyle$1(body).direction === "rtl") x += max(html.clientWidth, body.clientWidth) - width;
		return {
			width,
			height,
			x,
			y
		};
	}
	var SCROLLBAR_MAX = 25;
	function getViewportRect(element, strategy) {
		const win = getWindow(element);
		const html = getDocumentElement(element);
		const visualViewport = win.visualViewport;
		let width = html.clientWidth;
		let height = html.clientHeight;
		let x = 0;
		let y = 0;
		if (visualViewport) {
			width = visualViewport.width;
			height = visualViewport.height;
			const visualViewportBased = isWebKit();
			if (!visualViewportBased || visualViewportBased && strategy === "fixed") {
				x = visualViewport.offsetLeft;
				y = visualViewport.offsetTop;
			}
		}
		const windowScrollbarX = getWindowScrollBarX(html);
		if (windowScrollbarX <= 0) {
			const doc = html.ownerDocument;
			const body = doc.body;
			const bodyStyles = getComputedStyle(body);
			const bodyMarginInline = doc.compatMode === "CSS1Compat" ? parseFloat(bodyStyles.marginLeft) + parseFloat(bodyStyles.marginRight) || 0 : 0;
			const clippingStableScrollbarWidth = Math.abs(html.clientWidth - body.clientWidth - bodyMarginInline);
			if (clippingStableScrollbarWidth <= SCROLLBAR_MAX) width -= clippingStableScrollbarWidth;
		} else if (windowScrollbarX <= SCROLLBAR_MAX) width += windowScrollbarX;
		return {
			width,
			height,
			x,
			y
		};
	}
	function getInnerBoundingClientRect(element, strategy) {
		const clientRect = getBoundingClientRect(element, true, strategy === "fixed");
		const top = clientRect.top + element.clientTop;
		const left = clientRect.left + element.clientLeft;
		const scale = isHTMLElement(element) ? getScale(element) : createCoords(1);
		return {
			width: element.clientWidth * scale.x,
			height: element.clientHeight * scale.y,
			x: left * scale.x,
			y: top * scale.y
		};
	}
	function getClientRectFromClippingAncestor(element, clippingAncestor, strategy) {
		let rect;
		if (clippingAncestor === "viewport") rect = getViewportRect(element, strategy);
		else if (clippingAncestor === "document") rect = getDocumentRect(getDocumentElement(element));
		else if (isElement(clippingAncestor)) rect = getInnerBoundingClientRect(clippingAncestor, strategy);
		else {
			const visualOffsets = getVisualOffsets(element);
			rect = {
				x: clippingAncestor.x - visualOffsets.x,
				y: clippingAncestor.y - visualOffsets.y,
				width: clippingAncestor.width,
				height: clippingAncestor.height
			};
		}
		return rectToClientRect(rect);
	}
	function hasFixedPositionAncestor(element, stopNode) {
		const parentNode = getParentNode(element);
		if (parentNode === stopNode || !isElement(parentNode) || isLastTraversableNode(parentNode)) return false;
		return getComputedStyle$1(parentNode).position === "fixed" || hasFixedPositionAncestor(parentNode, stopNode);
	}
	function getClippingElementAncestors(element, cache) {
		const cachedResult = cache.get(element);
		if (cachedResult) return cachedResult;
		let result = getOverflowAncestors(element, [], false).filter((el) => isElement(el) && getNodeName(el) !== "body");
		let currentContainingBlockComputedStyle = null;
		const elementIsFixed = getComputedStyle$1(element).position === "fixed";
		let currentNode = elementIsFixed ? getParentNode(element) : element;
		while (isElement(currentNode) && !isLastTraversableNode(currentNode)) {
			const computedStyle = getComputedStyle$1(currentNode);
			const currentNodeIsContaining = isContainingBlock(currentNode);
			if (!currentNodeIsContaining && computedStyle.position === "fixed") currentContainingBlockComputedStyle = null;
			if (elementIsFixed ? !currentNodeIsContaining && !currentContainingBlockComputedStyle : !currentNodeIsContaining && computedStyle.position === "static" && !!currentContainingBlockComputedStyle && (currentContainingBlockComputedStyle.position === "absolute" || currentContainingBlockComputedStyle.position === "fixed") || isOverflowElement(currentNode) && !currentNodeIsContaining && hasFixedPositionAncestor(element, currentNode)) result = result.filter((ancestor) => ancestor !== currentNode);
			else currentContainingBlockComputedStyle = computedStyle;
			currentNode = getParentNode(currentNode);
		}
		cache.set(element, result);
		return result;
	}
	function getClippingRect(_ref) {
		let { element, boundary, rootBoundary, strategy } = _ref;
		const clippingAncestors = [...boundary === "clippingAncestors" ? isTopLayer(element) ? [] : getClippingElementAncestors(element, this._c) : [].concat(boundary), rootBoundary];
		const firstRect = getClientRectFromClippingAncestor(element, clippingAncestors[0], strategy);
		let top = firstRect.top;
		let right = firstRect.right;
		let bottom = firstRect.bottom;
		let left = firstRect.left;
		for (let i = 1; i < clippingAncestors.length; i++) {
			const rect = getClientRectFromClippingAncestor(element, clippingAncestors[i], strategy);
			top = max(rect.top, top);
			right = min(rect.right, right);
			bottom = min(rect.bottom, bottom);
			left = max(rect.left, left);
		}
		return {
			width: right - left,
			height: bottom - top,
			x: left,
			y: top
		};
	}
	function getDimensions(element) {
		const { width, height } = getCssDimensions(element);
		return {
			width,
			height
		};
	}
	function getRectRelativeToOffsetParent(element, offsetParent, strategy) {
		const isOffsetParentAnElement = isHTMLElement(offsetParent);
		const documentElement = getDocumentElement(offsetParent);
		const isFixed = strategy === "fixed";
		const rect = getBoundingClientRect(element, true, isFixed, offsetParent);
		let scroll = {
			scrollLeft: 0,
			scrollTop: 0
		};
		const offsets = createCoords(0);
		function setLeftRTLScrollbarOffset() {
			offsets.x = getWindowScrollBarX(documentElement);
		}
		if (isOffsetParentAnElement || !isOffsetParentAnElement && !isFixed) {
			if (getNodeName(offsetParent) !== "body" || isOverflowElement(documentElement)) scroll = getNodeScroll(offsetParent);
			if (isOffsetParentAnElement) {
				const offsetRect = getBoundingClientRect(offsetParent, true, isFixed, offsetParent);
				offsets.x = offsetRect.x + offsetParent.clientLeft;
				offsets.y = offsetRect.y + offsetParent.clientTop;
			} else if (documentElement) setLeftRTLScrollbarOffset();
		}
		if (isFixed && !isOffsetParentAnElement && documentElement) setLeftRTLScrollbarOffset();
		const htmlOffset = documentElement && !isOffsetParentAnElement && !isFixed ? getHTMLOffset(documentElement, scroll) : createCoords(0);
		return {
			x: rect.left + scroll.scrollLeft - offsets.x - htmlOffset.x,
			y: rect.top + scroll.scrollTop - offsets.y - htmlOffset.y,
			width: rect.width,
			height: rect.height
		};
	}
	function isStaticPositioned(element) {
		return getComputedStyle$1(element).position === "static";
	}
	function getTrueOffsetParent(element, polyfill) {
		if (!isHTMLElement(element) || getComputedStyle$1(element).position === "fixed") return null;
		if (polyfill) return polyfill(element);
		let rawOffsetParent = element.offsetParent;
		if (getDocumentElement(element) === rawOffsetParent) rawOffsetParent = rawOffsetParent.ownerDocument.body;
		return rawOffsetParent;
	}
	function getOffsetParent(element, polyfill) {
		const win = getWindow(element);
		if (isTopLayer(element)) return win;
		if (!isHTMLElement(element)) {
			let svgOffsetParent = getParentNode(element);
			while (svgOffsetParent && !isLastTraversableNode(svgOffsetParent)) {
				if (isElement(svgOffsetParent) && !isStaticPositioned(svgOffsetParent)) return svgOffsetParent;
				svgOffsetParent = getParentNode(svgOffsetParent);
			}
			return win;
		}
		let offsetParent = getTrueOffsetParent(element, polyfill);
		while (offsetParent && isTableElement(offsetParent) && isStaticPositioned(offsetParent)) offsetParent = getTrueOffsetParent(offsetParent, polyfill);
		if (offsetParent && isLastTraversableNode(offsetParent) && isStaticPositioned(offsetParent) && !isContainingBlock(offsetParent)) return win;
		return offsetParent || getContainingBlock(element) || win;
	}
	var getElementRects = async function(data) {
		const getOffsetParentFn = this.getOffsetParent || getOffsetParent;
		const getDimensionsFn = this.getDimensions;
		const floatingDimensions = await getDimensionsFn(data.floating);
		return {
			reference: getRectRelativeToOffsetParent(data.reference, await getOffsetParentFn(data.floating), data.strategy),
			floating: {
				x: 0,
				y: 0,
				width: floatingDimensions.width,
				height: floatingDimensions.height
			}
		};
	};
	function isRTL(element) {
		return getComputedStyle$1(element).direction === "rtl";
	}
	var platform = {
		convertOffsetParentRelativeRectToViewportRelativeRect,
		getDocumentElement,
		getClippingRect,
		getOffsetParent,
		getElementRects,
		getClientRects,
		getDimensions,
		getScale,
		isElement,
		isRTL
	};
	function rectsAreEqual(a, b) {
		return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
	}
	function observeMove(element, onMove) {
		let io = null;
		let timeoutId;
		const root = getDocumentElement(element);
		function cleanup() {
			var _io;
			clearTimeout(timeoutId);
			(_io = io) == null || _io.disconnect();
			io = null;
		}
		function refresh(skip, threshold) {
			if (skip === void 0) skip = false;
			if (threshold === void 0) threshold = 1;
			cleanup();
			const elementRectForRootMargin = element.getBoundingClientRect();
			const { left, top, width, height } = elementRectForRootMargin;
			if (!skip) onMove();
			if (!width || !height) return;
			const insetTop = floor(top);
			const insetRight = floor(root.clientWidth - (left + width));
			const insetBottom = floor(root.clientHeight - (top + height));
			const insetLeft = floor(left);
			const options = {
				rootMargin: -insetTop + "px " + -insetRight + "px " + -insetBottom + "px " + -insetLeft + "px",
				threshold: max(0, min(1, threshold)) || 1
			};
			let isFirstUpdate = true;
			function handleObserve(entries) {
				const ratio = entries[0].intersectionRatio;
				if (ratio !== threshold) {
					if (!isFirstUpdate) return refresh();
					if (!ratio) timeoutId = setTimeout(() => {
						refresh(false, 1e-7);
					}, 1e3);
					else refresh(false, ratio);
				}
				if (ratio === 1 && !rectsAreEqual(elementRectForRootMargin, element.getBoundingClientRect())) refresh();
				isFirstUpdate = false;
			}
			try {
				io = new IntersectionObserver(handleObserve, {
					...options,
					root: root.ownerDocument
				});
			} catch (_e) {
				io = new IntersectionObserver(handleObserve, options);
			}
			io.observe(element);
		}
		refresh(true);
		return cleanup;
	}
	/**
	* Automatically updates the position of the floating element when necessary.
	* Should only be called when the floating element is mounted on the DOM or
	* visible on the screen.
	* @returns cleanup function that should be invoked when the floating element is
	* removed from the DOM or hidden from the screen.
	* @see https://floating-ui.com/docs/autoUpdate
	*/
	function autoUpdate(reference, floating, update, options) {
		if (options === void 0) options = {};
		const { ancestorScroll = true, ancestorResize = true, elementResize = typeof ResizeObserver === "function", layoutShift = typeof IntersectionObserver === "function", animationFrame = false } = options;
		const referenceEl = unwrapElement(reference);
		const ancestors = ancestorScroll || ancestorResize ? [...referenceEl ? getOverflowAncestors(referenceEl) : [], ...floating ? getOverflowAncestors(floating) : []] : [];
		ancestors.forEach((ancestor) => {
			ancestorScroll && ancestor.addEventListener("scroll", update, { passive: true });
			ancestorResize && ancestor.addEventListener("resize", update);
		});
		const cleanupIo = referenceEl && layoutShift ? observeMove(referenceEl, update) : null;
		let reobserveFrame = -1;
		let resizeObserver = null;
		if (elementResize) {
			resizeObserver = new ResizeObserver((_ref) => {
				let [firstEntry] = _ref;
				if (firstEntry && firstEntry.target === referenceEl && resizeObserver && floating) {
					resizeObserver.unobserve(floating);
					cancelAnimationFrame(reobserveFrame);
					reobserveFrame = requestAnimationFrame(() => {
						var _resizeObserver;
						(_resizeObserver = resizeObserver) == null || _resizeObserver.observe(floating);
					});
				}
				update();
			});
			if (referenceEl && !animationFrame) resizeObserver.observe(referenceEl);
			if (floating) resizeObserver.observe(floating);
		}
		let frameId;
		let prevRefRect = animationFrame ? getBoundingClientRect(reference) : null;
		if (animationFrame) frameLoop();
		function frameLoop() {
			const nextRefRect = getBoundingClientRect(reference);
			if (prevRefRect && !rectsAreEqual(prevRefRect, nextRefRect)) update();
			prevRefRect = nextRefRect;
			frameId = requestAnimationFrame(frameLoop);
		}
		update();
		return () => {
			var _resizeObserver2;
			ancestors.forEach((ancestor) => {
				ancestorScroll && ancestor.removeEventListener("scroll", update);
				ancestorResize && ancestor.removeEventListener("resize", update);
			});
			cleanupIo?.();
			(_resizeObserver2 = resizeObserver) == null || _resizeObserver2.disconnect();
			resizeObserver = null;
			if (animationFrame) cancelAnimationFrame(frameId);
		};
	}
	/**
	* Modifies the placement by translating the floating element along the
	* specified axes.
	* A number (shorthand for `mainAxis` or distance), or an axes configuration
	* object may be passed.
	* @see https://floating-ui.com/docs/offset
	*/
	var offset$1 = offset$2;
	/**
	* Optimizes the visibility of the floating element by shifting it in order to
	* keep it in view when it will overflow the clipping boundary.
	* @see https://floating-ui.com/docs/shift
	*/
	var shift$1 = shift$2;
	/**
	* Optimizes the visibility of the floating element by flipping the `placement`
	* in order to keep it in view when the preferred placement(s) will overflow the
	* clipping boundary. Alternative to `autoPlacement`.
	* @see https://floating-ui.com/docs/flip
	*/
	var flip$1 = flip$2;
	/**
	* Provides data that allows you to change the size of the floating element —
	* for instance, prevent it from overflowing the clipping boundary or match the
	* width of the reference element.
	* @see https://floating-ui.com/docs/size
	*/
	var size$1 = size$2;
	/**
	* Provides data to hide the floating element in applicable situations, such as
	* when it is not in the same clipping context as the reference element.
	* @see https://floating-ui.com/docs/hide
	*/
	var hide$1 = hide$2;
	/**
	* Provides data to position an inner element of the floating element so that it
	* appears centered to the reference element.
	* @see https://floating-ui.com/docs/arrow
	*/
	var arrow$2 = arrow$3;
	/**
	* Built-in `limiter` that will stop `shift()` at a certain point.
	*/
	var limitShift$1 = limitShift$2;
	/**
	* Computes the `x` and `y` coordinates that will place the floating element
	* next to a given reference element.
	*/
	var computePosition = (reference, floating, options) => {
		const cache = /* @__PURE__ */ new Map();
		const mergedOptions = {
			platform,
			...options
		};
		const platformWithCache = {
			...mergedOptions.platform,
			_c: cache
		};
		return computePosition$1(reference, floating, {
			...mergedOptions,
			platform: platformWithCache
		});
	};
	//#endregion
	//#region ../../node_modules/.pnpm/@floating-ui+react-dom@2.1.8_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@floating-ui/react-dom/dist/floating-ui.react-dom.mjs
	var index = typeof document !== "undefined" ? _ : function noop() {};
	function deepEqual(a, b) {
		if (a === b) return true;
		if (typeof a !== typeof b) return false;
		if (typeof a === "function" && a.toString() === b.toString()) return true;
		let length;
		let i;
		let keys;
		if (a && b && typeof a === "object") {
			if (Array.isArray(a)) {
				length = a.length;
				if (length !== b.length) return false;
				for (i = length; i-- !== 0;) if (!deepEqual(a[i], b[i])) return false;
				return true;
			}
			keys = Object.keys(a);
			length = keys.length;
			if (length !== Object.keys(b).length) return false;
			for (i = length; i-- !== 0;) if (!{}.hasOwnProperty.call(b, keys[i])) return false;
			for (i = length; i-- !== 0;) {
				const key = keys[i];
				if (key === "_owner" && a.$$typeof) continue;
				if (!deepEqual(a[key], b[key])) return false;
			}
			return true;
		}
		return a !== a && b !== b;
	}
	function getDPR(element) {
		if (typeof window === "undefined") return 1;
		return (element.ownerDocument.defaultView || window).devicePixelRatio || 1;
	}
	function roundByDPR(element, value) {
		const dpr = getDPR(element);
		return Math.round(value * dpr) / dpr;
	}
	function useLatestRef(value) {
		const ref = A$1(value);
		index(() => {
			ref.current = value;
		});
		return ref;
	}
	/**
	* Provides data to position a floating element.
	* @see https://floating-ui.com/docs/useFloating
	*/
	function useFloating(options) {
		if (options === void 0) options = {};
		const { placement = "bottom", strategy = "absolute", middleware = [], platform, elements: { reference: externalReference, floating: externalFloating } = {}, transform = true, whileElementsMounted, open } = options;
		const [data, setData] = d({
			x: 0,
			y: 0,
			strategy,
			placement,
			middlewareData: {},
			isPositioned: false
		});
		const [latestMiddleware, setLatestMiddleware] = d(middleware);
		if (!deepEqual(latestMiddleware, middleware)) setLatestMiddleware(middleware);
		const [_reference, _setReference] = d(null);
		const [_floating, _setFloating] = d(null);
		const setReference = q$1((node) => {
			if (node !== referenceRef.current) {
				referenceRef.current = node;
				_setReference(node);
			}
		}, []);
		const setFloating = q$1((node) => {
			if (node !== floatingRef.current) {
				floatingRef.current = node;
				_setFloating(node);
			}
		}, []);
		const referenceEl = externalReference || _reference;
		const floatingEl = externalFloating || _floating;
		const referenceRef = A$1(null);
		const floatingRef = A$1(null);
		const dataRef = A$1(data);
		const hasWhileElementsMounted = whileElementsMounted != null;
		const whileElementsMountedRef = useLatestRef(whileElementsMounted);
		const platformRef = useLatestRef(platform);
		const openRef = useLatestRef(open);
		const update = q$1(() => {
			if (!referenceRef.current || !floatingRef.current) return;
			const config = {
				placement,
				strategy,
				middleware: latestMiddleware
			};
			if (platformRef.current) config.platform = platformRef.current;
			computePosition(referenceRef.current, floatingRef.current, config).then((data) => {
				const fullData = {
					...data,
					isPositioned: openRef.current !== false
				};
				if (isMountedRef.current && !deepEqual(dataRef.current, fullData)) {
					dataRef.current = fullData;
					bn(() => {
						setData(fullData);
					});
				}
			});
		}, [
			latestMiddleware,
			placement,
			strategy,
			platformRef,
			openRef
		]);
		index(() => {
			if (open === false && dataRef.current.isPositioned) {
				dataRef.current.isPositioned = false;
				setData((data) => ({
					...data,
					isPositioned: false
				}));
			}
		}, [open]);
		const isMountedRef = A$1(false);
		index(() => {
			isMountedRef.current = true;
			return () => {
				isMountedRef.current = false;
			};
		}, []);
		index(() => {
			if (referenceEl) referenceRef.current = referenceEl;
			if (floatingEl) floatingRef.current = floatingEl;
			if (referenceEl && floatingEl) {
				if (whileElementsMountedRef.current) return whileElementsMountedRef.current(referenceEl, floatingEl, update);
				update();
			}
		}, [
			referenceEl,
			floatingEl,
			update,
			whileElementsMountedRef,
			hasWhileElementsMounted
		]);
		const refs = T$1(() => ({
			reference: referenceRef,
			floating: floatingRef,
			setReference,
			setFloating
		}), [setReference, setFloating]);
		const elements = T$1(() => ({
			reference: referenceEl,
			floating: floatingEl
		}), [referenceEl, floatingEl]);
		const floatingStyles = T$1(() => {
			const initialStyles = {
				position: strategy,
				left: 0,
				top: 0
			};
			if (!elements.floating) return initialStyles;
			const x = roundByDPR(elements.floating, data.x);
			const y = roundByDPR(elements.floating, data.y);
			if (transform) return {
				...initialStyles,
				transform: "translate(" + x + "px, " + y + "px)",
				...getDPR(elements.floating) >= 1.5 && { willChange: "transform" }
			};
			return {
				position: strategy,
				left: x,
				top: y
			};
		}, [
			strategy,
			transform,
			elements.floating,
			data.x,
			data.y
		]);
		return T$1(() => ({
			...data,
			update,
			refs,
			elements,
			floatingStyles
		}), [
			data,
			update,
			refs,
			elements,
			floatingStyles
		]);
	}
	/**
	* Provides data to position an inner element of the floating element so that it
	* appears centered to the reference element.
	* This wraps the core `arrow` middleware to allow React refs as the element.
	* @see https://floating-ui.com/docs/arrow
	*/
	var arrow$1 = (options) => {
		function isRef(value) {
			return {}.hasOwnProperty.call(value, "current");
		}
		return {
			name: "arrow",
			options,
			fn(state) {
				const { element, padding } = typeof options === "function" ? options(state) : options;
				if (element && isRef(element)) {
					if (element.current != null) return arrow$2({
						element: element.current,
						padding
					}).fn(state);
					return {};
				}
				if (element) return arrow$2({
					element,
					padding
				}).fn(state);
				return {};
			}
		};
	};
	/**
	* Modifies the placement by translating the floating element along the
	* specified axes.
	* A number (shorthand for `mainAxis` or distance), or an axes configuration
	* object may be passed.
	* @see https://floating-ui.com/docs/offset
	*/
	var offset = (options, deps) => {
		const result = offset$1(options);
		return {
			name: result.name,
			fn: result.fn,
			options: [options, deps]
		};
	};
	/**
	* Optimizes the visibility of the floating element by shifting it in order to
	* keep it in view when it will overflow the clipping boundary.
	* @see https://floating-ui.com/docs/shift
	*/
	var shift = (options, deps) => {
		const result = shift$1(options);
		return {
			name: result.name,
			fn: result.fn,
			options: [options, deps]
		};
	};
	/**
	* Built-in `limiter` that will stop `shift()` at a certain point.
	*/
	var limitShift = (options, deps) => {
		return {
			fn: limitShift$1(options).fn,
			options: [options, deps]
		};
	};
	/**
	* Optimizes the visibility of the floating element by flipping the `placement`
	* in order to keep it in view when the preferred placement(s) will overflow the
	* clipping boundary. Alternative to `autoPlacement`.
	* @see https://floating-ui.com/docs/flip
	*/
	var flip = (options, deps) => {
		const result = flip$1(options);
		return {
			name: result.name,
			fn: result.fn,
			options: [options, deps]
		};
	};
	/**
	* Provides data that allows you to change the size of the floating element —
	* for instance, prevent it from overflowing the clipping boundary or match the
	* width of the reference element.
	* @see https://floating-ui.com/docs/size
	*/
	var size = (options, deps) => {
		const result = size$1(options);
		return {
			name: result.name,
			fn: result.fn,
			options: [options, deps]
		};
	};
	/**
	* Provides data to hide the floating element in applicable situations, such as
	* when it is not in the same clipping context as the reference element.
	* @see https://floating-ui.com/docs/hide
	*/
	var hide = (options, deps) => {
		const result = hide$1(options);
		return {
			name: result.name,
			fn: result.fn,
			options: [options, deps]
		};
	};
	/**
	* Provides data to position an inner element of the floating element so that it
	* appears centered to the reference element.
	* This wraps the core `arrow` middleware to allow React refs as the element.
	* @see https://floating-ui.com/docs/arrow
	*/
	var arrow = (options, deps) => {
		const result = arrow$1(options);
		return {
			name: result.name,
			fn: result.fn,
			options: [options, deps]
		};
	};
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-arrow@1.1.7_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-arrow/dist/index.mjs
	var NAME$1 = "Arrow";
	var Arrow$1 = D((props, forwardedRef) => {
		const { children, width = 10, height = 5, ...arrowProps } = props;
		return /* @__PURE__ */ u(Primitive.svg, {
			...arrowProps,
			ref: forwardedRef,
			width,
			height,
			viewBox: "0 0 30 10",
			preserveAspectRatio: "none",
			children: props.asChild ? children : /* @__PURE__ */ u("polygon", { points: "0,0 30,0 15,10" })
		});
	});
	Arrow$1.displayName = NAME$1;
	var Root = Arrow$1;
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-popper@1.2.8_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-popper/dist/index.mjs
	var POPPER_NAME = "Popper";
	var [createPopperContext, createPopperScope] = createContextScope(POPPER_NAME);
	var [PopperProvider, usePopperContext] = createPopperContext(POPPER_NAME);
	var Popper = (props) => {
		const { __scopePopper, children } = props;
		const [anchor, setAnchor] = d(null);
		return /* @__PURE__ */ u(PopperProvider, {
			scope: __scopePopper,
			anchor,
			onAnchorChange: setAnchor,
			children
		});
	};
	Popper.displayName = POPPER_NAME;
	var ANCHOR_NAME = "PopperAnchor";
	var PopperAnchor = D((props, forwardedRef) => {
		const { __scopePopper, virtualRef, ...anchorProps } = props;
		const context = usePopperContext(ANCHOR_NAME, __scopePopper);
		const ref = A$1(null);
		const composedRefs = useComposedRefs(forwardedRef, ref);
		const anchorRef = A$1(null);
		y(() => {
			const previousAnchor = anchorRef.current;
			anchorRef.current = virtualRef?.current || ref.current;
			if (previousAnchor !== anchorRef.current) context.onAnchorChange(anchorRef.current);
		});
		return virtualRef ? null : /* @__PURE__ */ u(Primitive.div, {
			...anchorProps,
			ref: composedRefs
		});
	});
	PopperAnchor.displayName = ANCHOR_NAME;
	var CONTENT_NAME$1 = "PopperContent";
	var [PopperContentProvider, useContentContext] = createPopperContext(CONTENT_NAME$1);
	var PopperContent = D((props, forwardedRef) => {
		const { __scopePopper, side = "bottom", sideOffset = 0, align = "center", alignOffset = 0, arrowPadding = 0, avoidCollisions = true, collisionBoundary = [], collisionPadding: collisionPaddingProp = 0, sticky = "partial", hideWhenDetached = false, updatePositionStrategy = "optimized", onPlaced, ...contentProps } = props;
		const context = usePopperContext(CONTENT_NAME$1, __scopePopper);
		const [content, setContent] = d(null);
		const composedRefs = useComposedRefs(forwardedRef, (node) => setContent(node));
		const [arrow$4, setArrow] = d(null);
		const arrowSize = useSize(arrow$4);
		const arrowWidth = arrowSize?.width ?? 0;
		const arrowHeight = arrowSize?.height ?? 0;
		const desiredPlacement = side + (align !== "center" ? "-" + align : "");
		const collisionPadding = typeof collisionPaddingProp === "number" ? collisionPaddingProp : {
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
			...collisionPaddingProp
		};
		const boundary = Array.isArray(collisionBoundary) ? collisionBoundary : [collisionBoundary];
		const hasExplicitBoundaries = boundary.length > 0;
		const detectOverflowOptions = {
			padding: collisionPadding,
			boundary: boundary.filter(isNotNull),
			altBoundary: hasExplicitBoundaries
		};
		const { refs, floatingStyles, placement, isPositioned, middlewareData } = useFloating({
			strategy: "fixed",
			placement: desiredPlacement,
			whileElementsMounted: (...args) => {
				return autoUpdate(...args, { animationFrame: updatePositionStrategy === "always" });
			},
			elements: { reference: context.anchor },
			middleware: [
				offset({
					mainAxis: sideOffset + arrowHeight,
					alignmentAxis: alignOffset
				}),
				avoidCollisions && shift({
					mainAxis: true,
					crossAxis: false,
					limiter: sticky === "partial" ? limitShift() : void 0,
					...detectOverflowOptions
				}),
				avoidCollisions && flip({ ...detectOverflowOptions }),
				size({
					...detectOverflowOptions,
					apply: ({ elements, rects, availableWidth, availableHeight }) => {
						const { width: anchorWidth, height: anchorHeight } = rects.reference;
						const contentStyle = elements.floating.style;
						contentStyle.setProperty("--radix-popper-available-width", `${availableWidth}px`);
						contentStyle.setProperty("--radix-popper-available-height", `${availableHeight}px`);
						contentStyle.setProperty("--radix-popper-anchor-width", `${anchorWidth}px`);
						contentStyle.setProperty("--radix-popper-anchor-height", `${anchorHeight}px`);
					}
				}),
				arrow$4 && arrow({
					element: arrow$4,
					padding: arrowPadding
				}),
				transformOrigin({
					arrowWidth,
					arrowHeight
				}),
				hideWhenDetached && hide({
					strategy: "referenceHidden",
					...detectOverflowOptions
				})
			]
		});
		const [placedSide, placedAlign] = getSideAndAlignFromPlacement(placement);
		const handlePlaced = useCallbackRef$1(onPlaced);
		useLayoutEffect2(() => {
			if (isPositioned) handlePlaced?.();
		}, [isPositioned, handlePlaced]);
		const arrowX = middlewareData.arrow?.x;
		const arrowY = middlewareData.arrow?.y;
		const cannotCenterArrow = middlewareData.arrow?.centerOffset !== 0;
		const [contentZIndex, setContentZIndex] = d();
		useLayoutEffect2(() => {
			if (content) setContentZIndex(window.getComputedStyle(content).zIndex);
		}, [content]);
		return /* @__PURE__ */ u("div", {
			ref: refs.setFloating,
			"data-radix-popper-content-wrapper": "",
			style: {
				...floatingStyles,
				transform: isPositioned ? floatingStyles.transform : "translate(0, -200%)",
				minWidth: "max-content",
				zIndex: contentZIndex,
				["--radix-popper-transform-origin"]: [middlewareData.transformOrigin?.x, middlewareData.transformOrigin?.y].join(" "),
				...middlewareData.hide?.referenceHidden && {
					visibility: "hidden",
					pointerEvents: "none"
				}
			},
			dir: props.dir,
			children: /* @__PURE__ */ u(PopperContentProvider, {
				scope: __scopePopper,
				placedSide,
				onArrowChange: setArrow,
				arrowX,
				arrowY,
				shouldHideArrow: cannotCenterArrow,
				children: /* @__PURE__ */ u(Primitive.div, {
					"data-side": placedSide,
					"data-align": placedAlign,
					...contentProps,
					ref: composedRefs,
					style: {
						...contentProps.style,
						animation: !isPositioned ? "none" : void 0
					}
				})
			})
		});
	});
	PopperContent.displayName = CONTENT_NAME$1;
	var ARROW_NAME$1 = "PopperArrow";
	var OPPOSITE_SIDE = {
		top: "bottom",
		right: "left",
		bottom: "top",
		left: "right"
	};
	var PopperArrow = D(function PopperArrow2(props, forwardedRef) {
		const { __scopePopper, ...arrowProps } = props;
		const contentContext = useContentContext(ARROW_NAME$1, __scopePopper);
		const baseSide = OPPOSITE_SIDE[contentContext.placedSide];
		return /* @__PURE__ */ u("span", {
			ref: contentContext.onArrowChange,
			style: {
				position: "absolute",
				left: contentContext.arrowX,
				top: contentContext.arrowY,
				[baseSide]: 0,
				transformOrigin: {
					top: "",
					right: "0 0",
					bottom: "center 0",
					left: "100% 0"
				}[contentContext.placedSide],
				transform: {
					top: "translateY(100%)",
					right: "translateY(50%) rotate(90deg) translateX(-50%)",
					bottom: `rotate(180deg)`,
					left: "translateY(50%) rotate(-90deg) translateX(50%)"
				}[contentContext.placedSide],
				visibility: contentContext.shouldHideArrow ? "hidden" : void 0
			},
			children: /* @__PURE__ */ u(Root, {
				...arrowProps,
				ref: forwardedRef,
				style: {
					...arrowProps.style,
					display: "block"
				}
			})
		});
	});
	PopperArrow.displayName = ARROW_NAME$1;
	function isNotNull(value) {
		return value !== null;
	}
	var transformOrigin = (options) => ({
		name: "transformOrigin",
		options,
		fn(data) {
			const { placement, rects, middlewareData } = data;
			const isArrowHidden = middlewareData.arrow?.centerOffset !== 0;
			const arrowWidth = isArrowHidden ? 0 : options.arrowWidth;
			const arrowHeight = isArrowHidden ? 0 : options.arrowHeight;
			const [placedSide, placedAlign] = getSideAndAlignFromPlacement(placement);
			const noArrowAlign = {
				start: "0%",
				center: "50%",
				end: "100%"
			}[placedAlign];
			const arrowXCenter = (middlewareData.arrow?.x ?? 0) + arrowWidth / 2;
			const arrowYCenter = (middlewareData.arrow?.y ?? 0) + arrowHeight / 2;
			let x = "";
			let y = "";
			if (placedSide === "bottom") {
				x = isArrowHidden ? noArrowAlign : `${arrowXCenter}px`;
				y = `${-arrowHeight}px`;
			} else if (placedSide === "top") {
				x = isArrowHidden ? noArrowAlign : `${arrowXCenter}px`;
				y = `${rects.floating.height + arrowHeight}px`;
			} else if (placedSide === "right") {
				x = `${-arrowHeight}px`;
				y = isArrowHidden ? noArrowAlign : `${arrowYCenter}px`;
			} else if (placedSide === "left") {
				x = `${rects.floating.width + arrowHeight}px`;
				y = isArrowHidden ? noArrowAlign : `${arrowYCenter}px`;
			}
			return { data: {
				x,
				y
			} };
		}
	});
	function getSideAndAlignFromPlacement(placement) {
		const [side, align = "center"] = placement.split("-");
		return [side, align];
	}
	var Root2$1 = Popper;
	var Anchor = PopperAnchor;
	var Content = PopperContent;
	var Arrow = PopperArrow;
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-visually-hidden@1.2.3_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-visually-hidden/dist/index.mjs
	var VISUALLY_HIDDEN_STYLES = Object.freeze({
		position: "absolute",
		border: 0,
		width: 1,
		height: 1,
		padding: 0,
		margin: -1,
		overflow: "hidden",
		clip: "rect(0, 0, 0, 0)",
		whiteSpace: "nowrap",
		wordWrap: "normal"
	});
	var NAME = "VisuallyHidden";
	var VisuallyHidden = D((props, forwardedRef) => {
		return /* @__PURE__ */ u(Primitive.span, {
			...props,
			ref: forwardedRef,
			style: {
				...VISUALLY_HIDDEN_STYLES,
				...props.style
			}
		});
	});
	VisuallyHidden.displayName = NAME;
	//#endregion
	//#region ../../node_modules/.pnpm/@radix-ui+react-select@2.2.6_react-dom@19.2.4_react@19.2.4__react@19.2.4/node_modules/@radix-ui/react-select/dist/index.mjs
	var OPEN_KEYS = [
		" ",
		"Enter",
		"ArrowUp",
		"ArrowDown"
	];
	var SELECTION_KEYS = [" ", "Enter"];
	var SELECT_NAME = "Select";
	var [Collection, useCollection, createCollectionScope] = createCollection(SELECT_NAME);
	var [createSelectContext, createSelectScope] = createContextScope(SELECT_NAME, [createCollectionScope, createPopperScope]);
	var usePopperScope = createPopperScope();
	var [SelectProvider, useSelectContext] = createSelectContext(SELECT_NAME);
	var [SelectNativeOptionsProvider, useSelectNativeOptionsContext] = createSelectContext(SELECT_NAME);
	var Select = (props) => {
		const { __scopeSelect, children, open: openProp, defaultOpen, onOpenChange, value: valueProp, defaultValue, onValueChange, dir, name, autoComplete, disabled, required, form } = props;
		const popperScope = usePopperScope(__scopeSelect);
		const [trigger, setTrigger] = d(null);
		const [valueNode, setValueNode] = d(null);
		const [valueNodeHasChildren, setValueNodeHasChildren] = d(false);
		const direction = useDirection(dir);
		const [open, setOpen] = useControllableState({
			prop: openProp,
			defaultProp: defaultOpen ?? false,
			onChange: onOpenChange,
			caller: SELECT_NAME
		});
		const [value, setValue] = useControllableState({
			prop: valueProp,
			defaultProp: defaultValue,
			onChange: onValueChange,
			caller: SELECT_NAME
		});
		const triggerPointerDownPosRef = A$1(null);
		const isFormControl = trigger ? form || !!trigger.closest("form") : true;
		const [nativeOptionsSet, setNativeOptionsSet] = d(/* @__PURE__ */ new Set());
		const nativeSelectKey = Array.from(nativeOptionsSet).map((option) => option.props.value).join(";");
		return /* @__PURE__ */ u(Root2$1, {
			...popperScope,
			children: /* @__PURE__ */ u(SelectProvider, {
				required,
				scope: __scopeSelect,
				trigger,
				onTriggerChange: setTrigger,
				valueNode,
				onValueNodeChange: setValueNode,
				valueNodeHasChildren,
				onValueNodeHasChildrenChange: setValueNodeHasChildren,
				contentId: useId(),
				value,
				onValueChange: setValue,
				open,
				onOpenChange: setOpen,
				dir: direction,
				triggerPointerDownPosRef,
				disabled,
				children: [/* @__PURE__ */ u(Collection.Provider, {
					scope: __scopeSelect,
					children: /* @__PURE__ */ u(SelectNativeOptionsProvider, {
						scope: props.__scopeSelect,
						onNativeOptionAdd: q$1((option) => {
							setNativeOptionsSet((prev) => new Set(prev).add(option));
						}, []),
						onNativeOptionRemove: q$1((option) => {
							setNativeOptionsSet((prev) => {
								const optionsSet = new Set(prev);
								optionsSet.delete(option);
								return optionsSet;
							});
						}, []),
						children
					})
				}), isFormControl ? /* @__PURE__ */ u(SelectBubbleInput, {
					"aria-hidden": true,
					required,
					tabIndex: -1,
					name,
					autoComplete,
					value,
					onChange: (event) => setValue(event.target.value),
					disabled,
					form,
					children: [value === void 0 ? /* @__PURE__ */ u("option", { value: "" }) : null, Array.from(nativeOptionsSet)]
				}, nativeSelectKey) : null]
			})
		});
	};
	Select.displayName = SELECT_NAME;
	var TRIGGER_NAME = "SelectTrigger";
	var SelectTrigger = D((props, forwardedRef) => {
		const { __scopeSelect, disabled = false, ...triggerProps } = props;
		const popperScope = usePopperScope(__scopeSelect);
		const context = useSelectContext(TRIGGER_NAME, __scopeSelect);
		const isDisabled = context.disabled || disabled;
		const composedRefs = useComposedRefs(forwardedRef, context.onTriggerChange);
		const getItems = useCollection(__scopeSelect);
		const pointerTypeRef = A$1("touch");
		const [searchRef, handleTypeaheadSearch, resetTypeahead] = useTypeaheadSearch((search) => {
			const enabledItems = getItems().filter((item) => !item.disabled);
			const nextItem = findNextItem(enabledItems, search, enabledItems.find((item) => item.value === context.value));
			if (nextItem !== void 0) context.onValueChange(nextItem.value);
		});
		const handleOpen = (pointerEvent) => {
			if (!isDisabled) {
				context.onOpenChange(true);
				resetTypeahead();
			}
			if (pointerEvent) context.triggerPointerDownPosRef.current = {
				x: Math.round(pointerEvent.pageX),
				y: Math.round(pointerEvent.pageY)
			};
		};
		return /* @__PURE__ */ u(Anchor, {
			asChild: true,
			...popperScope,
			children: /* @__PURE__ */ u(Primitive.button, {
				type: "button",
				role: "combobox",
				"aria-controls": context.contentId,
				"aria-expanded": context.open,
				"aria-required": context.required,
				"aria-autocomplete": "none",
				dir: context.dir,
				"data-state": context.open ? "open" : "closed",
				disabled: isDisabled,
				"data-disabled": isDisabled ? "" : void 0,
				"data-placeholder": shouldShowPlaceholder(context.value) ? "" : void 0,
				...triggerProps,
				ref: composedRefs,
				onClick: composeEventHandlers(triggerProps.onClick, (event) => {
					event.currentTarget.focus();
					if (pointerTypeRef.current !== "mouse") handleOpen(event);
				}),
				onPointerDown: composeEventHandlers(triggerProps.onPointerDown, (event) => {
					pointerTypeRef.current = event.pointerType;
					const target = event.target;
					if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
					if (event.button === 0 && event.ctrlKey === false && event.pointerType === "mouse") {
						handleOpen(event);
						event.preventDefault();
					}
				}),
				onKeyDown: composeEventHandlers(triggerProps.onKeyDown, (event) => {
					const isTypingAhead = searchRef.current !== "";
					if (!(event.ctrlKey || event.altKey || event.metaKey) && event.key.length === 1) handleTypeaheadSearch(event.key);
					if (isTypingAhead && event.key === " ") return;
					if (OPEN_KEYS.includes(event.key)) {
						handleOpen();
						event.preventDefault();
					}
				})
			})
		});
	});
	SelectTrigger.displayName = TRIGGER_NAME;
	var VALUE_NAME = "SelectValue";
	var SelectValue = D((props, forwardedRef) => {
		const { __scopeSelect, className, style, children, placeholder = "", ...valueProps } = props;
		const context = useSelectContext(VALUE_NAME, __scopeSelect);
		const { onValueNodeHasChildrenChange } = context;
		const hasChildren = children !== void 0;
		const composedRefs = useComposedRefs(forwardedRef, context.onValueNodeChange);
		useLayoutEffect2(() => {
			onValueNodeHasChildrenChange(hasChildren);
		}, [onValueNodeHasChildrenChange, hasChildren]);
		return /* @__PURE__ */ u(Primitive.span, {
			...valueProps,
			ref: composedRefs,
			style: { pointerEvents: "none" },
			children: shouldShowPlaceholder(context.value) ? /* @__PURE__ */ u(k$2, { children: placeholder }) : children
		});
	});
	SelectValue.displayName = VALUE_NAME;
	var ICON_NAME = "SelectIcon";
	var SelectIcon = D((props, forwardedRef) => {
		const { __scopeSelect, children, ...iconProps } = props;
		return /* @__PURE__ */ u(Primitive.span, {
			"aria-hidden": true,
			...iconProps,
			ref: forwardedRef,
			children: children || "▼"
		});
	});
	SelectIcon.displayName = ICON_NAME;
	var PORTAL_NAME = "SelectPortal";
	var SelectPortal = (props) => {
		return /* @__PURE__ */ u(Portal$2, {
			asChild: true,
			...props
		});
	};
	SelectPortal.displayName = PORTAL_NAME;
	var CONTENT_NAME = "SelectContent";
	var SelectContent = D((props, forwardedRef) => {
		const context = useSelectContext(CONTENT_NAME, props.__scopeSelect);
		const [fragment, setFragment] = d();
		useLayoutEffect2(() => {
			setFragment(new DocumentFragment());
		}, []);
		if (!context.open) {
			const frag = fragment;
			return frag ? $(/* @__PURE__ */ u(SelectContentProvider, {
				scope: props.__scopeSelect,
				children: /* @__PURE__ */ u(Collection.Slot, {
					scope: props.__scopeSelect,
					children: /* @__PURE__ */ u("div", { children: props.children })
				})
			}), frag) : null;
		}
		return /* @__PURE__ */ u(SelectContentImpl, {
			...props,
			ref: forwardedRef
		});
	});
	SelectContent.displayName = CONTENT_NAME;
	var CONTENT_MARGIN = 10;
	var [SelectContentProvider, useSelectContentContext] = createSelectContext(CONTENT_NAME);
	var CONTENT_IMPL_NAME = "SelectContentImpl";
	var Slot = /* @__PURE__ */ createSlot("SelectContent.RemoveScroll");
	var SelectContentImpl = D((props, forwardedRef) => {
		const { __scopeSelect, position = "item-aligned", onCloseAutoFocus, onEscapeKeyDown, onPointerDownOutside, side, sideOffset, align, alignOffset, arrowPadding, collisionBoundary, collisionPadding, sticky, hideWhenDetached, avoidCollisions, ...contentProps } = props;
		const context = useSelectContext(CONTENT_NAME, __scopeSelect);
		const [content, setContent] = d(null);
		const [viewport, setViewport] = d(null);
		const composedRefs = useComposedRefs(forwardedRef, (node) => setContent(node));
		const [selectedItem, setSelectedItem] = d(null);
		const [selectedItemText, setSelectedItemText] = d(null);
		const getItems = useCollection(__scopeSelect);
		const [isPositioned, setIsPositioned] = d(false);
		const firstValidItemFoundRef = A$1(false);
		y(() => {
			if (content) return hideOthers(content);
		}, [content]);
		useFocusGuards();
		const focusFirst = q$1((candidates) => {
			const [firstItem, ...restItems] = getItems().map((item) => item.ref.current);
			const [lastItem] = restItems.slice(-1);
			const PREVIOUSLY_FOCUSED_ELEMENT = document.activeElement;
			for (const candidate of candidates) {
				if (candidate === PREVIOUSLY_FOCUSED_ELEMENT) return;
				candidate?.scrollIntoView({ block: "nearest" });
				if (candidate === firstItem && viewport) viewport.scrollTop = 0;
				if (candidate === lastItem && viewport) viewport.scrollTop = viewport.scrollHeight;
				candidate?.focus();
				if (document.activeElement !== PREVIOUSLY_FOCUSED_ELEMENT) return;
			}
		}, [getItems, viewport]);
		const focusSelectedItem = q$1(() => focusFirst([selectedItem, content]), [
			focusFirst,
			selectedItem,
			content
		]);
		y(() => {
			if (isPositioned) focusSelectedItem();
		}, [isPositioned, focusSelectedItem]);
		const { onOpenChange, triggerPointerDownPosRef } = context;
		y(() => {
			if (content) {
				let pointerMoveDelta = {
					x: 0,
					y: 0
				};
				const handlePointerMove = (event) => {
					pointerMoveDelta = {
						x: Math.abs(Math.round(event.pageX) - (triggerPointerDownPosRef.current?.x ?? 0)),
						y: Math.abs(Math.round(event.pageY) - (triggerPointerDownPosRef.current?.y ?? 0))
					};
				};
				const handlePointerUp = (event) => {
					if (pointerMoveDelta.x <= 10 && pointerMoveDelta.y <= 10) event.preventDefault();
					else if (!content.contains(event.target)) onOpenChange(false);
					document.removeEventListener("pointermove", handlePointerMove);
					triggerPointerDownPosRef.current = null;
				};
				if (triggerPointerDownPosRef.current !== null) {
					document.addEventListener("pointermove", handlePointerMove);
					document.addEventListener("pointerup", handlePointerUp, {
						capture: true,
						once: true
					});
				}
				return () => {
					document.removeEventListener("pointermove", handlePointerMove);
					document.removeEventListener("pointerup", handlePointerUp, { capture: true });
				};
			}
		}, [
			content,
			onOpenChange,
			triggerPointerDownPosRef
		]);
		y(() => {
			const close = () => onOpenChange(false);
			window.addEventListener("blur", close);
			window.addEventListener("resize", close);
			return () => {
				window.removeEventListener("blur", close);
				window.removeEventListener("resize", close);
			};
		}, [onOpenChange]);
		const [searchRef, handleTypeaheadSearch] = useTypeaheadSearch((search) => {
			const enabledItems = getItems().filter((item) => !item.disabled);
			const nextItem = findNextItem(enabledItems, search, enabledItems.find((item) => item.ref.current === document.activeElement));
			if (nextItem) setTimeout(() => nextItem.ref.current.focus());
		});
		const itemRefCallback = q$1((node, value, disabled) => {
			const isFirstValidItem = !firstValidItemFoundRef.current && !disabled;
			if (context.value !== void 0 && context.value === value || isFirstValidItem) {
				setSelectedItem(node);
				if (isFirstValidItem) firstValidItemFoundRef.current = true;
			}
		}, [context.value]);
		const handleItemLeave = q$1(() => content?.focus(), [content]);
		const itemTextRefCallback = q$1((node, value, disabled) => {
			const isFirstValidItem = !firstValidItemFoundRef.current && !disabled;
			if (context.value !== void 0 && context.value === value || isFirstValidItem) setSelectedItemText(node);
		}, [context.value]);
		const SelectPosition = position === "popper" ? SelectPopperPosition : SelectItemAlignedPosition;
		const popperContentProps = SelectPosition === SelectPopperPosition ? {
			side,
			sideOffset,
			align,
			alignOffset,
			arrowPadding,
			collisionBoundary,
			collisionPadding,
			sticky,
			hideWhenDetached,
			avoidCollisions
		} : {};
		return /* @__PURE__ */ u(SelectContentProvider, {
			scope: __scopeSelect,
			content,
			viewport,
			onViewportChange: setViewport,
			itemRefCallback,
			selectedItem,
			onItemLeave: handleItemLeave,
			itemTextRefCallback,
			focusSelectedItem,
			selectedItemText,
			position,
			isPositioned,
			searchRef,
			children: /* @__PURE__ */ u(ReactRemoveScroll, {
				as: Slot,
				allowPinchZoom: true,
				children: /* @__PURE__ */ u(FocusScope, {
					asChild: true,
					trapped: context.open,
					onMountAutoFocus: (event) => {
						event.preventDefault();
					},
					onUnmountAutoFocus: composeEventHandlers(onCloseAutoFocus, (event) => {
						context.trigger?.focus({ preventScroll: true });
						event.preventDefault();
					}),
					children: /* @__PURE__ */ u(DismissableLayer, {
						asChild: true,
						disableOutsidePointerEvents: true,
						onEscapeKeyDown,
						onPointerDownOutside,
						onFocusOutside: (event) => event.preventDefault(),
						onDismiss: () => context.onOpenChange(false),
						children: /* @__PURE__ */ u(SelectPosition, {
							role: "listbox",
							id: context.contentId,
							"data-state": context.open ? "open" : "closed",
							dir: context.dir,
							onContextMenu: (event) => event.preventDefault(),
							...contentProps,
							...popperContentProps,
							onPlaced: () => setIsPositioned(true),
							ref: composedRefs,
							style: {
								display: "flex",
								flexDirection: "column",
								outline: "none",
								...contentProps.style
							},
							onKeyDown: composeEventHandlers(contentProps.onKeyDown, (event) => {
								const isModifierKey = event.ctrlKey || event.altKey || event.metaKey;
								if (event.key === "Tab") event.preventDefault();
								if (!isModifierKey && event.key.length === 1) handleTypeaheadSearch(event.key);
								if ([
									"ArrowUp",
									"ArrowDown",
									"Home",
									"End"
								].includes(event.key)) {
									let candidateNodes = getItems().filter((item) => !item.disabled).map((item) => item.ref.current);
									if (["ArrowUp", "End"].includes(event.key)) candidateNodes = candidateNodes.slice().reverse();
									if (["ArrowUp", "ArrowDown"].includes(event.key)) {
										const currentElement = event.target;
										const currentIndex = candidateNodes.indexOf(currentElement);
										candidateNodes = candidateNodes.slice(currentIndex + 1);
									}
									setTimeout(() => focusFirst(candidateNodes));
									event.preventDefault();
								}
							})
						})
					})
				})
			})
		});
	});
	SelectContentImpl.displayName = CONTENT_IMPL_NAME;
	var ITEM_ALIGNED_POSITION_NAME = "SelectItemAlignedPosition";
	var SelectItemAlignedPosition = D((props, forwardedRef) => {
		const { __scopeSelect, onPlaced, ...popperProps } = props;
		const context = useSelectContext(CONTENT_NAME, __scopeSelect);
		const contentContext = useSelectContentContext(CONTENT_NAME, __scopeSelect);
		const [contentWrapper, setContentWrapper] = d(null);
		const [content, setContent] = d(null);
		const composedRefs = useComposedRefs(forwardedRef, (node) => setContent(node));
		const getItems = useCollection(__scopeSelect);
		const shouldExpandOnScrollRef = A$1(false);
		const shouldRepositionRef = A$1(true);
		const { viewport, selectedItem, selectedItemText, focusSelectedItem } = contentContext;
		const position = q$1(() => {
			if (context.trigger && context.valueNode && contentWrapper && content && viewport && selectedItem && selectedItemText) {
				const triggerRect = context.trigger.getBoundingClientRect();
				const contentRect = content.getBoundingClientRect();
				const valueNodeRect = context.valueNode.getBoundingClientRect();
				const itemTextRect = selectedItemText.getBoundingClientRect();
				if (context.dir !== "rtl") {
					const itemTextOffset = itemTextRect.left - contentRect.left;
					const left = valueNodeRect.left - itemTextOffset;
					const leftDelta = triggerRect.left - left;
					const minContentWidth = triggerRect.width + leftDelta;
					const contentWidth = Math.max(minContentWidth, contentRect.width);
					const rightEdge = window.innerWidth - CONTENT_MARGIN;
					const clampedLeft = clamp$1(left, [CONTENT_MARGIN, Math.max(CONTENT_MARGIN, rightEdge - contentWidth)]);
					contentWrapper.style.minWidth = minContentWidth + "px";
					contentWrapper.style.left = clampedLeft + "px";
				} else {
					const itemTextOffset = contentRect.right - itemTextRect.right;
					const right = window.innerWidth - valueNodeRect.right - itemTextOffset;
					const rightDelta = window.innerWidth - triggerRect.right - right;
					const minContentWidth = triggerRect.width + rightDelta;
					const contentWidth = Math.max(minContentWidth, contentRect.width);
					const leftEdge = window.innerWidth - CONTENT_MARGIN;
					const clampedRight = clamp$1(right, [CONTENT_MARGIN, Math.max(CONTENT_MARGIN, leftEdge - contentWidth)]);
					contentWrapper.style.minWidth = minContentWidth + "px";
					contentWrapper.style.right = clampedRight + "px";
				}
				const items = getItems();
				const availableHeight = window.innerHeight - CONTENT_MARGIN * 2;
				const itemsHeight = viewport.scrollHeight;
				const contentStyles = window.getComputedStyle(content);
				const contentBorderTopWidth = parseInt(contentStyles.borderTopWidth, 10);
				const contentPaddingTop = parseInt(contentStyles.paddingTop, 10);
				const contentBorderBottomWidth = parseInt(contentStyles.borderBottomWidth, 10);
				const contentPaddingBottom = parseInt(contentStyles.paddingBottom, 10);
				const fullContentHeight = contentBorderTopWidth + contentPaddingTop + itemsHeight + contentPaddingBottom + contentBorderBottomWidth;
				const minContentHeight = Math.min(selectedItem.offsetHeight * 5, fullContentHeight);
				const viewportStyles = window.getComputedStyle(viewport);
				const viewportPaddingTop = parseInt(viewportStyles.paddingTop, 10);
				const viewportPaddingBottom = parseInt(viewportStyles.paddingBottom, 10);
				const topEdgeToTriggerMiddle = triggerRect.top + triggerRect.height / 2 - CONTENT_MARGIN;
				const triggerMiddleToBottomEdge = availableHeight - topEdgeToTriggerMiddle;
				const selectedItemHalfHeight = selectedItem.offsetHeight / 2;
				const itemOffsetMiddle = selectedItem.offsetTop + selectedItemHalfHeight;
				const contentTopToItemMiddle = contentBorderTopWidth + contentPaddingTop + itemOffsetMiddle;
				const itemMiddleToContentBottom = fullContentHeight - contentTopToItemMiddle;
				if (contentTopToItemMiddle <= topEdgeToTriggerMiddle) {
					const isLastItem = items.length > 0 && selectedItem === items[items.length - 1].ref.current;
					contentWrapper.style.bottom = "0px";
					const viewportOffsetBottom = content.clientHeight - viewport.offsetTop - viewport.offsetHeight;
					const height = contentTopToItemMiddle + Math.max(triggerMiddleToBottomEdge, selectedItemHalfHeight + (isLastItem ? viewportPaddingBottom : 0) + viewportOffsetBottom + contentBorderBottomWidth);
					contentWrapper.style.height = height + "px";
				} else {
					const isFirstItem = items.length > 0 && selectedItem === items[0].ref.current;
					contentWrapper.style.top = "0px";
					const height = Math.max(topEdgeToTriggerMiddle, contentBorderTopWidth + viewport.offsetTop + (isFirstItem ? viewportPaddingTop : 0) + selectedItemHalfHeight) + itemMiddleToContentBottom;
					contentWrapper.style.height = height + "px";
					viewport.scrollTop = contentTopToItemMiddle - topEdgeToTriggerMiddle + viewport.offsetTop;
				}
				contentWrapper.style.margin = `${CONTENT_MARGIN}px 0`;
				contentWrapper.style.minHeight = minContentHeight + "px";
				contentWrapper.style.maxHeight = availableHeight + "px";
				onPlaced?.();
				requestAnimationFrame(() => shouldExpandOnScrollRef.current = true);
			}
		}, [
			getItems,
			context.trigger,
			context.valueNode,
			contentWrapper,
			content,
			viewport,
			selectedItem,
			selectedItemText,
			context.dir,
			onPlaced
		]);
		useLayoutEffect2(() => position(), [position]);
		const [contentZIndex, setContentZIndex] = d();
		useLayoutEffect2(() => {
			if (content) setContentZIndex(window.getComputedStyle(content).zIndex);
		}, [content]);
		return /* @__PURE__ */ u(SelectViewportProvider, {
			scope: __scopeSelect,
			contentWrapper,
			shouldExpandOnScrollRef,
			onScrollButtonChange: q$1((node) => {
				if (node && shouldRepositionRef.current === true) {
					position();
					focusSelectedItem?.();
					shouldRepositionRef.current = false;
				}
			}, [position, focusSelectedItem]),
			children: /* @__PURE__ */ u("div", {
				ref: setContentWrapper,
				style: {
					display: "flex",
					flexDirection: "column",
					position: "fixed",
					zIndex: contentZIndex
				},
				children: /* @__PURE__ */ u(Primitive.div, {
					...popperProps,
					ref: composedRefs,
					style: {
						boxSizing: "border-box",
						maxHeight: "100%",
						...popperProps.style
					}
				})
			})
		});
	});
	SelectItemAlignedPosition.displayName = ITEM_ALIGNED_POSITION_NAME;
	var POPPER_POSITION_NAME = "SelectPopperPosition";
	var SelectPopperPosition = D((props, forwardedRef) => {
		const { __scopeSelect, align = "start", collisionPadding = CONTENT_MARGIN, ...popperProps } = props;
		return /* @__PURE__ */ u(Content, {
			...usePopperScope(__scopeSelect),
			...popperProps,
			ref: forwardedRef,
			align,
			collisionPadding,
			style: {
				boxSizing: "border-box",
				...popperProps.style,
				"--radix-select-content-transform-origin": "var(--radix-popper-transform-origin)",
				"--radix-select-content-available-width": "var(--radix-popper-available-width)",
				"--radix-select-content-available-height": "var(--radix-popper-available-height)",
				"--radix-select-trigger-width": "var(--radix-popper-anchor-width)",
				"--radix-select-trigger-height": "var(--radix-popper-anchor-height)"
			}
		});
	});
	SelectPopperPosition.displayName = POPPER_POSITION_NAME;
	var [SelectViewportProvider, useSelectViewportContext] = createSelectContext(CONTENT_NAME, {});
	var VIEWPORT_NAME = "SelectViewport";
	var SelectViewport = D((props, forwardedRef) => {
		const { __scopeSelect, nonce, ...viewportProps } = props;
		const contentContext = useSelectContentContext(VIEWPORT_NAME, __scopeSelect);
		const viewportContext = useSelectViewportContext(VIEWPORT_NAME, __scopeSelect);
		const composedRefs = useComposedRefs(forwardedRef, contentContext.onViewportChange);
		const prevScrollTopRef = A$1(0);
		return /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u("style", {
			dangerouslySetInnerHTML: { __html: `[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}` },
			nonce
		}), /* @__PURE__ */ u(Collection.Slot, {
			scope: __scopeSelect,
			children: /* @__PURE__ */ u(Primitive.div, {
				"data-radix-select-viewport": "",
				role: "presentation",
				...viewportProps,
				ref: composedRefs,
				style: {
					position: "relative",
					flex: 1,
					overflow: "hidden auto",
					...viewportProps.style
				},
				onScroll: composeEventHandlers(viewportProps.onScroll, (event) => {
					const viewport = event.currentTarget;
					const { contentWrapper, shouldExpandOnScrollRef } = viewportContext;
					if (shouldExpandOnScrollRef?.current && contentWrapper) {
						const scrolledBy = Math.abs(prevScrollTopRef.current - viewport.scrollTop);
						if (scrolledBy > 0) {
							const availableHeight = window.innerHeight - CONTENT_MARGIN * 2;
							const cssMinHeight = parseFloat(contentWrapper.style.minHeight);
							const cssHeight = parseFloat(contentWrapper.style.height);
							const prevHeight = Math.max(cssMinHeight, cssHeight);
							if (prevHeight < availableHeight) {
								const nextHeight = prevHeight + scrolledBy;
								const clampedNextHeight = Math.min(availableHeight, nextHeight);
								const heightDiff = nextHeight - clampedNextHeight;
								contentWrapper.style.height = clampedNextHeight + "px";
								if (contentWrapper.style.bottom === "0px") {
									viewport.scrollTop = heightDiff > 0 ? heightDiff : 0;
									contentWrapper.style.justifyContent = "flex-end";
								}
							}
						}
					}
					prevScrollTopRef.current = viewport.scrollTop;
				})
			})
		})] });
	});
	SelectViewport.displayName = VIEWPORT_NAME;
	var GROUP_NAME = "SelectGroup";
	var [SelectGroupContextProvider, useSelectGroupContext] = createSelectContext(GROUP_NAME);
	var SelectGroup = D((props, forwardedRef) => {
		const { __scopeSelect, ...groupProps } = props;
		const groupId = useId();
		return /* @__PURE__ */ u(SelectGroupContextProvider, {
			scope: __scopeSelect,
			id: groupId,
			children: /* @__PURE__ */ u(Primitive.div, {
				role: "group",
				"aria-labelledby": groupId,
				...groupProps,
				ref: forwardedRef
			})
		});
	});
	SelectGroup.displayName = GROUP_NAME;
	var LABEL_NAME = "SelectLabel";
	var SelectLabel = D((props, forwardedRef) => {
		const { __scopeSelect, ...labelProps } = props;
		const groupContext = useSelectGroupContext(LABEL_NAME, __scopeSelect);
		return /* @__PURE__ */ u(Primitive.div, {
			id: groupContext.id,
			...labelProps,
			ref: forwardedRef
		});
	});
	SelectLabel.displayName = LABEL_NAME;
	var ITEM_NAME = "SelectItem";
	var [SelectItemContextProvider, useSelectItemContext] = createSelectContext(ITEM_NAME);
	var SelectItem = D((props, forwardedRef) => {
		const { __scopeSelect, value, disabled = false, textValue: textValueProp, ...itemProps } = props;
		const context = useSelectContext(ITEM_NAME, __scopeSelect);
		const contentContext = useSelectContentContext(ITEM_NAME, __scopeSelect);
		const isSelected = context.value === value;
		const [textValue, setTextValue] = d(textValueProp ?? "");
		const [isFocused, setIsFocused] = d(false);
		const composedRefs = useComposedRefs(forwardedRef, (node) => contentContext.itemRefCallback?.(node, value, disabled));
		const textId = useId();
		const pointerTypeRef = A$1("touch");
		const handleSelect = () => {
			if (!disabled) {
				context.onValueChange(value);
				context.onOpenChange(false);
			}
		};
		if (value === "") throw new Error("A <Select.Item /> must have a value prop that is not an empty string. This is because the Select value can be set to an empty string to clear the selection and show the placeholder.");
		return /* @__PURE__ */ u(SelectItemContextProvider, {
			scope: __scopeSelect,
			value,
			disabled,
			textId,
			isSelected,
			onItemTextChange: q$1((node) => {
				setTextValue((prevTextValue) => prevTextValue || (node?.textContent ?? "").trim());
			}, []),
			children: /* @__PURE__ */ u(Collection.ItemSlot, {
				scope: __scopeSelect,
				value,
				disabled,
				textValue,
				children: /* @__PURE__ */ u(Primitive.div, {
					role: "option",
					"aria-labelledby": textId,
					"data-highlighted": isFocused ? "" : void 0,
					"aria-selected": isSelected && isFocused,
					"data-state": isSelected ? "checked" : "unchecked",
					"aria-disabled": disabled || void 0,
					"data-disabled": disabled ? "" : void 0,
					tabIndex: disabled ? void 0 : -1,
					...itemProps,
					ref: composedRefs,
					onFocus: composeEventHandlers(itemProps.onFocus, () => setIsFocused(true)),
					onBlur: composeEventHandlers(itemProps.onBlur, () => setIsFocused(false)),
					onClick: composeEventHandlers(itemProps.onClick, () => {
						if (pointerTypeRef.current !== "mouse") handleSelect();
					}),
					onPointerUp: composeEventHandlers(itemProps.onPointerUp, () => {
						if (pointerTypeRef.current === "mouse") handleSelect();
					}),
					onPointerDown: composeEventHandlers(itemProps.onPointerDown, (event) => {
						pointerTypeRef.current = event.pointerType;
					}),
					onPointerMove: composeEventHandlers(itemProps.onPointerMove, (event) => {
						pointerTypeRef.current = event.pointerType;
						if (disabled) contentContext.onItemLeave?.();
						else if (pointerTypeRef.current === "mouse") event.currentTarget.focus({ preventScroll: true });
					}),
					onPointerLeave: composeEventHandlers(itemProps.onPointerLeave, (event) => {
						if (event.currentTarget === document.activeElement) contentContext.onItemLeave?.();
					}),
					onKeyDown: composeEventHandlers(itemProps.onKeyDown, (event) => {
						if (contentContext.searchRef?.current !== "" && event.key === " ") return;
						if (SELECTION_KEYS.includes(event.key)) handleSelect();
						if (event.key === " ") event.preventDefault();
					})
				})
			})
		});
	});
	SelectItem.displayName = ITEM_NAME;
	var ITEM_TEXT_NAME = "SelectItemText";
	var SelectItemText = D((props, forwardedRef) => {
		const { __scopeSelect, className, style, ...itemTextProps } = props;
		const context = useSelectContext(ITEM_TEXT_NAME, __scopeSelect);
		const contentContext = useSelectContentContext(ITEM_TEXT_NAME, __scopeSelect);
		const itemContext = useSelectItemContext(ITEM_TEXT_NAME, __scopeSelect);
		const nativeOptionsContext = useSelectNativeOptionsContext(ITEM_TEXT_NAME, __scopeSelect);
		const [itemTextNode, setItemTextNode] = d(null);
		const composedRefs = useComposedRefs(forwardedRef, (node) => setItemTextNode(node), itemContext.onItemTextChange, (node) => contentContext.itemTextRefCallback?.(node, itemContext.value, itemContext.disabled));
		const textContent = itemTextNode?.textContent;
		const nativeOption = T$1(() => /* @__PURE__ */ u("option", {
			value: itemContext.value,
			disabled: itemContext.disabled,
			children: textContent
		}, itemContext.value), [
			itemContext.disabled,
			itemContext.value,
			textContent
		]);
		const { onNativeOptionAdd, onNativeOptionRemove } = nativeOptionsContext;
		useLayoutEffect2(() => {
			onNativeOptionAdd(nativeOption);
			return () => onNativeOptionRemove(nativeOption);
		}, [
			onNativeOptionAdd,
			onNativeOptionRemove,
			nativeOption
		]);
		return /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u(Primitive.span, {
			id: itemContext.textId,
			...itemTextProps,
			ref: composedRefs
		}), itemContext.isSelected && context.valueNode && !context.valueNodeHasChildren ? $(itemTextProps.children, context.valueNode) : null] });
	});
	SelectItemText.displayName = ITEM_TEXT_NAME;
	var ITEM_INDICATOR_NAME = "SelectItemIndicator";
	var SelectItemIndicator = D((props, forwardedRef) => {
		const { __scopeSelect, ...itemIndicatorProps } = props;
		return useSelectItemContext(ITEM_INDICATOR_NAME, __scopeSelect).isSelected ? /* @__PURE__ */ u(Primitive.span, {
			"aria-hidden": true,
			...itemIndicatorProps,
			ref: forwardedRef
		}) : null;
	});
	SelectItemIndicator.displayName = ITEM_INDICATOR_NAME;
	var SCROLL_UP_BUTTON_NAME = "SelectScrollUpButton";
	var SelectScrollUpButton = D((props, forwardedRef) => {
		const contentContext = useSelectContentContext(SCROLL_UP_BUTTON_NAME, props.__scopeSelect);
		const viewportContext = useSelectViewportContext(SCROLL_UP_BUTTON_NAME, props.__scopeSelect);
		const [canScrollUp, setCanScrollUp] = d(false);
		const composedRefs = useComposedRefs(forwardedRef, viewportContext.onScrollButtonChange);
		useLayoutEffect2(() => {
			if (contentContext.viewport && contentContext.isPositioned) {
				let handleScroll2 = function() {
					setCanScrollUp(viewport.scrollTop > 0);
				};
				const viewport = contentContext.viewport;
				handleScroll2();
				viewport.addEventListener("scroll", handleScroll2);
				return () => viewport.removeEventListener("scroll", handleScroll2);
			}
		}, [contentContext.viewport, contentContext.isPositioned]);
		return canScrollUp ? /* @__PURE__ */ u(SelectScrollButtonImpl, {
			...props,
			ref: composedRefs,
			onAutoScroll: () => {
				const { viewport, selectedItem } = contentContext;
				if (viewport && selectedItem) viewport.scrollTop = viewport.scrollTop - selectedItem.offsetHeight;
			}
		}) : null;
	});
	SelectScrollUpButton.displayName = SCROLL_UP_BUTTON_NAME;
	var SCROLL_DOWN_BUTTON_NAME = "SelectScrollDownButton";
	var SelectScrollDownButton = D((props, forwardedRef) => {
		const contentContext = useSelectContentContext(SCROLL_DOWN_BUTTON_NAME, props.__scopeSelect);
		const viewportContext = useSelectViewportContext(SCROLL_DOWN_BUTTON_NAME, props.__scopeSelect);
		const [canScrollDown, setCanScrollDown] = d(false);
		const composedRefs = useComposedRefs(forwardedRef, viewportContext.onScrollButtonChange);
		useLayoutEffect2(() => {
			if (contentContext.viewport && contentContext.isPositioned) {
				let handleScroll2 = function() {
					const maxScroll = viewport.scrollHeight - viewport.clientHeight;
					setCanScrollDown(Math.ceil(viewport.scrollTop) < maxScroll);
				};
				const viewport = contentContext.viewport;
				handleScroll2();
				viewport.addEventListener("scroll", handleScroll2);
				return () => viewport.removeEventListener("scroll", handleScroll2);
			}
		}, [contentContext.viewport, contentContext.isPositioned]);
		return canScrollDown ? /* @__PURE__ */ u(SelectScrollButtonImpl, {
			...props,
			ref: composedRefs,
			onAutoScroll: () => {
				const { viewport, selectedItem } = contentContext;
				if (viewport && selectedItem) viewport.scrollTop = viewport.scrollTop + selectedItem.offsetHeight;
			}
		}) : null;
	});
	SelectScrollDownButton.displayName = SCROLL_DOWN_BUTTON_NAME;
	var SelectScrollButtonImpl = D((props, forwardedRef) => {
		const { __scopeSelect, onAutoScroll, ...scrollIndicatorProps } = props;
		const contentContext = useSelectContentContext("SelectScrollButton", __scopeSelect);
		const autoScrollTimerRef = A$1(null);
		const getItems = useCollection(__scopeSelect);
		const clearAutoScrollTimer = q$1(() => {
			if (autoScrollTimerRef.current !== null) {
				window.clearInterval(autoScrollTimerRef.current);
				autoScrollTimerRef.current = null;
			}
		}, []);
		y(() => {
			return () => clearAutoScrollTimer();
		}, [clearAutoScrollTimer]);
		useLayoutEffect2(() => {
			getItems().find((item) => item.ref.current === document.activeElement)?.ref.current?.scrollIntoView({ block: "nearest" });
		}, [getItems]);
		return /* @__PURE__ */ u(Primitive.div, {
			"aria-hidden": true,
			...scrollIndicatorProps,
			ref: forwardedRef,
			style: {
				flexShrink: 0,
				...scrollIndicatorProps.style
			},
			onPointerDown: composeEventHandlers(scrollIndicatorProps.onPointerDown, () => {
				if (autoScrollTimerRef.current === null) autoScrollTimerRef.current = window.setInterval(onAutoScroll, 50);
			}),
			onPointerMove: composeEventHandlers(scrollIndicatorProps.onPointerMove, () => {
				contentContext.onItemLeave?.();
				if (autoScrollTimerRef.current === null) autoScrollTimerRef.current = window.setInterval(onAutoScroll, 50);
			}),
			onPointerLeave: composeEventHandlers(scrollIndicatorProps.onPointerLeave, () => {
				clearAutoScrollTimer();
			})
		});
	});
	var SEPARATOR_NAME = "SelectSeparator";
	var SelectSeparator = D((props, forwardedRef) => {
		const { __scopeSelect, ...separatorProps } = props;
		return /* @__PURE__ */ u(Primitive.div, {
			"aria-hidden": true,
			...separatorProps,
			ref: forwardedRef
		});
	});
	SelectSeparator.displayName = SEPARATOR_NAME;
	var ARROW_NAME = "SelectArrow";
	var SelectArrow = D((props, forwardedRef) => {
		const { __scopeSelect, ...arrowProps } = props;
		const popperScope = usePopperScope(__scopeSelect);
		const context = useSelectContext(ARROW_NAME, __scopeSelect);
		const contentContext = useSelectContentContext(ARROW_NAME, __scopeSelect);
		return context.open && contentContext.position === "popper" ? /* @__PURE__ */ u(Arrow, {
			...popperScope,
			...arrowProps,
			ref: forwardedRef
		}) : null;
	});
	SelectArrow.displayName = ARROW_NAME;
	var BUBBLE_INPUT_NAME = "SelectBubbleInput";
	var SelectBubbleInput = D(({ __scopeSelect, value, ...props }, forwardedRef) => {
		const ref = A$1(null);
		const composedRefs = useComposedRefs(forwardedRef, ref);
		const prevValue = usePrevious(value);
		y(() => {
			const select = ref.current;
			if (!select) return;
			const selectProto = window.HTMLSelectElement.prototype;
			const setValue = Object.getOwnPropertyDescriptor(selectProto, "value").set;
			if (prevValue !== value && setValue) {
				const event = new Event("change", { bubbles: true });
				setValue.call(select, value);
				select.dispatchEvent(event);
			}
		}, [prevValue, value]);
		return /* @__PURE__ */ u(Primitive.select, {
			...props,
			style: {
				...VISUALLY_HIDDEN_STYLES,
				...props.style
			},
			ref: composedRefs,
			defaultValue: value
		});
	});
	SelectBubbleInput.displayName = BUBBLE_INPUT_NAME;
	function shouldShowPlaceholder(value) {
		return value === "" || value === void 0;
	}
	function useTypeaheadSearch(onSearchChange) {
		const handleSearchChange = useCallbackRef$1(onSearchChange);
		const searchRef = A$1("");
		const timerRef = A$1(0);
		const handleTypeaheadSearch = q$1((key) => {
			const search = searchRef.current + key;
			handleSearchChange(search);
			(function updateSearch(value) {
				searchRef.current = value;
				window.clearTimeout(timerRef.current);
				if (value !== "") timerRef.current = window.setTimeout(() => updateSearch(""), 1e3);
			})(search);
		}, [handleSearchChange]);
		const resetTypeahead = q$1(() => {
			searchRef.current = "";
			window.clearTimeout(timerRef.current);
		}, []);
		y(() => {
			return () => window.clearTimeout(timerRef.current);
		}, []);
		return [
			searchRef,
			handleTypeaheadSearch,
			resetTypeahead
		];
	}
	function findNextItem(items, search, currentItem) {
		const normalizedSearch = search.length > 1 && Array.from(search).every((char) => char === search[0]) ? search[0] : search;
		const currentItemIndex = currentItem ? items.indexOf(currentItem) : -1;
		let wrappedItems = wrapArray(items, Math.max(currentItemIndex, 0));
		if (normalizedSearch.length === 1) wrappedItems = wrappedItems.filter((v) => v !== currentItem);
		const nextItem = wrappedItems.find((item) => item.textValue.toLowerCase().startsWith(normalizedSearch.toLowerCase()));
		return nextItem !== currentItem ? nextItem : void 0;
	}
	function wrapArray(array, startIndex) {
		return array.map((_, index) => array[(startIndex + index) % array.length]);
	}
	var Root2 = Select;
	var Trigger = SelectTrigger;
	var Value = SelectValue;
	var Icon = SelectIcon;
	var Portal = SelectPortal;
	var Content2 = SelectContent;
	var Viewport = SelectViewport;
	var Item = SelectItem;
	var ItemText = SelectItemText;
	var ItemIndicator = SelectItemIndicator;
	//#endregion
	//#region src/components/primitives/radix-select.tsx
	var EMPTY_SENTINEL = "__codemem-empty-select__";
	function encodeValue(value) {
		return value === "" ? EMPTY_SENTINEL : value;
	}
	function decodeValue(value) {
		return value === EMPTY_SENTINEL ? "" : value;
	}
	function RadixSelect({ ariaLabel, className, contentClassName, disabled = false, id, itemClassName, onValueChange, options, placeholder, triggerClassName, value, viewportClassName }) {
		return /* @__PURE__ */ u(Root2, {
			disabled,
			onValueChange: (nextValue) => onValueChange(decodeValue(nextValue)),
			value: value ? encodeValue(value) : void 0,
			children: [/* @__PURE__ */ u(Trigger, {
				"aria-label": ariaLabel ?? placeholder,
				className: triggerClassName ?? className,
				"data-value": value,
				id,
				type: "button",
				children: [/* @__PURE__ */ u(Value, { placeholder }), /* @__PURE__ */ u(Icon, {
					className: "sync-radix-select-icon",
					"aria-hidden": "true",
					children: "▾"
				})]
			}), /* @__PURE__ */ u(Portal, { children: /* @__PURE__ */ u(Content2, {
				className: contentClassName,
				position: "popper",
				children: /* @__PURE__ */ u(Viewport, {
					className: viewportClassName,
					children: options.map((option) => /* @__PURE__ */ u(Item, {
						className: itemClassName,
						disabled: option.disabled,
						value: encodeValue(option.value),
						children: [/* @__PURE__ */ u(ItemText, { children: option.label }), /* @__PURE__ */ u(ItemIndicator, {
							className: "sync-radix-select-indicator",
							children: "✓"
						})]
					}, encodeValue(option.value)))
				})
			}) })]
		});
	}
	//#endregion
	//#region src/tabs/sync/team-sync.ts
	var TEAM_SYNC_ACTIONS_MOUNT_ID = "syncTeamActionsMount";
	var INVITE_POLICY_OPTIONS = [{
		value: "auto_admit",
		label: "Auto-admit"
	}, {
		value: "approval_required",
		label: "Approval required"
	}];
	var invitePolicyValue = "auto_admit";
	function renderAdminSetupDisclosure() {
		const mount = document.getElementById("syncAdminDisclosureMount");
		if (!mount) return;
		renderTeamSetupDisclosure(mount, {
			open: adminSetupExpanded,
			onOpenChange: (open) => {
				setAdminSetupExpanded(open);
				renderAdminSetupDisclosure();
				renderInvitePolicySelect();
				setInviteOutputVisibility();
			}
		});
	}
	function ensureInvitePanelInAdminSection() {}
	function ensureJoinPanelInSetupSection() {
		const joinPanel = document.getElementById("syncJoinPanel");
		const joinSection = document.getElementById("syncJoinSection");
		if (!joinPanel || !joinSection) return;
		if (joinPanel.parentElement !== joinSection) joinSection.appendChild(joinPanel);
	}
	function setInviteOutputVisibility() {
		const syncInviteOutput = document.getElementById("syncInviteOutput");
		const syncInviteWarnings = document.getElementById("syncInviteWarnings");
		if (!syncInviteOutput) return;
		const encoded = String(state.lastTeamInvite?.encoded || "").trim();
		syncInviteOutput.value = encoded;
		syncInviteOutput.hidden = !encoded;
		if (syncInviteWarnings) {
			const warnings = Array.isArray(state.lastTeamInvite?.warnings) ? state.lastTeamInvite.warnings : [];
			syncInviteWarnings.textContent = warnings.join(" · ");
			syncInviteWarnings.hidden = warnings.length === 0;
		}
	}
	function setJoinFeedbackVisibility() {
		const syncJoinFeedback = document.getElementById("syncJoinFeedback");
		if (!syncJoinFeedback) return;
		const feedback = state.syncJoinFlowFeedback;
		syncJoinFeedback.textContent = feedback?.message || "";
		syncJoinFeedback.hidden = !feedback?.message;
		syncJoinFeedback.setAttribute("role", feedback?.tone === "warning" ? "alert" : "status");
		syncJoinFeedback.setAttribute("aria-live", feedback?.tone === "warning" ? "assertive" : "polite");
		syncJoinFeedback.className = `peer-meta${feedback ? ` ${feedback.tone === "warning" ? "sync-inline-feedback warning" : "sync-inline-feedback success"}` : ""}`;
	}
	function clearContent(node) {
		if (node) node.textContent = "";
	}
	function pulseAttentionTarget(target) {
		if (!(target instanceof HTMLElement)) return;
		target.classList.remove("sync-attention-target");
		target.offsetWidth;
		target.classList.add("sync-attention-target");
		window.setTimeout(() => target.classList.remove("sync-attention-target"), 900);
	}
	function prefersReducedMotion() {
		return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	}
	function syncScrollBehavior() {
		return prefersReducedMotion() ? "auto" : "smooth";
	}
	function renderInvitePolicySelect() {
		const mount = document.getElementById("syncInvitePolicyMount");
		if (!mount) return;
		renderIntoSyncMount(mount, _$1(RadixSelect, {
			ariaLabel: "Join policy",
			contentClassName: "sync-radix-select-content sync-actor-select-content",
			id: "syncInvitePolicy",
			itemClassName: "sync-radix-select-item",
			onValueChange: (value) => {
				const nextValue = value === "approval_required" ? "approval_required" : "auto_admit";
				if (nextValue === invitePolicyValue) return;
				invitePolicyValue = nextValue;
				renderInvitePolicySelect();
			},
			options: INVITE_POLICY_OPTIONS,
			triggerClassName: "sync-radix-select-trigger sync-actor-select",
			value: invitePolicyValue,
			viewportClassName: "sync-radix-select-viewport"
		}));
	}
	function teardownTeamSyncRender(actions, targets) {
		const mount = document.getElementById(TEAM_SYNC_ACTIONS_MOUNT_ID);
		if (mount) {
			clearSyncMount(mount);
			mount.remove();
		}
		clearContent(actions);
		targets.forEach((target) => clearContent(target));
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
		const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
		if (!items.length) {
			clearSyncMount(list);
			panel.hidden = true;
			return;
		}
		panel.hidden = false;
		meta.textContent = `Teammates receive memories from ${state.currentProject ? `current project (${state.currentProject})` : "all allowed projects"} by default. Use Only me on a memory when it should stay local.`;
		renderIntoSyncMount(list, _$1(SyncSharingReview, {
			items: items.map((item) => ({
				actorDisplayName: String(item.actor_display_name || item.actor_id || "unknown"),
				actorId: String(item.actor_id || "unknown"),
				peerName: String(item.peer_name || item.peer_device_id || "Device"),
				privateCount: Number(item.private_count || 0),
				scopeLabel: String(item.scope_label || "All allowed projects"),
				shareableCount: Number(item.shareable_count || 0)
			})),
			onReview: openFeedSharingReview
		}));
	}
	var _loadSyncData$1 = async () => {};
	function setLoadSyncData$1(fn) {
		_loadSyncData$1 = fn;
	}
	function renderTeamSync() {
		const meta = document.getElementById("syncTeamMeta");
		const setupPanel = document.getElementById("syncSetupPanel");
		const list = document.getElementById("syncTeamStatus");
		const listHeading = list?.previousElementSibling;
		const actions = document.getElementById("syncTeamActions");
		if (!meta || !setupPanel || !list || !actions) return;
		renderAdminSetupDisclosure();
		renderInvitePolicySelect();
		setInviteOutputVisibility();
		setJoinFeedbackVisibility();
		const invitePanel = document.getElementById("syncInvitePanel");
		const inviteRestoreParent = document.getElementById("syncAdminSection");
		const joinPanel = document.getElementById("syncJoinPanel");
		const joinRestoreParent = document.getElementById("syncJoinSection");
		const joinRequests = document.getElementById("syncJoinRequests");
		const discoveredPanel = document.getElementById("syncCoordinatorDiscovered");
		const discoveredMeta = document.getElementById("syncCoordinatorDiscoveredMeta");
		const discoveredList = document.getElementById("syncCoordinatorDiscoveredList");
		hideSkeleton("syncTeamSkeleton");
		ensureInvitePanelInAdminSection();
		ensureJoinPanelInSetupSection();
		const coordinator = state.lastSyncCoordinator;
		const syncView = state.lastSyncViewModel || {
			summary: {
				connectedDeviceCount: 0,
				seenOnTeamCount: 0,
				offlineTeamDeviceCount: 0
			},
			duplicatePeople: [],
			attentionItems: []
		};
		const focusAttentionTarget = (item) => {
			if (item.kind === "possible-duplicate-person") {
				const actorList = document.getElementById("syncActorsList");
				if (actorList instanceof HTMLElement) {
					actorList.scrollIntoView({
						block: "center",
						behavior: syncScrollBehavior()
					});
					pulseAttentionTarget(actorList);
				}
				return;
			}
			const deviceId = String(item.deviceId || "").trim();
			if (!deviceId) return;
			if (item.kind === "name-device") {
				const renameInput = document.querySelector(`[data-device-name-input="${CSS.escape(deviceId)}"]`);
				if (renameInput instanceof HTMLInputElement) {
					renameInput.scrollIntoView({
						block: "center",
						behavior: syncScrollBehavior()
					});
					renameInput.focus();
					renameInput.select();
					pulseAttentionTarget(renameInput);
					return;
				}
			}
			const peerCard = document.querySelector(`[data-peer-device-id="${CSS.escape(deviceId)}"]`);
			if (peerCard instanceof HTMLElement) {
				peerCard.scrollIntoView({
					block: "center",
					behavior: syncScrollBehavior()
				});
				pulseAttentionTarget(peerCard);
				return;
			}
			const discoveredRow = document.querySelector(`[data-discovered-device-id="${CSS.escape(deviceId)}"]`);
			if (discoveredRow instanceof HTMLElement) {
				discoveredRow.scrollIntoView({
					block: "center",
					behavior: syncScrollBehavior()
				});
				pulseAttentionTarget(discoveredRow);
			}
		};
		const reviewDuplicatePeople = async (item) => {
			const actorIds = Array.isArray(item.actorIds) ? item.actorIds.map((value) => String(value || "").trim()).filter(Boolean) : [];
			const actors = (Array.isArray(state.lastSyncActors) ? state.lastSyncActors : []).filter((actor) => actorIds.includes(String(actor?.actor_id || "").trim()));
			if (actors.length < 2) {
				showGlobalNotice("This duplicate review is outdated. Refresh the card and review the remaining people entries.", "warning");
				return;
			}
			const result = await openDuplicatePersonDialog({
				title: "Review possible duplicate people",
				summary: item.title.replace(/^Possible duplicate person:\s*/, ""),
				actors: actors.map((actor) => ({
					actorId: String(actor?.actor_id || ""),
					label: String(actor?.display_name || actor?.actor_id || "Unknown person"),
					isLocal: Boolean(actor?.is_local)
				}))
			});
			if (result.action === "different-people") {
				saveDuplicatePersonDecision(actorIds, "different-people");
				showGlobalNotice("Okay. I will keep these people separate on this device.");
				await _loadSyncData$1();
				return;
			}
			if (result.action !== "merge") return;
			const primary = actors.find((actor) => String(actor?.actor_id || "") === result.primaryActorId);
			const secondary = actors.find((actor) => String(actor?.actor_id || "") === result.secondaryActorId);
			if (!primary?.actor_id || !secondary?.actor_id) {
				showGlobalNotice("Could not determine which people to combine. Refresh People & devices and try the review again.", "warning");
				return;
			}
			try {
				await mergeActor(String(primary.actor_id), String(secondary.actor_id));
				clearDuplicatePersonDecision(actorIds);
				showGlobalNotice(`Combined duplicate people into ${String(primary.display_name || primary.actor_id)}.`);
				await _loadSyncData$1();
			} catch (error) {
				try {
					await _loadSyncData$1();
				} catch {}
				showGlobalNotice(friendlyError(error, "Failed to combine these people."), "warning");
			}
		};
		const reviewDiscoveredDeviceName = async (suggestedName) => {
			return await openSyncInputDialog({
				title: "Review device",
				description: "Choose a friendly name for this device before connecting it on this machine.",
				initialValue: suggestedName,
				placeholder: "Desk Mini",
				confirmLabel: "Connect device",
				cancelLabel: "Cancel",
				validate: (nextValue) => nextValue.trim() ? null : "Enter a device name to connect this device."
			});
		};
		const configured = Boolean(coordinator && coordinator.configured);
		meta.textContent = configured ? `Team: ${(coordinator.groups || []).join(", ") || "none"}` : "Start by joining an existing team or creating one, then connect people and devices.";
		meta.title = configured ? String(coordinator.coordinator_url || "").trim() : "";
		if (!configured) {
			teardownTeamSyncRender(actions, [
				list,
				joinRequests,
				discoveredList
			]);
			setupPanel.hidden = false;
			list.hidden = true;
			if (listHeading) listHeading.hidden = true;
			actions.hidden = true;
			if (joinRequests) joinRequests.hidden = true;
			if (discoveredPanel) discoveredPanel.hidden = true;
			return;
		}
		setupPanel.hidden = true;
		list.hidden = false;
		if (listHeading) listHeading.hidden = false;
		actions.hidden = false;
		const presenceStatus = String(coordinator.presence_status || "");
		const presenceLabel = presenceStatus === "posted" ? "Connected" : presenceStatus === "not_enrolled" ? "Needs enrollment" : "Connection error";
		const localPeers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
		const attentionItems = Array.isArray(syncView.attentionItems) ? syncView.attentionItems : [];
		const connectedCount = Number(syncView.summary?.connectedDeviceCount || 0);
		const seenOnTeamCount = Number(syncView.summary?.seenOnTeamCount || 0);
		const offlineTeamDeviceCount = Number(syncView.summary?.offlineTeamDeviceCount || 0);
		const metricParts = [`Connected ${connectedCount}`, `Team ${seenOnTeamCount}`];
		if (offlineTeamDeviceCount > 0) metricParts.push(`Offline ${offlineTeamDeviceCount}`);
		const discoveredRows = (Array.isArray(coordinator.discovered_devices) ? coordinator.discovered_devices : []).map((device) => {
			const deviceId = String(device.device_id || "").trim();
			const displayName = resolveFriendlyDeviceName({
				coordinatorName: String(device.display_name || "").trim(),
				deviceId
			}) || "Discovered device";
			const displayTitle = deviceId && displayName !== deviceId ? deviceId : null;
			const fingerprint = String(device.fingerprint || "").trim();
			const hasAmbiguousCoordinatorGroup = (Array.isArray(device.groups) ? device.groups.map((value) => String(value || "").trim()).filter(Boolean) : []).length > 1;
			const pairedPeer = localPeers.find((peer) => String(peer?.peer_device_id || "") === deviceId);
			const approvalSummary = deriveCoordinatorApprovalSummary({
				device,
				pairedLocally: Boolean(pairedPeer)
			});
			const pairedFingerprint = String(pairedPeer?.fingerprint || "").trim();
			const hasConflict = Boolean(pairedPeer) && Boolean(fingerprint) && Boolean(pairedFingerprint) && pairedFingerprint !== fingerprint;
			const canAccept = Boolean(deviceId) && Boolean(fingerprint) && !pairedPeer && !device.stale && !hasAmbiguousCoordinatorGroup;
			const addresses = Array.isArray(device.addresses) ? device.addresses : [];
			const noteParts = [addresses.length ? addresses.map((address) => isSyncRedactionEnabled() ? redactAddress(String(address || "")) : String(address || "")).filter(Boolean).join(" · ") : "No fresh addresses"];
			if (!addresses.length && displayTitle) noteParts.push(`device id: ${deviceId}`);
			let actionMessage = null;
			let mode = canAccept ? "accept" : "none";
			let pairedMessage = null;
			if (hasConflict) mode = "conflict";
			else if (hasAmbiguousCoordinatorGroup) {
				actionMessage = "This device appears in multiple coordinator groups. Review team setup first or ask an admin to clean up the duplicate enrollment before approving it here.";
				mode = "ambiguous";
			} else if (pairedPeer && isPeerScopeReviewPending(deviceId)) {
				actionMessage = `Finish this device's scope review in People & devices before you sync it.`;
				mode = "scope-pending";
			} else if (pairedPeer?.last_error) {
				noteParts.push(`error: ${String(pairedPeer.last_error)}`);
				mode = "paired";
			} else if (pairedPeer?.status?.peer_state) {
				noteParts.push(`status: ${String(pairedPeer.status.peer_state)}`);
				mode = "paired";
			} else if (!pairedPeer && device.stale) {
				actionMessage = "Wait for a fresh coordinator presence update, then review this device again here.";
				mode = "stale";
			} else if (pairedPeer) mode = "paired";
			if (mode === "paired") pairedMessage = approvalSummary.state === "waiting-for-other-device" ? approvalSummary.description || "Waiting on the other device." : String(pairedPeer?.last_error || "").toLowerCase().includes("401") && String(pairedPeer?.last_error || "").toLowerCase().includes("unauthorized") ? "Waiting for the other device to trust this one before sync can work." : null;
			return {
				actionMessage,
				actionLabel: approvalSummary.actionLabel || "Review device",
				approvalBadgeLabel: approvalSummary.badgeLabel,
				availabilityLabel: device.stale ? "Offline" : "Available",
				connectionLabel: hasConflict ? SYNC_TERMINOLOGY.conflicts : pairedPeer ? SYNC_TERMINOLOGY.pairedLocally : "Not connected on this device",
				deviceId,
				displayName,
				displayTitle,
				fingerprint,
				mode,
				note: noteParts.join(" · "),
				pairedMessage
			};
		});
		const pendingJoinRequests = (Array.isArray(state.lastSyncJoinRequests) ? state.lastSyncJoinRequests : []).map((request) => ({
			displayName: String(request.display_name || request.device_id || "Pending device"),
			requestId: String(request.request_id || "")
		}));
		const visibleDiscoveredRows = discoveredRows.filter((row) => row.mode !== "paired" && row.mode !== "none" && row.mode !== "scope-pending");
		const discoveredActionableCount = discoveredRows.filter((row) => row.mode === "accept" || row.mode === "scope-pending").length;
		const actionableCount = attentionItems.length + pendingJoinRequests.length + discoveredActionableCount;
		const attentionParts = [];
		if (attentionItems.length > 0) {
			const repairItems = attentionItems.filter((item) => item.kind === "device-needs-repair");
			const nameItems = attentionItems.filter((item) => item.kind === "name-device");
			const reviewItems = attentionItems.filter((item) => item.kind === "review-team-device");
			const duplicateItems = attentionItems.filter((item) => item.kind === "possible-duplicate-person");
			if (repairItems.length > 0) attentionParts.push(`${repairItems.length} device${repairItems.length === 1 ? "" : "s"} to repair`);
			if (nameItems.length > 0) attentionParts.push(`${nameItems.length} device${nameItems.length === 1 ? "" : "s"} to name`);
			if (reviewItems.length > 0) attentionParts.push(`${reviewItems.length} device${reviewItems.length === 1 ? "" : "s"} to review`);
			if (duplicateItems.length > 0) attentionParts.push(`${duplicateItems.length} possible duplicate${duplicateItems.length === 1 ? "" : "s"}`);
		}
		if (pendingJoinRequests.length > 0) attentionParts.push(`${pendingJoinRequests.length} join request${pendingJoinRequests.length === 1 ? "" : "s"} to review`);
		if (discoveredActionableCount > 0) attentionParts.push(`${discoveredActionableCount} discovered device${discoveredActionableCount === 1 ? "" : "s"}`);
		const attentionDetail = attentionParts.join(", ");
		const teamLabel = (coordinator.groups || []).join(", ") || "none";
		const statusSummary = {
			badgeClassName: `pill ${presenceStatus === "posted" ? "pill-success" : presenceStatus === "not_enrolled" ? "pill-warning" : "pill-error"}`,
			headline: presenceStatus === "posted" ? actionableCount > 0 ? attentionDetail : "Everything is healthy" : presenceStatus === "not_enrolled" ? "This device is not enrolled in the team yet" : "Sync needs attention",
			metricsText: metricParts.join(" · "),
			presenceLabel
		};
		meta.textContent = presenceStatus === "posted" ? actionableCount > 0 ? `Team: ${teamLabel}. Start with the next step below, then scan the current team status.` : `Team: ${teamLabel}. Team status and device details are below.` : presenceStatus === "not_enrolled" ? `Team: ${teamLabel}. Enroll this device first, then return here to review the rest of the team.` : `Team: ${teamLabel}. Fix the current sync issue first, then use the rest of this card to verify the team state.`;
		if (discoveredPanel) discoveredPanel.hidden = visibleDiscoveredRows.length === 0 && !state.syncDiscoveredFeedback;
		if (discoveredMeta) discoveredMeta.textContent = visibleDiscoveredRows.length ? "Review anything here that still needs trust, repair, or approval." : "";
		if (joinRequests) joinRequests.hidden = pendingJoinRequests.length === 0 && !state.syncJoinRequestsFeedback;
		teardownTeamSyncRender(actions, [
			list,
			joinRequests,
			discoveredList
		]);
		const actionMount = document.createElement("div");
		actionMount.id = TEAM_SYNC_ACTIONS_MOUNT_ID;
		actions.appendChild(actionMount);
		renderIntoSyncMount(actionMount, _$1(TeamSyncPanel, {
			actionItems: attentionItems,
			actionableCount,
			children: _$1(SyncInviteJoinPanels, {
				invitePanel,
				invitePanelOpen: teamInvitePanelOpen,
				inviteRestoreParent,
				joinPanel,
				joinRestoreParent,
				onToggleInvitePanel: () => {
					if (!invitePanel) return;
					setTeamInvitePanelOpen(!teamInvitePanelOpen);
					renderTeamSync();
				},
				pairedPeerCount: Number(coordinator.paired_peer_count || 0),
				presenceStatus
			}),
			discoveredListMount: discoveredList,
			discoveredRows: visibleDiscoveredRows,
			joinRequestsMount: joinRequests,
			listMount: list,
			onApproveJoinRequest: async (request) => {
				try {
					await reviewJoinRequest(request.requestId, "approve");
					const feedback = {
						message: `Approved ${request.displayName}. They can now sync with the team.`,
						tone: "success"
					};
					state.syncJoinRequestsFeedback = feedback;
					await _loadSyncData$1();
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to approve join request. Keep it pending and try again after the coordinator refreshes."),
						tone: "warning"
					};
				}
			},
			onAttentionAction: async (item) => {
				if (item.kind === "possible-duplicate-person") {
					await reviewDuplicatePeople(item);
					return;
				}
				focusAttentionTarget(item);
			},
			onDenyJoinRequest: async (request) => {
				if (!await openSyncConfirmDialog({
					title: `Deny join request from ${request.displayName}?`,
					description: "They will need a new invite to try joining this team again.",
					confirmLabel: "Deny request",
					cancelLabel: "Keep request pending",
					tone: "danger"
				})) return null;
				try {
					await reviewJoinRequest(request.requestId, "deny");
					const feedback = {
						message: `Denied join request from ${request.displayName}.`,
						tone: "success"
					};
					state.syncJoinRequestsFeedback = feedback;
					await _loadSyncData$1();
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to deny join request. Leave it pending for now, then retry after the coordinator refreshes."),
						tone: "warning"
					};
				}
			},
			onInspectConflict: (row) => {
				const peerCard = document.querySelector(`[data-peer-device-id="${CSS.escape(row.deviceId)}"]`);
				if (peerCard instanceof HTMLElement) {
					peerCard.scrollIntoView({
						block: "center",
						behavior: syncScrollBehavior()
					});
					showGlobalNotice(`Opened the conflicting local device record for ${row.displayName}.`, "warning");
					return;
				}
				showGlobalNotice("The conflicting local device record is not visible yet. Scroll to People & devices and try again.", "warning");
			},
			onRemoveConflict: async (row) => {
				if (!await openSyncConfirmDialog({
					title: `Remove ${row.displayName}?`,
					description: "This deletes the broken local device record. You can review this device again after the screen refreshes.",
					confirmLabel: "Remove device record",
					cancelLabel: "Keep device record",
					tone: "danger"
				})) return null;
				try {
					await deletePeer(row.deviceId);
					const feedback = {
						message: `Removed the broken local device record for ${row.displayName}. If it is still available, review it again from Next steps or Devices seen on team.`,
						tone: "success"
					};
					state.syncDiscoveredFeedback = feedback;
					await _loadSyncData$1();
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to remove the broken local device record. The old local record is still present in People & devices."),
						tone: "warning"
					};
				}
			},
			onReviewDiscoveredDevice: async (row) => {
				try {
					const reviewedName = await reviewDiscoveredDeviceName(row.displayName);
					if (!reviewedName) return null;
					const result = await acceptDiscoveredPeer(row.deviceId, row.fingerprint);
					const optimisticName = String(result?.name || row.displayName || "").trim() || row.displayName;
					state.pendingAcceptedSyncPeers = [...Array.isArray(state.pendingAcceptedSyncPeers) ? state.pendingAcceptedSyncPeers.filter((peer) => String(peer?.peer_device_id || "").trim() !== row.deviceId) : [], {
						peer_device_id: row.deviceId,
						name: optimisticName,
						fingerprint: row.fingerprint,
						addresses: [],
						claimed_local_actor: false,
						status: { peer_state: "degraded" },
						last_error: "Waiting for the other device to approve this one."
					}];
					requestPeerScopeReview(row.deviceId);
					let feedback = {
						message: row.approvalBadgeLabel === "Needs your approval" ? `Approved ${row.displayName} on this device. Two-way trust should be ready once both devices refresh.` : `Step 1 complete on this device for ${row.displayName}. Finish onboarding on the other device so both sides trust each other for sync.`,
						tone: "success"
					};
					try {
						if (reviewedName.trim() !== optimisticName.trim()) {
							await renamePeer(row.deviceId, reviewedName.trim());
							state.pendingAcceptedSyncPeers = state.pendingAcceptedSyncPeers.map((peer) => String(peer?.peer_device_id || "").trim() === row.deviceId ? {
								...peer,
								name: reviewedName.trim()
							} : peer);
							feedback = {
								message: `Connected ${reviewedName.trim()} and saved its name.`,
								tone: "success"
							};
						}
					} catch (error) {
						feedback = {
							message: friendlyError(error, "Device connected, but naming did not finish."),
							tone: "warning"
						};
					}
					state.syncDiscoveredFeedback = feedback;
					try {
						await _loadSyncData$1();
					} catch (error) {
						feedback = {
							message: friendlyError(error, "Device connected, but the screen did not refresh yet. Refresh this page before trying the next step."),
							tone: "warning"
						};
						state.syncDiscoveredFeedback = feedback;
					}
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to review this device. Wait for a fresh presence update and try again."),
						tone: "warning"
					};
				}
			},
			pendingJoinRequests,
			presenceStatus,
			statusSummary
		}));
	}
	function initTeamSyncEvents(refreshCallback, loadSyncData) {
		renderAdminSetupDisclosure();
		renderInvitePolicySelect();
		const syncNowButton = document.getElementById("syncNowButton");
		const syncCreateInviteButton = document.getElementById("syncCreateInviteButton");
		const syncInviteGroup = document.getElementById("syncInviteGroup");
		const syncInviteTtl = document.getElementById("syncInviteTtl");
		const syncInviteOutput = document.getElementById("syncInviteOutput");
		const syncJoinButton = document.getElementById("syncJoinButton");
		const syncJoinInvite = document.getElementById("syncJoinInvite");
		syncCreateInviteButton?.addEventListener("click", async () => {
			if (!syncCreateInviteButton || !syncInviteGroup || !syncInviteTtl || !syncInviteOutput) return;
			const groupName = syncInviteGroup.value.trim();
			const ttlValue = Number(syncInviteTtl.value);
			let valid = true;
			if (!groupName) valid = markFieldError(syncInviteGroup, "Team name is required.");
			else clearFieldError(syncInviteGroup);
			if (!ttlValue || ttlValue < 1) valid = markFieldError(syncInviteTtl, "Must be at least 1 hour.");
			else clearFieldError(syncInviteTtl);
			if (!valid) return;
			syncCreateInviteButton.disabled = true;
			syncCreateInviteButton.textContent = "Creating…";
			try {
				const result = await createCoordinatorInvite({
					group_id: groupName,
					policy: invitePolicyValue,
					ttl_hours: ttlValue || 24
				});
				state.lastTeamInvite = result;
				setInviteOutputVisibility();
				syncInviteOutput.value = String(result.encoded || "");
				syncInviteOutput.hidden = false;
				syncInviteOutput.focus();
				syncInviteOutput.select();
				const warnings = Array.isArray(result.warnings) ? result.warnings : [];
				showGlobalNotice(warnings.length ? `Invite created. Copy it above and review ${warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}.` : "Invite created. Copy the text above and share it with your teammate.", warnings.length ? "warning" : "success");
			} catch (error) {
				showGlobalNotice(friendlyError(error, "Failed to create invite. Check the team name, invite lifetime, and coordinator reachability, then try again."), "warning");
				syncCreateInviteButton.textContent = "Retry";
				syncCreateInviteButton.disabled = false;
				return;
			} finally {
				if (syncCreateInviteButton.disabled) {
					syncCreateInviteButton.disabled = false;
					syncCreateInviteButton.textContent = "Create invite";
				}
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
				let feedback = {
					message: result.status === "pending" ? "Join request sent. Waiting for admin approval." : "Joined the team.",
					tone: "success"
				};
				state.syncJoinFlowFeedback = feedback;
				setJoinFeedbackVisibility();
				syncJoinInvite.value = "";
				try {
					await loadSyncData();
				} catch (error) {
					feedback = {
						message: friendlyError(error, "Joined the team, but this view has not refreshed yet."),
						tone: "warning"
					};
					state.syncJoinFlowFeedback = feedback;
					setJoinFeedbackVisibility();
				}
			} catch (error) {
				state.syncJoinFlowFeedback = {
					message: friendlyError(error, "Failed to import invite. Check that the invite is complete, current, and meant for this team, then try again."),
					tone: "warning"
				};
				setJoinFeedbackVisibility();
				syncJoinButton.textContent = "Retry";
				syncJoinButton.disabled = false;
				return;
			} finally {
				if (syncJoinButton.disabled) {
					syncJoinButton.disabled = false;
					syncJoinButton.textContent = "Join team";
				}
			}
		});
		syncNowButton?.addEventListener("click", async () => {
			if (!syncNowButton) return;
			syncNowButton.disabled = true;
			syncNowButton.textContent = "Syncing…";
			try {
				const summary = summarizeSyncRunResult(await triggerSync());
				showGlobalNotice(summary.message, summary.warning ? "warning" : void 0);
			} catch (error) {
				showGlobalNotice(friendlyError(error, "Failed to start sync. Retry once, then run codemem sync doctor if the problem keeps coming back."), "warning");
				syncNowButton.textContent = "Retry";
				syncNowButton.disabled = false;
				return;
			}
			syncNowButton.disabled = false;
			syncNowButton.textContent = "Sync now";
			refreshCallback();
		});
	}
	//#endregion
	//#region src/tabs/sync/components/sync-actors.tsx
	function localActorNote(hiddenLocalDuplicateCount) {
		if (hiddenLocalDuplicateCount <= 0) return "Represents you across your devices.";
		return `Represents you across your devices. ${hiddenLocalDuplicateCount} unresolved duplicate ${hiddenLocalDuplicateCount === 1 ? "entry is" : "entries are"} hidden until reviewed in Needs attention.`;
	}
	function SyncActorRow({ actor, hiddenLocalDuplicateCount, onRename, onMerge, onDeactivate }) {
		const actorId = String(actor.actor_id || "");
		const label = actorLabel(actor);
		const count = assignedActorCount(actorId);
		const mergeTargets = mergeTargetActors(actorId);
		const mergeTargetKeys = mergeTargets.map((target) => String(target.actor_id || "")).join("|");
		const [name, setName] = d(label);
		const [renameBusy, setRenameBusy] = d(false);
		const [renameLabel, setRenameLabel] = d("Rename");
		const [mergeBusy, setMergeBusy] = d(false);
		const [mergeLabel, setMergeLabel] = d("Combine into selected person");
		const [mergeTargetId, setMergeTargetId] = d("");
		y(() => {
			setName(label);
			setRenameBusy(false);
			setRenameLabel("Rename");
			setMergeBusy(false);
			setMergeLabel("Combine into selected person");
			setMergeTargetId("");
		}, [
			actorId,
			count,
			hiddenLocalDuplicateCount,
			label,
			mergeTargetKeys
		]);
		const mergeNote = !mergeTargets.length ? "No people available to combine yet. Create another person or use You." : actorMergeNote(mergeTargetId, actorId);
		async function rename() {
			const nextName = name.trim();
			if (!nextName) return;
			setRenameBusy(true);
			setRenameLabel("Saving…");
			let ok = false;
			try {
				await onRename(actorId, nextName);
				ok = true;
			} catch {
				setRenameLabel("Retry rename");
			} finally {
				setRenameBusy(false);
				if (ok) setRenameLabel("Rename");
			}
		}
		async function merge() {
			if (!mergeTargetId) return;
			const target = mergeTargets.find((candidate) => String(candidate.actor_id || "") === mergeTargetId);
			if (!target) return;
			if (!await openSyncConfirmDialog({
				title: `Combine ${label} into ${actorLabel(target)}?`,
				description: "Assigned devices move now, but older memories keep their current stamped provenance for now.",
				confirmLabel: "Combine people",
				cancelLabel: "Keep separate",
				tone: "danger"
			})) return;
			setMergeBusy(true);
			setMergeLabel("Merging…");
			let ok = false;
			try {
				await onMerge(mergeTargetId, actorId);
				ok = true;
			} catch {
				setMergeLabel("Retry merge");
			} finally {
				setMergeBusy(false);
				if (ok) setMergeLabel("Combine into selected person");
			}
		}
		return /* @__PURE__ */ u("div", {
			className: "actor-row",
			children: [/* @__PURE__ */ u("div", {
				className: "actor-details",
				children: [/* @__PURE__ */ u("div", {
					className: "actor-title",
					children: [/* @__PURE__ */ u("strong", { children: actorDisplayLabel(actor) }), /* @__PURE__ */ u("span", {
						className: `badge actor-badge${actor.is_local ? " local" : ""}`,
						title: actor.is_local ? localActorNote(hiddenLocalDuplicateCount) : void 0,
						children: actor.is_local ? "You" : `${count} device${count === 1 ? "" : "s"}`
					})]
				}), !actor.is_local ? /* @__PURE__ */ u("div", {
					className: "peer-meta",
					children: [
						count,
						" assigned device",
						count === 1 ? "" : "s"
					]
				}) : null]
			}), /* @__PURE__ */ u("div", {
				className: "actor-actions",
				children: actor.is_local ? /* @__PURE__ */ u("div", {
					className: "peer-meta",
					children: "Rename in config"
				}) : /* @__PURE__ */ u(k$2, { children: [
					/* @__PURE__ */ u("input", {
						"aria-label": `Rename ${label}`,
						className: "peer-scope-input actor-name-input",
						disabled: renameBusy || mergeBusy,
						value: name,
						onInput: (event) => setName(event.currentTarget.value)
					}),
					/* @__PURE__ */ u("button", {
						className: "settings-button",
						disabled: renameBusy || mergeBusy,
						onClick: () => void rename(),
						children: renameLabel
					}),
					/* @__PURE__ */ u("div", {
						className: "actor-merge-controls",
						children: [/* @__PURE__ */ u("select", {
							"aria-label": `Combine ${label} into another person`,
							className: "sync-actor-select actor-merge-select",
							disabled: mergeBusy,
							value: mergeTargetId,
							onChange: (event) => setMergeTargetId(event.currentTarget.value),
							children: [/* @__PURE__ */ u("option", {
								value: "",
								children: "Combine into person"
							}), mergeTargets.map((target) => {
								const targetId = String(target.actor_id || "");
								return /* @__PURE__ */ u("option", {
									value: targetId,
									children: target.is_local ? actorDisplayLabel(target) : actorLabel(target)
								}, targetId);
							})]
						}), /* @__PURE__ */ u("button", {
							className: "settings-button",
							disabled: mergeBusy || mergeTargets.length === 0,
							onClick: () => void merge(),
							children: mergeLabel
						})]
					}),
					/* @__PURE__ */ u("div", {
						className: "peer-meta actor-merge-note",
						children: mergeNote
					}),
					/* @__PURE__ */ u("button", {
						className: "settings-button",
						disabled: renameBusy || mergeBusy,
						onClick: async () => {
							if (await openSyncConfirmDialog({
								title: `Remove ${label}?`,
								description: "This deactivates the person and unassigns their devices. Existing memories keep their current attribution.",
								confirmLabel: "Remove person",
								cancelLabel: "Keep",
								tone: "danger"
							})) await onDeactivate(actorId);
						},
						children: "Remove person"
					})
				] })
			})]
		});
	}
	function SyncActorsList({ actors, hiddenLocalDuplicateCount, onRename, onMerge, onDeactivate }) {
		if (!actors.length) return /* @__PURE__ */ u("div", {
			className: "sync-empty-state",
			children: [/* @__PURE__ */ u("strong", { children: "No people yet." }), /* @__PURE__ */ u("span", { children: "Create a named person here, then assign each device below to keep sync ownership readable." })]
		});
		return /* @__PURE__ */ u(k$2, { children: actors.map((actor) => {
			const actorId = String(actor.actor_id || actor.display_name || actor.is_local || "");
			return /* @__PURE__ */ u(SyncActorRow, {
				actor,
				hiddenLocalDuplicateCount,
				onRename,
				onMerge,
				onDeactivate
			}, actorId);
		}) });
	}
	function renderSyncActorsList(mount, props) {
		renderIntoSyncMount(mount, /* @__PURE__ */ u(SyncActorsList, { ...props }));
	}
	//#endregion
	//#region src/tabs/sync/peer-scope-collapsible.tsx
	function PeerScopeCollapsible({ contentHost, initialOpen, onOpenChange, children }) {
		const [open, setOpen] = d(initialOpen);
		y(() => {
			setOpen(initialOpen);
		}, [initialOpen]);
		_(() => {
			onOpenChange(open);
		}, [onOpenChange, open]);
		return /* @__PURE__ */ u(Root$2, {
			open,
			onOpenChange: setOpen,
			children: [/* @__PURE__ */ u(Trigger$1, {
				asChild: true,
				children: /* @__PURE__ */ u("button", {
					type: "button",
					children: open ? "Hide scope editor" : "Edit scope"
				})
			}), contentHost ? $(/* @__PURE__ */ u(Content$2, {
				forceMount: true,
				className: `peer-scope-editor-wrap${open ? "" : " collapsed"}`,
				hidden: !open,
				inert: !open,
				children: /* @__PURE__ */ u(ScopeEditorContent, { children })
			}), contentHost) : null]
		});
	}
	function ScopeEditorContent({ children }) {
		return /* @__PURE__ */ u("div", { children });
	}
	//#endregion
	//#region src/tabs/sync/components/sync-peers.tsx
	function listText(value) {
		return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
	}
	function ExistingElementSlot({ element }) {
		const hostRef = A$1(null);
		_(() => {
			const host = hostRef.current;
			if (!host) return;
			if (element.parentElement !== host) host.appendChild(element);
			return () => {
				if (element.parentElement === host) host.removeChild(element);
			};
		}, [element]);
		return /* @__PURE__ */ u("div", { ref: hostRef });
	}
	function SyncPeerCard({ peer, onAssignActor, onRemove, onRename, onResetScope, onSaveScope, onSync }) {
		const peerId = String(peer.peer_device_id || "");
		const displayName = peer.name || (peerId ? peerId.slice(0, 8) : "unknown");
		const destructiveLabel = peer.name || peerId || displayName;
		const pendingScopeReview = isPeerScopeReviewPending(peerId);
		const trustSummary = derivePeerTrustSummary(peer);
		const peerStatus = peer.status || {};
		const scope = peer.project_scope || {};
		const includeList = listText(scope.include);
		const excludeList = listText(scope.exclude);
		listText(scope.effective_include);
		listText(scope.effective_exclude);
		Boolean(scope.inherits_global);
		const primaryAddress = pickPrimaryAddress(peer.addresses);
		const peerAddresses = Array.isArray(peer.addresses) ? Array.from(new Set(peer.addresses.filter(Boolean).map((value) => String(value)))) : [];
		const addressLine = peerAddresses.length ? peerAddresses.map((address) => isSyncRedactionEnabled() ? redactAddress(address) : address).join(" · ") : "No addresses";
		const lastSyncAt = String(peerStatus.last_sync_at || peerStatus.last_sync_at_utc || "");
		const lastPingAt = String(peerStatus.last_ping_at || peerStatus.last_ping_at_utc || "");
		const scopeEditorOpen = openPeerScopeEditors.has(peerId);
		const scopeReviewRequested = consumePeerScopeReviewRequest(peerId);
		const cardRef = A$1(null);
		const [scopeHost, setScopeHost] = d(null);
		const [renameValue, setRenameValue] = d(displayName);
		const [feedback, setFeedback] = d(() => state.syncPeerFeedbackById.get(peerId) ?? null);
		const [renameBusy, setRenameBusy] = d(false);
		const [renameLabel, setRenameLabel] = d("Save name");
		const [syncBusy, setSyncBusy] = d(false);
		const [removeBusy, setRemoveBusy] = d(false);
		const [removeLabel, setRemoveLabel] = d("Remove peer");
		const [selectedActorId, setSelectedActorId] = d(String(peer.actor_id || ""));
		const [applyActorBusy, setApplyActorBusy] = d(false);
		const [applyActorLabel, setApplyActorLabel] = d("Save person");
		const [saveScopeBusy, setSaveScopeBusy] = d(false);
		const [saveScopeLabel, setSaveScopeLabel] = d("Save scope");
		const [resetScopeBusy, setResetScopeBusy] = d(false);
		const [resetScopeLabel, setResetScopeLabel] = d("Reset to global scope");
		const actorSelectOptions = T$1(() => {
			const options = buildActorSelectOptions(selectedActorId);
			const hasSelected = options.some((option) => option.value === selectedActorId);
			if (selectedActorId && !hasSelected) options.push({
				value: selectedActorId,
				label: peer.claimed_local_actor ? "You" : String(peer.actor_display_name || "Current assignment")
			});
			return options;
		}, [
			peer.actor_display_name,
			peer.claimed_local_actor,
			selectedActorId,
			state.lastSyncActors,
			state.lastSyncPeers,
			state.lastSyncViewModel
		]);
		const includeEditor = T$1(() => createChipEditor(includeList, "Add included project", "All projects"), [peerId, includeList.join("|")]);
		const excludeEditor = T$1(() => createChipEditor(excludeList, "Add excluded project", "No exclusions"), [peerId, excludeList.join("|")]);
		y(() => {
			setRenameValue(displayName);
			setFeedback(state.syncPeerFeedbackById.get(peerId) ?? null);
			setRenameBusy(false);
			setRenameLabel("Save name");
			setSyncBusy(false);
			setRemoveBusy(false);
			setRemoveLabel("Remove peer");
			setSelectedActorId(String(peer.actor_id || ""));
			setApplyActorBusy(false);
			setApplyActorLabel("Save person");
			setSaveScopeBusy(false);
			setSaveScopeLabel("Save scope");
			setResetScopeBusy(false);
			setResetScopeLabel("Reset to global scope");
		}, [
			displayName,
			peer.actor_id,
			peerId,
			includeList.join("|"),
			excludeList.join("|")
		]);
		y(() => {
			if (!scopeReviewRequested || !cardRef.current) return;
			queueMicrotask(() => cardRef.current?.scrollIntoView({
				block: "center",
				behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
			}));
		}, [scopeReviewRequested]);
		async function rename() {
			if (!peerId) return;
			const nextName = renameValue.trim();
			if (!nextName) {
				const warning = {
					message: "Enter a friendly name for this device.",
					tone: "warning"
				};
				setFeedback(warning);
				state.syncPeerFeedbackById.set(peerId, warning);
				document.querySelector(`[data-device-name-input="${CSS.escape(peerId)}"]`)?.focus();
				return;
			}
			setRenameBusy(true);
			setRenameLabel("Saving…");
			try {
				const nextFeedback = await onRename(peerId, nextName);
				setFeedback(nextFeedback);
				state.syncPeerFeedbackById.set(peerId, nextFeedback);
				setRenameLabel("Save name");
			} catch {
				setRenameLabel("Retry");
			} finally {
				setRenameBusy(false);
			}
		}
		async function sync() {
			if (!primaryAddress) return;
			if (pendingScopeReview) {
				if (!await openSyncConfirmDialog({
					title: `Sync ${displayName} before scope review?`,
					description: "This manual sync will use the current effective scope until you finish reviewing and saving the device scope.",
					confirmLabel: "Sync anyway",
					cancelLabel: "Review scope first"
				})) return;
			}
			setSyncBusy(true);
			try {
				const nextFeedback = await onSync(peer, primaryAddress);
				setFeedback(nextFeedback);
				if (nextFeedback) state.syncPeerFeedbackById.set(peerId, nextFeedback);
			} finally {
				setSyncBusy(false);
			}
		}
		async function remove() {
			if (!peerId) return;
			if (!await openSyncConfirmDialog({
				title: `Remove peer ${destructiveLabel}?`,
				description: "This deletes the local sync peer entry on this device.",
				confirmLabel: "Remove peer",
				cancelLabel: "Keep peer",
				tone: "danger"
			})) return;
			setRemoveBusy(true);
			setRemoveLabel("Removing…");
			let ok = false;
			try {
				await onRemove(peerId, destructiveLabel);
				ok = true;
			} catch {
				setRemoveLabel("Retry remove");
			} finally {
				setRemoveBusy(false);
				if (ok) setRemoveLabel("Remove peer");
			}
		}
		async function savePerson() {
			if (!peerId) return;
			setApplyActorBusy(true);
			setApplyActorLabel("Saving…");
			try {
				const nextFeedback = await onAssignActor(peerId, selectedActorId || null);
				setFeedback(nextFeedback);
				state.syncPeerFeedbackById.set(peerId, nextFeedback);
				setApplyActorLabel("Save person");
			} catch {
				setApplyActorLabel("Retry");
			} finally {
				setApplyActorBusy(false);
			}
		}
		async function saveScope() {
			if (!peerId) return;
			setSaveScopeBusy(true);
			setSaveScopeLabel("Saving…");
			try {
				const nextFeedback = await onSaveScope(peerId, includeEditor.values(), excludeEditor.values());
				setFeedback(nextFeedback);
				state.syncPeerFeedbackById.set(peerId, nextFeedback);
				setSaveScopeLabel("Save scope");
			} catch {
				setSaveScopeLabel("Retry");
			} finally {
				setSaveScopeBusy(false);
			}
		}
		async function resetScope() {
			if (!peerId) return;
			setResetScopeBusy(true);
			setResetScopeLabel("Resetting…");
			try {
				const nextFeedback = await onResetScope(peerId);
				setFeedback(nextFeedback);
				state.syncPeerFeedbackById.set(peerId, nextFeedback);
				setResetScopeLabel("Reset to global scope");
			} catch {
				setResetScopeLabel("Retry");
			} finally {
				setResetScopeBusy(false);
			}
		}
		return /* @__PURE__ */ u("div", {
			ref: cardRef,
			className: "peer-card",
			"data-peer-device-id": peerId || void 0,
			children: [
				/* @__PURE__ */ u("div", {
					className: "peer-title",
					children: [/* @__PURE__ */ u("strong", {
						title: peerId || void 0,
						children: [
							displayName,
							" ",
							/* @__PURE__ */ u("span", {
								className: `badge ${trustSummary.isWarning ? "badge-offline" : "badge-online"}`,
								children: trustSummary.badgeLabel
							}),
							pendingScopeReview ? /* @__PURE__ */ u("span", {
								className: "badge actor-badge",
								children: "Needs scope review"
							}) : null
						]
					}), /* @__PURE__ */ u("div", {
						className: "peer-actions",
						children: [
							/* @__PURE__ */ u("input", {
								"aria-label": `Friendly name for ${displayName}`,
								className: "peer-scope-input",
								"data-device-name-input": peerId || void 0,
								disabled: renameBusy,
								placeholder: "Friendly device name",
								value: renameValue,
								onInput: (event) => setRenameValue(event.currentTarget.value)
							}),
							/* @__PURE__ */ u("button", {
								disabled: renameBusy,
								onClick: () => void rename(),
								children: renameLabel
							}),
							/* @__PURE__ */ u("button", {
								disabled: !primaryAddress || syncBusy,
								onClick: () => void sync(),
								children: syncBusy ? "Syncing…" : "Sync now"
							}),
							/* @__PURE__ */ u("button", {
								disabled: removeBusy,
								onClick: () => void remove(),
								children: removeLabel
							}),
							/* @__PURE__ */ u(PeerScopeCollapsible, {
								contentHost: scopeHost,
								initialOpen: scopeEditorOpen,
								onOpenChange: (open) => {
									if (open) openPeerScopeEditors.add(peerId);
									else openPeerScopeEditors.delete(peerId);
								},
								children: /* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("div", {
									className: "peer-scope-row",
									children: [/* @__PURE__ */ u(ExistingElementSlot, { element: includeEditor.element }), /* @__PURE__ */ u(ExistingElementSlot, { element: excludeEditor.element })]
								}), /* @__PURE__ */ u("div", {
									className: "peer-scope-actions",
									children: [/* @__PURE__ */ u("button", {
										type: "button",
										className: "settings-button",
										disabled: saveScopeBusy,
										onClick: () => void saveScope(),
										children: saveScopeLabel
									}), /* @__PURE__ */ u("button", {
										type: "button",
										className: "settings-button",
										disabled: resetScopeBusy,
										onClick: () => void resetScope(),
										children: resetScopeLabel
									})]
								})] })
							})
						]
					})]
				}),
				/* @__PURE__ */ u("div", {
					className: "peer-addresses",
					children: addressLine
				}),
				/* @__PURE__ */ u("div", {
					className: "peer-meta",
					children: [lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : "Sync: never", lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : "Ping: never"].join(" · ")
				}),
				/* @__PURE__ */ u("div", {
					className: "peer-scope",
					children: [
						scopeReviewRequested ? /* @__PURE__ */ u("div", {
							className: "peer-meta",
							children: "Review this device's sharing scope now."
						}) : pendingScopeReview ? /* @__PURE__ */ u("div", {
							className: "peer-meta",
							children: "Scope review still pending."
						}) : null,
						/* @__PURE__ */ u("div", {
							className: "peer-scope-summary",
							children: "Assigned person"
						}),
						/* @__PURE__ */ u("div", {
							className: "peer-meta",
							children: peer.actor_display_name ? `Assigned to ${peer.claimed_local_actor ? "You" : String(peer.actor_display_name)}` : "Unassigned person"
						}),
						/* @__PURE__ */ u("div", {
							className: "peer-actor-row",
							children: [/* @__PURE__ */ u("div", {
								className: "sync-radix-select-host sync-actor-select-host",
								children: /* @__PURE__ */ u(RadixSelect, {
									ariaLabel: `Assigned person for ${displayName}`,
									contentClassName: "sync-radix-select-content sync-actor-select-content",
									disabled: applyActorBusy,
									itemClassName: "sync-radix-select-item",
									onValueChange: setSelectedActorId,
									options: actorSelectOptions,
									placeholder: "No person assigned",
									triggerClassName: "sync-radix-select-trigger sync-actor-select",
									value: selectedActorId,
									viewportClassName: "sync-radix-select-viewport"
								})
							}), /* @__PURE__ */ u("button", {
								className: "settings-button",
								disabled: applyActorBusy,
								onClick: () => void savePerson(),
								children: applyActorLabel
							})]
						}),
						/* @__PURE__ */ u(SyncInlineFeedback, { feedback }),
						/* @__PURE__ */ u("div", { ref: setScopeHost })
					]
				})
			]
		});
	}
	function SyncPeersList(props) {
		const sectionFeedback = state.syncPeersSectionFeedback;
		const syncStatus = state.lastSyncStatus;
		const syncDisabled = syncStatus?.daemon_state === "disabled" || syncStatus?.enabled === false;
		if (!props.peers.length) return /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u(SyncInlineFeedback, { feedback: sectionFeedback }), /* @__PURE__ */ u("div", {
			className: "sync-empty-state",
			children: [/* @__PURE__ */ u("strong", { children: "No paired devices yet." }), /* @__PURE__ */ u("span", { children: syncDisabled ? "Turn on sync in Settings → Device Sync first, then use Show pairing in Advanced diagnostics to connect another device." : "Use the Show pairing control in Advanced diagnostics, run the command on the other device, then come back here to name and assign it." })]
		})] });
		return /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u(SyncInlineFeedback, { feedback: sectionFeedback }), props.peers.map((peer) => {
			const peerId = String(peer.peer_device_id || peer.name || "unknown-peer");
			return /* @__PURE__ */ u(SyncPeerCard, {
				peer,
				...props
			}, peerId);
		})] });
	}
	function renderSyncPeersList(mount, props) {
		renderIntoSyncMount(mount, /* @__PURE__ */ u(SyncPeersList, { ...props }));
	}
	//#endregion
	//#region src/tabs/sync/components/sync-legacy-claims.tsx
	function validDevices(devices) {
		return devices.filter((device) => String(device.origin_device_id || "").trim());
	}
	function metaText(devices) {
		const withLastSeen = devices.find((device) => String(device.last_seen_at || "").trim());
		if (withLastSeen?.last_seen_at) return `Detected from older synced memories. Latest memory: ${formatTimestamp(String(withLastSeen.last_seen_at).trim())}`;
		return "Detected from older synced memories not yet attached to a current device.";
	}
	function LegacyClaimMeta({ devices }) {
		return /* @__PURE__ */ u(k$2, { children: metaText(devices) });
	}
	function option(device) {
		const deviceId = String(device.origin_device_id || "").trim();
		const count = Number(device.memory_count || 0);
		return {
			label: count > 0 ? `${deviceId} (${count} memories)` : deviceId,
			value: deviceId
		};
	}
	function renderLegacyClaimsSlice(input) {
		const devices = validDevices(input.devices);
		if (!devices.length) {
			input.panel.hidden = true;
			input.onValueChange("");
			clearSyncMount(input.mount);
			clearSyncMount(input.meta);
			return;
		}
		const options = devices.map(option);
		const nextValue = options.some((item) => item.value === input.value) ? input.value : options[0]?.value || "";
		if (nextValue !== input.value) input.onValueChange(nextValue);
		input.panel.hidden = false;
		renderIntoSyncMount(input.mount, /* @__PURE__ */ u(RadixSelect, {
			ariaLabel: "Legacy device",
			contentClassName: "sync-radix-select-content sync-legacy-select-content",
			id: "syncLegacyDeviceSelect",
			itemClassName: "sync-radix-select-item",
			onValueChange: input.onValueChange,
			options,
			triggerClassName: "sync-radix-select-trigger sync-legacy-select",
			value: nextValue,
			viewportClassName: "sync-radix-select-viewport"
		}));
		renderIntoSyncMount(input.meta, /* @__PURE__ */ u(LegacyClaimMeta, { devices }));
	}
	//#endregion
	//#region src/tabs/sync/people.ts
	var _loadSyncData = async () => {};
	var legacyDeviceValue = "";
	function setPeopleCreateControlsDisabled(disabled) {
		const createButton = document.getElementById("syncActorCreateButton");
		const createInput = document.getElementById("syncActorCreateInput");
		if (createButton) createButton.disabled = disabled;
		if (createInput) createInput.disabled = disabled;
	}
	function setLoadSyncData(fn) {
		_loadSyncData = fn;
	}
	function renderSyncActors() {
		const actorList = document.getElementById("syncActorsList");
		const actorMeta = document.getElementById("syncActorsMeta");
		if (!actorList) return;
		hideSkeleton("syncActorsSkeleton");
		setPeopleCreateControlsDisabled(false);
		const actorVisibility = deriveVisiblePeopleActors({
			actors: state.lastSyncActors,
			peers: state.lastSyncPeers,
			duplicatePeople: state.lastSyncViewModel?.duplicatePeople
		});
		const actors = actorVisibility.visibleActors;
		if (actorMeta) {
			actorMeta.textContent = actors.length ? "Manage people here, then assign devices below." : "No named people yet. Create a person here, then assign devices below so sync ownership is easier to review.";
			if (actorVisibility.hiddenLocalDuplicateCount > 0) actorMeta.textContent += ` ${actorVisibility.hiddenLocalDuplicateCount} unresolved duplicate ${actorVisibility.hiddenLocalDuplicateCount === 1 ? "entry is" : "entries are"} hidden here until reviewed in Needs attention.`;
		}
		renderSyncActorsList(actorList, {
			actors,
			hiddenLocalDuplicateCount: actorVisibility.hiddenLocalDuplicateCount,
			onRename: async (actorId, nextName) => {
				await renameActor(actorId, nextName);
				await _loadSyncData();
			},
			onMerge: async (primaryActorId, secondaryActorId) => {
				try {
					await mergeActor(primaryActorId, secondaryActorId);
					showGlobalNotice("People combined. Assigned devices moved to the selected person.");
					await _loadSyncData();
				} catch (error) {
					showGlobalNotice(friendlyError(error, "Failed to combine people."), "warning");
					throw error;
				}
			},
			onDeactivate: async (actorId) => {
				try {
					await deactivateActor(actorId);
					showGlobalNotice("Person removed. Assigned devices have been unassigned.");
					await _loadSyncData();
				} catch (error) {
					showGlobalNotice(friendlyError(error, "Failed to remove person."), "warning");
					throw error;
				}
			}
		});
	}
	function renderSyncActorsUnavailable() {
		const actorList = document.getElementById("syncActorsList");
		const actorMeta = document.getElementById("syncActorsMeta");
		setPeopleCreateControlsDisabled(true);
		if (actorMeta) actorMeta.textContent = "People controls are temporarily unavailable. Refresh this page to retry, but device status and sync health are still available below.";
		if (actorList) renderSyncEmptyState(actorList, {
			title: "People unavailable right now.",
			detail: "Refresh this page to reload named people once the people endpoint is responding again."
		});
	}
	function renderSyncPeers() {
		const syncPeers = document.getElementById("syncPeers");
		if (!syncPeers) return;
		hideSkeleton("syncPeersSkeleton");
		const peers = state.lastSyncPeers;
		renderSyncPeersList(syncPeers, {
			peers: Array.isArray(peers) ? peers : [],
			onRename: async (peerId, nextName) => {
				try {
					await renamePeer(peerId, nextName);
					await _loadSyncData();
					return {
						message: "Device name saved.",
						tone: "success"
					};
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to save device name."),
						tone: "warning"
					};
				}
			},
			onSync: async (peer, address) => {
				try {
					const summary = summarizeSyncRunResult(await triggerSync(address));
					const peerId = String(peer?.peer_device_id || "");
					let feedback;
					if (!summary.ok) feedback = {
						message: summary.message,
						tone: "warning"
					};
					else if (peerId && isPeerScopeReviewPending(peerId)) feedback = {
						message: `Triggered sync for ${peer?.name || (peerId ? peerId.slice(0, 8) : "unknown")}. Review scope in this card if you want tighter sharing rules.`,
						tone: "warning"
					};
					else feedback = {
						message: summary.message,
						tone: "success"
					};
					try {
						await _loadSyncData();
					} catch {
						feedback = {
							message: "Sync started, but this view has not refreshed yet. Refresh the page or use Sync now again before retrying.",
							tone: "warning"
						};
					}
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to trigger sync."),
						tone: "warning"
					};
				}
			},
			onRemove: async (peerId, label) => {
				try {
					await deletePeer(peerId);
					const feedback = {
						message: `Removed peer ${label}.`,
						tone: "success"
					};
					state.syncPeerFeedbackById.delete(peerId);
					state.syncPeersSectionFeedback = feedback;
					await _loadSyncData();
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to remove peer. The local peer entry is still here."),
						tone: "warning"
					};
				}
			},
			onAssignActor: async (peerId, actorId) => {
				try {
					await assignPeerActor(peerId, actorId);
					await _loadSyncData();
					return {
						message: actorId ? "Device person updated." : "Device person cleared.",
						tone: "success"
					};
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to update device person. The current assignment is unchanged."),
						tone: "warning"
					};
				}
			},
			onSaveScope: async (peerId, include, exclude) => {
				try {
					await updatePeerScope(peerId, include, exclude);
					clearPeerScopeReview(peerId);
					await _loadSyncData();
					return {
						message: "Device sync scope saved.",
						tone: "success"
					};
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to save device scope. The current sharing rules are still active."),
						tone: "warning"
					};
				}
			},
			onResetScope: async (peerId) => {
				try {
					await updatePeerScope(peerId, null, null, true);
					clearPeerScopeReview(peerId);
					await _loadSyncData();
					return {
						message: "Device sync scope reset to global defaults.",
						tone: "success"
					};
				} catch (error) {
					return {
						message: friendlyError(error, "Failed to reset device scope. The current sharing rules are still active."),
						tone: "warning"
					};
				}
			}
		});
	}
	function renderSyncPeopleUnavailable() {
		const actorList = document.getElementById("syncActorsList");
		const actorMeta = document.getElementById("syncActorsMeta");
		const syncPeers = document.getElementById("syncPeers");
		setPeopleCreateControlsDisabled(true);
		if (actorMeta) actorMeta.textContent = "People and device details are unavailable right now. Refresh this page to retry once local sync status is reachable again.";
		if (actorList) renderSyncEmptyState(actorList, {
			title: "People unavailable right now.",
			detail: "Refresh this page to reload named people once the local sync status endpoint is responding again."
		});
		if (syncPeers) renderSyncEmptyState(syncPeers, {
			title: "Devices unavailable right now.",
			detail: "Refresh this page to reload paired devices. When sync is reachable again, you can rename, assign, or pair devices here."
		});
	}
	function renderLegacyDeviceClaims() {
		const panel = document.getElementById("syncLegacyClaims");
		const mount = document.getElementById("syncLegacyDeviceSelectMount");
		const meta = document.getElementById("syncLegacyClaimsMeta");
		if (!panel || !mount || !meta) return;
		renderLegacyClaimsSlice({
			devices: Array.isArray(state.lastSyncLegacyDevices) ? state.lastSyncLegacyDevices : [],
			meta,
			mount,
			onValueChange: (value) => {
				if (value === legacyDeviceValue) return;
				legacyDeviceValue = value;
				renderLegacyDeviceClaims();
			},
			panel,
			value: legacyDeviceValue
		});
	}
	function initPeopleEvents(loadSyncData) {
		const syncActorCreateButton = document.getElementById("syncActorCreateButton");
		const syncActorCreateInput = document.getElementById("syncActorCreateInput");
		const syncLegacyClaimButton = document.getElementById("syncLegacyClaimButton");
		syncActorCreateButton?.addEventListener("click", async () => {
			if (!syncActorCreateButton || !syncActorCreateInput) return;
			const displayName = String(syncActorCreateInput.value || "").trim();
			if (!displayName) {
				markFieldError(syncActorCreateInput, "Enter a name for the person.");
				return;
			}
			clearFieldError(syncActorCreateInput);
			syncActorCreateButton.disabled = true;
			syncActorCreateInput.disabled = true;
			syncActorCreateButton.textContent = "Creating…";
			try {
				await createActor(displayName);
				showGlobalNotice("Person created.");
				syncActorCreateInput.value = "";
				await loadSyncData();
			} catch (error) {
				showGlobalNotice(friendlyError(error, "Failed to create person."), "warning");
				syncActorCreateButton.textContent = "Retry";
				syncActorCreateButton.disabled = false;
				syncActorCreateInput.disabled = false;
				return;
			}
			syncActorCreateButton.textContent = "Create person";
			syncActorCreateButton.disabled = false;
			syncActorCreateInput.disabled = false;
		});
		syncLegacyClaimButton?.addEventListener("click", async () => {
			const originDeviceId = String(legacyDeviceValue || "").trim();
			if (!originDeviceId || !syncLegacyClaimButton) return;
			if (!await openSyncConfirmDialog({
				title: `Attach history from ${originDeviceId}?`,
				description: "This updates legacy provenance so the older device history is attached to you on this device.",
				confirmLabel: "Attach history",
				cancelLabel: "Cancel",
				tone: "danger"
			})) return;
			syncLegacyClaimButton.disabled = true;
			const originalText = syncLegacyClaimButton.textContent || "Attach device history";
			syncLegacyClaimButton.textContent = "Attaching…";
			try {
				await claimLegacyDeviceIdentity(originDeviceId);
				showGlobalNotice("Old device history attached to you.");
				await loadSyncData();
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
	//#endregion
	//#region src/tabs/sync/index.ts
	var lastSyncHash = "";
	var cachedSyncStatus = null;
	var latestSyncLoadRequestId = 0;
	var HEALTH_SYNC_STATUS_CACHE_TTL_MS = 15e3;
	function syncStatusCacheKey(project) {
		return `project:${project || ""}|includeJoinRequests:false`;
	}
	function readCachedSyncStatus(project) {
		const key = syncStatusCacheKey(project);
		if (!cachedSyncStatus) return null;
		if (cachedSyncStatus.key !== key) return null;
		if (Date.now() >= cachedSyncStatus.expiresAtMs) return null;
		return cachedSyncStatus.payload;
	}
	function writeCachedSyncStatus(project, payload) {
		cachedSyncStatus = {
			key: syncStatusCacheKey(project),
			expiresAtMs: Date.now() + HEALTH_SYNC_STATUS_CACHE_TTL_MS,
			payload
		};
	}
	function normalizeSyncStatusForCache(payload) {
		if (!payload || typeof payload !== "object") return payload;
		return {
			...payload,
			join_requests: []
		};
	}
	function hideStaleSyncSecondarySections() {
		const sharingReview = document.getElementById("syncSharingReview");
		const sharingReviewList = document.getElementById("syncSharingReviewList");
		const sharingReviewMeta = document.getElementById("syncSharingReviewMeta");
		const legacyClaims = document.getElementById("syncLegacyClaims");
		const legacyClaimsMeta = document.getElementById("syncLegacyClaimsMeta");
		if (sharingReview) sharingReview.hidden = true;
		if (sharingReviewList) sharingReviewList.textContent = "";
		if (sharingReviewMeta) sharingReviewMeta.textContent = "";
		if (legacyClaims) legacyClaims.hidden = true;
		if (legacyClaimsMeta) legacyClaimsMeta.textContent = "";
	}
	async function loadSyncData() {
		const requestId = ++latestSyncLoadRequestId;
		try {
			const project = state.currentProject || "";
			const includeJoinRequests = state.activeTab === "sync";
			const useCache = state.activeTab === "health";
			let fetchedFreshSyncStatus = false;
			let payload;
			if (useCache) {
				payload = readCachedSyncStatus(project);
				if (!payload) {
					payload = await loadSyncStatus(true, project, { includeJoinRequests: false });
					fetchedFreshSyncStatus = true;
				}
			} else {
				payload = await loadSyncStatus(true, project, { includeJoinRequests });
				fetchedFreshSyncStatus = true;
			}
			let actorsPayload = null;
			let actorLoadError = false;
			const duplicatePersonDecisions = readDuplicatePersonDecisions();
			try {
				actorsPayload = await loadSyncActors();
			} catch {
				actorLoadError = true;
			}
			if (requestId !== latestSyncLoadRequestId) return;
			if (fetchedFreshSyncStatus) writeCachedSyncStatus(project, normalizeSyncStatusForCache(payload));
			const hash = JSON.stringify([
				payload,
				actorsPayload,
				duplicatePersonDecisions
			]);
			if (hash === lastSyncHash) return;
			lastSyncHash = hash;
			const statusPayload = payload.status && typeof payload.status === "object" ? payload.status : null;
			if (statusPayload) state.lastSyncStatus = statusPayload;
			if (Array.isArray(actorsPayload?.items)) state.lastSyncActors = actorsPayload.items;
			else state.lastSyncActors = [];
			const payloadPeers = Array.isArray(payload.peers) ? payload.peers : [];
			const realPeerIds = new Set(payloadPeers.map((peer) => String(peer?.peer_device_id || "").trim()).filter(Boolean));
			const pendingPeers = Array.isArray(state.pendingAcceptedSyncPeers) ? state.pendingAcceptedSyncPeers.filter((peer) => {
				const peerId = String(peer?.peer_device_id || "").trim();
				return peerId && !realPeerIds.has(peerId);
			}) : [];
			state.pendingAcceptedSyncPeers = pendingPeers;
			state.lastSyncPeers = [...payloadPeers, ...pendingPeers];
			state.lastSyncSharingReview = payload.sharing_review || [];
			state.lastSyncCoordinator = payload.coordinator || null;
			if (Array.isArray(payload.join_requests)) state.lastSyncJoinRequests = payload.join_requests;
			state.lastSyncAttempts = payload.attempts || [];
			state.lastSyncLegacyDevices = payload.legacy_devices || [];
			state.lastSyncDuplicatePersonDecisions = duplicatePersonDecisions;
			state.lastSyncViewModel = deriveSyncViewModel({
				actors: state.lastSyncActors,
				peers: state.lastSyncPeers,
				coordinator: state.lastSyncCoordinator,
				duplicatePersonDecisions: state.lastSyncDuplicatePersonDecisions
			});
			renderSyncStatus();
			renderTeamSync();
			renderSyncActors();
			renderSyncSharingReview();
			renderSyncPeers();
			renderLegacyDeviceClaims();
			renderSyncAttempts();
			renderHealthOverview();
			if (actorLoadError) renderSyncActorsUnavailable();
		} catch {
			if (requestId !== latestSyncLoadRequestId) return;
			lastSyncHash = "";
			hideSkeleton("syncTeamSkeleton");
			hideSkeleton("syncActorsSkeleton");
			hideSkeleton("syncPeersSkeleton");
			hideSkeleton("syncDiagSkeleton");
			hideStaleSyncSecondarySections();
			renderSyncPeopleUnavailable();
			renderSyncDiagnosticsUnavailable();
		}
	}
	async function loadPairingData() {
		try {
			state.pairingPayloadRaw = await loadPairing() || null;
			renderPairing();
		} catch {
			state.pairingPayloadRaw = null;
			renderPairing();
		}
	}
	function initSyncTab(refreshCallback) {
		ensureSyncRenderBoundary();
		ensureSyncDialogHost();
		setLoadSyncData$1(loadSyncData);
		setLoadSyncData(loadSyncData);
		setRenderSyncPeers(renderSyncPeers);
		initTeamSyncEvents(refreshCallback, loadSyncData);
		initPeopleEvents(loadSyncData);
		initDiagnosticsEvents(refreshCallback);
	}
	//#endregion
	//#region src/tabs/settings.tsx
	var settingsOpen = false;
	var previouslyFocused = null;
	var settingsActiveTab = "observer";
	var settingsBaseline = {};
	var settingsEnvOverrides = {};
	var settingsTouchedKeys = /* @__PURE__ */ new Set();
	var settingsShellMounted = false;
	var settingsProtectedKeys = /* @__PURE__ */ new Set();
	var settingsStartPolling = null;
	var settingsRefresh = null;
	var SETTINGS_ADVANCED_KEY = "codemem-settings-advanced";
	var settingsShowAdvanced = loadAdvancedPreference();
	var DEFAULT_OPENAI_MODEL = "gpt-5.1-codex-mini";
	var DEFAULT_ANTHROPIC_MODEL = "claude-4.5-haiku";
	var settingsController = null;
	var INPUT_TO_CONFIG_KEY = {
		claudeCommand: "claude_command",
		observerProvider: "observer_provider",
		observerModel: "observer_model",
		observerTierRoutingEnabled: "observer_tier_routing_enabled",
		observerSimpleModel: "observer_simple_model",
		observerSimpleTemperature: "observer_simple_temperature",
		observerRichModel: "observer_rich_model",
		observerRichTemperature: "observer_rich_temperature",
		observerRichOpenAIUseResponses: "observer_rich_openai_use_responses",
		observerRichReasoningEffort: "observer_rich_reasoning_effort",
		observerRichReasoningSummary: "observer_rich_reasoning_summary",
		observerRichMaxOutputTokens: "observer_rich_max_output_tokens",
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
	var PROTECTED_VIEWER_CONFIG_KEYS = new Set([
		"claude_command",
		"observer_base_url",
		"observer_auth_file",
		"observer_auth_command",
		"observer_headers",
		"sync_coordinator_url"
	]);
	var settingsRenderState = {
		effectiveText: "",
		isSaving: false,
		observerStatus: null,
		overridesVisible: false,
		pathText: "Config path: n/a",
		providers: [],
		statusText: "Ready",
		values: {
			claudeCommand: "",
			observerProvider: "",
			observerModel: "",
			observerTierRoutingEnabled: false,
			observerSimpleModel: "",
			observerSimpleTemperature: "",
			observerRichModel: "",
			observerRichTemperature: "",
			observerRichOpenAIUseResponses: false,
			observerRichReasoningEffort: "",
			observerRichReasoningSummary: "",
			observerRichMaxOutputTokens: "",
			observerRuntime: "api_http",
			observerAuthSource: "auto",
			observerAuthFile: "",
			observerAuthCommand: "",
			observerAuthTimeoutMs: "",
			observerAuthCacheTtlS: "",
			observerHeaders: "",
			observerMaxChars: "",
			packObservationLimit: "",
			packSessionLimit: "",
			rawEventsSweeperIntervalS: "",
			syncEnabled: false,
			syncHost: "",
			syncPort: "",
			syncInterval: "",
			syncMdns: false,
			syncCoordinatorUrl: "",
			syncCoordinatorGroup: "",
			syncCoordinatorTimeout: "",
			syncCoordinatorPresenceTtl: ""
		}
	};
	function loadAdvancedPreference() {
		try {
			return globalThis.localStorage?.getItem(SETTINGS_ADVANCED_KEY) === "1";
		} catch {
			return false;
		}
	}
	function persistAdvancedPreference(show) {
		try {
			globalThis.localStorage?.setItem(SETTINGS_ADVANCED_KEY, show ? "1" : "0");
		} catch {}
	}
	function hasOwn(obj, key) {
		return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
	}
	function effectiveOrConfigured(config, effective, key) {
		if (hasOwn(effective, key)) return effective[key];
		if (hasOwn(config, key)) return config[key];
	}
	function asInputString(value) {
		if (value === void 0 || value === null) return "";
		return String(value);
	}
	function asBooleanValue(value) {
		if (typeof value === "boolean") return value;
		if (typeof value === "number") return value !== 0;
		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			if (!normalized) return false;
			if ([
				"0",
				"false",
				"no",
				"off"
			].includes(normalized)) return false;
			if ([
				"1",
				"true",
				"yes",
				"on"
			].includes(normalized)) return true;
		}
		return Boolean(value);
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
		if (configuredModel) return {
			model: configuredModel,
			source: "Configured"
		};
		if (runtime === "claude_sidecar") return {
			model: DEFAULT_ANTHROPIC_MODEL,
			source: "Recommended (local Claude session)"
		};
		if (provider === "anthropic") return {
			model: DEFAULT_ANTHROPIC_MODEL,
			source: "Recommended (Anthropic provider)"
		};
		if (provider === "opencode") return {
			model: "opencode/gpt-5.1-codex-mini",
			source: "Recommended (OpenCode Zen provider)"
		};
		if (provider && provider !== "openai") return {
			model: "provider default",
			source: "Recommended (provider default)"
		};
		return {
			model: DEFAULT_OPENAI_MODEL,
			source: "Recommended (direct API)"
		};
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
			case "observer_simple_model":
			case "observer_rich_model":
			case "observer_rich_reasoning_effort":
			case "observer_rich_reasoning_summary":
			case "observer_auth_file":
			case "sync_host":
			case "sync_coordinator_url":
			case "sync_coordinator_group": return normalizeTextValue(asInputString(config?.[key]));
			case "observer_runtime": return normalizeTextValue(asInputString(config?.observer_runtime));
			case "observer_auth_source": return normalizeTextValue(asInputString(config?.observer_auth_source));
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
					if (typeof header === "string" && header.trim() && typeof headerValue === "string") headers[header.trim()] = headerValue;
				});
				return headers;
			}
			case "observer_auth_timeout_ms":
			case "observer_max_chars":
			case "observer_simple_temperature":
			case "observer_rich_temperature":
			case "observer_rich_max_output_tokens":
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
			case "observer_tier_routing_enabled":
			case "observer_rich_openai_use_responses": return asBooleanValue(config?.[key]);
			default: return hasOwn(config, key) ? config[key] : "";
		}
	}
	function mergeOverrideBaseline(baseline, config, envOverrides) {
		const next = { ...baseline };
		Object.keys(envOverrides).forEach((key) => {
			if (hasOwn(next, key)) next[key] = configuredValueForKey(config, key);
		});
		return next;
	}
	function getObserverModelHint() {
		const values = settingsRenderState.values;
		if (values.observerTierRoutingEnabled) return "Tiered routing is enabled: simple/rich model selection now lives in Processing.";
		const inferred = inferObserverModel(values.observerRuntime.trim() || "api_http", values.observerProvider.trim(), normalizeTextValue(values.observerModel));
		return `${[
			"observer_model",
			"observer_provider",
			"observer_runtime"
		].some((key) => hasOwn(settingsEnvOverrides, key)) ? "Env override" : inferred.source}: ${inferred.model}`;
	}
	function getTieredRoutingHelperText() {
		if (!settingsRenderState.values.observerTierRoutingEnabled) return "Off: codemem uses the base observer settings from the Connection tab for all batches.";
		return "On: codemem can route simpler batches to a lighter model and richer batches to a higher-quality configuration.";
	}
	function getObserverModelLabel() {
		return settingsRenderState.values.observerTierRoutingEnabled ? "Base model fallback" : "Model";
	}
	function getObserverModelTooltip() {
		return settingsRenderState.values.observerTierRoutingEnabled ? "Tiered routing is enabled, so Processing controls the simple/rich models. This base model is only a fallback." : "Leave blank to use a recommended model for your selected mode/provider.";
	}
	function getObserverModelDescription() {
		return settingsRenderState.values.observerTierRoutingEnabled ? "Tiered routing is active. Use this only as a fallback while the Processing tab owns simple/rich model selection." : "Default: `gpt-5.1-codex-mini` for Direct API; `claude-4.5-haiku` for Local Claude session.";
	}
	function positionHelpTooltipElement(el, anchor) {
		const rect = anchor.getBoundingClientRect();
		const margin = 8;
		const gap = 8;
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		let left = rect.left + rect.width / 2 - width / 2;
		left = Math.max(margin, Math.min(left, globalThis.innerWidth - width - margin));
		let top = rect.bottom + gap;
		if (top + height > globalThis.innerHeight - margin) top = rect.top - height - gap;
		top = Math.max(margin, top);
		el.style.left = `${Math.round(left)}px`;
		el.style.top = `${Math.round(top)}px`;
	}
	function hideHelpTooltip() {
		settingsController?.hideTooltip();
	}
	function helpButtonFromTarget(target) {
		if (!(target instanceof Element)) return null;
		return target.closest(".help-icon[data-tooltip]");
	}
	function markFieldTouched(inputId) {
		const key = INPUT_TO_CONFIG_KEY[inputId];
		if (!key) return;
		settingsTouchedKeys.add(key);
	}
	function getFocusableNodes(container) {
		if (!container) return [];
		const selector = [
			"button:not([disabled])",
			"input:not([disabled])",
			"select:not([disabled])",
			"textarea:not([disabled])",
			"[href]",
			"[tabindex]:not([tabindex=\"-1\"])"
		].join(",");
		return Array.from(container.querySelectorAll(selector)).filter((node) => {
			const el = node;
			return !el.hidden && el.offsetParent !== null;
		});
	}
	function focusSettingsDialog() {
		const modal = $$2("settingsModal");
		(getFocusableNodes(modal)[0] || modal)?.focus();
	}
	function updateRenderState(patch) {
		if (settingsController) {
			settingsController.setRenderState(patch);
			return;
		}
		settingsRenderState = {
			...settingsRenderState,
			...patch
		};
	}
	function updateFormState(patch) {
		updateRenderState({ values: {
			...settingsRenderState.values,
			...patch
		} });
	}
	function renderSettingsShell() {
		const mount = $$2("settingsDialogMount");
		if (!mount) return;
		J$1(/* @__PURE__ */ u(SettingsDialogShell, {}), mount);
	}
	function ensureSettingsShell() {
		if (!$$2("settingsDialogMount")) return;
		if (settingsShellMounted) return;
		renderSettingsShell();
		settingsShellMounted = true;
	}
	function SettingsDialogShell() {
		const [open, setOpen] = d(settingsOpen);
		const [activeTab, setActiveTabState] = d([
			"observer",
			"queue",
			"sync"
		].includes(settingsActiveTab) ? settingsActiveTab : "observer");
		const [dirty, setDirtyState] = d(state.settingsDirty);
		const [renderState, setRenderStateState] = d(settingsRenderState);
		const [showAdvanced, setShowAdvancedState] = d(settingsShowAdvanced);
		const [tooltip, setTooltip] = d({
			anchor: null,
			content: "",
			visible: false
		});
		const tooltipRef = A$1(null);
		settingsOpen = open;
		settingsActiveTab = activeTab;
		state.settingsDirty = dirty;
		settingsRenderState = renderState;
		settingsShowAdvanced = showAdvanced;
		y(() => {
			settingsController = {
				hideTooltip: () => {
					setTooltip({
						anchor: null,
						content: "",
						visible: false
					});
				},
				setActiveTab: (tab) => {
					const nextTab = [
						"observer",
						"queue",
						"sync"
					].includes(tab) ? tab : "observer";
					settingsActiveTab = nextTab;
					setActiveTabState(nextTab);
				},
				setDirty: (nextDirty) => {
					state.settingsDirty = nextDirty;
					setDirtyState(nextDirty);
				},
				setOpen: (nextOpen) => {
					settingsOpen = nextOpen;
					setOpen(nextOpen);
				},
				setRenderState: (patch) => {
					const nextState = {
						...settingsRenderState,
						...patch
					};
					settingsRenderState = nextState;
					setRenderStateState(nextState);
				},
				setShowAdvanced: (nextShowAdvanced) => {
					settingsShowAdvanced = nextShowAdvanced;
					persistAdvancedPreference(nextShowAdvanced);
					setShowAdvancedState(nextShowAdvanced);
				}
			};
			return () => {
				if (settingsController) settingsController = null;
			};
		}, []);
		y(() => {
			const showTooltip = (anchor) => {
				const content = anchor.dataset.tooltip?.trim();
				if (!content) return;
				setTooltip({
					anchor,
					content,
					visible: true
				});
			};
			const hideTooltip = () => {
				setTooltip((current) => {
					if (!current.visible && !current.anchor && !current.content) return current;
					return {
						anchor: null,
						content: "",
						visible: false
					};
				});
			};
			const onPointerOver = (event) => {
				const button = helpButtonFromTarget(event.target);
				if (!button) return;
				showTooltip(button);
			};
			const onPointerOut = (event) => {
				const button = helpButtonFromTarget(event.target);
				if (!button) return;
				const related = event.relatedTarget;
				if (related instanceof Element && button.contains(related)) return;
				hideTooltip();
			};
			const onFocusIn = (event) => {
				const button = helpButtonFromTarget(event.target);
				if (!button) return;
				showTooltip(button);
			};
			const onFocusOut = (event) => {
				if (!helpButtonFromTarget(event.target)) return;
				hideTooltip();
			};
			const onClick = (event) => {
				const button = helpButtonFromTarget(event.target);
				if (!button) return;
				event.preventDefault();
				setTooltip((current) => {
					if (current.anchor === button && current.visible) return {
						anchor: null,
						content: "",
						visible: false
					};
					const content = button.dataset.tooltip?.trim() || "";
					if (!content) return current;
					return {
						anchor: button,
						content,
						visible: true
					};
				});
			};
			document.addEventListener("pointerover", onPointerOver);
			document.addEventListener("pointerout", onPointerOut);
			document.addEventListener("focusin", onFocusIn);
			document.addEventListener("focusout", onFocusOut);
			document.addEventListener("click", onClick);
			return () => {
				document.removeEventListener("pointerover", onPointerOver);
				document.removeEventListener("pointerout", onPointerOut);
				document.removeEventListener("focusin", onFocusIn);
				document.removeEventListener("focusout", onFocusOut);
				document.removeEventListener("click", onClick);
			};
		}, []);
		_(() => {
			if (!tooltip.visible || !tooltip.anchor || !tooltipRef.current) return;
			const frame = requestAnimationFrame(() => {
				if (tooltipRef.current && tooltip.anchor) positionHelpTooltipElement(tooltipRef.current, tooltip.anchor);
			});
			return () => {
				cancelAnimationFrame(frame);
			};
		}, [
			tooltip.anchor,
			tooltip.content,
			tooltip.visible
		]);
		y(() => {
			if (!tooltip.visible || !tooltip.anchor) return;
			const reposition = () => {
				if (tooltipRef.current && tooltip.anchor) positionHelpTooltipElement(tooltipRef.current, tooltip.anchor);
			};
			globalThis.addEventListener("resize", reposition);
			document.addEventListener("scroll", reposition, true);
			return () => {
				globalThis.removeEventListener("resize", reposition);
				document.removeEventListener("scroll", reposition, true);
			};
		}, [tooltip.anchor, tooltip.visible]);
		const tooltipPortal = T$1(() => {
			if (typeof document === "undefined") return null;
			return $(/* @__PURE__ */ u("div", {
				className: `help-tooltip${tooltip.visible ? " visible" : ""}`,
				hidden: !tooltip.visible,
				ref: tooltipRef,
				children: tooltip.content
			}), document.body);
		}, [tooltip.content, tooltip.visible]);
		const close = q$1(() => {
			if (settingsStartPolling && settingsRefresh) closeSettings(settingsStartPolling, settingsRefresh);
		}, []);
		return /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u(RadixDialog, {
			ariaDescribedby: "settingsDescription",
			ariaLabelledby: "settingsTitle",
			contentClassName: "modal",
			contentId: "settingsModal",
			onCloseAutoFocus: (event) => {
				event.preventDefault();
			},
			onOpenAutoFocus: (event) => {
				event.preventDefault();
				focusSettingsDialog();
			},
			onOpenChange: (nextOpen) => {
				if (nextOpen) {
					setOpen(true);
					return;
				}
				close();
			},
			open,
			overlayClassName: "modal-backdrop",
			overlayId: "settingsBackdrop",
			children: /* @__PURE__ */ u(SettingsDialogContent, {})
		}), tooltipPortal] });
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
		const warnings = Array.isArray(effects.warnings) ? effects.warnings.filter((value) => typeof value === "string" && value.trim().length > 0) : [];
		const manualActions = Array.isArray(effects.manual_actions) ? effects.manual_actions : [];
		const sync = effects.sync && typeof effects.sync === "object" ? effects.sync : {};
		const lines = [];
		if (hotReloaded.length) lines.push(`Applied now: ${joinPhrases(hotReloaded)}.`);
		if (liveApplied.length) lines.push(`Live settings updated: ${joinPhrases(liveApplied)}.`);
		if (sync.attempted && typeof sync.message === "string" && sync.message) lines.push(`Sync: ${sync.message}.`);
		else if (Array.isArray(sync.affected_keys) && sync.affected_keys.length && typeof sync.reason === "string" && sync.reason) lines.push(`Sync: ${sync.reason}.`);
		if (restartRequired.length) lines.push(`Restart required for ${joinPhrases(restartRequired)}. Run: codemem serve restart`);
		warnings.forEach((warning) => {
			lines.push(warning);
		});
		manualActions.forEach((action) => {
			if (action && typeof action.command === "string" && action.command.trim()) lines.push(`If needed: ${action.command}.`);
		});
		if (!lines.length) lines.push("Saved.");
		const hasWarning = restartRequired.length > 0 || warnings.length > 0 || sync.ok === false;
		return {
			message: lines.join(" "),
			type: hasWarning ? "warning" : "success"
		};
	}
	function isProtectedConfigKey(key) {
		return settingsProtectedKeys.has(key) || PROTECTED_VIEWER_CONFIG_KEYS.has(key);
	}
	function protectedConfigHelp(key) {
		return `${key} is read-only in the viewer for security. Edit the config file or environment instead.`;
	}
	function formStateFromPayload(payload) {
		const config = payload.config || {};
		const effective = payload.effective || {};
		const observerHeadersValue = effectiveOrConfigured(config, effective, "observer_headers");
		const observerHeaders = observerHeadersValue && typeof observerHeadersValue === "object" && !Array.isArray(observerHeadersValue) ? Object.fromEntries(Object.entries(observerHeadersValue).filter(([key, value]) => typeof key === "string" && key.trim() && typeof value === "string")) : {};
		const claudeCommandValue = effectiveOrConfigured(config, effective, "claude_command");
		const claudeCommand = Array.isArray(claudeCommandValue) ? claudeCommandValue.filter((item) => typeof item === "string") : [];
		const authCommandValue = effectiveOrConfigured(config, effective, "observer_auth_command");
		const authCommand = Array.isArray(authCommandValue) ? authCommandValue.filter((item) => typeof item === "string") : [];
		return {
			claudeCommand: claudeCommand.length ? JSON.stringify(claudeCommand, null, 2) : "",
			observerProvider: asInputString(effectiveOrConfigured(config, effective, "observer_provider")),
			observerModel: asInputString(effectiveOrConfigured(config, effective, "observer_model")),
			observerTierRoutingEnabled: asBooleanValue(effectiveOrConfigured(config, effective, "observer_tier_routing_enabled")),
			observerSimpleModel: asInputString(effectiveOrConfigured(config, effective, "observer_simple_model")),
			observerSimpleTemperature: asInputString(effectiveOrConfigured(config, effective, "observer_simple_temperature")),
			observerRichModel: asInputString(effectiveOrConfigured(config, effective, "observer_rich_model")),
			observerRichTemperature: asInputString(effectiveOrConfigured(config, effective, "observer_rich_temperature")),
			observerRichOpenAIUseResponses: asBooleanValue(effectiveOrConfigured(config, effective, "observer_rich_openai_use_responses")),
			observerRichReasoningEffort: asInputString(effectiveOrConfigured(config, effective, "observer_rich_reasoning_effort")),
			observerRichReasoningSummary: asInputString(effectiveOrConfigured(config, effective, "observer_rich_reasoning_summary")),
			observerRichMaxOutputTokens: asInputString(effectiveOrConfigured(config, effective, "observer_rich_max_output_tokens")),
			observerRuntime: asInputString(effectiveOrConfigured(config, effective, "observer_runtime")) || "api_http",
			observerAuthSource: asInputString(effectiveOrConfigured(config, effective, "observer_auth_source")) || "auto",
			observerAuthFile: asInputString(effectiveOrConfigured(config, effective, "observer_auth_file")),
			observerAuthCommand: authCommand.length ? JSON.stringify(authCommand, null, 2) : "",
			observerAuthTimeoutMs: asInputString(effectiveOrConfigured(config, effective, "observer_auth_timeout_ms")),
			observerAuthCacheTtlS: asInputString(effectiveOrConfigured(config, effective, "observer_auth_cache_ttl_s")),
			observerHeaders: Object.keys(observerHeaders).length ? JSON.stringify(observerHeaders, null, 2) : "",
			observerMaxChars: asInputString(effectiveOrConfigured(config, effective, "observer_max_chars")),
			packObservationLimit: asInputString(effectiveOrConfigured(config, effective, "pack_observation_limit")),
			packSessionLimit: asInputString(effectiveOrConfigured(config, effective, "pack_session_limit")),
			rawEventsSweeperIntervalS: asInputString(effectiveOrConfigured(config, effective, "raw_events_sweeper_interval_s")),
			syncEnabled: asBooleanValue(effectiveOrConfigured(config, effective, "sync_enabled")),
			syncHost: asInputString(effectiveOrConfigured(config, effective, "sync_host")),
			syncPort: asInputString(effectiveOrConfigured(config, effective, "sync_port")),
			syncInterval: asInputString(effectiveOrConfigured(config, effective, "sync_interval_s")),
			syncMdns: asBooleanValue(effectiveOrConfigured(config, effective, "sync_mdns")),
			syncCoordinatorUrl: asInputString(effectiveOrConfigured(config, effective, "sync_coordinator_url")),
			syncCoordinatorGroup: asInputString(effectiveOrConfigured(config, effective, "sync_coordinator_group")),
			syncCoordinatorTimeout: asInputString(effectiveOrConfigured(config, effective, "sync_coordinator_timeout_s")),
			syncCoordinatorPresenceTtl: asInputString(effectiveOrConfigured(config, effective, "sync_coordinator_presence_ttl_s"))
		};
	}
	function renderConfigModal(payload) {
		if (!payload || typeof payload !== "object") return;
		const defaults = payload.defaults || {};
		const config = payload.config || {};
		const envOverrides = payload.env_overrides && typeof payload.env_overrides === "object" ? payload.env_overrides : {};
		const protectedKeys = Array.isArray(payload.protected_keys) ? payload.protected_keys.filter((value) => typeof value === "string" && value.trim().length > 0) : [];
		const values = formStateFromPayload(payload);
		settingsEnvOverrides = envOverrides;
		settingsProtectedKeys = new Set(protectedKeys);
		state.configDefaults = defaults;
		state.configPath = payload.path || "";
		updateRenderState({
			effectiveText: Object.keys(envOverrides).length > 0 ? "Some fields are managed by environment settings." : "",
			overridesVisible: Object.keys(envOverrides).length > 0,
			pathText: state.configPath ? `Config path: ${state.configPath}` : "Config path: n/a",
			providers: toProviderList(payload.providers),
			statusText: "Ready",
			values
		});
		settingsTouchedKeys = /* @__PURE__ */ new Set();
		try {
			settingsBaseline = mergeOverrideBaseline(collectSettingsPayload({ allowUntouchedParseErrors: true }), config, envOverrides);
		} catch {
			settingsBaseline = {};
		}
		setDirty(false);
	}
	function parseCommandArgv(raw, options) {
		const text = raw.trim();
		if (!text) return [];
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`${options.label} must be a JSON string array`);
		if (!options.normalize && !options.requireNonEmpty) return parsed;
		const values = options.normalize ? parsed.map((item) => item.trim()) : parsed;
		if (options.requireNonEmpty && values.some((item) => item.trim() === "")) throw new Error(`${options.label} cannot contain empty command tokens`);
		return values;
	}
	function parseObserverHeaders(raw) {
		const text = raw.trim();
		if (!text) return {};
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("observer headers must be a JSON object");
		const headers = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof key !== "string" || !key.trim() || typeof value !== "string") throw new Error("observer headers must map string keys to string values");
			headers[key.trim()] = value;
		}
		return headers;
	}
	function collectSettingsPayload(options = {}) {
		const allowUntouchedParseErrors = options.allowUntouchedParseErrors === true;
		const values = settingsRenderState.values;
		let claudeCommand = [];
		try {
			claudeCommand = parseCommandArgv(values.claudeCommand, {
				label: "claude command",
				normalize: true,
				requireNonEmpty: true
			});
		} catch (error) {
			if (!allowUntouchedParseErrors || settingsTouchedKeys.has("claude_command")) throw error;
			const baseline = settingsBaseline.claude_command;
			claudeCommand = Array.isArray(baseline) ? baseline.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0) : [];
		}
		let authCommand = [];
		try {
			authCommand = parseCommandArgv(values.observerAuthCommand, { label: "observer auth command" });
		} catch (error) {
			if (!allowUntouchedParseErrors || settingsTouchedKeys.has("observer_auth_command")) throw error;
			const baseline = settingsBaseline.observer_auth_command;
			authCommand = Array.isArray(baseline) ? baseline.filter((item) => typeof item === "string") : [];
		}
		let headers = {};
		try {
			headers = parseObserverHeaders(values.observerHeaders);
		} catch (error) {
			if (!allowUntouchedParseErrors || settingsTouchedKeys.has("observer_headers")) throw error;
			const baseline = settingsBaseline.observer_headers;
			if (baseline && typeof baseline === "object" && !Array.isArray(baseline)) Object.entries(baseline).forEach(([key, value]) => {
				if (typeof key === "string" && key.trim() && typeof value === "string") headers[key] = value;
			});
		}
		const authCacheTtlInput = values.observerAuthCacheTtlS.trim();
		const simpleTemperatureInput = values.observerSimpleTemperature.trim();
		const richTemperatureInput = values.observerRichTemperature.trim();
		const richMaxOutputTokensInput = values.observerRichMaxOutputTokens.trim();
		const sweeperIntervalInput = values.rawEventsSweeperIntervalS.trim();
		const authCacheTtl = authCacheTtlInput === "" ? "" : Number(authCacheTtlInput);
		const simpleTemperature = simpleTemperatureInput === "" ? "" : Number(simpleTemperatureInput);
		const richTemperature = richTemperatureInput === "" ? "" : Number(richTemperatureInput);
		const richMaxOutputTokens = richMaxOutputTokensInput === "" ? "" : Number(richMaxOutputTokensInput);
		const sweeperIntervalNum = Number(sweeperIntervalInput);
		const sweeperInterval = sweeperIntervalInput === "" ? "" : sweeperIntervalNum;
		if (authCacheTtlInput !== "" && !Number.isFinite(authCacheTtl)) throw new Error("observer auth cache ttl must be a number");
		if (simpleTemperatureInput !== "" && (typeof simpleTemperature !== "number" || !Number.isFinite(simpleTemperature) || simpleTemperature < 0)) throw new Error("simple tier temperature must be a non-negative number");
		if (richTemperatureInput !== "" && (typeof richTemperature !== "number" || !Number.isFinite(richTemperature) || richTemperature < 0)) throw new Error("rich tier temperature must be a non-negative number");
		if (richMaxOutputTokensInput !== "" && (typeof richMaxOutputTokens !== "number" || !Number.isFinite(richMaxOutputTokens) || richMaxOutputTokens <= 0 || !Number.isInteger(richMaxOutputTokens))) throw new Error("rich tier max output tokens must be a positive integer");
		if (sweeperIntervalInput !== "" && (!Number.isFinite(sweeperIntervalNum) || sweeperIntervalNum <= 0)) throw new Error("raw-event sweeper interval must be a positive number");
		return {
			claude_command: claudeCommand,
			observer_provider: normalizeTextValue(values.observerProvider),
			observer_model: normalizeTextValue(values.observerModel),
			observer_tier_routing_enabled: values.observerTierRoutingEnabled,
			observer_simple_model: normalizeTextValue(values.observerSimpleModel),
			observer_simple_temperature: simpleTemperature,
			observer_rich_model: normalizeTextValue(values.observerRichModel),
			observer_rich_temperature: richTemperature,
			observer_rich_openai_use_responses: values.observerRichOpenAIUseResponses,
			observer_rich_reasoning_effort: normalizeTextValue(values.observerRichReasoningEffort),
			observer_rich_reasoning_summary: normalizeTextValue(values.observerRichReasoningSummary),
			observer_rich_max_output_tokens: richMaxOutputTokens,
			observer_runtime: normalizeTextValue(values.observerRuntime || "api_http") || "api_http",
			observer_auth_source: normalizeTextValue(values.observerAuthSource || "auto") || "auto",
			observer_auth_file: normalizeTextValue(values.observerAuthFile),
			observer_auth_command: authCommand,
			observer_auth_timeout_ms: Number(values.observerAuthTimeoutMs || 0) || "",
			observer_auth_cache_ttl_s: authCacheTtl,
			observer_headers: headers,
			observer_max_chars: Number(values.observerMaxChars || 0) || "",
			pack_observation_limit: Number(values.packObservationLimit || 0) || "",
			pack_session_limit: Number(values.packSessionLimit || 0) || "",
			raw_events_sweeper_interval_s: sweeperInterval,
			sync_enabled: values.syncEnabled,
			sync_host: normalizeTextValue(values.syncHost),
			sync_port: Number(values.syncPort || 0) || "",
			sync_interval_s: Number(values.syncInterval || 0) || "",
			sync_mdns: values.syncMdns,
			sync_coordinator_url: normalizeTextValue(values.syncCoordinatorUrl),
			sync_coordinator_group: normalizeTextValue(values.syncCoordinatorGroup),
			sync_coordinator_timeout_s: Number(values.syncCoordinatorTimeout || 0) || "",
			sync_coordinator_presence_ttl_s: Number(values.syncCoordinatorPresenceTtl || 0) || ""
		};
	}
	function setSettingsTab(tab) {
		const nextTab = [
			"observer",
			"queue",
			"sync"
		].includes(tab) ? tab : "observer";
		settingsActiveTab = nextTab;
		settingsController?.setActiveTab(nextTab);
	}
	function setDirty(dirty, rerender = true) {
		state.settingsDirty = dirty;
		if (rerender) settingsController?.setDirty(dirty);
	}
	function openSettings(stopPolling) {
		if (!settingsShellMounted) ensureSettingsShell();
		settingsOpen = true;
		previouslyFocused = document.activeElement;
		stopPolling();
		settingsController?.setOpen(true);
	}
	function closeSettings(startPolling, refreshCallback) {
		if (state.settingsDirty) {
			if (!globalThis.confirm("Discard unsaved changes?")) {
				settingsController?.setOpen(true);
				return;
			}
		}
		settingsOpen = false;
		settingsController?.setOpen(false);
		hideHelpTooltip();
		(previouslyFocused && typeof previouslyFocused.focus === "function" ? previouslyFocused : $button("settingsButton"))?.focus();
		previouslyFocused = null;
		settingsTouchedKeys = /* @__PURE__ */ new Set();
		startPolling();
		refreshCallback();
	}
	async function saveSettings(startPolling, refreshCallback) {
		if (settingsRenderState.isSaving) return;
		updateRenderState({
			isSaving: true,
			statusText: "Saving..."
		});
		try {
			const current = collectSettingsPayload({ allowUntouchedParseErrors: true });
			const changed = {};
			Object.entries(current).forEach(([key, value]) => {
				if (isProtectedConfigKey(key)) return;
				if (hasOwn(settingsEnvOverrides, key) && !settingsTouchedKeys.has(key)) return;
				if (!isEqualValue(value, settingsBaseline[key])) changed[key] = value;
			});
			if (Object.keys(changed).length === 0) {
				updateRenderState({
					isSaving: false,
					statusText: "No changes"
				});
				setDirty(false);
				closeSettings(startPolling, refreshCallback);
				return;
			}
			const notice = buildSettingsNotice(await saveConfig(changed));
			updateRenderState({
				isSaving: false,
				statusText: "Saved"
			});
			setDirty(false);
			closeSettings(startPolling, refreshCallback);
			showGlobalNotice(notice.message, notice.type);
		} catch (error) {
			updateRenderState({
				isSaving: false,
				statusText: `Save failed: ${error instanceof Error ? error.message : "unknown error"}`
			});
		}
	}
	function formatAuthMethod(method) {
		switch (method) {
			case "anthropic_consumer": return "OAuth (Claude Max/Pro)";
			case "codex_consumer": return "OAuth (ChatGPT subscription)";
			case "sdk_client": return "API key";
			case "claude_sidecar": return "Local Claude session";
			case "opencode_run": return "OpenCode sidecar";
			default: return method || "none";
		}
	}
	function formatCredentialSources(creds) {
		const parts = [];
		if (creds.oauth) parts.push("OAuth");
		if (creds.api_key) parts.push("API key");
		if (creds.env_var) parts.push("env var");
		return parts.length ? parts.join(", ") : "none";
	}
	function formatFailureTimestamp(value) {
		if (typeof value !== "string" || !value.trim()) return "Unknown time";
		const ts = new Date(value);
		if (Number.isNaN(ts.getTime())) return value;
		return ts.toLocaleString();
	}
	function renderObserverStatusBanner(status) {
		updateRenderState({ observerStatus: status && typeof status === "object" ? status : null });
	}
	async function loadConfigData() {
		if (settingsOpen) return;
		try {
			const [payload, status] = await Promise.all([loadConfig(), loadObserverStatus().catch(() => null)]);
			renderConfigModal(payload);
			renderObserverStatusBanner(status);
		} catch {}
	}
	function updateField(field, value) {
		markFieldTouched(field);
		updateFormState({ [field]: value });
		setDirty(true);
	}
	function onTextInput(field) {
		return (event) => {
			updateField(field, event.currentTarget.value);
		};
	}
	function onSelectInput(field) {
		return (event) => {
			updateField(field, event.currentTarget.value);
		};
	}
	function onCheckboxInput(field) {
		return (event) => {
			updateField(field, event.currentTarget.checked);
		};
	}
	function onAdvancedToggle(event) {
		const checked = event.currentTarget.checked;
		settingsShowAdvanced = checked;
		settingsController?.setShowAdvanced(checked);
	}
	function tabButtonClass(tab) {
		return `settings-tab${settingsActiveTab === tab ? " active" : ""}`;
	}
	function panelClass(tab) {
		return `settings-panel${settingsActiveTab === tab ? " active" : ""}`;
	}
	function hiddenUnlessAdvanced() {
		return !settingsShowAdvanced;
	}
	function ObserverStatusBanner() {
		const status = settingsRenderState.observerStatus;
		if (!status) return /* @__PURE__ */ u("div", {
			id: "observerStatusBanner",
			className: "observer-status-banner",
			hidden: true
		});
		const active = status.active;
		const available = status.available_credentials || {};
		const failure = status.latest_failure;
		const credentialEntries = Object.entries(available).filter(([, creds]) => creds && typeof creds === "object");
		return /* @__PURE__ */ u("div", {
			id: "observerStatusBanner",
			className: "observer-status-banner",
			children: [
				active ? /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u("div", {
					className: "status-label",
					children: "Active observer"
				}), /* @__PURE__ */ u("div", {
					className: "status-active",
					children: [
						String(active.provider || "unknown"),
						" → ",
						String(active.model || ""),
						" via",
						" ",
						formatAuthMethod(active.auth?.method || "none"),
						" ",
						/* @__PURE__ */ u("span", {
							className: active.auth?.token_present === true ? "cred-ok" : "cred-none",
							children: active.auth?.token_present === true ? "✓" : "✗"
						})
					]
				})] }) : /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u("div", {
					className: "status-label",
					children: "Observer status"
				}), /* @__PURE__ */ u("div", {
					className: "status-active",
					children: "Not yet initialized (waiting for first session)"
				})] }),
				credentialEntries.length ? /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u("div", {
					className: "status-label",
					children: "Available credentials"
				}), /* @__PURE__ */ u("div", { children: credentialEntries.map(([provider, creds], index) => {
					const normalizedCreds = creds;
					const hasAny = Object.values(normalizedCreds).some(Boolean);
					return /* @__PURE__ */ u("span", {
						className: "status-cred",
						children: [
							index > 0 ? " · " : null,
							/* @__PURE__ */ u("span", {
								className: hasAny ? "cred-ok" : "cred-none",
								children: hasAny ? "✓" : "–"
							}),
							" ",
							String(provider),
							": ",
							formatCredentialSources(normalizedCreds)
						]
					}, provider);
				}) })] }) : null,
				failure && typeof failure === "object" ? /* @__PURE__ */ u(k$2, { children: [/* @__PURE__ */ u("div", {
					className: "status-label",
					children: "Latest processing issue"
				}), /* @__PURE__ */ u("div", {
					className: "status-issue",
					children: [
						/* @__PURE__ */ u("div", {
							className: "status-issue-message",
							children: typeof failure.error_message === "string" && failure.error_message.trim() ? failure.error_message.trim() : "Raw-event processing failed."
						}),
						/* @__PURE__ */ u("div", {
							className: "status-issue-meta",
							children: [
								[
									typeof failure.observer_provider === "string" ? failure.observer_provider.trim() : "",
									typeof failure.observer_model === "string" && failure.observer_model.trim() ? `→ ${failure.observer_model.trim()}` : "",
									typeof failure.observer_runtime === "string" && failure.observer_runtime.trim() ? `(${failure.observer_runtime.trim()})` : ""
								].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
								`Last failure ${formatFailureTimestamp(failure.updated_at)}`,
								typeof failure.attempt_count === "number" && Number.isFinite(failure.attempt_count) ? `Attempts ${failure.attempt_count}` : ""
							].filter(Boolean).join(" · ")
						}),
						typeof failure.impact === "string" && failure.impact.trim() ? /* @__PURE__ */ u("div", {
							className: "status-issue-impact",
							children: failure.impact.trim()
						}) : null
					]
				})] }) : null
			]
		});
	}
	function Field({ children, className = "field", hidden = false, id }) {
		return /* @__PURE__ */ u("div", {
			className,
			hidden,
			id,
			children
		});
	}
	function SettingsDialogContent() {
		const values = settingsRenderState.values;
		const observerMaxCharsDefault = state.configDefaults?.observer_max_chars || "";
		const showAuthFile = values.observerAuthSource === "file";
		const showAuthCommand = values.observerAuthSource === "command";
		const showTieredRouting = values.observerTierRoutingEnabled;
		return /* @__PURE__ */ u("div", {
			className: "modal-card",
			children: [
				/* @__PURE__ */ u("div", {
					className: "modal-header",
					children: [/* @__PURE__ */ u("h2", {
						id: "settingsTitle",
						children: "Memory & model settings"
					}), /* @__PURE__ */ u("button", {
						"aria-label": "Close settings",
						className: "modal-close",
						id: "settingsClose",
						onClick: () => {
							if (settingsStartPolling && settingsRefresh) closeSettings(settingsStartPolling, settingsRefresh);
						},
						type: "button",
						children: "close"
					})]
				}),
				/* @__PURE__ */ u("div", {
					className: "modal-body",
					children: [
						/* @__PURE__ */ u("div", {
							className: "small",
							id: "settingsDescription",
							children: "Configure connection, authentication, processing, and sync behavior."
						}),
						/* @__PURE__ */ u("div", {
							"aria-label": "Settings sections",
							className: "settings-tabs",
							role: "tablist",
							children: [
								/* @__PURE__ */ u("button", {
									"aria-selected": settingsActiveTab === "observer" ? "true" : "false",
									className: tabButtonClass("observer"),
									"data-settings-tab": "observer",
									id: "settingsTabObserver",
									onClick: () => setSettingsTab("observer"),
									role: "tab",
									type: "button",
									children: "Connection"
								}),
								/* @__PURE__ */ u("button", {
									"aria-selected": settingsActiveTab === "queue" ? "true" : "false",
									className: tabButtonClass("queue"),
									"data-settings-tab": "queue",
									id: "settingsTabQueue",
									onClick: () => setSettingsTab("queue"),
									role: "tab",
									type: "button",
									children: "Processing"
								}),
								/* @__PURE__ */ u("button", {
									"aria-selected": settingsActiveTab === "sync" ? "true" : "false",
									className: tabButtonClass("sync"),
									"data-settings-tab": "sync",
									id: "settingsTabSync",
									onClick: () => setSettingsTab("sync"),
									role: "tab",
									type: "button",
									children: "Device Sync"
								})
							]
						}),
						/* @__PURE__ */ u("div", {
							className: "settings-advanced-toolbar field-checkbox",
							children: [
								/* @__PURE__ */ u("input", {
									checked: settingsShowAdvanced,
									className: "cm-checkbox",
									id: "settingsAdvancedToggle",
									onChange: onAdvancedToggle,
									type: "checkbox"
								}),
								/* @__PURE__ */ u("label", {
									htmlFor: "settingsAdvancedToggle",
									children: "Show advanced controls"
								}),
								/* @__PURE__ */ u("button", {
									"aria-label": "About advanced controls",
									className: "help-icon",
									"data-tooltip": "Advanced controls include JSON fields, tuning values, and network overrides.",
									type: "button",
									children: "?"
								})
							]
						}),
						/* @__PURE__ */ u("div", {
							className: panelClass("observer"),
							"data-settings-panel": "observer",
							hidden: settingsActiveTab !== "observer",
							id: "settingsPanelObserver",
							children: [
								/* @__PURE__ */ u(ObserverStatusBanner, {}),
								/* @__PURE__ */ u("div", {
									className: "settings-group",
									children: [
										/* @__PURE__ */ u("h3", {
											className: "settings-group-title",
											children: "Connection"
										}),
										/* @__PURE__ */ u(Field, { children: [
											/* @__PURE__ */ u("div", {
												className: "field-label",
												children: [/* @__PURE__ */ u("label", {
													htmlFor: "observerProvider",
													children: "Model provider"
												}), /* @__PURE__ */ u("button", {
													"aria-label": "About model provider",
													className: "help-icon",
													"data-tooltip": "Choose where model requests are sent. Use auto for recommended defaults.",
													type: "button",
													children: "?"
												})]
											}),
											/* @__PURE__ */ u("select", {
												id: "observerProvider",
												onChange: onSelectInput("observerProvider"),
												value: values.observerProvider,
												children: [/* @__PURE__ */ u("option", {
													value: "",
													children: "auto (default)"
												}), Array.from(new Set(settingsRenderState.providers.concat(values.observerProvider ? [values.observerProvider] : []))).sort((left, right) => left.localeCompare(right)).map((provider) => /* @__PURE__ */ u("option", {
													value: provider,
													children: provider
												}, provider))]
											}),
											/* @__PURE__ */ u("div", {
												className: "small",
												children: "`auto` uses recommended defaults for the selected connection mode."
											})
										] }),
										/* @__PURE__ */ u(Field, { children: [
											/* @__PURE__ */ u("div", {
												className: "field-label",
												children: [/* @__PURE__ */ u("label", {
													htmlFor: "observerModel",
													children: getObserverModelLabel()
												}), /* @__PURE__ */ u("button", {
													"aria-label": "About model defaults",
													className: "help-icon",
													"data-tooltip": getObserverModelTooltip(),
													type: "button",
													children: "?"
												})]
											}),
											/* @__PURE__ */ u("input", {
												id: "observerModel",
												onInput: onTextInput("observerModel"),
												placeholder: "leave empty for default",
												value: values.observerModel
											}),
											/* @__PURE__ */ u("div", {
												className: "small",
												children: getObserverModelDescription()
											}),
											/* @__PURE__ */ u("div", {
												className: "small",
												id: "observerModelHint",
												children: getObserverModelHint()
											})
										] }),
										/* @__PURE__ */ u(Field, { children: [
											/* @__PURE__ */ u("div", {
												className: "field-label",
												children: [/* @__PURE__ */ u("label", {
													htmlFor: "observerRuntime",
													children: "Connection mode"
												}), /* @__PURE__ */ u("button", {
													"aria-label": "About connection mode",
													className: "help-icon",
													"data-tooltip": "Direct API uses provider credentials. Local Claude session uses local Claude runtime auth.",
													type: "button",
													children: "?"
												})]
											}),
											/* @__PURE__ */ u("select", {
												id: "observerRuntime",
												onChange: onSelectInput("observerRuntime"),
												value: values.observerRuntime,
												children: [/* @__PURE__ */ u("option", {
													value: "api_http",
													children: "Direct API (default)"
												}), /* @__PURE__ */ u("option", {
													value: "claude_sidecar",
													children: "Local Claude session"
												})]
											}),
											/* @__PURE__ */ u("div", {
												className: "small",
												children: "Switch between provider API credentials and local Claude session auth."
											})
										] }),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: hiddenUnlessAdvanced(),
											children: [
												/* @__PURE__ */ u("label", {
													htmlFor: "claudeCommand",
													children: "Claude command (JSON argv)"
												}),
												/* @__PURE__ */ u("textarea", {
													disabled: true,
													id: "claudeCommand",
													placeholder: "[\"claude\"]",
													rows: 2,
													value: values.claudeCommand
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													children: protectedConfigHelp("claude_command")
												})
											]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: hiddenUnlessAdvanced(),
											children: [
												/* @__PURE__ */ u("label", {
													htmlFor: "observerMaxChars",
													children: "Request size limit (chars)"
												}),
												/* @__PURE__ */ u("input", {
													id: "observerMaxChars",
													min: "1",
													onInput: onTextInput("observerMaxChars"),
													type: "number",
													value: values.observerMaxChars
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													id: "observerMaxCharsHint",
													children: observerMaxCharsDefault ? `Default: ${observerMaxCharsDefault}` : ""
												})
											]
										})
									]
								}),
								/* @__PURE__ */ u("div", {
									className: "settings-group",
									children: [
										/* @__PURE__ */ u("h3", {
											className: "settings-group-title",
											children: "Authentication"
										}),
										/* @__PURE__ */ u(Field, { children: [
											/* @__PURE__ */ u("div", {
												className: "field-label",
												children: [/* @__PURE__ */ u("label", {
													htmlFor: "observerAuthSource",
													children: "Authentication method"
												}), /* @__PURE__ */ u("button", {
													"aria-label": "About authentication method",
													className: "help-icon",
													"data-tooltip": "Choose how credentials are resolved: environment, file, command, or none.",
													type: "button",
													children: "?"
												})]
											}),
											/* @__PURE__ */ u("select", {
												id: "observerAuthSource",
												onChange: onSelectInput("observerAuthSource"),
												value: values.observerAuthSource,
												children: [
													/* @__PURE__ */ u("option", {
														value: "auto",
														children: "auto (default)"
													}),
													/* @__PURE__ */ u("option", {
														value: "env",
														children: "env"
													}),
													/* @__PURE__ */ u("option", {
														value: "file",
														children: "file"
													}),
													/* @__PURE__ */ u("option", {
														value: "command",
														children: "command"
													}),
													/* @__PURE__ */ u("option", {
														value: "none",
														children: "none"
													})
												]
											}),
											/* @__PURE__ */ u("div", {
												className: "small",
												children: "Use `auto` unless you need a specific token source."
											})
										] }),
										/* @__PURE__ */ u(Field, {
											hidden: !showAuthFile,
											id: "observerAuthFileField",
											children: [
												/* @__PURE__ */ u("label", {
													htmlFor: "observerAuthFile",
													children: "Token file path"
												}),
												/* @__PURE__ */ u("input", {
													disabled: true,
													id: "observerAuthFile",
													placeholder: "~/.codemem/work-token.txt",
													value: values.observerAuthFile
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													children: protectedConfigHelp("observer_auth_file")
												})
											]
										}),
										/* @__PURE__ */ u(Field, {
											hidden: !showAuthCommand,
											id: "observerAuthCommandField",
											children: [
												/* @__PURE__ */ u("div", {
													className: "field-label",
													children: [/* @__PURE__ */ u("label", {
														htmlFor: "observerAuthCommand",
														children: "Token command"
													}), /* @__PURE__ */ u("button", {
														"aria-label": "About token command",
														className: "help-icon",
														"data-tooltip": "Runs this command and uses stdout as the token. JSON argv only, no shell parsing.",
														type: "button",
														children: "?"
													})]
												}),
												/* @__PURE__ */ u("textarea", {
													disabled: true,
													id: "observerAuthCommand",
													placeholder: "[\"iap-auth\", \"--audience\", \"gateway\"]",
													rows: 3,
													value: values.observerAuthCommand
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													children: protectedConfigHelp("observer_auth_command")
												})
											]
										}),
										/* @__PURE__ */ u("div", {
											className: "small",
											hidden: !showAuthCommand,
											id: "observerAuthCommandNote",
											children: "Command format: JSON string array, e.g. `[\"iap-auth\", \"--audience\", \"gateway\"]`."
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: hiddenUnlessAdvanced(),
											children: [/* @__PURE__ */ u("label", {
												htmlFor: "observerAuthTimeoutMs",
												children: "Token command timeout (ms)"
											}), /* @__PURE__ */ u("input", {
												id: "observerAuthTimeoutMs",
												min: "1",
												onInput: onTextInput("observerAuthTimeoutMs"),
												type: "number",
												value: values.observerAuthTimeoutMs
											})]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: hiddenUnlessAdvanced(),
											children: [/* @__PURE__ */ u("label", {
												htmlFor: "observerAuthCacheTtlS",
												children: "Token cache time (s)"
											}), /* @__PURE__ */ u("input", {
												id: "observerAuthCacheTtlS",
												min: "0",
												onInput: onTextInput("observerAuthCacheTtlS"),
												type: "number",
												value: values.observerAuthCacheTtlS
											})]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: hiddenUnlessAdvanced(),
											children: [
												/* @__PURE__ */ u("div", {
													className: "field-label",
													children: [/* @__PURE__ */ u("label", {
														htmlFor: "observerHeaders",
														children: "Request headers (JSON)"
													}), /* @__PURE__ */ u("button", {
														"aria-label": "About request headers",
														className: "help-icon",
														"data-tooltip": "Optional extra headers. Supports templates like ${auth.token}, ${auth.type}, ${auth.source}.",
														type: "button",
														children: "?"
													})]
												}),
												/* @__PURE__ */ u("textarea", {
													disabled: true,
													id: "observerHeaders",
													placeholder: "{\"Authorization\":\"Bearer ${auth.token}\"}",
													rows: 4,
													value: values.observerHeaders
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													children: protectedConfigHelp("observer_headers")
												})
											]
										})
									]
								})
							]
						}),
						/* @__PURE__ */ u("div", {
							className: panelClass("queue"),
							"data-settings-panel": "queue",
							hidden: settingsActiveTab !== "queue",
							id: "settingsPanelQueue",
							children: [
								/* @__PURE__ */ u("div", {
									className: "settings-group",
									children: [/* @__PURE__ */ u("h3", {
										className: "settings-group-title",
										children: "Processing"
									}), /* @__PURE__ */ u(Field, { children: [
										/* @__PURE__ */ u("div", {
											className: "field-label",
											children: [/* @__PURE__ */ u("label", {
												htmlFor: "rawEventsSweeperIntervalS",
												children: "Background processing interval (seconds)"
											}), /* @__PURE__ */ u("button", {
												"aria-label": "About background processing interval",
												className: "help-icon",
												"data-tooltip": "How often codemem checks for queued events to process in the background.",
												type: "button",
												children: "?"
											})]
										}),
										/* @__PURE__ */ u("input", {
											id: "rawEventsSweeperIntervalS",
											min: "1",
											onInput: onTextInput("rawEventsSweeperIntervalS"),
											type: "number",
											value: values.rawEventsSweeperIntervalS
										}),
										/* @__PURE__ */ u("div", {
											className: "small",
											children: "How often background flush checks pending raw events."
										})
									] })]
								}),
								/* @__PURE__ */ u("div", {
									className: "settings-group",
									children: [
										/* @__PURE__ */ u("h3", {
											className: "settings-group-title",
											children: "Tiered observer routing"
										}),
										/* @__PURE__ */ u("div", {
											className: "field field-checkbox",
											children: [/* @__PURE__ */ u("input", {
												checked: values.observerTierRoutingEnabled,
												className: "cm-checkbox",
												id: "observerTierRoutingEnabled",
												onChange: onCheckboxInput("observerTierRoutingEnabled"),
												type: "checkbox"
											}), /* @__PURE__ */ u("label", {
												htmlFor: "observerTierRoutingEnabled",
												children: "Enable tiered routing"
											})]
										}),
										/* @__PURE__ */ u("div", {
											className: "small",
											children: getTieredRoutingHelperText()
										}),
										/* @__PURE__ */ u(Field, {
											hidden: !showTieredRouting,
											children: [
												/* @__PURE__ */ u("div", {
													className: "field-label",
													children: [/* @__PURE__ */ u("label", {
														htmlFor: "observerSimpleModel",
														children: "Simple tier model"
													}), /* @__PURE__ */ u("button", {
														"aria-label": "About simple tier model",
														className: "help-icon",
														"data-tooltip": "Used for lighter replay batches. Leave blank to keep codemem's routing defaults or base observer fallback.",
														type: "button",
														children: "?"
													})]
												}),
												/* @__PURE__ */ u("input", {
													id: "observerSimpleModel",
													onInput: onTextInput("observerSimpleModel"),
													placeholder: "leave empty for default",
													value: values.observerSimpleModel
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													children: "Used when a batch falls below rich-routing thresholds."
												})
											]
										}),
										/* @__PURE__ */ u(Field, {
											hidden: !showTieredRouting,
											children: [
												/* @__PURE__ */ u("div", {
													className: "field-label",
													children: [/* @__PURE__ */ u("label", {
														htmlFor: "observerRichModel",
														children: "Rich tier model"
													}), /* @__PURE__ */ u("button", {
														"aria-label": "About rich tier model",
														className: "help-icon",
														"data-tooltip": "Used for larger or more complex replay batches. Leave blank to keep codemem's rich-tier defaults.",
														type: "button",
														children: "?"
													})]
												}),
												/* @__PURE__ */ u("input", {
													id: "observerRichModel",
													onInput: onTextInput("observerRichModel"),
													placeholder: "leave empty for default",
													value: values.observerRichModel
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													children: "Used when routing detects a richer replay batch."
												})
											]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field field-checkbox",
											hidden: !showTieredRouting,
											children: [/* @__PURE__ */ u("input", {
												checked: values.observerRichOpenAIUseResponses,
												className: "cm-checkbox",
												id: "observerRichOpenAIUseResponses",
												onChange: onCheckboxInput("observerRichOpenAIUseResponses"),
												type: "checkbox"
											}), /* @__PURE__ */ u("label", {
												htmlFor: "observerRichOpenAIUseResponses",
												children: "Use OpenAI Responses API for rich tier"
											})]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: !showTieredRouting || hiddenUnlessAdvanced(),
											children: [/* @__PURE__ */ u("label", {
												htmlFor: "observerSimpleTemperature",
												children: "Simple tier temperature"
											}), /* @__PURE__ */ u("input", {
												id: "observerSimpleTemperature",
												min: "0",
												onInput: onTextInput("observerSimpleTemperature"),
												step: "0.1",
												type: "number",
												value: values.observerSimpleTemperature
											})]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: !showTieredRouting || hiddenUnlessAdvanced(),
											children: [/* @__PURE__ */ u("label", {
												htmlFor: "observerRichTemperature",
												children: "Rich tier temperature"
											}), /* @__PURE__ */ u("input", {
												id: "observerRichTemperature",
												min: "0",
												onInput: onTextInput("observerRichTemperature"),
												step: "0.1",
												type: "number",
												value: values.observerRichTemperature
											})]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: !showTieredRouting || hiddenUnlessAdvanced(),
											children: [/* @__PURE__ */ u("label", {
												htmlFor: "observerRichReasoningEffort",
												children: "Rich tier reasoning effort"
											}), /* @__PURE__ */ u("input", {
												id: "observerRichReasoningEffort",
												onInput: onTextInput("observerRichReasoningEffort"),
												placeholder: "leave empty for default",
												value: values.observerRichReasoningEffort
											})]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: !showTieredRouting || hiddenUnlessAdvanced(),
											children: [/* @__PURE__ */ u("label", {
												htmlFor: "observerRichReasoningSummary",
												children: "Rich tier reasoning summary"
											}), /* @__PURE__ */ u("input", {
												id: "observerRichReasoningSummary",
												onInput: onTextInput("observerRichReasoningSummary"),
												placeholder: "leave empty for default",
												value: values.observerRichReasoningSummary
											})]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: !showTieredRouting || hiddenUnlessAdvanced(),
											children: [/* @__PURE__ */ u("label", {
												htmlFor: "observerRichMaxOutputTokens",
												children: "Rich tier max output tokens"
											}), /* @__PURE__ */ u("input", {
												id: "observerRichMaxOutputTokens",
												min: "1",
												onInput: onTextInput("observerRichMaxOutputTokens"),
												step: "1",
												type: "number",
												value: values.observerRichMaxOutputTokens
											})]
										})
									]
								}),
								/* @__PURE__ */ u("div", {
									className: "settings-group settings-advanced",
									hidden: hiddenUnlessAdvanced(),
									children: [
										/* @__PURE__ */ u("h3", {
											className: "settings-group-title",
											children: "Context Pack Limits"
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: hiddenUnlessAdvanced(),
											children: [
												/* @__PURE__ */ u("label", {
													htmlFor: "packObservationLimit",
													children: "Observation limit"
												}),
												/* @__PURE__ */ u("input", {
													id: "packObservationLimit",
													min: "1",
													onInput: onTextInput("packObservationLimit"),
													type: "number",
													value: values.packObservationLimit
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													children: "Default number of observations to include in a pack."
												})
											]
										}),
										/* @__PURE__ */ u(Field, {
											className: "field settings-advanced",
											hidden: hiddenUnlessAdvanced(),
											children: [
												/* @__PURE__ */ u("label", {
													htmlFor: "packSessionLimit",
													children: "Session summary limit"
												}),
												/* @__PURE__ */ u("input", {
													id: "packSessionLimit",
													min: "1",
													onInput: onTextInput("packSessionLimit"),
													type: "number",
													value: values.packSessionLimit
												}),
												/* @__PURE__ */ u("div", {
													className: "small",
													children: "Default number of session summaries to include in a pack."
												})
											]
										})
									]
								})
							]
						}),
						/* @__PURE__ */ u("div", {
							className: panelClass("sync"),
							"data-settings-panel": "sync",
							hidden: settingsActiveTab !== "sync",
							id: "settingsPanelSync",
							children: /* @__PURE__ */ u("div", {
								className: "settings-group",
								children: [
									/* @__PURE__ */ u("h3", {
										className: "settings-group-title",
										children: "Device Sync"
									}),
									/* @__PURE__ */ u("div", {
										className: "field field-checkbox",
										children: [/* @__PURE__ */ u("input", {
											checked: values.syncEnabled,
											className: "cm-checkbox",
											id: "syncEnabled",
											onChange: onCheckboxInput("syncEnabled"),
											type: "checkbox"
										}), /* @__PURE__ */ u("label", {
											htmlFor: "syncEnabled",
											children: "Enable sync"
										})]
									}),
									/* @__PURE__ */ u("div", {
										className: "field",
										children: [/* @__PURE__ */ u("label", {
											htmlFor: "syncInterval",
											children: "Sync interval (seconds)"
										}), /* @__PURE__ */ u("input", {
											id: "syncInterval",
											min: "10",
											onInput: onTextInput("syncInterval"),
											type: "number",
											value: values.syncInterval
										})]
									}),
									/* @__PURE__ */ u("div", {
										className: "field settings-advanced",
										hidden: hiddenUnlessAdvanced(),
										children: [/* @__PURE__ */ u("label", {
											htmlFor: "syncHost",
											children: "Sync host"
										}), /* @__PURE__ */ u("input", {
											id: "syncHost",
											onInput: onTextInput("syncHost"),
											placeholder: "127.0.0.1",
											value: values.syncHost
										})]
									}),
									/* @__PURE__ */ u("div", {
										className: "field settings-advanced",
										hidden: hiddenUnlessAdvanced(),
										children: [/* @__PURE__ */ u("label", {
											htmlFor: "syncPort",
											children: "Sync port"
										}), /* @__PURE__ */ u("input", {
											id: "syncPort",
											min: "1",
											onInput: onTextInput("syncPort"),
											type: "number",
											value: values.syncPort
										})]
									}),
									/* @__PURE__ */ u("div", {
										className: "field field-checkbox settings-advanced",
										hidden: hiddenUnlessAdvanced(),
										children: [/* @__PURE__ */ u("input", {
											checked: values.syncMdns,
											className: "cm-checkbox",
											id: "syncMdns",
											onChange: onCheckboxInput("syncMdns"),
											type: "checkbox"
										}), /* @__PURE__ */ u("label", {
											htmlFor: "syncMdns",
											children: "Enable mDNS discovery"
										})]
									}),
									/* @__PURE__ */ u("div", {
										className: "field",
										children: [
											/* @__PURE__ */ u("label", {
												htmlFor: "syncCoordinatorUrl",
												children: "Coordinator URL"
											}),
											/* @__PURE__ */ u("input", {
												disabled: true,
												id: "syncCoordinatorUrl",
												placeholder: "https://coord.example.com",
												value: values.syncCoordinatorUrl
											}),
											/* @__PURE__ */ u("div", {
												className: "small",
												children: protectedConfigHelp("sync_coordinator_url")
											})
										]
									}),
									/* @__PURE__ */ u("div", {
										className: "field",
										children: [
											/* @__PURE__ */ u("label", {
												htmlFor: "syncCoordinatorGroup",
												children: "Coordinator group"
											}),
											/* @__PURE__ */ u("input", {
												id: "syncCoordinatorGroup",
												onInput: onTextInput("syncCoordinatorGroup"),
												placeholder: "nerdworld",
												value: values.syncCoordinatorGroup
											}),
											/* @__PURE__ */ u("div", {
												className: "small",
												children: "Discovery namespace for peers using the same coordinator."
											})
										]
									}),
									/* @__PURE__ */ u("div", {
										className: "field settings-advanced",
										hidden: hiddenUnlessAdvanced(),
										children: [/* @__PURE__ */ u("label", {
											htmlFor: "syncCoordinatorTimeout",
											children: "Coordinator timeout (seconds)"
										}), /* @__PURE__ */ u("input", {
											id: "syncCoordinatorTimeout",
											min: "1",
											onInput: onTextInput("syncCoordinatorTimeout"),
											type: "number",
											value: values.syncCoordinatorTimeout
										})]
									}),
									/* @__PURE__ */ u("div", {
										className: "field settings-advanced",
										hidden: hiddenUnlessAdvanced(),
										children: [/* @__PURE__ */ u("label", {
											htmlFor: "syncCoordinatorPresenceTtl",
											children: "Presence TTL (seconds)"
										}), /* @__PURE__ */ u("input", {
											id: "syncCoordinatorPresenceTtl",
											min: "1",
											onInput: onTextInput("syncCoordinatorPresenceTtl"),
											type: "number",
											value: values.syncCoordinatorPresenceTtl
										})]
									})
								]
							})
						}),
						/* @__PURE__ */ u("div", {
							className: "small mono",
							id: "settingsPath",
							children: settingsRenderState.pathText
						}),
						/* @__PURE__ */ u("div", {
							className: "small",
							id: "settingsEffective",
							children: settingsRenderState.effectiveText
						}),
						/* @__PURE__ */ u("div", {
							className: "settings-note",
							hidden: !settingsRenderState.overridesVisible,
							id: "settingsOverrides",
							children: "Some values are controlled outside this screen and take priority."
						})
					]
				}),
				/* @__PURE__ */ u("div", {
					className: "modal-footer",
					children: [/* @__PURE__ */ u("div", {
						className: "small",
						id: "settingsStatus",
						children: settingsRenderState.statusText
					}), /* @__PURE__ */ u("button", {
						className: "settings-save",
						disabled: !state.settingsDirty || settingsRenderState.isSaving,
						id: "settingsSave",
						onClick: () => {
							if (settingsStartPolling && settingsRefresh) saveSettings(settingsStartPolling, settingsRefresh);
						},
						type: "button",
						children: "Save"
					})]
				})
			]
		});
	}
	function initSettings(stopPolling, startPolling, refreshCallback) {
		settingsStartPolling = startPolling;
		settingsRefresh = refreshCallback;
		ensureSettingsShell();
		$button("settingsButton")?.addEventListener("click", () => openSettings(stopPolling));
	}
	//#endregion
	//#region src/app.ts
	function setRuntimeLabel(version, commit) {
		const el = $$2("runtimeLabel");
		if (!el) return;
		el.textContent = commit ? `v${version} (${commit})` : `v${version}`;
		el.title = commit ? `codemem ${version} (${commit})` : `codemem ${version}`;
		el.hidden = false;
	}
	async function loadRuntimeLabel() {
		try {
			const runtime = await loadRuntimeInfo();
			if (!runtime?.version) return;
			setRuntimeLabel(runtime.version, "878e5a1");
		} catch {}
	}
	var lastAnnouncedRefreshState = null;
	var RECONNECT_POLL_MS = 1500;
	var reconnectTimer = null;
	var reconnecting = false;
	function setReconnectOverlay(open, detail) {
		const overlay = $$2("viewerReconnectOverlay");
		const detailEl = $$2("viewerReconnectDetail");
		if (!overlay || !detailEl) return;
		overlay.hidden = !open;
		detailEl.textContent = detail || "Trying again automatically while the viewer comes back.";
	}
	async function isViewerReady() {
		try {
			await pingViewerReady();
			return true;
		} catch {
			return false;
		}
	}
	function stopReconnectLoop() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		reconnecting = false;
		setReconnectOverlay(false);
	}
	function canResumeRefresh() {
		return document.visibilityState !== "hidden" && !isSettingsOpen();
	}
	function scheduleReconnectLoop() {
		if (reconnecting) return;
		reconnecting = true;
		stopPolling();
		setRefreshStatus("error", "(reconnecting)");
		setReconnectOverlay(true, "The viewer server is restarting or temporarily unavailable. Trying again automatically…");
		const tick = async () => {
			if (await isViewerReady()) {
				stopReconnectLoop();
				if (canResumeRefresh()) {
					setRefreshStatus("refreshing");
					startPolling();
					doRefresh();
				} else setRefreshStatus("paused", document.visibilityState === "hidden" ? "(tab hidden)" : "(settings open)");
				return;
			}
			setReconnectOverlay(true, "Still reconnecting… the viewer will recover automatically as soon as the server responds.");
			reconnectTimer = setTimeout(tick, RECONNECT_POLL_MS);
		};
		reconnectTimer = setTimeout(tick, RECONNECT_POLL_MS);
	}
	function setRefreshStatus(rs, detail) {
		state.refreshState = rs;
		const el = $$2("refreshStatus");
		if (!el) return;
		const announce = (msg) => {
			const announcer = $$2("refreshAnnouncer");
			if (!announcer || lastAnnouncedRefreshState === rs) return;
			announcer.textContent = msg;
			lastAnnouncedRefreshState = rs;
		};
		if (rs === "refreshing") {
			el.textContent = "refreshing…";
			return;
		}
		if (rs === "paused") {
			el.textContent = "paused";
			announce("Auto refresh paused.");
			return;
		}
		if (rs === "error" && detail === "(reconnecting)") {
			el.textContent = "reconnecting…";
			announce("Viewer reconnecting.");
			return;
		}
		if (rs === "error") {
			el.textContent = "refresh failed";
			announce("Refresh failed.");
			return;
		}
		const suffix = detail ? ` ${detail}` : "";
		el.textContent = "updated " + (/* @__PURE__ */ new Date()).toLocaleTimeString() + suffix;
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
		} else if (!isSettingsOpen() && !reconnecting) {
			startPolling();
			refresh();
		}
	});
	var TAB_IDS = [
		"feed",
		"health",
		"sync"
	];
	function switchTab(tab) {
		setActiveTab(tab);
		TAB_IDS.forEach((id) => {
			const panel = $$2(`tab-${id}`);
			if (panel) panel.hidden = id !== tab;
		});
		TAB_IDS.forEach((id) => {
			const btn = $$2(`tabBtn-${id}`);
			if (btn) btn.classList.toggle("active", id === tab);
		});
		refresh();
	}
	function initTabs() {
		TAB_IDS.forEach((id) => {
			$$2(`tabBtn-${id}`)?.addEventListener("click", () => switchTab(id));
		});
		window.addEventListener("hashchange", () => {
			const hash = window.location.hash.replace("#", "");
			if (TAB_IDS.includes(hash) && hash !== state.activeTab) switchTab(hash);
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
		} catch {}
	}
	$select("projectFilter")?.addEventListener("change", () => {
		state.currentProject = $select("projectFilter")?.value || "";
		updateFeedView(true);
		refresh();
	});
	var refreshDebounceTimer = null;
	async function refresh() {
		if (reconnecting) return;
		if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
		refreshDebounceTimer = setTimeout(() => doRefresh(), 80);
	}
	async function doRefresh() {
		if (reconnecting) return;
		if (state.refreshInFlight) {
			state.refreshQueued = true;
			return;
		}
		state.refreshInFlight = true;
		try {
			setRefreshStatus("refreshing");
			const promises = [loadHealthData(), loadConfigData()];
			if (state.activeTab === "feed") promises.push(loadFeedData());
			if (state.activeTab === "sync" || state.activeTab === "health") promises.push(loadSyncData());
			if (state.syncPairingOpen) promises.push(loadPairingData());
			await Promise.all(promises);
			setRefreshStatus("idle");
		} catch {
			if (!await isViewerReady()) scheduleReconnectLoop();
			else setRefreshStatus("error");
		} finally {
			state.refreshInFlight = false;
			if (state.refreshQueued && !reconnecting) {
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
	$$2("viewerReconnectRetry")?.addEventListener("click", async () => {
		setReconnectOverlay(true, "Checking whether the viewer server is back…");
		if (!await isViewerReady()) {
			scheduleReconnectLoop();
			return;
		}
		stopReconnectLoop();
		startPolling();
		doRefresh();
	});
	loadRuntimeLabel();
	refresh();
	startPolling();
	//#endregion
})();
