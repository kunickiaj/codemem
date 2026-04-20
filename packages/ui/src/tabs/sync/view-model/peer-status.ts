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
import type { PeerLike, UiPeerTrustSummary, UiSyncStatus } from "./types";

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
