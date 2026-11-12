import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTH_V2_SCHEMA_READINESS_SQL,
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import {
	connectV2Coordinator,
	setupV2Store,
} from "./coordinator-account-schema-sqlite-test-fixtures.js";
import {
	HEADLESS_CODE_LIMITS_TABLE,
	HEADLESS_LINK_PROVENANCE_TABLE,
	HEADLESS_LINK_SCHEMA_SQL,
	HEADLESS_LINK_SCHEMA_STATEMENTS,
} from "./coordinator-auth-headless-schema.js";
import {
	AUTH_LIFECYCLE_CURRENT_READINESS_SQL,
	AUTH_LIFECYCLE_CURRENT_READY_COUNT,
} from "./coordinator-auth-lifecycle-current-readiness.js";
import { AUTH_LIFECYCLE_FRESH_SCHEMA_STATEMENTS } from "./coordinator-auth-lifecycle-fresh-schema.js";
import { AUTH_LIFECYCLE_PREDECESSOR_CHECKS } from "./coordinator-auth-lifecycle-recognition.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { type Backend, type Fixture, setupStore } from "./coordinator-auth-store-test-fixtures.js";

const HEADLESS_TABLES = [HEADLESS_CODE_LIMITS_TABLE, HEADLESS_LINK_PROVENANCE_TABLE];
const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, worker), "utf8");
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

/** `v2` opens a SQLite coordinator file as a V2 release left it; D1 fixtures start on V2. */
function open(backend: Backend, schema: "current" | "v2" = "current"): Fixture {
	const f = backend === "SQLite" && schema === "v2" ? setupV2Store() : setupStore(backend);
	closers.push(async () => {
		await f.store.close();
		if (f.db.open) f.db.close();
	});
	return f;
}

function rawBackend(f: Fixture): AuthLinkBackend {
	return {
		first: async <T>({ sql, values }: { sql: string; values: unknown[] }) =>
			(f.db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: async ({ sql, values }) => f.db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			f.db.transaction(() => statements.map((s) => f.db.prepare(s.sql).run(...s.values).changes))(),
	};
}

function dropHeadless(db: Database.Database) {
	for (const table of HEADLESS_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}

async function authReadiness(f: Fixture) {
	return {
		v2: f.db.prepare(AUTH_V2_SCHEMA_READINESS_SQL).get(),
		connections: await readConnectionSchemaState(rawBackend(f)),
	};
}

describe("headless link capability", () => {
	it.each(["SQLite", "D1"] as const)("is present on a new %s coordinator", async (backend) => {
		// Arrange
		const f = open(backend);
		// Act
		const capability = await f.store.readHeadlessLinkBackend();
		// Assert
		expect(capability).not.toBeNull();
	});

	it.each([
		["SQLite", HEADLESS_CODE_LIMITS_TABLE],
		["SQLite", HEADLESS_LINK_PROVENANCE_TABLE],
		["D1", HEADLESS_CODE_LIMITS_TABLE],
		["D1", HEADLESS_LINK_PROVENANCE_TABLE],
	] as const)("is off on %s when %s is missing", async (backend, table) => {
		// Arrange
		const f = open(backend);
		f.db.exec(`DROP TABLE ${table}`);
		// Act
		const capability = await f.store.readHeadlessLinkBackend();
		// Assert
		expect(capability).toBeNull();
		await expect(f.store.assertAuthSchemaReady()).resolves.toBeUndefined();
	});
});

describe("existing auth readiness with headless tables", () => {
	it.each(["SQLite", "D1"] as const)(
		"leaves V2 and account-connection readiness unchanged on %s",
		async (backend) => {
			// Arrange
			const f = open(backend, "v2");
			dropHeadless(f.db);
			const v2Without = await authReadiness(f);
			// Act
			f.db.exec(HEADLESS_LINK_SCHEMA_SQL);
			const v2With = await authReadiness(f);
			await applyAccountConnectionSchema(rawBackend(f));
			const connectedWith = await authReadiness(f);
			dropHeadless(f.db);
			const connectedWithout = await authReadiness(f);
			// Assert
			expect(v2Without).toEqual({ v2: { ready: 10 }, connections: "v2" });
			expect(v2With).toEqual(v2Without);
			// The legacy V2 count reads 9 once the connection extension adds its fourth auxiliary object.
			expect(connectedWithout).toEqual({ v2: { ready: 9 }, connections: "ready" });
			expect(connectedWith).toEqual(connectedWithout);
			await expect(f.store.assertAuthSchemaReady()).resolves.toBeUndefined();
		},
	);

	it("leaves current lifecycle readiness at its full count", () => {
		// Arrange
		const db = new Database(":memory:");
		closers.push(() => db.close());
		for (const sql of AUTH_LIFECYCLE_FRESH_SCHEMA_STATEMENTS) db.exec(sql);
		// Act
		db.exec(HEADLESS_LINK_SCHEMA_SQL);
		// Assert
		expect(db.prepare(AUTH_LIFECYCLE_CURRENT_READINESS_SQL).get()).toEqual({
			ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT,
		});
	});

	it("passes every lifecycle predecessor fence on a store that created the headless tables", () => {
		// Arrange: the lifecycle upgrade's predecessor is the V2 schema earlier releases created.
		const db = connectV2Coordinator();
		closers.push(() => db.close());
		// Act
		const failed = AUTH_LIFECYCLE_PREDECESSOR_CHECKS.filter(
			({ matches }) => (db.prepare(`SELECT (${matches}) AS ok`).get() as { ok: number }).ok !== 1,
		).map(({ name }) => name);
		// Assert
		expect(
			db
				.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name IN (?, ?)`)
				.get(...HEADLESS_TABLES),
		).toEqual({ n: 2 });
		expect(failed).toEqual([]);
	});

	it("keeps headless DDL free of auth table names and reserved prefixes", () => {
		// Arrange
		const ddl = HEADLESS_LINK_SCHEMA_SQL.toLowerCase();
		// Act
		const mentions = ddl.match(/coordinator_auth_\w+/g) ?? [];
		// Assert
		expect(mentions).toEqual([]);
	});
});

describe("D1 migration 0043", () => {
	it("is generated from the core schema statements", () => {
		// Arrange
		const expected = [
			"-- Headless account linking: code-entry failure windows and link provenance.",
			"-- Additive only. Headless linking stays off until both tables exist.",
			"-- Generated from packages/core/src/coordinator-auth-headless-schema.ts. coordinator-auth-headless-schema.test.ts checks parity.",
			...HEADLESS_LINK_SCHEMA_STATEMENTS,
			"",
		].join("\n");
		// Act
		const migration = read("migrations/0043_add_headless_account_linking.sql");
		// Assert
		expect(migration).toBe(expected);
	});

	it("is included in schema.sql", () => {
		// Arrange
		const schema = read("schema.sql");
		// Act
		const missing = HEADLESS_LINK_SCHEMA_STATEMENTS.filter((sql) => !schema.includes(sql));
		// Assert
		expect(missing).toEqual([]);
	});
});
