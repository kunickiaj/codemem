import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./d1-coordinator-store.js";
import { RELAY_CLOCK_TEST_SCHEMA_SQL } from "./relay-admission-clock-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import {
	METADATA_CONTEXT,
	METADATA_INSERT_SQL,
	METADATA_READINESS_INSERT,
	METADATA_REALM_INSERT,
	metadataBindings,
	metadataSeed,
} from "./relay-admission-metadata-test-fixtures.js";
import { d1RelayHealthPublisher, sqliteRelayHealthPublisher } from "./relay-health-storage.js";

let db: Database.Database;
const namespace = { authorityId: METADATA_CONTEXT.authority, groupId: METADATA_CONTEXT.group };
function seed(omit?: "realmHealth") {
	for (const entry of metadataSeed({ omit }))
		db.prepare(entry.sql).run(Object.fromEntries(entry.values.map((value, i) => [i + 1, value])));
}
function seedRealm(group: string) {
	for (const entry of metadataSeed({ group }).filter(
		(entry) =>
			entry.sql === METADATA_REALM_INSERT ||
			(entry.sql === METADATA_READINESS_INSERT && entry.values[1] === "realm"),
	)) {
		db.prepare(entry.sql).run(Object.fromEntries(entry.values.map((value, i) => [i + 1, value])));
	}
}
function freezeAdmissionClock() {
	db.function("strftime", (format: string, when: string) => {
		if (when !== "now") throw new Error("unexpected clock argument");
		if (format === "%s") return "130";
		if (format === "%f") return "10.000";
		return "1970-01-01T00:02:10.000Z";
	});
}
function rows() {
	return db
		.prepare(
			"SELECT scope,revision,state,observed_at_ms FROM relay_admission_readiness ORDER BY scope",
		)
		.all();
}
class Statement implements D1PreparedStatementLike {
	values: unknown[] = [];
	constructor(readonly sql: string) {}
	bind(...values: unknown[]) {
		this.values = values;
		return this;
	}
	async first<T>() {
		return (db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
	}
	async all<T>() {
		return { results: db.prepare(this.sql).all(...this.values) as T[] };
	}
	async raw<T>() {
		return db
			.prepare(this.sql)
			.raw()
			.all(...this.values) as T[];
	}
	execute() {
		return { success: true, meta: { changes: db.prepare(this.sql).run(...this.values).changes } };
	}
	async run() {
		return this.execute();
	}
}
function d1Fixture() {
	const prepare = vi.fn((sql: string) => new Statement(sql));
	const batch = vi.fn(
		async (statements: D1PreparedStatementLike[]): Promise<unknown[]> =>
			db.transaction(() => statements.map((statement) => (statement as Statement).execute()))(),
	);
	const backend: D1DatabaseLike = { prepare, batch };
	return { backend, prepare, batch };
}
beforeEach(() => {
	db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(RELAY_CLOCK_TEST_SCHEMA_SQL);
	for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) db.exec(sql);
});
afterEach(() => {
	db.close();
	vi.restoreAllMocks();
});

describe.each(["sqlite", "d1"] as const)("%s durable relay health", (backend) => {
	function publisher(groupId = namespace.groupId) {
		const close = vi.fn();
		const d1 = d1Fixture();
		const target = { ...namespace, groupId };
		const publish =
			backend === "sqlite"
				? sqliteRelayHealthPublisher(() => ({ db, close }), target)
				: d1RelayHealthPublisher(d1.backend, target);
		return { publish, close, ...d1 };
	}
	it("increments the captured revision once for both authority and realm", async () => {
		// Arrange
		seed();
		const f = publisher();
		// Act
		const first = await f.publish({ state: "ready", observedAtMs: 130000 });
		const second = await f.publish({ state: "tripped", observedAtMs: null });
		// Assert
		expect([first, second]).toEqual([2, 3]);
		expect(rows()).toEqual(
			["authority", "realm"].map((scope) => ({
				scope,
				revision: 3,
				state: "tripped",
				observed_at_ms: null,
			})),
		);
		if (backend === "sqlite") expect(f.close).toHaveBeenCalledTimes(2);
		else expect(f.batch).toHaveBeenCalledTimes(2);
	});
	it.each(["tripped", "ready"] as const)(
		"publishes %s for a realm behind another realm's authority revision",
		async (state) => {
			// Arrange: realm B remains admissible at revision 1 after A advances to 2.
			seed();
			const groupId = "group-B";
			seedRealm(groupId);
			freezeAdmissionClock();
			const insert = (nonce: string) => {
				const bindings = metadataBindings({ group: groupId });
				bindings[1] = nonce;
				return db
					.prepare(METADATA_INSERT_SQL)
					.get(Object.fromEntries(bindings.map((value, i) => [i + 1, value])));
			};
			expect(await publisher().publish({ state: "ready", observedAtMs: 130000 })).toBe(2);
			expect(insert("3".repeat(32))).toBeDefined();
			const observedAtMs = state === "ready" ? 130001 : null;
			// Act
			const revision = await publisher(groupId).publish({ state, observedAtMs });
			const admitted = insert("4".repeat(32));
			// Assert: publication must refresh B or disable its real final nonce gate.
			expect.soft(revision).toBe(3);
			expect.soft(admitted !== undefined).toBe(state === "ready");
			expect
				.soft(
					db
						.prepare(
							"SELECT revision,state,observed_at_ms FROM relay_admission_readiness WHERE scope='authority' OR group_id=?",
						)
						.all(groupId),
				)
				.toEqual(Array(2).fill({ revision: 3, state, observed_at_ms: observedAtMs }));
		},
	);
	it("does not install missing metadata or fabricate a successful receipt", async () => {
		// Arrange
		seed("realmHealth");
		const f = publisher();
		const before = rows();
		// Act
		const revision = await f.publish({ state: "ready", observedAtMs: 130000 });
		// Assert
		expect(revision).toBeNull();
		expect(rows()).toEqual(before);
		expect(f.batch).not.toHaveBeenCalled();
	});
	it("rolls back the authority update if the realm update fails", async () => {
		// Arrange
		seed();
		db.exec(
			"CREATE TRIGGER health_fixture_abort BEFORE UPDATE ON relay_admission_readiness WHEN NEW.scope='realm' BEGIN SELECT RAISE(ABORT,'fixture'); END",
		);
		const f = publisher();
		const before = rows();
		// Act
		const revision = await f.publish({ state: "tripped", observedAtMs: null });
		// Assert
		expect(revision).toBeNull();
		expect(rows()).toEqual(before);
	});
	it("fails closed when the readiness schema is absent", async () => {
		// Arrange
		db.close();
		db = new Database(":memory:");
		const f = publisher();
		// Act
		const revision = await f.publish({ state: "ready", observedAtMs: 130000 });
		// Assert
		expect(revision).toBeNull();
		expect(f.batch).not.toHaveBeenCalled();
	});
	it("makes a published ready stamp available to the real final nonce condition and denies a trip", async () => {
		// Arrange
		seed();
		freezeAdmissionClock();
		const f = publisher();
		const insert = (nonce: string) => {
			const bindings = metadataBindings();
			bindings[1] = nonce;
			return db
				.prepare(METADATA_INSERT_SQL)
				.get(Object.fromEntries(bindings.map((value, i) => [i + 1, value])));
		};
		// Act
		await f.publish({ state: "ready", observedAtMs: 130000 });
		const ready = insert("1".repeat(32));
		await f.publish({ state: "tripped", observedAtMs: null });
		const denied = insert("2".repeat(32));
		// Assert
		expect(ready).toBeDefined();
		expect(denied).toBeUndefined();
		expect(db.prepare("SELECT count(*) AS count FROM relay_clock_test_nonces").get()).toEqual({
			count: 1,
		});
	});
});

describe("D1 publication receipts and races", () => {
	it.each([
		[],
		[{ success: true, meta: { changes: 1 } }],
		[
			{ success: true, meta: { changes: 1 } },
			{ success: true, meta: { changes: 0 } },
		],
		[{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
	])("rejects unknown or incomplete receipts without retry or readback: %j", async (receipts) => {
		// Arrange
		seed();
		const f = d1Fixture();
		f.batch.mockResolvedValue(receipts);
		// Act
		const revision = await d1RelayHealthPublisher(
			f.backend,
			namespace,
		)({ state: "ready", observedAtMs: 130000 });
		// Assert
		expect(revision).toBeNull();
		expect(f.batch).toHaveBeenCalledTimes(1);
		expect(f.prepare).toHaveBeenCalledTimes(3);
	});
	it("aborts a stale captured revision instead of silently updating zero rows", async () => {
		// Arrange
		seed();
		const f = d1Fixture();
		const nativeBatch = f.batch.getMockImplementation();
		f.batch.mockImplementation(async (statements) => {
			db.transaction(() => {
				db.prepare("UPDATE relay_admission_readiness SET revision=2 WHERE scope='authority'").run();
				db.prepare("UPDATE relay_admission_readiness SET revision=2 WHERE scope='realm'").run();
			})();
			if (!nativeBatch) throw new Error("missing fixture batch");
			return nativeBatch(statements);
		});
		// Act
		const revision = await d1RelayHealthPublisher(
			f.backend,
			namespace,
		)({ state: "tripped", observedAtMs: null });
		// Assert
		expect(revision).toBeNull();
		expect(rows()).toEqual(
			["authority", "realm"].map((scope) => ({
				scope,
				revision: 2,
				state: "ready",
				observed_at_ms: 130000,
			})),
		);
		expect(f.batch).toHaveBeenCalledTimes(1);
	});
	it("does not degrade to separate writes when atomic batch is unavailable", async () => {
		// Arrange
		seed();
		const f = d1Fixture();
		delete f.backend.batch;
		// Act
		const revision = await d1RelayHealthPublisher(
			f.backend,
			namespace,
		)({ state: "ready", observedAtMs: 130000 });
		// Assert
		expect(revision).toBeNull();
		expect(f.prepare).not.toHaveBeenCalled();
	});
});
