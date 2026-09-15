/* Health tab lifecycle — owns loadHealthData (stats, usage, sessions,
 * raw events fetch + renders) and initHealthTab. renderFeedView fires
 * if the actor id changed between loads so the feed refreshes after
 * an identity switch. */

import * as api from "../../lib/api";
import type { ReadRequestOptions } from "../../lib/read-request";
import { state } from "../../lib/state";
import { updateFeedView } from "../feed";
import { renderAutomaticRecall } from "./components";
import { renderHealthOverview } from "./render/health-overview";
import { renderSessionSummary } from "./render/session-summary";
import { renderStats } from "./render/stats";

export async function loadHealthData(options: ReadRequestOptions = {}) {
	const previousActorId = state.lastStatsPayload?.identity?.actor_id || null;
	const updateStatusPromise =
		state.activeTab === "health" && !state.lastUpdateStatus
			? api.loadUpdateStatus(options).catch(api.unavailableUpdateStatus)
			: Promise.resolve(state.lastUpdateStatus);
	const [statsPayload, usagePayload, _sessionsPayload, rawEventsPayload, updateStatus] =
		await Promise.all([
			api.loadStats(options),
			api.loadUsage(state.currentProject, options),
			api.loadSession(state.currentProject, options),
			api.loadRawEvents(state.currentProject, options),
			updateStatusPromise,
		]);
	if (options.signal?.aborted) return;

	state.lastStatsPayload = statsPayload || {};
	state.lastUsagePayload = usagePayload || {};
	state.lastRawEventsPayload = rawEventsPayload || {};
	state.lastUpdateStatus = updateStatus;
	const nextActorId = state.lastStatsPayload?.identity?.actor_id || null;

	renderStats();
	renderAutomaticRecall(
		document.getElementById("automaticRecallStats"),
		state.lastStatsPayload.automatic_recall,
	);
	renderSessionSummary();
	renderHealthOverview();
	if (state.activeTab === "feed" && previousActorId !== nextActorId) {
		updateFeedView(true);
	}
}

export function initHealthTab() {
	// No special init needed beyond data loading.
}
