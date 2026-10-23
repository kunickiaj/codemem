import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	LEGACY_OWNER_RESOLUTION_SCHEMA_SQL,
	LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS,
} from "../../core/src/coordinator-legacy-owner-resolution-schema.js";

const db = env.COORDINATOR_DB;
const table = "coordinator_legacy_owner_resolutions";
// ECMAScript WhiteSpace + LineTerminator, including BOM (not Unicode White_Space).
const trimWhitespace = [
	..."\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
];
// Inert synthetic metadata, not authenticated ownership or cryptographic proof.
function receipt() {
	return {
		coordinator_id: randomUUID(),
		resolution_id: `resolution-a-${randomUUID()}`,
		resolution_version: 1,
		device_id: randomUUID(),
		key_id: "a".repeat(64),
		owner_identity_id: "synthetic-owner-a",
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: randomUUID(),
		source_group_id: randomUUID(),
		source_controller_revision: 1,
		source_public_key: " original synthetic public key text\n",
		source_fingerprint: "b".repeat(64),
		source_enrollment_identity_id: null,
		source_created_at: "2026-10-01T00:00:00.000Z",
		source_review_receipt_id: "synthetic-original-review",
		source_evidence_digest: "c".repeat(64),
		resolution_evidence_digest: "d".repeat(64),
		reviewed_weak_labels_json: "[]",
		created_at: "2026-10-22T00:00:00.000Z",
	};
}
type Row = Record<keyof ReturnType<typeof receipt>, string | number | null>;
function insert(row: Row, verb: "INSERT" | "INSERT OR REPLACE" = "INSERT") {
	const entries = Object.entries(row);
	return db
		.prepare(
			`${verb} INTO ${table} (${entries.map(([name]) => name).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
		)
		.bind(...entries.map(([, value]) => value))
		.run();
}
async function rows(coordinator: string) {
	return (
		await db
			.prepare(`SELECT * FROM ${table} WHERE coordinator_id=? ORDER BY resolution_id`)
			.bind(coordinator)
			.all()
	).results;
}

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

it("native migrated resolution DDL matches source and preserves WITHOUT ROWID, indexes and no foreign keys", async () => {
	// Arrange: source DDL is idempotent on the already migrated ephemeral binding.
	const definitions = () =>
		db
			.prepare(
				"SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL ORDER BY type,name",
			)
			.bind(table)
			.all<{ type: string; name: string; sql: string }>();
	const before = await definitions();
	// Act
	await db.batch(LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
	const after = await definitions();
	const indexes = await db
		.prepare("SELECT name FROM pragma_index_list(?)")
		.bind(table)
		.all<{ name: string }>();
	const indexedColumns = await Promise.all(
		indexes.results.map(
			async ({ name }) =>
				(await db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").bind(name).all())
					.results,
		),
	);
	// Assert: raw rowid access is invalid, not a reason to alter the storage contract.
	expect(after.results).toEqual(before.results);
	const ddl = after.results.find(({ type }) => type === "table")?.sql;
	const normalize = (sql: string) =>
		sql.replaceAll("IF NOT EXISTS ", "").replace(/\s+/gu, " ").trim().replace(/;$/u, "");
	expect(normalize(ddl ?? "")).toBe(normalize(LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS[0]));
	expect(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL).toContain("WITHOUT ROWID");
	expect(indexedColumns).toEqual(
		expect.arrayContaining([
			[{ name: "coordinator_id" }, { name: "device_id" }],
			[{ name: "coordinator_id" }, { name: "key_id" }],
		]),
	);
	expect(
		(await db.prepare("SELECT * FROM pragma_foreign_key_list(?)").bind(table).all()).results,
	).toEqual([]);
	await expect(db.prepare(`SELECT rowid FROM ${table} LIMIT 1`).all()).rejects.toThrow(/rowid/u);
});

it("native storage retains exact source metadata and permits distinct same-owner appends", async () => {
	// Arrange
	const first = receipt();
	await insert(first);
	const next = {
		...first,
		resolution_id: `resolution-b-${randomUUID()}`,
		source_enrollment_identity_id: "synthetic-original-label",
		resolution_evidence_digest: "e".repeat(64),
	};
	// Act
	await insert(next);
	// Assert: storage acceptance alone grants no account, controller or membership authority.
	expect(await rows(first.coordinator_id)).toEqual([first, next]);
});

it("native collision checks isolate coordinators and allow unrelated devices/keys with another owner", async () => {
	// Arrange
	const first = receipt();
	await insert(first);
	const otherCoordinator = {
		...first,
		coordinator_id: randomUUID(),
		owner_identity_id: "synthetic-owner-b",
	};
	const unrelated = {
		...first,
		resolution_id: `resolution-b-${randomUUID()}`,
		device_id: randomUUID(),
		key_id: "e".repeat(64),
		owner_identity_id: "synthetic-owner-b",
	};
	// Act
	await insert(otherCoordinator);
	await insert(unrelated);
	// Assert
	expect(await rows(first.coordinator_id)).toEqual([first, unrelated]);
	expect(await rows(otherCoordinator.coordinator_id)).toEqual([otherCoordinator]);
});

it("native canonical identifiers accept accented and CJK text while retaining nullable and source bytes", async () => {
	// Arrange: use an isolated namespace because native receipts are immutable.
	const first = {
		...receipt(),
		coordinator_id: `identité-雪-${randomUUID()}`,
		resolution_id: "résolution-雪-a",
		device_id: "appareil-雪",
		owner_identity_id: "propriétaire-雪",
		source_attestation_id: "attesté-雪",
		source_group_id: "équipe-雪",
		source_review_receipt_id: "révision-雪",
	};
	const next = {
		...first,
		resolution_id: "résolution-雪-b",
		source_enrollment_identity_id: "inscrit-雪",
	};
	// Act
	await insert(first);
	await insert(next);
	// Assert: the null enrollment and original public-key whitespace remain exact.
	expect(await rows(first.coordinator_id)).toEqual([first, next]);
});

it("native storage retains internal trim whitespace and non-trim edge characters exactly", async () => {
	// NEL, MVS and zero-width space are not part of ECMAScript String.trim.
	const first = {
		...receipt(),
		device_id: `\u0085\u180e\u200bdevice${trimWhitespace.join("")}a\u0085\u180e\u200b`,
	};
	expect(first.device_id.trim()).toBe(first.device_id);
	await insert(first);
	expect(await rows(first.coordinator_id)).toEqual([first]);
});

it.each([
	"coordinator_id",
	"resolution_id",
	"device_id",
	"owner_identity_id",
	"source_attestation_id",
	"source_group_id",
	"source_review_receipt_id",
	"source_enrollment_identity_id",
] as const)(
	"native canonical %s CHECK rejects whitespace aliases without changing retained history",
	async (column) => {
		// Arrange: different keys/devices avoid unrelated collision-trigger failures.
		const first = receipt();
		await insert(first);
		const invalid = {
			...first,
			resolution_id: `resolution-b-${randomUUID()}`,
			device_id: randomUUID(),
			key_id: "e".repeat(64),
			owner_identity_id: "synthetic-owner-b",
		};
		for (const space of trimWhitespace) {
			// Device aliases use the retained device, but a different key and owner.
			const canonical = first[column] ?? "synthetic-enrollment";
			for (const value of [`${space}${canonical}`, `${canonical}${space}`, space]) {
				// Act / Assert: isolate CHECK rejection from exact collision probes.
				expect(value.trim()).not.toBe(value);
				await expect(insert({ ...invalid, [column]: value })).rejects.toThrow(
					/CHECK constraint failed/u,
				);
				if (column === "coordinator_id") expect(await rows(value)).toEqual([]);
			}
		}
		expect(await rows(first.coordinator_id)).toEqual([first]);
	},
);

it.each(["device", "key"] as const)(
	"native different-owner %s collision aborts without erasing retained history",
	async (match) => {
		// Arrange
		const first = receipt();
		await insert(first);
		const patch = match === "device" ? { key_id: "e".repeat(64) } : { device_id: randomUUID() };
		// Act
		const pending = insert({
			...first,
			...patch,
			resolution_id: randomUUID(),
			owner_identity_id: "synthetic-owner-b",
		});
		// Assert
		await expect(pending).rejects.toThrow(/legacy_owner_resolution_collision/u);
		expect(await rows(first.coordinator_id)).toEqual([first]);
	},
);

it.each(["UPDATE", "DELETE", "INSERT OR REPLACE"] as const)(
	"native %s cannot mutate the original resolution receipt",
	async (verb) => {
		// Arrange
		const first = receipt();
		await insert(first);
		// Act
		let pending: Promise<unknown>;
		if (verb === "UPDATE")
			pending = db
				.prepare(
					`UPDATE ${table} SET resolution_evidence_digest=? WHERE coordinator_id=? AND resolution_id=?`,
				)
				.bind("e".repeat(64), first.coordinator_id, first.resolution_id)
				.run();
		else if (verb === "DELETE")
			pending = db
				.prepare(`DELETE FROM ${table} WHERE coordinator_id=? AND resolution_id=?`)
				.bind(first.coordinator_id, first.resolution_id)
				.run();
		else pending = insert({ ...first, source_review_receipt_id: "changed-original-review" }, verb);
		// Assert
		await expect(pending).rejects.toThrow(/legacy_owner_resolution_(?:collision|immutable)/u);
		expect(await rows(first.coordinator_id)).toEqual([first]);
	},
);

it.each(["version", "purpose", "scope", "hash"] as const)(
	"native %s constraints reject invalid metadata after accepting valid metadata",
	async (kind) => {
		// Arrange
		const first = receipt();
		await insert(first);
		const invalid: Record<typeof kind, Partial<Row>[]> = {
			version: [{ resolution_version: 2 }, { source_controller_revision: 2 }],
			purpose: [{ purpose: "owner_transfer" }],
			scope: [{ scope: "all_owner_authority" }],
			hash: [
				{ key_id: "A".repeat(64) },
				{ source_fingerprint: "not-a-hash" },
				{ source_evidence_digest: "c".repeat(63) },
				{ resolution_evidence_digest: "D".repeat(64) },
			],
		};
		// Act / Assert: every rejected append preserves the accepted source bytes.
		for (const patch of invalid[kind]) {
			await expect(insert({ ...first, ...patch, resolution_id: randomUUID() })).rejects.toThrow(
				/CHECK constraint failed/u,
			);
			expect(await rows(first.coordinator_id)).toEqual([first]);
		}
	},
);

it.each(["malformed", "object", "oversized"] as const)(
	"native reviewed-label JSON rejects %s without extra receipts",
	async (kind) => {
		// Arrange
		const first = receipt();
		await insert(first);
		let json = "[";
		if (kind === "object") json = "{}";
		if (kind === "oversized") json = JSON.stringify(["雪".repeat(43690)]);
		// Act
		const pending = insert({
			...first,
			resolution_id: randomUUID(),
			reviewed_weak_labels_json: json,
		});
		// Assert: the UTF-8 byte cap applies even when the character count is below it.
		if (kind === "oversized") {
			expect(json.length).toBeLessThan(131072);
			expect(new TextEncoder().encode(json).length).toBeGreaterThan(131072);
		}
		await expect(pending).rejects.toThrow(/CHECK constraint failed/u);
		expect(await rows(first.coordinator_id)).toEqual([first]);
	},
);

it("native reviewed-label JSON accepts the exact byte cap and refuses one byte more", async () => {
	// Arrange
	const first = { ...receipt(), reviewed_weak_labels_json: JSON.stringify(["x".repeat(131068)]) };
	expect(new TextEncoder().encode(first.reviewed_weak_labels_json)).toHaveLength(131072);
	// Act
	await insert(first);
	const pending = insert({
		...first,
		resolution_id: randomUUID(),
		reviewed_weak_labels_json: JSON.stringify(["x".repeat(131069)]),
	});
	// Assert
	await expect(pending).rejects.toThrow(/CHECK constraint failed/u);
	expect(await rows(first.coordinator_id)).toEqual([first]);
});
