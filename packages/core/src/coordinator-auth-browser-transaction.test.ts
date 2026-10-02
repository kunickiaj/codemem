import { describe, expect, vi } from "vitest";
import type { CoordinatorAuthBrowserTransactionStartInput } from "./coordinator-auth-browser-transaction-contract.js";
import {
	browserCapability,
	browserConfig as config,
	hash,
	materials,
	seed,
	TABLE,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	advance,
	attempt,
	authorize,
	backendTest,
	completionHash,
	device,
	expectRejected,
	finalize,
	NOW,
	snapshot,
	type Test,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

function registerStartTests(test: Test) {
	test("signin start returns only expiry and stores fresh server-owned proof", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = materials();
		const before = snapshot(f);
		// Act
		const result = await f.store.startAuthBrowserTransaction(input, config);
		// Assert
		expect(result).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
		expect(transactionRows(f)).toHaveLength(1);
		expect(transactionRows(f)[0]).toMatchObject({
			purpose: "signin",
			attempt_id: null,
			state: "pending",
			state_hash: input.stateHash,
			binder_hash: input.binderHash,
			nonce: input.nonce,
			pkce_verifier: input.pkceVerifier,
		});
		expect(transactionRows(f)[0].browser_transaction_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(transactionRows(f)[0].browser_transaction_hash).not.toBe(input.stateHash);
		expect(snapshot(f)).toEqual(before);
	});
	test.for([
		{ stateHash: "A".repeat(64) },
		{ binderHash: "f".repeat(63) },
		{ nonce: "n".repeat(42) },
		{ nonce: "n".repeat(129) },
		{ nonce: "!".repeat(43) },
		{ pkceVerifier: "p".repeat(42) },
		{ pkceVerifier: "p".repeat(129) },
		{ browserTransactionHash: hash(50) },
		{ purpose: "signin", attemptId: "attempt-a" },
		{ purpose: "link" },
	])("invalid start shape %j rejects without writes", async (change, { fixture: f }) => {
		// Arrange
		const input = { ...materials(), ...change } as CoordinatorAuthBrowserTransactionStartInput;
		// Act
		const result = await f.store.startAuthBrowserTransaction(input, config);
		// Assert
		expectRejected(result, "invalid_input");
		expect(transactionRows(f)).toEqual([]);
	});
	test.for(["stateHash", "binderHash"] as const)(
		"used %s is burned even after expiry",
		async (key, { fixture: f }) => {
			// Arrange
			const input = materials();
			await f.store.startAuthBrowserTransaction(input, config);
			f.now += TTL;
			await f.store.maintainAuthBrowserTransactions({ coordinatorId: config.coordinatorId });
			const before = transactionRows(f);
			// Act
			const result = await f.store.startAuthBrowserTransaction(
				{ ...materials(2), [key]: input[key] },
				config,
			);
			// Assert
			expectRejected(result, "transaction_conflict");
			expect(transactionRows(f)).toEqual(before);
		},
	);
	test("disabled config rejects starts without writes", async ({ fixture: f }) => {
		// Arrange
		const disabled = { ...config, enabled: false };
		// Act
		const result = await f.store.startAuthBrowserTransaction(materials(), disabled);
		// Assert
		expectRejected(result, "auth_config_changed");
		expect(transactionRows(f)).toEqual([]);
	});
}

function registerConsumeTests(test: Test) {
	test("fresh capabilities share durable one-winner proof and ignore misleading changes counts", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = materials();
		const first = browserCapability(f, { changes: 0 });
		const second = browserCapability(f, { changes: 0 });
		await first.startAuthBrowserTransaction(input, config);
		// Act
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				(i % 2 === 0 ? first : second).consumeAuthBrowserTransaction(input, config),
			),
		);
		const replay = await browserCapability(f).consumeAuthBrowserTransaction(input, config);
		// Assert
		expect(results.filter((result) => result.kind === "consumed")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "rejected")).toHaveLength(7);
		expectRejected(replay, "transaction_unavailable");
	});
	test("consume returns original material once and permanently clears stored secrets", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = materials();
		await f.store.startAuthBrowserTransaction(input, config);
		const row = transactionRows(f)[0];
		// Act
		const result = await f.store.consumeAuthBrowserTransaction(input, config);
		const replay = await f.store.consumeAuthBrowserTransaction(input, config);
		// Assert
		expect(result).toEqual({
			kind: "consumed",
			purpose: "signin",
			browserTransactionHash: row.browser_transaction_hash,
			nonce: input.nonce,
			pkceVerifier: input.pkceVerifier,
		});
		expectRejected(replay, "transaction_unavailable");
		expect(transactionRows(f)[0]).toMatchObject({
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
			state_hash: input.stateHash,
			binder_hash: input.binderHash,
			consumed_at_ms: NOW,
		});
		expect(transactionRows(f)[0].claim_token).toEqual(expect.any(String));
	});
	test("eight concurrent callbacks expose material to exactly one winner", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = materials();
		await f.store.startAuthBrowserTransaction(input, config);
		// Act
		const results = await Promise.all(
			Array.from({ length: 8 }, () => f.store.consumeAuthBrowserTransaction(input, config)),
		);
		// Assert
		expect(results.filter((result) => result.kind === "consumed")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "rejected")).toEqual(
			Array.from({ length: 7 }, () => ({ kind: "rejected", error: "transaction_unavailable" })),
		);
		expect(transactionRows(f)[0].nonce).toBeNull();
	});
	test.for([
		{ change: { issuer: "https://other.example.test" }, error: "auth_config_changed" },
		{ change: { revision: hash(90) }, error: "auth_config_changed" },
		{
			change: { redirectUri: "https://coordinator.example.test/other" },
			error: "auth_config_changed",
		},
		{ change: { coordinatorId: "other" }, error: "transaction_unavailable" },
		{ change: { enabled: false }, error: "auth_config_changed" },
	])(
		"callback with changed config $change leaves pending material intact",
		async ({ change, error }, { fixture: f }) => {
			// Arrange
			const input = materials();
			await f.store.startAuthBrowserTransaction(input, config);
			const before = transactionRows(f);
			// Act
			const result = await f.store.consumeAuthBrowserTransaction(input, { ...config, ...change });
			// Assert
			expectRejected(result, error);
			expect(transactionRows(f)).toEqual(before);
		},
	);
	test.for(["stateHash", "binderHash"] as const)(
		"wrong %s cannot burn valid callback",
		async (key, { fixture: f }) => {
			// Arrange
			const input = materials();
			await f.store.startAuthBrowserTransaction(input, config);
			const before = transactionRows(f);
			// Act
			const result = await f.store.consumeAuthBrowserTransaction(
				{ ...input, [key]: hash(99) },
				config,
			);
			// Assert
			expectRejected(result, "transaction_unavailable");
			expect(transactionRows(f)).toEqual(before);
		},
	);
	test.for([-1, 0, 1])(
		"callback at expiry offset %s respects strict deadline",
		async (offset, { fixture: f }) => {
			// Arrange
			const input = materials();
			await f.store.startAuthBrowserTransaction(input, config);
			const before = transactionRows(f);
			f.now = NOW + TTL + offset;
			// Act
			const result = await f.store.consumeAuthBrowserTransaction(input, config);
			// Assert
			if (offset < 0) expect(result.kind).toBe("consumed");
			else {
				expectRejected(result, "transaction_unavailable");
				expect(transactionRows(f)).toEqual(before);
			}
		},
	);
}

function registerLinkAtomicityTests(test: Test) {
	test("concurrent fresh link starts claim one attempt for exactly one binder", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(attempt(), f.cfg);
		const inputs = [1, 2].map((value) => ({
			...materials(value),
			purpose: "link" as const,
			attemptId: "attempt-a",
		}));
		// Act
		const results = await Promise.all(
			inputs.map((input) => f.store.startAuthBrowserTransaction(input, config)),
		);
		const resolutions = await Promise.all(
			inputs.map((input) => f.store.resolveAuthLinkBrowserTransaction(input, config)),
		);
		const beforeRetry = transactionRows(f);
		const attemptsBeforeRetry = snapshot(f);
		const retry = await f.store.startAuthBrowserTransaction(
			{ ...materials(3), purpose: "link", attemptId: "attempt-a" },
			config,
		);
		// Assert
		expect(results.filter((result) => result.kind === "started")).toEqual([
			{ kind: "started", expiresAtMs: NOW + TTL },
		]);
		expect(results.filter((result) => result.kind === "rejected")).toEqual([
			{ kind: "rejected", error: "attempt_unavailable" },
		]);
		expect(beforeRetry).toHaveLength(1);
		const browserTransactionHash = beforeRetry[0].browser_transaction_hash;
		expect(attemptsBeforeRetry[0][0]).toMatchObject({
			attempt_id: "attempt-a",
			state: "browser_claimed",
			browser_transaction_hash: browserTransactionHash,
		});
		for (const [index, result] of results.entries()) {
			if (result.kind === "started") {
				expect(resolutions[index]).toEqual({ browserTransactionHash });
				expect(beforeRetry[0]).toMatchObject({
					state_hash: inputs[index].stateHash,
					binder_hash: inputs[index].binderHash,
				});
			} else expect(resolutions[index]).toBeNull();
		}
		expectRejected(retry, "attempt_unavailable");
		expect(transactionRows(f)).toEqual(beforeRetry);
		expect(snapshot(f)).toEqual(attemptsBeforeRetry);
	});
	test("server hash collision with an older link proof cannot cross ceremonies", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "browser_claimed");
		const before = snapshot(f);
		const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
			if (array instanceof Uint8Array) array.fill(204);
			return array;
		});
		try {
			// Act
			const result = await f.store.startAuthBrowserTransaction(materials(), config);
			// Assert
			expectRejected(result, "transaction_conflict");
			expect(transactionRows(f)).toEqual([]);
			expect(snapshot(f)).toEqual(before);
		} finally {
			random.mockRestore();
		}
	});
	test("ignored attempt claim rolls back the entire browser transaction", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(attempt(), f.cfg);
		f.db.exec(
			"CREATE TRIGGER ignore_browser_claim BEFORE UPDATE ON coordinator_auth_link_attempts WHEN NEW.state = 'browser_claimed' BEGIN SELECT RAISE(IGNORE); END",
		);
		const before = snapshot(f);
		// Act
		const result = f.store.startAuthBrowserTransaction(
			{ ...materials(), purpose: "link", attemptId: "attempt-a" },
			config,
		);
		// Assert
		await expect(result).rejects.toThrow(/^auth_browser_transaction_persistence_/);
		expect(transactionRows(f)).toEqual([]);
		expect(snapshot(f)).toEqual(before);
	});
	test("burned proof cannot claim a second link attempt", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(attempt(), f.cfg);
		await f.store.createAuthLinkAttempt(
			attempt({ attemptId: "attempt-b", runtimeVerifierHash: hash(100) }),
			f.cfg,
		);
		const input = { ...materials(), purpose: "link" as const, attemptId: "attempt-a" };
		await f.store.startAuthBrowserTransaction(input, config);
		const before = snapshot(f);
		const transactions = transactionRows(f);
		// Act
		const result = await f.store.startAuthBrowserTransaction(
			{ ...input, attemptId: "attempt-b" },
			config,
		);
		// Assert
		expectRejected(result, "transaction_conflict");
		expect(snapshot(f)).toEqual(before);
		expect(transactionRows(f)).toEqual(transactions);
	});
}

function registerLinkTests(test: Test) {
	test("link start claims the exact attempt atomically without extending its deadline", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(attempt(), f.cfg);
		f.now += 1000;
		const before = snapshot(f);
		const input = { ...materials(), purpose: "link" as const, attemptId: "attempt-a" };
		// Act
		const result = await f.store.startAuthBrowserTransaction(input, config);
		const resolved = await f.store.resolveAuthLinkBrowserTransaction(input, config);
		// Assert
		expect(result).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
		expect(resolved).toEqual({
			browserTransactionHash: transactionRows(f)[0].browser_transaction_hash,
		});
		expect(snapshot(f)[0][0]).toMatchObject({
			state: "browser_claimed",
			browser_transaction_hash: resolved?.browserTransactionHash,
		});
		expect(snapshot(f).slice(1)).toEqual(before.slice(1));
	});
	test.for(["missing", "expired", "failed"])(
		"link start denies %s attempt without transaction writes",
		async (state, { fixture: f }) => {
			// Arrange
			await authorize(f);
			if (state !== "missing") await f.store.createAuthLinkAttempt(attempt(), f.cfg);
			if (state === "expired") f.now += TTL;
			if (state === "failed")
				await f.store.failAuthLinkAttempt(
					{ attemptId: "attempt-a", requester: device, reason: "cancelled" },
					f.cfg,
				);
			const before = snapshot(f);
			// Act
			const result = await f.store.startAuthBrowserTransaction(
				{ ...materials(), purpose: "link", attemptId: "attempt-a" },
				config,
			);
			// Assert
			expectRejected(result, state === "expired" ? "attempt_expired" : "attempt_unavailable");
			expect(transactionRows(f)).toEqual([]);
			expect(snapshot(f)).toEqual(before);
		},
	);
	test("resolve retains link proof through trusted confirmation and finalization", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(attempt(), f.cfg);
		const input = { ...materials(), purpose: "link" as const, attemptId: "attempt-a" };
		await f.store.startAuthBrowserTransaction(input, config);
		const browserTransactionHash = transactionRows(f)[0].browser_transaction_hash as string;
		const proof = { attemptId: input.attemptId, browserTransactionHash };
		// Act
		const consumed = await f.store.consumeAuthBrowserTransaction(input, config);
		const afterConsume = await f.store.resolveAuthLinkBrowserTransaction(input, config);
		await f.store.recordAuthLinkOidcVerified(
			{ ...proof, account: { issuer: config.issuer, subject: "opaque-subject-a" } },
			f.cfg,
		);
		const afterVerify = await f.store.resolveAuthLinkBrowserTransaction(input, config);
		await f.store.confirmAuthLinkAttempt({ ...proof, completionSecretHash: completionHash }, f.cfg);
		const afterConfirm = await f.store.resolveAuthLinkBrowserTransaction(input, config);
		await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		const afterFinalize = await f.store.resolveAuthLinkBrowserTransaction(input, config);
		f.now += TTL;
		const expired = await f.store.resolveAuthLinkBrowserTransaction(input, config);
		// Assert
		expect(consumed).toEqual({
			kind: "consumed",
			purpose: "link",
			attemptId: input.attemptId,
			browserTransactionHash,
			nonce: input.nonce,
			pkceVerifier: input.pkceVerifier,
		});
		for (const result of [afterConsume, afterVerify, afterConfirm, afterFinalize])
			expect(result).toEqual({ browserTransactionHash });
		expect(expired).toBeNull();
	});
	test("failed link and wrong binder cannot resolve or consume pending material", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(attempt(), f.cfg);
		const input = { ...materials(), purpose: "link" as const, attemptId: "attempt-a" };
		await f.store.startAuthBrowserTransaction(input, config);
		// Act
		const wrong = await f.store.resolveAuthLinkBrowserTransaction(
			{ ...input, binderHash: hash(99) },
			config,
		);
		await f.store.failAuthLinkAttempt(
			{ attemptId: input.attemptId, requester: device, reason: "cancelled" },
			f.cfg,
		);
		const before = transactionRows(f);
		const failed = await f.store.resolveAuthLinkBrowserTransaction(input, config);
		const consumed = await f.store.consumeAuthBrowserTransaction(input, config);
		// Assert
		expect(wrong).toBeNull();
		expect(failed).toBeNull();
		expectRejected(consumed, "transaction_unavailable");
		expect(transactionRows(f)).toEqual(before);
	});
}

function registerAdmissionTests(test: Test) {
	test("4095 retained starts admit the last slot then permanently brake", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 4095, NOW - 7200000, "expired");
		// Act
		const admitted = await f.store.startAuthBrowserTransaction(materials(), config);
		const limited = await f.store.startAuthBrowserTransaction(materials(2), config);
		// Assert
		expect(admitted.kind).toBe("started");
		expectRejected(limited, "transaction_limited");
		expect(transactionRows(f)).toHaveLength(4096);
	});
	test("used proof remains a conflict when admission is already full", async ({ fixture: f }) => {
		// Arrange
		const input = materials();
		await f.store.startAuthBrowserTransaction(input, config);
		seed(f, 1023);
		const before = transactionRows(f);
		// Act
		const result = await f.store.startAuthBrowserTransaction(input, config);
		// Assert
		expectRejected(result, "transaction_conflict");
		expect(transactionRows(f)).toEqual(before);
	});
	test("1023 recent signin starts admit one then enforce the rolling window", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 1023);
		// Act
		const admitted = await f.store.startAuthBrowserTransaction(materials(), config);
		const limited = await f.store.startAuthBrowserTransaction(materials(2), config);
		// Assert
		expect(admitted.kind).toBe("started");
		expectRejected(limited, "transaction_limited");
		expect(transactionRows(f)).toHaveLength(1024);
	});
	test.for([-1, 0])(
		"rolling window cutoff offset %s uses strict greater-than",
		async (offset, { fixture: f }) => {
			// Arrange
			seed(f, 1024, NOW - 3600000 - offset, "expired");
			// Act
			const result = await f.store.startAuthBrowserTransaction(materials(), config);
			// Assert
			if (offset === 0) expect(result.kind).toBe("started");
			else expectRejected(result, "transaction_limited");
		},
	);
	test("retained expired signin history permanently caps admission across config rotation", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 4096, NOW - 7200000, "expired");
		const before = transactionRows(f);
		// Act
		const result = await f.store.startAuthBrowserTransaction(materials(), {
			...config,
			issuer: "https://rotated.example.test",
			revision: hash(90),
		});
		// Assert
		expectRejected(result, "transaction_limited");
		expect(transactionRows(f)).toEqual(before);
	});
	test("signin flood does not block an already authorized link attempt", async ({ fixture: f }) => {
		// Arrange
		seed(f, 4096, NOW - 7200000, "expired");
		await authorize(f);
		await f.store.createAuthLinkAttempt(attempt(), f.cfg);
		// Act
		const result = await f.store.startAuthBrowserTransaction(
			{ ...materials(), purpose: "link", attemptId: "attempt-a" },
			config,
		);
		// Assert
		expect(result.kind).toBe("started");
		expect(transactionRows(f)).toHaveLength(4097);
	});
}

function registerMaintenanceTests(test: Test) {
	test("explicit one-row maintenance limit never resweeps expired rows", async ({ fixture: f }) => {
		// Arrange
		seed(f, 2);
		f.now += TTL;
		// Act
		const first = await f.store.maintainAuthBrowserTransactions(
			{ coordinatorId: config.coordinatorId },
			{ limit: 1 },
		);
		const second = await f.store.maintainAuthBrowserTransactions(
			{ coordinatorId: config.coordinatorId },
			{ limit: 1 },
		);
		const empty = await f.store.maintainAuthBrowserTransactions(
			{ coordinatorId: config.coordinatorId },
			{ limit: 1 },
		);
		// Assert
		expect(first).toEqual({ kind: "maintained", processedCount: 1, more: true });
		expect(second).toEqual(first);
		expect(empty).toEqual({ kind: "maintained", processedCount: 0, more: false });
		expect(transactionRows(f)).toHaveLength(2);
	});
	test("maintenance expires only 32 then 8 rows without deleting proof history", async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f, 40);
		const before = snapshot(f);
		f.now += TTL;
		// Act
		const first = await f.store.maintainAuthBrowserTransactions({
			coordinatorId: config.coordinatorId,
		});
		const second = await f.store.maintainAuthBrowserTransactions({
			coordinatorId: config.coordinatorId,
		});
		f.now = NOW;
		const replay = await f.store.consumeAuthBrowserTransaction(
			{ stateHash: hash(20001), binderHash: hash(30001) },
			config,
		);
		// Assert
		expect(first).toEqual({ kind: "maintained", processedCount: 32, more: true });
		expect(second).toEqual({ kind: "maintained", processedCount: 8, more: false });
		expect(transactionRows(f)).toHaveLength(40);
		for (const row of transactionRows(f))
			expect(row).toMatchObject({ state: "expired", nonce: null, pkce_verifier: null });
		expectRejected(replay, "transaction_unavailable");
		expect(snapshot(f)).toEqual(before);
	});
	test.for([0, 33, 1.5, Number.NaN])(
		"invalid maintenance limit %s leaves rows unchanged",
		async (limit, { fixture: f }) => {
			// Arrange
			seed(f, 1);
			f.now += TTL;
			const before = transactionRows(f);
			// Act
			const result = await f.store.maintainAuthBrowserTransactions(
				{ coordinatorId: config.coordinatorId },
				{ limit },
			);
			// Assert
			expectRejected(result, "invalid_input");
			expect(transactionRows(f)).toEqual(before);
		},
	);
	test("maintenance preserves unexpired and consumed rows and other coordinators", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = materials();
		await f.store.startAuthBrowserTransaction(input, config);
		await f.store.consumeAuthBrowserTransaction(input, config);
		await f.store.startAuthBrowserTransaction(materials(2), config);
		const before = transactionRows(f);
		// Act
		const active = await f.store.maintainAuthBrowserTransactions({
			coordinatorId: config.coordinatorId,
		});
		f.now += TTL;
		const other = await f.store.maintainAuthBrowserTransactions({ coordinatorId: "other" });
		// Assert
		expect(active).toEqual({ kind: "maintained", processedCount: 0, more: false });
		expect(other).toEqual(active);
		expect(transactionRows(f)).toEqual(before);
		expect(f.db.prepare(`SELECT count(*) AS count FROM ${TABLE}`).get()).toEqual({ count: 2 });
	});
}

function registerValidationTests(test: Test) {
	test("throwing clock cannot start a transaction or expose the clock error", async ({
		fixture: f,
	}) => {
		// Arrange
		const store = browserCapability(f, {
			clock: () => {
				throw new Error("private-clock-error");
			},
		});
		// Act
		const operation = store.startAuthBrowserTransaction(materials(), config);
		// Assert
		await expect(operation).rejects.toThrow("auth_link_invalid_clock");
		expect(transactionRows(f)).toEqual([]);
	});
	test("RFC-unreserved material at maximum length survives a successful consume", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = {
			...materials(),
			nonce: `${"n".repeat(124)}._~-`,
			pkceVerifier: `${"p".repeat(124)}._~-`,
		};
		// Act
		const started = await f.store.startAuthBrowserTransaction(input, config);
		const consumed = await f.store.consumeAuthBrowserTransaction(input, config);
		// Assert
		expect(started.kind).toBe("started");
		expect(consumed).toMatchObject({
			kind: "consumed",
			nonce: input.nonce,
			pkceVerifier: input.pkceVerifier,
		});
	});
	test.for([
		"http://coordinator.example.test/auth/callback",
		"https://coordinator.example.test/auth/callback?secret=x",
		"https://coordinator.example.test/auth/callback#fragment",
		"https://coordinator.example.test:443/auth/callback",
	])("noncanonical redirect %s rejects without writes", async (redirectUri, { fixture: f }) => {
		// Arrange
		const invalid = { ...config, redirectUri };
		// Act
		const result = await f.store.startAuthBrowserTransaction(materials(), invalid);
		// Assert
		expectRejected(result, "invalid_input");
		expect(transactionRows(f)).toEqual([]);
	});
	test.for(["start", "consume", "resolve", "maintain"] as const)(
		"invalid clock blocks %s without mutations",
		async (stage, { fixture: f }) => {
			// Arrange
			const input = materials();
			await f.store.startAuthBrowserTransaction(input, config);
			const store = browserCapability(f, { clock: () => Number.NaN });
			const before = transactionRows(f);
			// Act
			let operation: Promise<unknown>;
			if (stage === "start") operation = store.startAuthBrowserTransaction(materials(2), config);
			else if (stage === "consume") operation = store.consumeAuthBrowserTransaction(input, config);
			else if (stage === "resolve")
				operation = store.resolveAuthLinkBrowserTransaction(
					{ attemptId: "attempt-a", binderHash: input.binderHash },
					config,
				);
			else
				operation = store.maintainAuthBrowserTransactions({ coordinatorId: config.coordinatorId });
			// Assert
			await expect(operation).rejects.toThrow("auth_link_invalid_clock");
			expect(transactionRows(f)).toEqual(before);
		},
	);
	test.for(["array", "prototype", "getter"])(
		"maintenance rejects %s options without invoking accessors",
		async (shape, { fixture: f }) => {
			// Arrange
			seed(f, 1);
			f.now += TTL;
			const before = transactionRows(f);
			let reads = 0;
			let options: unknown = [];
			if (shape === "prototype") options = Object.create({ limit: 1 });
			if (shape === "getter")
				options = Object.defineProperty({}, "limit", {
					get() {
						reads++;
						return 1;
					},
				});
			// Act
			const result = await f.store.maintainAuthBrowserTransactions(
				{ coordinatorId: config.coordinatorId },
				options as { limit?: number },
			);
			// Assert
			expectRejected(result, "invalid_input");
			expect(reads).toBe(0);
			expect(transactionRows(f)).toEqual(before);
		},
	);
	test.for(["stateHash", "binderHash"] as const)(
		"malformed callback %s rejects before touching rows",
		async (key, { fixture: f }) => {
			// Arrange
			const input = materials();
			await f.store.startAuthBrowserTransaction(input, config);
			const before = transactionRows(f);
			// Act
			const result = await f.store.consumeAuthBrowserTransaction(
				{ ...input, [key]: "BAD" },
				config,
			);
			// Assert
			expectRejected(result, "invalid_input");
			expect(transactionRows(f)).toEqual(before);
		},
	);
}

function registerCorruptionTests(test: Test) {
	test.for(["unknown-purpose", "orphan-signin"] as const)(
		"corrupted %s row never exposes or clears callback material",
		async (corruption, { fixture: f }) => {
			// Arrange: bypass constraints only on this test's isolated in-memory database.
			await authorize(f);
			await f.store.createAuthLinkAttempt(attempt(), f.cfg);
			const input = { ...materials(), purpose: "link" as const, attemptId: "attempt-a" };
			await f.store.startAuthBrowserTransaction(input, config);
			f.db.exec("PRAGMA ignore_check_constraints = ON");
			try {
				const purpose = corruption === "unknown-purpose" ? "unknown" : "signin";
				f.db.prepare(`UPDATE ${TABLE} SET purpose = ?`).run(purpose);
				const before = transactionRows(f);
				const protectedBefore = snapshot(f);
				// Act
				const result = await f.store.consumeAuthBrowserTransaction(input, config);
				// Assert
				expectRejected(result, "transaction_unavailable");
				expect(transactionRows(f)).toEqual(before);
				expect(snapshot(f)).toEqual(protectedBefore);
			} finally {
				f.db.exec("PRAGMA ignore_check_constraints = OFF");
			}
		},
	);
}

for (const backend of ["SQLite", "D1"] as const satisfies readonly Backend[]) {
	describe(`${backend} browser transactions`, () => {
		const test = backendTest(backend);
		registerStartTests(test);
		registerConsumeTests(test);
		registerLinkTests(test);
		registerLinkAtomicityTests(test);
		registerAdmissionTests(test);
		registerMaintenanceTests(test);
		registerValidationTests(test);
		registerCorruptionTests(test);
	});
}
