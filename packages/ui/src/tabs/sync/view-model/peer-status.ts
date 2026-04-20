/* Peer status derivations — translate raw peer records (status,
 * last_error, has_error) into the UI status chip (connected /
 * needs-repair / offline / waiting) and the longer trust-summary
 * blurb (two-way trust / needs re-pairing / needs review, etc.). */

import {
	cleanText,
	isConnectivityPeerError,
	isUnauthorizedPeerError,
	peerErrorText,
} from "./internal";
import type { PeerDirection, PeerLike, UiPeerTrustSummary, UiSyncStatus } from "./types";

// Classify a peer's recent sync direction from observed traffic:
// ↕ bidirectional when both directions have flowed in the recent window,
// ↑ publishing when we have only sent, ↓ subscribed when we have only
// received, and "none" when no qualifying attempts landed. Source data is
// the /api/sync/peers recent_ops aggregate (24-hour successful window).
export function derivePeerDirection(peer: PeerLike): PeerDirection {
	const inCount = Math.max(0, Number(peer?.recent_ops?.in ?? 0));
	const outCount = Math.max(0, Number(peer?.recent_ops?.out ?? 0));
	if (inCount > 0 && outCount > 0) return "bidirectional";
	if (outCount > 0) return "publishing";
	if (inCount > 0) return "subscribed";
	return "none";
}

export function derivePeerUiStatus(peer: PeerLike): UiSyncStatus {
	const peerState = cleanText(peer?.status?.peer_state);
	if (peerState === "offline" || peerState === "stale") return "offline";
	const lastError = peerErrorText(peer);
	if (isUnauthorizedPeerError(lastError)) return "needs-repair";
	if (isConnectivityPeerError(lastError)) return "offline";
	if (peer?.has_error || peerState === "degraded") return "needs-repair";
	if (peerState === "online") return "connected";
	if (peer?.status?.fresh) return "connected";
	return "waiting";
}

export function derivePeerTrustSummary(peer: PeerLike): UiPeerTrustSummary {
	const peerStatus = peer?.status || {};
	const peerState = cleanText(peerStatus.peer_state);
	const lastError = peerErrorText(peer);
	const syncOk =
		cleanText(peerStatus.sync_status) === "ok" || cleanText(peerStatus.ping_status) === "ok";
	if (peerState === "offline" || peerState === "stale") {
		return {
			state: "offline",
			badgeLabel: "Offline",
			description: "This device was paired before, but it is offline right now.",
			isWarning: true,
		};
	}
	if (isUnauthorizedPeerError(lastError)) {
		return {
			state: "needs-repairing",
			badgeLabel: "Needs re-pairing",
			description:
				"This device no longer accepts this one. Pair again from the other device, or remove this local record if it no longer belongs here.",
			isWarning: true,
		};
	}
	if (isConnectivityPeerError(lastError)) {
		return {
			state: "offline",
			badgeLabel: "Offline",
			description:
				"This device is saved here, but none of its last known addresses are responding right now.",
			isWarning: true,
		};
	}
	if (syncOk || peerState === "online") {
		return {
			state: "mutual-trust",
			badgeLabel: "Two-way trust",
			description: "Both devices trust each other and sync can run in both directions.",
			isWarning: false,
		};
	}
	if (peer?.has_error || peerState === "degraded") {
		return {
			state: "needs-review",
			badgeLabel: "Needs review",
			description:
				"This device has a sync problem that needs review before you trust the current state again.",
			isWarning: true,
		};
	}
	return {
		state: "trusted-by-you",
		badgeLabel: "Waiting on other device",
		description:
			"This device is already trusted here. Finish setup on the other device before sync can run both ways.",
		isWarning: false,
	};
}
