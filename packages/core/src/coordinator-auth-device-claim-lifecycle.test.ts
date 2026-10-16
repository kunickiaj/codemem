import { expect } from "vitest";
import {
	input,
	seedEnrollmentSql,
	seedKeyRevocationSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import {
	browserCapability,
	browserConfig,
	materials,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	attempt,
	backendTest,
	browserHash,
	completionHash,
	type LinkFixture,
	rows,
	TABLES,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";

// Trusted metadata only: no Google JWT verification or ownership commit.
const request = () =>
	attempt({
		authority: { kind: "device_claim", identityId: input.identityId },
		signer: input.signer,
		browserStartHash: "e".repeat(64),
	});
const browser = { attemptId: "attempt-a", browserTransactionHash: browserHash };
const device = { kind: "device" as const, signer: input.signer };
const fakeGoogleSubject = { issuer: browserConfig.issuer, subject: "trusted-test-google-subject" };
const start = () => ({
	...materials(),
	purpose: "link" as const,
	attemptId: "attempt-a",
	browserStartHash: request().browserStartHash,
});

function authoritySnapshot(f: LinkFixture) {
	const tables = f.db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('coordinator_auth_link_attempts','coordinator_auth_browser_transactions') ORDER BY name",
		)
		.all() as { name: string }[];
	return tables.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
type Stage = "pending" | "browser_claimed" | "oidc_verified";
async function next(f: LinkFixture, state: Stage, config = f.cfg, proof = browser) {
	if (state === "pending")
		return f.store.startAuthBrowserTransaction(start(), { ...browserConfig, ...config });
	if (state === "browser_claimed")
		return f.store.recordAuthLinkOidcVerified({ ...proof, account: fakeGoogleSubject }, config);
	return f.store.confirmAuthLinkAttempt({ ...proof, completionSecretHash: completionHash }, config);
}
async function prepare(f: LinkFixture, state: Stage) {
	f.db.exec(seedEnrollmentSql);
	expect(await f.store.createAuthLinkAttempt(request(), f.cfg)).toMatchObject({ kind: "created" });
	if (state === "pending") return browser;
	expect(await f.store.startAuthBrowserTransaction(start(), browserConfig)).toMatchObject({
		kind: "started",
	});
	const bound = await f.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: "attempt-a", binderHash: start().binderHash },
		browserConfig,
	);
	if (!bound) throw new Error("device claim browser was not bound");
	const claimed = { attemptId: "attempt-a", ...bound };
	if (state === "browser_claimed") return claimed;
	expect(
		await f.store.recordAuthLinkOidcVerified({ ...claimed, account: fakeGoogleSubject }, f.cfg),
	).toMatchObject({ kind: "applied" });
	return claimed;
}

for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} device claim reaches confirmation through browser start without authority writes`, async ({
		fixture: f,
	}) => {
		// Arrange: unrelated Team membership is deliberately present in the shared seed.
		f.db.exec(seedEnrollmentSql);
		const before = authoritySnapshot(f);
		// Act / Assert: every successful stage preserves all non-transaction tables.
		expect(await f.store.createAuthLinkAttempt(request(), f.cfg)).toMatchObject({
			kind: "created",
			status: { state: "pending" },
		});
		expect(authoritySnapshot(f)).toEqual(before);
		expect(await f.store.startAuthBrowserTransaction(start(), browserConfig)).toEqual({
			kind: "started",
			expiresAtMs: f.now + TTL,
		});
		const bound = await f.store.resolveAuthLinkBrowserTransaction(
			{ attemptId: "attempt-a", binderHash: start().binderHash },
			browserConfig,
		);
		expect(bound).not.toBeNull();
		if (!bound) throw new Error("device claim browser was not bound");
		const claimed = {
			attemptId: "attempt-a",
			browserTransactionHash: bound.browserTransactionHash,
		};
		expect(await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg)).toMatchObject({
			state: "browser_claimed",
		});
		expect(authoritySnapshot(f)).toEqual(before);
		expect(
			await f.store.consumeAuthBrowserTransaction(
				{ stateHash: start().stateHash, binderHash: start().binderHash },
				browserConfig,
			),
		).toMatchObject({
			kind: "consumed",
			purpose: "link",
			...claimed,
		});
		expect(await next(f, "browser_claimed", f.cfg, claimed)).toMatchObject({
			kind: "applied",
			status: { state: "oidc_verified" },
			target: {
				identityId: input.identityId,
				groupId: input.signer.groupId,
				deviceId: input.signer.deviceId,
			},
		});
		expect(authoritySnapshot(f)).toEqual(before);
		expect(await f.store.readAuthLinkCompletionDestination(claimed, f.cfg)).toEqual({
			destination: request().loopbackRedirect,
		});
		expect(await next(f, "oidc_verified", f.cfg, claimed)).toMatchObject({
			kind: "applied",
			status: { state: "confirmed" },
		});
		expect(await f.store.readAuthLinkCompletionDestination(claimed, f.cfg)).toBeNull();
		expect(authoritySnapshot(f)).toEqual(before);
	});
	test.for([
		[
			"pending",
			"UPDATE enrolled_devices SET public_key=public_key || ' changed' WHERE device_id='device-a'",
		],
		[
			"browser_claimed",
			"UPDATE enrolled_devices SET identity_id='other' WHERE device_id='device-a'",
		],
		["oidc_verified", "UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'"],
		["oidc_verified", seedKeyRevocationSql],
		["pending", "UPDATE groups SET archived_at='archived'"],
	] as const)(
		`${backend} live eligibility change at %s denies the next transition`,
		async ([state, mutation], { fixture: f }) => {
			// Arrange
			const browser = await prepare(f, state);
			f.db.exec(mutation);
			const before = authoritySnapshot(f);
			// Act
			const result = await next(f, state, f.cfg, browser);
			// Assert
			expect(result).toMatchObject({ kind: "rejected" });
			expect(await f.store.readAuthLinkCompletionDestination(browser, f.cfg)).toBeNull();
			expect(await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg)).toBeNull();
			expect(authoritySnapshot(f)).toEqual(before);
			if (state === "pending") expect(transactionRows(f)).toEqual([]);
		},
	);
	test.for([
		"UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'",
		seedKeyRevocationSql,
	])(
		`${backend} lost eligibility blocks browser secret consumption and routing reads`,
		async (mutation, { fixture: f }) => {
			// Arrange
			await prepare(f, "browser_claimed");
			const transactions = transactionRows(f);
			expect(transactions).toEqual([
				expect.objectContaining({
					state: "pending",
					nonce: start().nonce,
					pkce_verifier: start().pkceVerifier,
				}),
			]);
			f.db.exec(mutation);
			const authority = authoritySnapshot(f);
			const proof = { stateHash: start().stateHash, binderHash: start().binderHash };
			// Act
			const consumed = await f.store.consumeAuthBrowserTransaction(proof, browserConfig);
			const purpose = await browserCapability(f).readAuthBrowserTransactionPurpose(
				proof,
				browserConfig,
			);
			const resolved = await f.store.resolveAuthLinkBrowserTransaction(
				{ attemptId: "attempt-a", binderHash: proof.binderHash },
				browserConfig,
			);
			// Assert
			expect(consumed).toMatchObject({ kind: "rejected" });
			expect(purpose).toBeNull();
			expect(resolved).toBeNull();
			expect(transactionRows(f)).toEqual(transactions);
			expect(authoritySnapshot(f)).toEqual(authority);
		},
	);
	test.for([
		{ enabled: false },
		{ revision: "f".repeat(64) },
		{ issuer: "https://changed.example.test" },
	])(
		`${backend} changed trusted config denies confirmation and destination`,
		async (change, { fixture: f }) => {
			// Arrange
			const browser = await prepare(f, "oidc_verified");
			const before = authoritySnapshot(f);
			const changed = { ...f.cfg, ...change };
			// Act
			const result = await next(f, "oidc_verified", changed, browser);
			// Assert
			expect(result).toMatchObject({ kind: "rejected" });
			expect(await f.store.readAuthLinkCompletionDestination(browser, changed)).toBeNull();
			expect(authoritySnapshot(f)).toEqual(before);
		},
	);
	test.for(["runtime", "browser"] as const)(
		`${backend} rejects %s commitment used as browser-start proof`,
		async (proof, { fixture: f }) => {
			// Arrange
			await prepare(f, "pending");
			const before = rows(f, TABLES[0]);
			const authority = authoritySnapshot(f);
			// Act
			const result = await f.store.startAuthBrowserTransaction(
				{
					...start(),
					browserStartHash: proof === "runtime" ? request().runtimeVerifierHash : browserHash,
				},
				browserConfig,
			);
			// Assert
			expect(result).toMatchObject({ kind: "rejected" });
			expect(rows(f, TABLES[0])).toEqual(before);
			expect(transactionRows(f)).toEqual([]);
			expect(authoritySnapshot(f)).toEqual(authority);
		},
	);
	test.for(["browser_claimed", "oidc_verified"] as const)(
		`${backend} wrong browser cannot advance %s or cancel`,
		async (state, { fixture: f }) => {
			// Arrange
			const browser = await prepare(f, state);
			const wrong = { ...browser, browserTransactionHash: "f".repeat(64) };
			const requester = {
				kind: "browser" as const,
				browserTransactionHash: wrong.browserTransactionHash,
			};
			const before = rows(f, TABLES[0]);
			const authority = authoritySnapshot(f);
			// Act
			const advanced = await next(f, state, f.cfg, wrong);
			const cancelled = await f.store.failAuthLinkAttempt(
				{ attemptId: "attempt-a", requester, reason: "cancelled" },
				f.cfg,
			);
			// Assert
			for (const result of [advanced, cancelled])
				expect(result).toMatchObject({ kind: "rejected" });
			expect(await f.store.getAuthLinkAttemptStatus("attempt-a", requester, f.cfg)).toBeNull();
			expect(await f.store.readAuthLinkCompletionDestination(wrong, f.cfg)).toBeNull();
			expect(rows(f, TABLES[0])).toEqual(before);
			expect(authoritySnapshot(f)).toEqual(authority);
		},
	);
	test(`${backend} cancel after OIDC permits fresh attempt without burning device ownership`, async ({
		fixture: f,
	}) => {
		// Arrange
		const browser = await prepare(f, "oidc_verified");
		const before = authoritySnapshot(f);
		const fresh = {
			...request(),
			attemptId: "fresh-attempt",
			runtimeVerifierHash: "1".repeat(64),
			browserStartHash: "2".repeat(64),
		};
		// Act
		const cancelled = await f.store.failAuthLinkAttempt(
			{ attemptId: "attempt-a", requester: device, reason: "cancelled" },
			f.cfg,
		);
		const reused = await f.store.createAuthLinkAttempt(
			{ ...fresh, runtimeVerifierHash: request().runtimeVerifierHash },
			f.cfg,
		);
		const retry = await f.store.createAuthLinkAttempt(fresh, f.cfg);
		// Assert
		expect(cancelled).toMatchObject({ kind: "applied", status: { state: "failed" } });
		expect(reused).toEqual({ kind: "rejected", error: "attempt_conflict" });
		expect(retry).toMatchObject({ kind: "created", status: { state: "pending" } });
		expect(rows(f, TABLES[0])[0]).toMatchObject({
			account_subject: null,
			failure_reason: "device_cancelled",
		});
		expect(await f.store.readAuthLinkCompletionDestination(browser, f.cfg)).toBeNull();
		expect(authoritySnapshot(f)).toEqual(before);
	});
	test(`${backend} original device proof can cancel after enrollment is disabled`, async ({
		fixture: f,
	}) => {
		// Arrange
		const browser = await prepare(f, "oidc_verified");
		f.db.exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'");
		const before = authoritySnapshot(f);
		// Act
		const cancelled = await f.store.failAuthLinkAttempt(
			{ attemptId: "attempt-a", requester: device, reason: "cancelled" },
			f.cfg,
		);
		const confirmed = await next(f, "oidc_verified", f.cfg, browser);
		// Assert
		expect(cancelled).toMatchObject({ kind: "applied", status: { state: "failed" } });
		expect(confirmed).toMatchObject({ kind: "rejected" });
		expect(rows(f, TABLES[0])[0]).toMatchObject({
			account_subject: null,
			failure_reason: "device_cancelled",
		});
		expect(authoritySnapshot(f)).toEqual(before);
	});
	test(`${backend} maintenance expires at the exact boundary and clears OIDC metadata only`, async ({
		fixture: f,
	}) => {
		// Arrange
		const browser = await prepare(f, "oidc_verified");
		const before = authoritySnapshot(f);
		f.now += TTL - 1;
		// Act
		const early = await f.store.maintainAuthLinkAttempts(f.cfg);
		const live = await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg);
		f.now++;
		const expired = await f.store.maintainAuthLinkAttempts(f.cfg);
		const confirmation = await next(f, "oidc_verified", f.cfg, browser);
		// Assert
		expect(early).toMatchObject({ kind: "maintained", processedCount: 0 });
		expect(live).toMatchObject({ state: "oidc_verified" });
		expect(expired).toMatchObject({ kind: "maintained", processedCount: 1 });
		expect(confirmation).toMatchObject({ kind: "rejected" });
		expect(rows(f, TABLES[0])[0]).toMatchObject({
			state: "expired",
			account_subject: null,
			link_id: null,
		});
		expect(await f.store.readAuthLinkCompletionDestination(browser, f.cfg)).toBeNull();
		expect(authoritySnapshot(f)).toEqual(before);
	});
}
