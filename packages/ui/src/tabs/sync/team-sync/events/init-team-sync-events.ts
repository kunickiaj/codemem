/* Wires up the three top-level buttons on the team-sync card:
 * Join team and Sync now. Creating Teams and invitations happens in
 * Sharing (see sync-disclosure.tsx). Also runs an initial paint
 * of the Radix disclosure + invite policy select so the controls are
 * populated on first render. Kept separate from the render pipeline so
 * the render path can stay pure with respect to DOM listeners. */

import {
	mountOperationStatusHost,
	startOperationStatus,
} from "../../../../components/operation-status";
import * as api from "../../../../lib/api";
import { clearFieldError, friendlyError, markFieldError } from "../../../../lib/form";
import { humanPresentationLabel } from "../../../../lib/identity-presentation";
import { handlePrimaryActionKeyboard } from "../../../../lib/keyboard";
import { showGlobalNotice } from "../../../../lib/notice";
import { state } from "../../../../lib/state";
import { openProjectShareFlow } from "../../../project-sharing";
import type { SyncActionFeedback } from "../../components/sync-inline-feedback";
import { summarizeSyncRunResult } from "../../view-model";
import {
	renderAdminSetupDisclosure,
	renderInvitePolicySelect,
	setJoinFeedbackVisibility,
} from "../helpers/invite-panel-dom";

function projectInviteSummary(
	inspected: Extract<api.InspectInviteResult, { kind: "project_share_invite" }>,
) {
	const projectNames = (inspected.projects ?? [])
		.map(
			(project) =>
				`${project.display_name} (${project.existing_memory_count} existing ${project.existing_memory_count === 1 ? "memory" : "memories"})`,
		)
		.join(", ");
	return `${inspected.inviter_name || "A teammate"} invited you${inspected.team_name ? ` through ${inspected.team_name}` : ""} to share ${projectNames || "selected projects"}.`;
}

type JoinResult = Awaited<ReturnType<typeof api.importCoordinatorInvite>>;
const PAIRING_SAVED = "Pairing saved on this device. Team and Project access is unchanged.";

function projectJoinFeedback(result: JoinResult): SyncActionFeedback {
	const fields = result as { detail?: unknown; restart_required?: unknown; setup_state?: unknown };
	const pending =
		fields.restart_required === true ||
		fields.setup_state === "pending_inviter" ||
		result.status === "pending_setup";
	if (!pending) return { message: "Project invitation accepted.", tone: "success" };
	const detail = typeof fields.detail === "string" ? fields.detail.trim() : "";
	let message = "Project invitation accepted. Setup is still pending.";
	if (fields.restart_required === true)
		message = "Project invitation accepted. Restart codemem to finish setup.";
	else if (fields.setup_state === "pending_inviter")
		message = "Project invitation accepted. Waiting for the inviter to finish setup.";
	return { message: detail || message, tone: "warning" };
}

function joinFeedback(result: JoinResult): SyncActionFeedback {
	if (result.type === "project_share") return projectJoinFeedback(result);
	if (result.type === "pair") return { message: PAIRING_SAVED, tone: "success" };
	return {
		message:
			result.status === "pending"
				? "Join request sent. Waiting for admin approval."
				: "Joined the team.",
		tone: "success",
	};
}

function reviewedInviteAction(kind: api.InspectInviteResult["kind"] | undefined) {
	return kind === "pair" ? "Save pairing" : "Accept invite";
}

function pendingInviteAction(kind: api.InspectInviteResult["kind"] | undefined) {
	return kind === "pair" ? "Saving\u2026" : "Accepting\u2026";
}

function joinRefreshFailure(result: JoinResult, error: unknown): SyncActionFeedback {
	const message =
		result.type === "pair"
			? "Pairing saved on this device. Refresh to see the pairing. Team and Project access is unchanged."
			: "Accepted the invite, but this view has not refreshed yet.";
	return { message: friendlyError(error, message), tone: "warning" };
}

export function initTeamSyncEvents(refreshCallback: () => void, loadSyncData: () => Promise<void>) {
	renderAdminSetupDisclosure();
	renderInvitePolicySelect();
	const operationStatusRoot = document.getElementById("operationStatusRoot");
	if (operationStatusRoot) mountOperationStatusHost(operationStatusRoot);

	const syncNowButton = document.getElementById("syncNowButton") as HTMLButtonElement | null;
	const syncShareProjectsButton = document.getElementById(
		"syncShareProjectsButton",
	) as HTMLButtonElement | null;
	const syncJoinButton = document.getElementById("syncJoinButton") as HTMLButtonElement | null;
	const syncJoinInvite = document.getElementById("syncJoinInvite") as HTMLTextAreaElement | null;
	const projectInviteReview = document.getElementById(
		"syncProjectInviteReview",
	) as HTMLDivElement | null;
	const projectInviteContext = document.getElementById(
		"syncProjectInviteContext",
	) as HTMLDivElement | null;
	const projectInviteReviewHeading = document.getElementById(
		"syncProjectInviteReviewHeading",
	) as HTMLHeadingElement | null;
	const recipientName = document.getElementById("syncRecipientName") as HTMLInputElement | null;
	const recipientDeviceName = document.getElementById(
		"syncRecipientDeviceName",
	) as HTMLInputElement | null;
	let inspectedInviteValue = "";
	let inspectedInviteKind: api.InspectInviteResult["kind"] | undefined;
	let inviteInputRevision = 0;
	const pairingReview = document.getElementById("syncPairingReview");
	const pairingFields = [
		"syncPairingDeviceId",
		"syncPairingFingerprint",
		"syncPairingAddresses",
	].map((id) => document.getElementById(id));
	const clearPairingReview = () => {
		if (pairingReview) pairingReview.hidden = true;
		for (const field of pairingFields) if (field) field.textContent = "";
	};
	const renderPairingReview = (inspected: Extract<api.InspectInviteResult, { kind: "pair" }>) => {
		if (!pairingReview || pairingFields.some((field) => !field)) {
			throw new Error("Pairing review unavailable. Refresh and try again.");
		}
		const values = [inspected.device_id, inspected.fingerprint, inspected.addresses.join("\n")];
		pairingFields.forEach((field, index) => {
			if (field) field.textContent = values[index] ?? "";
		});
		pairingReview.hidden = false;
		document.getElementById("syncPairingReviewHeading")?.focus();
	};
	const isCurrentInvite = (value: string, revision: number) =>
		revision === inviteInputRevision && syncJoinInvite?.value.trim() === value;

	syncShareProjectsButton?.addEventListener("click", () => {
		if (!openProjectShareFlow()) {
			showGlobalNotice(
				"Project sharing is unavailable. Refresh Projects and try again.",
				"warning",
			);
		}
	});

	const reviewProjectInvite = async (
		inviteValue: string,
		inputRevision: number,
	): Promise<"project" | "other" | "stale"> => {
		const inspected = await api.inspectCoordinatorInvite(inviteValue);
		if (!isCurrentInvite(inviteValue, inputRevision)) {
			return "stale";
		}
		inspectedInviteKind = inspected.kind;
		if (inspected.kind === "pair") {
			renderPairingReview(inspected);
			return "other";
		}
		if (inspected.kind !== "project_share_invite") return "other";
		if (!projectInviteReview || !recipientName || !recipientDeviceName) return "other";
		if (projectInviteContext) {
			projectInviteContext.textContent = projectInviteSummary(inspected);
		}
		recipientName.value = humanPresentationLabel(inspected.recipient_name);
		recipientDeviceName.value = humanPresentationLabel(inspected.device_name);
		projectInviteReview.hidden = false;
		inspectedInviteValue = inviteValue;
		if (syncJoinButton) syncJoinButton.textContent = "Accept and start syncing";
		projectInviteReviewHeading?.focus();
		return "project";
	};

	syncJoinInvite?.addEventListener("input", () => {
		inviteInputRevision += 1;
		if (syncJoinInvite.value.trim() === inspectedInviteValue) return;
		inspectedInviteValue = "";
		inspectedInviteKind = undefined;
		if (projectInviteReview) projectInviteReview.hidden = true;
		clearPairingReview();
		if (syncJoinButton) syncJoinButton.textContent = "Review invite";
	});

	// Cmd/Ctrl+Enter inside the invite textarea triggers Accept. Bare Enter
	// is intentionally left alone so users can keep the textarea's native
	// newline behavior while pasting multi-line payloads.
	syncJoinInvite?.addEventListener("keydown", (event) => {
		handlePrimaryActionKeyboard(event, {
			onSubmit: () => syncJoinButton?.click(),
			disabled: !syncJoinButton || syncJoinButton.disabled,
		});
	});

	syncJoinButton?.addEventListener("click", async () => {
		if (!syncJoinButton || !syncJoinInvite) return;
		if (syncJoinButton.disabled) return;
		const inviteValue = syncJoinInvite.value.trim();
		if (!inviteValue) {
			markFieldError(syncJoinInvite, "Paste a team invite or pairing payload.");
			return;
		}
		clearFieldError(syncJoinInvite);
		if (inspectedInviteValue !== inviteValue) {
			const inputRevision = inviteInputRevision;
			syncJoinButton.disabled = true;
			try {
				const reviewOutcome = await reviewProjectInvite(inviteValue, inputRevision);
				if (reviewOutcome === "project" || reviewOutcome === "stale") return;
			} catch (error) {
				if (!isCurrentInvite(inviteValue, inputRevision)) return;
				markFieldError(
					syncJoinInvite,
					friendlyError(
						error,
						"Could not review this invite or pairing payload. Check the pasted text and try again.",
					),
				);
				return;
			} finally {
				syncJoinButton.disabled = false;
			}
			if (!isCurrentInvite(inviteValue, inputRevision)) {
				return;
			}
			inspectedInviteValue = inviteValue;
			syncJoinButton.textContent = reviewedInviteAction(inspectedInviteKind);
			return;
		}
		const identity =
			projectInviteReview && !projectInviteReview.hidden
				? {
						recipient_name: recipientName?.value.trim() ?? "",
						device_name: recipientDeviceName?.value.trim() ?? "",
					}
				: undefined;
		if (identity) {
			const invalid = (value: string) => humanPresentationLabel(value) === "";
			if (invalid(identity.recipient_name)) {
				if (recipientName)
					markFieldError(
						recipientName,
						"Enter a human-readable name using 120 characters or fewer.",
					);
				return;
			}
			if (invalid(identity.device_name)) {
				if (recipientDeviceName)
					markFieldError(
						recipientDeviceName,
						"Enter a human-readable device name using 120 characters or fewer.",
					);
				return;
			}
		}
		syncJoinButton.disabled = true;
		syncJoinButton.textContent = pendingInviteAction(inspectedInviteKind);
		try {
			const result = await api.importCoordinatorInvite(inviteValue, identity, inspectedInviteKind);
			state.lastTeamJoin = result;
			let feedback = joinFeedback(result);
			state.syncJoinFlowFeedback = feedback;
			setJoinFeedbackVisibility();
			syncJoinInvite.value = "";
			inviteInputRevision += 1;
			inspectedInviteValue = "";
			inspectedInviteKind = undefined;
			clearPairingReview();
			if (projectInviteReview) projectInviteReview.hidden = true;
			try {
				await loadSyncData();
			} catch (error) {
				feedback = joinRefreshFailure(result, error);
				state.syncJoinFlowFeedback = feedback;
				setJoinFeedbackVisibility();
			}
		} catch (error) {
			state.syncJoinFlowFeedback = {
				message: friendlyError(
					error,
					"Failed to accept. Check that the invite or pairing payload is complete and current, then try again.",
				),
				tone: "warning",
			};
			setJoinFeedbackVisibility();
			syncJoinButton.textContent = "Retry";
			syncJoinButton.disabled = false;
			return;
		} finally {
			if (syncJoinButton.disabled) {
				syncJoinButton.disabled = false;
				syncJoinButton.textContent = "Review invite";
			}
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
