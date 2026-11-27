/* Wires up the buttons on the team-sync card: Share projects and Sync now. Accepting
 * invitations and pairing codes happens in Sharing and Devices, and creating Teams and
 * invitations happens in Sharing (see sync-disclosure.tsx). Also runs an initial paint
 * of the Radix disclosure + invite policy select so the controls are populated on first
 * render. Kept separate from the render pipeline so the render path can stay pure with
 * respect to DOM listeners. */

import {
	mountOperationStatusHost,
	startOperationStatus,
} from "../../../../components/operation-status";
import * as api from "../../../../lib/api";
import { showGlobalNotice } from "../../../../lib/notice";
import { state } from "../../../../lib/state";
import { openProjectShareFlow } from "../../../project-sharing";
import { summarizeSyncRunResult } from "../../view-model";
import { renderAdminSetupDisclosure, renderInvitePolicySelect } from "../helpers/invite-panel-dom";

export function initTeamSyncEvents(refreshCallback: () => void) {
	renderAdminSetupDisclosure();
	renderInvitePolicySelect();
	const operationStatusRoot = document.getElementById("operationStatusRoot");
	if (operationStatusRoot) mountOperationStatusHost(operationStatusRoot);

	const syncNowButton = document.getElementById("syncNowButton") as HTMLButtonElement | null;
	const syncShareProjectsButton = document.getElementById(
		"syncShareProjectsButton",
	) as HTMLButtonElement | null;
	syncShareProjectsButton?.addEventListener("click", () => {
		if (!openProjectShareFlow()) {
			showGlobalNotice(
				"Project sharing is unavailable. Refresh Projects and try again.",
				"warning",
			);
		}
	});

	initManualSyncEvents(syncNowButton, refreshCallback);
}

function initManualSyncEvents(
	syncNowButton: HTMLButtonElement | null,
	refreshCallback: () => void,
) {
	let syncPending = false;
	if (syncNowButton) {
		syncNowButton.disabled =
			state.viewerActorId === null || syncNowButton.getAttribute("aria-busy") === "true";
	}
	syncNowButton?.addEventListener("click", async () => {
		if (!syncNowButton || syncPending || syncNowButton.disabled) return;
		const actorId = state.viewerActorId;
		if (actorId === null) return;
		syncPending = true;
		syncNowButton.disabled = true;
		syncNowButton.setAttribute("aria-busy", "true");
		syncNowButton.textContent = "Syncing\u2026";
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
			syncNowButton.disabled = state.viewerActorId === null;
			syncNowButton.removeAttribute("aria-busy");
			syncNowButton.textContent = "Sync now";
		}
		// The app schedules the view refresh and owns its eventual error feedback.
		if (confirmed) void refreshCallback();
	});
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
