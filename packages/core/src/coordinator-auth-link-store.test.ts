import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import type { CoordinatorAuthLinkCreateInput as CreateInput } from "./coordinator-auth-link-contract.js";
import {
	advance,
	attempt,
	authorize,
	backendTest,
	cfg,
	device,
	expectRejected,
	NOW,
	rows,
	setIdentity,
	signer,
	snapshot,
	status,
	TABLES,
	type Test,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import {
	type Backend,
	enroll,
	review,
	setupStore,
} from "./coordinator-auth-store-test-fixtures.js";

function registerCreationTests(test: Test) {
	test.for([null, "identity-a"])(
		"derives reviewed Identity with enrollment label %s",
		async (identity, { fixture: f }) => {
			// Arrange
			await authorize(f);
			setIdentity(f, identity);
			const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
			// Act
			const created = await f.store.createAuthLinkAttempt(attempt(), f.cfg);
			f.now += 100;
			const retry = await f.store.createAuthLinkAttempt(attempt(), f.cfg);
			// Assert: retries retain the original deadline and create no grants.
			expect(created).toEqual({
				kind: "created",
				status: status("pending"),
				identityId: "identity-a",
			});
			expect(retry).toEqual({ ...created, kind: "existing" });
			expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
			expect(rows(f, TABLES[0])).toHaveLength(1);
			expect(rows(f, TABLES[0])[0]).toMatchObject({
				runtime_verifier_hash: attempt().runtimeVerifierHash,
				browser_transaction_hash: null,
				completion_secret_hash: null,
				account_subject: null,
				loopback_redirect: attempt().loopbackRedirect,
				created_at_ms: NOW,
				expires_at_ms: NOW + TTL,
			});
			expect(rows(f, TABLES[1])).toEqual([]);
			expect(rows(f, TABLES[2])).toEqual([]);
		},
	);
	test.for([
		{ loopbackRedirect: "http://[::1]:4567/codemem/auth/complete" },
		{ loopbackRedirect: "http://127.0.0.1:80/codemem/auth/complete" },
	])("preserves literal allowed loopback $loopbackRedirect", async (overrides, { fixture: f }) => {
		// Arrange
		await authorize(f);
		// Act
		const result = await f.store.createAuthLinkAttempt(attempt(overrides), f.cfg);
		// Assert
		expect(result.kind).toBe("created");
		expect(rows(f, TABLES[0])[0].loopback_redirect).toBe(overrides.loopbackRedirect);
	});
}

function registerConflictTests(test: Test) {
	test.for([
		{ signer: { ...signer, deviceId: "other-device" } },
		{ loopbackRedirect: "http://127.0.0.1:4568/codemem/auth/complete" },
		{ runtimeVerifierHash: "e".repeat(64) },
		{ attemptId: "attempt-b" },
	])("rejects altered attempt or reused verifier %#", async (overrides, { fixture: f }) => {
		// Arrange
		await authorize(f);
		if ("signer" in overrides) {
			const other = review({
				deviceId: "other-device",
				attestationId: "attestation-other",
				reviewReceiptId: "receipt-other",
			});
			await enroll(f.store, other);
			await f.store.createAuthControllerAttestation(other);
		}
		await advance(f, "pending");
		const before = snapshot(f);
		// Act
		const result = await f.store.createAuthLinkAttempt(attempt(overrides), f.cfg);
		// Assert
		expectRejected(result, "attempt_conflict");
		expect(snapshot(f)).toEqual(before);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerCreationTests(test);
	registerConflictTests(test);
	registerValidationTests(test);
	registerNamespaceTests(test);
}

describe.each(["SQLite", "D1"] as const)(
	"%s auth-link creation parity (D1 is SQLite-backed)",
	registerBackend,
);

const invalidCreates: [string, unknown][] = [
	["null", null],
	["array", []],
	...["", " padded ", "x".repeat(257), "bad\u0000id", "bad\u200bid", "bad\ud800id", 42].map(
		(attemptId): [string, unknown] => ["invalid ID", { ...attempt(), attemptId }],
	),
	...["", "A".repeat(64), "a".repeat(63), "z".repeat(64), null].map(
		(runtimeVerifierHash): [string, unknown] => [
			"invalid hash",
			{ ...attempt(), runtimeVerifierHash },
		],
	),
	...[
		"https://127.0.0.1:4567/codemem/auth/complete",
		"http://localhost:4567/codemem/auth/complete",
		"http://127.0.0.1:04567/codemem/auth/complete",
		"http://127.0.0.1:4567/codemem/auth/complete?x=y",
		"http://127.0.0.1:4567/codemem/auth/complete#fragment",
		"http://user@127.0.0.1:4567/codemem/auth/complete",
		"http://127.0.0.1:0/codemem/auth/complete",
		"http://127.0.0.1:65536/codemem/auth/complete",
	].map((loopbackRedirect): [string, unknown] => [
		"invalid loopback",
		{ ...attempt(), loopbackRedirect },
	]),
];

function registerValidationTests(test: Test) {
	test.for(invalidCreates)(
		"rejects malformed create %s %# without writes",
		async ([_label, input], { fixture: f }) => {
			// Arrange
			await authorize(f);
			// Act: casts deliberately exercise the runtime input boundary.
			const result = await f.store.createAuthLinkAttempt(input as CreateInput, f.cfg);
			// Assert
			expectRejected(result, "invalid_input");
			expect(snapshot(f)).toEqual([[], [], []]);
		},
	);
	test.for(["getter", "inherited", "proxy", "coercion"])(
		"captures primitives without executing %s input code",
		async (variant, { fixture: f }) => {
			// Arrange
			await authorize(f);
			const executed = vi.fn(() => {
				throw new Error("untrusted-input-marker");
			});
			let input: unknown = attempt();
			if (variant === "getter") Object.defineProperty(input, "attemptId", { get: executed });
			if (variant === "inherited") input = Object.create(attempt());
			if (variant === "proxy")
				input = new Proxy(attempt(), {
					getOwnPropertyDescriptor() {
						throw new Error("proxy-marker");
					},
				});
			if (variant === "coercion")
				input = { ...attempt(), attemptId: { toString: executed, valueOf: executed } };
			// Act
			const result = await f.store.createAuthLinkAttempt(input as CreateInput, f.cfg);
			// Assert
			expectRejected(result, "invalid_input");
			expect(executed).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual([[], [], []]);
		},
	);
	test("disabled provider prevents even new attempt creation", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		// Act
		const result = await f.store.createAuthLinkAttempt(attempt(), { ...f.cfg, enabled: false });
		// Assert
		expectRejected(result, "auth_config_changed");
		expect(snapshot(f)).toEqual([[], [], []]);
	});
}

function registerNamespaceTests(test: Test) {
	test("quote and SQL-wildcard attempt identifiers round-trip as bound literals", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		const input = attempt({ attemptId: "attempt'percent%underscore_double--hyphen" });
		// Act
		const result = await f.store.createAuthLinkAttempt(input, f.cfg);
		const exact = await f.store.getAuthLinkAttemptStatus(input.attemptId, device, f.cfg);
		const wildcard = await f.store.getAuthLinkAttemptStatus("%", device, f.cfg);
		// Assert
		expect(result.kind).toBe("created");
		expect(exact).toEqual(status("pending", input.attemptId));
		expect(wildcard).toBeNull();
	});
}

it.each(
	(["SQLite", "D1"] as const).flatMap((backend) =>
		[Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER].map((now) => ({
			backend,
			now,
		})),
	),
)(
	"$backend rejects invalid auth clock $now without persisting an attempt",
	async ({ backend, now }) => {
		// Arrange
		const f = setupStore(backend, { authClock: () => now });
		try {
			await enroll(f.store);
			await f.store.createAuthControllerAttestation(review());
			// Act
			const result = f.store.createAuthLinkAttempt(attempt(), cfg);
			// Assert
			await expect(result).rejects.toThrow("auth_link_invalid_clock");
			expect(snapshot(f)).toEqual([[], [], []]);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
);

it.each(
	(["SQLite", "D1"] as const).flatMap((backend) =>
		[0, Number.MAX_SAFE_INTEGER - TTL].map((now) => ({ backend, now })),
	),
)("$backend accepts safe clock boundary $now", async ({ backend, now }) => {
	// Arrange
	const f = setupStore(backend, { authClock: () => now });
	try {
		await enroll(f.store);
		await f.store.createAuthControllerAttestation(review());
		// Act
		const result = await f.store.createAuthLinkAttempt(attempt(), cfg);
		// Assert
		expect(result).toEqual({
			kind: "created",
			status: { attemptId: "attempt-a", state: "pending", expiresAtMs: now + TTL },
			identityId: "identity-a",
		});
	} finally {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
});

it("SQLite existing-file upgrade adds empty link storage without changing review authority", async () => {
	// Arrange: only this disposable database represents a pre-link installation.
	const directory = mkdtempSync(join(tmpdir(), "auth-link-upgrade-"));
	const path = join(directory, "coordinator.sqlite");
	let store = new BetterSqliteCoordinatorStore(path, { authClock: () => NOW });
	try {
		await enroll(store);
		await store.createAuthControllerAttestation(review());
		const enrollment = store.db.prepare("SELECT * FROM enrolled_devices").all();
		const controllers = store.db
			.prepare("SELECT * FROM coordinator_auth_controller_attestations")
			.all();
		for (const table of [...TABLES].reverse()) store.db.exec(`DROP TABLE ${table}`);
		await store.close();
		// Act
		store = new BetterSqliteCoordinatorStore(path, { authClock: () => NOW });
		// Assert
		expect(snapshot({ store, db: store.db })).toEqual([[], [], []]);
		expect(store.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(enrollment);
		expect(
			store.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all(),
		).toEqual(controllers);
		expect(await store.createAuthLinkAttempt(attempt(), cfg)).toMatchObject({ kind: "created" });
	} finally {
		if (store.db.open) await store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
