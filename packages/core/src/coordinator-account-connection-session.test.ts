import { expect, it, vi } from "vitest";
import {
	config,
	hash,
	input,
	NOW,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import { connectionSessionFixture } from "../../cloudflare-coordinator-worker/test/account-connection-session-fixture.js";
import { seedEnrollmentSql } from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import {
	ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import { ACCOUNT_CONNECTION_STORAGE_STATEMENTS } from "./coordinator-account-connection-storage.js";
import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import { AUTH_SIGNIN_TXN_MAX_STARTS_PER_WINDOW } from "./coordinator-auth-browser-transaction-contract.js";
import { seed as seedBrowserRows } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { type AuthLinkBackend, AuthLinkOperations } from "./coordinator-auth-link.js";
import { AuthSessionOperations } from "./coordinator-auth-session.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import type { D1CoordinatorStore } from "./d1-coordinator-store.js";

function baseFixture() {
	const base = setupStore("D1", { authClock: () => NOW });
	const db = sqliteD1(base.db),
		batch = db.batch?.bind(db);
	if (!batch) throw new Error("missing atomic batch");
	const backend: AuthLinkBackend = {
		first: ({ sql, values }) =>
			db
				.prepare(sql)
				.bind(...values)
				.first(),
		run: async ({ sql, values }) => base.db.prepare(sql).run(...values).changes,
		batch: (statements) =>
			batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values))),
	};
	return { ...base, backend };
}
const test = it.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
	f: async ({ task: _task }, use) => {
		const f = await fixture();
		try {
			await use(f);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
});
async function fixture() {
	const base = baseFixture();
	const f = await connectionSessionFixture(base.store as D1CoordinatorStore, base.backend);
	const rows = (table: string) =>
		base.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
	return { ...base, ...f, rows };
}

test("retired unbound minting APIs never write; already issued legacy sessions remain readable", async ({
	f,
}) => {
	const before = f.rows("coordinator_auth_sessions");
	expect(await f.sessions.readAuthSession(hash(906), config)).not.toBeNull();
	expect(
		await f.sessions.signInWithAuthAccount(
			{
				browserTransactionHash: hash(777),
				credentialHash: hash(778),
				account: { issuer: config.issuer, subject: "account-A" },
			},
			config,
		),
	).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(
		await f.sessions.redeemAuthLinkSession(
			{ attemptId: "birth", browserTransactionHash: hash(903), credentialHash: hash(779) },
			config,
		),
	).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(f.rows("coordinator_auth_sessions")).toEqual(before);
});

test("NULL legacy browser orders drain; same-issuer config rotation uses current callback config, not link birth revision", async ({
	f,
}) => {
	const legacy = await f.consumed(1);
	f.db
		.prepare(
			"UPDATE coordinator_auth_browser_transactions SET start_order = NULL WHERE browser_transaction_hash = ?",
		)
		.run(legacy.browserTransactionHash);
	expect(await f.sessions.signInWithConsumedBrowserTransaction(legacy, f.bc)).toMatchObject({
		kind: "rejected",
	});
	const rotated = { ...f.bc, revision: hash(888) };
	const proof = await f.signin(2, rotated);
	expect(await f.sessions.readAuthSession(proof.credentialHash, rotated)).not.toBeNull();
	expect(f.rows("coordinator_auth_account_links")).toMatchObject([
		{ auth_config_revision: config.revision },
	]);
});

test("ordered same-session profile retries stay recorded without replacing their first payload", async ({
	f,
}) => {
	const proof = await f.signin(1);
	const write = (displayName: string) =>
		f.profiles.recordAuthAccountProfile(
			{ credentialHash: proof.credentialHash, profile: { displayName } },
			config,
		);
	expect(await write("Original")).toEqual({ kind: "recorded" });
	const original = f.rows("coordinator_auth_account_profiles");
	expect(await write("Retry must not replace")).toEqual({ kind: "recorded" });
	expect(f.rows("coordinator_auth_account_profiles")).toEqual(original);
	const newer = await f.signin(2);
	expect(
		await f.profiles.recordAuthAccountProfile(
			{ credentialHash: newer.credentialHash, profile: { displayName: "Newer" } },
			config,
		),
	).toEqual({ kind: "recorded" });
	expect(await write("Older session")).toEqual({ kind: "not_recorded" });
	await f.prepare(1, "refresh", {});
	await f.operations.finalize(f.proof(), config);
	expect(
		await f.profiles.recordAuthAccountProfile(
			{
				credentialHash: newer.credentialHash,
				profile: { displayName: "Stale under empty refresh" },
			},
			config,
		),
	).toEqual({ kind: "not_recorded" });
	expect((await f.profiles.readAuthSessionAccount(newer.credentialHash, config))?.profile).toEqual(
		{},
	);
});

test("ordered retry readback requires live matching session/order and honest persistence results", async ({
	f,
}) => {
	const proof = await f.signin(1);
	const input = { credentialHash: proof.credentialHash, profile: { displayName: "Original" } };
	expect(await f.profiles.recordAuthAccountProfile(input, config)).toEqual({ kind: "recorded" });
	const order = Number(f.rows("coordinator_auth_account_profiles")[0]?.source_order);
	f.db.exec("UPDATE coordinator_auth_account_profiles SET source_order=source_order+1");
	expect(await f.profiles.recordAuthAccountProfile(input, config)).toEqual({
		kind: "not_recorded",
	});
	f.db.prepare("UPDATE coordinator_auth_account_profiles SET source_order=?").run(order);
	expect(
		await f.profiles.recordAuthAccountProfile(input, { ...config, revision: hash(999) }),
	).toEqual({ kind: "not_recorded" });
	const run = vi.spyOn(f.backend, "run").mockResolvedValueOnce(Number.NaN);
	expect(await f.profiles.recordAuthAccountProfile(input, config)).toEqual({
		kind: "not_recorded",
	});
	run.mockRejectedValueOnce(new Error("private-write-fault"));
	await expect(f.profiles.recordAuthAccountProfile(input, config)).rejects.toThrow(
		"auth_account_profile_persistence_error",
	);
	run.mockRestore();
	const first = vi.spyOn(f.backend, "first");
	const originalRun = f.backend.run;
	vi.spyOn(f.backend, "run").mockImplementationOnce(async (statement) => {
		const changed = await originalRun(statement);
		first.mockRejectedValueOnce(new Error("private-read-fault"));
		return changed;
	});
	await expect(f.profiles.recordAuthAccountProfile(input, config)).rejects.toThrow(
		"auth_account_profile_persistence_error",
	);
	first.mockRestore();
	await f.sessions.revokeAuthAccountLink(
		{ linkId: String(f.rows("coordinator_auth_account_links")[0]?.link_id) },
		config,
	);
	expect(f.rows("coordinator_auth_account_profiles")).toHaveLength(1);
	expect(await f.profiles.recordAuthAccountProfile(input, config)).toEqual({
		kind: "not_recorded",
	});
});

test("refresh and signin snapshots share order; empty refresh clears and pending refresh never leaks", async ({
	f,
}) => {
	const signedIn = await f.signin(1);
	expect(
		await f.profiles.recordAuthAccountProfile(
			{ credentialHash: signedIn.credentialHash, profile: { displayName: "Signin" } },
			config,
		),
	).toEqual({ kind: "recorded" });
	await f.prepare(1, "refresh");
	expect(await f.profiles.readAuthSessionAccount(hash(906), config)).toMatchObject({
		profile: { displayName: "Signin" },
	});
	await f.operations.finalize(f.proof(), config);
	expect(await f.profiles.readAuthSessionAccount(hash(906), config)).toMatchObject({
		profile: { displayName: "Fresh" },
	});
	expect(
		await f.status.readAccountLinkStatus(input.signer, config, { identityId: input.identityId }),
	).toMatchObject({ version: 2, state: "linked", account: { displayName: "Fresh" } });
	await f.prepare(2, "refresh", {});
	await f.operations.finalize(f.proof(2), config);
	expect(await f.profiles.readAuthSessionAccount(hash(906), config)).toMatchObject({ profile: {} });
	expect((await f.profiles.readAuthSessionAccount(hash(906), config))?.profile).toEqual({});
	expect(
		await f.status.readAccountLinkStatus(input.signer, config, { identityId: input.identityId }),
	).toMatchObject({ state: "linked", account: {} });
	const newest = await f.signin(2);
	await f.profiles.recordAuthAccountProfile(
		{ credentialHash: newest.credentialHash, profile: { displayName: "Newest signin" } },
		config,
	);
	expect(await f.profiles.readAuthSessionAccount(hash(906), config)).toMatchObject({
		profile: { displayName: "Newest signin" },
	});
});

test("an older-started signin cannot overwrite refresh even when it completes later at the same clock time", async ({
	f,
}) => {
	const older = await f.consumed(1);
	await f.prepare(1, "refresh");
	await f.operations.finalize(f.proof(), config);
	expect(await f.sessions.signInWithConsumedBrowserTransaction(older, f.bc)).toMatchObject({
		kind: "issued",
	});
	expect(
		await f.profiles.recordAuthAccountProfile(
			{ credentialHash: older.credentialHash, profile: { displayName: "Older" } },
			config,
		),
	).toEqual({ kind: "not_recorded" });
	expect(await f.profiles.readAuthSessionAccount(hash(906), config)).toMatchObject({
		profile: { displayName: "Fresh" },
	});
});

test("browser counter and inserted browser row roll back together on a duplicate or overflow", async ({
	f,
}) => {
	await f.consumed(1);
	const order = f.rows("coordinator_auth_account_connection_orders");
	expect(
		await f.browser.startAuthBrowserTransaction(
			{
				purpose: "signin",
				stateHash: hash(502),
				binderHash: hash(503),
				nonce: "n".repeat(43),
				pkceVerifier: "p".repeat(43),
			},
			f.bc,
		),
	).toMatchObject({ kind: "rejected" });
	expect(f.rows("coordinator_auth_account_connection_orders")).toEqual(order);
	f.db.exec("DROP TRIGGER account_connection_order_update");
	f.db
		.prepare("UPDATE coordinator_auth_account_connection_orders SET last_order = ?")
		.run(Number.MAX_SAFE_INTEGER);
	f.db.exec(
		ACCOUNT_CONNECTION_STORAGE_STATEMENTS.find((s) =>
			s.startsWith("CREATE TRIGGER account_connection_order_update"),
		) as string,
	);
	const before = f.rows("coordinator_auth_browser_transactions");
	await expect(f.consumed(2)).rejects.toThrow();
	expect(f.rows("coordinator_auth_browser_transactions")).toEqual(before);
	expect(f.rows("coordinator_auth_account_connection_orders")).toMatchObject([
		{ last_order: Number.MAX_SAFE_INTEGER },
	]);
});

test("reciprocal LINK insertion boundary cannot overrun live CHANGE slots", async ({ f }) => {
	await f.operations.create(f.request(), config);
	await f.operations.create(f.request(2), config);
	const birth = f.rows("coordinator_auth_link_attempts")[0];
	if (!birth) throw new Error("missing birth");
	const pending = {
		...birth,
		attempt_id: "blocked-link",
		state: "pending",
		runtime_verifier_hash: hash(777),
		browser_start_hash: hash(778),
		browser_transaction_hash: null,
		account_subject: null,
		completion_secret_hash: null,
		link_id: null,
		claimed_at_ms: null,
		oidc_verified_at_ms: null,
		confirmed_at_ms: null,
		finalized_at_ms: null,
		created_at_ms: f.clock.now,
		expires_at_ms: f.clock.now + 600000,
	};
	expect(() =>
		f.db
			.prepare(
				`INSERT INTO coordinator_auth_link_attempts (${Object.keys(pending).join(",")}) VALUES (${Object.keys(
					pending,
				)
					.map(() => "?")
					.join(",")})`,
			)
			.run(...Object.values(pending)),
	).toThrow(/connection_attempt_limited/);
	expect(f.rows("coordinator_auth_link_attempts")).toHaveLength(1);
});

test("denied signin admission preserves its typed limit result and never consumes an order", async ({
	f,
}) => {
	seedBrowserRows({ ...f, cfg: config, now: f.clock.now }, AUTH_SIGNIN_TXN_MAX_STARTS_PER_WINDOW);
	const before = f.rows("coordinator_auth_browser_transactions");
	expect(
		await f.browser.startAuthBrowserTransaction(
			{
				purpose: "signin",
				stateHash: hash(502),
				binderHash: hash(503),
				nonce: "n".repeat(43),
				pkceVerifier: "p".repeat(43),
			},
			f.bc,
		),
	).toEqual({ kind: "rejected", error: "transaction_limited" });
	expect(f.rows("coordinator_auth_browser_transactions")).toEqual(before);
	expect(f.rows("coordinator_auth_account_connection_orders")).toEqual([
		{ coordinator_id: config.coordinatorId, last_order: 1 },
	]);
});

test("historical IDs remain administratively revocable after disconnect; fresh admission cannot use the removed link", async ({
	f,
}) => {
	const id = f.rows("coordinator_auth_account_links")[0]?.link_id;
	await f.prepare();
	await f.operations.finalize(f.proof(), config);
	expect(await f.sessions.revokeAuthAccountLink({ linkId: String(id) }, config)).toEqual({
		kind: "revoked",
	});
	expect(f.rows("coordinator_auth_account_connection_history")).toMatchObject([
		{ revoked_at_ms: f.clock.now },
	]);
	expect(await f.sessions.readAuthSession(hash(906), config)).toBeNull();
	const proof = await f.consumed(1);
	expect(await f.sessions.signInWithConsumedBrowserTransaction(proof, f.bc)).toMatchObject({
		kind: "rejected",
	});
});

it.each(["new coordinator", "attempt-only migration"] as const)(
	"%s allocates its missing counter atomically at the first browser start",
	async (mode) => {
		const f = baseFixture();
		try {
			for (const sql of seedEnrollmentSql.split(";").filter((s) => s.trim()))
				await f.backend.run({ sql, values: [] });
			if (mode === "new coordinator") await applyAccountConnectionSchema(f.backend);
			const links = new AuthLinkOperations(f.backend, () => NOW);
			const request = {
				attemptId: "first",
				authority: { kind: "device_claim" as const, identityId: input.identityId },
				signer: input.signer,
				runtimeVerifierHash: hash(102),
				browserStartHash: hash(103),
				loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
			};
			expect(await links.createAuthLinkAttempt(request, config)).toMatchObject({ kind: "created" });
			if (mode === "attempt-only migration") {
				// Isolated partial-data fixture: all canonical DDL is installed, but the
				// attempt-only coordinator's seed row is deliberately absent.
				await f.backend.batch(
					ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.filter(
						(sql) => !sql.includes("SELECT coordinator_id,0 FROM ("),
					).map((sql) => ({ sql, values: [] })),
				);
			}
			expect(await readConnectionSchemaState(f.backend)).toBe("ready");
			expect(
				f.db.prepare("SELECT * FROM coordinator_auth_account_connection_orders").all(),
			).toEqual([]);
			const browser = new CoordinatorAuthBrowserTransactions(f.backend, () => NOW);
			expect(
				await browser.startAuthBrowserTransaction(
					{
						purpose: "link",
						attemptId: request.attemptId,
						browserStartHash: request.browserStartHash,
						stateHash: hash(104),
						binderHash: hash(105),
						nonce: "n".repeat(43),
						pkceVerifier: "p".repeat(43),
					},
					{ ...config, redirectUri: "https://coordinator.example.test/auth/callback" },
				),
			).toMatchObject({ kind: "started" });
			expect(
				f.db.prepare("SELECT last_order FROM coordinator_auth_account_connection_orders").all(),
			).toEqual([{ last_order: 1 }]);
			expect(
				f.db.prepare("SELECT start_order FROM coordinator_auth_browser_transactions").all(),
			).toEqual([{ start_order: 1 }]);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
);

it("real first-link finalization records the counter floor, rejects earlier signin and admits its own bound ceremony", async () => {
	const f = baseFixture();
	try {
		await applyAccountConnectionSchema(f.backend);
		for (const sql of seedEnrollmentSql.split(";").filter((s) => s.trim()))
			await f.backend.run({ sql, values: [] });
		const links = new AuthLinkOperations(f.backend, () => NOW),
			browser = new CoordinatorAuthBrowserTransactions(f.backend, () => NOW),
			sessions = new AuthSessionOperations(f.backend, () => NOW);
		const bc = { ...config, redirectUri: "https://coordinator.example.test/auth/callback" };
		const oldStart = {
			purpose: "signin" as const,
			stateHash: hash(100),
			binderHash: hash(101),
			nonce: "n".repeat(43),
			pkceVerifier: "p".repeat(43),
		};
		await browser.startAuthBrowserTransaction(oldStart, bc);
		const old = await browser.consumeAuthBrowserTransaction(oldStart, bc);
		if (old.kind !== "consumed") throw new Error("old signin not consumed");
		const request = {
			attemptId: "first",
			authority: { kind: "device_claim" as const, identityId: input.identityId },
			signer: input.signer,
			runtimeVerifierHash: hash(102),
			browserStartHash: hash(103),
			loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
		};
		expect(await links.createAuthLinkAttempt(request, config)).toMatchObject({ kind: "created" });
		const start = {
			...oldStart,
			purpose: "link" as const,
			attemptId: "first",
			browserStartHash: request.browserStartHash,
			stateHash: hash(104),
			binderHash: hash(105),
		};
		expect(await browser.startAuthBrowserTransaction(start, bc)).toMatchObject({ kind: "started" });
		const consumed = await browser.consumeAuthBrowserTransaction(start, bc);
		if (consumed.kind !== "consumed") throw new Error("link not consumed");
		const pins = { attemptId: "first", browserTransactionHash: consumed.browserTransactionHash };
		await links.recordAuthLinkOidcVerified(
			{ ...pins, account: { issuer: config.issuer, subject: "account-A" } },
			config,
		);
		await links.confirmAuthLinkAttempt({ ...pins, completionSecretHash: hash(106) }, config);
		expect(
			await links.finalizeAuthLinkAttempt(
				{
					...request,
					purpose: "coordinator-account-link-v1",
					coordinatorId: config.coordinatorId,
					groupId: input.signer.groupId,
					identityId: input.identityId,
					deviceId: input.signer.deviceId,
					fingerprint: input.signer.fingerprint,
					completionSecretHash: hash(106),
				},
				config,
			),
		).toMatchObject({ kind: "applied" });
		expect(f.db.prepare("SELECT signin_floor FROM coordinator_auth_account_links").get()).toEqual({
			signin_floor: 2,
		});
		expect(
			await sessions.signInWithConsumedBrowserTransaction(
				{
					browserTransactionHash: old.browserTransactionHash,
					credentialHash: hash(107),
					account: { issuer: config.issuer, subject: "account-A" },
				},
				bc,
			),
		).toMatchObject({ kind: "rejected" });
		expect(
			await sessions.redeemAuthLinkSessionWithBrowserTransaction(
				{ ...pins, binderHash: start.binderHash, credentialHash: hash(108) },
				bc,
			),
		).toMatchObject({ kind: "issued" });
	} finally {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
});
