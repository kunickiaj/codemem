import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	evaluateSessionExtractionItems,
	getSessionExtractionEval,
	getSessionExtractionEvalScenario,
} from "./extraction-eval.js";
import { initTestSchema } from "./test-utils.js";

function createDbPath(name: string): string {
	return join(
		tmpdir(),
		`codemem-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
	);
}

describe("session extraction eval", () => {
	it("exposes the rich-session under-extraction scenario", () => {
		expect(getSessionExtractionEvalScenario("rich-session-under-extraction")?.title).toContain(
			"Rich multi-thread session extraction coverage",
		);
	});

	it("exposes the generic rich-batch shape scenario", () => {
		expect(getSessionExtractionEvalScenario("rich-batch-shape")?.title).toContain(
			"Rich batch output shape",
		);
	});

	it("exposes simple and working batch shape scenarios", () => {
		expect(getSessionExtractionEvalScenario("simple-batch-shape")?.title).toContain(
			"Simple batch output shape",
		);
		expect(getSessionExtractionEvalScenario("working-batch-shape")?.title).toContain(
			"Working batch output shape",
		);
	});

	it("passes when summary and observations cover the major rich-session threads", () => {
		const scenario = getSessionExtractionEvalScenario("rich-session-under-extraction");
		if (!scenario) throw new Error("scenario missing");

		const result = evaluateSessionExtractionItems(
			{ type: "session", sessionId: 166405 },
			{
				id: 166405,
				project: "codemem",
				cwd: "/tmp/repo",
				startedAt: "2026-04-06T21:23:59.631Z",
				endedAt: "2026-04-07T06:13:45.667Z",
				sessionClass: "durable",
				summaryDisposition: "stored",
			},
			[
				{
					id: 1,
					kind: "session_summary",
					title: "Track 3 and release readiness session summary",
					bodyText:
						"Closed the qd7h regression investigation after confirming the root cause had already been identified. Prepared 0.23.0 release readiness and reframed Track 3 toward injection-first rediscovery reduction. Also discussed a graph and progressive disclosure direction for future retrieval work.",
					active: true,
					createdAt: "2026-04-07T06:13:45.667Z",
					metadata: {},
				},
				{
					id: 2,
					kind: "decision",
					title: "Track 3 reframed around injection-first quality",
					bodyText:
						"Track 3 now focuses on reducing rediscovery and scouting effort through injection-first memory quality.",
					active: true,
					createdAt: "2026-04-07T06:13:46.000Z",
					metadata: {},
				},
				{
					id: 3,
					kind: "discovery",
					title: "qd7h regression root cause already fixed",
					bodyText:
						"The micro-session regression timeline was narrowed and qd7h was closed once the existing root cause fix was confirmed.",
					active: true,
					createdAt: "2026-04-07T06:13:47.000Z",
					metadata: {},
				},
				{
					id: 4,
					kind: "exploration",
					title: "Graph relationship layer kept as future direction",
					bodyText:
						"Graph and progressive disclosure ideas were captured as a future relationship layer direction rather than a release blocker.",
					active: true,
					createdAt: "2026-04-07T06:13:48.000Z",
					metadata: {},
				},
			],
			scenario,
		);

		expect(result.pass).toBe(true);
		expect(result.counts.summaries).toBe(1);
		expect(result.counts.observations).toBe(3);
		expect(result.coverage.summaryThreadCoverage).toBeGreaterThanOrEqual(2);
		expect(result.coverage.observationThreadCoverage).toBeGreaterThanOrEqual(2);
		expect(result.coverage.totalThreadCoverage).toBeGreaterThanOrEqual(3);
	});

	it("fails a narrow summary plus single-observation under-extraction case", () => {
		const scenario = getSessionExtractionEvalScenario("rich-session-under-extraction");
		if (!scenario) throw new Error("scenario missing");

		const result = evaluateSessionExtractionItems(
			{ type: "session", sessionId: 166405 },
			{
				id: 166405,
				project: "codemem",
				cwd: "/tmp/repo",
				startedAt: "2026-04-06T21:23:59.631Z",
				endedAt: "2026-04-07T06:13:45.667Z",
				sessionClass: "durable",
				summaryDisposition: "stored",
			},
			[
				{
					id: 1,
					kind: "session_summary",
					title: "Regression timeline summary",
					bodyText:
						"Investigated a regression timeline and narrowed the micro-session issue to raw-event sessionization changes.",
					active: true,
					createdAt: "2026-04-07T06:13:45.667Z",
					metadata: {},
				},
				{
					id: 2,
					kind: "discovery",
					title: "Micro-session regression timeline narrowed",
					bodyText: "The regression timeline was narrowed to raw-event sessionization changes.",
					active: true,
					createdAt: "2026-04-07T06:13:46.000Z",
					metadata: {},
				},
			],
			scenario,
		);

		expect(result.pass).toBe(false);
		expect(result.failureReasons).toEqual(
			expect.arrayContaining([
				expect.stringContaining("observation count 1 outside expected range 2-4"),
				expect.stringContaining("summary thread coverage"),
				expect.stringContaining("observation thread coverage"),
			]),
		);
	});

	it("loads and evaluates a session directly from the database", () => {
		const dbPath = createDbPath("session-extraction-eval");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (166405, '2026-04-06T21:23:59.631Z', '2026-04-07T06:13:45.667Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"post":{"session_class":"durable","summary_disposition":"stored"}}');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 166405, 'session_summary', 'Track 3 and release readiness session summary', 'Closed qd7h, prepared 0.23.0, reframed Track 3 toward injection-first rediscovery reduction, and discussed graph progressive disclosure work.', 1, '2026-04-07T06:13:45.667Z', '2026-04-07T06:13:45.667Z', '{}', 'k1'),
				  (2, 166405, 'decision', 'Track 3 reframed around injection-first quality', 'Track 3 now focuses on reducing rediscovery and scouting effort.', 1, '2026-04-07T06:13:46.000Z', '2026-04-07T06:13:46.000Z', '{}', 'k2'),
				  (3, 166405, 'exploration', 'Graph relationship layer kept as future direction', 'Graph and progressive disclosure ideas were recorded as future work.', 1, '2026-04-07T06:13:47.000Z', '2026-04-07T06:13:47.000Z', '{}', 'k3');
			`);
		} finally {
			db.close();
		}

		const result = getSessionExtractionEval(dbPath, {
			sessionId: 166405,
			scenarioId: "rich-session-under-extraction",
		});

		expect(result.session.sessionClass).toBe("durable");
		expect(result.counts.summaries).toBe(1);
		expect(result.counts.observations).toBe(2);
		expect(result.pass).toBe(true);
	});

	it("evaluates a flush batch using explicit batch metadata on extracted memories", () => {
		const dbPath = createDbPath("batch-extraction-eval");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (166405, '2026-04-06T21:23:59.631Z', '2026-04-07T06:13:45.667Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"post":{"session_class":"durable","summary_disposition":"stored"}}');
				INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
				  ('opencode', 'ses-1', 'ses-1', 166405, '2026-04-06T21:23:59.631Z');
				INSERT INTO raw_event_flush_batches(id, source, stream_id, opencode_session_id, start_event_seq, end_event_seq, extractor_version, status, attempt_count, created_at, updated_at) VALUES
				  (18503, 'opencode', 'ses-1', 'ses-1', 1204, 1356, 'raw_events_v1', 'completed', 1, '2026-04-07T06:13:45.600Z', '2026-04-07T06:13:45.700Z');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 166405, 'session_summary', 'Track 3 and release readiness session summary', 'Closed qd7h, prepared 0.23.0, reframed Track 3 toward injection-first rediscovery reduction, and discussed graph progressive disclosure work.', 1, '2026-04-07T06:13:45.650Z', '2026-04-07T06:13:45.650Z', '{"is_summary":true,"source":"observer_summary","flush_batch":{"batch_id":18503}}', 'k1'),
				  (2, 166405, 'decision', 'Track 3 reframed around injection-first quality', 'Track 3 now focuses on reducing rediscovery and scouting effort.', 1, '2026-04-07T06:13:45.651Z', '2026-04-07T06:13:45.651Z', '{"source":"observer","flush_batch":{"batch_id":18503}}', 'k2'),
				  (3, 166405, 'exploration', 'Graph relationship layer kept as future direction', 'Graph and progressive disclosure ideas were recorded as future work.', 1, '2026-04-07T06:13:45.652Z', '2026-04-07T06:13:45.652Z', '{"source":"observer","flush_batch":{"batch_id":18503}}', 'k3');
			`);
		} finally {
			db.close();
		}

		const result = getSessionExtractionEval(dbPath, {
			batchId: 18503,
			scenarioId: "rich-session-under-extraction",
		});

		expect(result.target).toEqual({ type: "batch", sessionId: 166405, batchId: 18503 });
		expect(result.counts.summaries).toBe(1);
		expect(result.counts.observations).toBe(2);
		expect(result.pass).toBe(true);
	});
});
