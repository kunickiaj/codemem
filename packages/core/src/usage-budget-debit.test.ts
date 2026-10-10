import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

describe("public usage excludes recovery budget debits", () => {
	let directory: string;
	let store: MemoryStore;
	let sessionId: number;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-usage-budget-"));
		const dbPath = join(directory, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		sessionId = Number(
			db
				.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
				.run("2026-04-01T00:00:00.000Z", "usage-project").lastInsertRowid,
		);
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	function insertUsage(event: string, session: number | null, metadata = "{}") {
		store.db
			.prepare(
				`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written,
			 tokens_saved, created_at, metadata_json) VALUES (?, ?, 10, 5, 2, ?, ?)`,
			)
			.run(session, event, "2026-04-01T00:00:00.000Z", metadata);
	}

	it.each([undefined, null, "", "usage-project"])(
		"counts real calls and unknown legacy events, not budget debits (project %s)",
		(project) => {
			// Arrange: exclude only the internal event, regardless of provenance metadata.
			insertUsage("observer_call", sessionId, '{"token_usage":{"source":"provider"}}');
			insertUsage("legacy_unknown", sessionId);
			insertUsage("observer_recovery_scope_denial", sessionId);
			insertUsage("observer_recovery_scope_denial", null, '{"token_usage":{"source":"provider"}}');

			// Act: both public projections must use the same event filter.
			const classified = store.classifiedUsageAggregate(project);
			const usage = store.usageAggregate(project);

			// Assert: legacy rows remain visible and counted; debits add no calls or tokens.
			expect(classified.map((row) => row.event).sort()).toEqual([
				"legacy_unknown",
				"observer_call",
			]);
			expect(classified.find((row) => row.event === "observer_call")).toMatchObject({
				count: 1,
				tokens_read: 10,
				tokens_written: 5,
				measured_count: 1,
				legacy_unclassified_count: 0,
			});
			expect(classified.find((row) => row.event === "legacy_unknown")).toMatchObject({
				count: 1,
				tokens_read: 10,
				tokens_written: 5,
				legacy_unclassified_count: 1,
			});
			expect(usage.reduce((sum, row) => sum + row.count, 0)).toBe(2);
			expect(usage.reduce((sum, row) => sum + row.tokens_saved, 0)).toBe(4);
		},
	);

	it("keeps sessionless public events global and preserves project isolation", () => {
		// Arrange: a real sessionless event must not disappear with the internal debit.
		insertUsage("observer_call", sessionId, '{"token_usage":{"source":"provider"}}');
		insertUsage("legacy_unknown", null);
		insertUsage("observer_recovery_scope_denial", null);
		insertUsage("observer_recovery_scope_denial", sessionId);

		// Act: project aggregates retain the existing sessions join semantics.
		const global = store.usageAggregate();
		const project = store.usageAggregate("usage-project");
		const missingProject = store.usageAggregate("other-project");
		const stats = store.stats().usage;

		// Assert: stats and global agree, while project results contain only their session.
		expect(global.map((row) => row.event).sort()).toEqual(["legacy_unknown", "observer_call"]);
		expect(project.map((row) => row.event)).toEqual(["observer_call"]);
		expect(missingProject).toEqual([]);
		expect(stats.events.reduce((sum, row) => sum + row.count, 0)).toBe(2);
		expect(stats.provenance.totals).toMatchObject({
			measured_count: 1,
			legacy_unclassified_count: 1,
		});
		expect(stats.totals).toMatchObject({ tokens_read: 20, tokens_written: 10, tokens_saved: 4 });
	});

	it("returns empty public usage for a debit-only database without deleting quota accounting", () => {
		// Arrange: four internal debits still belong to the private hourly-budget ledger.
		for (let index = 0; index < 4; index++) insertUsage("observer_recovery_scope_denial", null);

		// Act: read public aggregates and the stored private accounting separately.
		const classified = store.classifiedUsageAggregate();
		const usage = store.usageAggregate();
		const stats = store.stats().usage;
		const ledger = store.db
			.prepare(
				"SELECT COUNT(*) AS count FROM usage_events WHERE event = 'observer_recovery_scope_denial' AND created_at > ?",
			)
			.get("2026-03-31T23:00:00.000Z");

		// Assert: no synthetic public event or legacy provenance; all four debits survive.
		expect(classified).toEqual([]);
		expect(usage).toEqual([]);
		expect(stats.events).toEqual([]);
		expect(stats.provenance.totals.legacy_unclassified_count).toBe(0);
		expect(stats.totals).toMatchObject({ tokens_read: 0, tokens_written: 0, tokens_saved: 0 });
		expect(ledger).toEqual({ count: 4 });
	});
});
