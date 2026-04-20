/* Reliability metrics + raw-events gate for the maintenance surface.
 */

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema.js";
import { withDb } from "./with-db.js";

export interface ReliabilityMetrics {
	counts: {
		inserted_events: number;
		dropped_events: number;
		started_batches: number;
		running_batches: number;
		completed_batches: number;
		errored_batches: number;
		terminal_batches: number;
		sessions_with_events: number;
		sessions_with_started_at: number;
		retry_depth_max: number;
	};
	rates: {
		flush_success_rate: number;
		dropped_event_rate: number;
		session_boundary_accuracy: number;
	};
	window_hours: number | null;
}

export function getReliabilityMetrics(
	dbPath?: string,
	windowHours?: number | null,
): ReliabilityMetrics {
	return withDb(dbPath, (db) => {
		const d = drizzle(db, { schema });
		const cutoffIso =
			windowHours != null ? new Date(Date.now() - windowHours * 3600 * 1000).toISOString() : null;

		// Batch counts
		const batchRow = (
			cutoffIso
				? d
						.select({
							started: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('started', 'pending') THEN 1 ELSE 0 END), 0)`,
							running: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('running', 'claimed') THEN 1 ELSE 0 END), 0)`,
							completed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} = 'completed' THEN 1 ELSE 0 END), 0)`,
							errored: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('error', 'failed') THEN 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(gte(schema.rawEventFlushBatches.updated_at, cutoffIso))
						.get()
				: d
						.select({
							started: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('started', 'pending') THEN 1 ELSE 0 END), 0)`,
							running: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('running', 'claimed') THEN 1 ELSE 0 END), 0)`,
							completed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} = 'completed' THEN 1 ELSE 0 END), 0)`,
							errored: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('error', 'failed') THEN 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.get()
		) as Record<string, number> | undefined;

		const startedBatches = Number(batchRow?.started ?? 0);
		const runningBatches = Number(batchRow?.running ?? 0);
		const completedBatches = Number(batchRow?.completed ?? 0);
		const erroredBatches = Number(batchRow?.errored ?? 0);
		const terminalBatches = completedBatches + erroredBatches;
		const flushSuccessRate = terminalBatches > 0 ? completedBatches / terminalBatches : 1.0;

		// Event counts from raw_event_sessions
		// Sequences are 0-based indexes, so +1 converts to counts.
		const eventRow = (
			cutoffIso
				? d
						.select({
							total_received: sql<number>`COALESCE(SUM(${schema.rawEventSessions.last_received_event_seq} + 1), 0)`,
							total_flushed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventSessions.last_flushed_event_seq} >= 0 THEN ${schema.rawEventSessions.last_flushed_event_seq} + 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventSessions)
						.where(gte(schema.rawEventSessions.updated_at, cutoffIso))
						.get()
				: d
						.select({
							total_received: sql<number>`COALESCE(SUM(${schema.rawEventSessions.last_received_event_seq} + 1), 0)`,
							total_flushed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventSessions.last_flushed_event_seq} >= 0 THEN ${schema.rawEventSessions.last_flushed_event_seq} + 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventSessions)
						.get()
		) as Record<string, number> | undefined;

		// In-flight events: sum of (end_event_seq - start_event_seq + 1) for active batches
		const inFlightRow = (
			cutoffIso
				? d
						.select({
							in_flight: sql<number>`COALESCE(SUM(${schema.rawEventFlushBatches.end_event_seq} - ${schema.rawEventFlushBatches.start_event_seq} + 1), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(
							and(
								inArray(schema.rawEventFlushBatches.status, [
									"started",
									"pending",
									"running",
									"claimed",
								]),
								gte(schema.rawEventFlushBatches.updated_at, cutoffIso),
							),
						)
						.get()
				: d
						.select({
							in_flight: sql<number>`COALESCE(SUM(${schema.rawEventFlushBatches.end_event_seq} - ${schema.rawEventFlushBatches.start_event_seq} + 1), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(
							inArray(schema.rawEventFlushBatches.status, [
								"started",
								"pending",
								"running",
								"claimed",
							]),
						)
						.get()
		) as Record<string, number> | undefined;
		const inFlightEvents = Number(inFlightRow?.in_flight ?? 0);

		const insertedEvents = Number(eventRow?.total_flushed ?? 0);
		const droppedEvents = Math.max(
			0,
			Number(eventRow?.total_received ?? 0) - Number(eventRow?.total_flushed ?? 0) - inFlightEvents,
		);
		const droppedDenom = insertedEvents + droppedEvents;
		const droppedEventRate = droppedDenom > 0 ? droppedEvents / droppedDenom : 0.0;

		// Session boundary accuracy
		const hasEvents = (
			cutoffIso
				? d
						.selectDistinct({
							source: schema.rawEvents.source,
							stream_id: schema.rawEvents.stream_id,
						})
						.from(schema.rawEvents)
						.where(gte(schema.rawEvents.created_at, cutoffIso))
				: d
						.selectDistinct({
							source: schema.rawEvents.source,
							stream_id: schema.rawEvents.stream_id,
						})
						.from(schema.rawEvents)
		).as("has_events");

		const boundaryRow = d
			.select({
				sessions_with_events: sql<number>`COUNT(1)`,
				sessions_with_started_at: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.rawEventSessions.started_at}, '') != '' THEN 1 ELSE 0 END), 0)`,
			})
			.from(hasEvents)
			.leftJoin(
				schema.rawEventSessions,
				and(
					eq(schema.rawEventSessions.source, hasEvents.source),
					eq(schema.rawEventSessions.stream_id, hasEvents.stream_id),
				),
			)
			.get() as Record<string, number> | undefined;

		const sessionsWithEvents = Number(boundaryRow?.sessions_with_events ?? 0);
		const sessionsWithStartedAt = Number(boundaryRow?.sessions_with_started_at ?? 0);
		const sessionBoundaryAccuracy =
			sessionsWithEvents > 0 ? sessionsWithStartedAt / sessionsWithEvents : 1.0;

		const retryDepthRow = (
			cutoffIso
				? d
						.select({
							retry_depth_max: sql<number>`COALESCE(MAX(${schema.rawEventFlushBatches.attempt_count}), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(gte(schema.rawEventFlushBatches.updated_at, cutoffIso))
						.get()
				: d
						.select({
							retry_depth_max: sql<number>`COALESCE(MAX(${schema.rawEventFlushBatches.attempt_count}), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.get()
		) as Record<string, number> | undefined;
		const retryDepthMax = Math.max(0, Number(retryDepthRow?.retry_depth_max ?? 0) - 1);

		return {
			counts: {
				inserted_events: insertedEvents,
				dropped_events: droppedEvents,
				started_batches: startedBatches,
				running_batches: runningBatches,
				completed_batches: completedBatches,
				errored_batches: erroredBatches,
				terminal_batches: terminalBatches,
				sessions_with_events: sessionsWithEvents,
				sessions_with_started_at: sessionsWithStartedAt,
				retry_depth_max: retryDepthMax,
			},
			rates: {
				flush_success_rate: flushSuccessRate,
				dropped_event_rate: droppedEventRate,
				session_boundary_accuracy: sessionBoundaryAccuracy,
			},
			window_hours: windowHours ?? null,
		};
	});
}

export interface GateResult {
	passed: boolean;
	failures: string[];
	metrics: ReliabilityMetrics;
}

export function rawEventsGate(
	dbPath?: string,
	opts?: {
		minFlushSuccessRate?: number;
		maxDroppedEventRate?: number;
		minSessionBoundaryAccuracy?: number;
		windowHours?: number;
	},
): GateResult {
	const minFlushSuccessRate = opts?.minFlushSuccessRate ?? 0.95;
	const maxDroppedEventRate = opts?.maxDroppedEventRate ?? 0.05;
	const minSessionBoundaryAccuracy = opts?.minSessionBoundaryAccuracy ?? 0.9;
	const windowHours = opts?.windowHours ?? 24;

	const metrics = getReliabilityMetrics(dbPath, windowHours);
	const failures: string[] = [];

	if (metrics.rates.flush_success_rate < minFlushSuccessRate) {
		failures.push(
			`flush_success_rate=${metrics.rates.flush_success_rate.toFixed(4)} < min ${minFlushSuccessRate.toFixed(4)}`,
		);
	}
	if (metrics.rates.dropped_event_rate > maxDroppedEventRate) {
		failures.push(
			`dropped_event_rate=${metrics.rates.dropped_event_rate.toFixed(4)} > max ${maxDroppedEventRate.toFixed(4)}`,
		);
	}
	if (metrics.rates.session_boundary_accuracy < minSessionBoundaryAccuracy) {
		failures.push(
			`session_boundary_accuracy=${metrics.rates.session_boundary_accuracy.toFixed(4)} < min ${minSessionBoundaryAccuracy.toFixed(4)}`,
		);
	}

	return { passed: failures.length === 0, failures, metrics };
}
