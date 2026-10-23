import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";

const table = "coordinator_legacy_owner_resolutions";
// Synthetic storage records are not authenticated proofs or authorization fixtures.
const receipt = {
	coordinator_id: "coordinator.example",
	resolution_id: "resolution-a",
	resolution_version: 1,
	device_id: "device-a",
	key_id: "a".repeat(64),
	owner_identity_id: "owner-a",
	purpose: "existing_account_owner",
	scope: "historical_included_owner_labels_only",
	source_attestation_id: "controller-a",
	source_group_id: "group-a",
	source_controller_revision: 1,
	source_public_key: "synthetic-original-public-key-text",
	source_fingerprint: "b".repeat(64),
	source_enrollment_identity_id: null,
	source_created_at: "2026-10-01T00:00:00.000Z",
	source_review_receipt_id: "original-review-a",
	source_evidence_digest: "c".repeat(64),
	resolution_evidence_digest: "d".repeat(64),
	reviewed_weak_labels_json: "[]",
	created_at: "2026-10-22T00:00:00.000Z",
};
type Column = keyof typeof receipt;
type Row = Record<Column, string | number | null>;
const columns = Object.keys(receipt) as Column[];
const test = it.extend<{ db: SqliteDatabase }>({
	db: async ({ task: _task }, use) => {
		const db = new Database(":memory:");
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
			await use(db);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			db.close();
		}
	},
});
function insert(db: SqliteDatabase, patch: Partial<Row> = {}, verb = "INSERT") {
	const row: Row = { ...receipt, ...patch };
	db.prepare(
		`${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
	).run(...columns.map((column) => row[column]));
}
function rows(db: SqliteDatabase) {
	return db.prepare(`SELECT * FROM ${table} ORDER BY coordinator_id, resolution_id`).all();
}

describe("inert legacy owner-resolution schema", () => {
	test("retains exact original source fields and a separate fresh resolution digest", ({ db }) => {
		// Arrange: deliberately not a cryptographic proof; SQL must not invent a key/fingerprint relation.
		const patch = {
			source_public_key: " original synthetic key\n",
			source_review_receipt_id: "original-review-not-resolution-id",
			source_enrollment_identity_id: "original-enrollment-a",
		};
		// Act
		insert(db, patch);
		// Assert
		expect(rows(db)).toEqual([{ ...receipt, ...patch }]);
	});
	test("has the exact columns, coordinator-scoped primary key and lookup indexes without foreign keys", ({
		db,
	}) => {
		// Arrange
		const info = db.pragma(`table_info(${table})`) as {
			name: string;
			pk: number;
			notnull: number;
		}[];
		// Act
		const indexes = db.prepare("SELECT name FROM pragma_index_list(?)").all(table) as {
			name: string;
		}[];
		const indexedColumns = indexes.map(({ name }) =>
			db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name),
		);
		// Assert
		expect(info.map(({ name }) => name)).toEqual(columns);
		expect(info.filter(({ pk }) => pk > 0).map(({ name }) => name)).toEqual([
			"coordinator_id",
			"resolution_id",
		]);
		expect(info.filter(({ notnull }) => notnull === 0).map(({ name }) => name)).toEqual([
			"source_enrollment_identity_id",
		]);
		expect(indexedColumns).toEqual(
			expect.arrayContaining([
				[{ name: "coordinator_id" }, { name: "device_id" }],
				[{ name: "coordinator_id" }, { name: "key_id" }],
			]),
		);
		expect(db.pragma(`foreign_key_list(${table})`)).toEqual([]);
	});
	test("appends distinct receipts for the same owner, device and key", ({ db }) => {
		// Arrange
		insert(db);
		const next = { resolution_id: "resolution-b", resolution_evidence_digest: "e".repeat(64) };
		// Act
		insert(db, next);
		// Assert
		expect(rows(db)).toEqual([receipt, { ...receipt, ...next }]);
	});
	test("namespaces identical device, key and resolution identifiers by coordinator", ({ db }) => {
		// Arrange
		insert(db);
		const other = { coordinator_id: "other.example", owner_identity_id: "owner-b" };
		// Act
		insert(db, other);
		// Assert
		expect(rows(db)).toEqual([receipt, { ...receipt, ...other }]);
	});
	for (const patch of [{ key_id: "e".repeat(64) }, { device_id: "other-device" }]) {
		test(`rejects another owner matching ${"key_id" in patch ? "device" : "key"} within a coordinator`, ({
			db,
		}) => {
			// Arrange
			insert(db);
			// Act
			const attempt = () =>
				insert(db, { ...patch, resolution_id: "resolution-b", owner_identity_id: "owner-b" });
			// Assert
			expect(attempt).toThrow();
			expect(rows(db)).toEqual([receipt]);
		});
	}
	test("allows unrelated devices and keys with different owners", ({ db }) => {
		// Arrange
		insert(db);
		const other = {
			resolution_id: "resolution-b",
			device_id: "device-b",
			key_id: "e".repeat(64),
			owner_identity_id: "owner-b",
		};
		// Act
		insert(db, other);
		// Assert
		expect(rows(db)).toEqual([receipt, { ...receipt, ...other }]);
	});
});
describe("immutable resolution receipts", () => {
	for (const verb of ["INSERT", "INSERT OR REPLACE"]) {
		test(`${verb} cannot replace the same primary key with a changed same-owner receipt`, ({
			db,
		}) => {
			// Arrange: REPLACE must be safe even when implicit deletes do not fire triggers.
			db.pragma("recursive_triggers = OFF");
			insert(db);
			// Act
			const attempt = () =>
				insert(
					db,
					{
						source_review_receipt_id: "changed-original-review",
						resolution_evidence_digest: "e".repeat(64),
					},
					verb,
				);
			// Assert
			expect(attempt).toThrow();
			expect(rows(db)).toEqual([receipt]);
		});
	}
	test("INSERT OR IGNORE cannot change a receipt on a duplicate primary key", ({ db }) => {
		// Arrange
		insert(db);
		// Act: either rejection or an unchanged row is valid; no new error API is assumed.
		try {
			insert(db, { source_review_receipt_id: "changed-review" }, "INSERT OR IGNORE");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
		}
		// Assert
		expect(rows(db)).toEqual([receipt]);
	});
	test("rejects updates to every field, including same-owner metadata and no-op writes", ({
		db,
	}) => {
		// Arrange
		insert(db);
		for (const column of columns) {
			// Act
			const attempt = () => db.prepare(`UPDATE ${table} SET ${column} = ?`).run(receipt[column]);
			// Assert
			expect(attempt, column).toThrow();
			expect(rows(db)).toEqual([receipt]);
		}
	});
	test("rejects deletes without erasing the original receipt", ({ db }) => {
		// Arrange
		insert(db);
		// Act
		const attempt = () => db.prepare(`DELETE FROM ${table}`).run();
		// Assert
		expect(attempt).toThrow();
		expect(rows(db)).toEqual([receipt]);
	});
});
describe("resolution field constraints", () => {
	const canonicalIds = [
		"coordinator_id",
		"resolution_id",
		"device_id",
		"owner_identity_id",
		"source_attestation_id",
		"source_group_id",
		"source_review_receipt_id",
		"source_enrollment_identity_id",
	] as const;
	for (const column of canonicalIds) {
		test(`accepts accented and CJK canonical ${column} without rewriting source bytes`, ({
			db,
		}) => {
			// Arrange: canonical identifiers are not restricted to ASCII.
			const patch = { [column]: "identité-雪", source_public_key: " original synthetic key\n" };
			// Act
			insert(db, patch);
			// Assert
			expect(rows(db)).toEqual([{ ...receipt, ...patch }]);
		});
		for (const [label, value] of [
			["leading space", " identifier"],
			["trailing space", "identifier "],
			["leading tab and trailing newline", "\tidentifier\n"],
			["leading carriage return and trailing tab", "\ridentifier\t"],
		] as const) {
			test(`rejects ${label} in canonical ${column} without changing retained receipts`, ({
				db,
			}) => {
				// Arrange: isolate the CHECK from primary-key and owner-collision triggers.
				insert(db);
				const patch = {
					resolution_id: "resolution-b",
					device_id: "device-b",
					key_id: "e".repeat(64),
					[column]: value,
				};
				// Act
				const attempt = () => insert(db, patch);
				// Assert
				expect(attempt).toThrow(/CHECK constraint failed/u);
				expect(rows(db)).toEqual([receipt]);
			});
		}
	}
	test("rejects a whitespace device alias with a different key and owner at the CHECK boundary", ({
		db,
	}) => {
		// Arrange: raw-ID collision comparisons must not admit a noncanonical spelling.
		insert(db);
		const patch = {
			resolution_id: "resolution-b",
			device_id: " device-a",
			key_id: "e".repeat(64),
			owner_identity_id: "owner-b",
		};
		// Act
		const attempt = () => insert(db, patch);
		// Assert
		expect(attempt).toThrow(/CHECK constraint failed/u);
		expect(rows(db)).toEqual([receipt]);
	});
	for (const [column, value] of [
		["resolution_version", 2],
		["source_controller_revision", 2],
		["purpose", "owner_transfer"],
		["scope", "all_owner_authority"],
	] as const) {
		test(`rejects unsupported ${column}`, ({ db }) => {
			// Arrange
			const patch = { [column]: value };
			// Act
			const attempt = () => insert(db, patch);
			// Assert
			expect(attempt).toThrow();
			expect(rows(db)).toEqual([]);
		});
	}
	for (const column of [
		"key_id",
		"source_fingerprint",
		"source_evidence_digest",
		"resolution_evidence_digest",
	] as const) {
		test(`requires lowercase 64-hex ${column}`, ({ db }) => {
			// Arrange
			const invalid = [
				"",
				"a".repeat(63),
				"a".repeat(65),
				"A".repeat(64),
				"g".repeat(64),
				`${"a".repeat(63)}\n`,
			];
			for (const value of invalid) {
				// Act
				const attempt = () => insert(db, { [column]: value });
				// Assert
				expect(attempt, value).toThrow();
				expect(rows(db)).toEqual([]);
			}
		});
	}
	test("rejects null in every required field and empty required identifiers", ({ db }) => {
		// Arrange
		const ids: Column[] = [
			"coordinator_id",
			"resolution_id",
			"device_id",
			"owner_identity_id",
			"source_attestation_id",
			"source_group_id",
			"source_review_receipt_id",
		];
		for (const column of columns.filter((name) => name !== "source_enrollment_identity_id")) {
			// Act
			const attempt = () => insert(db, { [column]: null });
			// Assert
			expect(attempt, column).toThrow();
		}
		for (const column of ids) {
			// Act
			const attempt = () => insert(db, { [column]: "" });
			// Assert
			expect(attempt, column).toThrow();
		}
		expect(rows(db)).toEqual([]);
	});
});
describe("resolution JSON and installation", () => {
	test("accepts a JSON array at the byte cap without interpreting labels as authority", ({
		db,
	}) => {
		// Arrange: 4 JSON syntax bytes plus ASCII content = exactly 131072 bytes.
		const json = JSON.stringify(["x".repeat(131068)]);
		// Act
		insert(db, { reviewed_weak_labels_json: json });
		// Assert
		expect(Buffer.byteLength(json)).toBe(131072);
		expect(rows(db)).toEqual([{ ...receipt, reviewed_weak_labels_json: json }]);
	});
	for (const json of [
		"{",
		"{}",
		"null",
		'"label"',
		"1",
		JSON.stringify(["x".repeat(131069)]),
		JSON.stringify(["é".repeat(65535)]),
	]) {
		test(`rejects invalid, non-array or oversized weak-label JSON (${json.length} chars, ${json.slice(0, 8)})`, ({
			db,
		}) => {
			// Arrange
			const patch = { reviewed_weak_labels_json: json };
			// Act
			const attempt = () => insert(db, patch);
			// Assert
			expect(attempt).toThrow();
			expect(rows(db)).toEqual([]);
		});
	}
	test("rolls back earlier writes when a later receipt conflicts in the fixture transaction", ({
		db,
	}) => {
		// Arrange
		const transaction = db.transaction(() => {
			insert(db);
			insert(db, { resolution_id: "resolution-b", owner_identity_id: "owner-b" });
		});
		// Act
		const attempt = () => transaction();
		// Assert
		expect(attempt).toThrow();
		expect(rows(db)).toEqual([]);
		expect(db.inTransaction).toBe(false);
	});
	it("initial and repeated installation preserve unrelated schema and exact bytes without backfill", () => {
		// Arrange: fixture-only unrelated state, not a production schema or migration.
		const db = new Database(":memory:");
		try {
			db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY, payload BLOB NOT NULL)");
			const bytes = Buffer.from([0, 255, 39, 10, 128]);
			db.prepare("INSERT INTO unrelated VALUES (?, ?)").run("synthetic-row", bytes);
			const before = db
				.prepare("SELECT * FROM sqlite_master WHERE tbl_name = ? ORDER BY name")
				.all("unrelated");
			// Act
			db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
			db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
			// Assert
			expect(db.prepare("SELECT * FROM unrelated").all()).toEqual([
				{ id: "synthetic-row", payload: bytes },
			]);
			expect(
				db.prepare("SELECT * FROM sqlite_master WHERE tbl_name = ? ORDER BY name").all("unrelated"),
			).toEqual(before);
			expect(rows(db)).toEqual([]);
		} finally {
			db.close();
		}
	});
});
