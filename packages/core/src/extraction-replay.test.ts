import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { replayBatchExtraction } from "./extraction-replay.js";
import { initTestSchema } from "./test-utils.js";

function createDbPath(name: string): string {
	return `/tmp/codemem-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
}

describe("extraction replay", () => {
	it("replays a historical batch through the current observer prompt without persisting", async () => {
		const dbPath = createDbPath("extraction-replay");
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
				INSERT INTO raw_events(id, source, stream_id, opencode_session_id, event_id, event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, created_at) VALUES
				  (1, 'opencode', 'ses-1', 'ses-1', 'evt-1', 1204, 'user_prompt', 1000, 1, '{"type":"user_prompt","prompt_text":"Investigate qd7h, prep 0.23.0, and reframe Track 3 around injection-first quality"}', '2026-04-07T06:13:45.600Z'),
				  (2, 'opencode', 'ses-1', 'ses-1', 'evt-2', 1205, 'assistant_message', 1010, 2, '{"type":"assistant_message","assistant_text":"We should close qd7h, cover release readiness, and capture graph future direction."}', '2026-04-07T06:13:45.610Z'),
				  (3, 'opencode', 'ses-1', 'ses-1', 'evt-3', 1206, 'tool.execute.after', 1020, 3, '{"type":"tool.execute.after","tool":"read","args":{"filePath":"docs/plans/2026-04-07-track-3-injection-first-memory-policy.md"},"output":"ok"}', '2026-04-07T06:13:45.620Z');
			`);
		} finally {
			db.close();
		}

		const observer = {
			observe: async () => {
				callCount += 1;
				if (callCount === 1) {
					return {
						raw: `<summary>
						  <request>Investigate qd7h, prep 0.23.0, and reframe Track 3 around injection-first quality.</request>
						  <investigated>Reviewed the policy plan and discussed qd7h closure, release readiness, and graph future direction.</investigated>
						  <learned>qd7h could be closed and Track 3 needed reframing.</learned>
						  <completed>Started the investigation and captured a broad summary only.</completed>
						  <next_steps>Add durable observations for the missing subthreads.</next_steps>
						  <notes>This intentionally under-extracts to trigger the repair pass.</notes>
						  <files_read><file>docs/plans/2026-04-07-track-3-injection-first-memory-policy.md</file></files_read>
						  <files_modified></files_modified>
						</summary>`,
						parsed: null,
						provider: "test",
						model: "test-model",
					};
				}
				return {
					raw: `<observation>
				  <type>decision</type>
				  <title>Track 3 reframed around injection-first quality for 0.23.0 release readiness</title>
				  <subtitle>Track 3 now targets rediscovery reduction.</subtitle>
				  <facts><fact>Track 3 was reframed around injection-first quality and rediscovery reduction for 0.23.0 release readiness.</fact></facts>
				  <narrative>Track 3 was reframed to focus on injection-first quality while 0.23.0 release readiness was discussed as a near-term product pressure.</narrative>
				  <concepts><concept>decision</concept></concepts>
				  <files_read><file>docs/plans/2026-04-07-track-3-injection-first-memory-policy.md</file></files_read>
				  <files_modified></files_modified>
				</observation>
				<observation>
				  <type>exploration</type>
				  <title>qd7h closure and graph direction captured as future work</title>
				  <subtitle>Graph relationship retrieval stayed exploratory.</subtitle>
				  <facts><fact>qd7h was closed after the root cause had already been identified, and graph progressive disclosure remained future-direction work.</fact></facts>
				  <narrative>Graph and progressive disclosure ideas were captured as future work while qd7h closure confirmed the regression thread could be wrapped up.</narrative>
				  <concepts><concept>exploration</concept></concepts>
				  <files_read></files_read>
				  <files_modified></files_modified>
				</observation>
				<summary>
				  <request>Investigate qd7h, prep 0.23.0, and reframe Track 3 around injection-first quality.</request>
				  <investigated>Reviewed the policy plan and discussed qd7h closure, release readiness, and graph future direction.</investigated>
				  <learned>qd7h could be closed, 0.23.0 readiness mattered, and graph work should remain future-facing.</learned>
				  <completed>Reframed Track 3 around injection-first quality and captured graph direction as future work.</completed>
				  <next_steps>Continue quality tuning and finish release readiness.</next_steps>
				  <notes>Keep the summary broad across the major subthreads.</notes>
				  <files_read><file>docs/plans/2026-04-07-track-3-injection-first-memory-policy.md</file></files_read>
				  <files_modified></files_modified>
				</summary>`,
					parsed: null,
					provider: "test",
					model: "test-model",
				};
			},
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		} as any;
		let callCount = 0;

		const result = await replayBatchExtraction(dbPath, observer, {
			batchId: 18503,
			scenarioId: "rich-session-under-extraction",
		});

		expect(result.target).toEqual({ batchId: 18503, sessionId: 166405 });
		expect(result.classification.status).toBe("pass");
		expect(result.evaluation.target).toEqual({ type: "batch", sessionId: 166405, batchId: 18503 });
		expect(result.evaluation.counts.summaries).toBe(1);
		expect(result.evaluation.counts.observations).toBe(2);
		expect(result.observer.provider).toBe("test");
		expect(result.observer.repairApplied).toBe(true);
		expect(callCount).toBe(2);
		expect(result.observerContext.userPrompt).toContain("Track 3");
		expect(result.evaluation.coverage.totalThreadCoverage).toBeGreaterThanOrEqual(3);
		expect(result.evaluation.pass).toBe(true);
	});

	it("ignores replay observations with unsupported memory kinds", async () => {
		const dbPath = createDbPath("extraction-replay-invalid-kind");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (200001, '2026-04-06T21:23:59.631Z', '2026-04-07T06:13:45.667Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"post":{"session_class":"durable","summary_disposition":"stored"}}');
				INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
				  ('opencode', 'ses-2', 'ses-2', 200001, '2026-04-06T21:23:59.631Z');
				INSERT INTO raw_event_flush_batches(id, source, stream_id, opencode_session_id, start_event_seq, end_event_seq, extractor_version, status, attempt_count, created_at, updated_at) VALUES
				  (19001, 'opencode', 'ses-2', 'ses-2', 1, 20, 'raw_events_v1', 'completed', 1, '2026-04-07T06:13:45.600Z', '2026-04-07T06:13:45.700Z');
				INSERT INTO raw_events(id, source, stream_id, opencode_session_id, event_id, event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, created_at) VALUES
				  (1, 'opencode', 'ses-2', 'ses-2', 'evt-1', 1, 'user_prompt', 1000, 1, '{"type":"user_prompt","prompt_text":"Summarize a rich session"}', '2026-04-07T06:13:45.600Z');
			`);
		} finally {
			db.close();
		}

		const observer = {
			observe: async () => ({
				raw: `<observation>
				  <type>foo</type>
				  <title>Unsupported observation kind</title>
				  <subtitle>Should be discarded.</subtitle>
				  <facts><fact>Not a valid stored kind.</fact></facts>
				  <narrative>This should never count toward replay observation totals.</narrative>
				  <concepts><concept>invalid</concept></concepts>
				  <files_read></files_read>
				  <files_modified></files_modified>
				</observation>
				<summary>
				  <request>Summarize a rich session.</request>
				  <completed>Returned an invalid observation kind.</completed>
				  <notes>This should still count only as a summary.</notes>
				  <files_read></files_read>
				  <files_modified></files_modified>
				</summary>`,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		} as any;

		const result = await replayBatchExtraction(dbPath, observer, {
			batchId: 19001,
			scenarioId: "rich-batch-shape",
		});

		expect(result.evaluation.counts.summaries).toBe(1);
		expect(result.evaluation.counts.observations).toBe(0);
		expect(result.classification.status).toBe("shape_fail");
	});
});
