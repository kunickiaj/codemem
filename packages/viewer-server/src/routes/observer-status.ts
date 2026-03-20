/**
 * Observer status route — GET /api/observer-status.
 *
 * Ports Python's viewer_routes/observer_status.py.
 * Returns observer runtime info, credential availability, and queue status.
 */

import type { ObserverClient } from "@codemem/core";
import { type MemoryStore, probeAvailableCredentials, type RawEventSweeper } from "@codemem/core";
import { Hono } from "hono";

type StoreFactory = () => MemoryStore;

export interface ObserverStatusDeps {
	getStore: StoreFactory;
	getSweeper: () => RawEventSweeper | null;
	getObserver?: () => ObserverClient | null;
}

function normalizeActiveObserver(active: ReturnType<ObserverClient["getStatus"]> | null) {
	if (!active) return null;
	return {
		...active,
		auth: {
			...active.auth,
			method: active.auth.type,
			token_present: active.auth.hasToken,
		},
	};
}

function buildFailureImpact(
	latestFailure: Record<string, unknown> | null,
	queueTotals: { pending: number; sessions: number },
	authBackoff: { active: boolean; remainingS: number },
): string | null {
	if (!latestFailure) return null;
	if (authBackoff.active) {
		return `Queue retries paused for ~${authBackoff.remainingS}s after an observer auth failure.`;
	}
	if (queueTotals.pending > 0) {
		return `${queueTotals.pending} queued raw events across ${queueTotals.sessions} session(s) are waiting on a successful flush.`;
	}
	return "Failed flush batches are pending retry.";
}

export function observerStatusRoutes(deps?: ObserverStatusDeps) {
	const app = new Hono();

	app.get("/api/observer-status", (c) => {
		const store = deps?.getStore();
		const sweeper = deps?.getSweeper();
		const observer = deps?.getObserver?.() ?? null;

		// Stub fallback when store doesn't have the required methods (e.g. tests with mock store)
		if (!store || typeof store.rawEventBacklogTotals !== "function") {
			return c.json({
				active: null,
				available_credentials: {},
				latest_failure: null,
				queue: {
					pending: 0,
					sessions: 0,
					auth_backoff_active: false,
					auth_backoff_remaining_s: 0,
				},
			});
		}

		const queueTotals = store.rawEventBacklogTotals();
		const authBackoff = sweeper?.authBackoffStatus() ?? { active: false, remainingS: 0 };
		const latestFailure = store.latestRawEventFlushFailure();
		const active = normalizeActiveObserver(observer?.getStatus() ?? null);
		const availableCredentials = probeAvailableCredentials();
		const shouldShowFailure =
			latestFailure != null && (authBackoff.active || queueTotals.pending > 0);

		const failureWithImpact =
			shouldShowFailure && latestFailure
				? { ...latestFailure, impact: buildFailureImpact(latestFailure, queueTotals, authBackoff) }
				: null;

		return c.json({
			active,
			available_credentials: availableCredentials,
			latest_failure: failureWithImpact,
			queue: {
				...queueTotals,
				auth_backoff_active: authBackoff.active,
				auth_backoff_remaining_s: authBackoff.remainingS,
			},
		});
	});

	return app;
}
