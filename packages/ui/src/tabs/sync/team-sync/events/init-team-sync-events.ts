/* Wires up the three top-level buttons on the team-sync card:
 * Create invite, Join team, and Sync now. Also runs an initial paint
 * of the Radix disclosure + invite policy select so the controls are
 * populated on first render. Kept separate from the render pipeline so
 * the render path can stay pure with respect to DOM listeners. */

import * as api from "../../../../lib/api";
import { clearFieldError, friendlyError, markFieldError } from "../../../../lib/form";
import { humanPresentationLabel } from "../../../../lib/identity-presentation";
import { handlePrimaryActionKeyboard } from "../../../../lib/keyboard";
import { showGlobalNotice } from "../../../../lib/notice";
import { state } from "../../../../lib/state";
import { openProjectShareFlow } from "../../../project-sharing";
import type { SyncActionFeedback } from "../../components/sync-inline-feedback";
import { summarizeSyncRunResult } from "../../view-model";
import { teamSyncState } from "../data/state";
import {
	renderAdminSetupDisclosure,
	renderInvitePolicySelect,
	setInviteOutputVisibility,
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

function showInviteCreatedNotice(warnings: unknown[]) {
	if (!warnings.length) {
		showGlobalNotice(
			"Invite created. Copy the text above and share it with your teammate.",
			"success",
		);
		return;
	}
	const count = warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`;
	showGlobalNotice(`Invite created. Copy it above and review ${count}.`, "warning");
}

type JoinResult = Awaited<ReturnType<typeof api.importCoordinatorInvite>>;

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
	const fields = result as { type?: unknown; peer_device_id?: unknown };
	if (fields.type === "project_share") return projectJoinFeedback(result);
	if (fields.type === "pair") {
		const peerId = String(fields.peer_device_id ?? "").trim();
		return {
			message: peerId
				? `Paired with device ${peerId.slice(0, 8)}. It will appear in People & devices.`
				: "Paired the device. It will appear in People & devices.",
			tone: "success",
		};
	}
	return {
		message:
			result.status === "pending"
				? "Join request sent. Waiting for admin approval."
				: "Joined the team.",
		tone: "success",
	};
}

export function initTeamSyncEvents(refreshCallback: () => void, loadSyncData: () => Promise<void>) {
	renderAdminSetupDisclosure();
	renderInvitePolicySelect();

	const syncNowButton = document.getElementById("syncNowButton") as HTMLButtonElement | null;
	const syncShareProjectsButton = document.getElementById(
		"syncShareProjectsButton",
	) as HTMLButtonElement | null;
	const syncCreateInviteButton = document.getElementById(
		"syncCreateInviteButton",
	) as HTMLButtonElement | null;
	const syncInviteGroup = document.getElementById("syncInviteGroup") as HTMLInputElement | null;
	const syncInviteTtl = document.getElementById("syncInviteTtl") as HTMLInputElement | null;
	const syncInviteOutput = document.getElementById(
		"syncInviteOutput",
	) as HTMLTextAreaElement | null;
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

	syncCreateInviteButton?.addEventListener("click", async () => {
		if (!syncCreateInviteButton || !syncInviteGroup || !syncInviteTtl || !syncInviteOutput) return;
		if (syncCreateInviteButton.disabled) return;
		const groupName = syncInviteGroup.value.trim();
		const ttlValue = Number(syncInviteTtl.value);
		let valid = true;
		if (!groupName) {
			valid = markFieldError(syncInviteGroup, "Team name is required.");
		} else {
			clearFieldError(syncInviteGroup);
		}
		if (!ttlValue || ttlValue < 1) {
			valid = markFieldError(syncInviteTtl, "Must be at least 1 hour.");
		} else {
			clearFieldError(syncInviteTtl);
		}
		if (!valid) return;
		syncCreateInviteButton.disabled = true;
		syncCreateInviteButton.textContent = "Creating\u2026";
		try {
			const result = await api.createCoordinatorInvite({
				group_id: groupName,
				policy: teamSyncState.invitePolicy,
				ttl_hours: ttlValue || 24,
			});
			state.lastTeamInvite = result;
			setInviteOutputVisibility();
			syncInviteOutput.value = String(result.encoded || "");
			syncInviteOutput.hidden = false;
			syncInviteOutput.focus();
			syncInviteOutput.select();
			const warnings = Array.isArray(result.warnings) ? result.warnings : [];
			showInviteCreatedNotice(warnings);
		} catch (error) {
			showGlobalNotice(
				friendlyError(
					error,
					"Failed to create invite. Check the team name, invite lifetime, and coordinator reachability, then try again.",
				),
				"warning",
			);
			syncCreateInviteButton.textContent = "Retry";
			syncCreateInviteButton.disabled = false;
			return;
		} finally {
			if (syncCreateInviteButton.disabled) {
				syncCreateInviteButton.disabled = false;
				syncCreateInviteButton.textContent = "Create invite";
			}
		}
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
			syncJoinButton.textContent = "Accept invite";
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
		syncJoinButton.textContent = "Accepting\u2026";
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
				feedback = {
					message: friendlyError(
						error,
						"Accepted the invite, but this view has not refreshed yet.",
					),
					tone: "warning",
				};
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

	syncNowButton?.addEventListener("click", async () => {
		if (!syncNowButton) return;
		syncNowButton.disabled = true;
		syncNowButton.textContent = "Syncing\u2026";
		try {
			const result = await api.triggerSync();
			const summary = summarizeSyncRunResult(result);
			showGlobalNotice(summary.message, summary.warning ? "warning" : undefined);
		} catch (error) {
			showGlobalNotice(
				friendlyError(
					error,
					"Failed to start sync. Retry once, then run codemem sync doctor if the problem keeps coming back.",
				),
				"warning",
			);
			syncNowButton.textContent = "Retry";
			syncNowButton.disabled = false;
			return;
		}
		syncNowButton.disabled = false;
		syncNowButton.textContent = "Sync now";
		refreshCallback();
	});
}
