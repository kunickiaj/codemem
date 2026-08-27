/* Coordinator-admin join requests panel — renders the pending join
 * requests list with per-row approve/deny actions. Pulls the list from
 * `state.lastCoordinatorAdminJoinRequests` and takes the review callback
 * as a dep so the barrel can wire the factory action. */

import { h } from "preact";
import { RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { state } from "../../../lib/state";
import { stableDeviceDisplayNames } from "../data/device-card";
import { surfaceHasSnapshot, surfaceIsNotApplicable } from "../data/recovery";
import { coordinatorAdminState } from "../data/state";
import type { CoordinatorAdminSummary } from "../data/summary";

export interface JoinRequestsPanelDeps {
	summary: CoordinatorAdminSummary;
	fresh: boolean;
	snapshotMatchesTarget: boolean;
	reviewJoinRequest: (requestId: string, action: "approve" | "deny") => void;
}

export function renderJoinRequestsPanel(deps: JoinRequestsPanelDeps) {
	const { summary, fresh, reviewJoinRequest, snapshotMatchesTarget } = deps;
	const known =
		snapshotMatchesTarget && surfaceHasSnapshot(coordinatorAdminState.recovery, "joinRequests");
	const notApplicable = surfaceIsNotApplicable(coordinatorAdminState.recovery, "joinRequests");
	const items =
		known && Array.isArray(state.lastCoordinatorAdminJoinRequests)
			? state.lastCoordinatorAdminJoinRequests
			: [];
	const aliasItems = items.map((item) => ({
		device_id:
			String(item.device_id || "").trim() || `join-request:${String(item.request_id || "").trim()}`,
		display_name: item.display_name,
	}));
	const deviceDisplayNames = stableDeviceDisplayNames(
		aliasItems,
		coordinatorAdminState.unnamedDeviceAliases,
	);
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "join-requests" },
		h("h3", null, "Pending join requests"),
		h(
			"p",
			{ class: "peer-submeta" },
			summary.readiness === "ready"
				? "Approve or deny devices that want to join this legacy coordinator group. Space transport access is handled by legacy group defaults and can be reviewed in Spaces; Sharing policy is separate."
				: "Finish coordinator setup first. Join request review stays disabled until legacy administration is ready.",
		),
		notApplicable
			? h(
					"div",
					{ class: "peer-meta" },
					"Complete legacy coordinator setup to load join requests. No join queue is expected yet.",
				)
			: !known
				? h(
						"div",
						{ class: "peer-meta" },
						"Join requests are unavailable. Retry to load the current queue; no empty result is being assumed.",
					)
				: !items.length
					? h(
							"div",
							{ class: "peer-meta" },
							summary.readiness === "ready"
								? "No pending join requests right now."
								: "Join request review will appear here once setup is complete.",
						)
					: h(
							"div",
							{ class: "peer-list" },
							items.map((item) => {
								const requestId = String(item.request_id || "").trim();
								const deviceId = String(item.device_id || "").trim();
								const aliasKey = deviceId || `join-request:${requestId}`;
								const displayName = deviceDisplayNames.get(aliasKey) || "Unnamed device";
								const fingerprint = String(item.fingerprint || "").trim();
								const advancedDetails = [`Device ID ${deviceId || "unknown"}`];
								if (fingerprint) advancedDetails.push(`Fingerprint ${fingerprint}`);
								const pending = coordinatorAdminState.joinReviewPendingId === requestId;
								return h(
									"div",
									{ class: "peer-card peer-card--padded", key: requestId || deviceId },
									h("div", { class: "peer-title" }, h("strong", null, displayName)),
									h(
										"details",
										{ class: "coordinator-admin-diagnostics" },
										h("summary", null, "Diagnostics"),
										h("div", { class: "peer-meta" }, `Advanced: ${advancedDetails.join(" · ")}`),
									),
									h(
										"div",
										{ class: "peer-actions" },
										h(
											"button",
											{
												class: "settings-button",
												disabled: !fresh || !requestId || pending,
												onClick: () => reviewJoinRequest(requestId, "approve"),
												type: "button",
											},
											pending && coordinatorAdminState.joinReviewPendingAction === "approve"
												? "Approving…"
												: "Approve",
										),
										h(
											"button",
											{
												class: "settings-button danger",
												disabled: !fresh || !requestId || pending,
												onClick: () => reviewJoinRequest(requestId, "deny"),
												type: "button",
											},
											pending && coordinatorAdminState.joinReviewPendingAction === "deny"
												? "Denying…"
												: "Deny",
										),
									),
								);
							}),
						),
	);
}
