import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	type RelayQuotaContractHost,
	type RelayQuotaContractStorage,
	registerRelayQuotaContract,
} from "./relay-quota-contract-test-fixtures.js";
import {
	createExclusiveWriterRelayQuota,
	createSqliteRelayQuota,
	initializeRelayQuotaSchema,
	provisionLocalRelayQuota,
	type RelayQuotaDatabase,
	type RelayQuotaProfile,
	setRelayQuotaEnabled,
} from "./relay-quota-sqlite.js";

const realmId = "a".repeat(64);
const signal = () => new AbortController().signal;
const allocation = { ratePerMinute: 1, burst: 4 };
const profile: RelayQuotaProfile = {
	upgrade: { service: allocation, realm: allocation },
	control: { service: allocation, realm: allocation, device: allocation },
	open: {
		service: allocation,
		realm: allocation,
		device: allocation,
		pair: { ...allocation, burst: 2 },
	},
	traffic: { service: allocation, realm: allocation, device: allocation, pair: allocation },
};
const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) if (database.open) database.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function database(path = ":memory:") {
	const db = new Database(path);
	databases.push(db);
	// Freeze the external clock inside SQLite, while executing the real quota SQL.
	// Neither sleeps nor application Date values participate in quota decisions.
	db.function("strftime", { varargs: true }, (format) => {
		if (format === "%s") return "1800000000";
		if (format === "%f") return "00.000";
		throw new Error("Unexpected quota clock format");
	});
	return db;
}
function fixture(selected: RelayQuotaProfile = profile, db = database()) {
	initializeRelayQuotaSchema(db);
	provisionLocalRelayQuota(db, { realmId, profile: selected });
	setRelayQuotaEnabled(db, { realmId, enabled: true });
	return { db, quota: adapter(db) };
}
function adapter(db: RelayQuotaDatabase) {
	return createSqliteRelayQuota({ database: db, realmId, enabled: true });
}
function request(
	purpose: "control" | "open" | "traffic" = "traffic",
	units = 1,
	deviceId = "a",
	peerDeviceId = "b",
) {
	return {
		purpose,
		units,
		realmId,
		deviceId,
		peerDeviceId: purpose === "control" ? null : peerDeviceId,
	};
}
function buckets(db: Database.Database) {
	return db.prepare("SELECT * FROM relay_quota_buckets ORDER BY purpose,scope,subject").all();
}
function boundary(
	db: Database.Database,
	options: { before?: () => void; after?: () => void; fail?: boolean; reads?: string[] },
): RelayQuotaDatabase {
	return {
		exec: (sql) => db.exec(sql),
		prepare(sql) {
			const statement = db.prepare(sql);
			return {
				get(...bindings) {
					options.reads?.push(sql);
					return statement.get(...bindings);
				},
				run: (...bindings) => statement.run(...bindings),
			};
		},
		transaction(operation) {
			return {
				immediate() {
					options.before?.();
					const result = db.transaction(operation).immediate();
					options.after?.();
					if (options.fail) throw new Error("Commit receipt unavailable");
					return result;
				},
			};
		},
	};
}

/** File-backed so `restart` can close and reopen the same database. */
async function nodeHost(): Promise<RelayQuotaContractHost> {
	const directory = mkdtempSync(join(tmpdir(), "relay-quota-contract-"));
	directories.push(directory);
	const path = join(directory, "quota.sqlite");
	let db = database(path);
	const storage = (): RelayQuotaContractStorage => ({
		database: db,
		rows: (sql, ...bindings) => db.prepare(sql).all(...bindings) as Record<string, unknown>[],
		quota: (options) => createSqliteRelayQuota({ database: db, ...options }),
	});
	return {
		use: async (operation) => operation(storage()),
		restart: async () => {
			db.close();
			db = database(path);
		},
	};
}

describe("better-sqlite3 relay quota contract", () => {
	registerRelayQuotaContract(nodeHost);
});

describe("quota intersections and fixed-point units", () => {
	it.each([0, -1, 1.5, Number.NaN, 268435457])(
		"rejects invalid units %s without charging",
		async (units) => {
			// Arrange
			const { db, quota } = fixture();
			// Act
			const result = await quota.reserve(request("traffic", units), signal());
			// Assert
			expect(result).toBe("denied");
			expect(buckets(db)).toEqual([]);
			expect(await quota.reserve(request("traffic", 4), signal())).toBe("reserved");
		},
	);

	it.each([59999, 60000])(
		"requires exactly 60000 fixed-point units (balance %s)",
		async (balance) => {
			// Arrange
			const { db, quota } = fixture();
			await quota.reserve(request(), signal());
			db.prepare("UPDATE relay_quota_buckets SET balance=?").run(balance);
			const snapshot = buckets(db);
			// Act
			const result = await quota.reserve(request(), signal());
			// Assert
			expect(result).toBe(balance === 60000 ? "reserved" : "denied");
			if (balance === 59999) expect(buckets(db)).toEqual(snapshot);
			else
				expect(buckets(db).every((row) => (row as { balance: number }).balance === 0)).toBe(true);
		},
	);
});

describe("policy writes retain quota floors independently of reservations", () => {
	it("retains service and realm floors when a later pair denial rolls consumption back", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.prepare("UPDATE relay_quota_buckets SET balance=0 WHERE scope='pair'").run();
		// Act
		db.prepare(
			"UPDATE relay_quota_allocations SET rate=1,burst=2 WHERE purpose='traffic' AND scope IN ('service','realm')",
		).run();
		const snapshot = buckets(db);
		const denied = await quota.reserve(request(), signal());
		// Assert: the request is atomic, but the prior policy transaction already tightened parents.
		expect(denied).toBe("denied");
		expect(buckets(db)).toEqual(snapshot);
		expect(
			db
				.prepare(
					"SELECT scope,balance,last_rate,last_capacity FROM relay_quota_buckets WHERE scope IN ('service','realm') ORDER BY scope",
				)
				.all(),
		).toEqual([
			{ scope: "realm", balance: 120000, last_rate: 1, last_capacity: 120000 },
			{ scope: "service", balance: 120000, last_rate: 1, last_capacity: 120000 },
		]);
	});

	it("retains floors across allocation deletion and reinsertion without an intervening reservation", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		// Act
		db.prepare(
			"UPDATE relay_quota_allocations SET rate=1,burst=1 WHERE purpose='traffic' AND scope='service'",
		).run();
		db.prepare(
			"DELETE FROM relay_quota_allocations WHERE purpose='traffic' AND scope='service'",
		).run();
		const missing = await quota.reserve(request(), signal());
		db.prepare(
			"INSERT INTO relay_quota_allocations(purpose,scope,rate,burst) VALUES('traffic','service',2,4)",
		).run();
		const restored = await adapter(db).reserve(request("traffic", 3), signal());
		// Assert
		expect({
			missing,
			restored,
			floor: db
				.prepare("SELECT last_rate,last_capacity FROM relay_quota_buckets WHERE scope='service'")
				.get(),
		}).toEqual({
			missing: "denied",
			restored: "denied",
			floor: { last_rate: 1, last_capacity: 60000 },
		});
	});

	it("retains the old identity's floor when a tightened allocation is rekeyed", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.prepare(
			"DELETE FROM relay_quota_allocations WHERE purpose='open' AND scope='service'",
		).run();
		// Act
		db.prepare(
			"UPDATE relay_quota_allocations SET purpose='open',rate=1,burst=1 WHERE purpose='traffic' AND scope='service'",
		).run();
		db.prepare(
			"INSERT INTO relay_quota_allocations(purpose,scope,rate,burst) VALUES('traffic','service',2,4)",
		).run();
		const restored = await adapter(db).reserve(request("traffic", 3), signal());
		// Assert
		expect({
			restored,
			floor: db
				.prepare(
					"SELECT last_rate,last_capacity FROM relay_quota_buckets WHERE purpose='traffic' AND scope='service'",
				)
				.get(),
		}).toEqual({
			restored: "denied",
			floor: { last_rate: 1, last_capacity: 60000 },
		});
	});
});

describe("temporary allocation disable preserves positive quota floors", () => {
	it("initializes legacy zero and missing allocations without erasing known positive capacity", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.prepare("UPDATE relay_quota_allocations SET rate=1,burst=1 WHERE purpose='traffic'").run();
		const snapshot = buckets(db);
		db.exec(
			"DROP TRIGGER relay_quota_policy_insert; DROP TRIGGER relay_quota_policy_update; DROP TRIGGER relay_quota_policy_delete;",
		);
		db.prepare(
			"UPDATE relay_quota_allocations SET rate=0,burst=0 WHERE purpose='traffic' AND scope='service'",
		).run();
		db.prepare(
			"DELETE FROM relay_quota_allocations WHERE purpose='traffic' AND scope='realm'",
		).run();
		// Act
		const unprotected = await quota.reserve(request(), signal());
		initializeRelayQuotaSchema(db);
		const reconciled = buckets(db);
		const zero = await quota.reserve(request(), signal());
		db.prepare(
			"UPDATE relay_quota_allocations SET rate=2,burst=4 WHERE purpose='traffic' AND scope='service'",
		).run();
		const missing = await quota.reserve(request(), signal());
		db.prepare(
			"INSERT INTO relay_quota_allocations(purpose,scope,rate,burst) VALUES('traffic','realm',2,4)",
		).run();
		const resumed = await quota.reserve(request(), signal());
		const exhausted = await quota.reserve(request(), signal());
		// Assert
		expect({
			unprotected,
			zero,
			missing,
			resumed,
			exhausted,
			retainedCapacity: reconciled,
		}).toEqual({
			unprotected: "unknown",
			zero: "denied",
			missing: "denied",
			resumed: "reserved",
			exhausted: "denied",
			retainedCapacity: snapshot,
		});
	});
});

describe("explicit quota protection upgrades", () => {
	it("rejects legacy storage until explicit initialization retains its lowered policy", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.exec(
			"DROP TRIGGER relay_quota_policy_insert; DROP TRIGGER relay_quota_policy_update; DROP TRIGGER relay_quota_policy_delete;",
		);
		db.prepare("UPDATE relay_quota_allocations SET rate=1,burst=1 WHERE purpose='traffic'").run();
		const snapshot = buckets(db);
		// Act
		const legacy = adapter(db);
		const unprotected = await legacy.reserve(request(), signal());
		const unchanged = buckets(db);
		initializeRelayQuotaSchema(db);
		const floors = db
			.prepare("SELECT DISTINCT last_rate,last_capacity,balance FROM relay_quota_buckets")
			.all();
		db.prepare("UPDATE relay_quota_allocations SET rate=2,burst=4 WHERE purpose='traffic'").run();
		const restored = await legacy.reserve(request("traffic", 3), signal());
		// Assert
		expect(unprotected).toBe("unknown");
		expect(unchanged).toEqual(snapshot);
		expect(floors).toEqual([{ last_rate: 1, last_capacity: 60000, balance: 60000 }]);
		expect(restored).toBe("denied");
		expect(await legacy.reserve(request(), signal())).toBe("reserved");
	});

	it("retains INSERT OR REPLACE minima when SQLite recursive triggers are off", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.pragma("recursive_triggers = OFF");
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		// Act
		db.prepare(
			"INSERT OR REPLACE INTO relay_quota_allocations(purpose,scope,rate,burst) VALUES('traffic','service',1,1)",
		).run();
		db.prepare(
			"INSERT OR REPLACE INTO relay_quota_allocations(purpose,scope,rate,burst) VALUES('traffic','service',2,4)",
		).run();
		const oversized = await quota.reserve(request("traffic", 3), signal());
		// Assert
		expect(db.pragma("recursive_triggers", { simple: true })).toBe(0);
		expect(oversized).toBe("denied");
		expect(
			db
				.prepare(
					"SELECT last_rate,last_capacity,balance FROM relay_quota_buckets WHERE scope='service'",
				)
				.get(),
		).toEqual({ last_rate: 1, last_capacity: 60000, balance: 60000 });
		expect(await quota.reserve(request(), signal())).toBe("reserved");
	});

	it("rolls trigger installation back if legacy bucket reconciliation fails", async () => {
		// Arrange
		const { db, quota } = fixture();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.exec(
			"DROP TRIGGER relay_quota_policy_insert; DROP TRIGGER relay_quota_policy_update; DROP TRIGGER relay_quota_policy_delete;",
		);
		db.prepare("UPDATE relay_quota_allocations SET burst=1 WHERE purpose='traffic'").run();
		const snapshot = buckets(db);
		const wrapped = boundary(db, {});
		// Act
		const initialize = () =>
			initializeRelayQuotaSchema({
				...wrapped,
				exec(sql) {
					if (sql.startsWith("UPDATE relay_quota_buckets AS b SET"))
						throw new Error("Reconciliation failed");
					return db.exec(sql);
				},
			});
		// Assert: failed reconciliation must not advertise installed protection.
		expect(initialize).toThrow("Reconciliation failed");
		expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()).toEqual([]);
		expect(buckets(db)).toEqual(snapshot);
		expect(await quota.reserve(request(), signal())).toBe("unknown");
		initializeRelayQuotaSchema(db);
		expect(await quota.reserve(request(), signal())).toBe("reserved");
	});
});

describe("quota lock handling", () => {
	it("disables SQLite lock waits, attempts once without writes, and recovers after unlock", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "relay-quota-lock-test-"));
		directories.push(directory);
		const path = join(directory, "quota.sqlite");
		const { db } = fixture(profile, database(path));
		const contender = database(path);
		try {
			contender.pragma("busy_timeout = 5000");
			const reads: string[] = [];
			let attempts = 0;
			const quota = adapter(
				boundary(contender, {
					reads,
					before: () => {
						attempts++;
					},
				}),
			);
			const changes = contender.prepare("SELECT total_changes() AS count").get();
			db.exec("BEGIN IMMEDIATE");
			// Act
			const locked = await quota.reserve(request(), signal());
			// Assert: zero busy timeout proves there is no blocking wait without a wall-clock deadline.
			expect(contender.pragma("busy_timeout", { simple: true })).toBe(0);
			expect(locked).toBe("unknown");
			expect(attempts).toBe(1);
			expect(reads).toEqual([]);
			expect(contender.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
			expect(buckets(db)).toEqual([]);
			db.exec("ROLLBACK");
			expect(await quota.reserve(request(), signal())).toBe("reserved");
			expect(attempts).toBe(2);
			expect(buckets(contender)).toHaveLength(5);
		} finally {
			if (db.inTransaction) db.exec("ROLLBACK");
			contender.close();
			db.close();
		}
	});

	it("never accesses quota storage when configuring nonblocking SQLite fails", async () => {
		// Arrange
		const { db } = fixture();
		const reads: string[] = [];
		let attempts = 0;
		let configurations = 0;
		const wrapped = boundary(db, {
			reads,
			before: () => {
				attempts++;
			},
		});
		const quota = adapter({
			...wrapped,
			exec(sql) {
				configurations++;
				expect(sql).toBe("PRAGMA busy_timeout = 0");
				throw new Error("SQLite configuration unavailable");
			},
		});
		// Act
		const traffic = await quota.reserve(request(), signal());
		const upgrade = await quota.reserveUpgrade(signal());
		// Assert
		expect([traffic, upgrade]).toEqual(["unknown", "unknown"]);
		expect(configurations).toBe(1);
		expect(attempts).toBe(0);
		expect(reads).toEqual([]);
		expect(buckets(db)).toEqual([]);
	});
});

describe("exclusive writer access", () => {
	it("skips the busy-timeout PRAGMA and still reserves", async () => {
		// Arrange
		const { db } = fixture();
		const statements: string[] = [];
		const quota = createExclusiveWriterRelayQuota({
			database: {
				...boundary(db, {}),
				exec(sql) {
					statements.push(sql);
					return db.exec(sql);
				},
			},
			realmId,
			enabled: true,
		});
		// Act
		const result = await quota.reserve(request(), signal());
		// Assert
		expect(result).toBe("reserved");
		expect(statements).toEqual([]);
		expect(buckets(db)).toHaveLength(5);
	});
});

// The frozen SQLite clock makes these exact. The shared contract allows real-clock refill.
describe("frozen-clock exact balances", () => {
	it("denies a 1 ms database clock rollback without changing any bucket", async () => {
		// Arrange
		const { db, quota } = fixture();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.prepare(
			"UPDATE relay_quota_buckets SET refilled_at_ms=refilled_at_ms+1 WHERE scope='pair'",
		).run();
		const snapshot = buckets(db);
		// Act
		const result = await quota.reserve(request(), signal());
		// Assert
		expect(result).toBe("denied");
		expect(buckets(db)).toEqual(snapshot);
	});

	it("leaves zero balance after resuming from a zero allocation", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.prepare("UPDATE relay_quota_allocations SET rate=1,burst=1 WHERE purpose='traffic'").run();
		db.prepare("UPDATE relay_quota_allocations SET rate=0,burst=0 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("denied");
		db.prepare("UPDATE relay_quota_allocations SET rate=2,burst=4 WHERE purpose='traffic'").run();
		// Act
		const resumed = await quota.reserve(request(), signal());
		// Assert
		expect(resumed).toBe("reserved");
		expect(
			db.prepare("SELECT DISTINCT last_rate,last_capacity,balance FROM relay_quota_buckets").all(),
		).toEqual([{ last_rate: 1, last_capacity: 60000, balance: 0 }]);
	});

	it("leaves zero balance after a lowered profile is raised again", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.prepare("UPDATE relay_quota_allocations SET burst=2,rate=1 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.prepare("UPDATE relay_quota_allocations SET burst=4,rate=2 WHERE purpose='traffic'").run();
		// Act
		const remaining = await quota.reserve(request(), signal());
		// Assert
		expect(remaining).toBe("reserved");
		expect(
			db.prepare("SELECT DISTINCT last_rate,last_capacity,balance FROM relay_quota_buckets").all(),
		).toEqual([{ last_rate: 1, last_capacity: 120000, balance: 0 }]);
	});
});

describe("quota cancellation and durable history", () => {
	it.each(["before call", "before transaction", "after commit"])(
		"handles cancellation %s without refunds",
		async (stage) => {
			// Arrange
			const { db } = fixture();
			const controller = new AbortController();
			const abort = () => controller.abort();
			const quota = adapter(
				boundary(db, {
					before: stage === "before transaction" ? abort : undefined,
					after: stage === "after commit" ? abort : undefined,
				}),
			);
			if (stage === "before call") abort();
			// Act
			const result = await quota.reserve(request("traffic", 4), controller.signal);
			const next = await adapter(db).reserve(request("traffic", 4), signal());
			// Assert
			expect(result).toBe("denied");
			expect(next).toBe(stage === "after commit" ? "denied" : "reserved");
		},
	);

	it("returns unknown for a lost commit receipt without retry, readback or refund", async () => {
		// Arrange
		const { db } = fixture();
		const reads: string[] = [];
		let readsAtCommit = 0;
		const quota = adapter(
			boundary(db, {
				fail: true,
				reads,
				after: () => {
					readsAtCommit = reads.length;
				},
			}),
		);
		// Act
		const result = await quota.reserve(request("traffic", 4), signal());
		// Assert
		expect(result).toBe("unknown");
		expect(reads[0]).toContain("FROM sqlite_schema");
		expect(reads).toHaveLength(12); // Protection and policy reads plus allocation and RETURNING per scope.
		expect(reads.filter((sql) => sql.startsWith("SELECT"))).toHaveLength(7);
		expect(reads.length).toBe(readsAtCommit);
		expect(await adapter(db).reserve(request(), signal())).toBe("denied");
	});
});
