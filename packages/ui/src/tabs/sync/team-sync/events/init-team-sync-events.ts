/* Wires up the three top-level buttons on the team-sync card:
 * Create invite, Join team, and Sync now. Also runs an initial paint
 * of the Radix disclosure + invite policy select so the controls are
 * populated on first render. Kept separate from the render pipeline so
 * the render path can stay pure with respect to DOM listeners. */

import * as api from "../../../../lib/api";
import { clearFieldError, friendlyError, markFieldError } from "../../../../lib/form";
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
	let inviteInputRevision = 0;

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
		if (!projectInviteReview || !recipientName || !recipientDeviceName) return "other";
		const inspected = await api.inspectCoordinatorInvite(inviteValue);
		if (inputRevision !== inviteInputRevision || syncJoinInvite?.value.trim() !== inviteValue) {
			return "stale";
		}
		if (inspected.kind !== "project_share_invite") return "other";
		const projectNames = (inspected.projects ?? [])
			.map(
				(project) =>
					`${project.display_name} (${project.existing_memory_count} existing ${project.existing_memory_count === 1 ? "memory" : "memories"})`,
			)
			.join(", ");
		if (projectInviteContext) {
			projectInviteContext.textContent = `${inspected.inviter_name || "A teammate"} invited you${inspected.team_name ? ` through ${inspected.team_name}` : ""} to share ${projectNames || "selected projects"}.`;
		}
		recipientName.value = inspected.recipient_name ?? "";
		recipientDeviceName.value = inspected.device_name ?? "";
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
		if (projectInviteReview) projectInviteReview.hidden = true;
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
			showGlobalNotice(
				warnings.length
					? `Invite created. Copy it above and review ${warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}.`
					: "Invite created. Copy the text above and share it with your teammate.",
				warnings.length ? "warning" : "success",
			);
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
		const inviteValue = syncJoinInvite.value.trim();
		if (!inviteValue) {
			markFieldError(syncJoinInvite, "Paste a team invite or pairing payload.");
			return;
		}
		clearFieldError(syncJoinInvite);
		if (inspectedInviteValue !== inviteValue) {
			const inputRevision = inviteInputRevision;
			try {
				const reviewOutcome = await reviewProjectInvite(inviteValue, inputRevision);
				if (reviewOutcome === "project" || reviewOutcome === "stale") return;
			} catch {
				// Pairing payloads and legacy envelopes continue through the existing importer.
			}
			if (inputRevision !== inviteInputRevision || syncJoinInvite.value.trim() !== inviteValue) {
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
			const invalid = (value: string) =>
				!value ||
				[...value].length > 120 ||
				[...value].some((character) => /[\p{Cc}\p{Cf}]/u.test(character));
			if (invalid(identity.recipient_name)) {
				if (recipientName)
					markFieldError(recipientName, "Enter a valid name using 120 characters or fewer.");
				return;
			}
			if (invalid(identity.device_name)) {
				if (recipientDeviceName)
					markFieldError(
						recipientDeviceName,
						"Enter a valid device name using 120 characters or fewer.",
					);
				return;
			}
		}
		syncJoinButton.disabled = true;
		syncJoinButton.textContent = "Accepting\u2026";
		try {
			const result = await api.importCoordinatorInvite(inviteValue, identity);
			state.lastTeamJoin = result;
			const resultFields = result as {
				detail?: unknown;
				restart_required?: unknown;
				setup_state?: unknown;
				type?: unknown;
			};
			const resultType = typeof resultFields.type === "string" ? resultFields.type : "team_join";
			let feedback: SyncActionFeedback;
			if (resultType === "pair") {
				const peerId = String((result as { peer_device_id?: unknown }).peer_device_id ?? "").trim();
				feedback = {
					message: peerId
						? `Paired with device ${peerId.slice(0, 8)}. It will appear in People & devices.`
						: "Paired the device. It will appear in People & devices.",
					tone: "success",
				};
			} else if (resultType === "project_share") {
				const pendingSetup =
					resultFields.restart_required === true ||
					resultFields.setup_state === "pending_inviter" ||
					result.status === "pending_setup";
				const detail = typeof resultFields.detail === "string" ? resultFields.detail.trim() : "";
				feedback = pendingSetup
					? {
							message:
								detail ||
								(resultFields.restart_required === true
									? "Project invitation accepted. Restart codemem to finish setup."
									: resultFields.setup_state === "pending_inviter"
										? "Project invitation accepted. Waiting for the inviter to finish setup."
										: "Project invitation accepted. Setup is still pending."),
							tone: "warning",
						}
					: { message: "Project invitation accepted.", tone: "success" };
			} else {
				feedback = {
					message:
						result.status === "pending"
							? "Join request sent. Waiting for admin approval."
							: "Joined the team.",
					tone: "success",
				};
			}
			state.syncJoinFlowFeedback = feedback;
			setJoinFeedbackVisibility();
			syncJoinInvite.value = "";
			inspectedInviteValue = "";
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
