import { describe, expect, it, vi } from "vitest";
import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import {
	browserCapability,
	browserConfig as config,
	hash,
	materials,
	seed,
	TABLE,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	attempt,
	authorize,
	backendTest,
	device,
	expectRejected,
	type LinkFixture,
	NOW,
	type Test,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import { linked, signInInput } from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

const scope = { coordinatorId: config.coordinatorId };
const retired = (processedCount = 0, limit = 32) => ({
	kind: "retired",
	processedCount,
	more: processedCount === limit,
});
const expired = (row: Record<string, unknown>) => ({
	...row,
	state: "expired",
	nonce: null,
	pkce_verifier: null,
});

// Snapshot every fixture-owned table, including profiles and enrollment metadata.
function protectedData(f: LinkFixture) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> ? ORDER BY name")
		.all(TABLE) as { name: string }[];
	return JSON.stringify(
		tables.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]),
	);
}
function allData(f: LinkFixture) {
	return [protectedData(f), JSON.stringify(transactionRows(f))];
}
async function startLink(f: LinkFixture) {
	await authorize(f);
	await f.store.createAuthLinkAttempt(attempt(), f.cfg);
	const input = { ...materials(), purpose: "link" as const, attemptId: "attempt-a" };
	expect((await f.store.startAuthBrowserTransaction(input, config)).kind).toBe("started");
	return input;
}
function cancel(f: LinkFixture, input: unknown, owner: unknown = scope) {
	return f.store.cancelAuthSigninBrowserTransaction(
		input as Parameters<typeof f.store.cancelAuthSigninBrowserTransaction>[0],
		owner as Parameters<typeof f.store.cancelAuthSigninBrowserTransaction>[1],
	);
}
function retire(f: LinkFixture, cfg: unknown = config, options?: unknown) {
	return f.store.retireAuthBrowserTransactions(
		cfg as Parameters<typeof f.store.retireAuthBrowserTransactions>[0],
		options as Parameters<typeof f.store.retireAuthBrowserTransactions>[1],
	);
}

function registerCancellation(test: Test) {
	test("own binder cancels only its pending signin and acknowledges expired retries", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		seed(f, 2);
		const before = transactionRows(f);
		const protectedBefore = protectedData(f);
		// Act
		const result = await cancel(f, { binderHash: hash(30001) });
		const retry = await cancel(f, { binderHash: hash(30001) });
		// Assert
		expect(result).toEqual({ kind: "cancelled" });
		expect(retry).toEqual(result);
		expect(transactionRows(f)).toEqual([expired(before[0]), before[1]]);
		expect(protectedData(f)).toBe(protectedBefore);
	});
	test.for(["wrong", "other-coordinator", "missing", "consumed", "link"])(
		"cancellation cannot touch $0 proof",
		async (variant, { fixture: f }) => {
			// Arrange
			const input = variant === "link" ? await startLink(f) : materials();
			if (variant !== "link" && variant !== "missing")
				await f.store.startAuthBrowserTransaction(input, config);
			if (variant === "consumed") await f.store.consumeAuthBrowserTransaction(input, config);
			const before = allData(f);
			// Act
			const result = await cancel(
				f,
				{ binderHash: variant === "wrong" ? hash(99) : input.binderHash },
				variant === "other-coordinator" ? { coordinatorId: "other" } : scope,
			);
			// Assert
			expect(result).toEqual({ kind: "unavailable" });
			expect(allData(f)).toEqual(before);
		},
	);
	test("explicit cancellation accepts a future-born own row but retirement leaves it alone", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1);
		f.now = NOW - 1;
		const before = transactionRows(f);
		// Act
		const swept = await retire(f, { ...config, enabled: false });
		const afterSweep = transactionRows(f);
		const cancelled = await cancel(f, { binderHash: hash(30001) });
		// Assert
		expect(swept).toEqual(retired());
		expect(afterSweep).toEqual(before);
		expect(cancelled).toEqual({ kind: "cancelled" });
		expect(transactionRows(f)).toEqual(before.map(expired));
	});
}

function registerEligibility(test: Test) {
	test("live signin and browser-claimed link remain pending; wrong cookie does not fail a link", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = await startLink(f);
		seed(f, 1);
		const before = allData(f);
		// Act
		const wrongCookie = await f.store.resolveAuthLinkBrowserTransaction(
			{ ...input, binderHash: hash(99) },
			config,
		);
		const result = await retire(f);
		// Assert
		expect(wrongCookie).toBeNull();
		expect(result).toEqual(retired());
		expect(allData(f)).toEqual(before);
	});
	test.for(["issuer", "revision", "redirectUri", "disabled", "deadline"])(
		"retires pending rows for $0 while preserving consumed, expired and foreign rows",
		async (variant, { fixture: f }) => {
			// Arrange
			await linked(f);
			await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
			seed(f, 3);
			await f.store.startAuthBrowserTransaction(materials(), config);
			await f.store.consumeAuthBrowserTransaction(materials(), config);
			f.db
				.prepare(
					`UPDATE ${TABLE} SET state = 'expired', nonce = NULL, pkce_verifier = NULL WHERE state_hash = ?`,
				)
				.run(hash(20002));
			f.db
				.prepare(`UPDATE ${TABLE} SET coordinator_id = 'other' WHERE state_hash = ?`)
				.run(hash(20003));
			const before = transactionRows(f);
			const protectedBefore = protectedData(f);
			const changed = { ...config };
			if (variant === "issuer") changed.issuer = "https://other.example.test";
			if (variant === "revision") changed.revision = hash(99);
			if (variant === "redirectUri") changed.redirectUri = "https://coordinator.example.test/new";
			if (variant === "disabled") changed.enabled = false;
			if (variant === "deadline") f.now += TTL;
			// Act
			const result = await retire(f, changed);
			let restoredConfigConsume: unknown;
			if (variant === "issuer" || variant === "revision" || variant === "redirectUri") {
				restoredConfigConsume = await f.store.consumeAuthBrowserTransaction(
					{ stateHash: hash(20001), binderHash: hash(30001) },
					config,
				);
			}
			// Assert
			expect(result).toEqual(retired(1));
			if (restoredConfigConsume !== undefined)
				expectRejected(restoredConfigConsume, "transaction_unavailable");
			expect(transactionRows(f)).toEqual(
				before.map((row) => (row.state_hash === hash(20001) ? expired(row) : row)),
			);
			expect(protectedData(f)).toBe(protectedBefore);
		},
	);
	test("expiry is strict at the deadline and old maintenance remains expiry-only", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1);
		const before = transactionRows(f);
		f.now += TTL - 1;
		// Act
		const early = await retire(f);
		const unchanged = transactionRows(f);
		f.now++;
		const exact = await retire(f);
		// Assert
		expect(early).toEqual(retired());
		expect(unchanged).toEqual(before);
		expect(exact).toEqual(retired(1));
		expect(transactionRows(f)).toEqual(before.map(expired));
	});
	test("strict maintenance does not retire config-obsolete unexpired rows", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1);
		f.db.prepare(`UPDATE ${TABLE} SET auth_config_revision = ?`).run(hash(99));
		const before = transactionRows(f);
		// Act
		const strict = await f.store.maintainAuthBrowserTransactions(scope);
		const afterStrict = transactionRows(f);
		const explicit = await retire(f);
		// Assert
		expect(strict).toEqual({ kind: "maintained", processedCount: 0, more: false });
		expect(afterStrict).toEqual(before);
		expect(explicit).toEqual(retired(1));
		expect(transactionRows(f)).toEqual(before.map(expired));
	});
}

function registerLinkEligibility(test: Test) {
	test.for(["device", "browser"] as const)(
		"failed link via $0 is retired without altering its attempt",
		async (requester, { fixture: f }) => {
			// Arrange
			const input = await startLink(f);
			const proof = await f.store.resolveAuthLinkBrowserTransaction(input, config);
			expect(proof).not.toBeNull();
			await f.store.failAuthLinkAttempt(
				{
					attemptId: input.attemptId,
					requester:
						requester === "device"
							? device
							: { kind: "browser", browserTransactionHash: proof?.browserTransactionHash ?? "" },
					reason: "cancelled",
				},
				f.cfg,
			);
			const before = transactionRows(f);
			const protectedBefore = protectedData(f);
			// Act
			const result = await retire(f);
			// Assert
			expect(result).toEqual(retired(1));
			expect(transactionRows(f)).toEqual(before.map(expired));
			expect(protectedData(f)).toBe(protectedBefore);
		},
	);
	test.for([
		"pending",
		"oidc_verified",
		"confirmed",
		"finalized",
		"session_redeemed",
		"failed",
		"expired",
		"missing",
		"hash",
		"issuer",
		"revision",
		"deadline",
		"coordinator",
		"attempt",
	])("link without live matching claim ($0) is retired", async (variant, { fixture: f }) => {
		// Arrange: mutate only the disposable fixture to isolate each eligibility predicate.
		await startLink(f);
		const table = "coordinator_auth_link_attempts";
		if (variant === "missing") f.db.prepare(`DELETE FROM ${table}`).run();
		else if (variant === "hash")
			f.db.prepare(`UPDATE ${table} SET browser_transaction_hash = ?`).run(hash(99));
		else if (variant === "issuer")
			f.db.prepare(`UPDATE ${table} SET issuer = ?`).run("https://other.example.test");
		else if (variant === "revision")
			f.db.prepare(`UPDATE ${table} SET auth_config_revision = ?`).run(hash(99));
		else if (variant === "deadline")
			f.db.prepare(`UPDATE ${table} SET created_at_ms = ?, expires_at_ms = ?`).run(NOW - TTL, NOW);
		else if (variant === "coordinator")
			f.db.prepare(`UPDATE ${table} SET coordinator_id = 'other'`).run();
		else if (variant === "attempt") f.db.prepare(`UPDATE ${table} SET attempt_id = 'other'`).run();
		else {
			f.db.exec("PRAGMA ignore_check_constraints = ON");
			f.db.prepare(`UPDATE ${table} SET state = ?`).run(variant);
			f.db.exec("PRAGMA ignore_check_constraints = OFF");
		}
		const before = transactionRows(f);
		const protectedBefore = protectedData(f);
		// Act
		const result = await retire(f);
		// Assert
		expect(result).toEqual(retired(1));
		expect(transactionRows(f)).toEqual(before.map(expired));
		expect(protectedData(f)).toBe(protectedBefore);
	});
}

function registerFutureScopedRetirement(test: Test) {
	test("scoped retirement clears a future-born failed link but general retirement cannot", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = await startLink(f);
		seed(f, 1);
		f.now = NOW - 1;
		const failed = await f.store.failAuthLinkAttempt(
			{ attemptId: input.attemptId, requester: device, reason: "cancelled" },
			f.cfg,
		);
		expect(failed.kind).toBe("applied");
		const before = transactionRows(f);
		const protectedBefore = protectedData(f);
		// Act
		const general = await retire(f);
		const afterGeneral = allData(f);
		const scoped = await retire(f, config, { attemptId: input.attemptId });
		const consumed = await f.store.consumeAuthBrowserTransaction(input, config);
		const resolved = await f.store.resolveAuthLinkBrowserTransaction(input, config);
		// Assert
		expect(general).toEqual(retired());
		expect(afterGeneral).toEqual([protectedBefore, JSON.stringify(before)]);
		expect(scoped).toEqual(retired(1));
		expectRejected(consumed, "transaction_unavailable");
		expect(resolved).toBeNull();
		expect(transactionRows(f)).toEqual(
			before.map((row) => (row.attempt_id === input.attemptId ? expired(row) : row)),
		);
		expect(protectedData(f)).toBe(protectedBefore);
	});
	test.for([
		{ enabled: false },
		{ issuer: "https://other.example.test" },
		{ revision: hash(99) },
		{ redirectUri: "https://coordinator.example.test/new" },
	])(
		"scoped retirement preserves future-born live link and signin under config change %j",
		async (change, { fixture: f }) => {
			// Arrange
			const input = await startLink(f);
			seed(f, 1);
			f.now = NOW - 1;
			const before = allData(f);
			// Act
			const scoped = await retire(f, { ...config, ...change }, { attemptId: input.attemptId });
			const general = await retire(f, { ...config, ...change });
			const unmatched = await retire(f, { ...config, ...change }, { attemptId: "missing" });
			// Assert
			expect(scoped).toEqual(retired());
			expect(general).toEqual(retired());
			expect(unmatched).toEqual(retired());
			expect(allData(f)).toEqual(before);
			expect(transactionRows(f).map((row) => row.state)).toEqual(["pending", "pending"]);
		},
	);
}

function registerLimits(test: Test) {
	test("forty eligible rows drain 32 then 8 and cannot reopen after clock rollback", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 40);
		const before = transactionRows(f);
		f.now += TTL;
		// Act
		const first = await retire(f);
		const firstRows = transactionRows(f);
		const second = await retire(f);
		f.now = NOW;
		const replay = await f.store.consumeAuthBrowserTransaction(
			{ stateHash: hash(20001), binderHash: hash(30001) },
			config,
		);
		const restart = await f.store.startAuthBrowserTransaction(
			{ ...materials(), binderHash: hash(30001) },
			config,
		);
		const empty = await retire(f);
		// Assert
		expect(first).toEqual(retired(32));
		expect(firstRows).toEqual(before.map((row, index) => (index < 32 ? expired(row) : row)));
		expect(second).toEqual(retired(8));
		expect(empty).toEqual(retired());
		expectRejected(replay, "transaction_unavailable");
		expectRejected(restart, "transaction_conflict");
		expect(transactionRows(f)).toEqual(before.map(expired));
	});
	test("limit orders by deadline then hash and more stays conservative for a full final batch", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 3);
		f.db
			.prepare(`UPDATE ${TABLE} SET created_at_ms = ?, expires_at_ms = ? WHERE state_hash = ?`)
			.run(NOW - 1, NOW + TTL - 1, hash(20003));
		const before = transactionRows(f);
		f.now += TTL;
		// Act
		const first = await retire(f, config, { limit: 2 });
		const firstRows = transactionRows(f);
		const last = await retire(f, config, { limit: 1 });
		const empty = await retire(f, config, { limit: 1 });
		// Assert
		expect(first).toEqual(retired(2, 2));
		expect(firstRows).toEqual([expired(before[0]), before[1], expired(before[2])]);
		expect(last).toEqual(retired(1, 1));
		expect(empty).toEqual(retired(0, 1));
	});
	test("attempt filter retires only its dead link, not other ceremonies", async ({
		fixture: f,
	}) => {
		// Arrange
		await startLink(f);
		await f.store.createAuthLinkAttempt(
			attempt({ attemptId: "attempt-b", runtimeVerifierHash: hash(99) }),
			f.cfg,
		);
		await f.store.startAuthBrowserTransaction(
			{ ...materials(2), purpose: "link", attemptId: "attempt-b" },
			config,
		);
		seed(f, 1);
		const before = transactionRows(f);
		const protectedBefore = protectedData(f);
		// Act
		const missing = await retire(f, { ...config, enabled: false }, { attemptId: "missing" });
		const result = await retire(f, { ...config, enabled: false }, { attemptId: "attempt-a" });
		// Assert
		expect(missing).toEqual(retired());
		expect(result).toEqual(retired(1));
		expect(transactionRows(f)).toEqual(
			before.map((row) => (row.attempt_id === "attempt-a" ? expired(row) : row)),
		);
		expect(protectedData(f)).toBe(protectedBefore);
	});
}

type InputField = "input" | "scope" | "config" | "limit" | "attemptId";
function hostileInputs(field: InputField, executed: () => never): unknown[] {
	const key = {
		input: "binderHash",
		scope: "coordinatorId",
		config: "redirectUri",
		limit: "limit",
		attemptId: "attemptId",
	}[field];
	let base: object = { [key]: 1 };
	if (field === "input") base = { binderHash: hash(30001) };
	if (field === "scope") base = scope;
	if (field === "config") base = config;
	const hostile: unknown[] = [
		null,
		[],
		{ ...base, [key]: 123 },
		Object.create(base),
		Object.defineProperty({ ...base }, key, { get: executed }),
		Object.create(Object.defineProperty({}, key, { get: executed })),
		{ ...base, [key]: { valueOf: executed, toString: executed } },
	];
	if (field === "input" || field === "scope" || field === "config") hostile.push({});
	return hostile;
}
function rejectHostile(f: LinkFixture, field: InputField, value: unknown) {
	if (field === "input") return cancel(f, value);
	if (field === "scope") return cancel(f, { binderHash: hash(30001) }, value);
	if (field === "config") return retire(f, value);
	return retire(f, config, value);
}

function registerValidation(test: Test) {
	test.for([
		null,
		[],
		1,
		"1",
		{ limit: 0 },
		{ limit: 33 },
		{ limit: -1 },
		{ limit: 1.5 },
		{ limit: NaN },
		{ limit: Infinity },
		{ limit: "1" },
		{ limit: undefined },
		{ attemptId: undefined },
		{ attemptId: "" },
		{ attemptId: 1 },
	])("invalid retirement options %# reject without writes", async (options, { fixture: f }) => {
		// Arrange
		seed(f, 1);
		const before = allData(f);
		// Act
		const result = await retire(f, { ...config, enabled: false }, options);
		// Assert
		expectRejected(result, "invalid_input");
		expect(allData(f)).toEqual(before);
	});
	test.for(["input", "scope", "config", "limit", "attemptId"] as const)(
		"rejects malformed $0 without evaluating accessors or coercion",
		async (field, { fixture: f }) => {
			// Arrange
			seed(f, 1);
			const before = allData(f);
			const executed = vi.fn(() => {
				throw new Error("private-marker");
			});
			const hostile = hostileInputs(field, executed);
			// Act
			const results = [];
			for (const value of hostile) results.push(await rejectHostile(f, field, value));
			// Assert
			for (const result of results) expectRejected(result, "invalid_input");
			expect(allData(f)).toEqual(before);
			expect(executed).not.toHaveBeenCalled();
		},
	);
	test.for(["input", "scope", "config", "limit", "attemptId"] as const)(
		"rejects throwing $0 proxy reflection without evaluating property values",
		async (field, { fixture: f }) => {
			// Arrange
			seed(f, 1);
			const before = allData(f);
			const key = {
				input: "binderHash",
				scope: "coordinatorId",
				config: "redirectUri",
				limit: "limit",
				attemptId: "attemptId",
			}[field];
			const coercion = vi.fn(() => {
				throw new Error("private-coercion-marker");
			});
			const get = vi.fn(() => {
				throw new Error("private-get-marker");
			});
			const reflection = vi.fn((target: object, inspected: PropertyKey) => {
				if (inspected === key) throw new Error("private-marker");
				return Reflect.getOwnPropertyDescriptor(target, inspected);
			});
			const target = { ...config, limit: 1, [key]: { valueOf: coercion, toString: coercion } };
			const proxy = new Proxy(target, { get, getOwnPropertyDescriptor: reflection });
			// Act
			const result = await rejectHostile(f, field, proxy);
			// Assert
			expectRejected(result, "invalid_input");
			expect(JSON.stringify(result)).not.toContain("private-marker");
			expect(reflection).toHaveBeenCalledWith(target, key);
			expect(get).not.toHaveBeenCalled();
			expect(coercion).not.toHaveBeenCalled();
			expect(allData(f)).toEqual(before);
		},
	);
	test.for([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])(
		"invalid clock %# throws before either method writes",
		async (now, { fixture: f }) => {
			// Arrange
			seed(f, 1);
			f.now = now;
			const before = allData(f);
			// Act
			const operations = [
				cancel(f, { binderHash: hash(30001) }),
				retire(f, { ...config, enabled: false }),
			];
			// Assert
			for (const operation of operations)
				await expect(operation).rejects.toThrow("auth_link_invalid_clock");
			expect(allData(f)).toEqual(before);
		},
	);
}

function registerFaults(test: Test) {
	test.for(["cancel", "retire"] as const)(
		"aborted $0 atomically preserves every row and redacts persistence errors",
		async (stage, { fixture: f }) => {
			// Arrange
			seed(f, 2);
			f.db.exec(
				`CREATE TRIGGER abort_retirement BEFORE UPDATE ON ${TABLE} WHEN OLD.state_hash = '${hash(20002)}' BEGIN SELECT RAISE(ABORT, 'private-nonce-provider-marker'); END`,
			);
			const before = allData(f);
			// Act
			const operation =
				stage === "cancel"
					? cancel(f, { binderHash: hash(30002) })
					: retire(f, { ...config, enabled: false });
			// Assert
			await expect(operation).rejects.toThrow(/^auth_browser_transaction_persistence_/);
			await expect(operation).rejects.not.toThrow("private-nonce-provider-marker");
			expect(allData(f)).toEqual(before);
		},
	);
	test("native zero changes reports no retirement authority and cancellation uses durable readback", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 2);
		const capability = browserCapability(f, { changes: 0 });
		const before = transactionRows(f);
		const protectedBefore = protectedData(f);
		// Act
		const cancelled = await capability.cancelAuthSigninBrowserTransaction(
			{ binderHash: hash(30001) },
			scope,
		);
		const result = await capability.retireAuthBrowserTransactions({ ...config, enabled: false });
		const replay = await capability.consumeAuthBrowserTransaction(
			{ stateHash: hash(20002), binderHash: hash(30002) },
			config,
		);
		// Assert
		expect(cancelled).toEqual({ kind: "cancelled" });
		expect(result).toEqual(retired());
		expectRejected(replay, "transaction_unavailable");
		expect(transactionRows(f)).toEqual(before.map(expired));
		expect(protectedData(f)).toBe(protectedBefore);
	});
}

for (const backend of ["SQLite", "D1"] as const satisfies readonly Backend[]) {
	describe(`${backend} explicit browser retirement (D1 is SQLite-backed)`, () => {
		const test = backendTest(backend);
		registerCancellation(test);
		registerEligibility(test);
		registerLinkEligibility(test);
		registerFutureScopedRetirement(test);
		registerLimits(test);
		registerValidation(test);
		registerFaults(test);
	});
}

it("retirement issues one capped UPDATE without reading authority or using batch", async () => {
	// Arrange
	const run = vi.fn<AuthLinkBackend["run"]>().mockResolvedValue(7);
	const first = vi.fn<AuthLinkBackend["first"]>();
	const batch = vi.fn<AuthLinkBackend["batch"]>();
	const capability = new CoordinatorAuthBrowserTransactions({ run, first, batch }, () => NOW);
	// Act
	const result = await capability.retireAuthBrowserTransactions(config);
	// Assert
	expect(result).toEqual(retired(7));
	expect(run).toHaveBeenCalledTimes(1);
	expect(run.mock.calls[0][0].sql).toMatch(/^UPDATE coordinator_auth_browser_transactions/u);
	expect(first).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});
