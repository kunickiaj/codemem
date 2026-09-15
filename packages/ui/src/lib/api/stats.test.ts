import { describe, expect, it } from "vitest";

import {
	parseRawEventsPayload,
	parseSessionPayload,
	parseStatsPayload,
	parseUsagePayload,
} from "./stats";

const emptyAutomaticRecall = {
	availability: "no_data",
	periodStart: "2026-08-16T12:00:00.000Z",
	periodEnd: "2026-09-15T12:00:00.000Z",
	windowLimit: 1000,
	freshEvaluations: 0,
	evaluationsWithDuplicates: 0,
	candidateItems: 0,
	duplicatesOmitted: 0,
	beforeTokens: 0,
	afterTokens: 0,
	estimatedTokensAvoided: 0,
	missingRetainedMetadata: 0,
	invalidRetainedMetadata: 0,
	packMetadataGaps: 0,
	unmeasuredAttempts: 0,
	captureVersion: "opencode-retained-v1",
};

function emptyStatsPayload() {
	return {
		identity: {
			device_id: "device-one",
			actor_id: "actor-one",
			actor_display_name: "Example User",
		},
		database: {
			path: "/home/example/.codemem/codemem.db",
			size_bytes: 0,
			sessions: 0,
			memory_items: 0,
			active_memory_items: 0,
			artifacts: 0,
			vector_rows: 0,
			vector_coverage: 0,
			tags_filled: 0,
			tags_coverage: 0,
			raw_events: 0,
		},
		usage: {
			events: [],
			totals: { events: 0, tokens_read: 0, tokens_written: 0, tokens_saved: 0 },
			provenance: {
				events: [],
				totals: {
					token_unit: "tokens",
					measured_count: 0,
					estimated_count: 0,
					unavailable_count: 0,
					legacy_text_length_count: 0,
					legacy_unclassified_count: 0,
				},
			},
		},
		automatic_recall: emptyAutomaticRecall,
		viewer_pid: 1234,
		maintenance_jobs: [],
	};
}

function usageTotals() {
	return {
		tokens_read: 0,
		tokens_written: 0,
		tokens_saved: 0,
		count: 0,
		token_unit: "tokens",
		measured_count: 0,
		estimated_count: 0,
		unavailable_count: 0,
		legacy_text_length_count: 0,
		legacy_unclassified_count: 0,
	};
}

function emptyUsagePayload() {
	return {
		project: "example-project",
		events: [],
		totals: usageTotals(),
		events_global: [],
		totals_global: usageTotals(),
		events_filtered: [],
		totals_filtered: usageTotals(),
		recent_packs: [],
	};
}

function usageEvent() {
	return {
		event: "pack",
		count: 1,
		total_tokens_read: 100,
		total_tokens_written: 10,
		total_tokens_saved: 25,
		token_unit: "tokens",
		measured_count: 1,
		estimated_count: 0,
		unavailable_count: 0,
		legacy_text_length_count: 0,
		legacy_unclassified_count: 0,
	};
}

describe("parseStatsPayload", () => {
	it("accepts a complete server response with valid empty stats", () => {
		// Arrange
		const payload = emptyStatsPayload();

		// Act
		const result = parseStatsPayload(payload);

		// Assert
		expect(result).toEqual({
			automatic_recall: emptyAutomaticRecall,
			database: {
				path: payload.database.path,
				size_bytes: 0,
				active_memory_items: 0,
				vector_coverage: 0,
				tags_coverage: 0,
			},
			reliability: undefined,
			maintenance_jobs: [],
		});
	});

	it("accepts a complete server response with a valid nested maintenance job", () => {
		// Arrange
		const maintenanceJob = validMaintenanceJob();
		const payload = { ...emptyStatsPayload(), maintenance_jobs: [maintenanceJob] };

		// Act
		const result = parseStatsPayload(payload);

		// Assert
		expect(result?.maintenance_jobs).toEqual([maintenanceJob]);
	});

	it.each([null, [], {}, { ...emptyStatsPayload(), maintenance_jobs: undefined }])(
		"rejects a missing or malformed stats payload %#",
		(payload) => {
			// Arrange
			const candidate: unknown = payload;

			// Act
			const result = parseStatsPayload(candidate);

			// Assert
			expect(result).toBeNull();
		},
	);

	it.each([
		{ ...validMaintenanceJob(), progress: { current: -1, total: 10, unit: "items" } },
		{ ...validMaintenanceJob(), progress: { current: 0, total: "10", unit: "items" } },
		{ ...validMaintenanceJob(), error: { private: "failure" } },
	])("rejects a malformed nested maintenance job %#", (maintenanceJob) => {
		// Arrange
		const payload = { ...emptyStatsPayload(), maintenance_jobs: [maintenanceJob] };

		// Act
		const result = parseStatsPayload(payload);

		// Assert
		expect(result).toBeNull();
	});

	it.each([
		{ field: "vector_coverage", value: -0.01 },
		{ field: "tags_coverage", value: 1.01 },
	])("rejects out-of-range database ratio $field", ({ field, value }) => {
		const payload = emptyStatsPayload();
		payload.database = { ...payload.database, [field]: value };

		expect(parseStatsPayload(payload)).toBeNull();
	});

	it.each([
		{ field: "flush_success_rate", value: -0.01 },
		{ field: "dropped_event_rate", value: 1.01 },
	])("rejects out-of-range reliability ratio $field", ({ field, value }) => {
		const payload = {
			...emptyStatsPayload(),
			reliability: {
				counts: { errored_batches: 0 },
				rates: { flush_success_rate: 1, dropped_event_rate: 0, [field]: value },
			},
		};

		expect(parseStatsPayload(payload)).toBeNull();
	});
});

function validMaintenanceJob() {
	return {
		kind: "vector-backfill",
		title: "Build search index",
		status: "running",
		message: "Indexing memories",
		progress: { current: 0, total: 10, unit: "items" },
		finished_at: null,
		error: null,
	};
}

describe("parseUsagePayload", () => {
	it("accepts a complete server response with valid empty usage", () => {
		// Arrange
		const payload = emptyUsagePayload();

		// Act
		const result = parseUsagePayload(payload);

		// Assert
		expect(result).toEqual({
			events: [],
			events_global: [],
			events_filtered: [],
			totals: usageTotals(),
			totals_global: usageTotals(),
			totals_filtered: usageTotals(),
			recent_packs: [],
		});
	});

	it("accepts complete valid nested usage events and a recent pack", () => {
		// Arrange
		const event = usageEvent();
		const payload = {
			...emptyUsagePayload(),
			events: [event],
			events_global: [event],
			events_filtered: [event],
			recent_packs: [
				{
					id: 42,
					session_id: 7,
					event: "pack",
					tokens_read: 100,
					tokens_written: 10,
					tokens_saved: 25,
					created_at: "2026-09-15T12:00:00.000Z",
					metadata_json: { exact_duplicates_collapsed: 2, exact_dedupe_enabled: true },
				},
			],
		};

		// Act
		const result = parseUsagePayload(payload);

		// Assert
		expect(result).toMatchObject({
			events: [event],
			events_global: [event],
			events_filtered: [event],
			recent_packs: [
				{
					created_at: "2026-09-15T12:00:00.000Z",
					tokens_read: 100,
					tokens_saved: 25,
					metadata_json: { exact_duplicates_collapsed: 2, exact_dedupe_enabled: true },
				},
			],
		});
	});

	it.each([null, [], {}, { ...emptyUsagePayload(), totals: undefined }])(
		"rejects a missing or malformed usage payload %#",
		(payload) => {
			// Arrange
			const candidate: unknown = payload;

			// Act
			const result = parseUsagePayload(candidate);

			// Assert
			expect(result).toBeNull();
		},
	);

	it.each(["events", "events_global", "events_filtered"] as const)(
		"rejects a malformed nested usage event in %s",
		(eventField) => {
			// Arrange
			const malformedEvent = { ...usageEvent(), total_tokens_saved: -1 };
			const payload = {
				...emptyUsagePayload(),
				[eventField]: [malformedEvent],
			};

			// Act
			const result = parseUsagePayload(payload);

			// Assert
			expect(result).toBeNull();
		},
	);

	it("rejects a malformed nested recent pack", () => {
		// Arrange
		const payload = {
			...emptyUsagePayload(),
			recent_packs: [
				{
					id: 42,
					session_id: 7,
					event: "pack",
					tokens_read: 100,
					tokens_written: 10,
					tokens_saved: 25,
					created_at: "2026-09-15T12:00:00.000Z",
					metadata_json: { exact_duplicates_collapsed: -1, exact_dedupe_enabled: true },
				},
			],
		};

		// Act
		const result = parseUsagePayload(payload);

		// Assert
		expect(result).toBeNull();
	});
});

describe("parseSessionPayload", () => {
	it("accepts a complete server response with valid empty session counts", () => {
		// Arrange
		const payload = { total: 0, memories: 0, artifacts: 0, prompts: 0, observations: 0 };

		// Act
		const result = parseSessionPayload(payload);

		// Assert
		expect(result).toEqual(payload);
	});

	it.each([
		null,
		[],
		{},
		{ total: 0, memories: 0, artifacts: 0, prompts: 0 },
		{ total: 0, memories: -1, artifacts: 0, prompts: 0, observations: 0 },
	])("rejects a missing or malformed session payload %#", (payload) => {
		// Arrange
		const candidate: unknown = payload;

		// Act
		const result = parseSessionPayload(candidate);

		// Assert
		expect(result).toBeNull();
	});
});

describe("parseRawEventsPayload", () => {
	it("accepts a complete server response with a valid empty backlog", () => {
		// Arrange
		const payload = { pending: 0, sessions: 0 };

		// Act
		const result = parseRawEventsPayload(payload);

		// Assert
		expect(result).toEqual(payload);
	});

	it.each([
		null,
		[],
		{},
		{ pending: 0 },
		{ pending: "0", sessions: 0 },
		{ pending: 0, sessions: -1 },
	])("rejects a missing or malformed raw-events payload %#", (payload) => {
		// Arrange
		const candidate: unknown = payload;

		// Act
		const result = parseRawEventsPayload(candidate);

		// Assert
		expect(result).toBeNull();
	});
});
