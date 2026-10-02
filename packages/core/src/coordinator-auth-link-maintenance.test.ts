import { describe, expect, it, vi } from "vitest";
import { type AuthLinkBackend, AuthLinkOperations } from "./coordinator-auth-link.js";
import {
	AUTH_LINK_CREATE_WINDOW_MS,
	AUTH_LINK_EXPIRE_BATCH_MAX,
	AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
	AUTH_LINK_MAX_ACTIVE_PER_IDENTITY,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
	AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
	AUTH_LINK_RETENTION_WINDOW_MS,
	type CoordinatorAuthLinkConfig,
	type CoordinatorAuthLinkMaintenanceOptions,
} from "./coordinator-auth-link-contract.js";
import {
	actor,
	allData,
	digest,
	expireAt,
	numberedAttempt,
	seedCopies,
} from "./coordinator-auth-link-maintenance-fixtures.js";
import {
	advance,
	attempt,
	authorize,
	backendTest,
	cfg,
	device,
	expectRejected,
	finalize,
	NOW,
	rows,
	signer,
	snapshot,
	TABLES,
	type Test,
	TTL,
	transition,
} from "./coordinator-auth-link-test-fixtures.js";
import {
	credentialHash,
	freshBrowserHash,
	grants,
	linked,
	redeemInput,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

function registerCapacity(test: Test) {
	test("eight parallel creates admit two per device and exact retries keep their TTL", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		const inputs = Array.from({ length: 8 }, (_, n) => numberedAttempt(n + 1));
		// Act
		const results = await Promise.all(
			inputs.map((input) => f.store.createAuthLinkAttempt(input, f.cfg)),
		);
		f.now++;
		const retry = await f.store.createAuthLinkAttempt(inputs[0], f.cfg);
		const altered = await f.store.createAuthLinkAttempt(
			{ ...inputs[0], runtimeVerifierHash: digest(99) },
			f.cfg,
		);
		// Assert
		expect(results.filter((result) => result.kind === "created")).toHaveLength(2);
		expect(results.filter((result) => result.kind === "rejected")).toEqual(
			Array(6).fill({ kind: "rejected", error: "attempt_limited" }),
		);
		expect(retry).toEqual({ ...results[0], kind: "existing" });
		expectRejected(altered, "attempt_conflict");
		expect(rows(f, TABLES[0])).toHaveLength(2);
	});
	test("identity cap spans devices but another coordinator is independent", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		const second = await actor(f, "second");
		const other = await actor(f, "other", "identity-a", "coordinator-b");
		// Act
		const results = await Promise.all(
			[signer, signer, second, second].map((s, n) =>
				f.store.createAuthLinkAttempt(numberedAttempt(n + 1, s), f.cfg),
			),
		);
		const independent = await f.store.createAuthLinkAttempt(numberedAttempt(5, other), {
			...f.cfg,
			coordinatorId: "coordinator-b",
		});
		// Assert
		expect(results.filter((result) => result.kind === "created")).toHaveLength(3);
		expect(results.filter((result) => result.kind === "rejected")).toEqual([
			{ kind: "rejected", error: "attempt_limited" },
		]);
		expect(independent.kind).toBe("created");
	});
	test("authority failure takes precedence over exhausted device capacity", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		await f.store.createAuthLinkAttempt(numberedAttempt(2), f.cfg);
		const before = snapshot(f);
		// Act
		const limited = await f.store.createAuthLinkAttempt(numberedAttempt(3), f.cfg);
		const inactive = await f.store.createAuthLinkAttempt(
			numberedAttempt(4, { ...signer, publicKey: "unreviewed-key" }),
			f.cfg,
		);
		// Assert
		expectRejected(limited, "attempt_limited");
		expectRejected(inactive, "controller_not_active");
		expect(snapshot(f)).toEqual(before);
	});
	test("cancellation does not reset six creates per hour; exact cutoff frees history", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		for (let n = 1; n <= 6; n++) {
			const input = numberedAttempt(n);
			expect((await f.store.createAuthLinkAttempt(input, f.cfg)).kind).toBe("created");
			await f.store.failAuthLinkAttempt(
				{ attemptId: input.attemptId, requester: device, reason: "cancelled" },
				f.cfg,
			);
		}
		// Act
		const limited = await f.store.createAuthLinkAttempt(numberedAttempt(7), f.cfg);
		f.now = NOW + AUTH_LINK_CREATE_WINDOW_MS;
		const boundary = await f.store.createAuthLinkAttempt(numberedAttempt(8), f.cfg);
		// Assert
		expectRejected(limited, "attempt_limited");
		expect(boundary.kind).toBe("created");
		expect(rows(f, TABLES[0])).toHaveLength(7);
	});
	test("sixty retained creates limit admission until the strict thirty-day cutoff", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "pending");
		f.db.prepare("UPDATE coordinator_auth_link_attempts SET state = 'expired'").run();
		expireAt(f, NOW - AUTH_LINK_RETENTION_WINDOW_MS + 1);
		seedCopies(f, 59);
		const before = rows(f, TABLES[0]);
		// Act
		const limited = await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		f.now++;
		const boundary = await f.store.createAuthLinkAttempt(numberedAttempt(2), f.cfg);
		// Assert
		expectRejected(limited, "attempt_limited");
		expect(boundary.kind).toBe("created");
		expect(rows(f, TABLES[0]).slice(0, 60)).toEqual(before);
	});
}

function registerCeiling(test: Test) {
	test("ten thousand unfinished rows block creates, not an existing pending completion", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		seedCopies(f, 9_999, {
			state: "expired",
			account_subject: null,
			device_id: "history-device",
			identity_id: "history-identity",
		});
		const before = rows(f, TABLES[0]);
		// Act
		const limited = await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		const completed = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		const admitted = await f.store.createAuthLinkAttempt(numberedAttempt(2), f.cfg);
		// Assert
		expectRejected(limited, "attempt_limited");
		expect(completed.kind).toBe("applied");
		expect(admitted.kind).toBe("created");
		expect(rows(f, TABLES[0]).slice(1, 10_000)).toEqual(before.slice(1));
	});
	test("linked sign-in and session reads remain available at the unfinished ceiling", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		seedCopies(f, 10_000, {
			state: "expired",
			account_subject: null,
			link_id: null,
			finalized_at_ms: null,
			device_id: "history-device",
			identity_id: "history-identity",
		});
		const before = grants(f);
		// Act
		const limited = await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		const issued = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		const read = await f.store.readAuthSession(credentialHash, f.cfg);
		// Assert
		expectRejected(limited, "attempt_limited");
		expect(issued.kind).toBe("issued");
		expect(read).not.toBeNull();
		expect(grants(f)).toEqual(before);
	});
}

function registerMaintenance(test: Test) {
	test("bounded expiry drains forty rows in 32 then 8 while preserving commitments", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		seedCopies(f, 39);
		const before = rows(f, TABLES[0]);
		const immutable = grants(f);
		f.now += TTL;
		// Act
		const first = await f.store.maintainAuthLinkAttempts(f.cfg);
		const second = await f.store.maintainAuthLinkAttempts(f.cfg);
		const done = await f.store.maintainAuthLinkAttempts(f.cfg);
		// Assert
		expect(first).toEqual({ kind: "maintained", processedCount: 32, more: true });
		expect(second).toEqual({ kind: "maintained", processedCount: 8, more: false });
		expect(done).toEqual({ kind: "maintained", processedCount: 0, more: false });
		expect(rows(f, TABLES[0])).toEqual(
			before.map((row) => ({ ...row, state: "expired", account_subject: null })),
		);
		expect(grants(f)).toEqual(immutable);
	});
	test("a full last batch reports conservative more even when no work remains", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "pending");
		f.now += TTL;
		// Act
		const result = await f.store.maintainAuthLinkAttempts(f.cfg, { limit: 1 });
		const next = await f.store.maintainAuthLinkAttempts(f.cfg, { limit: 1 });
		// Assert
		expect(result).toEqual({ kind: "maintained", processedCount: 1, more: true });
		expect(next).toEqual({ kind: "maintained", processedCount: 0, more: false });
	});
	test.for(["pending", "browser_claimed", "oidc_verified", "confirmed"])(
		"expires $0 at the exact deadline but not one millisecond before",
		async (state, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, state);
			const before = snapshot(f);
			f.now += TTL - 1;
			// Act
			const early = await f.store.maintainAuthLinkAttempts(f.cfg);
			const earlyRows = snapshot(f);
			f.now++;
			const exact = await f.store.maintainAuthLinkAttempts(f.cfg);
			// Assert
			expect(early).toEqual({ kind: "maintained", processedCount: 0, more: false });
			expect(earlyRows).toEqual(before);
			expect(exact).toEqual({ kind: "maintained", processedCount: 1, more: false });
			expect(rows(f, TABLES[0])[0]).toEqual({
				...before[0][0],
				state: "expired",
				account_subject: null,
			});
		},
	);
	test("scrubs failed subjects immediately without changing the failure reason", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		await transition(f, "fail");
		const before = rows(f, TABLES[0])[0];
		// Act
		const result = await f.store.maintainAuthLinkAttempts(f.cfg);
		const repeated = await f.store.maintainAuthLinkAttempts(f.cfg);
		// Assert
		expect(result).toEqual({ kind: "maintained", processedCount: 1, more: false });
		expect(rows(f, TABLES[0])).toEqual([{ ...before, account_subject: null }]);
		expect(repeated).toEqual({ kind: "maintained", processedCount: 0, more: false });
	});
	test("maintenance includes old configuration rows but excludes foreign coordinators and finalized sessions", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		seedCopies(f, 1, {
			state: "confirmed",
			link_id: null,
			finalized_at_ms: null,
			auth_config_revision: "9".repeat(64),
		});
		seedCopies(
			f,
			1,
			{ state: "confirmed", link_id: null, finalized_at_ms: null, coordinator_id: "coordinator-b" },
			101,
		);
		const before = rows(f, TABLES[0]);
		const immutable = [grants(f), sessionRows(f)];
		f.now += TTL;
		// Act
		const result = await f.store.maintainAuthLinkAttempts({
			...f.cfg,
			revision: "8".repeat(64),
			issuer: "https://new.example.test",
		});
		// Assert
		expect(result).toEqual({ kind: "maintained", processedCount: 1, more: false });
		expect(rows(f, TABLES[0])).toEqual(
			before.map((row) =>
				row.attempt_id === "seed-100" ? { ...row, state: "expired", account_subject: null } : row,
			),
		);
		expect([grants(f), sessionRows(f)]).toEqual(immutable);
	});
	test("an aborted maintenance UPDATE leaves every table unchanged", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		f.now += TTL;
		f.db.exec(
			"CREATE TRIGGER abort_maintenance BEFORE UPDATE ON coordinator_auth_link_attempts BEGIN SELECT RAISE(ABORT, 'fixture-failure'); END",
		);
		const before = allData(f);
		// Act
		const result = f.store.maintainAuthLinkAttempts(f.cfg);
		// Assert
		await expect(result).rejects.toThrow("auth_link_persistence_error");
		expect(allData(f)).toEqual(before);
	});
}

function registerBoundaries(test: Test) {
	test("exact expiry frees active capacity without an automatic maintenance write", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		await f.store.createAuthLinkAttempt(numberedAttempt(2), f.cfg);
		f.now += TTL - 1;
		const before = rows(f, TABLES[0]);
		// Act
		const early = await f.store.createAuthLinkAttempt(numberedAttempt(3), f.cfg);
		f.now++;
		const exact = await f.store.createAuthLinkAttempt(numberedAttempt(4), f.cfg);
		// Assert
		expectRejected(early, "attempt_limited");
		expect(exact.kind).toBe("created");
		expect(rows(f, TABLES[0]).slice(0, 2)).toEqual(before);
	});
	test("key rotation cannot reset group/device capacity", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		await f.store.createAuthLinkAttempt(numberedAttempt(2), f.cfg);
		const rotated = { ...signer, publicKey: "fixture-rotated-key", fingerprint: "7".repeat(64) };
		f.db
			.prepare("UPDATE enrolled_devices SET public_key = ?, fingerprint = ?")
			.run(rotated.publicKey, rotated.fingerprint);
		f.db
			.prepare(
				"UPDATE coordinator_auth_controller_attestations SET public_key = ?, fingerprint = ?",
			)
			.run(rotated.publicKey, rotated.fingerprint);
		const before = allData(f);
		// Act
		const limited = await f.store.createAuthLinkAttempt(numberedAttempt(3, rotated), f.cfg);
		const oldCommitment = await f.store.createAuthLinkAttempt(numberedAttempt(1, rotated), f.cfg);
		// Assert
		expectRejected(limited, "attempt_limited");
		expectRejected(oldCommitment, "attempt_conflict");
		expect(allData(f)).toEqual(before);
	});
	test("maintenance processes deadline then attempt ID with a stable capped order", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "pending");
		seedCopies(f, 2);
		f.db
			.prepare(
				"UPDATE coordinator_auth_link_attempts SET created_at_ms = ?, expires_at_ms = ? WHERE attempt_id = ?",
			)
			.run(NOW - 1, NOW + TTL - 1, "seed-101");
		f.now += TTL;
		// Act
		const first = await f.store.maintainAuthLinkAttempts(f.cfg, { limit: 2 });
		const states = rows(f, TABLES[0]).map((row) => [row.attempt_id, row.state]);
		const next = await f.store.maintainAuthLinkAttempts(f.cfg, { limit: 2 });
		// Assert
		expect(first).toEqual({ kind: "maintained", processedCount: 2, more: true });
		expect(states).toEqual([
			["attempt-a", "expired"],
			["seed-100", "pending"],
			["seed-101", "expired"],
		]);
		expect(next).toEqual({ kind: "maintained", processedCount: 1, more: false });
	});
	test.for(["finalized", "session_redeemed"])(
		"maintenance never touches %s, sessions or consumed receipts",
		async (state, { fixture: f }) => {
			// Arrange
			await linked(f);
			if (state === "session_redeemed")
				expect((await f.store.redeemAuthLinkSession(redeemInput(), f.cfg)).kind).toBe("issued");
			f.now += TTL;
			const before = allData(f);
			// Act
			const result = await f.store.maintainAuthLinkAttempts(f.cfg);
			// Assert
			expect(result).toEqual({ kind: "maintained", processedCount: 0, more: false });
			expect(allData(f)).toEqual(before);
		},
	);
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
		{ limit: Number.NaN },
		{ limit: Infinity },
	])("rejects invalid maintenance options %# without writes", async (options, { fixture: f }) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		f.now += TTL;
		const before = allData(f);
		// Act
		const result = await f.store.maintainAuthLinkAttempts(
			f.cfg,
			options as CoordinatorAuthLinkMaintenanceOptions,
		);
		// Assert
		expectRejected(result, "invalid_input");
		expect(allData(f)).toEqual(before);
	});
	test.for(["getter", "inherited", "proxy", "coercion"])(
		"never executes %s option code",
		async (variant, { fixture: f }) => {
			// Arrange
			const executed = vi.fn(() => {
				throw new Error("untrusted-marker");
			});
			let options: unknown = { limit: 1 };
			if (variant === "getter") Object.defineProperty(options, "limit", { get: executed });
			if (variant === "inherited") options = Object.create({ limit: 1 });
			if (variant === "proxy")
				options = new Proxy(
					{},
					{
						getOwnPropertyDescriptor() {
							throw new Error("proxy-marker");
						},
					},
				);
			if (variant === "coercion") options = { limit: { valueOf: executed, toString: executed } };
			const before = allData(f);
			// Act
			const result = await f.store.maintainAuthLinkAttempts(
				f.cfg,
				options as CoordinatorAuthLinkMaintenanceOptions,
			);
			// Assert
			expectRejected(result, "invalid_input");
			expect(executed).not.toHaveBeenCalled();
			expect(allData(f)).toEqual(before);
		},
	);
	test.for([
		null,
		{ ...attempt() },
		{ enabled: true },
		{ coordinatorId: "", issuer: "x", revision: "x", enabled: true },
	])("rejects malformed configuration %#", async (config, { fixture: f }) => {
		// Arrange
		const before = allData(f);
		// Act
		const result = await f.store.maintainAuthLinkAttempts(config as CoordinatorAuthLinkConfig);
		// Assert
		expectRejected(result, "invalid_input");
		expect(allData(f)).toEqual(before);
	});
	test("disabled configuration performs no expiry writes", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		f.now += TTL;
		const before = allData(f);
		// Act
		const disabled = await f.store.maintainAuthLinkAttempts({ ...f.cfg, enabled: false });
		const disabledData = allData(f);
		const enabled = await f.store.maintainAuthLinkAttempts(f.cfg, {});
		// Assert
		expectRejected(disabled, "auth_config_changed");
		expect(disabledData).toEqual(before);
		expect(enabled).toEqual({ kind: "maintained", processedCount: 1, more: false });
		expect(rows(f, TABLES[0])).toEqual(
			(before[0] as Record<string, unknown>[]).map((row) => ({
				...row,
				state: "expired",
				account_subject: null,
			})),
		);
	});
	test.for([Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])(
		"invalid trusted clock %# throws without writes",
		async (now, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			f.now = now;
			const before = allData(f);
			// Act
			const result = f.store.maintainAuthLinkAttempts(f.cfg);
			// Assert
			await expect(result).rejects.toThrow("auth_link_invalid_clock");
			expect(allData(f)).toEqual(before);
		},
	);
}

function registerBurns(test: Test) {
	test.for(["claim", "confirm", "finalize", "fail"] as const)(
		"persisted expiry cannot %s after clock rollback",
		async (stage, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			f.now += TTL;
			await f.store.maintainAuthLinkAttempts(f.cfg);
			f.now = NOW;
			const before = allData(f);
			// Act
			const result = await transition(f, stage);
			const retry = await f.store.createAuthLinkAttempt(attempt(), f.cfg);
			const status = await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg);
			// Assert
			expectRejected(result, "attempt_expired");
			expectRejected(retry, "attempt_conflict");
			expect(status).toEqual({ attemptId: "attempt-a", state: "expired", expiresAtMs: NOW + TTL });
			expect(allData(f)).toEqual(before);
		},
	);
	test("unobserved expiry remains subject to the trusted clock limitation", async ({
		fixture: f,
	}) => {
		// Arrange: no operation observes the elapsed deadline.
		await authorize(f);
		await advance(f, "pending");
		f.now += TTL;
		f.now = NOW;
		// Act
		const result = await transition(f, "claim");
		// Assert
		expect(result.kind).toBe("applied");
		expect(rows(f, TABLES[0])[0].state).toBe("browser_claimed");
	});
	test("expired commitments remain burned against a new attempt ID", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		f.now += TTL;
		await f.store.maintainAuthLinkAttempts(f.cfg);
		const before = allData(f);
		// Act
		const replay = await f.store.createAuthLinkAttempt(
			attempt({ attemptId: "new-attempt" }),
			f.cfg,
		);
		// Assert
		expectRejected(replay, "attempt_conflict");
		expect(allData(f)).toEqual(before);
	});
	test("normal sign-in receipt prevents a later link claim with the same browser proof", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		expect((await f.store.signInWithAuthAccount(signInInput(f), f.cfg)).kind).toBe("issued");
		await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		const before = allData(f);
		// Act
		const replay = await f.store.claimAuthLinkAttempt(
			{ attemptId: "maintenance-1", browserTransactionHash: freshBrowserHash },
			f.cfg,
		);
		const replayData = allData(f);
		const fresh = await f.store.claimAuthLinkAttempt(
			{ attemptId: "maintenance-1", browserTransactionHash: digest(500) },
			f.cfg,
		);
		// Assert
		expectRejected(replay, "attempt_unavailable");
		expect(replayData).toEqual(before);
		expect(fresh.kind).toBe("applied");
		expect(sessionRows(f)).toEqual(before.slice(-2));
	});
	test("claimed expired link proof cannot sign in even after subject scrubbing", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		await f.store.claimAuthLinkAttempt(
			{ attemptId: "maintenance-1", browserTransactionHash: freshBrowserHash },
			f.cfg,
		);
		f.now += TTL;
		await f.store.maintainAuthLinkAttempts(f.cfg);
		const before = allData(f);
		// Act
		const replay = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		// Assert
		expectRejected(replay, "browser_transaction_used");
		expect(allData(f)).toEqual(before);
	});
	test("racing claim and normal sign-in admits only one browser proof consumer", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.createAuthLinkAttempt(numberedAttempt(1), f.cfg);
		// Act
		const results = await Promise.all([
			f.store.claimAuthLinkAttempt(
				{ attemptId: "maintenance-1", browserTransactionHash: freshBrowserHash },
				f.cfg,
			),
			f.store.signInWithAuthAccount(signInInput(f), f.cfg),
		]);
		// Assert
		expect(
			results.filter((result) => result.kind === "applied" || result.kind === "issued"),
		).toHaveLength(1);
		expect(results.filter((result) => result.kind === "rejected")).toHaveLength(1);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerCapacity(test);
	registerCeiling(test);
	registerMaintenance(test);
	registerBoundaries(test);
	registerValidation(test);
	registerBurns(test);
	test("exports fixed work and admission limits", ({ fixture: _f }) => {
		// Arrange
		const constants = [
			AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
			AUTH_LINK_MAX_ACTIVE_PER_IDENTITY,
			AUTH_LINK_CREATE_WINDOW_MS,
			AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
			AUTH_LINK_RETENTION_WINDOW_MS,
			AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION,
			AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
			AUTH_LINK_EXPIRE_BATCH_MAX,
		];
		// Act
		const values = [...constants];
		// Assert
		expect(values).toEqual([2, 3, 3_600_000, 6, 2_592_000_000, 60, 10_000, 32]);
	});
}

describe.each(["SQLite", "D1"] as const)(
	"%s auth-link admission and explicit maintenance parity (D1 is SQLite-backed)",
	registerBackend,
);

it("maintenance reports the native update count without reading authority metadata", async () => {
	// Arrange: the backend result is reporting data, not a controller grant.
	const run = vi.fn<AuthLinkBackend["run"]>().mockResolvedValue(7);
	const first = vi.fn<AuthLinkBackend["first"]>();
	const batch = vi.fn<AuthLinkBackend["batch"]>();
	const operations = new AuthLinkOperations({ run, first, batch }, () => NOW);
	// Act
	const result = await operations.maintainAuthLinkAttempts(cfg);
	// Assert
	expect(result).toEqual({ kind: "maintained", processedCount: 7, more: false });
	expect(run).toHaveBeenCalledTimes(1);
	expect(run.mock.calls[0][0]).toMatchObject({
		sql: expect.stringMatching(/^UPDATE coordinator_auth_link_attempts/u),
	});
	expect(first).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});

it("constructing the maintenance capability does not read a clock or mutate persistence", () => {
	// Arrange
	const run = vi.fn<AuthLinkBackend["run"]>();
	const first = vi.fn<AuthLinkBackend["first"]>();
	const batch = vi.fn<AuthLinkBackend["batch"]>();
	const clock = vi.fn(() => NOW + TTL);
	// Act
	const operations = new AuthLinkOperations({ run, first, batch }, clock);
	// Assert
	expect(operations).toBeInstanceOf(AuthLinkOperations);
	expect(clock).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
	expect(first).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});

it("a throwing trusted clock rejects maintenance before any persistence call", async () => {
	// Arrange
	const run = vi.fn<AuthLinkBackend["run"]>();
	const first = vi.fn<AuthLinkBackend["first"]>();
	const batch = vi.fn<AuthLinkBackend["batch"]>();
	const operations = new AuthLinkOperations({ run, first, batch }, () => {
		throw new Error("clock-marker");
	});
	// Act
	const result = operations.maintainAuthLinkAttempts(cfg);
	// Assert
	await expect(result).rejects.toThrow("auth_link_invalid_clock");
	expect(run).not.toHaveBeenCalled();
	expect(first).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});
