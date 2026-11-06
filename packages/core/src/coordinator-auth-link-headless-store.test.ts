import { createHash } from "node:crypto";
import { describe, expect } from "vitest";
import {
	browserConfig,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	AUTH_LINK_HEADLESS_MARKER,
	deriveHeadlessUserCodeStartBytes,
	hashHeadlessUserCode,
} from "./coordinator-auth-link-headless.js";
import {
	AUTHORITIES,
	attemptRow,
	authorizeFor,
	DESKTOP_ID,
	DESKTOP_START,
	desktopCreate,
	desktopStart,
	desktopVerified,
	HEADLESS_ID,
	HEADLESS_VERIFIER,
	headlessConfirmed,
	headlessCreate,
	headlessStart,
	headlessVerified,
	PROFILE,
	SUBJECT,
	signerFor,
	USER_CODE,
} from "./coordinator-auth-link-headless-test-fixtures.js";
import {
	backendTest,
	completionHash,
	expectRejected,
	snapshot,
	status,
} from "./coordinator-auth-link-test-fixtures.js";

const unavailable = { kind: "rejected", error: "attempt_unavailable" };

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} headless create`, () => {
		const test = backendTest(backend);
		test.for(AUTHORITIES)(
			"stores the marker and code hash with exact retries for %s",
			async (kind, { fixture: f }) => {
				// Arrange
				await authorizeFor(f, kind);
				const input = await headlessCreate(kind);
				// Act
				const created = await f.store.createHeadlessAuthLinkAttempt(input, f.cfg);
				const retry = await f.store.createHeadlessAuthLinkAttempt(input, f.cfg);
				const otherCode = await f.store.createHeadlessAuthLinkAttempt(
					{ ...input, userCodeHash: await hashHeadlessUserCode("ZXWVTSRQ") },
					f.cfg,
				);
				const asDesktop = await f.store.createAuthLinkAttempt(
					{
						...desktopCreate(kind),
						attemptId: HEADLESS_ID,
						runtimeVerifierHash: HEADLESS_VERIFIER,
					},
					f.cfg,
				);
				// Assert
				expect(created).toEqual({
					kind: "created",
					status: status("pending", HEADLESS_ID),
					identityId: "identity-a",
				});
				expect(retry).toEqual({ ...created, kind: "existing" });
				expectRejected(otherCode, "attempt_conflict");
				expectRejected(asDesktop, "attempt_conflict");
				expect(attemptRow(f, HEADLESS_ID)).toMatchObject({
					loopback_redirect: AUTH_LINK_HEADLESS_MARKER,
					browser_start_hash: input.userCodeHash,
					authority_kind: kind,
				});
			},
		);
		test("rejects malformed headless input and keeps desktop loopback validation", async ({
			fixture: f,
		}) => {
			// Arrange
			await authorizeFor(f, "controller_attestation");
			const input = await headlessCreate();
			const before = snapshot(f);
			// Act
			const results = [
				await f.store.createHeadlessAuthLinkAttempt({ ...input, userCodeHash: "x" }, f.cfg),
				await f.store.createAuthLinkAttempt(
					{ ...desktopCreate(), loopbackRedirect: AUTH_LINK_HEADLESS_MARKER },
					f.cfg,
				),
			];
			// Assert
			for (const result of results) expectRejected(result, "invalid_input");
			expect(snapshot(f)).toEqual(before);
		});
	});

	describe(`${backend} headless browser claim`, () => {
		const test = backendTest(backend);
		test("claims a pending headless attempt once by its code", async ({ fixture: f }) => {
			// Arrange
			await authorizeFor(f, "controller_attestation");
			const input = await headlessCreate();
			await f.store.createHeadlessAuthLinkAttempt(input, f.cfg);
			// Act
			const first = await f.store.startHeadlessAuthLinkBrowserTransaction(
				headlessStart(input.userCodeHash),
				browserConfig,
			);
			const second = await f.store.startHeadlessAuthLinkBrowserTransaction(
				headlessStart(input.userCodeHash, 5),
				browserConfig,
			);
			// Assert
			expect(first).toEqual({
				kind: "started",
				expiresAtMs: f.now + 600_000,
				attemptId: HEADLESS_ID,
			});
			expect(second).toEqual(unavailable);
			expect(attemptRow(f, HEADLESS_ID)).toMatchObject({ state: "browser_claimed" });
			expect(transactionRows(f)).toHaveLength(1);
		});
		test.for(["failed", "expired", "unknown"] as const)(
			"refuses a %s code without writes",
			async (condition, { fixture: f }) => {
				// Arrange
				await authorizeFor(f, "controller_attestation");
				const input = await headlessCreate();
				await f.store.createHeadlessAuthLinkAttempt(input, f.cfg);
				if (condition === "failed")
					await f.store.failAuthLinkAttempt(
						{
							attemptId: HEADLESS_ID,
							requester: { kind: "device", signer: input.signer },
							reason: "cancelled",
						},
						f.cfg,
					);
				if (condition === "expired") f.now += 600_000;
				const code = condition === "unknown" ? await hashHeadlessUserCode("ZXWVTSRQ") : null;
				const before = snapshot(f);
				// Act
				const result = await f.store.startHeadlessAuthLinkBrowserTransaction(
					headlessStart(code ?? input.userCodeHash),
					browserConfig,
				);
				// Assert
				expect(result).toEqual(unavailable);
				expect(snapshot(f)).toEqual(before);
				expect(transactionRows(f)).toEqual([]);
			},
		);
		test("desktop start cannot claim a headless attempt, even with the derived start code", async ({
			fixture: f,
		}) => {
			// Arrange: the inner bytes are what a desktop start code would decode to.
			await authorizeFor(f, "controller_attestation");
			const input = await headlessCreate();
			await f.store.createHeadlessAuthLinkAttempt(input, f.cfg);
			const inner = await deriveHeadlessUserCodeStartBytes(USER_CODE);
			const derived = createHash("sha256").update(inner).digest("hex");
			const before = snapshot(f);
			// Act
			const started = await f.store.startAuthBrowserTransaction(
				desktopStart(HEADLESS_ID, derived),
				browserConfig,
			);
			const legacy = await f.store.claimAuthLinkAttempt(
				{ attemptId: HEADLESS_ID, browserTransactionHash: "c".repeat(64) },
				f.cfg,
			);
			// Assert
			expect(derived).toBe(input.userCodeHash);
			expect(started).toEqual(unavailable);
			expect(legacy).toEqual(unavailable);
			expect(snapshot(f)).toEqual(before);
			expect(transactionRows(f)).toEqual([]);
		});
		test("headless code entry cannot claim a desktop attempt with the same start hash", async ({
			fixture: f,
		}) => {
			// Arrange
			await authorizeFor(f, "controller_attestation");
			await f.store.createAuthLinkAttempt(desktopCreate(), f.cfg);
			const before = snapshot(f);
			// Act
			const result = await f.store.startHeadlessAuthLinkBrowserTransaction(
				headlessStart(DESKTOP_START),
				browserConfig,
			);
			// Assert
			expect(result).toEqual(unavailable);
			expect(snapshot(f)).toEqual(before);
			expect(transactionRows(f)).toEqual([]);
		});
	});

	describe(`${backend} headless confirmation`, () => {
		const test = backendTest(backend);
		test.for(AUTHORITIES)(
			"confirms with the runtime verifier for %s",
			async (kind, { fixture: f }) => {
				// Act
				await headlessConfirmed(f, kind);
				// Assert
				expect(attemptRow(f, HEADLESS_ID)).toMatchObject({
					state: "confirmed",
					completion_secret_hash: HEADLESS_VERIFIER,
					runtime_verifier_hash: HEADLESS_VERIFIER,
				});
			},
		);
		test("OIDC target names the device key fingerprint and marks the headless mode", async ({
			fixture: f,
		}) => {
			// Arrange
			await authorizeFor(f, "controller_attestation");
			const input = await headlessCreate();
			await f.store.createHeadlessAuthLinkAttempt(input, f.cfg);
			const start = headlessStart(input.userCodeHash);
			await f.store.startHeadlessAuthLinkBrowserTransaction(start, browserConfig);
			const consumed = await f.store.consumeAuthBrowserTransaction(start, browserConfig);
			if (consumed.kind !== "consumed") throw new Error("fixture_not_consumed");
			// Act
			const recorded = await f.store.recordAuthLinkOidcVerified(
				{
					attemptId: HEADLESS_ID,
					browserTransactionHash: consumed.browserTransactionHash,
					account: { issuer: f.cfg.issuer, subject: SUBJECT },
				},
				f.cfg,
			);
			// Assert
			expect(recorded).toEqual({
				kind: "applied",
				status: status("oidc_verified", HEADLESS_ID),
				target: {
					identityId: "identity-a",
					groupId: input.signer.groupId,
					deviceId: input.signer.deviceId,
					fingerprint: input.signer.fingerprint,
					headless: true,
				},
			});
		});
		test("each confirmation refuses the other mode's attempt", async ({ fixture: f }) => {
			// Arrange
			const headless = await headlessVerified(f);
			const desktop = await desktopVerified(f, "controller_attestation", { authorized: true });
			const before = snapshot(f);
			// Act
			const desktopOnHeadless = await f.store.confirmAuthLinkAttempt(
				{
					attemptId: headless.attemptId,
					browserTransactionHash: headless.browserTransactionHash,
					completionSecretHash: completionHash,
				},
				f.cfg,
			);
			const headlessOnDesktop = await f.store.confirmHeadlessAuthLinkAttempt(
				{ attemptId: desktop.attemptId, browserTransactionHash: desktop.browserTransactionHash },
				f.cfg,
			);
			// Assert
			expect(desktopOnHeadless).toEqual(unavailable);
			expect(headlessOnDesktop).toEqual(unavailable);
			expect(snapshot(f)).toEqual(before);
			expect(attemptRow(f, DESKTOP_ID).completion_secret_hash).toBeNull();
			expect(attemptRow(f, HEADLESS_ID).completion_secret_hash).toBeNull();
		});
	});

	describe(`${backend} headless approval read`, () => {
		const test = backendTest(backend);
		test("returns the verified account only to the signing device after confirmation", async ({
			fixture: f,
		}) => {
			// Arrange
			const browser = await headlessVerified(f);
			const s = signerFor("controller_attestation");
			const request = { attemptId: HEADLESS_ID, signer: s };
			const early = await f.store.readHeadlessAuthLinkApproval(request, f.cfg);
			const { binderHash: _binder, ...proof } = browser;
			await f.store.confirmHeadlessAuthLinkAttempt(proof, f.cfg);
			// Act
			const approval = await f.store.readHeadlessAuthLinkApproval(request, f.cfg);
			const stranger = await f.store.readHeadlessAuthLinkApproval(
				{ ...request, signer: { ...s, deviceId: "device-b" } },
				f.cfg,
			);
			// Assert
			expect(early).toBeNull();
			expect(stranger).toBeNull();
			expect(approval).toEqual({
				issuer: f.cfg.issuer,
				subject: SUBJECT,
				displayName: PROFILE.displayName,
				email: PROFILE.email,
				emailVerified: true,
			});
		});
		test("returns nothing for a confirmed desktop attempt", async ({ fixture: f }) => {
			// Arrange
			const desktop = await desktopVerified(f);
			const { binderHash: _binder, ...proof } = desktop;
			await f.store.confirmAuthLinkAttempt(
				{ ...proof, completionSecretHash: completionHash },
				f.cfg,
			);
			// Act
			const approval = await f.store.readHeadlessAuthLinkApproval(
				{ attemptId: DESKTOP_ID, signer: signerFor("controller_attestation") },
				f.cfg,
			);
			// Assert
			expect(attemptRow(f, DESKTOP_ID)).toMatchObject({ state: "confirmed" });
			expect(approval).toBeNull();
		});
	});
}
