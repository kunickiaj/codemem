/* Health tab lifecycle — owns lightweight viewer status plus detailed Health loads. */

import * as api from "../../lib/api";
import type { ReadRequestOptions } from "../../lib/read-request";
import type { HealthResourceState } from "../../lib/state";
import {
	beginHealthLoad,
	completeHealthLoad,
	failHealthLoad,
	healthData,
	state,
} from "../../lib/state";
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
	const project = state.currentProject;
	state.healthStats = beginHealthLoad(state.healthStats);
	state.healthUsage = beginHealthLoad(state.healthUsage, project);
	state.healthSession = beginHealthLoad(state.healthSession, project);
	state.healthRawEvents = beginHealthLoad(state.healthRawEvents);
	renderHealthSections();

	const updateStatusPromise =
		state.activeTab === "health" && !state.lastUpdateStatus
			? api.loadUpdateStatus(options).catch(api.unavailableUpdateStatus)
			: Promise.resolve(state.lastUpdateStatus);
	const [statsResult, usageResult, sessionResult, rawEventsResult, updateStatus] =
		await Promise.all([
			settleHealthRead(api.loadStats(options)),
			settleHealthRead(api.loadUsage(project, options)),
			settleHealthRead(api.loadSession(project, options)),
			settleHealthRead(api.loadRawEvents(project, options)),
			updateStatusPromise,
		]);
	if (options.signal?.aborted) return;

	state.healthStats = applyHealthResult(state.healthStats, statsResult);
	state.healthUsage = applyHealthResult(state.healthUsage, usageResult, project);
	state.healthSession = applyHealthResult(state.healthSession, sessionResult, project);
	state.healthRawEvents = applyHealthResult(state.healthRawEvents, rawEventsResult);
	state.lastUpdateStatus = updateStatus;
	renderHealthSections();
}

function renderHealthSections(): void {
	renderStats();
	renderAutomaticRecall(
		document.getElementById("automaticRecallStats"),
		healthData(state.healthStats)?.automatic_recall,
	);
	renderSessionSummary();
	renderHealthOverview();
}

type HealthReadResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function settleHealthRead<T>(promise: Promise<T>): Promise<HealthReadResult<T>> {
	try {
		return { ok: true, data: await promise };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "Health request failed" };
	}
}

function applyHealthResult<T>(
	current: HealthResourceState<T>,
	result: HealthReadResult<T>,
	scopeKey = "",
): HealthResourceState<T> {
	if ("data" in result) return completeHealthLoad(result.data, Date.now(), scopeKey);
	return failHealthLoad(current, result.error);
}

export function initHealthTab() {
	// No special init needed beyond data loading.
}
