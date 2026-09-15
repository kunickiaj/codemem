/* Health tab lifecycle — owns lightweight viewer status plus detailed Health loads. */

import * as api from "../../lib/api";
import type { ReadRequestOptions } from "../../lib/read-request";
import { state } from "../../lib/state";
import { updateFeedView } from "../feed";
import { renderAutomaticRecall } from "./components";
import { renderHealthOverview } from "./render/health-overview";
import { renderSessionSummary } from "./render/session-summary";
import { renderStats } from "./render/stats";

export async function refreshViewerStatus(options: ReadRequestOptions = {}) {
	const previousActorId = state.viewerActorId;
	const status = await api.loadViewerStatus(options);
	if (options.signal?.aborted) return;
	state.viewerActorId = status.identity.actor_id;
	if (previousActorId !== state.viewerActorId) updateFeedView(true);
}

export async function loadHealthData(options: ReadRequestOptions = {}) {
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
	renderStats();
	renderAutomaticRecall(
		document.getElementById("automaticRecallStats"),
		state.lastStatsPayload.automatic_recall,
	);
	renderSessionSummary();
	renderHealthOverview();
}

export function initHealthTab() {
	// No special init needed beyond data loading.
}
