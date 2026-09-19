/* Sync status renderer — reads state.lastSyncStatus, derives the
 * diagnostics grid entries (state, pending events, last sync, last
 * ping, retention), meta line, and the action list shown under the
 * grid. Covers the disabled / no-peers / stopped / offline-peers /
 * error / rebootstrapping / needs_attention branches. */

import { formatAgeShort, secondsSince, titleCase } from "../../../../lib/format";
import { state } from "../../../../lib/state";
import {
	renderDiagnosticsGrid,
	renderSyncEmptyState,
	type SyncStatItem,
} from "../../components/sync-diagnostics";
import { hideSkeleton, renderActionList } from "../../helpers";
import { diagnosticsLoadingState, newestPeerPing } from "../helpers";
import type { SyncCleanupDiagnostics, SyncStatusState } from "../types";

function numeric(value: unknown): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function cleanupDiagnosticLabel(cleanup: SyncCleanupDiagnostics | undefined): string {
	const state = String(cleanup?.state ?? "clear");
	const stale = cleanup?.stale_peer_rows ?? {};
	const ops = cleanup?.access_cleanup_ops ?? {};
	const wouldRemove = numeric(stale.would_remove);
	const ambiguous = numeric(stale.ambiguous);
	const applied = numeric(ops.applied);
	const sourceAuthored = numeric(ops.source_authored);
	if (state === "cleanup_pending" || wouldRemove > 0) return `${wouldRemove} pending removal`;
	if (state === "needs_review" || ambiguous > 0) return `${ambiguous} needs review`;
	if (state === "cleanup_applied" || applied > 0) return `${applied} applied`;
	if (state === "cleanup_announced" || sourceAuthored > 0) return `${sourceAuthored} announced`;
	return "Clear";
}

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
	const cleanup = status.cleanup_diagnostics;
	const cleanupStale = cleanup?.stale_peer_rows ?? {};
	const cleanupWouldRemove = numeric(cleanupStale.would_remove);
	const cleanupAmbiguous = numeric(cleanupStale.ambiguous);
	const retentionEnabled = retention.enabled === true;
	const retentionDeleted = Number(retention.last_deleted_ops || 0);
	const retentionLastRunAt = retention.last_run_at || null;
	const retentionLastError = String(retention.last_error || "");
	const daemonStateLabels: Record<string, string> = {
		needs_attention: "Needs attention",
		"offline-peers": "Offline peers",
		rebootstrapping: "Rebootstrapping",
	};
	const daemonStateLabel = daemonStateLabels[daemonState] ?? titleCase(daemonState);
	const syncDisabled = daemonState === "disabled" || status.enabled === false;
	const peerCount = Object.keys(peers).length;
	const syncNoPeers = !syncDisabled && peerCount === 0;
	if (syncMeta) {
		let parts: string[];
		if (syncDisabled) {
			parts = [
				"Advanced sync is off on this device",
				"Turn on sync in Settings → Device Sync when you want pairing payloads, peer status, and recent attempt details here",
			];
		} else if (syncNoPeers) {
			parts = [
				"Advanced sync is ready but idle",
				"Pair another device from Devices, then return here for live peer status and recent attempts",
			];
		} else {
			parts = [
				`Advanced state: ${daemonStateLabel}`,
				`Peers: ${peerCount}`,
				lastSync ? `Last sync: ${formatAgeShort(secondsSince(lastSync))} ago` : "Last sync: never",
			];
		}
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
		if (cleanupWouldRemove > 0) {
			parts.push(`${cleanupWouldRemove.toLocaleString()} stale peer rows pending cleanup`);
		} else if (cleanupAmbiguous > 0) {
			parts.push(
				`${cleanupAmbiguous.toLocaleString()} stale peer rows retained because safe cleanup could not be proven`,
			);
		}

		syncMeta.textContent = parts.join(" · ");
	}

	let items: SyncStatItem[];
	if (syncDisabled) {
		items = [
			{ label: "State", value: "Disabled" },
			{ label: "Mode", value: "Optional" },
			{ label: "Pending events", value: pending },
			{ label: "Last sync", value: "Not running" },
		];
	} else if (syncNoPeers) {
		items = [
			{ label: "State", value: "No peers" },
			{ label: "Mode", value: "Ready to pair" },
			{ label: "Pending events", value: pending },
			{ label: "Last sync", value: "Waiting for first peer" },
		];
	} else {
		let retentionValue = "Disabled";
		if (retentionEnabled) {
			retentionValue = retentionLastRunAt
				? `${retentionDeleted.toLocaleString()} ops last run (approx)`
				: "Enabled";
		}
		items = [
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
			{ label: "Retention", value: retentionValue },
		];
	}

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

	if (!syncDisabled && !syncNoPeers && cleanup) {
		items.push({ label: "Cleanup", value: cleanupDiagnosticLabel(cleanup) });
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
	if (!syncDisabled && cleanupAmbiguous > 0) {
		actions.push({
			label: "Some stale peer rows were retained because cleanup was ambiguous.",
			command: "codemem sync doctor",
		});
	} else if (!syncDisabled && cleanupWouldRemove > 0) {
		actions.push({
			label: "Stale peer rows are eligible for cleanup. Run one sync pass now.",
			command: "codemem sync once",
		});
	}
	renderActionList(syncActions, actions);
}
