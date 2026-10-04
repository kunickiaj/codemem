import { describe, expect, it, vi } from "vitest";
import {
	browserConfig,
	materials,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { AuthLinkOperations } from "./coordinator-auth-link.js";
import {
	advance,
	attempt,
	authorize,
	backendTest,
	browserHash,
	device,
	type LinkFixture,
	NOW,
	snapshot,
	type Test,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";

const proof = { attemptId: "attempt-a", browserTransactionHash: browserHash };
const destinations = [
	"http://127.0.0.1:80/codemem/auth/complete",
	"http://127.0.0.1:65535/codemem/auth/complete",
	"http://[::1]:80/codemem/auth/complete",
	"http://[::1]:65535/codemem/auth/complete",
];
function unchanged(f: LinkFixture) {
	return [
		snapshot(f),
		transactionRows(f),
		...[
			"coordinator_auth_controller_attestations",
			"enrolled_devices",
			"coordinator_auth_sessions",
			"coordinator_auth_session_receipts",
		].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()),
	];
}
async function verifiedBrowser(f: LinkFixture, loopbackRedirect: string) {
	await authorize(f);
	const created = await f.store.createAuthLinkAttempt(attempt({ loopbackRedirect }), f.cfg);
	expect(created.kind).toBe("created");
	const input = { ...materials(), purpose: "link" as const, attemptId: proof.attemptId };
	expect((await f.store.startAuthBrowserTransaction(input, browserConfig)).kind).toBe("started");
	const consumed = await f.store.consumeAuthBrowserTransaction(input, browserConfig);
	if (consumed.kind !== "consumed") throw new Error("fixture browser consume failed");
	const owned = { ...proof, browserTransactionHash: consumed.browserTransactionHash };
	const account = { issuer: f.cfg.issuer, subject: "fixture-subject" };
	const verified = await f.store.recordAuthLinkOidcVerified({ ...owned, account }, f.cfg);
	expect(verified.kind).toBe("applied");
	const pending = await f.store.startAuthBrowserTransaction(materials(2), browserConfig);
	expect(pending.kind).toBe("started");
	return owned;
}

function registerSuccess(test: Test) {
	test.for(destinations)("returns exact saved literal %s", async (destination, { fixture: f }) => {
		// Arrange: real browser-store admission; account metadata remains trusted test input.
		const owned = await verifiedBrowser(f, destination);
		const before = unchanged(f);
		const statusBefore = await f.store.getAuthLinkAttemptStatus(proof.attemptId, device, f.cfg);
		// Act
		const result = await f.store.readAuthLinkCompletionDestination(owned, f.cfg);
		const retry = await f.store.readAuthLinkCompletionDestination(owned, f.cfg);
		// Assert: no authority, secrets, status changes, or nonce/PKCE mutation.
		expect(result).toEqual({ destination });
		expect(retry).toEqual(result);
		expect(unchanged(f)).toEqual(before);
		expect(await f.store.getAuthLinkAttemptStatus(proof.attemptId, device, f.cfg)).toEqual(
			statusBefore,
		);
	});
	test.for([
		"pending",
		"browser_claimed",
		"confirmed",
		"finalized",
		"session_redeemed",
		"failed",
		"expired",
	])("does not return a destination in %s", async (state, { fixture: f }) => {
		// Arrange: legacy claim is trusted fixture setup, never a public handler.
		await authorize(f);
		const setupState = {
			session_redeemed: "finalized",
			failed: "oidc_verified",
			expired: "oidc_verified",
		};
		await advance(f, setupState[state as keyof typeof setupState] ?? state);
		if (state === "session_redeemed" || state === "expired")
			f.db.prepare("UPDATE coordinator_auth_link_attempts SET state = ?").run(state);
		if (state === "failed")
			await f.store.failAuthLinkAttempt(
				{ attemptId: proof.attemptId, requester: device, reason: "cancelled" },
				f.cfg,
			);
		const before = unchanged(f);
		// Act
		const result = await f.store.readAuthLinkCompletionDestination(proof, f.cfg);
		// Assert
		expect(result).toBeNull();
		expect(unchanged(f)).toEqual(before);
	});
}

function registerGuards(test: Test) {
	const cases: { input?: unknown; config?: unknown; getter?: string }[] = [
		...[
			null,
			[],
			{ ...proof, attemptId: "" },
			{ ...proof, attemptId: 1 },
			{ ...proof, attemptId: "missing-attempt" },
			{ ...proof, browserTransactionHash: "C".repeat(64) },
			{ ...proof, browserTransactionHash: "c".repeat(63) },
			{ ...proof, browserTransactionHash: "e".repeat(64) },
		].map((input) => ({ input })),
		...[
			{ coordinatorId: "other-coordinator" },
			{ issuer: "https://other.example.test" },
			{ revision: "e".repeat(64) },
			{ enabled: false },
		].map((change) => ({ config: { ...browserConfig, ...change } })),
		...["attemptId", "browserTransactionHash", "issuer", "enabled"].map((getter) => ({ getter })),
	];
	test.for(cases)("rejects invalid proof/config %#", async (change, { fixture: f }) => {
		// Arrange
		await authorize(f);
		await advance(f, "oidc_verified");
		const input = Object.hasOwn(change, "input") ? change.input : { ...proof };
		const config = change.config ?? { ...f.cfg };
		const getter = vi.fn(() => "must not execute");
		if (change.getter)
			Object.defineProperty(Object.hasOwn(proof, change.getter) ? input : config, change.getter, {
				get: getter,
			});
		const before = unchanged(f);
		// Act
		const result = await f.store.readAuthLinkCompletionDestination(
			input as typeof proof,
			config as typeof f.cfg,
		);
		// Assert
		expect(result).toBeNull();
		expect(getter).not.toHaveBeenCalled();
		expect(unchanged(f)).toEqual(before);
	});
	test.for([-1, 0, TTL - 1, TTL, TTL + 1])(
		"checks creation/deadline at offset %s",
		async (offset, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "oidc_verified");
			f.now = NOW + offset;
			const before = unchanged(f);
			// Act
			const result = await f.store.readAuthLinkCompletionDestination(proof, f.cfg);
			// Assert: creation equality is live; deadline equality and future-born are not.
			expect(result).toEqual(
				offset >= 0 && offset < TTL ? { destination: attempt().loopbackRedirect } : null,
			);
			expect(unchanged(f)).toEqual(before);
		},
	);
}

function registerInvalid(test: Test) {
	test.for([
		"not a URL",
		"https://127.0.0.1:80/codemem/auth/complete",
		"http://user@127.0.0.1:80/codemem/auth/complete",
		"http://127.0.0.1:80/codemem/auth/complete?x=1",
		"http://127.0.0.1:80/codemem/auth/complete#fragment",
		"http://localhost:80/codemem/auth/complete",
		"http://127.0.0.2:80/codemem/auth/complete",
		"http://127.0.0.1:80/other",
		"http://127.0.0.1:0/codemem/auth/complete",
		"http://[:::1]:80/codemem/auth/complete",
		"http://[0:0:0:0:0:0:0:1]:80/codemem/auth/complete",
		"http://2130706433:80/codemem/auth/complete",
	])("fails closed on corrupt saved redirect %s", async (destination, { fixture: f }) => {
		// Arrange: ordinary saved column has no URL CHECK; bypass only input validation.
		await authorize(f);
		await advance(f, "oidc_verified");
		f.db
			.prepare("UPDATE coordinator_auth_link_attempts SET loopback_redirect = ?")
			.run(destination);
		const before = unchanged(f);
		// Act
		const result = await f.store.readAuthLinkCompletionDestination(proof, f.cfg);
		// Assert
		expect(result).toBeNull();
		expect(unchanged(f)).toEqual(before);
	});
}

describe.each(["SQLite", "D1"] as const)(
	"%s trusted completion destination (D1 is SQLite-backed)",
	(backend) => {
		const test = backendTest(backend);
		registerSuccess(test);
		registerGuards(test);
		registerInvalid(test);
	},
);

it("normalizes backend read failure without issuing writes", async () => {
	// Arrange
	const first = vi.fn().mockRejectedValue(new Error("private backend detail"));
	const run = vi.fn();
	const batch = vi.fn();
	const links = new AuthLinkOperations({ first, run, batch }, () => NOW);
	// Act
	const result = links.readAuthLinkCompletionDestination(proof, browserConfig);
	// Assert
	await expect(result).rejects.toThrow(/^auth_link_persistence_error$/);
	expect(run).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});
