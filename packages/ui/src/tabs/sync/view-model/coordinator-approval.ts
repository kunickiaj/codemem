/* Coordinator-approval derivations — translate the discovered-device
 * flags (needs_local_approval / waiting_for_peer_approval) into the
 * approval state + badge shown on each team-sync discovered row, and
 * decide whether the UI should offer the Review action at all.
 * summarizeSyncRunResult turns a bulk "sync now" response into the
 * single toast message the Sync button displays. */

import { cleanText } from "./internal";
import type {
	DiscoveredDeviceLike,
	UiCoordinatorApprovalSummary,
	UiSyncRunResponse,
	UiSyncSkippedOutDetail,
} from "./types";

const OUTBOUND_FILTER_LABELS: Record<string, string> = {
	scope_filter: "sharing-domain membership",
	visibility_filter: "visibility",
	project_filter: "project filter",
};

export function deriveCoordinatorApprovalSummary(input: {
	device: DiscoveredDeviceLike;
	pairedLocally?: boolean;
}): UiCoordinatorApprovalSummary {
	if (input.device?.needs_local_approval) {
		return {
			state: "needs-your-approval",
			badgeLabel: "Needs your approval",
			description:
				"Another device already approved this pairing. Approve it here to finish the connection on both sides.",
			actionLabel: "Approve on this device",
		};
	}
	if (input.device?.waiting_for_peer_approval) {
		return {
			state: "waiting-for-other-device",
			badgeLabel: "Waiting on other device",
			description:
				"You already approved this pairing here. The other device still needs to approve this one before sync can work both ways.",
			actionLabel: null,
		};
	}
	return {
		state: "none",
		badgeLabel: null,
		description: null,
		actionLabel: null,
	};
}

export function shouldShowCoordinatorReviewAction(input: {
	device: DiscoveredDeviceLike;
	pairedLocally?: boolean;
	hasAmbiguousCoordinatorGroup?: boolean;
}): boolean {
	const approvalSummary = deriveCoordinatorApprovalSummary(input);
	const deviceId = cleanText(input.device?.device_id);
	if (!deviceId) return false;
	if (input.device?.stale || input.hasAmbiguousCoordinatorGroup) return false;
	if (!input.pairedLocally) return true;
	return approvalSummary.state === "needs-your-approval";
}

export function summarizeSyncRunResult(payload: UiSyncRunResponse): {
	ok: boolean;
	message: string;
	warning: boolean;
} {
	const items = Array.isArray(payload?.items) ? payload.items : [];
	if (!items.length) {
		return { ok: true, message: "Sync pass completed with no eligible devices.", warning: false };
	}
	const failedItems = items.filter((item) => item && item.ok === false);
	const skippedItems = items.filter((item) => Math.max(0, Number(item.opsSkipped ?? 0)) > 0);
	if (!failedItems.length) {
		if (skippedItems.length) {
			const skipped = skippedItems.reduce(
				(total, item) => total + Math.max(0, Number(item.opsSkipped ?? 0)),
				0,
			);
			const reasonSummary = skippedReasonSummary(
				skippedItems.map((item) => item.skipped_out ?? null),
			);
			return {
				ok: true,
				message: `${skipped.toLocaleString()} outbound op${skipped === 1 ? " was" : "s were"} filtered: ${reasonSummary}. No payload was sent for filtered data.`,
				warning: true,
			};
		}
		return {
			ok: true,
			message: `Sync pass finished for ${items.length} device${items.length === 1 ? "" : "s"}.`,
			warning: false,
		};
	}
	const unauthorizedFailures = failedItems.filter((item) =>
		isTrustFailureError(cleanText(item.error)),
	);
	if (unauthorizedFailures.length === failedItems.length) {
		return {
			ok: false,
			message:
				"This device no longer has two-way trust with the peer. Pair it again from the other device, or remove the stale local record if it should be gone.",
			warning: true,
		};
	}
	const scopeFailures = failedItems.filter((item) =>
		isScopeMembershipFailureError(cleanText(item.error)),
	);
	if (scopeFailures.length === failedItems.length) {
		return {
			ok: false,
			message:
				"Sync ran, but the peer is not authorized for one or more Spaces. Review Space access for this device in Teams, then sync again.",
			warning: true,
		};
	}
	if (failedItems.length < items.length) {
		return {
			ok: false,
			message: `${failedItems.length} of ${items.length} device sync attempts failed. Open the affected device cards for the specific errors.`,
			warning: true,
		};
	}
	const error = cleanText(failedItems[0]?.error);
	return {
		ok: false,
		message: error || "Sync failed for at least one device.",
		warning: true,
	};
}

/**
 * True when a sync-failure error string looks like a two-way-trust failure
 * (401 unauthorized on the peer's /v1/status), which is the only class of
 * failure that should trigger the "no longer has two-way trust" toast. Any
 * other class — connectivity, scope/membership, generation mismatch — flows
 * through the generic mixed-failure or scoped paths so users do not get
 * pointed at re-pairing for problems that re-pairing will not fix.
 */
function isTrustFailureError(error: string): boolean {
	const lower = error.toLowerCase();
	return lower.includes("401") && lower.includes("unauthorized");
}

/**
 * True when a sync-failure error string indicates the peer is not authorized
 * for a Space (or is authorized at a stale epoch). These failures map to the
 * scoped-sync protocol classes documented in
 * docs/plans/2026-05-25-scoped-sync-protocol.md:
 *
 * - `403: scope_rejected` from POST /v1/ops outbound scope filter.
 * - `409: reset_required` with `reason=missing_scope` or `stale_epoch`
 *   from GET /v1/ops or GET /v1/snapshot.
 * - syncOneScope's aggregate string only when it includes one of those wire
 *   reasons. Other scoped-sync failures remain generic sync failures.
 *
 * Detection is intentionally substring-based because the wire reason can
 * arrive embedded in a longer error string from the address-fallback loop.
 */
function isScopeMembershipFailureError(error: string): boolean {
	const lower = error.toLowerCase();
	if (lower.includes("scope_rejected")) return true;
	if (lower.includes("missing_scope")) return true;
	if (lower.includes("stale_epoch")) return true;
	if (lower.includes("scope_inactive")) return true;
	return false;
}

function outboundFilterLabel(detail: UiSyncSkippedOutDetail | null): string {
	const reason = cleanText(detail?.reason);
	return OUTBOUND_FILTER_LABELS[reason] ?? (reason.replaceAll("_", " ") || "sync filters");
}

function skippedReasonSummary(details: Array<UiSyncSkippedOutDetail | null>): string {
	const counts = new Map<string, number>();
	for (const detail of details) {
		const label = outboundFilterLabel(detail);
		const count = Math.max(0, Number(detail?.skipped_count ?? 0));
		if (count === 0) continue;
		counts.set(label, (counts.get(label) ?? 0) + count);
	}
	if (!counts.size) return "sync filters";
	return Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([label, count]) => `${count.toLocaleString()} by ${label}`)
		.join(", ");
}
