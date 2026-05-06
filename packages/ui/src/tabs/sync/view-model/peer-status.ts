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
import type {
	PeerAuthorizedScopeLike,
	PeerDirection,
	PeerLike,
	PeerProjectScopeLike,
	PeerScopeRejectionReason,
	UiPeerTrustSummary,
	UiSyncStatus,
} from "./types";

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

const SCOPE_REJECTION_REASON_LABELS: Record<PeerScopeRejectionReason, string> = {
	missing_scope: "Missing scope id",
	sender_not_member: "Sender not a scope member",
	receiver_not_member: "Receiver not a scope member",
	stale_epoch: "Stale or revoked membership",
	scope_mismatch: "Scope mismatch",
	visibility_filter: "Visibility filter",
	project_filter: "Project filter",
};

export interface PeerScopeRejectionsView {
	total: number;
	badgeLabel: string | null;
	reasons: Array<{ reason: PeerScopeRejectionReason; label: string; count: number }>;
	lastAt: string | null;
}

/**
 * Translate the per-peer scope-rejection summary returned by /api/sync/peers
 * into a UI-ready view. Returns total=0 when nothing has been rejected, in
 * which case the row should not display a rejection badge or detail block.
 */
export function derivePeerScopeRejectionsView(peer: PeerLike): PeerScopeRejectionsView {
	const summary = peer?.scope_rejections;
	const total = Math.max(0, Number(summary?.total ?? 0));
	if (!summary || total === 0) {
		return { total: 0, badgeLabel: null, reasons: [], lastAt: null };
	}
	const reasons: Array<{ reason: PeerScopeRejectionReason; label: string; count: number }> = [];
	for (const [reason, count] of Object.entries(summary.by_reason ?? {})) {
		const numeric = Math.max(0, Number(count ?? 0));
		if (numeric === 0) continue;
		const key = reason as PeerScopeRejectionReason;
		reasons.push({
			reason: key,
			label: SCOPE_REJECTION_REASON_LABELS[key] ?? reason,
			count: numeric,
		});
	}
	reasons.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
	const badgeLabel = total === 1 ? "1 sync rejection" : `${total.toLocaleString()} sync rejections`;
	return {
		total,
		badgeLabel,
		reasons,
		lastAt: summary.last_at ?? null,
	};
}

function cleanList(values: unknown): string[] {
	return Array.isArray(values)
		? values.map((item) => cleanText(item)).filter((item): item is string => Boolean(item))
		: [];
}

function shortList(values: string[], emptyLabel: string): string {
	if (values.length === 0) return emptyLabel;
	const visible = values.slice(0, 3).join(", ");
	const remaining = values.length - 3;
	return remaining > 0 ? `${visible} +${remaining.toLocaleString()} more` : visible;
}

function labelPart(value: string | null, fallback: string): string {
	return value ? value.replaceAll("_", " ") : fallback;
}

export interface PeerAuthorizedDomainViewItem {
	scopeId: string;
	label: string;
	detail: string;
}

export interface PeerAuthorizedDomainsView {
	total: number;
	badgeLabel: string;
	isWarning: boolean;
	domains: PeerAuthorizedDomainViewItem[];
	emptyMessage: string;
}

export function derivePeerAuthorizedDomainsView(peer: PeerLike): PeerAuthorizedDomainsView {
	const domains = (Array.isArray(peer.authorized_scopes) ? peer.authorized_scopes : [])
		.map((scope: PeerAuthorizedScopeLike): PeerAuthorizedDomainViewItem | null => {
			const scopeId = cleanText(scope.scope_id);
			const label = cleanText(scope.label) ?? scopeId;
			if (!scopeId && !label) return null;
			const detail = [
				labelPart(cleanText(scope.kind), "user"),
				labelPart(cleanText(scope.authority_type), "local"),
				`${labelPart(cleanText(scope.role), "member")} role`,
			]
				.filter(Boolean)
				.join(" · ");
			return { scopeId: scopeId || label, label: label || scopeId, detail };
		})
		.filter((item): item is PeerAuthorizedDomainViewItem => item != null);
	const total = domains.length;
	return {
		total,
		badgeLabel:
			total === 1
				? "1 Sharing domain"
				: total > 1
					? `${total} Sharing domains`
					: "No Sharing domains",
		isWarning: total === 0,
		domains,
		emptyMessage:
			"No authorized Sharing domains are cached for this device. Project filters below cannot send data by themselves.",
	};
}

export interface PeerProjectNarrowingView {
	summary: string;
	note: string;
	sourceLabel: string;
	includeLabel: string;
	excludeLabel: string;
}

export function derivePeerProjectNarrowingView(
	scope: PeerProjectScopeLike | null | undefined,
): PeerProjectNarrowingView {
	const effectiveInclude = cleanList(scope?.effective_include);
	const effectiveExclude = cleanList(scope?.effective_exclude);
	const sourceLabel = scope?.inherits_global ? "Global defaults" : "Device override";
	const includeLabel = `Include filter: ${shortList(effectiveInclude, "all projects")}`;
	const excludeLabel = `Exclude filter: ${shortList(effectiveExclude, "no exclusions")}`;
	return {
		sourceLabel,
		includeLabel,
		excludeLabel,
		summary: `${sourceLabel}. ${includeLabel}; ${excludeLabel}.`,
		note: "Project filters only narrow data after Sharing domain authorization; they never grant access to another domain.",
	};
}
