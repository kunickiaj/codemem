/* Diagnostics card — sync status grid, attempts log, pairing. */

import { h } from "preact";
import { RadixSwitch } from "../../components/primitives/radix-switch";
import { copyToClipboard } from "../../lib/dom";
import { formatTimestamp } from "../../lib/format";
import {
	isSyncRedactionEnabled,
	setSyncPairingOpen,
	setSyncRedactionEnabled,
	state,
} from "../../lib/state";
import { renderIntoSyncMount } from "./components/render-root";
import {
	renderAttemptsList,
	renderPairingView,
	renderSyncEmptyState,
	type SyncAttemptItem,
} from "./components/sync-diagnostics";
import { renderPairingDisclosure } from "./components/sync-disclosure";
import {
	diagnosticsUnavailableState,
	noAttemptsState,
	pairingView,
	syncAttemptsHistoryNote,
	unavailableAttemptsState,
} from "./diagnostics/helpers";
import { renderSyncStatus } from "./diagnostics/render/sync-status";
import {
	SYNC_REDACT_LABEL_ID,
	SYNC_REDACT_MOUNT_ID,
	type SyncAttemptState,
} from "./diagnostics/types";
import { renderActionList } from "./helpers";

export { renderSyncStatus, syncAttemptsHistoryNote };

/* ── Import render functions needed for redact toggle ────── */
// These are set by the index module to avoid circular imports.
let _renderSyncPeers: () => void = () => {};
export function setRenderSyncPeers(fn: () => void) {
	_renderSyncPeers = fn;
}

let _refreshPairing: () => void = () => {};

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
