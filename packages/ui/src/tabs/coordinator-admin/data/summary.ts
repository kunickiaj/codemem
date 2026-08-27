/* Coordinator-admin readiness summary — derives the banner copy from
 * the latest viewer /coordinator-admin/status response. Pure: reads
 * `state.lastCoordinatorAdminStatus` and returns a display-ready shape. */

import { state } from "../../../lib/state";
import { coordinatorAdminState } from "./state";

export type CoordinatorAdminReadiness = "ready" | "partial" | "not_configured";

export interface CoordinatorAdminSummary {
	readiness: CoordinatorAdminReadiness;
	title: string;
	detail: string;
}

export function coordinatorAdminSummary(): CoordinatorAdminSummary {
	const status = state.lastCoordinatorAdminStatus;
	if (!status) {
		if (coordinatorAdminState.recovery.status.availability === "unavailable") {
			return {
				readiness: "partial",
				title: "Legacy coordinator status is unavailable",
				detail:
					"Current coordinator readiness could not be loaded. Retry before using legacy administration actions.",
			};
		}
		return {
			readiness: "partial",
			title: "Checking legacy coordinator readiness…",
			detail: "Loading local coordinator administration configuration from the viewer server.",
		};
	}
	if (status.readiness === "ready") {
		return {
			readiness: "ready",
			title: "Legacy coordinator administration is ready",
			detail:
				"This viewer can manage legacy coordinator groups, invites, join requests, and enrolled devices without exposing the admin secret to the browser.",
		};
	}
	if (status.readiness === "partial") {
		return {
			readiness: "partial",
			title: "Legacy coordinator setup is incomplete",
			detail:
				status.has_admin_secret === false
					? "Set a coordinator admin secret for the viewer server before using legacy invite and device actions."
					: "Finish configuring the coordinator target and group before using legacy administration actions.",
		};
	}
	return {
		readiness: "not_configured",
		title: "Legacy coordinator administration is not configured",
		detail:
			"Set a coordinator URL, group, and admin secret locally to enable remote coordinator administration from this viewer.",
	};
}
