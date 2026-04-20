/* Recent sync attempts renderer — reads state.lastSyncAttempts and
 * produces a 5-row history with peer label, status, detail (ops in/out
 * or error), and formatted timestamp. Also owns the "diagnostics
 * unavailable" fallback for when the whole /api/sync/status call
 * failed. */

import { formatTimestamp } from "../../../../lib/format";
import { isSyncRedactionEnabled, state } from "../../../../lib/state";
import {
	renderAttemptsList,
	renderSyncEmptyState,
	type SyncAttemptItem,
} from "../../components/sync-diagnostics";
import { renderActionList } from "../../helpers";
import {
	diagnosticsUnavailableState,
	noAttemptsState,
	syncAttemptsHistoryNote,
	unavailableAttemptsState,
} from "../helpers";
import type { SyncAttemptState } from "../types";

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
