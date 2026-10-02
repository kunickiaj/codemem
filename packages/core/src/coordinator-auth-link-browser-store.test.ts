import { describe, expect, vi } from "vitest";
import type { CoordinatorAuthLinkRequester as Requester } from "./coordinator-auth-link-contract.js";
import {
	advance,
	attempt,
	authorize,
	backendTest,
	browser,
	browserHash,
	cfg,
	completionHash,
	device,
	expectRejected,
	finalize,
	NOW,
	previousState,
	rows,
	signer,
	snapshot,
	stages,
	status,
	TABLES,
	type Test,
	TTL,
	transition,
} from "./coordinator-auth-link-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

function registerBrowserTests(test: Test) {
	test("freezes the server-verified issuer and opaque subject without creating a link", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "browser_claimed");
		const input = {
			attemptId: "attempt-a",
			browserTransactionHash: browserHash,
			account: { issuer: cfg.issuer, subject: "opaque-subject-a" },
		};
		// Act
		const verified = await f.store.recordAuthLinkOidcVerified(input, f.cfg);
		const replay = await f.store.recordAuthLinkOidcVerified(
			{ ...input, account: { ...input.account, subject: "other-subject" } },
			f.cfg,
		);
		// Assert
		expect(verified).toEqual({
			kind: "applied",
			status: status("oidc_verified"),
			target: { identityId: "identity-a", groupId: signer.groupId, deviceId: signer.deviceId },
		});
		expectRejected(replay, "attempt_unavailable");
		expect(rows(f, TABLES[0])[0].account_subject).toBe(input.account.subject);
		expect(rows(f, TABLES[1])).toEqual([]);
	});
	test("confirmation writes one commitment and replay cannot overwrite it", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "oidc_verified");
		const input = {
			attemptId: "attempt-a",
			browserTransactionHash: browserHash,
			completionSecretHash: completionHash,
		};
		// Act
		const confirmed = await f.store.confirmAuthLinkAttempt(input, f.cfg);
		const replay = await f.store.confirmAuthLinkAttempt(
			{ ...input, completionSecretHash: "e".repeat(64) },
			f.cfg,
		);
		// Assert
		expect(confirmed).toEqual({ kind: "applied", status: status("confirmed") });
		expectRejected(replay, "attempt_unavailable");
		expect(rows(f, TABLES[0])[0].completion_secret_hash).toBe(completionHash);
	});
	test.for(["browser_claimed", "oidc_verified"])(
		"wrong browser proof cannot advance %s",
		async (state, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, state);
			const before = snapshot(f);
			const input = { attemptId: "attempt-a", browserTransactionHash: "e".repeat(64) };
			// Act
			let result: unknown;
			if (state === "browser_claimed")
				result = await f.store.recordAuthLinkOidcVerified(
					{ ...input, account: { issuer: cfg.issuer, subject: "subject" } },
					f.cfg,
				);
			else
				result = await f.store.confirmAuthLinkAttempt(
					{ ...input, completionSecretHash: completionHash },
					f.cfg,
				);
			// Assert
			expectRejected(result, "attempt_unavailable");
			expect(snapshot(f)).toEqual(before);
		},
	);
}

function registerBoundaryTests(test: Test) {
	test.for(stages.flatMap((stage) => [-1, 0, 1].map((offset) => ({ stage, offset }))))(
		"$stage at deadline offset $offset",
		async ({ stage, offset }, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, previousState[stage]);
			const before = snapshot(f);
			f.now = NOW + TTL + offset;
			// Act
			const result = await transition(f, stage);
			// Assert: deadline equality is expired, with no renewal or consume.
			if (offset < 0) expect(result.kind).toBe("applied");
			else {
				expectRejected(result, "attempt_expired");
				expect(snapshot(f)).toEqual(before);
				expect(await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg)).toEqual(
					status("expired"),
				);
			}
		},
	);
	test.for(
		stages.flatMap((stage) => [
			{ stage, change: { revision: "e".repeat(64) } },
			{ stage, change: { issuer: "https://other.example.test" } },
			{ stage, change: { enabled: false } },
		]),
	)("$stage rejects changed auth config %#", async ({ stage, change }, { fixture: f }) => {
		// Arrange
		await authorize(f);
		await advance(f, previousState[stage]);
		const before = snapshot(f);
		const changed = { ...f.cfg, ...change };
		// Act
		const result = await transition(f, stage, changed);
		const publicStatus = await f.store.getAuthLinkAttemptStatus("attempt-a", device, changed);
		// Assert
		expectRejected(result, "auth_config_changed");
		expect(publicStatus).toBeNull();
		expect(snapshot(f)).toEqual(before);
	});
}

function registerStatusTests(test: Test) {
	test.for(["pending", "browser_claimed", "oidc_verified", "confirmed", "finalized"])(
		"public %s status authorizes only the pinned requester",
		async (state, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, state);
			const wrong: Requester[] = [
				{ kind: "browser", browserTransactionHash: "e".repeat(64) },
				...["groupId", "deviceId", "publicKey", "fingerprint"].map((field) => ({
					kind: "device" as const,
					signer: { ...signer, [field]: field === "fingerprint" ? "e".repeat(64) : "wrong" },
				})),
			];
			// Act
			const allowed = await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg);
			const browserStatus = await f.store.getAuthLinkAttemptStatus("attempt-a", browser, f.cfg);
			const denied = await Promise.all(
				wrong.map((requester) => f.store.getAuthLinkAttemptStatus("attempt-a", requester, f.cfg)),
			);
			// Assert: exact equality prohibits private fields in public status.
			expect(allowed).toEqual(status(state));
			expect(browserStatus).toEqual(state === "pending" ? null : status(state));
			expect(denied).toEqual(wrong.map(() => null));
		},
	);
}

const cancellations = [
	{ requester: device, reason: "cancelled", stored: "device_cancelled" },
	{ requester: browser, reason: "cancelled", stored: "browser_cancelled" },
	{ requester: browser, reason: "provider_failure", stored: "provider_failure" },
	{ requester: browser, reason: "config_failure", stored: "config_failure" },
] as const;

function registerFailureTests(test: Test) {
	test.for(cancellations)(
		"authorized failure $stored is terminal and idempotent",
		async ({ requester, reason, stored }, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			const input = { attemptId: "attempt-a", requester, reason };
			// Act
			const first = await f.store.failAuthLinkAttempt(input, f.cfg);
			const retry = await f.store.failAuthLinkAttempt(input, f.cfg);
			const finalizeResult = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
			f.now += TTL + 1;
			// Assert
			expect(first).toEqual({ kind: "applied", status: status("failed") });
			expect(retry).toEqual({ kind: "existing", status: status("failed") });
			expectRejected(finalizeResult, "attempt_unavailable");
			expect(await f.store.getAuthLinkAttemptStatus("attempt-a", requester, f.cfg)).toEqual(
				status("failed"),
			);
			expect(rows(f, TABLES[0])[0]).toMatchObject({ failure_reason: stored, failed_at_ms: NOW });
			expect(rows(f, TABLES[1])).toEqual([]);
		},
	);
	test.for([
		{
			requester: { kind: "browser", browserTransactionHash: "e".repeat(64) },
			reason: "cancelled",
			error: "attempt_unavailable",
		},
		{ requester: device, reason: "provider_failure", error: "invalid_input" },
		{ requester: device, reason: "config_failure", error: "invalid_input" },
	] as const)(
		"invalid failure requester/reason %# cannot change state",
		async ({ requester, reason, error }, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			const before = snapshot(f);
			// Act
			const result = await f.store.failAuthLinkAttempt(
				{ attemptId: "attempt-a", requester, reason },
				f.cfg,
			);
			// Assert
			expectRejected(result, error);
			expect(snapshot(f)).toEqual(before);
		},
	);
}

function registerOidcValidationTests(test: Test) {
	test.for([
		{ issuer: "https://other.example.test", subject: "subject" },
		{ issuer: cfg.issuer, subject: "" },
		{ issuer: cfg.issuer, subject: "x".repeat(256) },
		{ issuer: cfg.issuer, subject: "bad\u0000subject" },
	])(
		"invalid verified-account input %# cannot freeze an account",
		async (account, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "browser_claimed");
			const before = snapshot(f);
			// Act
			const result = await f.store.recordAuthLinkOidcVerified(
				{ attemptId: "attempt-a", browserTransactionHash: browserHash, account },
				f.cfg,
			);
			// Assert
			expectRejected(result, "invalid_input");
			expect(snapshot(f)).toEqual(before);
		},
	);
	test("captures account ownership fields without invoking accessors", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		await advance(f, "browser_claimed");
		const getter = vi.fn(() => "opaque-subject-a");
		const account = { issuer: cfg.issuer, subject: "opaque-subject-a" };
		Object.defineProperty(account, "subject", { get: getter });
		const before = snapshot(f);
		// Act
		const result = await f.store.recordAuthLinkOidcVerified(
			{ attemptId: "attempt-a", browserTransactionHash: browserHash, account },
			f.cfg,
		);
		// Assert
		expectRejected(result, "invalid_input");
		expect(getter).not.toHaveBeenCalled();
		expect(snapshot(f)).toEqual(before);
	});
}

function registerClaimTests(test: Test) {
	test("one competing browser owns the attempt and exact claim retry retains it", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "pending");
		const hashes = [browserHash, "e".repeat(64)];
		// Act
		const results = await Promise.all(
			hashes.map((hash) =>
				f.store.claimAuthLinkAttempt(
					{ attemptId: "attempt-a", browserTransactionHash: hash },
					f.cfg,
				),
			),
		);
		const winner = results.findIndex((result) => result.kind === "applied");
		const retry = await f.store.claimAuthLinkAttempt(
			{ attemptId: "attempt-a", browserTransactionHash: hashes[winner] },
			f.cfg,
		);
		// Assert
		expect(results.filter((result) => result.kind === "applied")).toEqual([
			{ kind: "applied", status: status("browser_claimed") },
		]);
		expectRejected(results[1 - winner], "attempt_unavailable");
		expect(retry).toEqual({ kind: "existing", status: status("browser_claimed") });
		expect(rows(f, TABLES[0])[0].browser_transaction_hash).toBe(hashes[winner]);
	});
	test("browser commitment reused across attempts is a conflict, not new ownership", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "browser_claimed");
		await f.store.createAuthLinkAttempt(
			attempt({ attemptId: "attempt-b", runtimeVerifierHash: "1".repeat(64) }),
			f.cfg,
		);
		const before = snapshot(f);
		// Act
		const result = await f.store.claimAuthLinkAttempt(
			{ attemptId: "attempt-b", browserTransactionHash: browserHash },
			f.cfg,
		);
		// Assert
		expectRejected(result, "attempt_conflict");
		expect(snapshot(f)).toEqual(before);
	});
}

function registerTransitionTests(test: Test) {
	test.for([
		{ state: "pending", stage: "oidc" },
		{ state: "pending", stage: "confirm" },
		{ state: "pending", stage: "finalize" },
		{ state: "browser_claimed", stage: "confirm" },
		{ state: "browser_claimed", stage: "finalize" },
		{ state: "oidc_verified", stage: "claim" },
		{ state: "confirmed", stage: "oidc" },
		{ state: "finalized", stage: "claim" },
		{ state: "finalized", stage: "confirm" },
		{ state: "finalized", stage: "fail" },
	] as const)("cannot perform $stage from $state", async ({ state, stage }, { fixture: f }) => {
		// Arrange
		await authorize(f);
		await advance(f, state);
		const before = snapshot(f);
		// Act
		const result = await transition(f, stage);
		// Assert
		expectRejected(result, "attempt_unavailable");
		expect(snapshot(f)).toEqual(before);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerBrowserTests(test);
	registerBoundaryTests(test);
	registerStatusTests(test);
	registerFailureTests(test);
	registerOidcValidationTests(test);
	registerClaimTests(test);
	registerTransitionTests(test);
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-link browser parity (D1 is SQLite-backed)",
	registerBackend,
);
