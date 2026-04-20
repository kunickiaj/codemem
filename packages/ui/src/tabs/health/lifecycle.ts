/* Health tab lifecycle — owns loadHealthData (stats, usage, sessions,
 * raw events fetch + renders) and initHealthTab. renderFeedView fires
 * if the actor id changed between loads so the feed refreshes after
 * an identity switch. */

import * as api from "../../lib/api";
import { state } from "../../lib/state";
import { updateFeedView } from "../feed";
import { renderHealthOverview } from "./render/health-overview";
import { renderSessionSummary } from "./render/session-summary";
import { renderStats } from "./render/stats";

export async function loadHealthData() {
	const previousActorId = state.lastStatsPayload?.identity?.actor_id || null;
	const [statsPayload, usagePayload, _sessionsPayload, rawEventsPayload] = await Promise.all([
		api.loadStats(),
		api.loadUsage(state.currentProject),
		api.loadSession(state.currentProject),
		api.loadRawEvents(state.currentProject),
	]);

	state.lastStatsPayload = statsPayload || {};
	state.lastUsagePayload = usagePayload || {};
	state.lastRawEventsPayload = rawEventsPayload || {};
	const nextActorId = state.lastStatsPayload?.identity?.actor_id || null;

	renderStats();
	renderSessionSummary();
	renderHealthOverview();
	if (state.activeTab === "feed" && previousActorId !== nextActorId) {
		updateFeedView(true);
	}
}

export function initHealthTab() {
	// No special init needed beyond data loading.
}
