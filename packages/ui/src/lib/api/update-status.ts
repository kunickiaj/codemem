import { fetchJson } from "./internal";
import type { UpdateStatus } from "./types";

export async function loadUpdateStatus(): Promise<UpdateStatus> {
	return fetchJson<UpdateStatus>("/api/update-status");
}

export function unavailableUpdateStatus(error: unknown): UpdateStatus {
	return {
		current_version: "unknown",
		latest_version: null,
		update_available: false,
		first_seen_at: null,
		checked_at: null,
		stale: false,
		install_kind: "unknown",
		auto_update_eligible: false,
		recommended_action: "Check network access and try again.",
		error: error instanceof Error ? error.message : "Update status request failed.",
	};
}
