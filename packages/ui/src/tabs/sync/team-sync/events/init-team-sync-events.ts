/* Wires up the three top-level buttons on the team-sync card:
 * Create invite, Join team, and Sync now. Also runs an initial paint
 * of the Radix disclosure + invite policy select so the controls are
 * populated on first render. Kept separate from the render pipeline so
 * the render path can stay pure with respect to DOM listeners. */

import * as api from "../../../../lib/api";
import { clearFieldError, friendlyError, markFieldError } from "../../../../lib/form";
import { showGlobalNotice } from "../../../../lib/notice";
import { state } from "../../../../lib/state";
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

	syncJoinButton?.addEventListener("click", async () => {
		if (!syncJoinButton || !syncJoinInvite) return;
		const inviteValue = syncJoinInvite.value.trim();
		if (!inviteValue) {
			markFieldError(syncJoinInvite, "Paste a team invite to join.");
			return;
		}
		clearFieldError(syncJoinInvite);
		syncJoinButton.disabled = true;
		syncJoinButton.textContent = "Joining\u2026";
		try {
			const result = await api.importCoordinatorInvite(inviteValue);
			state.lastTeamJoin = result;
			let feedback: SyncActionFeedback = {
				message:
					result.status === "pending"
						? "Join request sent. Waiting for admin approval."
						: "Joined the team.",
				tone: "success",
			};
			state.syncJoinFlowFeedback = feedback;
			setJoinFeedbackVisibility();
			syncJoinInvite.value = "";
			try {
				await loadSyncData();
			} catch (error) {
				feedback = {
					message: friendlyError(error, "Joined the team, but this view has not refreshed yet."),
					tone: "warning",
				};
				state.syncJoinFlowFeedback = feedback;
				setJoinFeedbackVisibility();
			}
		} catch (error) {
			state.syncJoinFlowFeedback = {
				message: friendlyError(
					error,
					"Failed to import invite. Check that the invite is complete, current, and meant for this team, then try again.",
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
				syncJoinButton.textContent = "Join team";
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
