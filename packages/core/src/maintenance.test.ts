import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	backfillTagsText,
	deactivateLowSignalMemories,
	deactivateLowSignalObservations,
	getMemoryRoleReport,
	getRawEventRelinkPlan,
	getRawEventRelinkReport,
	getRawEventStatus,
	getReliabilityMetrics,
	initDatabase,
	retryRawEventFailures,
	vacuumDatabase,
} from "./maintenance.js";
import { initTestSchema } from "./test-utils.js";

function createDbPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-maintenance-"));
	return join(dir, `${name}.sqlite`);
}

function seedMaintenanceDb(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		initTestSchema(db);
		db.exec(`
			INSERT INTO sessions(id, started_at, cwd, project, user, tool_version) VALUES
			  (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
			INSERT INTO raw_event_sessions(
				source, stream_id, opencode_session_id, cwd, project, started_at,
				last_seen_ts_wall_ms, last_received_event_seq, last_flushed_event_seq, updated_at
			) VALUES (
				'opencode', 'sess-1', 'sess-1', '/tmp/repo', 'codemem', '2026-03-01T10:00:00Z',
				1000, 4, 1, '2026-03-01T10:10:00Z'
			);
			INSERT INTO raw_events(source, stream_id, opencode_session_id, event_id, event_seq, event_type, ts_wall_ms, payload_json, created_at) VALUES
			  ('opencode', 'sess-1', 'sess-1', 'e1', 1, 'tool.execute.after', 1000, '{}', '2026-03-01T10:00:01Z'),
			  ('opencode', 'sess-1', 'sess-1', 'e2', 2, 'tool.execute.after', 1001, '{}', '2026-03-01T10:00:02Z'),
			  ('opencode', 'sess-1', 'sess-1', 'e3', 3, 'tool.execute.after', 1002, '{}', '2026-03-01T10:00:03Z'),
			  ('opencode', 'sess-1', 'sess-1', 'e4', 4, 'tool.execute.after', 1003, '{}', '2026-03-01T10:00:04Z');
			INSERT INTO raw_event_flush_batches(
				source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
				extractor_version, status, error_message, updated_at, created_at
			) VALUES (
				'opencode', 'sess-1', 'sess-1', 2, 4,
				'raw_events_v1', 'failed', 'boom', '2026-03-01T10:10:00Z', '2026-03-01T10:05:00Z'
			);
		`);
	} finally {
		db.close();
	}
}

describe("maintenance", () => {
	it("returns raw event backlog status", () => {
		const dbPath = createDbPath("status");
		seedMaintenanceDb(dbPath);

		const result = getRawEventStatus(dbPath, 10);

		expect(result.totals).toEqual({ pending: 3, sessions: 1 });
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.session_stream_id).toBe("sess-1");
		expect(result.items[0]?.project).toBe("codemem");
	});

	it("requeues failed raw event batches", () => {
		const dbPath = createDbPath("retry");
		seedMaintenanceDb(dbPath);

		const result = retryRawEventFailures(dbPath, 10);
		expect(result.retried).toBe(1);

		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db
				.prepare("SELECT status, error_message FROM raw_event_flush_batches LIMIT 1")
				.get() as {
				status: string;
				error_message: string | null;
			};
			expect(row).toEqual({ status: "pending", error_message: null });
		} finally {
			db.close();
		}
	});

	it("initializes and vacuums a schema-ready database", () => {
		const dbPath = createDbPath("init-vacuum");
		seedMaintenanceDb(dbPath);

		const init = initDatabase(dbPath);
		expect(init.path).toBe(dbPath);
		expect(init.sizeBytes).toBeGreaterThan(0);

		const vacuum = vacuumDatabase(dbPath);
		expect(vacuum.path).toBe(dbPath);
		expect(vacuum.sizeBytes).toBeGreaterThan(0);
	});

	it("initializes a fresh database schema", () => {
		const dbPath = createDbPath("fresh-init");

		const init = initDatabase(dbPath);
		expect(init.path).toBe(dbPath);
		expect(init.sizeBytes).toBeGreaterThan(0);

		const db = new Database(dbPath, { readonly: true });
		try {
			expect(() => db.prepare("SELECT 1 FROM memory_items LIMIT 1").get()).not.toThrow();
			expect(() => db.prepare("SELECT 1 FROM sessions LIMIT 1").get()).not.toThrow();
			expect(db.pragma("user_version", { simple: true })).toBeGreaterThan(0);
		} finally {
			db.close();
		}
	});

	it("reports max retry depth from raw_event_flush_batches.attempt_count", () => {
		const dbPath = createDbPath("retry-depth");
		seedMaintenanceDb(dbPath);

		const db = new Database(dbPath);
		try {
			db.prepare("UPDATE raw_event_flush_batches SET attempt_count = ? WHERE id = 1").run(4);
			db.prepare(
				`INSERT INTO raw_event_flush_batches(
					source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
					extractor_version, status, updated_at, created_at, attempt_count
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"opencode",
				"sess-2",
				"sess-2",
				1,
				1,
				"raw_events_v1",
				"completed",
				"2026-03-01T11:00:00Z",
				"2026-03-01T10:59:00Z",
				2,
			);
		} finally {
			db.close();
		}

		const metrics = getReliabilityMetrics(dbPath);
		expect(metrics.counts.retry_depth_max).toBe(3);
	});

	it("backfills tags_text for memories with empty tags", () => {
		const dbPath = createDbPath("backfill-tags");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, tags_text, active,
					created_at, updated_at, concepts, files_modified, import_key
				) VALUES
					(1, 1, 'feature', 'Auth login flow', 'body', '', 1,
					 '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', '["authentication"]', '["src/auth/login.ts"]', 'k1');
			`);
		} finally {
			db.close();
		}

		const dbRw = new Database(dbPath);
		try {
			const result = backfillTagsText(dbRw, {});
			expect(result).toEqual({ checked: 1, updated: 1, skipped: 0 });

			const row = dbRw.prepare("SELECT tags_text FROM memory_items WHERE id = 1").get() as {
				tags_text: string;
			};
			expect(row.tags_text).toContain("feature");
			expect(row.tags_text).toContain("authentication");
			expect(row.tags_text).toContain("login-ts");
		} finally {
			dbRw.close();
		}
	});

	it("supports backfill-tags dry-run mode", () => {
		const dbPath = createDbPath("backfill-tags-dry-run");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, tags_text, active,
					created_at, updated_at, import_key
				) VALUES
					(1, 1, 'feature', 'Needs tags', 'body', '', 1,
					 '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 'k1');
			`);

			const result = backfillTagsText(db, { dryRun: true });
			expect(result).toEqual({ checked: 1, updated: 1, skipped: 0 });

			const row = db.prepare("SELECT tags_text FROM memory_items WHERE id = 1").get() as {
				tags_text: string;
			};
			expect(row.tags_text).toBe("");
		} finally {
			db.close();
		}
	});

	it("deactivates low-signal observations only", () => {
		const dbPath = createDbPath("prune-observations");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, import_key
				) VALUES
					(1, 1, 'observation', 'Low signal', 'No code changes were made', 1, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 'k1'),
					(2, 1, 'observation', 'High signal', 'Implemented a retry guard', 1, '2026-03-01T10:00:01Z', '2026-03-01T10:00:01Z', 'k2');
			`);

			const result = deactivateLowSignalObservations(db);
			expect(result).toEqual({ checked: 2, deactivated: 1 });

			const rows = db.prepare("SELECT id, active FROM memory_items ORDER BY id").all() as Array<{
				id: number;
				active: number;
			}>;
			expect(rows).toEqual([
				{ id: 1, active: 0 },
				{ id: 2, active: 1 },
			]);
		} finally {
			db.close();
		}
	});

	it("supports prune-memories dry-run mode", () => {
		const dbPath = createDbPath("prune-memories-dry-run");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, import_key
				) VALUES
					(1, 1, 'change', 'Low signal', 'No code changes were made', 1, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 'k1');
			`);

			const result = deactivateLowSignalMemories(db, {
				kinds: ["change"],
				dryRun: true,
			});
			expect(result).toEqual({ checked: 1, deactivated: 1 });

			const row = db.prepare("SELECT active FROM memory_items WHERE id = 1").get() as {
				active: number;
			};
			expect(row.active).toBe(1);
		} finally {
			db.close();
		}
	});

	it("reports inferred memory roles and summary lineages", () => {
		const dbPath = createDbPath("memory-role-report");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test'),
				  (2, '2026-03-01T10:20:00Z', '2026-03-01T10:20:20Z', '/tmp/repo', '', 'adam', 'test');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 1, 'session_summary', 'Session recap', 'Summary body', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{}', 'k1'),
				  (2, 1, 'decision', 'OAuth callback fix', 'Durable auth decision', 1, '2026-03-01T10:10:01Z', '2026-03-01T10:10:01Z', '{}', 'k2'),
				  (3, 2, 'change', 'Legacy recap', '## Request\nfoo\n\n## Completed\nbar', 1, '2026-03-01T10:20:20Z', '2026-03-01T10:20:20Z', '{"is_summary":true}', 'k3'),
				  (4, 2, 'change', 'Micro change', 'small procedural update', 1, '2026-03-01T10:20:21Z', '2026-03-01T10:20:21Z', '{}', 'k4');
				INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
				  ('opencode', 'ses-1', 'ses-1', 1, '2026-03-01T10:00:00Z');
			`);
		} finally {
			db.close();
		}

		const report = getMemoryRoleReport(dbPath, {});

		expect(report.totals.memories).toBe(4);
		expect(report.counts_by_kind.session_summary).toBe(1);
		expect(report.counts_by_kind.change).toBe(2);
		expect(report.summary_lineages).toEqual({
			session_summary: 1,
			legacy_metadata_summary: 1,
		});
		expect(report.counts_by_mapping).toEqual({ mapped: 2, unmapped: 2 });
		expect(report.summary_mapping).toEqual({ mapped: 1, unmapped: 1 });
		expect(report.counts_by_role.recap).toBe(2);
		expect(report.counts_by_role.durable).toBe(1);
		expect(report.counts_by_role.ephemeral).toBe(1);
		expect(report.project_quality.empty).toBe(2);
		expect(report.role_examples.recap?.map((item) => item.id)).toEqual([1, 3]);
		expect(report.role_examples.recap?.[0]?.role_reason).toBe("session_summary_kind");
		expect(report.session_duration_buckets["5-30m"]).toBe(1);
		expect(report.session_duration_buckets["<1m"]).toBe(1);
	});

	it("tolerates malformed metadata JSON in role reports", () => {
		const dbPath = createDbPath("memory-role-report-malformed-metadata");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
				INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
				  ('opencode', 'ses-1', 'ses-1', 1, '2026-03-01T10:00:00Z');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 1, 'change', 'Broken metadata row', 'Still should not crash the report', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{not-json', 'k1');
			`);
		} finally {
			db.close();
		}

		const report = getMemoryRoleReport(dbPath, {});

		expect(report.totals.memories).toBe(1);
		expect(report.counts_by_role.ephemeral).toBe(1);
	});

	it("supports probe queries in memory role reports", () => {
		const dbPath = createDbPath("memory-role-report-probes");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
				INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
				  ('opencode', 'ses-1', 'ses-1', 1, '2026-03-01T10:00:00Z');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 1, 'session_summary', 'Session recap', 'Summary body', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{}', 'k1'),
				  (2, 1, 'decision', 'OAuth callback fix', 'Patched callback validation', 1, '2026-03-01T10:10:01Z', '2026-03-01T10:10:01Z', '{}', 'k2');
			`);
		} finally {
			db.close();
		}

		const report = getMemoryRoleReport(dbPath, { probes: ["oauth callback"] });

		expect(report.probe_results).toHaveLength(1);
		expect(report.probe_results[0]?.query).toBe("oauth callback");
		expect(report.probe_results[0]?.top_role_counts).toEqual({
			recap: 1,
			durable: 1,
			ephemeral: 0,
			general: 0,
		});
		expect(report.probe_results[0]?.top_mapping_counts).toEqual({ mapped: 2, unmapped: 0 });
		expect(report.probe_results[0]?.top_burden).toEqual({
			recap_share: 0.5,
			unmapped_share: 0,
			recap_unmapped_share: 0,
		});
		expect(report.probe_results[0]?.simulated_demoted_unmapped_recap?.top_burden).toEqual({
			recap_share: 0.5,
			unmapped_share: 0,
			recap_unmapped_share: 0,
		});
		expect(
			report.probe_results[0]?.simulated_demoted_unmapped_recap_and_ephemeral?.top_burden,
		).toEqual({
			recap_share: 0.5,
			unmapped_share: 0,
			recap_unmapped_share: 0,
		});
		expect(report.probe_results[0]?.simulated_relinked_mapping?.top_burden).toEqual({
			recap_share: 0.5,
			unmapped_share: 0,
			recap_unmapped_share: 0,
		});
		expect(report.probe_results[0]?.items[0]).toEqual(
			expect.objectContaining({
				kind: "decision",
				mapping: "mapped",
				relinkable: false,
				role: "durable",
				role_reason: "durable_kind",
				title: "OAuth callback fix",
			}),
		);
	});

	it("reports relinkable raw-event session groups", () => {
		const dbPath = createDbPath("raw-event-relink-report");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"flusher":"raw_events","streamId":"ses-1"}}'),
				  (2, '2026-03-01T10:12:00Z', '2026-03-01T10:13:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"flusher":"raw_events","streamId":"ses-1"}}'),
				  (3, '2026-03-01T10:20:00Z', '2026-03-01T10:21:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"flusher":"raw_events","streamId":"ses-2"}}');
				INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
				  ('opencode', 'ses-1', 'ses-1', 1, '2026-03-01T10:00:00Z');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 1, 'session_summary', 'Summary 1', 'body', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{}', 'k1'),
				  (2, 2, 'decision', 'Decision 2', 'body', 1, '2026-03-01T10:13:00Z', '2026-03-01T10:13:00Z', '{}', 'k2'),
				  (3, 3, 'change', 'Change 3', 'body', 1, '2026-03-01T10:21:00Z', '2026-03-01T10:21:00Z', '{}', 'k3');
			`);
		} finally {
			db.close();
		}

		const report = getRawEventRelinkReport(dbPath, { limit: 10 });

		expect(report.totals.recoverable_sessions).toBe(3);
		expect(report.totals.distinct_stable_ids).toBe(2);
		expect(report.totals.groups_with_multiple_sessions).toBe(1);
		expect(report.totals.groups_with_mapped_session).toBe(1);
		expect(report.totals.groups_without_mapped_session).toBe(1);
		expect(report.totals.eligible_groups).toBe(2);
		expect(report.totals.ineligible_groups).toBe(0);
		expect(report.totals.active_memories).toBe(3);
		expect(report.totals.repointable_active_memories).toBe(1);
		expect(report.groups[0]).toEqual(
			expect.objectContaining({
				stable_id: "ses-1",
				local_sessions: 2,
				mapped_sessions: 1,
				unmapped_sessions: 1,
				eligible: true,
				blockers: [],
				canonical_session_id: 1,
				canonical_reason: "existing_mapped_session",
				would_create_bridge: false,
				sessions_to_compact: 1,
				repointable_active_memories: 1,
			}),
		);
		expect(report.groups[0]?.sample_session_ids.sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("emits dry-run relink actions from relinkable groups", () => {
		const dbPath = createDbPath("raw-event-relink-plan");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"flusher":"raw_events","streamId":"ses-1"}}'),
				  (2, '2026-03-01T10:12:00Z', '2026-03-01T10:13:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"flusher":"raw_events","streamId":"ses-1"}}');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 1, 'session_summary', 'Summary 1', 'body', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{}', 'k1'),
				  (2, 2, 'decision', 'Decision 2', 'body', 1, '2026-03-01T10:13:00Z', '2026-03-01T10:13:00Z', '{}', 'k2');
			`);
		} finally {
			db.close();
		}

		const plan = getRawEventRelinkPlan(dbPath, { limit: 10 });

		expect(plan.totals.groups).toBe(1);
		expect(plan.totals.eligible_groups).toBe(1);
		expect(plan.totals.skipped_groups).toBe(0);
		expect(plan.totals.bridge_creations).toBe(1);
		expect(plan.totals.memory_repoints).toBe(1);
		expect(plan.totals.session_compactions).toBe(1);
		expect(plan.actions[1]?.session_ids).toEqual([2]);
		expect(plan.skipped_groups).toEqual([]);
		expect(plan.actions).toEqual([
			expect.objectContaining({
				action: "create_bridge",
				stable_id: "ses-1",
				canonical_session_id: 1,
				reason: "oldest_unmapped_session",
			}),
			expect.objectContaining({
				action: "repoint_memories",
				stable_id: "ses-1",
				canonical_session_id: 1,
				memory_count: 1,
			}),
			expect.objectContaining({
				action: "compact_sessions",
				stable_id: "ses-1",
				canonical_session_id: 1,
			}),
		]);
	});
});
