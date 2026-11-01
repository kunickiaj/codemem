import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRelayAdmissionNonceReceipt } from "./relay-admission-clock.js";
import {
	RELAY_CLOCK_TEST_ROWS_SQL,
	RELAY_CLOCK_TEST_SCHEMA_SQL,
} from "./relay-admission-clock-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import {
	METADATA_ASSOCIATION,
	METADATA_AUDIENCE_INSERT,
	METADATA_CONTEXT,
	METADATA_INSERT_SQL,
	METADATA_NOW,
	METADATA_POLICY_INSERT,
	METADATA_READINESS_INSERT,
	METADATA_REALM_INSERT,
	type MetadataSeedOptions,
	metadataBindings,
	metadataSeed,
} from "./relay-admission-metadata-test-fixtures.js";
import { readRelayAdmissionReadinessStamp } from "./relay-admission-readiness.js";

let db: Database.Database;
function execute(sql: string, values: readonly (string | number | null)[] = []) {
	return db.prepare(sql).run(Object.fromEntries(values.map((value, index) => [index + 1, value])));
}
function seed(options: MetadataSeedOptions = {}) {
	for (const entry of metadataSeed(options)) execute(entry.sql, entry.values);
}
function insert(options: Parameters<typeof metadataBindings>[0] = {}) {
	return db
		.prepare(METADATA_INSERT_SQL)
		.get(Object.fromEntries(metadataBindings(options).map((value, index) => [index + 1, value])));
}
function fixedClock() {
	db.function("strftime", (format, when) => {
		if (when !== "now") throw new Error("unexpected clock argument");
		if (format === "%s") return "130";
		if (format === "%f") return "10.000";
		if (format === "%Y-%m-%dT%H:%M:%fZ") return "1970-01-01T00:02:10.000Z";
		throw new Error("unexpected clock format");
	});
}
beforeEach(() => {
	db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(RELAY_CLOCK_TEST_SCHEMA_SQL);
});
afterEach(() => {
	db.close();
	vi.restoreAllMocks();
});
const install = () => {
	for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) db.exec(sql);
};
const authority = METADATA_CONTEXT.authority;

describe("inert relay metadata schema", () => {
	it("exports frozen definitions without installing ordinary coordinator tables", () => {
		// Arrange
		const before = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
		// Act
		install();
		const definitions = db
			.prepare(
				"SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'relay_admission_%'",
			)
			.all() as { name: string; sql: string }[];
		// Assert
		expect(Object.isFrozen(RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS)).toBe(true);
		expect(before).toEqual([{ name: "relay_clock_test_nonces" }]);
		expect(definitions).toHaveLength(4);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(5);
		for (const row of definitions) expect(row.sql).toMatch(/WITHOUT\s+ROWID/i);
	});
	it("fails closed when metadata tables have never been installed", () => {
		// Arrange
		fixedClock();
		// Act
		const attempt = () => insert();
		// Assert
		expect(attempt).toThrow(/no such table/i);
		expect(db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).toEqual([]);
	});

	it.each<[string, string, (string | number | null)[]]>([
		["authority alphabet", METADATA_POLICY_INSERT, ["G".repeat(64), 1, "enabled"]],
		["authority length", METADATA_POLICY_INSERT, ["a".repeat(63), 1, "enabled"]],
		["authority NUL", METADATA_POLICY_INSERT, [`${"a".repeat(63)}\0`, 1, "enabled"]],
		["zero revision", METADATA_POLICY_INSERT, [authority, 0, "enabled"]],
		["initial revision two", METADATA_POLICY_INSERT, [authority, 2, "enabled"]],
		[
			"initial exhausted revision",
			METADATA_POLICY_INSERT,
			[authority, Number.MAX_SAFE_INTEGER, "enabled"],
		],
		[
			"unsafe revision",
			METADATA_POLICY_INSERT,
			[authority, Number.MAX_SAFE_INTEGER + 1, "enabled"],
		],
		["fractional revision", METADATA_POLICY_INSERT, [authority, 1.5, "enabled"]],
		["missing operator state", METADATA_POLICY_INSERT, [authority, 1, null]],
		[
			"no default state",
			"INSERT INTO relay_admission_authority_policy(authority_id,policy_revision) VALUES (?1,?2)",
			[authority, 1],
		],
		["unknown operator state", METADATA_POLICY_INSERT, [authority, 1, "ready"]],
	])("rejects invalid policy %s", (_label, sql, values) => {
		// Arrange
		install();
		// Act
		const attempt = () => execute(sql, values);
		// Assert
		expect(attempt).toThrow();
	});
});

describe("relay metadata child constraints and valid initialization", () => {
	it.each<[string, (string | number | null)[]]>([
		[METADATA_AUDIENCE_INSERT, [authority, "f".repeat(63), "enabled", 1]],
		[METADATA_AUDIENCE_INSERT, [authority, "f".repeat(64), "ready", 1]],
		[METADATA_REALM_INSERT, [authority, "group", "ready", 1]],
		[METADATA_REALM_INSERT, [authority, "", "enabled", 1]],
		[METADATA_REALM_INSERT, [authority, "é".repeat(65), "enabled", 1]],
		[METADATA_REALM_INSERT, [authority, "a\0b", "enabled", 1]],
		[METADATA_REALM_INSERT, [authority, "group", "enabled", 2]],
		[METADATA_READINESS_INSERT, [authority, "authority", "group", 1, "ready", METADATA_NOW]],
		[METADATA_READINESS_INSERT, [authority, "realm", "", 1, "ready", METADATA_NOW]],
		[METADATA_READINESS_INSERT, [authority, "other", "", 1, "ready", METADATA_NOW]],
		[METADATA_READINESS_INSERT, [authority, "authority", "", 1, "ready", null]],
		[METADATA_READINESS_INSERT, [authority, "authority", "", 1, "ready", -1]],
		[METADATA_READINESS_INSERT, [authority, "authority", "", 1, "ready", 0.5]],
		[
			METADATA_READINESS_INSERT,
			[authority, "authority", "", 1, "ready", Number.MAX_SAFE_INTEGER - 49999],
		],
		[METADATA_READINESS_INSERT, [authority, "authority", "", 0, "ready", METADATA_NOW]],
		[METADATA_READINESS_INSERT, [authority, "authority", "", 2, "ready", METADATA_NOW]],
		[
			METADATA_READINESS_INSERT,
			[authority, "authority", "", Number.MAX_SAFE_INTEGER, "ready", METADATA_NOW],
		],
		[METADATA_READINESS_INSERT, [authority, "authority", "", 1.5, "ready", METADATA_NOW]],
		[
			METADATA_READINESS_INSERT,
			[authority, "authority", "", Number.MAX_SAFE_INTEGER + 1, "ready", METADATA_NOW],
		],
		[METADATA_READINESS_INSERT, [authority, "authority", "", 1, "enabled", METADATA_NOW]],
		[METADATA_READINESS_INSERT, [authority, "realm", "missing-realm", 1, "ready", METADATA_NOW]],
	])("rejects invalid child publication %#", (sql, values) => {
		// Arrange
		install();
		execute(METADATA_POLICY_INSERT, [authority, 1, "enabled"]);
		// Act
		const attempt = () => execute(sql, values);
		// Assert
		expect(attempt).toThrow();
	});

	it("accepts initial policy revision one and 128-byte groups", () => {
		// Arrange
		install();
		// Act
		seed({ group: "é".repeat(64) });
		// Assert
		expect(
			db.prepare("SELECT policy_revision FROM relay_admission_authority_policy").get(),
		).toEqual({ policy_revision: 1 });
	});
	it.each([METADATA_AUDIENCE_INSERT, METADATA_REALM_INSERT])(
		"rejects a child without its authority: %s",
		(sql) => {
			// Arrange
			install();
			// Act
			const attempt = () => execute(sql, [authority, METADATA_CONTEXT.audience, "enabled", 1]);
			// Assert
			expect(attempt).toThrow();
		},
	);
	it.each([null, 0, Number.MAX_SAFE_INTEGER - 50000])(
		"accepts paused readiness observation boundary %s",
		(observed) => {
			// Arrange
			install();
			execute(METADATA_POLICY_INSERT, [authority, 1, "enabled"]);
			// Act
			execute(METADATA_READINESS_INSERT, [authority, "authority", "", 1, "paused", observed]);
			// Assert
			expect(db.prepare("SELECT observed_at_ms FROM relay_admission_readiness").get()).toEqual({
				observed_at_ms: observed,
			});
		},
	);
});

describe("metadata publication integrity", () => {
	beforeEach(() => {
		install();
		seed();
	});
	it("rejects valid-looking key changes even when publication counters advance", () => {
		// Arrange: avoid rejection solely because the child's counter did not advance.
		execute("UPDATE relay_admission_authority_policy SET policy_revision=2");
		// Act
		const audience = () =>
			execute("UPDATE relay_admission_audiences SET audience_id=?1,changed_revision=2", [
				"d".repeat(64),
			]);
		const realm = () =>
			execute("UPDATE relay_admission_realms SET group_id=?1,changed_revision=2", [
				"new-valid-group",
			]);
		// Assert
		expect(audience).toThrow();
		expect(realm).toThrow();
	});
	it.each([
		"UPDATE relay_admission_authority_policy SET policy_revision=policy_revision+2",
		"UPDATE relay_admission_authority_policy SET policy_revision=policy_revision",
		"UPDATE relay_admission_authority_policy SET policy_revision=0",
		"UPDATE relay_admission_authority_policy SET authority_id=?1,policy_revision=policy_revision+1",
		"UPDATE relay_admission_audiences SET audience_id=?1",
		"UPDATE relay_admission_audiences SET authority_id=?1",
		"UPDATE relay_admission_realms SET group_id=?1",
		"UPDATE relay_admission_realms SET authority_id=?1",
		"UPDATE relay_admission_readiness SET scope=?1",
		"UPDATE relay_admission_readiness SET authority_id=?1",
		"UPDATE relay_admission_readiness SET group_id=?1",
		"UPDATE relay_admission_audiences SET changed_revision=changed_revision",
		"UPDATE relay_admission_realms SET changed_revision=2",
		"UPDATE relay_admission_readiness SET revision=revision WHERE scope='authority'",
		"UPDATE relay_admission_readiness SET revision=revision+2 WHERE scope='authority'",
		"UPDATE relay_admission_readiness SET revision=2 WHERE scope='realm'",
	])("rejects invalid mutation %s", (sql) => {
		// Arrange
		const values = sql.includes("?1") ? ["d".repeat(64)] : [];
		// Act
		const attempt = () => execute(sql, values);
		// Assert
		expect(attempt).toThrow();
	});

	it.each([
		"relay_admission_authority_policy",
		"relay_admission_audiences",
		"relay_admission_realms",
		"relay_admission_readiness",
	])("protects %s from DELETE and duplicate replacement", (table) => {
		// Arrange: identifiers come only from this static test matrix.
		const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as Record<
			string,
			string | number
		>;
		const columns = Object.keys(row).join(",");
		const parameters = Object.keys(row)
			.map((_, i) => `?${i + 1}`)
			.join(",");
		const base = `INTO ${table}(${columns}) VALUES (${parameters})`;
		// Act
		const attempts = [
			() => execute(`DELETE FROM ${table}`),
			() => execute(`INSERT OR REPLACE ${base}`, Object.values(row)),
			() => execute(`INSERT ${base} ON CONFLICT DO NOTHING`, Object.values(row)),
			() =>
				execute(
					`INSERT ${base} ON CONFLICT DO UPDATE SET ${Object.keys(row)[0]}=excluded.${Object.keys(row)[0]}`,
					Object.values(row),
				),
		];
		// Assert
		for (const attempt of attempts) expect(attempt).toThrow();
		expect(db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()).toEqual(row);
	});
});

describe("metadata publications and operator switches", () => {
	beforeEach(() => {
		install();
		seed();
	});
	it("publishes explicit revisions atomically and keeps operator state independent from health", () => {
		// Arrange
		fixedClock();
		// Act: the fixed captured successor must trigger an abort if it is stale.
		db.transaction(() => {
			execute(
				"UPDATE relay_admission_authority_policy SET policy_revision=2,operator_state='disabled' WHERE authority_id=?1",
				[authority],
			);
			execute(
				"UPDATE relay_admission_realms SET changed_revision=2,operator_state='disabled' WHERE authority_id=?1",
				[authority],
			);
			execute(
				"UPDATE relay_admission_readiness SET revision=2 WHERE authority_id=?1 AND scope='authority'",
				[authority],
			);
			execute(
				"UPDATE relay_admission_readiness SET revision=2 WHERE authority_id=?1 AND scope='realm'",
				[authority],
			);
		})();
		// Assert
		expect(insert({ policyRevision: 2 })).toBeUndefined();
		expect(db.prepare("SELECT operator_state FROM relay_admission_realms").get()).toEqual({
			operator_state: "disabled",
		});
	});

	it("aborts a stale root publication before its otherwise-valid realm change commits", () => {
		// Arrange: another publication already advanced this root to revision 2.
		const staleAuthority = "d".repeat(64);
		seed({ authority: staleAuthority, realmState: "disabled" });
		execute("UPDATE relay_admission_authority_policy SET policy_revision=2 WHERE authority_id=?1", [
			staleAuthority,
		]);
		const publish = db.transaction(() => {
			execute(
				"UPDATE relay_admission_authority_policy SET policy_revision=2 WHERE authority_id=?1",
				[staleAuthority],
			);
			execute(
				"UPDATE relay_admission_realms SET operator_state='enabled',changed_revision=2 WHERE authority_id=?1",
				[staleAuthority],
			);
		});
		// Act
		let failure: unknown;
		try {
			publish();
		} catch (error) {
			failure = error;
		}
		// Assert
		expect(failure).toBeInstanceOf(Error);
		expect(
			db
				.prepare(
					"SELECT policy_revision FROM relay_admission_authority_policy WHERE authority_id=?1",
				)
				.get({ 1: staleAuthority }),
		).toEqual({ policy_revision: 2 });
		expect(
			db
				.prepare(
					"SELECT operator_state,changed_revision FROM relay_admission_realms WHERE authority_id=?1",
				)
				.get({ 1: staleAuthority }),
		).toEqual({ operator_state: "disabled", changed_revision: 1 });
	});

	it("allows reversible operator switches but never updates a revoked audience", () => {
		// Arrange
		const publish = db.transaction((revision: number, state: string) => {
			execute("UPDATE relay_admission_authority_policy SET policy_revision=?1,operator_state=?2", [
				revision,
				state,
			]);
			execute("UPDATE relay_admission_realms SET changed_revision=?1,operator_state=?2", [
				revision,
				state,
			]);
		});
		// Act
		publish(2, "disabled");
		db.transaction(() => {
			publish(3, "enabled");
			execute("UPDATE relay_admission_audiences SET state='revoked',changed_revision=3");
		})();
		// Assert
		expect(db.prepare("SELECT operator_state FROM relay_admission_realms").get()).toEqual({
			operator_state: "enabled",
		});
		execute("UPDATE relay_admission_authority_policy SET policy_revision=4");
		expect(() =>
			execute("UPDATE relay_admission_audiences SET state='enabled',changed_revision=4"),
		).toThrow();
	});
});

describe("conditional metadata gate and same-insert projections", () => {
	beforeEach(() => {
		install();
		fixedClock();
	});
	it("allows new children at the current policy and authority-health revision two", () => {
		// Arrange: only root insertions start at one. New children reference current roots.
		seed();
		const audience = "d".repeat(64);
		// Act
		db.transaction(() => {
			execute(
				"UPDATE relay_admission_authority_policy SET policy_revision=2 WHERE authority_id=?1",
				[authority],
			);
			execute(
				"UPDATE relay_admission_readiness SET revision=2 WHERE authority_id=?1 AND scope='authority'",
				[authority],
			);
			execute(METADATA_AUDIENCE_INSERT, [authority, audience, "enabled", 2]);
			execute(METADATA_REALM_INSERT, [authority, "group-B", "enabled", 2]);
			execute(METADATA_READINESS_INSERT, [authority, "realm", "group-B", 2, "ready", METADATA_NOW]);
		})();
		const row = insert({ group: "group-B", audience, policyRevision: 2 });
		// Assert
		expect(row).toMatchObject({ policyRevision: 2, readinessRevision: 2 });
	});
	it.each([
		{ omit: "policy" },
		{ omit: "audience" },
		{ omit: "realm" },
		{ omit: "authorityHealth" },
		{ omit: "realmHealth" },
		{ operatorState: "disabled" },
		{ realmState: "disabled" },
		{ audienceState: "revoked" },
		{ authorityState: "paused" },
		{ authorityState: "tripped" },
		{ healthState: "paused" },
		{ healthState: "tripped" },
		{ authorityObserved: 80000 },
		{ realmObserved: 80000 },
		{ authorityObserved: 140001 },
		{ realmObserved: 140001 },
	] satisfies MetadataSeedOptions[])(
		"denies missing, disabled, stale, or future metadata %j",
		(options) => {
			// Arrange
			seed(options);
			// Act
			const row = insert();
			// Assert
			expect(row).toBeUndefined();
			expect(db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).toEqual([]);
		},
	);
	it.each([
		{ authority: "d".repeat(64) },
		{ group: "wrong" },
		{ audience: "e".repeat(64) },
		{ policyRevision: 2 },
	])("denies mismatched captured context %j", (context) => {
		// Arrange
		seed();
		// Act
		const row = insert(context);
		// Assert
		expect(row).toBeUndefined();
	});
	it.each([
		{ authorityObserved: 80001, realmObserved: 140000 },
		{ authorityObserved: 140000, realmObserved: 80001 },
	])("accepts inclusive lead and exclusive expiry boundaries %j", (times) => {
		// Arrange
		seed(times);
		execute("UPDATE relay_admission_readiness SET revision=2 WHERE scope='authority'");
		// Act: an older realm revision remains usable while its observation is fresh.
		const row = insert();
		const receipt = readRelayAdmissionNonceReceipt(row, METADATA_ASSOCIATION);
		// Assert
		expect(receipt).not.toBeNull();
		expect(row).toMatchObject({
			readinessRevision: 2,
			readinessObservedAtMs: 80001,
			policyRevision: 1,
		});
		if (!receipt) throw new Error("missing inserted receipt");
		expect(readRelayAdmissionReadinessStamp(row, receipt)).toEqual({
			revision: 2,
			state: "ready",
			observedAtMs: 80001,
			validUntilMs: 130001,
		});
	});
	it("denies an attempt captured before a policy publication", () => {
		// Arrange
		seed();
		execute("UPDATE relay_admission_authority_policy SET policy_revision=2");
		// Act
		const oldAttempt = insert();
		const newAttempt = insert({ policyRevision: 2 });
		// Assert
		expect(oldAttempt).toBeUndefined();
		expect(newAttempt).toMatchObject({ policyRevision: 2 });
	});
});
