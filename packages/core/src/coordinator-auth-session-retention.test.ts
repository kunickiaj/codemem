import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import {
	browserConfig,
	hash,
	materials,
	TABLE,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	backendTest,
	expectRejected,
	type LinkFixture,
	NOW,
	type Test,
} from "./coordinator-auth-link-test-fixtures.js";
import { AuthSessionOperations } from "./coordinator-auth-session.js";
import {
	linked,
	redeemInput,
	SESSION_TTL,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

const SESSIONS = "coordinator_auth_sessions";
const RECEIPTS = "coordinator_auth_session_receipts";
const GRACE = 24 * 3_600_000;
const AGE = SESSION_TTL + GRACE;
const scope = { coordinatorId: browserConfig.coordinatorId };
const methods = ["purgeAuthGuardedSigninSessions", "purgeAuthGuardedSigninReceipts"] as const;
type Method = (typeof methods)[number];
const purged = (processedCount = 0, limit = 256) => ({
	kind: "purged",
	processedCount,
	more: processedCount === limit,
});

function rows(f: LinkFixture, table: string) {
	return f.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[];
}
function snapshot(f: LinkFixture, omit: string[] = []) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables.filter(({ name }) => !omit.includes(name)).map(({ name }) => [name, rows(f, name)]);
}
function purge(f: LinkFixture, method: Method, options?: unknown, owner: unknown = scope) {
	return f.store[method](owner as never, options as never);
}
function traced(f: LinkFixture, clock = () => f.now) {
	const first = vi.fn<AuthLinkBackend["first"]>(
		async ({ sql, values }) => f.db.prepare(sql).get(...values) ?? null,
	);
	const run = vi.fn<AuthLinkBackend["run"]>(
		async ({ sql, values }) => f.db.prepare(sql).run(...values).changes,
	);
	const batch = vi.fn<AuthLinkBackend["batch"]>(async () => {
		throw new Error("unexpected_batch");
	});
	return { first, run, batch, capability: new AuthSessionOperations({ first, run, batch }, clock) };
}
// Synthetic persisted metadata is not HTTP authentication or provider proof.
function seed(f: LinkFixture, id = 1, changes: Record<string, unknown> = {}) {
	const session = {
		coordinator_id: scope.coordinatorId,
		session_id: `session-${id}`,
		credential_hash: hash(10_000 + id),
		browser_transaction_hash: hash(20_000 + id),
		link_id: "link-a",
		identity_id: "identity-a",
		issuer: browserConfig.issuer,
		subject: "opaque-subject-a",
		auth_config_revision: browserConfig.revision,
		created_at_ms: NOW,
		expires_at_ms: NOW + SESSION_TTL,
		revoked_at_ms: null,
		...changes,
	};
	insert(f.db, SESSIONS, session);
	insert(f.db, RECEIPTS, {
		coordinator_id: session.coordinator_id,
		browser_transaction_hash: session.browser_transaction_hash,
		source: "signin",
		attempt_id: null,
		link_id: session.link_id,
		session_id: session.session_id,
		auth_config_revision: session.auth_config_revision,
		created_at_ms: session.created_at_ms,
		purge_eligible: 1,
	});
	return session;
}
function insert(db: Database.Database, table: string, row: Record<string, unknown>) {
	db.prepare(
		`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
			.map(() => "?")
			.join(",")})`,
	).run(...Object.values(row));
}
async function consumedInput(f: LinkFixture, id = 1) {
	const input = materials(id);
	expect((await f.store.startAuthBrowserTransaction(input, browserConfig)).kind).toBe("started");
	const consumed = await f.store.consumeAuthBrowserTransaction(input, browserConfig);
	if (consumed.kind !== "consumed") throw new Error("fixture_consume_failed");
	const trusted = {
		browserTransactionHash: consumed.browserTransactionHash,
		credentialHash: hash(30_000 + id),
		account: { issuer: browserConfig.issuer, subject: "opaque-subject-a" },
	};
	return trusted;
}
async function guarded(f: LinkFixture, id = 1) {
	const trusted = await consumedInput(f, id);
	expect((await f.store.signInWithConsumedBrowserTransaction(trusted, browserConfig)).kind).toBe(
		"issued",
	);
	return trusted;
}
async function cleanup(f: LinkFixture) {
	await f.store.purgeAuthSigninBrowserTransactions(scope);
	await purge(f, methods[0]);
	await purge(f, methods[1]);
}

function registerBoundaries(test: Test) {
	test.for([-1, 0, 1])("session grace boundary offset %s", async (offset, { fixture: f }) => {
		// Arrange
		seed(f);
		f.now = NOW + AGE + offset;
		const before = rows(f, RECEIPTS);
		// Act
		const result = await purge(f, methods[0]);
		// Assert
		expect(result).toEqual(purged(offset < 0 ? 0 : 1));
		expect(rows(f, SESSIONS)).toHaveLength(offset < 0 ? 1 : 0);
		expect(rows(f, RECEIPTS)).toEqual(before);
	});
	test.for([-1, 0, 1])(
		"receipt age boundary offset %s after session removal",
		async (offset, { fixture: f }) => {
			// Arrange
			seed(f);
			f.db.exec(`DELETE FROM ${SESSIONS}`);
			f.now = NOW + AGE + offset;
			// Act
			const result = await purge(f, methods[1]);
			// Assert
			expect(result).toEqual(purged(offset < 0 ? 0 : 1));
			expect(rows(f, RECEIPTS)).toHaveLength(offset < 0 ? 1 : 0);
		},
	);
	test("receipt cleanup cannot precede session cleanup, including revoked sessions", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1, { revoked_at_ms: NOW });
		seed(f, 2);
		f.now += AGE;
		// Act
		const early = await purge(f, methods[1]);
		const sessions = await purge(f, methods[0]);
		const receipts = await purge(f, methods[1]);
		// Assert
		expect(early).toEqual(purged());
		expect(sessions).toEqual(purged(2));
		expect(receipts).toEqual(purged(2));
		expect(sessionRows(f)).toEqual([[], []]);
	});
	test("foreign browser transactions do not block the owner but owner transactions do", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await guarded(f);
		f.now += AGE;
		// Act
		const blocked = await purge(f, methods[0]);
		f.db.prepare(`UPDATE ${TABLE} SET coordinator_id='other'`).run();
		const allowed = await purge(f, methods[0]);
		const receipt = await purge(f, methods[1]);
		// Assert
		expect(blocked).toEqual(purged());
		expect(allowed).toEqual(purged(1));
		expect(receipt).toEqual(purged(1));
		expect(rows(f, TABLE)[0].browser_transaction_hash).toBe(input.browserTransactionHash);
	});
}

function registerCoherence(test: Test) {
	test("owner browser transaction preserves an old receipt even with no remaining session", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await guarded(f);
		f.db.exec(`DELETE FROM ${SESSIONS}`);
		f.now += AGE * 10;
		const before = snapshot(f);
		// Act
		const blocked = await purge(f, methods[1]);
		const retained = snapshot(f);
		await f.store.purgeAuthSigninBrowserTransactions(scope);
		const allowed = await purge(f, methods[1]);
		// Assert
		expect(blocked).toEqual(purged());
		expect(retained).toEqual(before);
		expect(allowed).toEqual(purged(1));
		expect(rows(f, RECEIPTS)).toEqual([]);
	});
	test.for([
		{ link_id: "wrong" },
		{ session_id: "wrong" },
		{ browser_transaction_hash: hash(999) },
		{ auth_config_revision: hash(998) },
		{ created_at_ms: NOW + 1 },
		{ coordinator_id: "other" },
		{ purge_eligible: 0 },
		{ source: "link_redeem", attempt_id: "attempt-a", purge_eligible: 0 },
	])("incoherent receipt %j cannot authorize session deletion", async (changes, { fixture: f }) => {
		// Arrange
		seed(f);
		const keys = Object.keys(changes);
		f.db
			.prepare(`UPDATE ${RECEIPTS} SET ${keys.map((key) => `${key}=?`).join(",")}`)
			.run(...Object.values(changes));
		f.now += AGE * 10;
		const before = snapshot(f);
		// Act
		const result = await purge(f, methods[0]);
		// Assert
		expect(result).toEqual(purged());
		expect(snapshot(f)).toEqual(before);
	});
	test("orphan sessions never acquire deletion authority", async ({ fixture: f }) => {
		// Arrange
		seed(f);
		f.db.exec(`DELETE FROM ${RECEIPTS}`);
		f.now += AGE * 100;
		const before = snapshot(f);
		// Act
		const result = await purge(f, methods[0]);
		// Assert
		expect(result).toEqual(purged());
		expect(snapshot(f)).toEqual(before);
	});
	test.for(["session_id", "browser_transaction_hash"] as const)(
		"any session sharing %s preserves a receipt despite other mismatches",
		async (key, { fixture: f }) => {
			// Arrange
			seed(f);
			f.db
				.prepare(
					`UPDATE ${SESSIONS} SET ${key === "session_id" ? "browser_transaction_hash" : "session_id"}=?,link_id='unrelated',subject='unrelated'`,
				)
				.run(key === "session_id" ? hash(999) : "unrelated");
			f.now += AGE * 10;
			const before = snapshot(f);
			// Act
			const result = await purge(f, methods[1]);
			// Assert
			expect(result).toEqual(purged());
			expect(snapshot(f)).toEqual(before);
		},
	);
	test("two distinct sessions matching receipt ID and hash both prevent deletion", async ({
		fixture: f,
	}) => {
		// Arrange
		const first = seed(f);
		f.db
			.prepare(`UPDATE ${SESSIONS} SET browser_transaction_hash=?,link_id='other-link'`)
			.run(hash(999));
		insert(f.db, SESSIONS, {
			...first,
			session_id: "other-id",
			credential_hash: hash(998),
			subject: "other-subject",
		});
		f.now += AGE * 10;
		const before = snapshot(f);
		// Act
		const result = await purge(f, methods[1]);
		// Assert
		expect(result).toEqual(purged());
		expect(snapshot(f)).toEqual(before);
	});
}

function registerOrigins(test: Test) {
	test("only guarded signin marks new receipts eligible; legacy and link redemption remain permanent", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		await f.store.signInWithAuthAccount({ ...signInInput(f), credentialHash: hash(301) }, f.cfg);
		await guarded(f);
		const before = rows(f, RECEIPTS);
		f.now += AGE * 100;
		// Act
		await cleanup(f);
		// Assert
		expect(before.map((row) => [row.source, row.purge_eligible])).toEqual([
			["link_redeem", 0],
			["signin", 0],
			["signin", 1],
		]);
		expect(rows(f, RECEIPTS)).toEqual(before.filter((row) => row.purge_eligible === 0));
		expect(rows(f, SESSIONS)).toHaveLength(2);
	});
	test("legacy-original hash remains rejected before and after very old cleanup", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = signInInput(f);
		await f.store.signInWithAuthAccount(input, f.cfg);
		// Act
		const before = await f.store.signInWithAuthAccount(
			{ ...input, credentialHash: hash(999) },
			f.cfg,
		);
		f.now += AGE * 100;
		await cleanup(f);
		const after = await f.store.signInWithAuthAccount(
			{ ...input, credentialHash: hash(998) },
			f.cfg,
		);
		// Assert
		expectRejected(before, "browser_transaction_used");
		expectRejected(after, "browser_transaction_used");
		expect(rows(f, RECEIPTS)[0].purge_eligible).toBe(0);
	});
	test("link-created session and receipt survive while active and long after expiry", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		const before = sessionRows(f);
		// Act
		const active = await Promise.all(methods.map((method) => purge(f, method)));
		f.now += AGE * 100;
		const expired = await Promise.all(methods.map((method) => purge(f, method)));
		// Assert
		expect(active).toEqual([purged(), purged()]);
		expect(expired).toEqual([purged(), purged()]);
		expect(sessionRows(f)).toEqual(before);
	});
}

function registerReplay(test: Test) {
	test("lagging S3 cleanup retains both records and rollback cannot replay consumed proof", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await guarded(f);
		f.now += AGE * 10;
		const before = snapshot(f);
		// Act
		const results = await Promise.all(methods.map((method) => purge(f, method)));
		f.now = NOW;
		const replay = await f.store.signInWithConsumedBrowserTransaction(
			{ ...input, credentialHash: hash(999) },
			browserConfig,
		);
		// Assert
		expect(results).toEqual([purged(), purged()]);
		expectRejected(replay, "browser_transaction_used");
		expect(snapshot(f)).toEqual(before);
	});
	test("after S3 and session deletion, retained receipt still burns the hash", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await guarded(f);
		f.now += AGE;
		await f.store.purgeAuthSigninBrowserTransactions(scope);
		// Act
		const deletion = await purge(f, methods[0]);
		f.now = NOW;
		const legacy = await f.store.signInWithAuthAccount(input, f.cfg);
		const replay = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
		// Assert
		expect(deletion).toEqual(purged(1));
		expectRejected(legacy, "browser_transaction_used");
		expectRejected(replay, "browser_transaction_used");
		expect(rows(f, RECEIPTS)).toHaveLength(1);
		expect(await f.store.readAuthSession(input.credentialHash, f.cfg)).toBeNull();
	});
	test("approved trusted legacy reuse can mint after all guarded records are gone, not from old proof", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await guarded(f);
		f.now += AGE;
		await cleanup(f);
		f.now = NOW;
		// Act
		const oldCookie = await f.store.readAuthSession(input.credentialHash, f.cfg);
		const oldProof = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
		const trustedLegacy = await f.store.signInWithAuthAccount(input, f.cfg);
		// Assert
		expect(oldCookie).toBeNull();
		expectRejected(oldProof, "transaction_unavailable");
		expect(trustedLegacy.kind).toBe("issued");
		expect(rows(f, RECEIPTS)[0].purge_eligible).toBe(0);
	});
	test("cleanup preserves permanent authority, purge floor and dangling profile without exposing it", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await guarded(f);
		await f.store.recordAuthAccountProfile(
			{ credentialHash: input.credentialHash, profile: { displayName: "Fixture Person" } },
			f.cfg,
		);
		expect(await f.store.readAuthSessionAccount(input.credentialHash, f.cfg)).toMatchObject({
			profile: { displayName: "Fixture Person" },
		});
		f.now += AGE;
		await f.store.purgeAuthSigninBrowserTransactions(scope);
		const protectedBefore = snapshot(f, [SESSIONS, RECEIPTS]);
		// Act
		await purge(f, methods[0]);
		await purge(f, methods[1]);
		f.now = NOW;
		const session = await f.store.readAuthSession(input.credentialHash, f.cfg);
		const account = await f.store.readAuthSessionAccount(input.credentialHash, f.cfg);
		// Assert
		expect(session).toBeNull();
		expect(account).toBeNull();
		expect(snapshot(f, [SESSIONS, RECEIPTS])).toEqual(protectedBefore);
	});
	test("ten live current-config sessions remain readable after cleanup and large rollback", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const old = await guarded(f);
		f.now += AGE;
		await cleanup(f);
		const live = [];
		for (let id = 2; id <= 11; id++) live.push(await guarded(f, id));
		// Act
		const denied = await f.store.signInWithConsumedBrowserTransaction(
			await consumedInput(f, 12),
			browserConfig,
		);
		await cleanup(f);
		const readable = await Promise.all(
			live.map((input) => f.store.readAuthSession(input.credentialHash, f.cfg)),
		);
		f.now = NOW;
		const rolledBack = await Promise.all(
			live.map((input) => f.store.readAuthSession(input.credentialHash, f.cfg)),
		);
		// Assert
		expectRejected(denied, "session_limited");
		expect(readable.filter(Boolean)).toHaveLength(10);
		expect(rolledBack.filter(Boolean).length).toBeLessThanOrEqual(10);
		expect(await f.store.readAuthSession(old.credentialHash, f.cfg)).toBeNull();
		expect(
			await f.store.readAuthSession(live[0].credentialHash, { ...f.cfg, revision: hash(997) }),
		).toBeNull();
	});
}

function registerPaging(test: Test) {
	test.for(methods)(
		"%s default 256 cap, deterministic oldest order and conservative more",
		async (method, { fixture: f }) => {
			// Arrange
			for (let id = 1; id <= 257; id++) seed(f, id);
			f.db
				.prepare(
					`UPDATE ${SESSIONS} SET created_at_ms=?,expires_at_ms=? WHERE session_id='session-257'`,
				)
				.run(NOW - 1, NOW + SESSION_TTL - 1);
			f.db
				.prepare(`UPDATE ${RECEIPTS} SET created_at_ms=? WHERE session_id='session-257'`)
				.run(NOW - 1);
			if (method === methods[1]) f.db.exec(`DELETE FROM ${SESSIONS}`);
			f.now += AGE;
			const table = method === methods[0] ? SESSIONS : RECEIPTS;
			const order =
				method === methods[0]
					? "expires_at_ms,session_id"
					: "created_at_ms,browser_transaction_hash";
			const expected = f.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
			// Act
			const first = await purge(f, method);
			const left = rows(f, table);
			const last = await purge(f, method, { limit: 1 });
			const empty = await purge(f, method, { limit: 1 });
			// Assert
			expect(first).toEqual(purged(256));
			expect(left).toEqual(expected.slice(256));
			expect(last).toEqual(purged(1, 1));
			expect(empty).toEqual(purged(0, 1));
		},
	);
	test.for(methods)(
		"%s custom cap and coordinator tuple isolation",
		async (method, { fixture: f }) => {
			// Arrange
			seed(f, 1);
			seed(f, 2);
			seed(f, 1, { coordinator_id: "other" });
			if (method === methods[1])
				f.db.exec(`DELETE FROM ${SESSIONS} WHERE coordinator_id='${scope.coordinatorId}'`);
			f.now += AGE;
			const foreign = [rows(f, SESSIONS), rows(f, RECEIPTS)].map((list) =>
				list.filter((row) => row.coordinator_id === "other"),
			);
			// Act
			const result = await purge(f, method, { limit: 1 });
			// Assert
			expect(result).toEqual(purged(1, 1));
			expect(
				[rows(f, SESSIONS), rows(f, RECEIPTS)].map((list) =>
					list.filter((row) => row.coordinator_id === "other"),
				),
			).toEqual(foreign);
			expect(
				rows(f, method === methods[0] ? SESSIONS : RECEIPTS).filter(
					(row) => row.coordinator_id === scope.coordinatorId,
				),
			).toHaveLength(1);
		},
	);
}

function registerValidation(test: Test, method: Method) {
	test.for([
		null,
		[],
		1,
		"1",
		{ limit: undefined },
		{ limit: 0 },
		{ limit: 257 },
		{ limit: -1 },
		{ limit: 1.5 },
		{ limit: NaN },
		{ limit: Infinity },
		{ limit: "1" },
	])(`${method} invalid options %# reject before SQL`, async (options, { fixture: f }) => {
		// Arrange
		const trace = traced(f);
		// Act
		const result = await trace.capability[method](scope, options as never);
		// Assert
		expectRejected(result, "invalid_input");
		expect(trace.first).not.toHaveBeenCalled();
		expect(trace.run).not.toHaveBeenCalled();
		expect(trace.batch).not.toHaveBeenCalled();
	});
	test.for(["coordinatorId", "limit"] as const)(
		`${method} rejects hostile %s capture without invoking getters`,
		async (key, { fixture: f }) => {
			// Arrange
			const invoked = vi.fn(() => {
				throw new Error("private-input");
			});
			const bad = [
				Object.create({ [key]: key === "limit" ? 1 : scope.coordinatorId }),
				Object.defineProperty({}, key, { get: invoked }),
				new Proxy({}, { getOwnPropertyDescriptor: invoked }),
				{ [key]: { valueOf: invoked, toString: invoked } },
			];
			const trace = traced(f);
			// Act
			const results = [];
			for (const value of bad)
				results.push(
					await trace.capability[method](
						(key === "coordinatorId" ? value : scope) as never,
						(key === "limit" ? value : undefined) as never,
					),
				);
			// Assert
			for (const result of results) expectRejected(result, "invalid_input");
			// Reflection may throw, but accessor/coercion callbacks must never run.
			expect(invoked.mock.calls).toHaveLength(1);
			expect(trace.run).not.toHaveBeenCalled();
			expect(trace.first).not.toHaveBeenCalled();
			expect(trace.batch).not.toHaveBeenCalled();
		},
	);
	test.for([
		null,
		[],
		{},
		{ coordinatorId: undefined },
		{ coordinatorId: "" },
		{ coordinatorId: "bad\n" },
		{ coordinatorId: 1 },
	])(`${method} invalid scope %# rejects before SQL`, async (owner, { fixture: f }) => {
		// Arrange
		const trace = traced(f);
		// Act
		const result = await trace.capability[method](owner as never);
		// Assert
		expectRejected(result, "invalid_input");
		expect(trace.run).not.toHaveBeenCalled();
		expect(trace.first).not.toHaveBeenCalled();
		expect(trace.batch).not.toHaveBeenCalled();
	});
	test.for([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER - SESSION_TTL + 1])(
		`${method} invalid clock %s fails before SQL`,
		async (now, { fixture: f }) => {
			// Arrange
			const trace = traced(f, () => now);
			// Act
			const result = trace.capability[method](scope);
			// Assert
			await expect(result).rejects.toThrow(/^auth_session_invalid_clock$/u);
			expect(trace.run).not.toHaveBeenCalled();
			expect(trace.first).not.toHaveBeenCalled();
		},
	);
	test.for([0, AGE - 1, Number.MAX_SAFE_INTEGER - SESSION_TTL])(
		`${method} valid clock %s supports empty operation`,
		async (now, { fixture: f }) => {
			// Arrange
			f.now = now;
			const before = snapshot(f);
			// Act
			const result = await purge(f, method, {});
			// Assert
			expect(result).toEqual(purged());
			expect(snapshot(f)).toEqual(before);
		},
	);
	test(`${method} throwing clock is sanitized without SQL`, async ({ fixture: f }) => {
		// Arrange
		const trace = traced(f, () => {
			throw new Error("private-clock");
		});
		// Act
		const result = trace.capability[method](scope);
		// Assert
		await expect(result).rejects.toThrow(/^auth_session_invalid_clock$/u);
		expect(trace.run).not.toHaveBeenCalled();
	});
}

function registerFaultsAndSql(test: Test) {
	test.for(methods)(
		"%s captures owned primitives before clock callbacks mutate input",
		async (method, { fixture: f }) => {
			// Arrange
			seed(f, 1);
			seed(f, 2);
			if (method === methods[1]) f.db.exec(`DELETE FROM ${SESSIONS}`);
			const owner = { ...scope };
			const options = { limit: 1 };
			const clock = vi.fn(() => {
				owner.coordinatorId = "other";
				options.limit = 256;
				return NOW + AGE;
			});
			const trace = traced(f, clock);
			// Act
			const result = await trace.capability[method](owner, options);
			// Assert
			expect(result).toEqual(purged(1, 1));
			expect(clock).toHaveBeenCalledTimes(1);
			expect(rows(f, method === methods[0] ? SESSIONS : RECEIPTS)).toHaveLength(1);
		},
	);
	test.for(methods)(
		"%s delete failure is atomic and redacts private diagnostics",
		async (method, { fixture: f }) => {
			// Arrange
			seed(f);
			if (method === methods[1]) f.db.exec(`DELETE FROM ${SESSIONS}`);
			const table = method === methods[0] ? SESSIONS : RECEIPTS;
			f.db.exec(
				`CREATE TRIGGER fault BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'private-marker'); END`,
			);
			f.now += AGE;
			const before = snapshot(f);
			// Act
			const result = await purge(f, method).catch((error: unknown) => error);
			// Assert
			expect(result).toBeInstanceOf(Error);
			expect(result).toMatchObject({ message: "auth_session_persistence_error" });
			expect((result as Error).cause).toBeUndefined();
			expect(snapshot(f)).toEqual(before);
		},
	);
	test.for(methods)(
		"%s performs one portable ordered capped write without authority reads",
		async (method, { fixture: f }) => {
			// Arrange
			seed(f);
			if (method === methods[1]) f.db.exec(`DELETE FROM ${SESSIONS}`);
			f.now += AGE;
			const trace = traced(f);
			// Act
			const result = await trace.capability[method](scope, { limit: 1 });
			// Assert
			expect(result).toEqual(purged(1, 1));
			expect(trace.run).toHaveBeenCalledTimes(1);
			const sql = trace.run.mock.calls[0][0].sql;
			expect(sql).toMatch(/^DELETE\s/iu);
			expect(sql).toMatch(/SELECT[\s\S]*ORDER BY[\s\S]*LIMIT/iu);
			expect(sql).toMatch(
				method === methods[0]
					? /ORDER BY[\s\S]*expires_at_ms[\s\S]*session_id/iu
					: /ORDER BY[\s\S]*created_at_ms[\s\S]*browser_transaction_hash/iu,
			);
			expect(sql).not.toMatch(/DELETE FROM\s+\w+\s+LIMIT/iu);
			expect(trace.first).not.toHaveBeenCalled();
			expect(trace.batch).not.toHaveBeenCalled();
		},
	);
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerBoundaries(test);
	registerCoherence(test);
	registerOrigins(test);
	registerReplay(test);
	registerPaging(test);
	for (const method of methods) registerValidation(test, method);
	registerFaultsAndSql(test);
}
describe.each(["SQLite", "D1"] as const)(
	"%s guarded session retention (D1 is SQLite-backed)",
	registerBackend,
);

it.each(methods)("%s zero write metadata grants no credential or authority", async (method) => {
	// Arrange
	const first = vi.fn<AuthLinkBackend["first"]>();
	const run = vi.fn<AuthLinkBackend["run"]>().mockResolvedValue(0);
	const batch = vi.fn<AuthLinkBackend["batch"]>();
	const capability = new AuthSessionOperations({ first, run, batch }, () => NOW + AGE);
	// Act
	const result = await capability[method](scope);
	// Assert
	expect(result).toEqual(purged());
	expect(Object.keys(result).sort()).toEqual(["kind", "more", "processedCount"]);
	expect(run).toHaveBeenCalledTimes(1);
	expect(first).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});

function migration(name: string) {
	return readFileSync(
		join(import.meta.dirname, "../../cloudflare-coordinator-worker/migrations", name),
		"utf8",
	);
}
function schema(db: Database.Database) {
	return [RECEIPTS, SESSIONS].map((table) => ({
		columns: db.pragma(`table_info(${table})`),
		ddl: String(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(table))
			.replace(/\s+/gu, " ")
			.replace(/\s*,\s*/gu, ",")
			.trim(),
		indexes: (
			db.pragma(`index_list(${table})`) as { name: string; unique: number; partial: number }[]
		)
			.map((index) => ({
				name: index.name,
				unique: index.unique,
				partial: index.partial,
				columns: db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name),
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
	}));
}
function historical(db: Database.Database) {
	for (const id of [1, 2])
		insert(db, RECEIPTS, {
			coordinator_id: scope.coordinatorId,
			browser_transaction_hash: hash(id),
			source: "signin",
			attempt_id: null,
			link_id: "historical-link",
			session_id: `historical-${id}`,
			auth_config_revision: browserConfig.revision,
			created_at_ms: NOW,
		});
}
it("versioned migration 24 runs once, keeps historical flags zero and rejects replay before mutation", () => {
	// Arrange
	const db = new Database(":memory:");
	const reference = connectCoordinator(":memory:");
	try {
		db.exec(migration("0018_add_auth_sessions.sql"));
		db.exec(migration("0022_add_auth_session_admission_index.sql"));
		historical(db);
		const upgrade = migration("0024_add_auth_guarded_signin_retention.sql");
		// Act
		db.exec(upgrade);
		const before = db.prepare(`SELECT * FROM ${RECEIPTS}`).all();
		const replay = () => db.exec(upgrade);
		// Assert
		expect(schema(db)).toEqual(schema(reference));
		expect(before).toHaveLength(2);
		expect(before).toEqual(
			expect.arrayContaining([expect.objectContaining({ purge_eligible: 0 })]),
		);
		expect(replay).toThrow(/duplicate column name: purge_eligible/u);
		expect(db.prepare(`SELECT * FROM ${RECEIPTS}`).all()).toEqual(before);
	} finally {
		db.close();
		reference.close();
	}
});
it("SQLite checks old receipt columns while holding an immediate write lock", () => {
	// Arrange: an independent connection can write before startup takes the lock.
	const directory = mkdtempSync(join(tmpdir(), "codemem-retention-lock-"));
	const path = join(directory, "fixture.sqlite");
	const probe = new Database(path, { timeout: 0 });
	let upgraded: Database.Database | undefined;
	let prepareSpy: ReturnType<typeof vi.spyOn> | undefined;
	const lockErrors: unknown[] = [];
	try {
		probe.exec(migration("0018_add_auth_sessions.sql"));
		probe.exec(migration("0022_add_auth_session_admission_index.sql"));
		probe.exec("BEGIN IMMEDIATE");
		probe.exec("ROLLBACK");
		const originalPrepare = Database.prototype.prepare;
		prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql: string,
		) {
			if (sql === "PRAGMA table_info(coordinator_auth_session_receipts)") {
				try {
					probe.exec("BEGIN IMMEDIATE");
					lockErrors.push(null);
				} catch (error) {
					lockErrors.push(error);
				} finally {
					if (probe.inTransaction) probe.exec("ROLLBACK");
				}
			}
			return originalPrepare.call(this, sql);
		});
		// Act: probe at the actual column check, not after an ALTER takes a lock.
		upgraded = connectCoordinator(path);
		// Assert: deferred or unlocked checks would let this independent writer in.
		expect(lockErrors).toHaveLength(1);
		expect(lockErrors[0]).toMatchObject({ code: "SQLITE_BUSY" });
		expect(probe.inTransaction).toBe(false);
	} finally {
		prepareSpy?.mockRestore();
		if (probe.inTransaction) probe.exec("ROLLBACK");
		upgraded?.close();
		probe.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
it("SQLite warm receipt upgrade uses the read hint without creating a writer transaction", () => {
	// Arrange: cold startup performs the upgrade before transaction instrumentation.
	const directory = mkdtempSync(join(tmpdir(), "codemem-retention-warm-"));
	const path = join(directory, "fixture.sqlite");
	const old = new Database(path);
	old.exec(migration("0018_add_auth_sessions.sql"));
	old.exec(migration("0022_add_auth_session_admission_index.sql"));
	historical(old);
	old.close();
	let warm: Database.Database | undefined;
	let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
	let prepareSpy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		const cold = connectCoordinator(path);
		const before = cold.prepare(`SELECT * FROM ${RECEIPTS}`).all();
		cold.close();
		// Both spies call through; no startup SQL or transaction mode is mocked.
		transactionSpy = vi.spyOn(Database.prototype, "transaction");
		prepareSpy = vi.spyOn(Database.prototype, "prepare");
		// Act
		warm = connectCoordinator(path);
		// Assert: this verifies the helper's fast path, not global lock-free startup.
		expect(prepareSpy).toHaveBeenCalledWith(
			"SELECT 1 FROM pragma_table_info('coordinator_auth_session_receipts') WHERE name = 'purge_eligible'",
		);
		expect(prepareSpy).not.toHaveBeenCalledWith(
			"PRAGMA table_info(coordinator_auth_session_receipts)",
		);
		expect(transactionSpy).not.toHaveBeenCalled();
		expect(warm.prepare(`SELECT * FROM ${RECEIPTS}`).all()).toEqual(before);
		expect(before).toHaveLength(2);
		expect(before).toEqual(
			expect.arrayContaining([expect.objectContaining({ purge_eligible: 0 })]),
		);
	} finally {
		prepareSpy?.mockRestore();
		transactionSpy?.mockRestore();
		warm?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
it("SQLite upgrades old 18/22 receipts without reclassifying historical signin rows and reconnects safely", () => {
	// Arrange: temporary database is test-owned, never the user's database.
	const directory = mkdtempSync(join(tmpdir(), "codemem-retention-"));
	const path = join(directory, "fixture.sqlite");
	const old = new Database(path);
	old.exec(migration("0018_add_auth_sessions.sql"));
	old.exec(migration("0022_add_auth_session_admission_index.sql"));
	historical(old);
	const before = old.prepare(`SELECT * FROM ${RECEIPTS}`).all();
	old.close();
	const fresh = connectCoordinator(":memory:");
	let upgraded: Database.Database | undefined;
	try {
		// Act
		upgraded = connectCoordinator(path);
		const after = upgraded.prepare(`SELECT * FROM ${RECEIPTS}`).all() as Record<string, unknown>[];
		const firstSchema = schema(upgraded);
		upgraded.close();
		upgraded = connectCoordinator(path);
		// Assert: token-preserving punctuation normalization keeps every CHECK clause.
		expect(after).toEqual(before.map((row) => ({ ...(row as object), purge_eligible: 0 })));
		expect(schema(upgraded)).toEqual(firstSchema);
		expect(firstSchema).toEqual(schema(fresh));
		expect((upgraded.pragma(`table_info(${RECEIPTS})`) as { name: string }[]).at(-1)?.name).toBe(
			"purge_eligible",
		);
	} finally {
		upgraded?.close();
		fresh.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
