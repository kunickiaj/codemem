/* DOM helpers that keep the team-sync invite/join panel UI in sync
 * with the latest state — invite readiness gating, Radix disclosure
 * rendering, invite-policy Radix select, and the invite/join output
 * visibility toggles. Kept colocated because the helpers reference
 * each other (open/close cycles re-render the select + output). */

import { h } from "preact";
import {
	RadixSelect,
	type RadixSelectOption,
} from "../../../../components/primitives/radix-select";
import { state } from "../../../../lib/state";
import { renderIntoSyncMount } from "../../components/render-root";
import { renderTeamSetupDisclosure } from "../../components/sync-disclosure";
import { adminSetupExpanded, setAdminSetupExpanded } from "../../helpers";
import { teamSyncState } from "../data/state";

const INVITE_POLICY_OPTIONS: RadixSelectOption[] = [
	{ value: "auto_admit", label: "Auto-admit" },
	{ value: "approval_required", label: "Approval required" },
];

export function applySyncInviteReadinessState() {
	const syncCreateInviteButton = document.getElementById(
		"syncCreateInviteButton",
	) as HTMLButtonElement | null;
	const hint = document.getElementById("syncInviteAdminHint") as HTMLParagraphElement | null;
	if (!syncCreateInviteButton || !hint) return;
	const readiness = state.lastCoordinatorAdminStatus?.readiness;
	const activeGroup = String(state.lastCoordinatorAdminStatus?.active_group || "").trim();
	if (readiness === "ready") {
		syncCreateInviteButton.disabled = false;
		hint.hidden = false;
		hint.textContent = activeGroup
			? `Remote coordinator admin is ready for ${activeGroup}. Advanced admin tools now live in Coordinator Admin.`
			: "Remote coordinator admin is ready. Advanced admin tools now live in Coordinator Admin.";
		return;
	}
	const message =
		readiness === "partial"
			? "Finish coordinator admin setup before creating remote invites. Use Coordinator Admin to check what is missing."
			: "Configure a coordinator URL, group, and admin secret before creating remote invites. Use Coordinator Admin to finish setup.";
	syncCreateInviteButton.disabled = true;
	hint.hidden = false;
	hint.textContent = message;
}

export function renderAdminSetupDisclosure() {
	const mount = document.getElementById("syncAdminDisclosureMount") as HTMLElement | null;
	if (!mount) return;
	renderTeamSetupDisclosure(mount, {
		open: adminSetupExpanded,
		onOpenChange: (open) => {
			setAdminSetupExpanded(open);
			renderAdminSetupDisclosure();
			renderInvitePolicySelect();
			setInviteOutputVisibility();
		},
	});
}

export function ensureJoinPanelInSetupSection() {
	const joinPanel = document.getElementById("syncJoinPanel");
	const joinSection = document.getElementById("syncJoinSection");
	if (!joinPanel || !joinSection) return;
	if (joinPanel.parentElement !== joinSection) joinSection.appendChild(joinPanel);
}

export function setInviteOutputVisibility() {
	const syncInviteOutput = document.getElementById(
		"syncInviteOutput",
	) as HTMLTextAreaElement | null;
	const syncInviteWarnings = document.getElementById("syncInviteWarnings") as HTMLDivElement | null;
	if (!syncInviteOutput) return;
	const encoded = String(state.lastTeamInvite?.encoded || "").trim();
	syncInviteOutput.value = encoded;
	syncInviteOutput.hidden = !encoded;
	if (syncInviteWarnings) {
		const warnings = Array.isArray(state.lastTeamInvite?.warnings)
			? state.lastTeamInvite.warnings
			: [];
		syncInviteWarnings.textContent = warnings.join(" · ");
		syncInviteWarnings.hidden = warnings.length === 0;
	}
}

export function setJoinFeedbackVisibility() {
	const syncJoinFeedback = document.getElementById("syncJoinFeedback") as HTMLDivElement | null;
	if (!syncJoinFeedback) return;
	const feedback = state.syncJoinFlowFeedback;
	syncJoinFeedback.textContent = feedback?.message || "";
	syncJoinFeedback.hidden = !feedback?.message;
	syncJoinFeedback.setAttribute("role", feedback?.tone === "warning" ? "alert" : "status");
	syncJoinFeedback.setAttribute("aria-live", feedback?.tone === "warning" ? "assertive" : "polite");
	syncJoinFeedback.className = `peer-meta${feedback ? ` ${feedback.tone === "warning" ? "sync-inline-feedback warning" : "sync-inline-feedback success"}` : ""}`;
}

export function renderInvitePolicySelect() {
	const mount = document.getElementById("syncInvitePolicyMount") as HTMLElement | null;
	if (!mount) return;
	renderIntoSyncMount(
		mount,
		h(RadixSelect, {
			ariaLabel: "Join policy",
			contentClassName: "sync-radix-select-content sync-actor-select-content",
			id: "syncInvitePolicy",
			itemClassName: "sync-radix-select-item",
			onValueChange: (value) => {
				const nextValue = value === "approval_required" ? "approval_required" : "auto_admit";
				if (nextValue === teamSyncState.invitePolicy) return;
				teamSyncState.invitePolicy = nextValue;
				renderInvitePolicySelect();
			},
			options: INVITE_POLICY_OPTIONS,
			triggerClassName: "sync-radix-select-trigger sync-actor-select",
			value: teamSyncState.invitePolicy,
			viewportClassName: "sync-radix-select-viewport",
		}),
	);
}
