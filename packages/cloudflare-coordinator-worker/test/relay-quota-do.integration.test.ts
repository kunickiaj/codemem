import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RELAY_ADMISSION_CLOCK_SQL } from "../../core/src/relay-admission-clock.js";
import {
	type RelayQuotaContractHost,
	type RelayQuotaContractStorage,
	registerRelayQuotaContract,
	relayQuotaFixture,
	relayQuotaRealmId,
	relayQuotaRequest,
} from "../../core/src/relay-quota-contract-test-fixtures.js";
import {
	createSqliteRelayQuota,
	initializeRelayQuotaSchema,
} from "../../core/src/relay-quota-sqlite.js";
import {
	createDurableObjectRelayQuota,
	durableObjectRelayQuotaDatabase,
} from "../src/relay-quota-do.js";

const signal = () => new AbortController().signal;

function contractStorage(storage: DurableObjectStorage): RelayQuotaContractStorage {
	return {
		database: durableObjectRelayQuotaDatabase(storage),
		rows: (sql, ...bindings) => storage.sql.exec(sql, ...bindings).toArray(),
		quota: (options) => createDurableObjectRelayQuota({ storage, ...options }),
	};
}

// Each host is a fresh object, so cases never share storage.
function freshStub() {
	return env.RELAY_QUOTA_TEST.get(env.RELAY_QUOTA_TEST.newUniqueId());
}
function within<T>(
	stub: ReturnType<typeof freshStub>,
	operation: (storage: DurableObjectStorage) => T | Promise<T>,
): Promise<T> {
	return runInDurableObject(stub, (_object, state) => operation(state.storage));
}

async function durableObjectHost(): Promise<RelayQuotaContractHost> {
	const stub = freshStub();
	return {
		use: (operation) => within(stub, (storage) => operation(contractStorage(storage))),
		restart: () => evictDurableObject(stub),
	};
}

describe("Durable Object SQLite relay quota contract", () => {
	registerRelayQuotaContract(durableObjectHost);
});

describe("Durable Object SQLite constructs used by relay quota", () => {
	it("rejects PRAGMA busy_timeout, so the shared-writer adapter fails closed", async () => {
		// Arrange
		const stub = freshStub();
		await within(stub, (storage) => relayQuotaFixture(contractStorage(storage)));
		// Act
		const pragma = await within(stub, (storage) => {
			try {
				storage.sql.exec("PRAGMA busy_timeout = 0");
				return "accepted";
			} catch (error) {
				return (error as Error).message;
			}
		});
		const shared = await within(stub, (storage) =>
			createSqliteRelayQuota({
				database: durableObjectRelayQuotaDatabase(storage),
				realmId: relayQuotaRealmId,
				enabled: true,
			}).reserve(relayQuotaRequest(), signal()),
		);
		const sharedBuckets = await within(stub, (storage) =>
			storage.sql.exec("SELECT COUNT(*) AS count FROM relay_quota_buckets").one(),
		);
		const exclusive = await within(stub, (storage) =>
			createDurableObjectRelayQuota({ storage, realmId: relayQuotaRealmId, enabled: true }).reserve(
				relayQuotaRequest(),
				signal(),
			),
		);
		// Assert
		expect(pragma).toContain("SQLITE_AUTH");
		expect({ shared, sharedBuckets, exclusive }).toEqual({
			shared: "unknown",
			sharedBuckets: { count: 0 },
			exclusive: "reserved",
		});
	});

	it("reads UTC milliseconds from the clock SQL that advance across events", async () => {
		// Arrange
		const stub = freshStub();
		const clock = () =>
			within(
				stub,
				(storage) =>
					storage.sql.exec(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`).one().now as number,
			);
		// Act
		const before = Date.now();
		const first = await clock();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const second = await clock();
		const after = Date.now();
		// Assert: local workerd only. Production clock behavior still needs its own evidence.
		expect(Number.isSafeInteger(first)).toBe(true);
		expect(first).toBeGreaterThanOrEqual(before);
		expect(second).toBeGreaterThan(first);
		expect(second).toBeLessThanOrEqual(after);
	});

	it("installs the policy triggers visible through sqlite_schema", async () => {
		// Arrange
		const stub = freshStub();
		// Act
		const triggers = await within(stub, (storage) => {
			initializeRelayQuotaSchema(durableObjectRelayQuotaDatabase(storage));
			return storage.sql
				.exec(
					"SELECT name,tbl_name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'relay_quota%' ORDER BY name",
				)
				.toArray();
		});
		// Assert
		expect(triggers).toEqual([
			{ name: "relay_quota_policy_delete", tbl_name: "relay_quota_allocations" },
			{ name: "relay_quota_policy_insert", tbl_name: "relay_quota_allocations" },
			{ name: "relay_quota_policy_update", tbl_name: "relay_quota_allocations" },
		]);
	});

	it("aborts with RAISE and rolls a transactionSync callback back, but rejects BEGIN", async () => {
		// Arrange
		const stub = freshStub();
		await within(stub, (storage) => {
			storage.sql.exec(`CREATE TABLE probe(value TEXT NOT NULL) STRICT;
 CREATE TRIGGER probe_guard BEFORE INSERT ON probe WHEN NEW.value = 'blocked'
 BEGIN SELECT RAISE(ABORT, 'probe blocked'); END;`);
		});
		// Act
		const outcome = await within(stub, (storage) => {
			const attempt = (operation: () => void) => {
				try {
					operation();
					return "ok";
				} catch (error) {
					return (error as Error).message;
				}
			};
			return {
				raise: attempt(() =>
					storage.transactionSync(() => {
						storage.sql.exec("INSERT INTO probe(value) VALUES('kept-out')");
						storage.sql.exec("INSERT INTO probe(value) VALUES('blocked')");
					}),
				),
				begin: attempt(() => storage.sql.exec("BEGIN IMMEDIATE")),
				rows: storage.sql.exec("SELECT value FROM probe").toArray(),
			};
		});
		// Assert
		expect(outcome.raise).toContain("probe blocked");
		expect(outcome.raise).toContain("SQLITE_CONSTRAINT");
		expect(outcome.begin).toContain("transactionSync");
		expect(outcome.rows).toEqual([]);
	});
});
