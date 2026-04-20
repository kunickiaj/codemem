/* Internal helpers shared across the view-model modules. cleanText
 * and normalizeDisplayName are the text normalizers used for diffing
 * peer/actor names; friendlyDeviceFallback produces a short stable
 * fallback when neither local nor coordinator names are available. The
 * peer-error classifiers centralise the "is this message 401 /
 * connectivity failure" checks used by the trust + UI status
 * derivations. */

import type { PeerLike } from "./types";

export function cleanText(value: unknown): string {
	return String(value ?? "").trim();
}

export function normalizeDisplayName(value: unknown): string {
	return cleanText(value).replace(/\s+/g, " ").toLowerCase();
}

export function friendlyDeviceFallback(deviceId: string): string {
	const cleanId = cleanText(deviceId);
	return cleanId ? cleanId.slice(0, 8) : "Unnamed device";
}

export function peerErrorText(peer: PeerLike): string {
	return cleanText(peer?.last_error).toLowerCase();
}

export function isUnauthorizedPeerError(errorText: string): boolean {
	return errorText.includes("401") && errorText.includes("unauthorized");
}

export function isConnectivityPeerError(errorText: string): boolean {
	return ["timeout", "connection refused", "unreachable", "aborted", "all addresses failed"].some(
		(fragment) => errorText.includes(fragment),
	);
}
