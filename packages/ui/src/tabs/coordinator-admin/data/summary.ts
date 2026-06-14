/* Coordinator-admin readiness summary — derives the banner copy from
 * the latest viewer /coordinator-admin/status response. Pure: reads
 * `state.lastCoordinatorAdminStatus` and returns a display-ready shape. */

import { state } from "../../../lib/state";

export type CoordinatorAdminReadiness = "ready" | "partial" | "not_configured";

export interface CoordinatorAdminSummary {
	readiness: CoordinatorAdminReadiness;
	title: string;
	detail: string;
}

export function coordinatorAdminSummary(): CoordinatorAdminSummary {
	const status = state.lastCoordinatorAdminStatus;
	if (!status) {
		return {
			readiness: "partial",
			title: "Checking Teams readiness…",
			detail: "Loading local Teams configuration from the viewer server.",
		};
	}
	if (status.readiness === "ready") {
		return {
			readiness: "ready",
			title: "Teams is ready",
			detail:
				"This viewer can use the local Teams admin configuration to manage invites, join requests, and enrolled devices without exposing the admin secret to the browser.",
		};
	}
	if (status.readiness === "partial") {
		return {
			readiness: "partial",
			title: "Teams setup is incomplete",
			detail:
				status.has_admin_secret === false
					? "Set a coordinator admin secret for the viewer server before using Teams invite and device actions."
					: "Finish configuring the coordinator target and Team before using Teams actions.",
		};
	}
	return {
		readiness: "not_configured",
		title: "Teams is not configured",
		detail:
			"Set a coordinator URL, Team, and admin secret locally to enable remote Teams administration from this viewer.",
	};
}
