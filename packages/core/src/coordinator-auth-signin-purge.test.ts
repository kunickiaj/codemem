import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import { AUTH_BROWSER_TXN_SCHEMA_SQL } from "./coordinator-auth-browser-transaction-contract.js";
import {
	browserConfig as config,
	hash,
	materials,
	seed,
	TABLE,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	attempt,
	authorize,
	backendTest,
	expectRejected,
	type LinkFixture,
	NOW,
	type Test,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import { linked, sessionRows, signInInput } from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

const AGE = 7_200_000;
const WINDOW = 3_600_000;
const MAX_CLOCK = 9_007_199_254_140_991;
const FLOOR = "coordinator_auth_signin_purge_floors";
const scope = { coordinatorId: config.coordinatorId };
const purged = (processedCount = 0, limit = 256) => ({
	kind: "purged",
	processedCount,
	more: processedCount === limit,
});

function purge(f: LinkFixture, owner: unknown = scope, options?: unknown) {
	return f.store.purgeAuthSigninBrowserTransactions(
		owner as Parameters<typeof f.store.purgeAuthSigninBrowserTransactions>[0],
		options as Parameters<typeof f.store.purgeAuthSigninBrowserTransactions>[1],
	);
}
function floor(f: LinkFixture, coordinatorId = scope.coordinatorId): number | null {
	const row = f.db.prepare(`SELECT * FROM ${FLOOR} WHERE coordinator_id = ?`).get(coordinatorId);
	if (!row) return null;
	return Object.values(row).find((value): value is number => typeof value === "number") ?? null;
}
function protectedData(f: LinkFixture) {
	const tables = f.db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN (?,?) ORDER BY name",
		)
		.all(TABLE, FLOOR) as { name: string }[];
	return tables.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function snapshot(f: LinkFixture) {
	return [transactionRows(f), f.db.prepare(`SELECT * FROM ${FLOOR}`).all(), protectedData(f)];
}
function trace(f: LinkFixture, beforeRun?: (statement: AuthLinkStatement) => void) {
	const first = vi.fn<AuthLinkBackend["first"]>(async ({ sql, values }) => {
		return f.db.prepare(sql).get(...values) ?? null;
	});
	const run = vi.fn<AuthLinkBackend["run"]>(async (statement) => {
		beforeRun?.(statement);
		return f.db.prepare(statement.sql).run(...statement.values).changes;
	});
	const batch = vi.fn<AuthLinkBackend["batch"]>(async (statements) => {
		f.db.transaction(() => {
			for (const { sql, values } of statements) f.db.prepare(sql).run(...values);
		})();
	});
	return {
		first,
		run,
		batch,
		capability: new CoordinatorAuthBrowserTransactions({ first, run, batch }, () => f.now),
	};
}
function setCreated(f: LinkFixture, id: number, created: number) {
	f.db
		.prepare(`UPDATE ${TABLE} SET created_at_ms = ?, expires_at_ms = ? WHERE state_hash = ?`)
		.run(created, created + TTL, hash(20000 + id));
}
async function startLink(f: LinkFixture) {
	await authorize(f);
	await f.store.createAuthLinkAttempt(attempt(), f.cfg);
	const input = { ...materials(500), purpose: "link" as const, attemptId: "attempt-a" };
	expect((await f.store.startAuthBrowserTransaction(input, config)).kind).toBe("started");
	return input;
}
// Store-trusted metadata only: no provider verification or cookie-proof claims.
async function consumed(f: LinkFixture, id = 1) {
	const input = materials(id);
	expect((await f.store.startAuthBrowserTransaction(input, config)).kind).toBe("started");
	const result = await f.store.consumeAuthBrowserTransaction(input, config);
	if (result.kind !== "consumed") throw new Error("fixture_consume_failed");
	return {
		browserTransactionHash: result.browserTransactionHash,
		credentialHash: hash(9000 + id),
		account: { issuer: config.issuer, subject: "opaque-subject-a" },
	};
}

function registerEligibility(test: Test) {
	test("two-hour boundary purges every signin state but preserves newer, foreign and link rows", async ({
		fixture: f,
	}) => {
		// Arrange
		await startLink(f);
		seed(f, 6);
		f.db
			.prepare(
				`UPDATE ${TABLE} SET state='expired',nonce=NULL,pkce_verifier=NULL WHERE state_hash=?`,
			)
			.run(hash(20002));
		f.db
			.prepare(
				`UPDATE ${TABLE} SET state='consumed',nonce=NULL,pkce_verifier=NULL,claim_token='fixture',consumed_at_ms=? WHERE state_hash=?`,
			)
			.run(NOW, hash(20003));
		setCreated(f, 4, NOW + 1);
		setCreated(f, 6, NOW + AGE + 1);
		f.db.prepare(`UPDATE ${TABLE} SET coordinator_id='other' WHERE state_hash=?`).run(hash(20005));
		const before = transactionRows(f);
		const protectedBefore = protectedData(f);
		f.now = NOW + AGE;
		// Act
		const result = await purge(f);
		// Assert: links remain even when expired; every deleted creation is covered by the durable floor.
		expect(result).toEqual(purged(3));
		expect(transactionRows(f)).toEqual(
			before.filter(
				(row) =>
					row.purpose === "link" ||
					[hash(20004), hash(20005), hash(20006)].includes(String(row.state_hash)),
			),
		);
		expect(floor(f)).toBe(NOW);
		for (const row of before.filter(
			(row) => !transactionRows(f).some((left) => left.state_hash === row.state_hash),
		))
			expect(Number(row.created_at_ms)).toBeLessThanOrEqual(floor(f) ?? -1);
		expect(protectedData(f)).toEqual(protectedBefore);
	});
	test("expired future-born links and unrelated ceremony data stay identical", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		await f.store.recordAuthAccountProfile(
			{ credentialHash: signInInput(f).credentialHash, profile: { displayName: "Fixture Person" } },
			f.cfg,
		);
		await f.store.createAuthLinkAttempt(
			attempt({ attemptId: "attempt-b", runtimeVerifierHash: hash(99) }),
			f.cfg,
		);
		await f.store.startAuthBrowserTransaction(
			{ ...materials(500), purpose: "link", attemptId: "attempt-b" },
			config,
		);
		seed(f, 1);
		f.db
			.prepare(
				`UPDATE ${TABLE} SET state='expired',nonce=NULL,pkce_verifier=NULL,created_at_ms=?,expires_at_ms=? WHERE purpose='link'`,
			)
			.run(NOW + AGE + 1, NOW + AGE + TTL + 1);
		const links = transactionRows(f).filter((row) => row.purpose === "link");
		const before = protectedData(f);
		f.now += AGE;
		// Act
		const result = await purge(f);
		// Assert
		expect(result).toEqual(purged(1));
		expect(transactionRows(f)).toEqual(links);
		expect(protectedData(f)).toEqual(before);
	});
	test("one millisecond before retention is empty and cannot create a floor", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1);
		f.now += AGE - 1;
		const before = snapshot(f);
		// Act
		const result = await purge(f);
		// Assert
		expect(result).toEqual(purged());
		expect(snapshot(f)).toEqual(before);
	});
}

function registerLimits(test: Test) {
	test("default cap deletes oldest creation then hash, including conservative final more", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 257);
		setCreated(f, 257, NOW - 1);
		f.now += AGE;
		const before = transactionRows(f);
		// Act
		const first = await purge(f);
		const left = transactionRows(f);
		const last = await purge(f, scope, { limit: 1 });
		const empty = await purge(f, scope, { limit: 1 });
		// Assert
		expect(first).toEqual(purged(256));
		expect(left).toEqual([before[255]]);
		expect(last).toEqual(purged(1, 1));
		expect(empty).toEqual(purged(0, 1));
		expect(transactionRows(f)).toEqual([]);
		expect(floor(f)).toBe(NOW);
	});
	test("custom limit caps only deletion, not the eligible maximum recorded in the floor", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 3);
		setCreated(f, 3, NOW + 100);
		f.now += AGE + 100;
		// Act
		const result = await purge(f, scope, { limit: 1 });
		// Assert
		expect(result).toEqual(purged(1, 1));
		expect(transactionRows(f).map((row) => row.state_hash)).toEqual([hash(20002), hash(20003)]);
		expect(floor(f)).toBe(NOW + 100);
	});
	test("sixteen capped purges free the 4096 backstop across all retained states", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 4096);
		f.db.exec(
			`UPDATE ${TABLE} SET state='expired',nonce=NULL,pkce_verifier=NULL WHERE rowid % 3 = 0`,
		);
		f.db
			.prepare(
				`UPDATE ${TABLE} SET state='consumed',nonce=NULL,pkce_verifier=NULL,claim_token=browser_transaction_hash,consumed_at_ms=? WHERE rowid % 3 = 1`,
			)
			.run(NOW);
		f.now = NOW + WINDOW;
		const blocked = await f.store.startAuthBrowserTransaction(materials(18000), config);
		f.now = NOW + AGE;
		// Act
		const results = [];
		for (let index = 0; index < 16; index++) results.push(await purge(f));
		const started = await f.store.startAuthBrowserTransaction(materials(18000), config);
		// Assert
		expectRejected(blocked, "transaction_limited");
		expect(results).toEqual(Array.from({ length: 16 }, () => purged(256)));
		expect(started.kind).toBe("started");
		expect(transactionRows(f)).toHaveLength(1);
		expect(floor(f)).toBe(NOW);
	});
}

function registerFloors(test: Test) {
	test("actual maximum, not a distant cutoff, allows legitimate starts after a forward jump", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1);
		f.now = NOW + AGE * 100;
		// Act
		const result = await purge(f);
		f.now = NOW + WINDOW;
		const started = await f.store.startAuthBrowserTransaction(materials(2), config);
		// Assert
		expect(result).toEqual(purged(1));
		expect(floor(f)).toBe(NOW);
		expect(started.kind).toBe("started");
	});
	test("purged 1024-start window blocks rollback until the exact strict window boundary", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1024);
		f.now = NOW + AGE + 10;
		for (let index = 0; index < 4; index++) await purge(f);
		const before = protectedData(f);
		// Act
		const denied = [];
		for (const offset of [30 * 60_000, WINDOW - 1]) {
			f.now = NOW + offset;
			denied.push(await f.store.startAuthBrowserTransaction(materials(8000), config));
		}
		const rowsBeforeBoundary = transactionRows(f);
		f.now = NOW + WINDOW;
		const allowed = await f.store.startAuthBrowserTransaction(materials(8000), config);
		// Assert
		for (const result of denied) expectRejected(result, "clock_retention_blocked");
		expect(rowsBeforeBoundary).toEqual([]);
		expect(allowed.kind).toBe("started");
		expect(floor(f)).toBe(NOW);
		expect(protectedData(f)).toEqual(before);
	});
	test("live rolling-window cap remains 1024 after old rows are purged", async ({ fixture: f }) => {
		// Arrange
		seed(f, 1024);
		f.now += AGE;
		for (let index = 0; index < 4; index++) await purge(f);
		seed(f, 1023, f.now);
		// Act
		const last = await f.store.startAuthBrowserTransaction(materials(8000), config);
		const blocked = await f.store.startAuthBrowserTransaction(materials(8001), config);
		// Assert
		expect(last.kind).toBe("started");
		expectRejected(blocked, "transaction_limited");
		expect(transactionRows(f)).toHaveLength(1024);
	});
	test("floor survives empty calls, lower clocks, config rotation and stays coordinator-scoped", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 2);
		f.now += AGE;
		await purge(f, scope, { limit: 1 });
		f.db.exec(
			`CREATE TRIGGER no_floor_rewrite BEFORE UPDATE ON ${FLOOR} BEGIN SELECT RAISE(ABORT,'unexpected-floor-write'); END`,
		);
		const equal = await purge(f);
		f.now = NOW + 1;
		seed(f, 1, NOW - AGE);
		const rotated = {
			...config,
			issuer: "https://other.example.test",
			revision: hash(99),
			redirectUri: "https://coordinator.example.test/new",
		};
		// Act
		const lower = await purge(f);
		const empty = await purge(f);
		const denied = await f.store.startAuthBrowserTransaction(materials(3), rotated);
		const foreign = await f.store.startAuthBrowserTransaction(materials(3), {
			...rotated,
			coordinatorId: "other",
		});
		// Assert
		expect(equal).toEqual(purged(1));
		expect(lower).toEqual(purged(1));
		expect(empty).toEqual(purged());
		expect(floor(f)).toBe(NOW);
		expect(floor(f, "other")).toBeNull();
		expectRejected(denied, "clock_retention_blocked");
		expect(foreign.kind).toBe("started");
	});
	test("future-created eligible data imposes a known availability wait through F plus one hour", async ({
		fixture: f,
	}) => {
		// Arrange
		const future = NOW + AGE * 10;
		seed(f, 1, future);
		f.now = future + AGE;
		await purge(f);
		// Act
		f.now = NOW;
		const rollback = await f.store.startAuthBrowserTransaction(materials(3), config);
		f.now = future + WINDOW - 1;
		const early = await f.store.startAuthBrowserTransaction(materials(3), config);
		f.now++;
		const exact = await f.store.startAuthBrowserTransaction(materials(3), config);
		// Assert
		expect(floor(f)).toBe(future);
		expectRejected(rollback, "clock_retention_blocked");
		expectRejected(early, "clock_retention_blocked");
		expect(exact.kind).toBe("started");
	});
}

function registerReplay(test: Test) {
	test("purged pending and consumed-unissued proofs stay unavailable after rollback", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await consumed(f);
		await f.store.startAuthBrowserTransaction(materials(2), config);
		f.now += AGE;
		await purge(f);
		f.now = NOW;
		const before = snapshot(f);
		// Act
		const pending = await f.store.consumeAuthBrowserTransaction(materials(2), config);
		const cancelled = await f.store.cancelAuthSigninBrowserTransaction(
			{ binderHash: materials(2).binderHash },
			scope,
		);
		const issuance = await f.store.signInWithConsumedBrowserTransaction(input, config);
		// Assert
		expectRejected(pending, "transaction_unavailable");
		expect(cancelled).toEqual({ kind: "unavailable" });
		expectRejected(issuance, "transaction_unavailable");
		expect(snapshot(f)).toEqual(before);
	});
	test("issued sessions, receipts and profiles outlive browser proof purge", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await consumed(f);
		expect((await f.store.signInWithConsumedBrowserTransaction(input, config)).kind).toBe("issued");
		await f.store.recordAuthAccountProfile(
			{ credentialHash: input.credentialHash, profile: { displayName: "Fixture Person" } },
			f.cfg,
		);
		const before = protectedData(f);
		f.now += AGE;
		// Act
		const result = await purge(f);
		const session = await f.store.readAuthSession(input.credentialHash, f.cfg);
		// Assert
		expect(result).toEqual(purged(1));
		expect(session).toMatchObject({ identityId: "identity-a" });
		expect(protectedData(f)).toEqual(before);
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
	});
	test("retained receipt burns a purged hash forever while fresh hashes permit state and binder reuse", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await consumed(f);
		await f.store.signInWithConsumedBrowserTransaction(input, config);
		f.now += AGE;
		await purge(f);
		const bytes = Uint8Array.from(input.browserTransactionHash.match(/../gu) ?? [], (byte) =>
			Number.parseInt(byte, 16),
		);
		const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
			if (!(array instanceof Uint8Array)) throw new Error("fixture_expected_bytes");
			array.set(bytes);
			return array;
		});
		// Act
		let collision: unknown;
		try {
			collision = await f.store.startAuthBrowserTransaction(materials(), config);
		} finally {
			random.mockRestore();
		}
		const legacy = await f.store.signInWithAuthAccount(
			{ ...input, credentialHash: hash(900) },
			f.cfg,
		);
		await f.store.createAuthLinkAttempt(
			attempt({ attemptId: "attempt-b", runtimeVerifierHash: hash(999) }),
			f.cfg,
		);
		const oldClaim = await f.store.claimAuthLinkAttempt(
			{ attemptId: "attempt-b", browserTransactionHash: input.browserTransactionHash },
			f.cfg,
		);
		const fresh = await f.store.startAuthBrowserTransaction(materials(), config);
		// Assert: state/binder collision detection is retention-scoped; receipts are not.
		expectRejected(collision, "transaction_conflict");
		expectRejected(legacy, "browser_transaction_used");
		expectRejected(oldClaim, "attempt_unavailable");
		expect(fresh.kind).toBe("started");
		expect(transactionRows(f)).toHaveLength(1);
		expect(transactionRows(f)[0].browser_transaction_hash).not.toBe(input.browserTransactionHash);
	});
}

function registerFaults(test: Test) {
	test.for(["floor", "delete"] as const)(
		"failed %s stage preserves proof and redacts diagnostics without authority changes",
		async (stage, { fixture: f }) => {
			// Arrange
			await linked(f);
			seed(f, 2);
			f.now += AGE;
			const table = stage === "floor" ? FLOOR : TABLE;
			const operation = stage === "floor" ? "INSERT" : "DELETE";
			f.db.exec(
				`CREATE TRIGGER fault BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'private-provider-nonce-marker'); END`,
			);
			const before = transactionRows(f);
			const protectedBefore = protectedData(f);
			// Act
			const error = await purge(f).catch((caught: unknown) => caught);
			// Assert: stage B failure leaves only an availability floor, never an authority row.
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({ message: "auth_browser_transaction_persistence_error" });
			expect((error as Error).cause).toBeUndefined();
			expect(transactionRows(f)).toEqual(before);
			expect(protectedData(f)).toEqual(protectedBefore);
			expect(floor(f)).toBe(stage === "floor" ? null : NOW);
		},
	);
	test("insertion between stages above the captured floor survives until the next floor advance", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1);
		f.now += AGE + 100;
		let inserted = false;
		const traced = trace(f, ({ sql }) => {
			if (!/^DELETE\s/iu.test(sql) || inserted) return;
			inserted = true;
			f.db
				.prepare(`INSERT INTO ${TABLE}
				(coordinator_id,browser_transaction_hash,purpose,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
				SELECT coordinator_id,?,'signin',?,?,issuer,auth_config_revision,redirect_uri,'pending',nonce,pkce_verifier,?,? FROM ${TABLE} LIMIT 1`)
				.run(hash(999), hash(998), hash(997), NOW + 1, NOW + TTL + 1);
		});
		// Act
		const first = await traced.capability.purgeAuthSigninBrowserTransactions(scope);
		const survivor = transactionRows(f);
		const recorded = floor(f);
		const next = await purge(f);
		// Assert
		expect(first).toEqual(purged(1));
		expect(recorded).toBe(NOW);
		expect(survivor).toHaveLength(1);
		expect(survivor[0].created_at_ms).toBe(NOW + 1);
		expect(next).toEqual(purged(1));
		expect(floor(f)).toBe(NOW + 1);
		expect(transactionRows(f)).toEqual([]);
	});
	test("missing floor table sanitizes signin and purge failures but does not affect link start", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(attempt(), f.cfg);
		f.db.exec(`DROP TABLE ${FLOOR}`);
		// Act
		const errors = await Promise.all([
			f.store.startAuthBrowserTransaction(materials(), config).catch((error: unknown) => error),
			purge(f).catch((error: unknown) => error),
		]);
		const link = await f.store.startAuthBrowserTransaction(
			{ ...materials(2), purpose: "link", attemptId: "attempt-a" },
			config,
		);
		// Assert
		for (const error of errors) {
			expect(error).toMatchObject({ message: "auth_browser_transaction_persistence_error" });
			expect((error as Error).cause).toBeUndefined();
		}
		expect(link.kind).toBe("started");
	});
}

function registerValidation(test: Test) {
	test.for([
		null,
		[],
		1,
		"1",
		{ limit: 0 },
		{ limit: 257 },
		{ limit: -1 },
		{ limit: 1.5 },
		{ limit: NaN },
		{ limit: Infinity },
		{ limit: "1" },
		{ limit: undefined },
	])("invalid options %# reject before SQL", async (options, { fixture: f }) => {
		// Arrange
		const traced = trace(f);
		// Act
		const result = await traced.capability.purgeAuthSigninBrowserTransactions(
			scope,
			options as never,
		);
		// Assert
		expectRejected(result, "invalid_input");
		expect(traced.first).not.toHaveBeenCalled();
		expect(traced.run).not.toHaveBeenCalled();
		expect(traced.batch).not.toHaveBeenCalled();
	});
	test.for(["coordinatorId", "limit"] as const)(
		"hostile %s descriptors and proxies reject without access, coercion or SQL",
		async (key, { fixture: f }) => {
			// Arrange
			const invoked = vi.fn(() => {
				throw new Error("private-input-marker");
			});
			const base = key === "limit" ? { limit: 1 } : scope;
			const bad = [
				null,
				[],
				Object.create({ [key]: 1 }),
				{ [key]: { valueOf: invoked, toString: invoked } },
				Object.defineProperty({}, key, { get: invoked }),
				new Proxy(base, {
					get: invoked,
					getOwnPropertyDescriptor: () => {
						throw new Error("private-reflection-marker");
					},
				}),
			];
			if (key === "coordinatorId")
				bad.push({}, { coordinatorId: "" }, { coordinatorId: "bad\n" }, { coordinatorId: 1 });
			const traced = trace(f);
			// Act
			const results = [];
			for (const value of bad)
				results.push(
					await traced.capability.purgeAuthSigninBrowserTransactions(
						(key === "coordinatorId" ? value : scope) as never,
						(key === "limit" ? value : undefined) as never,
					),
				);
			// Assert
			for (const result of results) expectRejected(result, "invalid_input");
			expect(invoked).not.toHaveBeenCalled();
			expect(traced.first).not.toHaveBeenCalled();
			expect(traced.run).not.toHaveBeenCalled();
			expect(traced.batch).not.toHaveBeenCalled();
		},
	);
	test.for([NaN, Infinity, -1, 1.5, MAX_CLOCK + 1, Number.MAX_SAFE_INTEGER])(
		"invalid clock %# throws before SQL",
		async (now, { fixture: f }) => {
			// Arrange
			f.now = now;
			const traced = trace(f);
			// Act
			const operation = traced.capability.purgeAuthSigninBrowserTransactions(scope);
			// Assert
			await expect(operation).rejects.toThrow(/^auth_link_invalid_clock$/u);
			expect(traced.first).not.toHaveBeenCalled();
			expect(traced.run).not.toHaveBeenCalled();
			expect(traced.batch).not.toHaveBeenCalled();
		},
	);
	test.for([0, AGE - 1, MAX_CLOCK])(
		"safe clock %# permits empty purge without a floor write",
		async (now, { fixture: f }) => {
			// Arrange
			f.now = now;
			f.db.exec(
				`CREATE TRIGGER no_floor_insert BEFORE INSERT ON ${FLOOR} BEGIN SELECT RAISE(ABORT,'unexpected-write'); END`,
			);
			// Act
			const result = await purge(f, scope, {});
			// Assert
			expect(result).toEqual(purged());
			expect(floor(f)).toBeNull();
		},
	);
}

function registerSql(test: Test) {
	test("two separate portable capped writes use durable floor protection without batch or authority reads", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1);
		f.now += AGE;
		const traced = trace(f);
		// Act
		const result = await traced.capability.purgeAuthSigninBrowserTransactions(scope);
		// Assert
		expect(result).toEqual(purged(1));
		expect(traced.run).toHaveBeenCalledTimes(2);
		const [advance, deletion] = traced.run.mock.calls.map(([statement]) => statement.sql);
		expect(advance).toMatch(/MAX\s*\(/iu);
		expect(advance).toContain(FLOOR);
		expect(deletion).toMatch(/^DELETE\s/iu);
		expect(deletion).toContain(FLOOR);
		expect(deletion).toMatch(
			/ORDER BY[\s\S]*created_at_ms[\s\S]*browser_transaction_hash[\s\S]*LIMIT/iu,
		);
		expect(deletion).not.toMatch(/DELETE FROM\s+\w+\s+LIMIT/iu);
		expect(traced.first).not.toHaveBeenCalled();
		expect(traced.batch).not.toHaveBeenCalled();
	});
	test("signin floor admission happens inside insertion and collision diagnostics retain priority", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1);
		f.now += AGE;
		await purge(f);
		f.now = NOW + 1;
		seed(f, 1, f.now);
		const traced = trace(f);
		// Act
		const result = await traced.capability.startAuthBrowserTransaction(
			{ ...materials(), stateHash: hash(20001) },
			config,
		);
		// Assert
		expectRejected(result, "transaction_conflict");
		const sql = traced.run.mock.calls[0][0].sql;
		expect(sql).toMatch(/^INSERT INTO/iu);
		expect(sql).toContain(FLOOR);
		expect(sql).toMatch(/NOT EXISTS/iu);
		expect(traced.first.mock.invocationCallOrder[0]).toBeGreaterThan(
			traced.run.mock.invocationCallOrder[0],
		);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	test("largest valid clock purges actual old data and starts without timestamp overflow", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1, MAX_CLOCK - AGE);
		f.now = MAX_CLOCK;
		// Act
		const result = await purge(f);
		const started = await f.store.startAuthBrowserTransaction(materials(), config);
		// Assert
		expect(result).toEqual(purged(1));
		expect(floor(f)).toBe(MAX_CLOCK - AGE);
		expect(started).toEqual({ kind: "started", expiresAtMs: Number.MAX_SAFE_INTEGER });
	});
	test("fresh store creates the shared floor schema without seeding retention history", async ({
		fixture: f,
	}) => {
		// Arrange
		const reference = new Database(":memory:");
		try {
			reference.exec(AUTH_BROWSER_TXN_SCHEMA_SQL);
			// Act
			const actual = floorSchema(f.db);
			// Assert
			expect(actual).toEqual(floorSchema(reference));
			expect(floor(f)).toBeNull();
		} finally {
			reference.close();
		}
	});
	registerEligibility(test);
	registerLimits(test);
	registerFloors(test);
	registerReplay(test);
	registerFaults(test);
	registerValidation(test);
	registerSql(test);
}
describe.each(["SQLite", "D1"] as const)("%s signin purge (D1 is SQLite-backed)", registerBackend);

it("floor write count is not deletion authority and purge never uses a transaction batch", async () => {
	// Arrange
	const run = vi.fn<AuthLinkBackend["run"]>().mockResolvedValueOnce(0).mockResolvedValueOnce(7);
	const first = vi.fn<AuthLinkBackend["first"]>();
	const batch = vi.fn<AuthLinkBackend["batch"]>();
	const capability = new CoordinatorAuthBrowserTransactions({ first, run, batch }, () => NOW);
	// Act
	const result = await capability.purgeAuthSigninBrowserTransactions(scope);
	// Assert
	expect(result).toEqual(purged(7));
	expect(run).toHaveBeenCalledTimes(2);
	expect(first).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});

function floorSchema(db: Database.Database) {
	return {
		columns: db.prepare(`PRAGMA table_info(${FLOOR})`).all(),
		definition: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(FLOOR),
		indexes: db.prepare(`PRAGMA index_list(${FLOOR})`).all(),
	};
}
it("fresh/shared SQL and migrations 20 plus 23 have identical empty floor schema and replay safely", () => {
	// Arrange
	const directory = join(import.meta.dirname, "../../cloudflare-coordinator-worker/migrations");
	const migration20 = readFileSync(
		join(directory, "0020_add_auth_browser_transactions.sql"),
		"utf8",
	);
	const migration23 = readFileSync(
		join(directory, "0023_add_auth_signin_purge_floors.sql"),
		"utf8",
	);
	const db = new Database(":memory:");
	const reference = new Database(":memory:");
	try {
		reference.exec(AUTH_BROWSER_TXN_SCHEMA_SQL);
		db.exec(migration20);
		db.exec(migration23);
		const before = floorSchema(db);
		// Act
		db.prepare(`INSERT INTO ${FLOOR} VALUES (?,?)`).run(scope.coordinatorId, NOW);
		db.exec(migration23);
		// Assert
		expect(before).toEqual(floorSchema(reference));
		expect(floorSchema(db)).toEqual(before);
		expect(reference.prepare(`SELECT * FROM ${FLOOR}`).all()).toEqual([]);
		expect(Object.values(db.prepare(`SELECT * FROM ${FLOOR}`).get() ?? {})).toEqual([
			scope.coordinatorId,
			NOW,
		]);
	} finally {
		db.close();
		reference.close();
	}
});
it.each([-1, 0.5, MAX_CLOCK + 1, null])(
	"floor schema rejects invalid timestamp %s without replacing a valid row",
	(value) => {
		// Arrange
		const db = new Database(":memory:");
		try {
			db.exec(AUTH_BROWSER_TXN_SCHEMA_SQL);
			db.prepare(`INSERT INTO ${FLOOR} VALUES (?,?)`).run(scope.coordinatorId, MAX_CLOCK);
			const before = db.prepare(`SELECT * FROM ${FLOOR}`).all();
			// Act
			const invalid = () =>
				db.prepare(`INSERT OR REPLACE INTO ${FLOOR} VALUES (?,?)`).run(scope.coordinatorId, value);
			// Assert
			expect(invalid).toThrow();
			expect(db.prepare(`SELECT * FROM ${FLOOR}`).all()).toEqual(before);
		} finally {
			db.close();
		}
	},
);
