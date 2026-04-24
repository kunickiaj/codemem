/* Pure-ish helpers for the diagnostics tab — empty-state copy and the
 * pairing-payload → copyable-command translation. pairingView stashes
 * the raw command on state.pairingCommandRaw so the Copy button can
 * reach it later without re-parsing the payload. */

import { state } from "../../../lib/state";
import type { PairingView } from "../components/sync-diagnostics";
import type { PairingPayloadState } from "./types";

export function newestPeerPing(peers: Record<string, unknown> | null | undefined): string | null {
	const timestamps = Object.values(peers || {})
		.map((peer) => {
			if (!peer || typeof peer !== "object") return "";
			return String((peer as { last_ping_at?: string | null }).last_ping_at || "").trim();
		})
		.filter(Boolean)
		.sort();
	return timestamps[timestamps.length - 1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function noPairingCommand(payloadText: string, hintText: string): PairingView {
	state.pairingCommandRaw = "";
	return { payloadText, hintText };
}

export function pairingView(payload: unknown): PairingView {
	if (!isRecord(payload)) {
		return noPairingCommand("Pairing not available", "Enable sync and retry.");
	}

	const pairingPayload = payload as PairingPayloadState;
	// Invariant: the pairing command is only constructed when the server
	// returned a non-redacted payload. When sync redaction is on (the
	// default) /api/sync/pairing strips device_id/fingerprint/public_key/
	// addresses and returns { redacted: true }; turning that into a
	// base64 command produces one the CLI accept path rejects. Surface
	// the redaction state so the user can disable it and retry.
	if (pairingPayload.redacted) {
		return noPairingCommand(
			"Pairing command hidden while sync redaction is on.",
			"Turn off sync redaction in Settings → Device Sync to reveal the copyable pairing command for this device.",
		);
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

export function diagnosticsLoadingState() {
	return {
		title: "Diagnostics still loading.",
		detail:
			"Wait a moment for local sync status. If it stays blank, refresh the page or check whether sync is enabled on this device.",
	};
}

export function diagnosticsUnavailableState() {
	return {
		title: "Diagnostics unavailable right now.",
		detail:
			"The viewer could not load sync status. Refresh this page, or check that the local codemem sync service is reachable before retrying.",
	};
}

export function noAttemptsState() {
	const syncStatus = state.lastSyncStatus as { daemon_state?: string; enabled?: boolean } | null;
	const syncDisabled = syncStatus?.daemon_state === "disabled" || syncStatus?.enabled === false;
	return {
		title: "No recent sync attempts yet.",
		detail: syncDisabled
			? "Turn on sync in Settings → Device Sync first. Recent attempts will appear here after this device can actually run sync work."
			: "Trigger a sync pass or pair another device to generate activity here when you need low-level troubleshooting.",
	};
}

export function unavailableAttemptsState() {
	return {
		title: "Recent attempts unavailable right now.",
		detail:
			"Attempt history could not be loaded because sync diagnostics failed. Refresh the page after local sync status is reachable again.",
	};
}

export function syncAttemptsHistoryNote(daemonState: string, hasVisibleErrors: boolean): string {
	return daemonState === "offline-peers" && hasVisibleErrors
		? "Some recent failures may have happened before all peers went offline. Sync will resume automatically when a peer becomes reachable."
		: "";
}
