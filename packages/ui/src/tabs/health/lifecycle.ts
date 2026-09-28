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

let healthLoadGeneration = 0;

export async function refreshViewerStatus(options: ReadRequestOptions = {}) {
	const previousActorId = state.viewerActorId;
	const status = await api.loadViewerStatus(options);
	if (options.signal?.aborted) return;
	state.viewerActorId = status.identity.actor_id;
	if (previousActorId !== state.viewerActorId) updateFeedView(true);
}

export async function loadHealthData(options: ReadRequestOptions = {}) {
	const generation = ++healthLoadGeneration;
	const project = state.currentProject;
	state.healthStats = beginHealthLoad(state.healthStats);
	state.healthUsage = beginHealthLoad(state.healthUsage, project);
	state.healthSession = beginHealthLoad(state.healthSession, project);
	state.healthRawEvents = beginHealthLoad(state.healthRawEvents);
	renderHealthSections();

	const isCurrent = () => !options.signal?.aborted && generation === healthLoadGeneration;
	if (state.activeTab === "health" && !state.lastUpdateStatus) {
		void api.loadUpdateStatus(options).then(
			(status) => {
				if (!isCurrent()) return;
				state.lastUpdateStatus = status;
				renderHealthOverview();
			},
			(error) => {
				if (!isCurrent()) return;
				state.lastUpdateStatus = api.unavailableUpdateStatus(error);
				renderHealthOverview();
			},
		);
	}

	await Promise.all([
		settleHealthRead(api.loadStats(options)).then((result) => {
			if (!isCurrent()) return;
			state.healthStats = applyHealthResult(state.healthStats, result);
			renderHealthSections();
		}),
		settleHealthRead(api.loadUsage(project, options)).then((result) => {
			if (!isCurrent()) return;
			state.healthUsage = applyHealthResult(state.healthUsage, result, project);
			renderHealthSections();
		}),
		settleHealthRead(api.loadSession(project, options)).then((result) => {
			if (!isCurrent()) return;
			state.healthSession = applyHealthResult(state.healthSession, result, project);
			renderHealthSections();
		}),
		settleHealthRead(api.loadRawEvents(project, options)).then((result) => {
			if (!isCurrent()) return;
			state.healthRawEvents = applyHealthResult(state.healthRawEvents, result);
			renderHealthSections();
		}),
	]);
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
