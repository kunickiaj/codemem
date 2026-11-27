import { startOperationStatus } from "../components/operation-status";
import { summarizeSyncRunResult } from "../tabs/sync/view-model";
import * as api from "./api";
import { showGlobalNotice } from "./notice";
import { state } from "./state";

let syncPending = false;

/** True while a manual sync started from Devices is still waiting for the server. */
export function isManualSyncPending(): boolean {
	return syncPending;
}

/**
 * Syncs every paired device and reports the outcome in the header status, so the person can
 * keep browsing while it runs. Resolves to true only when the server confirmed the result.
 * The view refresh is the caller's, because only the caller knows which view is showing.
 */
export async function runManualSync(refresh: () => void): Promise<boolean> {
	const actorId = state.viewerActorId;
	if (syncPending) return false;
	if (actorId === null) {
		showGlobalNotice("Still checking who is signed in. Try again in a moment.", "warning");
		return false;
	}
	syncPending = true;
	const operation = startOperationStatus("Syncing devices…", "You can keep browsing.");
	const finish = (message: string, tone: "warning" | "success") => {
		if (operation) operation.finish(message, tone);
		else showGlobalNotice(message, tone);
	};
	let confirmed = false;
	try {
		const result = await api.triggerSync();
		// Do not let the summary's empty-list fallback turn an invalid response into success.
		if (!isSyncResult(result) || actorId !== state.viewerActorId) {
			throw new Error("Unconfirmed sync result");
		}
		const summary = summarizeSyncRunResult(result);
		finish(summary.message, summary.warning ? "warning" : "success");
		confirmed = true;
	} catch (error) {
		finish(manualSyncErrorMessage(error, actorId), "warning");
	} finally {
		syncPending = false;
	}
	// The caller schedules the view refresh and owns its eventual error feedback.
	if (confirmed) void refresh();
	return confirmed;
}

function manualSyncErrorMessage(error: unknown, actorId: typeof state.viewerActorId): string {
	if (
		actorId === state.viewerActorId &&
		error instanceof Error &&
		error.message === "sync_disabled"
	) {
		return "Sync is disabled. Enable device sync in Settings before trying again.";
	}
	return "Couldn’t confirm whether sync finished. Check device sync status before retrying.";
}

function isSyncResult(result: unknown): result is api.SyncRunResponse {
	if (!result || typeof result !== "object" || !("items" in result)) return false;
	if (!Array.isArray(result.items)) return false;
	return result.items.every(
		(item) =>
			item &&
			typeof item === "object" &&
			typeof item.peer_device_id === "string" &&
			typeof item.ok === "boolean" &&
			isSyncCount(item.opsIn) &&
			isSyncCount(item.opsOut) &&
			(item.opsSkipped === undefined || isSyncCount(item.opsSkipped)) &&
			(item.error === undefined || typeof item.error === "string") &&
			Array.isArray(item.addressErrors),
	);
}

function isSyncCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
