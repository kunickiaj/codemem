import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	CoordinatorAuthSchemaUpgradeRequiredError,
	withCoordinatorAuthSchema,
} from "./coordinator-auth-schema.js";
import { type Fixture, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { createD1AuthLinkBackend, type D1DatabaseLike } from "./d1-coordinator-store.js";

const fixtures: Fixture[] = [];
const databases: Database.Database[] = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
	for (const db of databases.splice(0)) db.close();
});

const READS: AuthLinkStatement[] = [
	{ sql: "SELECT ? AS a UNION ALL SELECT ? ORDER BY 1", values: ["x", "y"] },
	{ sql: "SELECT group_id FROM groups WHERE group_id = ?", values: ["absent"] },
	{ sql: "SELECT count(*) AS n FROM groups", values: [] },
];

async function rawBackend(kind: "SQLite" | "D1"): Promise<AuthLinkBackend> {
	const f = setupStore(kind);
	fixtures.push(f);
	// The rebind backend is each store's raw backend, without the auth-schema wrapper.
	const backend = await f.store.readDeviceRebindBackend();
	if (!backend) throw new Error("rebind schema missing");
	return backend;
}

describe.each(["SQLite", "D1"] as const)("%s read batch", (kind) => {
	it("returns each statement's rows in statement order, including an empty result", async () => {
		// Arrange
		const backend = await rawBackend(kind);
		// Act
		const rows = await backend.readBatch?.(READS);
		// Assert
		expect(rows).toEqual([[{ a: "x" }, { a: "y" }], [], [{ n: 0 }]]);
	});

	it("passes through the auth-schema wrapper", async () => {
		// Arrange
		const backend = withCoordinatorAuthSchema(await rawBackend(kind));
		// Act
		const rows = await backend.readBatch?.(READS.slice(2));
		// Assert
		expect(rows).toEqual([[{ n: 0 }]]);
	});
});

describe("auth-schema wrapper read batch", () => {
	it("is absent when the wrapped backend has none", () => {
		// Arrange
		const { readBatch: _omitted, ...withoutReadBatch } = fakeBackend(async () => null);
		// Act
		const wrapped = withCoordinatorAuthSchema(withoutReadBatch);
		// Assert
		expect(wrapped.readBatch).toBeUndefined();
	});

	it("refuses to read while the auth schema needs an upgrade", async () => {
		// Arrange: an empty presence row reads as neither the current nor the prior schema.
		const reads: AuthLinkStatement[][] = [];
		const backend = fakeBackend(async () => ({ present: 0, v2: 0 }), reads);
		// Act
		const result = withCoordinatorAuthSchema(backend).readBatch?.(READS);
		// Assert
		await expect(result).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
		expect(reads).toEqual([]);
	});
});

describe("D1 read batch faults", () => {
	const d1 = () => {
		const db = new Database(":memory:");
		databases.push(db);
		return sqliteD1(db);
	};

	it("requires D1's batch", async () => {
		// Arrange
		const { batch: _omitted, ...withoutBatch } = d1();
		const backend = createD1AuthLinkBackend(schemaReady(withoutBatch));
		// Act
		const result = backend.readBatch?.([{ sql: "SELECT 1 AS a", values: [] }]);
		// Assert
		await expect(result).rejects.toThrow("auth_link_atomic_batch_required");
	});

	it("does not treat a result without rows as an empty read", async () => {
		// Arrange
		const db = d1();
		const backend = createD1AuthLinkBackend(schemaReady({ ...db, batch: async () => [{}] }));
		// Act
		const result = backend.readBatch?.([{ sql: "SELECT 1 AS a", values: [] }]);
		// Assert
		await expect(result).rejects.toThrow("auth_read_set_unavailable");
	});
});

function fakeBackend(
	first: () => Promise<unknown>,
	reads: AuthLinkStatement[][] = [],
): AuthLinkBackend {
	return {
		first: first as AuthLinkBackend["first"],
		run: async () => 0,
		batch: async () => [],
		readBatch: async <T>(statements: AuthLinkStatement[]) => {
			reads.push(statements);
			return statements.map(() => [] as T[]);
		},
	};
}

/** Answers the wrapper's schema-state query as the prior ready schema; other reads pass through. */
function schemaReady(db: D1DatabaseLike): D1DatabaseLike {
	return {
		...db,
		prepare(query) {
			const statement = db.prepare(query);
			if (!query.includes(" AS present,")) return statement;
			return {
				...statement,
				bind: () => ({ ...statement, first: async () => ({ present: 0, v2: 1 }) as never }),
			};
		},
	};
}
