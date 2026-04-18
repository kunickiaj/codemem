/* Diagnostics card — sync status grid, attempts log, pairing. */

import { h } from "preact";
import { RadixSwitch } from "../../components/primitives/radix-switch";
import { copyToClipboard } from "../../lib/dom";
import { formatAgeShort, formatTimestamp, secondsSince, titleCase } from "../../lib/format";
import {
	isSyncRedactionEnabled,
	setSyncPairingOpen,
	setSyncRedactionEnabled,
	state,
} from "../../lib/state";
import { renderIntoSyncMount } from "./components/render-root";
import {
	type PairingView,
	renderAttemptsList,
	renderDiagnosticsGrid,
	renderPairingView,
	renderSyncEmptyState,
	type SyncAttemptItem,
	type SyncStatItem,
} from "./components/sync-diagnostics";
import { renderPairingDisclosure } from "./components/sync-disclosure";
import { hideSkeleton, renderActionList } from "./helpers";

type SyncRetention = {
	enabled?: boolean;
	last_deleted_ops?: number | string;
	last_error?: string;
	last_run_at?: string | null;
};

type SyncPayloadState = {
	seconds_since_last?: number;
};

type PingPayloadState = SyncPayloadState & {
	last_ping_at?: string | null;
};

type SyncStatusState = {
	daemon_detail?: string;
	daemon_state?: string;
	enabled?: boolean;
	last_ping_at?: string | null;
	last_ping_error?: string;
	last_sync_at?: string | null;
	last_sync_at_utc?: string | null;
	last_sync_error?: string;
	pending?: number | string;
	peers?: Record<string, unknown>;
	ping?: PingPayloadState;
	retention?: SyncRetention;
	sync?: SyncPayloadState;
};

type SyncAttemptState = {
	address?: string;
	error?: string;
	finished_at?: string;
	ops_in?: number;
	ops_out?: number;
	peer_device_id?: string;
	started_at?: string;
	started_at_utc?: string;
	status?: string;
};

type PairingPayloadState = Record<string, unknown> & {
	addresses?: unknown[];
	redacted?: boolean;
};

const SYNC_REDACT_MOUNT_ID = "syncRedactMount";
const SYNC_REDACT_LABEL_ID = "syncRedactLabel";

function newestPeerPing(peers: Record<string, unknown> | null | undefined): string | null {
	const timestamps = Object.values(peers || {})
		.map((peer) => {
			if (!peer || typeof peer !== "object") return "";
			return String((peer as { last_ping_at?: string | null }).last_ping_at || "").trim();
		})
		.filter(Boolean)
		.sort();
	return timestamps[timestamps.length - 1] ?? null;
}

/* ── Import render functions needed for redact toggle ────── */
// These are set by the index module to avoid circular imports.
let _renderSyncPeers: () => void = () => {};
export function setRenderSyncPeers(fn: () => void) {
	_renderSyncPeers = fn;
}

let _refreshPairing: () => void = () => {};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function pairingView(payload: unknown): PairingView {
	if (!isRecord(payload)) {
		state.pairingCommandRaw = "";
		return {
			payloadText: "Pairing not available",
			hintText: "Enable sync and retry.",
		};
	}

	const pairingPayload = payload as PairingPayloadState;
	if (pairingPayload.redacted) {
		state.pairingCommandRaw = "";
		return {
			payloadText: "Pairing payload hidden",
			hintText: "Diagnostics are required to view the pairing payload.",
		};
	}

	const safePayload = {
		...pairingPayload,
		addresses: Array.isArray(pairingPayload.addresses) ? pairingPayload.addresses : [],
	};
	const compact = JSON.stringify(safePayload);
	const b64 = btoa(compact);
	const command = `echo '${b64}' | base64 -d | codemem sync pair --accept-file -`;
	state.pairingCommandRaw = command;
	return {
		payloadText: command,
		hintText:
			"Copy this command and run it on the other device. Use --include/--exclude to control which projects sync.",
	};
}

function diagnosticsLoadingState() {
	return {
		title: "Diagnostics still loading.",
		detail:
			"Wait a moment for local sync status. If it stays blank, refresh the page or check whether sync is enabled on this device.",
	};
}

function diagnosticsUnavailableState() {
	return {
		title: "Diagnostics unavailable right now.",
		detail:
			"The viewer could not load sync status. Refresh this page, or check that the local codemem sync service is reachable before retrying.",
	};
}

function noAttemptsState() {
	const syncStatus = state.lastSyncStatus as { daemon_state?: string; enabled?: boolean } | null;
	const syncDisabled = syncStatus?.daemon_state === "disabled" || syncStatus?.enabled === false;
	return {
		title: "No recent sync attempts yet.",
		detail: syncDisabled
			? "Turn on sync in Settings → Device Sync first. Recent attempts will appear here after this device can actually run sync work."
			: "Trigger a sync pass or pair another device to generate activity here when you need low-level troubleshooting.",
	};
}

function unavailableAttemptsState() {
	return {
		title: "Recent attempts unavailable right now.",
		detail:
			"Attempt history could not be loaded because sync diagnostics failed. Refresh the page after local sync status is reachable again.",
	};
}

/* ── Sync status renderer ────────────────────────────────── */

export function renderSyncStatus() {
	const syncStatusGrid = document.getElementById("syncStatusGrid");
	const syncMeta = document.getElementById("syncMeta");
	const syncActions = document.getElementById("syncActions");
	if (!syncStatusGrid) return;

	hideSkeleton("syncDiagSkeleton");

	const status = state.lastSyncStatus as SyncStatusState | null;
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
	const daemonStateLabel =
		daemonState === "offline-peers"
			? "Offline peers"
			: daemonState === "needs_attention"
				? "Needs attention"
				: daemonState === "rebootstrapping"
					? "Rebootstrapping"
					: titleCase(daemonState);
	const syncDisabled = daemonState === "disabled" || status.enabled === false;
	const peerCount = Object.keys(peers).length;
	const syncNoPeers = !syncDisabled && peerCount === 0;

	if (syncMeta) {
		const parts = syncDisabled
			? [
					"Advanced sync is off on this device",
					"Turn on sync in Settings → Device Sync when you want pairing payloads, peer status, and recent attempt details here",
				]
			: syncNoPeers
				? [
						"Advanced sync is ready but idle",
						"Use Show pairing to connect another device, then this panel will start showing live peer status and recent attempts",
					]
				: [
						`Advanced state: ${daemonStateLabel}`,
						`Peers: ${peerCount}`,
						lastSync
							? `Last sync: ${formatAgeShort(secondsSince(lastSync))} ago`
							: "Last sync: never",
					];
		if (daemonState === "offline-peers") {
			parts.push("All peers are currently offline; sync will resume automatically");
		}
		if (daemonDetail && daemonState === "stopped") {
			parts.push(`Detail: ${daemonDetail}`);
		}
		if (daemonDetail && (daemonState === "needs_attention" || daemonState === "rebootstrapping")) {
			parts.push(`Detail: ${daemonDetail}`);
		}
		if (retentionEnabled) {
			parts.push(
				retentionLastRunAt
					? `Retention last ran ${formatAgeShort(secondsSince(retentionLastRunAt))} ago (approx oldest-first)`
					: "Retention enabled",
			);
		}

		syncMeta.textContent = parts.join(" · ");
	}

	const items: SyncStatItem[] = syncDisabled
		? [
				{ label: "State", value: "Disabled" },
				{ label: "Mode", value: "Optional" },
				{ label: "Pending events", value: pending },
				{ label: "Last sync", value: "Not running" },
			]
		: syncNoPeers
			? [
					{ label: "State", value: "No peers" },
					{ label: "Mode", value: "Ready to pair" },
					{ label: "Pending events", value: pending },
					{ label: "Last sync", value: "Waiting for first peer" },
				]
			: [
					{ label: "State", value: daemonStateLabel },
					{ label: "Pending events", value: pending },
					{
						label: "Last sync",
						value: lastSync ? `${formatAgeShort(secondsSince(lastSync))} ago` : "never",
					},
					{
						label: "Last peer ping",
						value: lastPing ? `${formatAgeShort(secondsSince(lastPing))} ago` : "never",
					},
					{
						label: "Retention",
						value: retentionEnabled
							? retentionLastRunAt
								? `${retentionDeleted.toLocaleString()} ops last run (approx)`
								: "Enabled"
							: "Disabled",
					},
				];

	if (!syncDisabled && !syncNoPeers && (syncError || pingError)) {
		items.push({
			label: [syncError, pingError].filter(Boolean).join(" · "),
			value: "Errors",
		});
	}

	if (!syncDisabled && !syncNoPeers && syncPayload.seconds_since_last) {
		items.push({
			label: "Since last sync",
			value: `${syncPayload.seconds_since_last}s`,
		});
	}

	if (!syncDisabled && !syncNoPeers && pingPayload.seconds_since_last) {
		items.push({
			label: "Since last peer ping",
			value: `${pingPayload.seconds_since_last}s`,
		});
	}

	if (!syncDisabled && retentionEnabled && retentionLastError) {
		items.push({
			label: retentionLastError,
			value: "Retention",
		});
	}

	renderDiagnosticsGrid(syncStatusGrid, items);

	const actions: Array<{ label: string; command: string }> = [];
	if (syncNoPeers) {
		/* no action */
	} else if (daemonState === "offline-peers") {
		/* informational */
	} else if (daemonState === "stopped") {
		actions.push({ label: "Sync daemon is stopped. Start it.", command: "codemem serve start" });
		actions.push({ label: "Run one sync pass now.", command: "codemem sync once" });
	} else if (daemonState === "needs_attention") {
		actions.push({
			label: "Sync needs manual attention before reset can continue.",
			command: "codemem sync doctor",
		});
	} else if (daemonState === "rebootstrapping") {
		actions.push({
			label: "Sync is rebuilding state in the background.",
			command: "codemem sync status",
		});
	} else if (syncError || pingError || daemonState === "error") {
		actions.push({
			label: "Sync reports errors. Restart now.",
			command: "codemem serve restart && codemem sync once",
		});
		actions.push({
			label: "Run doctor for the root cause.",
			command: "codemem sync doctor",
		});
	} else if (!syncDisabled && !syncNoPeers && pending > 0) {
		actions.push({
			label: "Pending sync work detected. Run one pass now.",
			command: "codemem sync once",
		});
	}
	renderActionList(syncActions, actions);
}

/* ── Attempts renderer ───────────────────────────────────── */

export function renderSyncAttempts() {
	const syncAttempts = document.getElementById("syncAttempts");
	if (!syncAttempts) return;

	const attempts = state.lastSyncAttempts as SyncAttemptState[];
	const daemonState = String(state.lastSyncStatus?.daemon_state || "").trim();
	if (!Array.isArray(attempts) || !attempts.length) {
		renderSyncEmptyState(syncAttempts, noAttemptsState());
		return;
	}

	const historyOnlyNote = syncAttemptsHistoryNote(
		daemonState,
		attempts.slice(0, 5).some((attempt) => attempt.status === "error"),
	);

	const items: SyncAttemptItem[] = attempts.slice(0, 5).map((attempt) => {
		const time = attempt.started_at || attempt.started_at_utc || "";
		const peerId = String(attempt.peer_device_id || "").trim();
		const matchedPeer = Array.isArray(state.lastSyncPeers)
			? state.lastSyncPeers.find((p) => String(p?.peer_device_id || "") === peerId)
			: null;
		const peerName = String(matchedPeer?.name || "").trim();
		const peerLabel = peerName || (peerId ? peerId.slice(0, 8) : "unknown");

		// Progressive disclosure: show what's relevant for this attempt's outcome
		const isError = attempt.status === "error";
		const detailParts: string[] = [];
		if (isError && attempt.error) {
			detailParts.push(String(attempt.error));
		}
		if (!isError && (attempt.ops_in || attempt.ops_out)) {
			detailParts.push(`${attempt.ops_in ?? 0} in · ${attempt.ops_out ?? 0} out`);
		}
		if (!isSyncRedactionEnabled() && attempt.address) {
			detailParts.push(attempt.address);
		}

		return {
			status: attempt.status || "unknown",
			peerLabel,
			detail: detailParts.join(" · "),
			startedAt: time ? formatTimestamp(time) : "",
		};
	});

	renderAttemptsList(syncAttempts, items, historyOnlyNote);
}

export function syncAttemptsHistoryNote(daemonState: string, hasVisibleErrors: boolean): string {
	return daemonState === "offline-peers" && hasVisibleErrors
		? "Some recent failures may have happened before all peers went offline. Sync will resume automatically when a peer becomes reachable."
		: "";
}

export function renderSyncDiagnosticsUnavailable() {
	const syncStatusGrid = document.getElementById("syncStatusGrid");
	const syncAttempts = document.getElementById("syncAttempts");
	const syncMeta = document.getElementById("syncMeta");
	const syncActions = document.getElementById("syncActions");
	if (syncStatusGrid) renderSyncEmptyState(syncStatusGrid, diagnosticsUnavailableState());
	if (syncAttempts) renderSyncEmptyState(syncAttempts, unavailableAttemptsState());
	if (syncMeta) {
		syncMeta.textContent =
			"Advanced diagnostics are unavailable right now. Refresh the page first. If that still fails, verify the local sync service and retry once it responds again.";
	}
	renderActionList(syncActions, []);
}

/* ── Pairing renderer ────────────────────────────────────── */

function renderPairingCollapsible() {
	const mount = document.getElementById("syncPairingDisclosureMount") as HTMLElement | null;
	const contentHost = document.getElementById("syncPairingPanelMount") as HTMLElement | null;
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
				if (pairingPayloadEl) {
					renderPairingView(pairingPayloadEl, pairingHint, {
						payloadText: "Loading…",
						hintText: "Fetching pairing payload…",
					});
				}
			}
			_refreshPairing();
		},
	});

	const pairingCopy = document.getElementById("pairingCopy") as HTMLButtonElement | null;
	if (pairingCopy) {
		pairingCopy.onclick = async () => {
			const text =
				state.pairingCommandRaw || document.getElementById("pairingPayload")?.textContent || "";
			if (text) await copyToClipboard(text, pairingCopy);
		};
	}
}

export function renderPairing() {
	renderPairingCollapsible();
	const pairingPayloadEl = document.getElementById("pairingPayload");
	const pairingHint = document.getElementById("pairingHint");
	if (!pairingPayloadEl) return;

	renderPairingView(pairingPayloadEl, pairingHint, pairingView(state.pairingPayloadRaw));
}

function renderRedactControl() {
	const mount = document.getElementById(SYNC_REDACT_MOUNT_ID) as HTMLElement | null;
	if (!mount) return;

	renderIntoSyncMount(
		mount,
		h(RadixSwitch, {
			"aria-labelledby": SYNC_REDACT_LABEL_ID,
			checked: isSyncRedactionEnabled(),
			className: "sync-redact-switch",
			id: "syncRedact",
			onCheckedChange: (checked: boolean) => {
				setSyncRedactionEnabled(checked);
				renderRedactControl();
				renderSyncStatus();
				_renderSyncPeers();
				renderSyncAttempts();
				renderPairing();
			},
			thumbClassName: "sync-redact-switch-thumb",
		}),
	);
}

/* ── Event wiring ────────────────────────────────────────── */

export function initDiagnosticsEvents(refreshCallback: () => void) {
	_refreshPairing = refreshCallback;
	renderPairingCollapsible();
	renderRedactControl();
}
