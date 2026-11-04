import {
	createExclusiveWriterRelayQuota,
	type RelayQuotaDatabase,
	type SqliteRelayQuotaPort,
} from "@codemem/core/internal/relay-host";

/**
 * Maps a Durable Object's SQLite storage onto the relay quota database boundary,
 * so quota uses the same SQL, schema and triggers as the Node implementation.
 * Durable Object SQL rejects BEGIN and SAVEPOINT, so `.immediate()` runs the
 * operation in `transactionSync`, which rolls back when the operation throws.
 * Every cursor is read to completion while still inside that synchronous call.
 */
export function durableObjectRelayQuotaDatabase(storage: DurableObjectStorage): RelayQuotaDatabase {
	return Object.freeze({
		prepare: (sql: string) =>
			Object.freeze({
				// A conditional upsert that matches no row returns no row, so this must not use one().
				get: (...bindings: (string | number)[]) => storage.sql.exec(sql, ...bindings).toArray()[0],
				run: (...bindings: (string | number)[]) => {
					storage.sql.exec(sql, ...bindings).toArray();
				},
			}),
		exec: (sql: string) => {
			storage.sql.exec(sql).toArray();
		},
		transaction: <T>(operation: () => T) =>
			Object.freeze({ immediate: () => storage.transactionSync(operation) }),
	});
}

/**
 * Quota port backed by the object's own storage. The object runs one event at a
 * time and `transactionSync` cannot yield, so no other writer can hold a lock
 * during a reservation. That is why this uses the exclusive-writer factory
 * (Durable Object SQL rejects `PRAGMA busy_timeout` with SQLITE_AUTH).
 * Counters live only in storage. Eviction or a new adapter neither mints nor resets quota.
 */
export function createDurableObjectRelayQuota(options: {
	readonly storage: DurableObjectStorage;
	readonly realmId: string;
	readonly enabled?: boolean;
}): SqliteRelayQuotaPort {
	return createExclusiveWriterRelayQuota({
		database: durableObjectRelayQuotaDatabase(options.storage),
		realmId: options.realmId,
		enabled: options.enabled,
	});
}
