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
} from "./types";

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
	const fingerprint = cleanText(input.device?.fingerprint);
	if (!deviceId || !fingerprint) return false;
	if (Boolean(input.device?.stale) || Boolean(input.hasAmbiguousCoordinatorGroup)) return false;
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
	if (!failedItems.length) {
		return {
			ok: true,
			message: `Sync pass finished for ${items.length} device${items.length === 1 ? "" : "s"}.`,
			warning: false,
		};
	}
	const unauthorizedFailures = failedItems.filter(
		(item) =>
			cleanText(item.error).toLowerCase().includes("401") &&
			cleanText(item.error).toLowerCase().includes("unauthorized"),
	);
	if (unauthorizedFailures.length === failedItems.length) {
		return {
			ok: false,
			message:
				"This device no longer has two-way trust with the peer. Pair it again from the other device, or remove the stale local record if it should be gone.",
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
