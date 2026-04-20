/* Sharing review renderer for the team-sync card — renders the
 * "Teammates are receiving your memories" review surface and routes
 * the "Review" CTA back to the Feed tab filtered by the current actor. */

import { h } from "preact";
import { setFeedScopeFilter, state } from "../../../../lib/state";
import { clearSyncMount, renderIntoSyncMount } from "../../components/render-root";
import {
	SyncSharingReview,
	type SyncSharingReviewItem,
} from "../../components/sync-sharing-review";

function openFeedSharingReview() {
	setFeedScopeFilter("mine");
	state.feedQuery = "";
	window.location.hash = "feed";
}

export function renderSyncSharingReview() {
	const panel = document.getElementById("syncSharingReview");
	const meta = document.getElementById("syncSharingReviewMeta");
	const list = document.getElementById("syncSharingReviewList") as HTMLElement | null;
	if (!panel || !meta || !list) return;
	const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
	if (!items.length) {
		clearSyncMount(list);
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	const scopeLabel = state.currentProject
		? `current project (${state.currentProject})`
		: "all allowed projects";
	meta.textContent = `Teammates receive memories from ${scopeLabel} by default. Use Only me on a memory when it should stay local.`;
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
		h(SyncSharingReview, { items: reviewItems, onReview: openFeedSharingReview }),
	);
}
