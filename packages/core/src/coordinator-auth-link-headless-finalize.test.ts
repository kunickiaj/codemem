import { describe, expect } from "vitest";
import {
	browserConfig,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	AUTHORITIES,
	type Authority,
	attemptRow,
	DESKTOP_ID,
	desktopConfirmed,
	desktopFinalize,
	HEADLESS_ID,
	headlessConfirmed,
	headlessFinalize,
	linkEffects,
	SUBJECT,
} from "./coordinator-auth-link-headless-test-fixtures.js";
import {
	backendTest,
	completionHash,
	consumeSigninProof,
	type LinkFixture,
	snapshot,
	status,
} from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";

const unavailable = { kind: "rejected", error: "attempt_unavailable" };
const SESSION_CREDENTIAL = "e".repeat(64);
const SIGNIN_HASH = "f".repeat(64);
type Mode = "desktop" | "headless";
const MODES: Mode[] = ["desktop", "headless"];

async function finalizedLink(f: LinkFixture, mode: Mode, kind: Authority) {
	if (mode === "desktop") {
		const browser = await desktopConfirmed(f, kind);
		expect(await f.store.finalizeAuthLinkAttempt(desktopFinalize(f, kind), f.cfg)).toMatchObject({
			kind: "applied",
		});
		return browser;
	}
	const browser = await headlessConfirmed(f, kind);
	expect(
		await f.store.finalizeHeadlessAuthLinkAttempt(headlessFinalize(f, kind), f.cfg),
	).toMatchObject({ kind: "applied" });
	return browser;
}

async function desktopEffects(f: LinkFixture, backend: Backend, kind: Authority) {
	const other = setupStore(backend, { authClock: () => f.now });
	const g: LinkFixture = { ...other, cfg: { ...f.cfg }, now: f.now };
	try {
		await finalizedLink(g, "desktop", kind);
		return linkEffects(g);
	} finally {
		await g.store.close();
		if (g.db.open) g.db.close();
	}
}

function sessions(f: LinkFixture) {
	return f.db.prepare("SELECT * FROM coordinator_auth_sessions").all();
}

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} headless finalize`, () => {
		const test = backendTest(backend);
		test.for(AUTHORITIES)(
			"links the approved account with the same effects as desktop for %s",
			async (kind, { fixture: f }) => {
				// Arrange: desktop runs in a separate store so both start from the same state.
				const desktop = await desktopEffects(f, backend, kind);
				await headlessConfirmed(f, kind);
				// Act
				const result = await f.store.finalizeHeadlessAuthLinkAttempt(
					headlessFinalize(f, kind),
					f.cfg,
				);
				const retry = await f.store.finalizeHeadlessAuthLinkAttempt(
					headlessFinalize(f, kind),
					f.cfg,
				);
				// Assert
				expect(result).toEqual({ kind: "applied", status: status("finalized", HEADLESS_ID) });
				expect(retry).toEqual({ kind: "existing", status: status("finalized", HEADLESS_ID) });
				expect(linkEffects(f)).toEqual(desktop);
				expect(linkEffects(f).links).toEqual([
					expect.objectContaining({ subject: SUBJECT, authority_kind: kind }),
				]);
			},
		);
		test.for(AUTHORITIES)(
			"writes nothing when the approved subject differs for %s",
			async (kind, { fixture: f }) => {
				// Arrange
				await headlessConfirmed(f, kind);
				const before = snapshot(f);
				// Act
				const result = await f.store.finalizeHeadlessAuthLinkAttempt(
					headlessFinalize(f, kind, "someone-else"),
					f.cfg,
				);
				// Assert
				expect(snapshot(f)).toEqual(before);
				expect(result).toEqual(unavailable);
				expect(attemptRow(f, HEADLESS_ID)).toMatchObject({ state: "confirmed", link_id: null });
			},
		);
		test("rejects an approved account from another issuer as invalid input", async ({
			fixture: f,
		}) => {
			// Arrange
			await headlessConfirmed(f);
			const input = headlessFinalize(f);
			input.approvedAccount = { issuer: "https://other.example.test", subject: SUBJECT };
			// Act
			const result = await f.store.finalizeHeadlessAuthLinkAttempt(input, f.cfg);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(attemptRow(f, HEADLESS_ID)).toMatchObject({ state: "confirmed" });
		});
		test.for(AUTHORITIES)(
			"each finalize refuses the other mode's attempt for %s",
			async (kind, { fixture: f }) => {
				// Arrange
				await headlessConfirmed(f, kind);
				const before = snapshot(f);
				const { approvedAccount: _approved, ...plain } = headlessFinalize(f, kind);
				// Act
				const desktopOnHeadless = await f.store.finalizeAuthLinkAttempt(plain, f.cfg);
				const headlessOnDesktop = await f.store.finalizeHeadlessAuthLinkAttempt(
					{
						...desktopFinalize(f, kind),
						approvedAccount: { issuer: f.cfg.issuer, subject: SUBJECT },
					},
					f.cfg,
				);
				// Assert
				expect(snapshot(f)).toEqual(before);
				expect(desktopOnHeadless).toEqual(unavailable);
				expect(headlessOnDesktop).toMatchObject({ kind: "rejected" });
			},
		);
		test("headless finalize refuses a confirmed desktop attempt", async ({ fixture: f }) => {
			// Arrange
			await desktopConfirmed(f);
			const before = snapshot(f);
			// Act
			const result = await f.store.finalizeHeadlessAuthLinkAttempt(
				{
					...desktopFinalize(f),
					approvedAccount: { issuer: f.cfg.issuer, subject: SUBJECT },
				},
				f.cfg,
			);
			const desktopOnly = await f.store.finalizeHeadlessAuthLinkAttempt(
				{
					...desktopFinalize(f),
					completionSecretHash: attemptRow(f, DESKTOP_ID).runtime_verifier_hash as string,
					approvedAccount: { issuer: f.cfg.issuer, subject: SUBJECT },
				},
				f.cfg,
			);
			// Assert
			expect(snapshot(f)).toEqual(before);
			expect(result).toEqual(unavailable);
			expect(desktopOnly).toEqual(unavailable);
			expect(attemptRow(f, DESKTOP_ID).completion_secret_hash).toBe(completionHash);
		});
	});

	describe(`${backend} headless browser sessions`, () => {
		const test = backendTest(backend);
		test.for(MODES)("bound redemption after %s finalize", async (mode, { fixture: f }) => {
			// Arrange
			const browser = await finalizedLink(f, mode, "controller_attestation");
			const before = transactionRows(f);
			// Act
			const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(
				{ ...browser, credentialHash: SESSION_CREDENTIAL },
				browserConfig,
			);
			// Assert
			if (mode === "desktop") {
				expect(result).toMatchObject({ kind: "issued" });
				expect(sessions(f)).toHaveLength(1);
				return;
			}
			expect(result).toEqual(unavailable);
			expect(sessions(f)).toEqual([]);
			expect(transactionRows(f)).toEqual(before);
			expect(attemptRow(f, browser.attemptId)).toMatchObject({ state: "finalized" });
		});
		test.for(MODES)(
			"existing-session completion after %s finalize",
			async (mode, { fixture: f }) => {
				// Arrange: an independent sign-in session already exists for the linked account.
				const browser = await finalizedLink(f, mode, "controller_attestation");
				await consumeSigninProof(f, SIGNIN_HASH);
				expect(
					await f.store.signInWithConsumedBrowserTransaction(
						{
							browserTransactionHash: SIGNIN_HASH,
							credentialHash: SESSION_CREDENTIAL,
							account: { issuer: f.cfg.issuer, subject: SUBJECT },
						},
						browserConfig,
					),
				).toMatchObject({ kind: "issued" });
				// Act
				const result = await f.store.preserveAuthLinkSessionCompletion(
					{ ...browser, credentialHash: SESSION_CREDENTIAL },
					browserConfig,
				);
				// Assert
				const state = attemptRow(f, browser.attemptId).state;
				if (mode === "desktop") {
					expect(result).toEqual({ kind: "preserved" });
					expect(state).toBe("session_redeemed");
					return;
				}
				expect(result).toEqual(unavailable);
				expect(state).toBe("finalized");
			},
		);
	});
}
