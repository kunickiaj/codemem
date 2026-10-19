import { expect, it } from "vitest";
import {
	changeFixture,
	config,
	hash,
	NOW,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import {
	ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	ACCOUNT_CONNECTION_SCHEMA_CHECKS,
	applyAccountConnectionSchema,
	CoordinatorAuthSchemaUpgradeRequiredError,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { AUTH_GUARDED_SIGNIN_RECEIPT_PURGE_AGE_MS } from "./coordinator-auth-session.js";
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

async function signinForProfile(f: ReturnType<typeof setupStore>, n: number) {
	const bc = { ...config, redirectUri: "https://coordinator.example.test/auth/callback" };
	const input = {
		purpose: "signin" as const,
		stateHash: hash(n),
		binderHash: hash(n + 1),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect((await f.store.startAuthBrowserTransaction(input, bc)).kind).toBe("started");
	const consumed = await f.store.consumeAuthBrowserTransaction(input, bc);
	if (consumed.kind !== "consumed") throw new Error("signin fixture unavailable");
	const credentialHash = hash(n + 2);
	expect(
		(
			await f.store.signInWithConsumedBrowserTransaction(
				{
					browserTransactionHash: consumed.browserTransactionHash,
					credentialHash,
					account: { issuer: config.issuer, subject: "account-A" },
				},
				bc,
			)
		).kind,
	).toBe("issued");
	return credentialHash;
}
it.each([{ displayName: "Retained profile" }, {}])(
	"keeps legacy profile %j after actual receipt retention and migration",
	async (profile) => {
		let now = NOW;
		const f = setupStore("SQLite", { authClock: () => now });
		let live = "";
		try {
			await changeFixture(f.store, raw(f), "device_claim", async () => {
				const credentialHash = await signinForProfile(f, 9200);
				expect(await f.store.recordAuthAccountProfile({ credentialHash, profile }, config)).toEqual(
					{ kind: "recorded" },
				);
				now += AUTH_GUARDED_SIGNIN_RECEIPT_PURGE_AGE_MS + 1;
				await f.store.maintainAuthBrowserTransactions(config);
				expect(await f.store.purgeAuthSigninBrowserTransactions(config)).toMatchObject({
					kind: "purged",
					processedCount: 1,
				});
				expect(await f.store.purgeAuthGuardedSigninSessions(config)).toMatchObject({
					kind: "purged",
					processedCount: 1,
				});
				expect(await f.store.purgeAuthGuardedSigninReceipts(config)).toMatchObject({
					kind: "purged",
					processedCount: 1,
				});
				expect(await f.store.readAuthSession(credentialHash, config)).toBeNull();
				live = await signinForProfile(f, 9210);
				expect((await f.store.readAuthSessionAccount(live, config))?.profile).toEqual(profile);
			});
			expect((await f.store.readAuthSessionAccount(live, config))?.profile).toEqual(profile);
			f.db.prepare("UPDATE coordinator_auth_account_profiles SET source_order=2").run();
			expect((await f.store.readAuthSessionAccount(live, config))?.profile).toEqual({
				displayName: "Birth",
			});
			f.db.prepare("UPDATE coordinator_auth_account_profiles SET source_order=1").run();
			const fresh = await signinForProfile(f, 9220);
			expect((await f.store.readAuthSessionAccount(fresh, config))?.profile).toEqual(profile);
			expect(
				await f.store.recordAuthAccountProfile(
					{ credentialHash: fresh, profile: { displayName: "New verified profile" } },
					config,
				),
			).toEqual({ kind: "recorded" });
			expect((await f.store.readAuthSessionAccount(fresh, config))?.profile).toEqual({
				displayName: "New verified profile",
			});
		} finally {
			await f.store.close();
		}
	},
);

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
