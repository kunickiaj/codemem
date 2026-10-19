import { expect, it } from "vitest";
import {
	ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	ACCOUNT_CONNECTION_SCHEMA_CHECKS,
	applyAccountConnectionSchema,
	CoordinatorAuthSchemaUpgradeRequiredError,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";

const raw = (f: ReturnType<typeof setupStore>): AuthLinkBackend => ({
	first: async <T>({ sql, values }: AuthLinkStatement) =>
		(f.db.prepare(sql).get(...values) as T | undefined) ?? null,
	run: async ({ sql, values }) => f.db.prepare(sql).run(...values).changes,
	batch: async (statements) =>
		f.db
			.transaction(() =>
				statements.map(({ sql, values }) => f.db.prepare(sql).run(...values).changes),
			)
			.immediate(),
});

it("records the frozen V2 column inventory used by extension preflight", async () => {
	const f = setupStore("SQLite");
	try {
		const tables = [
			"coordinator_auth_link_attempts",
			"coordinator_auth_account_links",
			"coordinator_auth_link_audit_log",
			"coordinator_auth_browser_transactions",
			"coordinator_auth_sessions",
			"coordinator_auth_session_receipts",
			"coordinator_auth_link_profiles",
			"coordinator_auth_account_profiles",
		];
		expect(
			Object.fromEntries(
				tables.map((name) => [name, f.db.prepare(`PRAGMA table_info(${name})`).all().length]),
			),
		).toEqual({
			coordinator_auth_link_attempts: 29,
			coordinator_auth_account_links: 12,
			coordinator_auth_link_audit_log: 13,
			coordinator_auth_browser_transactions: 16,
			coordinator_auth_sessions: 12,
			coordinator_auth_session_receipts: 9,
			coordinator_auth_link_profiles: 12,
			coordinator_auth_account_profiles: 8,
		});
		expect(await readConnectionSchemaState(raw(f))).toBe("v2");
	} finally {
		await f.store.close();
	}
});

it("matches every declared postflight invariant independently", async () => {
	const f = setupStore("SQLite");
	try {
		await raw(f).batch(
			ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.slice(0, -1).map((sql) => ({ sql, values: [] })),
		);
		expect(
			ACCOUNT_CONNECTION_SCHEMA_CHECKS.flatMap((check, index) =>
				(f.db.prepare(`SELECT CASE WHEN ${check} THEN 1 ELSE 0 END AS ok`).get() as { ok: number })
					.ok
					? []
					: [
							{
								index,
								check: check.slice(0, 230),
								history: f.db
									.prepare(
										"SELECT sql FROM sqlite_master WHERE name='coordinator_auth_account_connection_history'",
									)
									.get(),
							},
						],
			),
		).toEqual([]);
	} finally {
		await f.store.close();
	}
});

it("rejects partial installation and rolls back a late migration fault completely", async () => {
	const f = setupStore("SQLite");
	try {
		const before = f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
			b = raw(f);
		await expect(
			applyAccountConnectionSchema({
				...b,
				batch: (statements) =>
					b.batch([
						...statements.slice(0, -1),
						{
							sql: "INSERT INTO coordinator_auth_account_connection_orders DEFAULT VALUES",
							values: [],
						},
						...statements.slice(-1),
					]),
			}),
		).rejects.toThrow();
		expect(f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
		expect(await readConnectionSchemaState(b)).toBe("v2");
		await b.run({ sql: ACCOUNT_CONNECTION_MIGRATION_STATEMENTS[1] as string, values: [] });
		expect(await readConnectionSchemaState(b)).toBe("upgrade_required");
		await expect(applyAccountConnectionSchema(b)).rejects.toBeInstanceOf(
			CoordinatorAuthSchemaUpgradeRequiredError,
		);
	} finally {
		await f.store.close();
	}
});
