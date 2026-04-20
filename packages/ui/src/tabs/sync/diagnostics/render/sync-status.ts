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
import type { SyncStatusState } from "../types";

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
