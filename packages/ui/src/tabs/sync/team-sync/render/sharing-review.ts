/* Sharing review renderer for the team-sync card — renders the
 * "Teammates are receiving your memories" review surface and routes
 * the "Review" CTA back to the Feed tab filtered by the current actor. */

import { h } from "preact";
import * as api from "../../../../lib/api";
import type {
	LegacySharedReviewReassignmentPreview,
	LegacySharedReviewReassignmentResult,
} from "../../../../lib/api/sync";
import { showGlobalNotice } from "../../../../lib/notice";
import { setFeedScopeFilter, state } from "../../../../lib/state";
import { clearSyncMount, renderIntoSyncMount } from "../../components/render-root";
import {
	type SyncLegacySharedReviewGroup,
	SyncSharingReview,
	type SyncSharingReviewItem,
} from "../../components/sync-sharing-review";

function openFeedSharingReview() {
	setFeedScopeFilter("mine");
	state.feedQuery = "";
	window.location.hash = "feed";
}

function openProjectsReview() {
	window.location.hash = "projects";
}

async function reassignLegacySharedReviewGroup(
	group: SyncLegacySharedReviewGroup,
	scopeId: string,
	confirmedOldCopies: boolean,
	confirmationToken?: string,
): Promise<LegacySharedReviewReassignmentPreview | null> {
	try {
		const result = (await api.reassignLegacySharedReviewGroup({
			...(confirmationToken ? { confirmation_token: confirmationToken } : {}),
			confirmed_old_copies: confirmedOldCopies,
			scope_id: scopeId,
			workspace_identity: group.workspaceIdentity,
		})) as LegacySharedReviewReassignmentResult;
		state.lastSyncLegacySharedReview = result.legacy_shared_review ?? null;
		showGlobalNotice(
			`Reassigned ${result.reassigned_memory_count.toLocaleString()} legacy review memor${result.reassigned_memory_count === 1 ? "y" : "ies"} to ${result.target_scope_label}.`,
		);
		renderSyncSharingReview();
		return null;
	} catch (error) {
		if (error instanceof api.LegacySharedReviewConfirmationError) return error.preview;
		const message =
			error instanceof Error ? error.message : "Unable to reassign legacy review memories.";
		showGlobalNotice(message, "warning");
		throw new Error(message);
	}
}

export function renderSyncSharingReview() {
	const panel = document.getElementById("syncSharingReview");
	const meta = document.getElementById("syncSharingReviewMeta");
	const list = document.getElementById("syncSharingReviewList") as HTMLElement | null;
	if (!panel || !meta || !list) return;
	const title = panel.querySelector<HTMLElement>(".settings-group-title");
	const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
	const legacyRaw = state.lastSyncLegacySharedReview;
	const legacyCount = Math.max(0, Number(legacyRaw?.memory_count ?? 0));
	const legacyReview = legacyRaw?.has_data
		? {
				groups: Array.isArray(legacyRaw.groups)
					? legacyRaw.groups.map((group) => {
							const raw = group as Record<string, unknown>;
							return {
								displayProject: String(raw.display_project || raw.project || "Unknown project"),
								identitySource: String(raw.identity_source || "unknown"),
								lastUpdatedAt: typeof raw.last_updated_at === "string" ? raw.last_updated_at : null,
								memoryCount: Number(raw.memory_count || 0),
								memorySamples: Array.isArray(raw.memory_samples)
									? raw.memory_samples.map((sample) => {
											const sampleRaw = sample as Record<string, unknown>;
											const ownership: "local" | "peer" =
												sampleRaw.ownership === "peer" ? "peer" : "local";
											return {
												bodyPreview:
													typeof sampleRaw.body_preview === "string"
														? sampleRaw.body_preview
														: null,
												createdAt:
													typeof sampleRaw.created_at === "string" ? sampleRaw.created_at : null,
												cwd: typeof sampleRaw.cwd === "string" ? sampleRaw.cwd : null,
												gitRemote:
													typeof sampleRaw.git_remote === "string" ? sampleRaw.git_remote : null,
												id: Number(sampleRaw.id || 0),
												kind: typeof sampleRaw.kind === "string" ? sampleRaw.kind : null,
												ownership,
												project: typeof sampleRaw.project === "string" ? sampleRaw.project : null,
												title: String(sampleRaw.title || `Memory ${Number(sampleRaw.id || 0)}`),
												updatedAt:
													typeof sampleRaw.updated_at === "string" ? sampleRaw.updated_at : null,
											};
										})
									: [],
								peerOwnedMemoryCount: Number(raw.peer_owned_memory_count || 0),
								reassignableMemoryCount: Number(raw.reassignable_memory_count || 0),
								suggestedScopeId:
									typeof raw.suggested_scope_id === "string" ? raw.suggested_scope_id : null,
								suggestionReason:
									typeof raw.suggestion_reason === "string" ? raw.suggestion_reason : null,
								workspaceIdentity: String(
									raw.workspace_identity || raw.display_project || "unknown",
								),
							};
						})
					: [],
				memoryCount: legacyCount,
				scopeId: String(legacyRaw.scope_id || "legacy-shared-review"),
				totalGroupCount: Number(legacyRaw.total_group_count || legacyRaw.groups?.length || 0),
				targetScopes: Array.isArray(legacyRaw.target_scopes)
					? legacyRaw.target_scopes
							.map((scope) => {
								const raw = scope as Record<string, unknown>;
								return {
									authorityType: String(raw.authority_type || "unknown"),
									label: String(raw.label || raw.scope_id || "Unknown domain"),
									scopeId: String(raw.scope_id || ""),
								};
							})
							.filter((scope) => scope.scopeId)
					: [],
			}
		: null;
	if (!items.length && !legacyReview) {
		clearSyncMount(list);
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	if (title) title.textContent = legacyReview ? "Sharing review" : "What teammates will receive";
	const scopeLabel = state.currentProject
		? `current project (${state.currentProject})`
		: "all allowed projects";
	meta.textContent = legacyReview
		? `Review conservative upgrade state before promoting historical shared data. Teammates receive memories from ${scopeLabel} by default once Sharing-domain grants allow it.`
		: `Teammates receive memories from ${scopeLabel} by default. Use Only me on a memory when it should stay local.`;
	const reviewItems: SyncSharingReviewItem[] = items.map((item) => ({
		actorDisplayName: String(item.actor_display_name || item.actor_id || "unknown"),
		actorId: String(item.actor_id || "unknown"),
		peerName: String(item.peer_name || item.peer_device_id || "Device"),
		privateCount: Number(item.private_count || 0),
		scopeLabel: String(item.scope_label || "All allowed projects"),
		shareableCount: Number(item.shareable_count || 0),
	}));
	renderIntoSyncMount(
		list,
		h(SyncSharingReview, {
			items: reviewItems,
			legacyReview,
			onLegacyReassign: reassignLegacySharedReviewGroup,
			onLegacyReview: openProjectsReview,
			onReview: openFeedSharingReview,
		}),
	);
}
