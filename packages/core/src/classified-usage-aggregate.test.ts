import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";
import type { ClassifiedUsageEventRow } from "./types.js";

vi.mock("./observer-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./observer-config.js")>()),
	readCodememConfigFile: () => ({}),
}));

// Frozen from 7c50ce2d: intentionally independent of production SQL helpers.
const BASELINE_SQL = `WITH classified_usage AS (
	SELECT usage_events.*,
		CASE WHEN json_valid(usage_events.metadata_json)
			THEN json_extract(usage_events.metadata_json, '$.token_usage.source')
			ELSE NULL END AS usage_source
	FROM usage_events
	WHERE (? IS NULL OR session_id IN (SELECT id FROM sessions WHERE project = ?))
)
SELECT event, COUNT(*) AS count,
	COALESCE(SUM(CASE WHEN event = 'observer_call' AND usage_source IS NOT 'provider' THEN 0 ELSE COALESCE(tokens_read, 0) END), 0) AS tokens_read,
	COALESCE(SUM(CASE WHEN event = 'observer_call' AND usage_source IS NOT 'provider' THEN 0 ELSE COALESCE(tokens_written, 0) END), 0) AS tokens_written,
	COALESCE(SUM(COALESCE(tokens_saved, 0)), 0) AS tokens_saved,
	SUM(CASE WHEN usage_source = 'provider' THEN 1 ELSE 0 END) AS measured_count,
	SUM(CASE WHEN usage_source = 'estimate' OR (event = 'pack' AND usage_source IS NULL) THEN 1 ELSE 0 END) AS estimated_count,
	SUM(CASE WHEN event = 'observer_call' AND usage_source IS NOT NULL AND usage_source != 'provider' THEN 1 ELSE 0 END) AS unavailable_count,
	SUM(CASE WHEN event = 'observer_call' AND usage_source IS NULL THEN 1 ELSE 0 END) AS legacy_text_length_count,
	SUM(CASE WHEN event != 'observer_call' AND event != 'pack' AND usage_source IS NULL THEN 1 ELSE 0 END) AS legacy_unclassified_count
FROM classified_usage
WHERE event != 'observer_recovery_scope_denial' AND event NOT GLOB 'observer_recovery_call_clock:*'
GROUP BY event`;

const NOW = "2026-04-01T00:00:00.000Z";
const PROVIDER = '{"token_usage":{"source":"provider"}}';
const EVENTS = ["observer_call", "pack", "legacy_unknown"];
const METADATA_CASES = [
	[PROVIDER, "provider"],
	['{"token_usage":{"source":"estimate"}}', "estimate"],
	['{"token_usage":{"source":"unknown"}}', "other"],
	['{"token_usage":{"source":"Provider"}}', "other"],
	['{"token_usage":{"source":"PROVIDER"}}', "other"],
	['{"token_usage":{"source":"Estimate"}}', "other"],
	['{"token_usage":{"source":""}}', "other"],
	['{"token_usage":{"source":["provider"]}}', "other"],
	['{"token_usage":{"source":{"name":"provider"}}}', "other"],
	['{"token_usage":{"source":17}}', "other"],
	['{"token_usage":{"source":true}}', "other"],
	['{"token_usage":{"source":false}}', "other"],
	['{"token_usage":{"source":null}}', "missing"],
	['{"token_usage":{}}', "missing"],
	['{"token_usage":[]}', "missing"],
	['{"token_usage":"provider"}', "missing"],
	['{"token_usage":42}', "missing"],
	['{"token_usage":true}', "missing"],
	['{"token_usage":null}', "missing"],
	["{}", "missing"],
	["[]", "missing"],
	['"provider"', "missing"],
	["null", "missing"],
	[null, "missing"],
	["{broken", "missing"],
] as const;

function publicRow({
	event,
	count,
	tokens_read,
	tokens_written,
	tokens_saved,
}: ClassifiedUsageEventRow) {
	return { event, count, tokens_read, tokens_written, tokens_saved };
}

function provenanceRow({
	count: _count,
	tokens_read: _read,
	tokens_written: _written,
	tokens_saved: _saved,
	...provenance
}: ClassifiedUsageEventRow) {
	return provenance;
}

let directory: string;
let store: MemoryStore;
let sessionId: number;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-classified-usage-"));
	vi.stubEnv("CODEMEM_DEVICE_ID", "fixture-device");
	vi.stubEnv("CODEMEM_ACTOR_ID", "fixture-actor");
	vi.stubEnv("CODEMEM_ACTOR_DISPLAY_NAME", "Fixture Actor");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const dbPath = join(directory, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(dbPath, {
		keysDir: join(directory, "keys"),
		runtimeSigningKey: { deviceId: "fixture-device", publicKey: "fixture-public-key" },
	});
	sessionId = insertSession("project-a");
});

afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function insertSession(project: string | null) {
	return Number(
		store.db.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)").run(NOW, project)
			.lastInsertRowid,
	);
}

function insertUsage(
	event: string,
	metadata: string | null = PROVIDER,
	session: number | null = sessionId,
	tokens: (number | null)[] = [11, 7, 3],
) {
	return store.db
		.prepare(`INSERT INTO usage_events(session_id, event, metadata_json, tokens_read, tokens_written, tokens_saved, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`)
		.run(session, event, metadata, ...tokens, NOW).lastInsertRowid;
}

function readBaseline(project?: string | null): ClassifiedUsageEventRow[] {
	const filter = project || null;
	const rows = store.db.prepare(BASELINE_SQL).all(filter, filter) as Omit<
		ClassifiedUsageEventRow,
		"token_unit"
	>[];
	return rows.map((row) => ({ ...row, token_unit: "tokens" }));
}

function assertParity(project?: string | null) {
	const expected = readBaseline(project);
	const actual = store.classifiedUsageAggregate(project);
	expect(actual.toSorted((a, b) => a.event.localeCompare(b.event))).toEqual(
		expected.toSorted((a, b) => a.event.localeCompare(b.event)),
	);
	expect(store.usageAggregate(project)).toEqual(actual.map(publicRow));
	const global = readBaseline().sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
	const stats = store.stats().usage;
	expect(stats.events).toEqual(global.map(publicRow));
	expect(stats.provenance.events).toEqual(global.map(provenanceRow));
	for (const key of ["events", "tokens_read", "tokens_written", "tokens_saved"] as const) {
		expect(stats.totals[key]).toBe(
			global.reduce((sum, row) => sum + row[key === "events" ? "count" : key], 0),
		);
	}
	expect(stats.provenance.totals.token_unit).toBe("tokens");
	for (const key of [
		"measured_count",
		"estimated_count",
		"unavailable_count",
		"legacy_text_length_count",
		"legacy_unclassified_count",
	] as const) {
		expect(stats.provenance.totals[key]).toBe(global.reduce((sum, row) => sum + row[key], 0));
	}
	return actual;
}

describe("classified usage source baseline parity", () => {
	it.each(METADATA_CASES)("preserves classification for metadata %s (%s)", (metadata, source) => {
		// Arrange: the same source has different historical meanings for each event.
		for (const event of EVENTS) insertUsage(event, metadata);
		// Act: exercise all public views against the frozen SQL.
		const rows = assertParity("project-a");
		// Assert: counts can overlap (observer estimates are also unavailable).
		rows.forEach((row) => {
			const observer = row.event === "observer_call";
			const suppressTokens = observer && source !== "provider";
			const missing = source === "missing";
			expect(row).toMatchObject({
				count: 1,
				tokens_saved: 3,
				tokens_read: suppressTokens ? 0 : 11,
				tokens_written: suppressTokens ? 0 : 7,
				measured_count: Number(source === "provider"),
				estimated_count: Number(
					source === "estimate" || (row.event === "pack" && source === "missing"),
				),
				unavailable_count: Number(suppressTokens && !missing),
				legacy_text_length_count: Number(observer && missing),
				legacy_unclassified_count: Number(row.event === "legacy_unknown" && missing),
			});
		});
	});
});

describe("classified usage filtering baseline parity", () => {
	it.each([undefined, null, "", "project-a", "project-b", "absent", "' OR 1=1 --"])(
		"preserves global and exact project filtering for %s",
		(project) => {
			// Arrange: sessionless and NULL/empty-project sessions remain global only.
			for (const session of [
				sessionId,
				insertSession("project-b"),
				insertSession(null),
				insertSession(""),
				null,
			])
				insertUsage("pack", PROVIDER, session);
			// Act
			const rows = assertParity(project);
			// Assert
			const count = rows.reduce((sum, row) => sum + row.count, 0);
			if (!project) expect(count).toBe(5);
			else if (project.startsWith("project-")) expect(count).toBe(1);
			else expect(rows).toEqual([]);
		},
	);

	it.each([PROVIDER, "{}", "{broken"])(
		"excludes private accounting but retains similarly named public events (%s)",
		(metadata) => {
			// Arrange
			for (const event of [
				"observer_recovery_scope_denial",
				"observer_recovery_call_clock:",
				"observer_recovery_call_clock:batch-1",
			]) {
				insertUsage(event, metadata);
				insertUsage(event, metadata, null);
			}
			for (const event of [
				"observer_recovery_scope_denial_extra",
				"observer_recovery_call_clock",
				"Observer_recovery_call_clock:batch-1",
			])
				insertUsage(event, metadata);
			// Act
			const rows = assertParity("project-a");
			// Assert
			expect(rows).toHaveLength(3);
			expect(rows.every((row) => row.count === 1 && row.tokens_read === 11)).toBe(true);
		},
	);
});

describe("classified usage token and freshness baseline parity", () => {
	it.each([
		[null, null, null],
		[-11, -7, -3],
		[2 ** 40, 2 ** 39, 2 ** 38],
	])("preserves nullable, negative and large integer tokens %s/%s/%s", (read, written, saved) => {
		// Arrange: repeated rows test SUM as well as per-row coercion.
		for (const event of EVENTS)
			for (const metadata of [PROVIDER, "{}"])
				insertUsage(event, metadata, sessionId, [read, written, saved]);
		// Act
		const rows = assertParity();
		// Assert
		for (const row of rows) {
			const multiplier = row.event === "observer_call" ? 1 : 2;
			expect(publicRow(row)).toEqual({
				event: row.event,
				count: 2,
				tokens_read: (read ?? 0) * multiplier,
				tokens_written: (written ?? 0) * multiplier,
				tokens_saved: (saved ?? 0) * 2,
			});
		}
	});

	it.each(["empty", "internal-only"])("returns zero public totals for %s data", (dataset) => {
		// Arrange
		if (dataset === "internal-only")
			for (const event of [
				"observer_recovery_scope_denial",
				"observer_recovery_call_clock:batch-1",
			])
				insertUsage(event);
		// Act
		const rows = assertParity();
		const projectRows = assertParity("project-a");
		// Assert
		expect(rows).toEqual([]);
		expect(projectRows).toEqual([]);
	});

	it("reflects insert, classification/project updates and deletion without stale results", () => {
		// Arrange: warm every read before each mutation on the same store instance.
		assertParity("project-a");
		// Act / Assert: insert is visible immediately.
		const id = insertUsage("observer_call");
		expect(assertParity("project-a")[0]).toMatchObject({
			count: 1,
			tokens_read: 11,
			measured_count: 1,
		});
		// Act / Assert: changing source and tokens invalidates earlier measured totals.
		store.db
			.prepare(
				"UPDATE usage_events SET metadata_json = ?, tokens_read = 999, tokens_saved = NULL WHERE id = ?",
			)
			.run("{broken", id);
		expect(assertParity("project-a")[0]).toMatchObject({
			tokens_read: 0,
			tokens_written: 0,
			tokens_saved: 0,
			measured_count: 0,
			legacy_text_length_count: 1,
		});
		// Act / Assert: project moves affect scoped reads but not the global count.
		store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("project-b", sessionId);
		expect(assertParity("project-a")).toEqual([]);
		expect(assertParity("project-b")[0]?.count).toBe(1);
		// Act / Assert: deleted events disappear from both scopes and global stats.
		store.db.prepare("DELETE FROM usage_events WHERE id = ?").run(id);
		expect(assertParity("project-b")).toEqual([]);
		expect(assertParity()).toEqual([]);
	});
});
