import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalReviewedWeakLabels,
	captureLegacyOwnerResolutionRecord,
	readLegacyOwnerResolutionSchemaState,
} from "./coordinator-legacy-owner-resolution-metadata.js";
import {
	LEGACY_OWNER_RESOLUTION_SCHEMA_SQL,
	LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS,
} from "./coordinator-legacy-owner-resolution-schema.js";

const table = "coordinator_legacy_owner_resolutions";
function weak(patch: Record<string, unknown> = {}) {
	return {
		label: "C",
		kind: "legacy_included_owner_label",
		group_id: "group-archived",
		device_id: "device-B",
		evidence_ref: "e".repeat(64),
		effect: "account_owner_display_only",
		...patch,
	};
}
// These are metadata fixtures, not owner proofs. No source/controller tables exist.
function record(patch: Record<string, unknown> = {}) {
	return {
		coordinator_id: "coordinator.example",
		resolution_id: "resolution-C",
		resolution_version: 1,
		device_id: "device-B",
		key_id: EXPECTED_KEY_ID,
		owner_identity_id: "C",
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: "controller-C",
		source_group_id: "group-archived",
		source_controller_revision: 1,
		source_public_key: CANONICAL_PUBLIC_KEY,
		source_fingerprint: "b".repeat(64),
		source_enrollment_identity_id: null,
		source_created_at: "2026-10-01T00:00:00.000Z",
		source_review_receipt_id: "original-review-C",
		source_evidence_digest: "c".repeat(64),
		resolution_evidence_digest: "d".repeat(64),
		reviewed_weak_labels_json: JSON.stringify([weak()]),
		created_at: "2026-10-22T00:00:00.000Z",
		...patch,
	};
}

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

describe("strict historical resolution metadata capture (not authority)", () => {
	it.each(ACCEPTED_ALIASES)("preserves exact stored source text: $name", async ({ publicKey }) => {
		// Arrange: fingerprint binds a legacy record later, not the normalized key bytes here.
		const raw = record({ source_public_key: publicKey, source_enrollment_identity_id: "B" });
		const before = structuredClone(raw);
		// Act
		const captured = await captureLegacyOwnerResolutionRecord(raw);
		// Assert: all DDL fields survive, without auth flags or fabricated current-owner state.
		expect(captured).toEqual(before);
		expect(raw).toEqual(before);
		expect(captured).not.toBe(raw);
	});

	it("accepts nullable enrollment snapshot and empty reviewed metadata without source queries", async () => {
		// Arrange: archived/missing source groups are checked by later evidence readers only.
		const raw = record({ reviewed_weak_labels_json: "[]" });
		// Act
		const captured = await captureLegacyOwnerResolutionRecord(raw);
		// Assert
		expect(captured).toEqual(raw);
	});

	it("accepts 256-character identifiers without trimming or rewriting them", async () => {
		// Arrange
		const raw = record({
			coordinator_id: "C".repeat(256),
			source_review_receipt_id: "B".repeat(256),
		});
		// Act
		const captured = await captureLegacyOwnerResolutionRecord(raw);
		// Assert
		expect(captured).toEqual(raw);
	});

	it.each(Object.keys(record()))(
		"rejects missing or inherited required column %s",
		async (field) => {
			// Arrange
			const raw = record();
			const inherited = { [field]: raw[field as keyof typeof raw] };
			Reflect.deleteProperty(raw, field);
			// Act
			const absent = await captureLegacyOwnerResolutionRecord(raw);
			const fromPrototype = await captureLegacyOwnerResolutionRecord(
				Object.assign(Object.create(inherited), raw),
			);
			// Assert
			expect(absent).toBeNull();
			expect(fromPrototype).toBeNull();
		},
	);

	it.each(["token", "extraSecret", "dbPath", "__proto__", "constructor"])(
		"rejects extra %s without printing values",
		async (field) => {
			// Arrange
			const raw = record();
			Object.defineProperty(raw, field, { value: "synthetic-sensitive-marker", enumerable: true });
			const logs = ["log", "warn", "error", "info", "debug"].map((method) =>
				vi.spyOn(console, method as "log").mockImplementation(() => {}),
			);
			// Act: malformed inputs resolve to null rather than errors containing raw values.
			const captured = await captureLegacyOwnerResolutionRecord(raw);
			// Assert
			expect(captured).toBeNull();
			for (const log of logs) expect(log).not.toHaveBeenCalled();
		},
	);

	it("does not execute getters, including nonenumerable or symbol extras", async () => {
		// Arrange
		const getter = vi.fn(() => {
			throw new Error("getter must never execute");
		});
		const inputs = [record(), record(), record()];
		Object.defineProperty(inputs[0], "source_public_key", { get: getter, enumerable: true });
		Object.defineProperty(inputs[1], "hidden", { get: getter });
		Object.defineProperty(inputs[2], Symbol("extra"), { get: getter });
		// Act
		const captured = await Promise.all(inputs.map(captureLegacyOwnerResolutionRecord));
		// Assert
		expect(captured).toEqual([null, null, null]);
		expect(getter).not.toHaveBeenCalled();
	});
});

describe("identifier Unicode semantics match the controller protocol", () => {
	const unicodeCases = [
		{ category: "ordinary accented and CJK letters", value: "C-\u00e9\u4e2d", valid: true },
		{ category: "bidi format character Cf", value: "C-\u202e-B", valid: false },
		{ category: "lone surrogate Cs", value: "C-\ud800-B", valid: false },
	];
	const recordFields = [
		"coordinator_id",
		"resolution_id",
		"device_id",
		"owner_identity_id",
		"source_attestation_id",
		"source_group_id",
		"source_enrollment_identity_id",
		"source_review_receipt_id",
	];
	it.each(recordFields.flatMap((field) => unicodeCases.map((entry) => ({ field, ...entry }))))(
		"record $field handles $category without rewriting the identifier",
		async ({ field, value, valid }) => {
			// Arrange: only identifiers change; public-key comments and proof semantics do not.
			const raw = record({ [field]: value });
			// Act
			const captured = await captureLegacyOwnerResolutionRecord(raw);
			// Assert
			if (valid) expect(captured).toEqual(raw);
			else expect(captured).toBeNull();
		},
	);

	it.each(
		["label", "group_id", "device_id"].flatMap((field) =>
			unicodeCases.map((entry) => ({ field, ...entry })),
		),
	)(
		"weak metadata $field handles $category without rewriting the identifier",
		({ field, value, valid }) => {
			// Arrange: source references remain synthetic digests, never ownership proof.
			const raw = [weak({ [field]: value })];
			// Act
			const canonical = canonicalReviewedWeakLabels(raw);
			// Assert
			if (valid) expect(canonical).toBe(JSON.stringify(raw));
			else expect(canonical).toBeNull();
		},
	);
});

describe("resolution field and stored-encoding validation", () => {
	const invalidFields: [string, unknown][] = [
		["resolution_version", "1"],
		["resolution_version", 2],
		["source_controller_revision", 0],
		["source_controller_revision", "1"],
		["purpose", "owner_transfer"],
		["scope", "scope_access"],
		["source_public_key", "ssh-ed25519 $$$$"],
		["source_public_key", "x".repeat(4097)],
		["key_id", "a".repeat(64)],
		["source_enrollment_identity_id", ""],
		["reviewed_weak_labels_json", "{}"],
		["reviewed_weak_labels_json", "not-json"],
	];
	for (const field of [
		"coordinator_id",
		"resolution_id",
		"device_id",
		"owner_identity_id",
		"source_attestation_id",
		"source_group_id",
		"source_enrollment_identity_id",
		"source_review_receipt_id",
	]) {
		for (const value of ["", " C", "C ", "C\nB", "C\u0000B", "x".repeat(257), 1])
			invalidFields.push([field, value]);
	}
	for (const field of [
		"key_id",
		"source_fingerprint",
		"source_evidence_digest",
		"resolution_evidence_digest",
	]) {
		for (const value of ["A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), null])
			invalidFields.push([field, value]);
	}
	for (const field of ["source_created_at", "created_at"]) {
		for (const value of ["yesterday", "2026-02-30T00:00:00.000Z", "2026-10-22", "", 1])
			invalidFields.push([field, value]);
	}
	it.each(invalidFields)("rejects malformed %s (%#)", async (field, value) => {
		// Arrange
		const raw = record({ [field]: value });
		// Act
		const captured = await captureLegacyOwnerResolutionRecord(raw);
		// Assert
		expect(captured).toBeNull();
	});

	it.each([null, [], "record", 1, undefined].map((raw) => ({ raw })))(
		"rejects non-record input %#",
		async ({ raw }) => {
			// Arrange: raw is intentionally not a row.
			// Act
			const captured = await captureLegacyOwnerResolutionRecord(raw);
			// Assert
			expect(captured).toBeNull();
		},
	);

	it.each([
		` ${JSON.stringify([weak()])}`,
		JSON.stringify([weak()], null, 2),
		JSON.stringify([Object.fromEntries(Object.entries(weak()).reverse())]),
		`[${JSON.stringify(weak()).replace('"label":"C"', '"label":"B","label":"C"')}]`,
		JSON.stringify([weak({ label: "Z" }), weak({ label: "A" })]),
		JSON.stringify([weak(), weak()]),
	])("rejects stored JSON that is not already canonical (%#)", async (json) => {
		// Arrange
		const raw = record({ reviewed_weak_labels_json: json });
		// Act
		const captured = await captureLegacyOwnerResolutionRecord(raw);
		// Assert
		expect(captured).toBeNull();
	});
});

describe("canonical weak-label metadata (display only, not provenance proof)", () => {
	it("uses fixed field order and binary order, independent of locale and input order", () => {
		// Arrange: these labels distinguish binary order from common locale collations.
		const expected = [weak({ label: "Z" }), weak({ label: "a" }), weak({ label: "ä" })];
		const raw = expected
			.toReversed()
			.map((entry) => Object.fromEntries(Object.entries(entry).reverse()));
		const before = structuredClone(raw);
		const locale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
			throw new Error("locale forbidden");
		});
		// Act
		const canonical = canonicalReviewedWeakLabels(raw);
		// Assert
		expect(canonical).toBe(JSON.stringify(expected));
		expect(raw).toEqual(before);
		expect(locale).not.toHaveBeenCalled();
	});

	it("retains distinct source references and both accepted categories for the same label", () => {
		// Arrange: syntactically valid references are not claims that server records exist.
		const entries = [
			weak(),
			weak({ evidence_ref: "f".repeat(64) }),
			weak({ kind: "consumed_project_actor_label" }),
		];
		// Act
		const canonical = canonicalReviewedWeakLabels(entries);
		// Assert
		expect(canonical).not.toBeNull();
		expect(JSON.parse(canonical ?? "null")).toHaveLength(3);
		expect(canonicalReviewedWeakLabels(entries.toReversed())).toBe(canonical);
	});

	it.each(
		[[], Array.from({ length: 256 }, (_, i) => weak({ label: `C-${i}` }))].map((raw) => ({ raw })),
	)("accepts empty and 256-entry arrays (%#)", ({ raw }) => {
		// Arrange: raw is within the entry and byte limits.
		// Act
		const canonical = canonicalReviewedWeakLabels(raw);
		// Assert
		expect(typeof canonical).toBe("string");
		expect(JSON.parse(canonical ?? "null")).toHaveLength(raw.length);
	});

	it("enforces the 131072-byte UTF-8 limit rather than string length", () => {
		// Arrange: pad valid fields to the exact byte limit using multibyte labels.
		const raw = Array.from({ length: 256 }, (_, i) => weak({ label: `é-${i}`, group_id: "g" }));
		let remaining = 131072 - Buffer.byteLength(JSON.stringify(raw));
		for (const entry of raw) {
			for (const field of ["label", "group_id", "device_id"] as const) {
				const padding = Math.min(256 - entry[field].length, remaining);
				entry[field] += "x".repeat(padding);
				remaining -= padding;
			}
		}
		const oversized = structuredClone(raw);
		oversized[255].group_id += "x";
		// Act
		const accepted = canonicalReviewedWeakLabels(raw);
		const rejected = canonicalReviewedWeakLabels(oversized);
		// Assert
		expect(remaining).toBe(0);
		expect(Buffer.byteLength(accepted ?? "")).toBe(131072);
		expect(rejected).toBeNull();
	});

	const invalidEntries = [
		weak({ kind: "submitted_memory_author" }),
		weak({ kind: "owner_invite" }),
		weak({ effect: "scope_owner" }),
		weak({ token: "synthetic-marker" }),
		weak({ label: " C" }),
		weak({ label: "C\u0000" }),
		weak({ label: "x".repeat(257) }),
		weak({ group_id: "" }),
		weak({ device_id: "B\nC" }),
		weak({ evidence_ref: "" }),
	];
	it.each(invalidEntries)("rejects malformed or authority-bearing weak metadata (%#)", (entry) => {
		// Arrange
		const raw = [entry];
		// Act
		const canonical = canonicalReviewedWeakLabels(raw);
		// Assert
		expect(canonical).toBeNull();
	});

	it.each(["__proto__", "constructor", "hidden", Symbol("extra")])(
		"rejects extra weak-entry properties without reading them (%#)",
		(field) => {
			// Arrange
			const entry = weak();
			const getter = vi.fn(() => {
				throw new Error("getter forbidden");
			});
			Object.defineProperty(entry, field, { get: getter });
			// Act
			const canonical = canonicalReviewedWeakLabels([entry]);
			// Assert
			expect(canonical).toBeNull();
			expect(getter).not.toHaveBeenCalled();
		},
	);

	it.each(Object.keys(weak()))("requires own data field %s without invoking accessors", (field) => {
		// Arrange
		const entry = weak();
		const getter = vi.fn(() => {
			throw new Error("getter forbidden");
		});
		Reflect.deleteProperty(entry, field);
		const inherited = Object.assign(
			Object.create({ [field]: weak()[field as keyof ReturnType<typeof weak>] }),
			entry,
		);
		const accessor = Object.defineProperty({ ...entry }, field, { get: getter, enumerable: true });
		// Act
		const results = [entry, inherited, accessor].map((value) =>
			canonicalReviewedWeakLabels([value]),
		);
		// Assert
		expect(results).toEqual([null, null, null]);
		expect(getter).not.toHaveBeenCalled();
	});

	it.each(
		[
			null,
			{},
			"[]",
			[weak(), weak()],
			Array.from({ length: 257 }, (_, i) => weak({ label: `C-${i}` })),
		].map((raw) => ({ raw })),
	)("rejects nonarrays, identical duplicates and entry overflow (%#)", ({ raw }) => {
		// Arrange: raw violates the array contract.
		// Act
		const canonical = canonicalReviewedWeakLabels(raw);
		// Assert
		expect(canonical).toBeNull();
	});
});

const schemaCases: [string, string, "ready" | "missing" | "unsupported"][] = [
	["completely absent", "", "missing"],
	["exact module installation", LEGACY_OWNER_RESOLUTION_SCHEMA_SQL, "ready"],
	[
		"equivalent formatting/comments",
		LEGACY_OWNER_RESOLUTION_SCHEMA_SQL.replaceAll("IF NOT EXISTS", "").replaceAll(
			"CREATE INDEX",
			"/* fixture */ CREATE   INDEX",
		),
		"ready",
	],
	["wrong table", `CREATE TABLE ${table} (resolution_id TEXT)`, "unsupported"],
	["incomplete installation", LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS[0], "unsupported"],
	[
		"missing device index",
		`${LEGACY_OWNER_RESOLUTION_SCHEMA_SQL}\nDROP INDEX idx_legacy_owner_resolutions_device;`,
		"unsupported",
	],
	[
		"missing key index",
		`${LEGACY_OWNER_RESOLUTION_SCHEMA_SQL}\nDROP INDEX idx_legacy_owner_resolutions_key;`,
		"unsupported",
	],
	[
		"changed table check",
		LEGACY_OWNER_RESOLUTION_SCHEMA_SQL.replace("resolution_version = 1", "resolution_version = 2"),
		"unsupported",
	],
	[
		"changed lookup index",
		LEGACY_OWNER_RESOLUTION_SCHEMA_SQL.replace(
			"(coordinator_id, key_id);",
			"(key_id, coordinator_id);",
		),
		"unsupported",
	],
	[
		"changed collision guard",
		LEGACY_OWNER_RESOLUTION_SCHEMA_SQL.replace(
			"key_id = NEW.key_id AND owner_identity_id <> NEW.owner_identity_id",
			"key_id = NEW.key_id AND 0",
		),
		"unsupported",
	],
	[
		"unknown attached trigger",
		`${LEGACY_OWNER_RESOLUTION_SCHEMA_SQL}\nCREATE TRIGGER extra_resolution_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END;`,
		"unsupported",
	],
];
for (const trigger of ["insert_collision", "immutable_update", "immutable_delete"]) {
	schemaCases.push([
		`missing ${trigger}`,
		`${LEGACY_OWNER_RESOLUTION_SCHEMA_SQL}\nDROP TRIGGER legacy_owner_resolution_${trigger};`,
		"unsupported",
	]);
}

describe("read-only exact sidecar schema readiness", () => {
	it.each(schemaCases)(
		"classifies %s without changing schema or data",
		async (_name, ddl, expected) => {
			// Arrange: schema mutations here affect only a new private in-memory test database.
			const db: SqliteDatabase = new Database(":memory:");
			try {
				db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('unchanged');");
				db.exec(ddl);
				if (expected === "ready") {
					const row = record();
					db.prepare(
						`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
							.map(() => "?")
							.join(",")})`,
					).run(...Object.values(row));
				}
				const before = db.serialize();
				const first = vi.fn<Pick<AuthLinkBackend, "first">["first"]>(async ({ sql, values }) => {
					expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i);
					return (db.prepare(sql).get(...values) ?? null) as never;
				});
				// Act: only first is supplied; no run/batch/install capability is available.
				const state = await readLegacyOwnerResolutionSchemaState({ first });
				// Assert
				expect(state).toBe(expected);
				expect(first).toHaveBeenCalled();
				expect(db.serialize()).toEqual(before);
			} finally {
				db.close();
			}
		},
	);
});
