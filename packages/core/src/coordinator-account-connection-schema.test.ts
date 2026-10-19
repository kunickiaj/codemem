import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	changeFixture,
	config,
	hash,
	input,
	NOW,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import { reconnectFixture } from "../../cloudflare-coordinator-worker/test/account-reconnect-fixture.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	ACCOUNT_CONNECTION_SCHEMA_CHECKS,
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import { AuthAccountProfileOperations } from "./coordinator-auth-account-profile.js";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL } from "./coordinator-auth-device-claim-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { AuthLinkOperations } from "./coordinator-auth-link.js";
import { AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-contract.js";
import {
	AUTH_SCHEMA_READINESS_SQL,
	CoordinatorAuthSchemaUpgradeRequiredError,
	withCoordinatorAuthSchema,
} from "./coordinator-auth-schema.js";
import {
	AUTH_GUARDED_SIGNIN_RECEIPT_PURGE_AGE_MS,
	AuthSessionOperations,
} from "./coordinator-auth-session.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import type { D1CoordinatorStore } from "./d1-coordinator-store.js";

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
it("executes two fresh raw schema lookups instead of six recursively wrapped lookups", async () => {
	const f = setupStore("SQLite");
	try {
		const backend = raw(f);
		await applyAccountConnectionSchema(backend);
		let queries = 0;
		const counted: AuthLinkBackend = {
			...backend,
			first: (statement) => {
				queries++;
				return backend.first(statement);
			},
		};
		const wrapped = withCoordinatorAuthSchema(counted);
		expect(await hasConnectionSessionSchema(wrapped)).toBe(true);
		expect(queries).toBe(2);
		queries = 0;
		await wrapped.first({ sql: "SELECT 1", values: [] });
		expect(queries).toBe(3); // Normal operations still assert readiness, then execute.
		f.db.exec("DROP TRIGGER account_change_birth");
		await expect(hasConnectionSessionSchema(wrapped)).rejects.toBeInstanceOf(
			CoordinatorAuthSchemaUpgradeRequiredError,
		);
		await expect(
			wrapped.run({ sql: "UPDATE coordinator_auth_account_links SET revoked_at_ms=1", values: [] }),
		).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
	} finally {
		await f.store.close();
	}
});
it("keeps the trusted selector's legacy V2 result unchanged", async () => {
	const f = setupStore("SQLite");
	try {
		expect(await hasConnectionSessionSchema(withCoordinatorAuthSchema(raw(f)))).toBe(false);
	} finally {
		await f.store.close();
	}
});
it.each(["SQLite", "D1"] as const)(
	"%s startup capability reads current schema and never caches a ready result",
	async (kind) => {
		const f = setupStore(kind);
		try {
			expect(await f.store.readAccountChangeCapability()).toBeNull();
			await applyAccountConnectionSchema(raw(f));
			const operations = await f.store.readAccountChangeCapability();
			expect(operations).not.toBeNull();
			f.db.exec("DROP TRIGGER account_change_birth");
			await expect(f.store.readAccountChangeCapability()).rejects.toBeInstanceOf(
				CoordinatorAuthSchemaUpgradeRequiredError,
			);
			if (!operations) throw new Error("missing ready capability");
			await expect(
				operations.readCapabilities(
					{ signer: input.signer, expectedIdentityId: input.identityId },
					config,
				),
			).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
		} finally {
			await f.store.close();
		}
	},
);
it("sanitizes raw lookup errors in auth operations and never reaches a writer", async () => {
	const f = setupStore("SQLite");
	try {
		let writes = 0;
		const failed = withCoordinatorAuthSchema({
			...raw(f),
			first: async () => {
				throw new Error("private-raw-query-failure");
			},
			batch: async () => {
				writes++;
			},
		});
		const sessions = new AuthSessionOperations(failed);
		await expect(sessions.readAuthSession(hash(900), config)).rejects.toThrow(
			/^auth_session_persistence_error$/,
		);
		await expect(
			sessions.signOutAuthSession(hash(900), { coordinatorId: config.coordinatorId }),
		).rejects.toThrow(/^auth_session_persistence_error$/);
		expect(writes).toBe(0);
	} finally {
		await f.store.close();
	}
});
it.each(["schema", "enrollment"] as const)(
	"rechecks %s after predicate preparation before OIDC publication",
	async (mutation) => {
		const base = setupStore("D1", { authClock: () => NOW });
		try {
			const backend = raw(base),
				f = await reconnectFixture(base.store as D1CoordinatorStore, backend);
			await f.disconnect(1);
			const request = f.linkRequest(1);
			expect(await f.links.createAuthLinkAttempt(request, config)).toMatchObject({
				kind: "created",
			});
			const start = {
				purpose: "link" as const,
				attemptId: request.attemptId,
				browserStartHash: request.browserStartHash,
				stateHash: hash(3012),
				binderHash: hash(3013),
				nonce: "n".repeat(43),
				pkceVerifier: "p".repeat(43),
			};
			expect(await f.browser.startAuthBrowserTransaction(start, f.bc)).toMatchObject({
				kind: "started",
			});
			const consumed = await f.browser.consumeAuthBrowserTransaction(start, f.bc);
			if (consumed.kind !== "consumed") throw new Error("missing consumed reconnect");
			const wrapped = withCoordinatorAuthSchema(backend),
				prepare = wrapped.prepareAuthLinkSource;
			if (!prepare) throw new Error("missing internal predicate preparation");
			let changed = false;
			const links = new AuthLinkOperations(
				{
					...wrapped,
					prepareAuthLinkSource: async (...args) => {
						const predicate = await prepare(...args);
						if (!changed) {
							changed = true;
							if (mutation === "schema") base.db.exec("DROP TRIGGER account_change_birth");
							else
								base.db
									.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?")
									.run(input.signer.deviceId);
						}
						return predicate;
					},
				},
				() => f.clock.now,
			);
			const rows = () =>
				base.db
					.prepare("SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id=?")
					.get(request.attemptId);
			const before = rows(),
				pins = {
					attemptId: request.attemptId,
					browserTransactionHash: consumed.browserTransactionHash,
				};
			const publish = links.recordAuthLinkOidcVerified(
				{
					...pins,
					account: { issuer: config.issuer, subject: "account-B" },
					profile: { displayName: "Must not publish" },
				},
				config,
			);
			if (mutation === "schema") {
				await expect(publish).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
				await expect(links.readAuthLinkCompletionDestination(pins, config)).rejects.toBeInstanceOf(
					CoordinatorAuthSchemaUpgradeRequiredError,
				);
				await expect(
					new AuthAccountProfileOperations(wrapped).readAuthSessionAccount(hash(906), config),
				).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
			} else expect(await publish).toMatchObject({ kind: "rejected" });
			expect(rows()).toEqual(before);
			expect(
				base.db
					.prepare("SELECT * FROM coordinator_auth_link_profiles WHERE attempt_id=?")
					.all(request.attemptId),
			).toEqual([]);
		} finally {
			await base.store.close();
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

it("explicitly installs complete extensions as one atomic batch", async () => {
	const f = setupStore("SQLite");
	try {
		await applyAccountConnectionSchema(raw(f));
		expect(await readConnectionSchemaState(raw(f))).toBe("ready");
		expect(await f.store.getAccountChanges()).toBeDefined();
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

it("keeps fresh stores V2-only and management unavailable until explicit installation", async () => {
	const f = setupStore("SQLite");
	try {
		await f.store.assertAuthSchemaReady();
		await expect(f.store.getAccountChanges()).rejects.toBeInstanceOf(
			CoordinatorAuthSchemaUpgradeRequiredError,
		);
		expect(await hasConnectionSessionSchema(raw(f))).toBe(false);
		expect(
			f.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name LIKE 'coordinator_auth_account_connection_%'",
				)
				.all(),
		).toEqual([]);
	} finally {
		await f.store.close();
	}
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

it.each([
	{
		displayName: "Legacy signin",
		email: "legacy@example.test",
		emailVerified: true,
		pictureUrl: "https://lh3.googleusercontent.com/a/legacy",
	},
	{},
])("preserves legacy rows and profile %j through upgrade", async (profile) => {
	const f = setupStore("SQLite", { authClock: () => NOW });
	try {
		const snapshots: { table: string; columns: string; rows: unknown[] }[] = [];
		await changeFixture(f.store, raw(f), "device_claim", async () => {
			const bc = { ...config, redirectUri: "https://coordinator.example.test/auth/callback" };
			const start = {
				purpose: "signin" as const,
				stateHash: hash(990),
				binderHash: hash(991),
				nonce: "n".repeat(43),
				pkceVerifier: "p".repeat(43),
			};
			await f.store.startAuthBrowserTransaction(start, bc);
			const proof = await f.store.consumeAuthBrowserTransaction(start, bc);
			if (proof.kind !== "consumed") throw new Error("legacy signin not consumed");
			await f.store.signInWithConsumedBrowserTransaction(
				{
					browserTransactionHash: proof.browserTransactionHash,
					credentialHash: hash(992),
					account: { issuer: config.issuer, subject: "account-A" },
				},
				bc,
			);
			await f.store.recordAuthAccountProfile({ credentialHash: hash(992), profile }, config);
			for (const table of [
				"coordinator_auth_account_links",
				"coordinator_auth_link_attempts",
				"coordinator_auth_device_claims",
				"coordinator_auth_link_audit_log",
				"coordinator_auth_browser_transactions",
				"coordinator_auth_sessions",
				"coordinator_auth_session_receipts",
				"coordinator_auth_link_profiles",
				"coordinator_auth_account_profiles",
				"enrolled_devices",
				"coordinator_device_ownership_bindings",
				"coordinator_identity_group_grants",
			]) {
				const columns = (f.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
					.map((c) => c.name)
					.join(",");
				const ddl = (
					f.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }
				).sql;
				const select = ddl.includes("WITHOUT ROWID")
					? columns
					: `rowid AS original_rowid,${columns}`;
				snapshots.push({
					table,
					columns: select,
					rows: f.db.prepare(`SELECT ${select} FROM ${table}`).all(),
				});
			}
		});
		for (const s of snapshots)
			expect(f.db.prepare(`SELECT ${s.columns} FROM ${s.table}`).all()).toEqual(s.rows);
		expect(f.db.prepare(AUTH_SCHEMA_READINESS_SQL).get()).toEqual({ ready: 9 });
		expect(
			f.db.prepare("SELECT last_order FROM coordinator_auth_account_connection_orders").all(),
		).toEqual([{ last_order: 1 }]);
		expect(
			f.db.prepare("SELECT start_order FROM coordinator_auth_browser_transactions").all(),
		).toEqual([{ start_order: null }, { start_order: null }]);
		expect(f.db.prepare("SELECT source_order FROM coordinator_auth_link_profiles").get()).toEqual({
			source_order: 0,
		});
		expect(
			f.db.prepare("SELECT source_order FROM coordinator_auth_account_profiles").get(),
		).toEqual({ source_order: 1 });
		expect(await f.store.readAuthSession(hash(992), config)).not.toBeNull();
		expect(await f.store.readAuthSessionAccount(hash(992), config)).toMatchObject({ profile });
		expect((await f.store.readAuthSessionAccount(hash(992), config))?.profile).toEqual(profile);
		await f.store.assertAuthSchemaReady();
		expect(await f.store.getAccountChanges()).toBeDefined();
		await expect(applyAccountConnectionSchema(raw(f))).rejects.toThrow("already_installed");
	} finally {
		await f.store.close();
	}
});

it.each(["missing", "fake", "column"])(
	"rejects %s extensions before normal auth and retained-capability writes",
	async (defect) => {
		const f = setupStore("SQLite");
		try {
			await applyAccountConnectionSchema(raw(f));
			const cap = await f.store.getAccountChanges();
			if (defect === "column")
				f.db.exec(
					"ALTER TABLE coordinator_auth_link_attempts RENAME COLUMN prior_link_id TO invalid_prior",
				);
			else {
				f.db.exec("DROP TRIGGER account_connection_claim_history");
				if (defect === "fake")
					f.db.exec(
						"CREATE TRIGGER account_connection_claim_history BEFORE INSERT ON coordinator_auth_device_claims BEGIN SELECT 1; END",
					);
			}
			expect(await readConnectionSchemaState(raw(f))).toBe("upgrade_required");
			await expect(hasConnectionSessionSchema(raw(f))).rejects.toBeInstanceOf(
				CoordinatorAuthSchemaUpgradeRequiredError,
			);
			await expect(f.store.getAccountChanges()).rejects.toBeInstanceOf(
				CoordinatorAuthSchemaUpgradeRequiredError,
			);
			await expect(
				cap.readManagementActivity({ binderHash: hash(1) }, config),
			).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
			await expect(f.store.signOutAuthSession(hash(1), config)).rejects.toBeInstanceOf(
				CoordinatorAuthSchemaUpgradeRequiredError,
			);
			expect(f.db.prepare("SELECT * FROM coordinator_auth_sessions").all()).toEqual([]);
			await f.store.createGroup("sync-still-available");
			expect(await f.store.getGroup("sync-still-available")).not.toBeNull();
		} finally {
			await f.store.close();
		}
	},
);

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

it("never repairs partial optional-auth DDL on SQLite reopen and preserves the old-binary fence", async () => {
	mkdirSync(".tmp", { recursive: true });
	const dir = mkdtempSync(join(".tmp", "connection-readiness-")),
		f = setupStore("SQLite");
	try {
		await applyAccountConnectionSchema(raw(f));
		// Replay the old auth initializer's unchanged frozen declarations.
		f.db.exec(AUTH_LINK_SCHEMA_SQL);
		f.db.exec(COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL);
		const healthy = join(dir, "healthy.sqlite");
		await f.db.backup(healthy);
		const reopened = new BetterSqliteCoordinatorStore(healthy);
		try {
			await reopened.assertAuthSchemaReady();
			expect(reopened.db.prepare(AUTH_SCHEMA_READINESS_SQL).get()).toEqual({ ready: 9 });
		} finally {
			await reopened.close();
		}
		f.db.exec("DROP TABLE coordinator_auth_link_profiles");
		const path = join(dir, "partial.sqlite");
		await f.db.backup(path);
		const partial = new BetterSqliteCoordinatorStore(path);
		try {
			expect(
				partial.db
					.prepare("SELECT name FROM sqlite_master WHERE name='coordinator_auth_link_profiles'")
					.all(),
			).toEqual([]);
			await expect(partial.assertAuthSchemaReady()).rejects.toBeInstanceOf(
				CoordinatorAuthSchemaUpgradeRequiredError,
			);
		} finally {
			await partial.close();
		}
	} finally {
		await f.store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each(["SQLite", "D1"] as const)(
	"%s exposes matching raw schema-state and browser-purpose delegates",
	async (backend) => {
		const f = setupStore(backend, { authClock: () => NOW });
		try {
			expect(await f.store.readAccountConnectionSchemaState()).toBe("v2");
			const bc = { ...config, redirectUri: "https://coordinator.example.test/auth/callback" };
			const input = {
				purpose: "signin" as const,
				stateHash: hash(880),
				binderHash: hash(881),
				nonce: "n".repeat(43),
				pkceVerifier: "p".repeat(43),
			};
			expect(await f.store.startAuthBrowserTransaction(input, bc)).toMatchObject({
				kind: "started",
			});
			expect(await f.store.readAuthBrowserTransactionPurpose(input, bc)).toBe("signin");
			await applyAccountConnectionSchema(raw(f));
			expect(await f.store.readAccountConnectionSchemaState()).toBe("ready");
			expect(await f.store.readAuthBrowserTransactionPurpose(input, bc)).toBe("signin");
			f.db.exec("DROP TRIGGER account_connection_claim_history");
			expect(await f.store.readAccountConnectionSchemaState()).toBe("upgrade_required");
			await expect(f.store.readAuthBrowserTransactionPurpose(input, bc)).rejects.toBeInstanceOf(
				CoordinatorAuthSchemaUpgradeRequiredError,
			);
		} finally {
			await f.store.close();
		}
	},
);

it("sanitizes schema-selector failures and preserves upgrade-required errors at auth boundaries", async () => {
	for (const failure of [
		new Error("fixture-private-read-secret"),
		new CoordinatorAuthSchemaUpgradeRequiredError(),
	]) {
		const backend: AuthLinkBackend = {
			first: async () => {
				throw failure;
			},
			run: async () => {
				throw failure;
			},
			batch: async () => {
				throw failure;
			},
		};
		const session = new AuthSessionOperations(backend),
			profile = new AuthAccountProfileOperations(backend),
			link = new AuthLinkOperations(backend);
		const proof = {
			purpose: "coordinator-account-link-v1" as const,
			coordinatorId: config.coordinatorId,
			attemptId: "attempt",
			groupId: input.signer.groupId,
			identityId: input.identityId,
			deviceId: input.signer.deviceId,
			fingerprint: input.signer.fingerprint,
			runtimeVerifierHash: hash(1),
			completionSecretHash: hash(2),
			signer: input.signer,
		};
		const checks = [
			session.readAuthSession(hash(3), config),
			profile.readAuthSessionAccount(hash(3), config),
			link.finalizeAuthLinkAttempt(proof, config),
		];
		const messages = [
			"auth_session_persistence_error",
			"auth_account_profile_persistence_error",
			"auth_link_persistence_error",
		];
		for (const [index, result] of checks.entries()) {
			if (failure instanceof CoordinatorAuthSchemaUpgradeRequiredError)
				await expect(result).rejects.toBe(failure);
			else await expect(result).rejects.toThrow(new RegExp(`^${messages[index]}$`));
		}
	}
});

it.each(["SQLite", "D1"] as const)(
	"%s keeps legacy auth readiness independent of optional profile storage",
	async (backend) => {
		const f = setupStore(backend);
		try {
			f.db.exec("DROP TABLE coordinator_auth_account_profiles");
			expect(f.db.prepare(AUTH_SCHEMA_READINESS_SQL).get()).toEqual({ ready: 10 });
			expect(await f.store.readAccountConnectionSchemaState()).toBe("v2");
			await f.store.assertAuthSchemaReady();
			const before = f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
			await expect(applyAccountConnectionSchema(raw(f))).rejects.toThrow();
			expect(f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(
				before,
			);
			await raw(f).run({ sql: ACCOUNT_CONNECTION_MIGRATION_STATEMENTS[1] as string, values: [] });
			expect(await f.store.readAccountConnectionSchemaState()).toBe("upgrade_required");
			await expect(f.store.assertAuthSchemaReady()).rejects.toBeInstanceOf(
				CoordinatorAuthSchemaUpgradeRequiredError,
			);
		} finally {
			await f.store.close();
		}
	},
);

const sqlBytes = ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.reduce(
	(n, s) => n + new TextEncoder().encode(s).length,
	0,
);
it(`exports ${ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.length} atomic statements / ${sqlBytes} UTF-8 SQL bytes`, () => {
	expect(
		ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.every(
			(s) => new TextEncoder().encode(s).length < 100000,
		),
	).toBe(true);
});
