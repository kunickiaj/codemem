/* Coordinator-admin join requests panel — renders the pending join
 * requests list with per-row approve/deny actions. Pulls the list from
 * `state.lastCoordinatorAdminJoinRequests` and takes the review callback
 * as a dep so the barrel can wire the factory action. */

import { h } from "preact";
import { RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { state } from "../../../lib/state";
import { coordinatorAdminState } from "../data/state";
import type { CoordinatorAdminSummary } from "../data/summary";

export interface JoinRequestsPanelDeps {
	summary: CoordinatorAdminSummary;
	reviewJoinRequest: (requestId: string, action: "approve" | "deny") => void;
}

export function renderJoinRequestsPanel(deps: JoinRequestsPanelDeps) {
	const { summary, reviewJoinRequest } = deps;
	const items = Array.isArray(state.lastCoordinatorAdminJoinRequests)
		? state.lastCoordinatorAdminJoinRequests
		: [];
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "join-requests" },
		h("h3", null, "Pending join requests"),
		h(
			"p",
			{ class: "peer-submeta" },
			summary.readiness === "ready"
				? "Approve or deny teammate join requests from the dedicated operator surface instead of burying them in Sync."
				: "Finish setup first. Join request review stays disabled until coordinator admin is ready.",
		),
		!items.length
			? h(
					"div",
					{ class: "peer-meta" },
					summary.readiness === "ready"
						? "No pending join requests right now."
						: "Join request review will appear here once setup is complete.",
				)
			: h(
					"div",
					{ class: "coordinator-admin-request-list" },
					items.map((item) => {
						const requestId = String(item.request_id || "").trim();
						const deviceId = String(item.device_id || "unknown-device");
						const displayName = String(item.display_name || deviceId);
						const pending = coordinatorAdminState.joinReviewPendingId === requestId;
						return h(
							"div",
							{ class: "peer-card", key: requestId || deviceId },
							h("div", { class: "peer-title" }, h("strong", null, displayName)),
							h("div", { class: "peer-meta" }, `Device: ${deviceId}`),
							h(
								"div",
								{ class: "peer-actions" },
								h(
									"button",
									{
										disabled: !requestId || pending,
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
										class: "danger",
										disabled: !requestId || pending,
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
