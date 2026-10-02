import { describe, expect } from "vitest";
import { expectRejected, snapshot } from "./coordinator-auth-link-test-fixtures.js";
import {
	backendTest,
	credentialHash,
	expectIssued,
	linked,
	linkId,
	redeemInput,
	SESSION_TTL,
	type SessionTest,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

const malformed = [null, undefined, [], "raw-fixture-secret", 42] as const;
function hostile(field: string, valid: Record<string, unknown>, kind: string) {
	if (kind === "inherited")
		return Object.assign(
			Object.create({ [field]: valid[field] }),
			Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field)),
		);
	if (kind === "getter")
		return Object.defineProperty({ ...valid }, field, {
			get() {
				throw new Error("fixture-secret-getter");
			},
		});
	if (kind === "coercion")
		return {
			...valid,
			[field]: {
				toString() {
					throw new Error("fixture-secret-coercion");
				},
			},
		};
	if (kind === "shadow") return { ...valid, hasOwnProperty: () => true, [field]: null };
	return { ...valid, [field]: "short" };
}
function registerIssueInputs(test: SessionTest) {
	test.for(malformed)(
		"rejects malformed redemption and sign-in %j without writes",
		async (input, { fixture: f }) => {
			// Arrange
			await linked(f);
			const before = snapshot(f);
			// Act
			const redeem = await f.store.redeemAuthLinkSession(input as never, f.cfg);
			const signIn = await f.store.signInWithAuthAccount(input as never, f.cfg);
			// Assert
			expectRejected(redeem, "invalid_input");
			expectRejected(signIn, "invalid_input");
			expect(sessionRows(f)).toEqual([[], []]);
			expect(snapshot(f)).toEqual(before);
		},
	);
	test.for(["inherited", "getter", "coercion", "shadow", "wrong-hash"])(
		"captures only own data for hostile %s fields",
		async (kind, { fixture: f }) => {
			// Arrange
			await linked(f);
			const before = snapshot(f);
			// Act
			const results = [];
			for (const field of ["attemptId", "browserTransactionHash", "credentialHash"])
				results.push({
					field,
					result: await f.store.redeemAuthLinkSession(
						hostile(field, redeemInput(), kind) as never,
						f.cfg,
					),
				});
			for (const field of ["browserTransactionHash", "credentialHash", "account"])
				results.push({
					field,
					result: await f.store.signInWithAuthAccount(
						hostile(field, signInInput(f), kind) as never,
						f.cfg,
					),
				});
			// Assert
			for (const { field, result } of results) {
				const error =
					kind === "wrong-hash" && field === "attemptId" ? "attempt_unavailable" : "invalid_input";
				expectRejected(result, error);
			}
			expect(sessionRows(f)).toEqual([[], []]);
			expect(snapshot(f)).toEqual(before);
		},
	);
	test.for(["inherited", "getter", "coercion", "shadow"])(
		"rejects hostile nested verified account %s",
		async (kind, { fixture: f }) => {
			// Arrange
			await linked(f);
			const input = signInInput(f);
			// Act
			const results = [];
			for (const field of ["issuer", "subject"])
				results.push(
					await f.store.signInWithAuthAccount(
						{ ...input, account: hostile(field, input.account, kind) } as never,
						f.cfg,
					),
				);
			// Assert
			for (const result of results) expectRejected(result, "invalid_input");
			expect(sessionRows(f)).toEqual([[], []]);
		},
	);
	test("own valid data ignores poisoned object prototypes and unknown getters", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = Object.assign(
			Object.create({ credentialHash: "bad", identityId: "attacker" }),
			signInInput(f),
		);
		Object.defineProperty(input, "profile", {
			get() {
				throw new Error("fixture-secret-profile");
			},
		});
		// Act
		const result = await f.store.signInWithAuthAccount(input, f.cfg);
		// Assert
		expectIssued(result, f);
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
	});
}
function registerScopeInputs(test: SessionTest) {
	test.for(["inherited", "getter", "coercion", "shadow"])(
		"rejects hostile logout and revoke scopes %s",
		async (kind, { fixture: f }) => {
			// Arrange
			await linked(f);
			await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
			const before = sessionRows(f);
			const links = snapshot(f);
			const scope = hostile("coordinatorId", { coordinatorId: f.cfg.coordinatorId }, kind);
			// Act
			const logout = await f.store.signOutAuthSession(credentialHash, scope as never);
			const revoke = await f.store.revokeAuthAccountLink({ linkId: linkId(f) }, scope as never);
			// Assert
			expectRejected(logout, "invalid_input");
			expectRejected(revoke, "invalid_input");
			expect(sessionRows(f)).toEqual(before);
			expect(snapshot(f)).toEqual(links);
		},
	);
	test.for(["short", "G".repeat(64), null, { toString: () => credentialHash }])(
		"rejects invalid credential %j in logout and read",
		async (hash, { fixture: f }) => {
			// Arrange
			await linked(f);
			await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
			const before = sessionRows(f);
			// Act
			const logout = await f.store.signOutAuthSession(hash as never, {
				coordinatorId: f.cfg.coordinatorId,
			});
			const read = await f.store.readAuthSession(hash as never, f.cfg);
			// Assert
			expectRejected(logout, "invalid_input");
			expect(read).toBeNull();
			expect(sessionRows(f)).toEqual(before);
		},
	);
	test.for(["inherited", "getter", "coercion", "shadow"])(
		"rejects hostile revocation link ID %s",
		async (kind, { fixture: f }) => {
			// Arrange
			await linked(f);
			const before = snapshot(f);
			// Act
			const result = await f.store.revokeAuthAccountLink(
				hostile("linkId", { linkId: linkId(f) }, kind) as never,
				{ coordinatorId: f.cfg.coordinatorId },
			);
			// Assert
			expectRejected(result, "invalid_input");
			expect(snapshot(f)).toEqual(before);
		},
	);
}
function registerClock(test: SessionTest) {
	test.for([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER - SESSION_TTL + 1,
	])("invalid clock %s throws before mutation", async (now, { fixture: f }) => {
		// Arrange
		await linked(f);
		f.now = now;
		const before = snapshot(f);
		// Act
		const result = f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		// Assert
		await expect(result).rejects.toThrow(/^auth_session_invalid_clock$/);
		expect(sessionRows(f)).toEqual([[], []]);
		expect(snapshot(f)).toEqual(before);
	});
	test.for([0, Number.MAX_SAFE_INTEGER - SESSION_TTL])(
		"safe clock boundary %s can issue a session",
		async (now, { fixture: f }) => {
			// Arrange
			await linked(f);
			f.now = now;
			// Act
			const result = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
			// Assert
			expectIssued(result, f);
			expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
		},
	);
}
function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerIssueInputs(test);
	registerScopeInputs(test);
	registerClock(test);
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-session own-data inputs and clocks (D1 is SQLite-backed)",
	registerBackend,
);
