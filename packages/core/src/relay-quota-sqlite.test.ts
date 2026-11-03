import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
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

describe("disposable relay-owned SQLite quota", () => {
	it("installs only inert quota metadata and requires both explicit switches", async () => {
		// Arrange
		const db = database();
		initializeRelayQuotaSchema(db);
		provisionLocalRelayQuota(db, { realmId, profile });
		// Act
		const disabled = await adapter(db).reserve(request(), signal());
		setRelayQuotaEnabled(db, { realmId, enabled: true });
		const defaultAdapter = createSqliteRelayQuota({ database: db, realmId });
		// Assert
		expect(disabled).toBe("denied");
		expect(await defaultAdapter.reserve(request(), signal())).toBe("denied");
		expect(await adapter(db).reserve(request(), signal())).toBe("reserved");
		expect(
			db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
		).toEqual([
			{ name: "relay_quota_allocations" },
			{ name: "relay_quota_buckets" },
			{ name: "relay_quota_root" },
		]);
		expect(
			db
				.prepare("PRAGMA table_info(relay_quota_buckets)")
				.all()
				.map((row) => (row as { name: string }).name),
		).toEqual([
			"purpose",
			"scope",
			"subject",
			"balance",
			"refilled_at_ms",
			"last_rate",
			"last_capacity",
		]);
	});

	it.each(["absent schema", "absent root", "zero profile", "missing allocation"])(
		"fails closed for %s",
		async (state) => {
			// Arrange
			const db = database();
			if (state !== "absent schema") initializeRelayQuotaSchema(db);
			if (state === "zero profile") {
				provisionLocalRelayQuota(db, { realmId });
				setRelayQuotaEnabled(db, { realmId, enabled: true });
			}
			if (state === "missing allocation") {
				fixture(profile, db);
				db.prepare("DELETE FROM relay_quota_allocations WHERE scope='pair'").run();
			}
			// Act
			const result = await adapter(db).reserve(request(), signal());
			// Assert: unavailable storage is unknown, never permission to send.
			expect(result).toBe(state === "absent schema" ? "unknown" : "denied");
			if (state !== "absent schema") expect(buckets(db)).toEqual([]);
		},
	);

	it.each(["upgrade", "control", "open", "traffic"] as const)(
		"charges exact unit boundaries for %s",
		async (purpose) => {
			// Arrange
			const { db, quota } = fixture();
			const burst = purpose === "open" ? 2 : 4;
			const reserve = () =>
				purpose === "upgrade"
					? quota.reserveUpgrade(signal())
					: quota.reserve(request(purpose), signal());
			// Act
			const results = [];
			for (let index = 0; index < burst; index++) results.push(await reserve());
			const snapshot = buckets(db);
			const exhausted = await reserve();
			// Assert
			expect(results).toEqual(Array(burst).fill("reserved"));
			expect(exhausted).toBe("denied");
			expect(buckets(db)).toEqual(snapshot);
		},
	);
});

describe("quota intersections and fixed-point units", () => {
	it.each(["service", "realm", "source", "target", "pair"] as const)(
		"intersects %s capacity and rolls back earlier charges",
		async (limited) => {
			// Arrange
			const { db, quota } = fixture();
			expect(await quota.reserve(request("traffic", 1), signal())).toBe("reserved");
			const scope = limited === "source" || limited === "target" ? "device" : limited;
			const subject = { service: "", realm: "", source: "a", target: "b", pair: '["a","b"]' }[
				limited
			];
			db.prepare("UPDATE relay_quota_buckets SET balance=0 WHERE scope=? AND subject=?").run(
				scope,
				subject,
			);
			const snapshot = buckets(db);
			// Act: reverse participants to prove pair keys are unordered and both devices count.
			const result = await quota.reserve(request("traffic", 1, "b", "a"), signal());
			// Assert
			expect(result).toBe("denied");
			expect(buckets(db)).toEqual(snapshot);
		},
	);

	it.each(["service", "realm"])(
		"does not multiply %s capacity across fresh devices and pairs",
		async (scope) => {
			// Arrange
			const selected = {
				...profile,
				traffic: { ...profile.traffic, [scope]: { ...allocation, burst: 1 } },
			};
			const { quota } = fixture(selected);
			// Act
			const first = await quota.reserve(request(), signal());
			const freshPair = await quota.reserve(request("traffic", 1, "c", "d"), signal());
			// Assert
			expect(first).toBe("reserved");
			expect(freshPair).toBe("denied");
		},
	);

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
		const quota = adapter(boundary(db, { fail: true, reads }));
		// Act
		const result = await quota.reserve(request("traffic", 4), signal());
		// Assert
		expect(result).toBe("unknown");
		expect(reads).toHaveLength(11); // One policy read plus allocation and RETURNING per scope.
		expect(reads.filter((sql) => sql.startsWith("SELECT"))).toHaveLength(6);
		expect(await adapter(db).reserve(request(), signal())).toBe("denied");
	});

	it("keeps consumed buckets after restart, reconnect, switching and rejected reprovision", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "relay-quota-test-"));
		directories.push(directory);
		const path = join(directory, "quota.sqlite");
		const { db, quota } = fixture(profile, database(path));
		expect(await quota.reserve(request("traffic", 4), signal())).toBe("reserved");
		const snapshot = buckets(db);
		db.close();
		// Act
		const reopened = database(path);
		setRelayQuotaEnabled(reopened, { realmId, enabled: false });
		const disabled = await adapter(reopened).reserve(request(), signal());
		setRelayQuotaEnabled(reopened, { realmId, enabled: true });
		// Assert
		expect(disabled).toBe("denied");
		expect(() => provisionLocalRelayQuota(reopened, { realmId, profile })).toThrow();
		expect(await adapter(reopened).reserve(request("traffic", 1, "b", "a"), signal())).toBe(
			"denied",
		);
		expect(buckets(reopened)).toEqual(snapshot);
	});

	it("retains historical minimum rate and capacity when a lowered profile is raised again", async () => {
		// Arrange
		const { db, quota } = fixture();
		db.prepare("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'").run();
		expect(await quota.reserve(request(), signal())).toBe("reserved");
		db.prepare("UPDATE relay_quota_allocations SET burst=2,rate=1 WHERE purpose='traffic'").run();
		// Act
		const lowered = await quota.reserve(request(), signal());
		db.prepare("UPDATE relay_quota_allocations SET burst=4,rate=2 WHERE purpose='traffic'").run();
		const remaining = await adapter(db).reserve(request(), signal());
		const exhausted = await adapter(db).reserve(request(), signal());
		// Assert
		expect([lowered, remaining, exhausted]).toEqual(["reserved", "reserved", "denied"]);
		expect(buckets(db)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ balance: 0, last_rate: 1, last_capacity: 120000 }),
			]),
		);
	});

	it("denies a database clock rollback without changing any bucket", async () => {
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
});
