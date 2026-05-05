import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	aiBackfillStructuredContent,
	applyRawEventRelinkPlan,
	backfillMemoryDedupKeys,
	backfillNarrativeFromBody,
	backfillTagsText,
	compareMemoryRoleReports,
	deactivateLowSignalMemories,
	deactivateLowSignalObservations,
	dedupNearDuplicateMemories,
	extractNarrativeFromBody,
	getMemoryRoleReport,
	getRawEventRelinkPlan,
	getRawEventRelinkReport,
	getRawEventStatus,
	getReliabilityMetrics,
	initDatabase,
	retryRawEventFailures,
	scanSecretsRetroactive,
	vacuumDatabase,
} from "./maintenance.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
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

// CI occasionally times out these filesystem-heavy sqlite tests on shared
// runners (mkdtempSync + better-sqlite3 writes + WAL sync). Bump the suite
// timeout so ordinary slow-disk conditions don't read as failures.
describe("maintenance", { timeout: 15_000 }, () => {
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

	it("does not initialize unrelated non-empty SQLite databases", () => {
		const dbPath = createDbPath("unrelated-init");
		const unrelated = new Database(dbPath);
		unrelated.exec("CREATE TABLE unrelated_data (id INTEGER PRIMARY KEY)");
		unrelated.close();

		expect(() => initDatabase(dbPath)).toThrow(/Refusing to initialize .*non-codemem schema/);

		const db = new Database(dbPath, { readonly: true });
		try {
			expect(() => db.prepare("SELECT 1 FROM memory_items LIMIT 1").get()).toThrow();
			expect(() => db.prepare("SELECT 1 FROM unrelated_data LIMIT 1").get()).not.toThrow();
			expect(db.pragma("user_version", { simple: true })).toBe(0);
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
						id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key, scope_id
					) VALUES
					  (1, 1, 'session_summary', 'Session recap', 'Summary body', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{}', 'k1', 'local-default'),
					  (2, 1, 'decision', 'OAuth callback fix', 'Patched callback validation', 1, '2026-03-01T10:10:01Z', '2026-03-01T10:10:01Z', '{}', 'k2', 'local-default');
				`);
		} finally {
			db.close();
		}

		const report = getMemoryRoleReport(dbPath, {
			probes: ["what did we decide last time about oauth"],
		});

		expect(report.probe_results).toHaveLength(1);
		expect(report.probe_results[0]?.query).toBe("what did we decide last time about oauth");
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
		expect(report.probe_results[0]?.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "decision",
					mapping: "mapped",
					role: "durable",
					role_reason: "durable_kind",
					title: "OAuth callback fix",
					session_class: "unknown",
					summary_disposition: "unknown",
				}),
			]),
		);
		expect(report.probe_results[0]).toEqual(
			expect.objectContaining({
				scenario_id: "oauth-recurrence",
				scenario_category: "troubleshooting",
				scenario_score: expect.objectContaining({
					primary_match_count: expect.any(Number),
					anti_signal_count: expect.any(Number),
					recap_count: expect.any(Number),
					unmapped_recap_count: expect.any(Number),
					administrative_chatter_count: expect.any(Number),
					score: expect.any(Number),
				}),
			}),
		);
		expect(report.session_class_buckets).toEqual({ unknown: 1 });
		expect(report.summary_disposition_buckets).toEqual({ unknown: 1 });
	});

	it("reports persisted session policy buckets from session metadata", () => {
		const dbPath = createDbPath("memory-role-session-policy-buckets");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:00:20Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"post":{"session_class":"micro_low_value","summary_disposition":"suppressed"}}'),
				  (2, '2026-03-01T10:30:00Z', '2026-03-01T10:40:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"post":{"session_class":"durable","summary_disposition":"stored"}}');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 1, 'decision', 'Micro decision', 'body', 1, '2026-03-01T10:00:20Z', '2026-03-01T10:00:20Z', '{}', 'k1'),
				  (2, 2, 'session_summary', 'Durable summary', 'body', 1, '2026-03-01T10:40:00Z', '2026-03-01T10:40:00Z', '{}', 'k2');
			`);
		} finally {
			db.close();
		}

		const report = getMemoryRoleReport(dbPath, { project: "codemem" });
		expect(report.session_class_buckets).toEqual({ micro_low_value: 1, durable: 1 });
		expect(report.summary_disposition_buckets).toEqual({ suppressed: 1, stored: 1 });
	});

	it("compares memory role reports across two database snapshots", () => {
		const baselinePath = createDbPath("memory-role-compare-baseline");
		const candidatePath = createDbPath("memory-role-compare-candidate");
		for (const dbPath of [baselinePath, candidatePath]) {
			const db = new Database(dbPath);
			try {
				initTestSchema(db);
			} finally {
				db.close();
			}
		}

		const baselineDb = new Database(baselinePath);
		try {
			baselineDb.exec(`
					INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version) VALUES
					  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test'),
					  (2, '2026-03-01T10:20:00Z', '2026-03-01T10:20:20Z', '/tmp/repo', 'codemem', 'adam', 'test');
					INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
					  ('opencode', 'ses-1', 'ses-1', 1, '2026-03-01T10:00:00Z');
					INSERT INTO memory_items(
						id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key, scope_id
					) VALUES
					  (1, 1, 'session_summary', 'Session recap', 'Summary body', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{}', 'k1', 'local-default'),
					  (2, 2, 'change', 'Legacy recap', '## Request\nfoo\n\n## Completed\nbar', 1, '2026-03-01T10:20:20Z', '2026-03-01T10:20:20Z', '{"is_summary":true}', 'k2', 'local-default'),
					  (3, 2, 'decision', 'OAuth callback fix', 'Patched callback validation', 1, '2026-03-01T10:20:21Z', '2026-03-01T10:20:21Z', '{}', 'k3', 'local-default');
				`);
		} finally {
			baselineDb.close();
		}

		const candidateDb = new Database(candidatePath);
		try {
			candidateDb.exec(`
					INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version) VALUES
					  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
					INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
					  ('opencode', 'ses-1', 'ses-1', 1, '2026-03-01T10:00:00Z');
					INSERT INTO memory_items(
						id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key, scope_id
					) VALUES
					  (20, 1, 'decision', 'OAuth callback fix', 'Patched callback validation', 1, '2026-03-01T10:20:21Z', '2026-03-01T10:20:21Z', '{}', 'k3', 'local-default'),
					  (21, 1, 'session_summary', 'Session recap', 'Summary body', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{}', 'k1', 'local-default');
				`);
		} finally {
			candidateDb.close();
		}

		const comparison = compareMemoryRoleReports(baselinePath, candidatePath, {
			project: "codemem",
			probes: ["oauth callback"],
		});

		expect(comparison.delta.totals.sessions).toBe(-1);
		expect(comparison.delta.counts_by_mapping).toEqual({ mapped: 1, unmapped: -2 });
		expect(comparison.delta.summary_mapping).toEqual({ mapped: 0, unmapped: -1 });
		expect(comparison.probe_comparisons).toHaveLength(1);
		expect(comparison.probe_comparisons[0]).toEqual(
			expect.objectContaining({
				query: "oauth callback",
				baseline_item_ids: [3, 2],
				candidate_item_ids: [20, 21],
				shared_item_keys: ["import:k3"],
				delta_top_mapping_counts: { mapped: 2, unmapped: -2 },
				delta_top_burden: {
					recap_share: 0,
					unmapped_share: -1,
					recap_unmapped_share: -0.5,
				},
			}),
		);
		expect(comparison.probe_comparisons[0]).toEqual(
			expect.objectContaining({
				baseline_scenario_id: undefined,
				candidate_scenario_id: undefined,
				baseline_scenario_score: undefined,
				candidate_scenario_score: undefined,
				delta_scenario_score: undefined,
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
		expect(report.totals.active_memories).toBe(3);
		expect(report.totals.repointable_active_memories).toBe(1);
		expect(report.groups[0]).toEqual(
			expect.objectContaining({
				stable_id: "ses-1",
				local_sessions: 2,
				mapped_sessions: 1,
				unmapped_sessions: 1,
				source: "opencode",
				eligible: true,
				blockers: [],
				canonical_session_id: 1,
				repointable_active_memories: 1,
			}),
		);
	});

	it("ignores unrelated bridge rows when selecting mapped canonical sessions", () => {
		const dbPath = createDbPath("raw-event-relink-report-unrelated-bridge");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-1"}}'),
				  (2, '2026-03-01T10:12:00Z', '2026-03-01T10:13:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-1"}}'),
				  (3, '2026-03-01T10:14:00Z', '2026-03-01T10:15:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-other"}}');
				INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
				  ('opencode', 'ses-other', 'ses-other', 2, '2026-03-01T10:14:00Z');
			`);
		} finally {
			db.close();
		}

		const report = getRawEventRelinkReport(dbPath, { limit: 10 });
		const ses1Group = report.groups.find((group) => group.stable_id === "ses-1");

		expect(ses1Group).toEqual(
			expect.objectContaining({
				mapped_sessions: 0,
				unmapped_sessions: 2,
				canonical_session_id: 1,
				canonical_reason: "oldest_unmapped_session",
				would_create_bridge: true,
			}),
		);
	});

	it("separates relink groups by source even when stable ids match", () => {
		const dbPath = createDbPath("raw-event-relink-report-source-scope");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"source":"opencode","session_context":{"flusher":"raw_events","streamId":"ses-shared"}}'),
				  (2, '2026-03-01T10:12:00Z', '2026-03-01T10:13:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"source":"claude","session_context":{"flusher":"raw_events","streamId":"ses-shared"}}');
			`);
		} finally {
			db.close();
		}

		const report = getRawEventRelinkReport(dbPath, { limit: 10 });

		expect(report.totals.distinct_stable_ids).toBe(2);
		expect(report.groups.map((group) => `${group.source}:${group.stable_id}`).sort()).toEqual([
			"claude:ses-shared",
			"opencode:ses-shared",
		]);
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
		expect(plan.totals.bridge_creations).toBe(1);
		expect(plan.totals.memory_repoints).toBe(1);
		expect(plan.totals.session_compactions).toBe(1);
		expect(plan.actions[1]?.session_ids).toEqual([2]);
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

	it("applies raw-event relink remediation and compacts duplicate sessions", () => {
		const dbPath = createDbPath("raw-event-relink-apply");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"source":"plugin","session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-1"}}'),
				  (2, '2026-03-01T10:12:00Z', '2026-03-01T10:13:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"source":"plugin","session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-1"}}');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 1, 'session_summary', 'Summary 1', 'body', 1, '2026-03-01T10:10:00Z', '2026-03-01T10:10:00Z', '{}', 'k1'),
				  (2, 2, 'decision', 'Decision 2', 'body', 1, '2026-03-01T10:13:00Z', '2026-03-01T10:13:00Z', '{}', 'k2');
				INSERT INTO session_summaries(
					id, session_id, project, request, created_at, created_at_epoch, metadata_json, import_key
				) VALUES
				  (1, 2, 'codemem', 'repair me', '2026-03-01T10:13:00Z', 1740823980, '{}', 'summary-1');
				INSERT INTO user_prompts(
					id, session_id, project, prompt_text, created_at, created_at_epoch, metadata_json, import_key
				) VALUES
				  (1, 2, 'codemem', 'repair me', '2026-03-01T10:12:30Z', 1740823950, '{}', 'prompt-1');
			`);
		} finally {
			db.close();
		}

		const result = applyRawEventRelinkPlan(dbPath, { limit: 10 });

		expect(result.totals).toEqual({
			groups: 1,
			eligible_groups: 1,
			skipped_groups: 0,
			bridge_creations: 1,
			memory_repoints: 1,
			session_compactions: 1,
		});

		const verify = new Database(dbPath, { readonly: true });
		try {
			const sessions = verify.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{
				id: number;
			}>;
			expect(sessions).toEqual([{ id: 1 }]);

			const bridge = verify
				.prepare(
					"SELECT source, stream_id, session_id FROM opencode_sessions WHERE stream_id = 'ses-1'",
				)
				.get() as { source: string; stream_id: string; session_id: number };
			expect(bridge).toEqual({ source: "opencode", stream_id: "ses-1", session_id: 1 });

			const memorySessionIds = verify
				.prepare("SELECT id, session_id FROM memory_items ORDER BY id")
				.all() as Array<{ id: number; session_id: number }>;
			expect(memorySessionIds).toEqual([
				{ id: 1, session_id: 1 },
				{ id: 2, session_id: 1 },
			]);

			const sessionSummary = verify
				.prepare("SELECT session_id FROM session_summaries WHERE id = 1")
				.get() as { session_id: number };
			expect(sessionSummary.session_id).toBe(1);

			const userPrompt = verify
				.prepare("SELECT session_id FROM user_prompts WHERE id = 1")
				.get() as { session_id: number };
			expect(userPrompt.session_id).toBe(1);
		} finally {
			verify.close();
		}
	}, 15_000);

	it("runs raw-event relink remediation during initDatabase", () => {
		const dbPath = createDbPath("init-relink-apply");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-2"}}'),
				  (2, '2026-03-01T10:12:00Z', '2026-03-01T10:13:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-2"}}');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 2, 'decision', 'Decision 2', 'body', 1, '2026-03-01T10:13:00Z', '2026-03-01T10:13:00Z', '{}', 'k2');
			`);
		} finally {
			db.close();
		}

		initDatabase(dbPath);

		const verify = new Database(dbPath, { readonly: true });
		try {
			const sessions = verify.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{
				id: number;
			}>;
			expect(sessions).toEqual([{ id: 1 }]);

			const bridge = verify
				.prepare(
					"SELECT source, stream_id, session_id FROM opencode_sessions WHERE stream_id = 'ses-2'",
				)
				.get() as { source: string; stream_id: string; session_id: number };
			expect(bridge).toEqual({ source: "opencode", stream_id: "ses-2", session_id: 1 });

			const memory = verify.prepare("SELECT session_id FROM memory_items WHERE id = 1").get() as {
				session_id: number;
			};
			expect(memory.session_id).toBe(1);
		} finally {
			verify.close();
		}
	});

	it("is idempotent when raw-event relink remediation is applied twice", () => {
		const dbPath = createDbPath("raw-event-relink-apply-idempotent");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-3"}}'),
				  (2, '2026-03-01T10:12:00Z', '2026-03-01T10:13:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-3"}}');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 2, 'decision', 'Decision 3', 'body', 1, '2026-03-01T10:13:00Z', '2026-03-01T10:13:00Z', '{}', 'k3');
			`);
		} finally {
			db.close();
		}

		const first = applyRawEventRelinkPlan(dbPath, { limit: 10 });
		const second = applyRawEventRelinkPlan(dbPath, { limit: 10 });

		expect(first.totals.bridge_creations).toBe(1);
		expect(first.totals.memory_repoints).toBe(1);
		expect(first.totals.session_compactions).toBe(1);
		expect(second.totals.bridge_creations).toBe(0);
		expect(second.totals.memory_repoints).toBe(0);
		expect(second.totals.session_compactions).toBe(0);
	}, 15_000);

	it("blocks compaction when redundant sessions still carry other bridge rows", () => {
		const dbPath = createDbPath("raw-event-relink-foreign-bridge-blocker");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json) VALUES
				  (1, '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-4"}}'),
				  (2, '2026-03-01T10:12:00Z', '2026-03-01T10:13:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"session_context":{"source":"opencode","flusher":"raw_events","streamId":"ses-4"}}');
				INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES
				  ('opencode', 'other-stream', 'other-stream', 2, '2026-03-01T10:12:00Z');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key
				) VALUES
				  (1, 2, 'decision', 'Decision 4', 'body', 1, '2026-03-01T10:13:00Z', '2026-03-01T10:13:00Z', '{}', 'k4');
			`);
		} finally {
			db.close();
		}

		const report = getRawEventRelinkReport(dbPath, { limit: 10 });
		expect(report.groups[0]).toEqual(
			expect.objectContaining({
				stable_id: "ses-4",
				eligible: false,
				blockers: expect.arrayContaining(["out_of_group_bridge_rows"]),
			}),
		);

		const result = applyRawEventRelinkPlan(dbPath, { limit: 10 });
		expect(result.totals).toEqual({
			groups: 1,
			eligible_groups: 0,
			skipped_groups: 1,
			bridge_creations: 0,
			memory_repoints: 0,
			session_compactions: 0,
		});
		expect(result.skipped_groups).toEqual([
			{ stable_id: "ses-4", blockers: ["out_of_group_bridge_rows"] },
		]);

		const verify = new Database(dbPath, { readonly: true });
		try {
			const sessions = verify.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{
				id: number;
			}>;
			expect(sessions).toEqual([{ id: 1 }, { id: 2 }]);
			const bridgeRows = verify
				.prepare("SELECT source, stream_id, session_id FROM opencode_sessions ORDER BY stream_id")
				.all() as Array<{ source: string; stream_id: string; session_id: number }>;
			expect(bridgeRows).toEqual([
				{ source: "opencode", stream_id: "other-stream", session_id: 2 },
			]);
		} finally {
			verify.close();
		}
	}, 15_000);
});

// ---------------------------------------------------------------------------
// Retroactive near-duplicate deactivation
// ---------------------------------------------------------------------------

describe("dedupNearDuplicateMemories", () => {
	function seedMemory(
		db: Database,
		sessionId: number,
		title: string,
		confidence: number,
		createdAt: string,
	): number {
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'discovery', ?, 'body', ?, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, title, confidence, createdAt, createdAt);
		return Number(info.lastInsertRowid);
	}

	it("deactivates the lower-confidence duplicate within the time window", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const s1 = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const s2 = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:30:00Z", "test").lastInsertRowid,
			);
			const id1 = seedMemory(db, s1, "Sync orchestrator ported", 0.8, "2026-01-01T00:00:00Z");
			const id2 = seedMemory(db, s2, "Sync orchestrator ported", 0.5, "2026-01-01T00:30:00Z");

			const result = dedupNearDuplicateMemories(db);

			expect(result.deactivated).toBe(1);
			expect(result.pairs[0]).toMatchObject({ kept_id: id1, deactivated_id: id2 });
			const row = db.prepare("SELECT active FROM memory_items WHERE id = ?").get(id2) as {
				active: number;
			};
			const active = row.active;
			expect(active).toBe(0);
		} finally {
			db.close();
		}
	});

	it("does not deactivate pairs outside the time window", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const s1 = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const s2 = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T06:00:00Z", "test").lastInsertRowid,
			);
			seedMemory(db, s1, "Same title here", 0.8, "2026-01-01T00:00:00Z");
			seedMemory(db, s2, "Same title here", 0.5, "2026-01-01T06:00:00Z");

			const result = dedupNearDuplicateMemories(db, { windowMs: 3_600_000 });

			expect(result.deactivated).toBe(0);
		} finally {
			db.close();
		}
	});

	it("keeps the more recent memory on confidence tie", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const s1 = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const s2 = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:10:00Z", "test").lastInsertRowid,
			);
			const id1 = seedMemory(db, s1, "Equal confidence pair", 0.7, "2026-01-01T00:00:00Z");
			const id2 = seedMemory(db, s2, "Equal confidence pair", 0.7, "2026-01-01T00:10:00Z");

			const result = dedupNearDuplicateMemories(db);

			expect(result.deactivated).toBe(1);
			expect(result.pairs[0]).toMatchObject({ kept_id: id2, deactivated_id: id1 });
		} finally {
			db.close();
		}
	});

	it("respects dry-run mode", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const s1 = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const s2 = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:05:00Z", "test").lastInsertRowid,
			);
			const id2 = seedMemory(db, s1, "Dry run test", 0.5, "2026-01-01T00:00:00Z");
			seedMemory(db, s2, "Dry run test", 0.8, "2026-01-01T00:05:00Z");

			const result = dedupNearDuplicateMemories(db, { dryRun: true });

			expect(result.deactivated).toBe(1);
			const row = db.prepare("SELECT active FROM memory_items WHERE id = ?").get(id2) as {
				active: number;
			};
			const active = row.active;
			expect(active).toBe(1); // Not actually deactivated
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Heuristic narrative extraction
// ---------------------------------------------------------------------------

describe("extractNarrativeFromBody", () => {
	it("extracts Completed and Learned sections", () => {
		const body = `## Request
Do something important.

## Completed
Built the widget and integrated it.

## Learned
Widgets need careful alignment.`;

		const result = extractNarrativeFromBody(body);
		expect(result).toBe("Built the widget and integrated it.\n\nWidgets need careful alignment.");
	});

	it("extracts only Completed when Learned is absent", () => {
		const body = `## Request
Fix the bug.

## Completed
Fixed the null pointer in the parser.`;

		expect(extractNarrativeFromBody(body)).toBe("Fixed the null pointer in the parser.");
	});

	it("returns null when no structured sections exist", () => {
		expect(extractNarrativeFromBody("Just a plain body with no headers.")).toBeNull();
	});

	it("returns null for empty body", () => {
		expect(extractNarrativeFromBody("")).toBeNull();
	});
});

describe("backfillNarrativeFromBody", () => {
	function seedSummary(db: Database, sessionId: number, title: string, body: string): number {
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'session_summary', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, title, body, now, now);
		return Number(info.lastInsertRowid);
	}

	it("populates narrative from structured body_text", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedSummary(
				db,
				sessionId,
				"Summary title",
				"## Request\nDo stuff\n\n## Completed\nDid the stuff.\n\n## Learned\nStuff is easy.",
			);

			const result = backfillNarrativeFromBody(db);

			expect(result).toMatchObject({ checked: 1, updated: 1, skipped: 0 });
			const row = db.prepare("SELECT narrative FROM memory_items WHERE id = ?").get(id) as {
				narrative: string | null;
			};
			expect(row.narrative).toBe("Did the stuff.\n\nStuff is easy.");
		} finally {
			db.close();
		}
	});

	it("skips memories without structured sections", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			seedSummary(db, sessionId, "Plain summary", "Just a plain text body.");

			const result = backfillNarrativeFromBody(db);

			expect(result).toMatchObject({ checked: 1, updated: 0, skipped: 1 });
		} finally {
			db.close();
		}
	});

	it("does not overwrite existing narrative", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedSummary(
				db,
				sessionId,
				"Has narrative",
				"## Request\nStuff\n\n## Completed\nDone.",
			);
			db.prepare("UPDATE memory_items SET narrative = ? WHERE id = ?").run(
				"Existing narrative",
				id,
			);

			const result = backfillNarrativeFromBody(db);

			expect(result.checked).toBe(0); // Already has narrative, not selected
			const row = db.prepare("SELECT narrative FROM memory_items WHERE id = ?").get(id) as {
				narrative: string | null;
			};
			expect(row.narrative).toBe("Existing narrative");
		} finally {
			db.close();
		}
	});

	it("respects dry-run mode", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedSummary(
				db,
				sessionId,
				"Dry run narrative",
				"## Request\nDo\n\n## Completed\nDone.\n\n## Learned\nLearned stuff.",
			);

			const result = backfillNarrativeFromBody(db, { dryRun: true });

			expect(result).toMatchObject({ checked: 1, updated: 1, skipped: 0 });
			const row = db.prepare("SELECT narrative FROM memory_items WHERE id = ?").get(id) as {
				narrative: string | null;
			};
			expect(row.narrative).toBeNull(); // Not actually written
		} finally {
			db.close();
		}
	});
});

describe("backfillMemoryDedupKeys", () => {
	function seedMemoryWithoutDedupKey(
		db: Database,
		sessionId: number,
		title: string,
		dedupKey: string | null = null,
	): number {
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
				 workspace_id, dedup_key)
				 VALUES (?, 'discovery', ?, 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', 'shared:default', ?)`,
			)
			.run(sessionId, title, now, now, dedupKey);
		return Number(info.lastInsertRowid);
	}

	it("populates missing dedup_key values for legacy rows", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemoryWithoutDedupKey(db, sessionId, "PR #123 Sync pass orchestrator ported");

			const result = backfillMemoryDedupKeys(db);

			expect(result).toMatchObject({ checked: 1, updated: 1, skipped: 0 });
			const row = db.prepare("SELECT dedup_key FROM memory_items WHERE id = ?").get(id) as {
				dedup_key: string | null;
			};
			expect(row.dedup_key).toBeTruthy();
		} finally {
			db.close();
		}
	});

	it("uses a fallback key when normalization strips the title", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemoryWithoutDedupKey(db, sessionId, "PR #123");

			const result = backfillMemoryDedupKeys(db);

			expect(result).toMatchObject({ checked: 1, updated: 1, skipped: 0 });
			const row = db.prepare("SELECT dedup_key FROM memory_items WHERE id = ?").get(id) as {
				dedup_key: string | null;
			};
			expect(row.dedup_key).toBeTruthy();
		} finally {
			db.close();
		}
	});

	it("skips conflicting active legacy duplicates instead of aborting the backfill", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const idA = seedMemoryWithoutDedupKey(db, sessionId, "PR #88 duplicate title");
			const idB = seedMemoryWithoutDedupKey(db, sessionId, "PR #88 duplicate title");

			const result = backfillMemoryDedupKeys(db);

			expect(result).toMatchObject({ checked: 2, updated: 1, skipped: 1 });
			const rows = db
				.prepare("SELECT id, dedup_key FROM memory_items WHERE id IN (?, ?) ORDER BY id ASC")
				.all(idA, idB) as Array<{ id: number; dedup_key: string | null }>;
			expect(rows.filter((row) => row.dedup_key !== null)).toHaveLength(1);
			expect(rows.filter((row) => row.dedup_key === null)).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("does not overwrite existing dedup_key values", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemoryWithoutDedupKey(db, sessionId, "Existing key", "already-set");

			const result = backfillMemoryDedupKeys(db);

			expect(result).toMatchObject({ checked: 0, updated: 0, skipped: 0 });
			const row = db.prepare("SELECT dedup_key FROM memory_items WHERE id = ?").get(id) as {
				dedup_key: string | null;
			};
			expect(row.dedup_key).toBe("already-set");
		} finally {
			db.close();
		}
	});

	it("respects dry-run mode", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemoryWithoutDedupKey(db, sessionId, "Dry run title");

			const result = backfillMemoryDedupKeys(db, { dryRun: true });

			expect(result).toMatchObject({ checked: 1, updated: 1, skipped: 0 });
			const row = db.prepare("SELECT dedup_key FROM memory_items WHERE id = ?").get(id) as {
				dedup_key: string | null;
			};
			expect(row.dedup_key).toBeNull();
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// AI structured-content backfill
// ---------------------------------------------------------------------------

describe("aiBackfillStructuredContent", () => {
	function seedMemory(
		db: Database,
		sessionId: number,
		kind: string,
		title: string,
		body: string,
		narrative: string | null = null,
		facts: string | null = null,
		concepts: string | null = null,
	): number {
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
				 narrative, facts, concepts)
				 VALUES (?, ?, ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared', ?, ?, ?)`,
			)
			.run(sessionId, kind, title, body, now, now, narrative, facts, concepts);
		return Number(info.lastInsertRowid);
	}

	function makeObserver(raw: string) {
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			parsed = null;
		}
		return {
			observe: async () => ({ raw, parsed: null, provider: "openai", model: "gpt-5.4" }),
			observeStructuredJson: async () => ({
				raw,
				parsed,
				provider: "openai",
				model: "gpt-5.4",
				usedStructuredOutputs: true,
			}),
			getStatus: () => ({
				provider: "openai",
				model: "gpt-5.4",
				runtime: "responses_api",
				auth: { source: "test", type: "api_direct" as const, hasToken: true },
			}),
		};
	}

	it("fills missing structured fields from observer output", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemory(
				db,
				sessionId,
				"change",
				"Added new widget",
				"Implemented the widget and documented its behavior.",
			);

			const observer = makeObserver(
				JSON.stringify({
					narrative: "Implemented the new widget and documented its behavior.",
					facts: ["The widget was implemented", "Documentation was updated"],
					concepts: ["what-changed", "pattern"],
				}),
			);

			const result = await aiBackfillStructuredContent(db, { observer });

			expect(result).toMatchObject({ checked: 1, updated: 1, skipped: 0, failed: 0 });
			const row = db
				.prepare("SELECT narrative, facts, concepts FROM memory_items WHERE id = ?")
				.get(id) as { narrative: string | null; facts: string | null; concepts: string | null };
			expect(row.narrative).toBe("Implemented the new widget and documented its behavior.");
			expect(row.facts).toBe(
				JSON.stringify(["The widget was implemented", "Documentation was updated"]),
			);
			expect(row.concepts).toBe(JSON.stringify(["what-changed", "pattern"]));
		} finally {
			db.close();
		}
	});

	it("redacts secrets in AI-generated narrative, facts, and concepts before persisting", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemory(
				db,
				sessionId,
				"change",
				"Memory with secret-shaped AI output",
				"Original body.",
			);

			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const observer = makeObserver(
				JSON.stringify({
					narrative: `AI summary mentions ${pat} verbatim.`,
					facts: [`fact A references ${pat}`, "harmless fact"],
					concepts: ["what-changed"],
				}),
			);

			const result = await aiBackfillStructuredContent(db, { observer });
			expect(result).toMatchObject({ updated: 1 });

			const row = db.prepare("SELECT narrative, facts FROM memory_items WHERE id = ?").get(id) as {
				narrative: string | null;
				facts: string | null;
			};
			expect(row.narrative ?? "").not.toContain(pat);
			expect(row.narrative ?? "").toContain("[REDACTED:github_pat_classic]");
			expect(row.facts ?? "").not.toContain(pat);
			expect(row.facts ?? "").toContain("[REDACTED:github_pat_classic]");
		} finally {
			db.close();
		}
	});

	it("preserves existing structured fields by default", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemory(
				db,
				sessionId,
				"discovery",
				"Existing narrative",
				"Observed something useful.",
				"Already there",
				JSON.stringify(["Existing fact"]),
				null,
			);

			const observer = makeObserver(
				JSON.stringify({
					narrative: "New narrative",
					facts: ["New fact"],
					concepts: ["gotcha"],
				}),
			);

			const result = await aiBackfillStructuredContent(db, { observer });

			expect(result).toMatchObject({ checked: 1, updated: 1, skipped: 0, failed: 0 });
			const row = db
				.prepare("SELECT narrative, facts, concepts FROM memory_items WHERE id = ?")
				.get(id) as { narrative: string | null; facts: string | null; concepts: string | null };
			expect(row.narrative).toBe("Already there");
			expect(row.facts).toBe(JSON.stringify(["Existing fact"]));
			expect(row.concepts).toBe(JSON.stringify(["gotcha"]));
		} finally {
			db.close();
		}
	});

	it("overwrites existing fields when overwrite=true", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemory(
				db,
				sessionId,
				"bugfix",
				"Overwrite test",
				"Fixed a bug.",
				"Old narrative",
				JSON.stringify(["Old fact"]),
				JSON.stringify(["old-concept"]),
			);

			const observer = makeObserver(
				JSON.stringify({
					narrative: "New narrative.",
					facts: ["New fact"],
					concepts: ["problem-solution"],
				}),
			);

			await aiBackfillStructuredContent(db, { observer, overwrite: true });

			const row = db
				.prepare("SELECT narrative, facts, concepts FROM memory_items WHERE id = ?")
				.get(id) as { narrative: string | null; facts: string | null; concepts: string | null };
			expect(row.narrative).toBe("New narrative.");
			expect(row.facts).toBe(JSON.stringify(["New fact"]));
			expect(row.concepts).toBe(JSON.stringify(["problem-solution"]));
		} finally {
			db.close();
		}
	});

	it("counts invalid observer output as failed and completes the job", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			seedMemory(db, sessionId, "feature", "Bad JSON", "Body text");

			const observer = makeObserver("not json at all");
			const result = await aiBackfillStructuredContent(db, { observer });

			expect(result).toMatchObject({ checked: 1, updated: 0, skipped: 0, failed: 1 });
			const job = getMaintenanceJob(db, "ai_structured_backfill");
			expect(job).toMatchObject({
				status: "completed",
				progress: { current: 1, total: 1, unit: "items" },
			});
			expect(job?.metadata).toMatchObject({ failed: 1 });
		} finally {
			db.close();
		}
	});

	it("counts schema-invalid observer objects as failed instead of skipped", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			seedMemory(db, sessionId, "feature", "Schema invalid", "Body text");

			const observer = makeObserver(JSON.stringify({ foo: "bar" }));
			const result = await aiBackfillStructuredContent(db, { observer });

			expect(result).toMatchObject({ checked: 1, updated: 0, skipped: 0, failed: 1 });
		} finally {
			db.close();
		}
	});

	it("excludes summary-like legacy memories from AI backfill target set", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'change', 'Legacy recap', 'Summary body', 0.5, '', 1, ?, ?, ?, 1, 'shared')`,
			).run(sessionId, now, now, JSON.stringify({ is_summary: true, source: "observer_summary" }));

			const observer = makeObserver(
				JSON.stringify({
					narrative: "Should not be used.",
					facts: ["Fact"],
					concepts: ["what-changed"],
				}),
			);
			const result = await aiBackfillStructuredContent(db, { observer });

			expect(result).toMatchObject({ checked: 0, updated: 0, skipped: 0, failed: 0 });
		} finally {
			db.close();
		}
	});

	it("sanitizes truncated narratives and filters unsupported concepts", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemory(
				db,
				sessionId,
				"feature",
				"Truncation test",
				"Body text with enough context.",
			);

			const observer = makeObserver(
				JSON.stringify({
					narrative:
						"Useful first sentence. Another complete sentence. And then an incomplete trailing clause",
					facts: ["Concrete supported fact"],
					concepts: ["what-changed", "unsupported-concept", "gotcha"],
				}),
			);

			await aiBackfillStructuredContent(db, { observer, overwrite: true });

			const row = db
				.prepare("SELECT narrative, facts, concepts FROM memory_items WHERE id = ?")
				.get(id) as { narrative: string | null; facts: string | null; concepts: string | null };
			expect(row.narrative).toBe("Useful first sentence. Another complete sentence.");
			expect(row.concepts).toBe(JSON.stringify(["what-changed", "gotcha"]));
		} finally {
			db.close();
		}
	});

	it("respects dry-run mode", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const id = seedMemory(db, sessionId, "decision", "Dry run", "Decided a thing.");

			const observer = makeObserver(
				JSON.stringify({
					narrative: "Made a decision.",
					facts: ["Decision fact"],
					concepts: ["trade-off"],
				}),
			);

			const result = await aiBackfillStructuredContent(db, { observer, dryRun: true });

			expect(result).toMatchObject({ checked: 1, updated: 1, skipped: 0, failed: 0 });
			expect(result.samples).toHaveLength(1);
			expect(result.samples?.[0]).toMatchObject({
				id,
				kind: "decision",
				title: "Dry run",
				narrative: "Made a decision.",
				facts: ["Decision fact"],
				concepts: ["trade-off"],
			});
			const row = db
				.prepare("SELECT narrative, facts, concepts FROM memory_items WHERE id = ?")
				.get(id) as { narrative: string | null; facts: string | null; concepts: string | null };
			expect(row.narrative).toBeNull();
			expect(row.facts).toBeNull();
			expect(row.concepts).toBeNull();
		} finally {
			db.close();
		}
	});
});

describe("scanSecretsRetroactive", () => {
	function seedLegacyRow(
		db: Database,
		sessionId: number,
		title: string,
		body: string,
		extras: Partial<{
			subtitle: string;
			narrative: string;
			tags_text: string;
			facts: string;
			concepts: string;
			metadata_json: string;
		}> = {},
	): number {
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, subtitle, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
				 narrative, facts, concepts)
				 VALUES (?, ?, ?, ?, ?, 0.5, ?, 1, ?, ?, ?, 1, 'shared', ?, ?, ?)`,
			)
			.run(
				sessionId,
				"discovery",
				title,
				extras.subtitle ?? null,
				body,
				extras.tags_text ?? "",
				now,
				now,
				extras.metadata_json ?? "{}",
				extras.narrative ?? null,
				extras.facts ?? null,
				extras.concepts ?? null,
			);
		return Number(info.lastInsertRowid);
	}

	it("redacts legacy unredacted memories in place", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const awsId = "AKIAIOSFODNN7EXAMPLE";
			const id = seedLegacyRow(db, sessionId, `legacy ${pat}`, `body has ${awsId}`, {
				narrative: `narrative has ${pat}`,
				tags_text: `safe ${pat}`,
				facts: JSON.stringify([`fact has ${pat}`, "clean"]),
				metadata_json: JSON.stringify({ password: "supersecretvalue123", note: "fine" }),
			});

			const result = scanSecretsRetroactive(db);
			expect(result.checked).toBe(1);
			expect(result.updated).toBe(1);
			expect(result.detections.length).toBeGreaterThan(0);

			const row = db
				.prepare(
					"SELECT title, body_text, narrative, tags_text, facts, metadata_json FROM memory_items WHERE id = ?",
				)
				.get(id) as {
				title: string;
				body_text: string;
				narrative: string | null;
				tags_text: string | null;
				facts: string | null;
				metadata_json: string | null;
			};
			expect(row.title).not.toContain(pat);
			expect(row.title).toContain("[REDACTED:github_pat_classic]");
			expect(row.body_text).not.toContain(awsId);
			expect(row.narrative).not.toContain(pat);
			expect(row.tags_text ?? "").not.toContain(pat);
			expect(row.facts ?? "").not.toContain(pat);
			const meta = JSON.parse(row.metadata_json ?? "{}");
			expect(meta.password).toBe("[REDACTED:context_secret]");
			expect(meta.note).toBe("fine");
		} finally {
			db.close();
		}
	});

	it("is idempotent — second run reports zero updates", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			seedLegacyRow(db, sessionId, "legacy ghp_abcdefghijklmnopqrstuvwxyz0123456789", "clean body");
			const first = scanSecretsRetroactive(db);
			expect(first.updated).toBe(1);
			const second = scanSecretsRetroactive(db);
			expect(second.checked).toBeGreaterThan(0);
			expect(second.updated).toBe(0);
		} finally {
			db.close();
		}
	});

	it("dry-run reports detections without writing", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const id = seedLegacyRow(db, sessionId, `legacy ${pat}`, "clean body");
			const result = scanSecretsRetroactive(db, { dryRun: true });
			expect(result.updated).toBe(1);
			expect(result.detections.find((d) => d.kind === "github_pat_classic")?.count).toBe(1);
			const row = db.prepare("SELECT title FROM memory_items WHERE id = ?").get(id) as {
				title: string;
			};
			expect(row.title).toContain(pat);
		} finally {
			db.close();
		}
	});

	it("skips rows over the size cap and reports them", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			seedLegacyRow(db, sessionId, "huge", `${"x".repeat(200)}${pat}`);
			const result = scanSecretsRetroactive(db, { maxRowBytes: 100 });
			expect(result.skippedOversized).toBe(1);
			expect(result.updated).toBe(0);
		} finally {
			db.close();
		}
	});

	it("idempotent on dual-rule redactions (secret-context plus pattern match)", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			// "secret: ghp_..." triggers BOTH generic_assigned_secret and github_pat_classic.
			const id = seedLegacyRow(
				db,
				sessionId,
				"title",
				"secret: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			);
			const first = scanSecretsRetroactive(db);
			expect(first.updated).toBe(1);
			const firstBody = db.prepare("SELECT body_text FROM memory_items WHERE id = ?").get(id) as {
				body_text: string;
			};
			expect(firstBody.body_text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
			const second = scanSecretsRetroactive(db);
			expect(second.updated).toBe(0);
			const secondBody = db.prepare("SELECT body_text FROM memory_items WHERE id = ?").get(id) as {
				body_text: string;
			};
			expect(secondBody.body_text).toBe(firstBody.body_text);
		} finally {
			db.close();
		}
	});

	it("redacts actor_display_name and origin_source", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const now = new Date().toISOString();
			const id = Number(
				db
					.prepare(
						`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
						 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
						 actor_display_name, origin_source)
						 VALUES (?, 'discovery', 'Title', 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', ?, ?)`,
					)
					.run(sessionId, now, now, `peer ${pat}`, `tool ${pat}`).lastInsertRowid,
			);
			const result = scanSecretsRetroactive(db);
			expect(result.updated).toBe(1);
			const row = db
				.prepare("SELECT actor_display_name, origin_source FROM memory_items WHERE id = ?")
				.get(id) as { actor_display_name: string | null; origin_source: string | null };
			expect(row.actor_display_name ?? "").not.toContain(pat);
			expect(row.actor_display_name ?? "").toContain("[REDACTED:github_pat_classic]");
			expect(row.origin_source ?? "").not.toContain(pat);
		} finally {
			db.close();
		}
	});

	it("refreshes memory_concept_refs after redacting concepts", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const conceptsRaw = JSON.stringify([`leaks ${pat}`, "clean"]);
			const id = seedLegacyRow(db, sessionId, "Title", "Body", { concepts: conceptsRaw });
			// Seed the junction table with the unredacted concept (mimic what
			// would have happened if remember() had been called pre-scanner).
			db.prepare("INSERT INTO memory_concept_refs (memory_id, concept) VALUES (?, ?), (?, ?)").run(
				id,
				`leaks ${pat}`.toLowerCase(),
				id,
				"clean",
			);
			const result = scanSecretsRetroactive(db);
			expect(result.updated).toBe(1);
			const refs = db
				.prepare("SELECT concept FROM memory_concept_refs WHERE memory_id = ? ORDER BY concept")
				.all(id) as Array<{ concept: string }>;
			const all = refs.map((r) => r.concept).join("|");
			expect(all).not.toContain(pat);
		} finally {
			db.close();
		}
	});

	it("redacts legacy file_read/file_modified arrays and refreshes memory_file_refs", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const filesRead = JSON.stringify([`/tmp/${pat}.log`, "/clean/path"]);
			const filesModified = JSON.stringify([`/var/${pat}.tmp`]);
			// Seed legacy memory and pre-scanner junction-table refs that contain
			// the unredacted paths (mimics what populateMemoryRefs would have done
			// pre-scanner deployment).
			const now = new Date().toISOString();
			const id = Number(
				db
					.prepare(
						`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
						 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
						 files_read, files_modified)
						 VALUES (?, 'discovery', 'T', 'B', 0.5, '', 1, ?, ?, '{}', 1, 'shared', ?, ?)`,
					)
					.run(sessionId, now, now, filesRead, filesModified).lastInsertRowid,
			);
			db.prepare(
				"INSERT INTO memory_file_refs (memory_id, file_path, relation) VALUES (?, ?, 'read'), (?, ?, 'read'), (?, ?, 'modified')",
			).run(id, `/tmp/${pat}.log`, id, "/clean/path", id, `/var/${pat}.tmp`);

			const result = scanSecretsRetroactive(db);
			expect(result.updated).toBe(1);

			const row = db
				.prepare("SELECT files_read, files_modified FROM memory_items WHERE id = ?")
				.get(id) as { files_read: string; files_modified: string };
			expect(row.files_read).not.toContain(pat);
			expect(row.files_read).toContain("[REDACTED:github_pat_classic]");
			expect(row.files_modified).not.toContain(pat);

			const refs = db
				.prepare("SELECT file_path FROM memory_file_refs WHERE memory_id = ?")
				.all(id) as Array<{ file_path: string }>;
			for (const r of refs) {
				expect(r.file_path).not.toContain(pat);
			}
			expect(refs.some((r) => r.file_path === "/clean/path")).toBe(true);
		} finally {
			db.close();
		}
	});

	it("does not flag rows as changed when metadata only differs by JSON canonicalization", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			// Stored JSON has whitespace and key order V8's JSON.stringify will
			// not reproduce. The row contains no secrets, so the sweep must
			// report changed=false rather than re-stringifying and treating the
			// canonicalization diff as a redaction.
			const noisyMeta = '{"b": 2,  "a":1,\n"nested": {"x": "ok"}}';
			seedLegacyRow(db, sessionId, "Title", "Body no secrets", { metadata_json: noisyMeta });
			const result = scanSecretsRetroactive(db);
			expect(result.checked).toBe(1);
			expect(result.updated).toBe(0);
			expect(result.detections).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("completes without stack overflow on a large no-op sweep", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			// Seed enough rows that the previous mergeDetections(...detectionLists)
			// spread would have tripped V8's argument-stack limit (~10k entries).
			// Pre-redacted titles ensure changed=false so the only thing we're
			// stressing is the accumulator path.
			const insert = db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'discovery', ?, '', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			);
			const now = new Date().toISOString();
			db.transaction(() => {
				for (let i = 0; i < 12_000; i++) {
					insert.run(sessionId, `clean title ${i}`, now, now);
				}
			})();
			expect(() => scanSecretsRetroactive(db)).not.toThrow();
			const result = scanSecretsRetroactive(db);
			expect(result.checked).toBe(12_000);
			expect(result.updated).toBe(0);
		} finally {
			db.close();
		}
	});

	it("rejects updates with a stale rev when a concurrent writer bumps rev mid-scan", async () => {
		const { SecretScanner } = await import("./secret-scanner.js");
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = Number(
				db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
					.run("2026-01-01T00:00:00Z", "test").lastInsertRowid,
			);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const id = seedLegacyRow(db, sessionId, `legacy ${pat}`, "Body");
			// Inject a concurrent rev bump between the sweep's SELECT (which
			// loaded rev=1) and its UPDATE. The first scan call happens on
			// the title; we hijack it to bump rev in the DB so the UPDATE's
			// WHERE rev=1 guard fails.
			const racy = new SecretScanner();
			const orig = racy.scan.bind(racy);
			let bumped = false;
			racy.scan = (text: string) => {
				if (!bumped && text.includes(pat)) {
					bumped = true;
					db.prepare("UPDATE memory_items SET rev = rev + 1 WHERE id = ?").run(id);
				}
				return orig(text);
			};
			const result = scanSecretsRetroactive(db, { scanner: racy });
			expect(result.updated).toBe(0);
			expect(result.staleWrites).toBe(1);
			// Stale-write rows must NOT appear in samples or detections — those
			// only describe persisted redactions.
			expect(result.samples).toEqual([]);
			expect(result.detections).toEqual([]);
			const row = db.prepare("SELECT title FROM memory_items WHERE id = ?").get(id) as {
				title: string;
			};
			// Original content survives because the rev guard rejected the write.
			expect(row.title).toContain(pat);
		} finally {
			db.close();
		}
	});
});
