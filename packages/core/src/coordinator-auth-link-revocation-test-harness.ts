import { expect, it } from "vitest";
import type { CoordinatorAuthLinkStore } from "./coordinator-auth-link-contract.js";
import { NOW, TTL } from "./coordinator-auth-link-test-fixtures.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";
import {
	enrollRevocation,
	type RevocationFixture,
} from "./coordinator-device-revocation-test-harness.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

export { NOW };
export const linkRevocationTables = [
	"coordinator_auth_link_audit_log",
	"coordinator_auth_account_links",
	"coordinator_auth_link_attempts",
	"coordinator_auth_controller_attestations",
	"coordinator_device_revocations",
	"enrolled_devices",
	"groups",
] as const;
export type LinkRevocationFixture = RevocationFixture & { now: number };
type Gate = (query: string, boundary: "read" | "captured" | "write") => Promise<void>;
type Guarded = (f: LinkRevocationFixture, gate: Gate) => CoordinatorAuthLinkStore;
export function linkRevocationHarness(
	fixture: (use: (f: LinkRevocationFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: LinkRevocationFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
type Test = ReturnType<typeof linkRevocationHarness>;

function inputs(f: LinkRevocationFixture) {
	const controller = review({
		...f.input,
		coordinatorId: `${f.input.groupId}-coordinator`,
		attestationId: `${f.input.deviceId}-attestation`,
		reviewReceiptId: `${f.input.deviceId}-receipt`,
	});
	const cfg = {
		coordinatorId: controller.coordinatorId,
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		enabled: true,
	};
	const signer = {
		groupId: f.input.groupId,
		deviceId: f.input.deviceId,
		publicKey: f.input.publicKey,
		fingerprint: f.input.fingerprint,
	};
	const start = {
		attemptId: `${f.input.deviceId}-attempt`,
		signer,
		runtimeVerifierHash: "b".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browser = { attemptId: start.attemptId, browserTransactionHash: "c".repeat(64) };
	const confirm = { ...browser, completionSecretHash: "d".repeat(64) };
	const final = {
		purpose: "coordinator-account-link-v1" as const,
		coordinatorId: cfg.coordinatorId,
		attemptId: start.attemptId,
		groupId: signer.groupId,
		identityId: controller.identityId,
		deviceId: signer.deviceId,
		fingerprint: signer.fingerprint,
		signer,
		runtimeVerifierHash: start.runtimeVerifierHash,
		completionSecretHash: confirm.completionSecretHash,
	};
	return { controller, cfg, start, browser, confirm, final };
}
type Inputs = ReturnType<typeof inputs>;
async function authorize(f: LinkRevocationFixture) {
	await enrollRevocation(f);
	const i = inputs(f);
	expect(await f.store.createAuthControllerAttestation(i.controller)).toMatchObject({
		kind: "created",
	});
	return i;
}
async function confirmed(f: LinkRevocationFixture, i: Inputs) {
	expect(await f.store.createAuthLinkAttempt(i.start, i.cfg)).toMatchObject({ kind: "created" });
	expect(await f.store.claimAuthLinkAttempt(i.browser, i.cfg)).toMatchObject({ kind: "applied" });
	expect(
		await f.store.recordAuthLinkOidcVerified(
			{ ...i.browser, account: { issuer: i.cfg.issuer, subject: "subject-a" } },
			i.cfg,
		),
	).toMatchObject({ kind: "applied" });
	expect(await f.store.confirmAuthLinkAttempt(i.confirm, i.cfg)).toMatchObject({ kind: "applied" });
}
async function effects(f: LinkRevocationFixture) {
	return Promise.all(linkRevocationTables.slice(0, 4).map((table) => f.rows(table)));
}
async function revoke(f: LinkRevocationFixture, subject: "device" | "key") {
	let tuple = f.input;
	if (subject === "key") {
		// A distinct clean receiver ID prevents the device-ID tombstone masking key bugs.
		tuple = {
			...tuple,
			groupId: `${tuple.groupId}-seed`,
			deviceId: `${tuple.deviceId}-seed`,
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: "f".repeat(64),
		};
		await f.store.createGroup(tuple.groupId);
		await f.store.enrollDevice(tuple.groupId, tuple);
	}
	expect(await f.store.createDeviceRevocation(tuple)).toMatchObject({ kind: "revoked" });
}
type Stage = "insert" | "retry" | "consume";
function isGate(query: string, stage: Stage) {
	if (stage === "insert") return query.startsWith("INSERT INTO coordinator_auth_link_attempts");
	if (stage === "retry")
		return (
			query.startsWith("SELECT 1 FROM coordinator_auth_link_attempts WHERE attempt_id") &&
			query.includes("coordinator_device_revocations")
		);
	return query.startsWith("UPDATE coordinator_auth_link_attempts SET state = 'finalized'");
}
async function prepare(f: LinkRevocationFixture, stage: Stage) {
	const i = await authorize(f);
	if (stage === "consume") await confirmed(f, i);
	if (stage === "retry")
		expect(await f.store.createAuthLinkAttempt(i.start, i.cfg)).toMatchObject({ kind: "created" });
	return i;
}
function perform(store: CoordinatorAuthLinkStore, i: Inputs, stage: Stage) {
	if (stage === "consume") return store.finalizeAuthLinkAttempt(i.final, i.cfg);
	return store.createAuthLinkAttempt(i.start, i.cfg);
}
const denial = { kind: "rejected", error: "controller_not_active" };

export function registerAuthLinkRevocationContract(test: Test) {
	registerOrdinary(test);
	registerRevocations(test);
	registerProofs(test);
	registerHistory(test);
}
function registerOrdinary(test: Test) {
	for (const identity of [null, "identity-a"]) {
		test(`ordinary link preserves create/retry/confirm/finalize with live Identity ${identity}`, async ({
			fixture: f,
		}) => {
			// Arrange: historical null enrollment may now have the reviewed Identity.
			const i = await authorize(f);
			await f.exec(
				"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ?",
				identity,
				f.input.groupId,
			);
			// Act
			await confirmed(f, i);
			const retry = await f.store.createAuthLinkAttempt(i.start, i.cfg);
			const result = await f.store.finalizeAuthLinkAttempt(i.final, i.cfg);
			// Assert
			expect(retry).toMatchObject({ kind: "existing", status: { state: "confirmed" } });
			expect(result).toEqual({
				kind: "applied",
				status: { attemptId: i.start.attemptId, state: "finalized", expiresAtMs: NOW + TTL },
			});
			expect(await f.rows(linkRevocationTables[0])).toHaveLength(1);
			expect(await f.rows(linkRevocationTables[1])).toMatchObject([
				{ issuer: i.cfg.issuer, subject: "subject-a", identity_id: "identity-a" },
			]);
		});
	}
}
function registerRevocations(test: Test) {
	for (const subject of ["device", "key"] as const) {
		for (const stage of ["insert", "retry", "consume"] as const) {
			test(`${subject} revocation denies ${stage} without consuming or rewriting existing history`, async ({
				fixture: f,
			}) => {
				// Arrange: controller review exists BEFORE revocation even for a new attempt.
				const i = await prepare(f, stage);
				await revoke(f, subject);
				const before = await effects(f);
				// Act
				const result = await perform(f.store, i, stage);
				const retry = await perform(f.store, i, stage);
				// Assert: store errors stay within the existing controller contract.
				expect([result, retry]).toEqual([denial, denial]);
				expect(await effects(f)).toEqual(before);
			});
		}
	}
	for (const publicKey of [
		`${CANONICAL_PUBLIC_KEY} fixture@example.invalid`,
		CANONICAL_PUBLIC_KEY.replace(/\+/g, "-").replace(/\//g, "_"),
	]) {
		test(`key revocation uses the enrolled canonical key despite comment/URL metadata ${publicKey.slice(-16)}`, async ({
			fixture: f,
		}) => {
			// Arrange: cryptographic identity is independent of fingerprint and namespace.
			f.input.publicKey = publicKey;
			f.input.fingerprint = "9".repeat(64);
			const i = await prepare(f, "consume");
			const other = { ...i.cfg, coordinatorId: `${i.cfg.coordinatorId}-other` };
			expect(
				await f.store.createAuthControllerAttestation({
					...i.controller,
					coordinatorId: other.coordinatorId,
				}),
			).toMatchObject({ kind: "created" });
			await revoke(f, "key");
			const before = await effects(f);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(
				{ ...i.final, keyId: "8".repeat(64) } as typeof i.final,
				i.cfg,
			);
			const newNamespace = await f.store.createAuthLinkAttempt(i.start, other);
			// Assert
			expect([result, newNamespace]).toEqual([denial, denial]);
			expect(await effects(f)).toEqual(before);
		});
	}
}
function registerProofs(test: Test) {
	for (const field of ["runtimeVerifierHash", "completionSecretHash"] as const) {
		test(`requires independently correct ${field} before and after revocation`, async ({
			fixture: f,
		}) => {
			// Arrange
			const i = await prepare(f, "consume");
			const wrong = { ...i.final, [field]: "f".repeat(64) };
			const before = await effects(f);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(wrong, i.cfg);
			await revoke(f, "key");
			const revoked = await f.store.finalizeAuthLinkAttempt(wrong, i.cfg);
			const valid = await f.store.finalizeAuthLinkAttempt(i.final, i.cfg);
			// Assert: wrong proof is not an authority oracle, and neither proof consumes.
			expect([result, revoked]).toEqual(
				Array(2).fill({ kind: "rejected", error: "attempt_unavailable" }),
			);
			expect(valid).toEqual(denial);
			expect(await effects(f)).toEqual(before);
		});
	}
	for (const terminal of ["expired", "cancelled"] as const) {
		test(`${terminal} attempt cannot revive through exact finalization or revocation`, async ({
			fixture: f,
		}) => {
			// Arrange
			const i = await prepare(f, "consume");
			if (terminal === "expired") f.now = NOW + TTL;
			else
				expect(
					await f.store.failAuthLinkAttempt(
						{
							attemptId: i.start.attemptId,
							requester: { kind: "device", signer: i.start.signer },
							reason: "cancelled",
						},
						i.cfg,
					),
				).toMatchObject({ kind: "applied" });
			const before = await effects(f);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(i.final, i.cfg);
			await revoke(f, "device");
			const retry = await f.store.finalizeAuthLinkAttempt(i.final, i.cfg);
			// Assert
			const expected = {
				kind: "rejected",
				error: terminal === "expired" ? "attempt_expired" : "attempt_unavailable",
			};
			expect([result, retry]).toEqual([expected, expected]);
			expect(await effects(f)).toEqual(before);
		});
	}
}
function registerHistory(test: Test) {
	test("concurrent finalization is one use; replay after R returns only a stored public receipt", async ({
		fixture: f,
	}) => {
		// Arrange
		const i = await prepare(f, "consume");
		// Act
		const results = await Promise.all([
			f.store.finalizeAuthLinkAttempt(i.final, i.cfg),
			f.store.finalizeAuthLinkAttempt(i.final, i.cfg),
		]);
		const before = await effects(f);
		await revoke(f, "device");
		const replay = await f.store.finalizeAuthLinkAttempt(i.final, i.cfg);
		const retry = await f.store.createAuthLinkAttempt(i.start, i.cfg);
		// Assert: existing link history is not active device authority or a new secret.
		expect(results.map((result) => result.kind).sort()).toEqual(["applied", "existing"]);
		expect(replay).toEqual({
			kind: "existing",
			status: { attemptId: i.start.attemptId, state: "finalized", expiresAtMs: NOW + TTL },
		});
		expect(retry).toEqual(denial);
		expect(await effects(f)).toEqual(before);
		expect(before[0]).toHaveLength(1);
		expect(before[1]).toHaveLength(1);
		expect(before[0]).toMatchObject([{ action: "link_created", attempt_id: i.start.attemptId }]);
	});
}

// Forward actual native statements and batches, never simulate affected-row receipts.
export function authLinkGuardedD1(db: D1DatabaseLike, gate: Gate, clock: () => number) {
	const originals = new WeakMap<
		D1PreparedStatementLike,
		{ statement: D1PreparedStatementLike; query: string }
	>();
	const wrap = (statement: D1PreparedStatementLike, query: string): D1PreparedStatementLike => {
		const wrapped: D1PreparedStatementLike = {
			bind: (...values) => wrap(statement.bind(...values), query),
			first: async <T>() => {
				await gate(query, "read");
				const result = await statement.first<T>();
				await gate(query, "captured");
				return result;
			},
			all: async <T>() => statement.all<T>(),
			raw: async <T>() => statement.raw<T>(),
			run: async () => {
				await gate(query, "write");
				return statement.run();
			},
		};
		originals.set(wrapped, { statement, query });
		return wrapped;
	};
	return new D1CoordinatorStore(
		{
			prepare: (query) => wrap(db.prepare(query), query),
			batch: async (statements) => {
				const actual = statements.map((statement) => {
					const original = originals.get(statement);
					if (!original) throw new Error("Unknown auth-link fixture statement");
					return original;
				});
				for (const statement of actual) await gate(statement.query, "write");
				if (!db.batch) throw new Error("Auth-link fixture requires atomic batch");
				return db.batch(actual.map((entry) => entry.statement));
			},
		},
		{ authClock: clock },
	);
}
export function registerAuthLinkAtomicGuards(test: Test, guarded: Guarded) {
	for (const stage of ["insert", "retry", "consume"] as const) {
		for (const subject of ["device", "key"] as const) {
			test(`${subject} R immediately before actual ${stage} SQL closes the unchecked-write window`, async ({
				fixture: f,
			}) => {
				// Arrange
				const i = await prepare(f, stage);
				const before = await effects(f);
				let injected = false;
				const racing = guarded(f, async (query) => {
					if (injected || !isGate(query, stage)) return;
					injected = true;
					await revoke(f, subject);
				});
				// Act
				const result = await perform(racing, i, stage);
				// Assert: a real consuming/INSERT/retry SQL guard, not only an active precheck.
				expect(injected).toBe(true);
				expect(result).toEqual(denial);
				expect(await effects(f)).toEqual(before);
			});
		}
	}
	registerDrift(test, guarded);
	registerCapture(test, guarded);
	registerRollback(test);
	registerUnknownReceipt(test, guarded);
}
function registerUnknownReceipt(test: Test, guarded: Guarded) {
	test("receipt read failure reports fixed uncertainty, not a false rollback claim", async ({
		fixture: f,
	}) => {
		// Arrange: the consuming transaction succeeds before its receipt read fails.
		const i = await prepare(f, "consume");
		let injected = false;
		const racing = guarded(f, async (query, boundary) => {
			if (
				injected ||
				boundary !== "read" ||
				!query.startsWith("SELECT 1 FROM coordinator_auth_link_attempts t")
			)
				return;
			injected = true;
			throw new Error("fixture receipt read unavailable");
		});
		// Act
		await expect(racing.finalizeAuthLinkAttempt(i.final, i.cfg)).rejects.toThrow(
			"auth_link_persistence_error",
		);
		const replay = await f.store.finalizeAuthLinkAttempt(i.final, i.cfg);
		// Assert: an unknown response does not undo the committed operation marker.
		expect(injected).toBe(true);
		expect(replay.kind).toBe("existing");
		expect(await f.rows(linkRevocationTables[0])).toHaveLength(1);
		expect(await f.rows(linkRevocationTables[1])).toHaveLength(1);
		expect(await f.rows(linkRevocationTables[2])).toMatchObject([{ state: "finalized" }]);
	});
}
function registerDrift(test: Test, guarded: Guarded) {
	const changes = {
		key: ["UPDATE enrolled_devices SET public_key = ? WHERE group_id = ?", UNRELATED_PUBLIC_KEY],
		fingerprint: ["UPDATE enrolled_devices SET fingerprint = ? WHERE group_id = ?", "8".repeat(64)],
		Identity: ["UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ?", "identity-other"],
		sameIdentity: ["UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ?", "identity-a"],
		disabled: ["UPDATE enrolled_devices SET enabled = ? WHERE group_id = ?", 0],
		archive: ["UPDATE groups SET archived_at = ? WHERE group_id = ?", "2026-10-06"],
		receipt: [
			"UPDATE coordinator_auth_controller_attestations SET review_receipt_id = ? WHERE group_id = ?",
			"receipt-other",
		],
	} as const;
	for (const stage of ["insert", "retry", "consume"] as const) {
		for (const [change, [sql, value]] of Object.entries(changes)) {
			test(`pins ${change} between source capture/hash and atomic ${stage}`, async ({
				fixture: f,
			}) => {
				// Arrange
				const i = await prepare(f, stage);
				let injected = false;
				const racing = guarded(f, async (query) => {
					if (injected || !isGate(query, stage)) return;
					injected = true;
					if (change === "key") await revoke(f, "key");
					await f.exec(sql, value, f.input.groupId);
				});
				// Act
				const result = await perform(racing, i, stage);
				// Assert: even null-to-reviewed-Identity drift must be pinned for THIS call.
				expect(injected).toBe(true);
				expect(result).toEqual(denial);
				await assertUnconsumed(f, i, stage);
				if (change === "sameIdentity") {
					const fresh = await perform(f.store, i, stage);
					expect(fresh.kind).toBe(
						{ insert: "created", retry: "existing", consume: "applied" }[stage],
					);
				}
			});
		}
	}
}
async function assertUnconsumed(f: LinkRevocationFixture, i: Inputs, stage: Stage) {
	expect(await f.rows(linkRevocationTables[0])).toEqual([]);
	expect(await f.rows(linkRevocationTables[1])).toEqual([]);
	if (stage === "insert") expect(await f.rows(linkRevocationTables[2])).toEqual([]);
	if (stage === "consume")
		expect(await f.rows(linkRevocationTables[2])).toMatchObject([
			{
				state: "confirmed",
				link_id: null,
				completion_secret_hash: i.final.completionSecretHash,
				runtime_verifier_hash: i.final.runtimeVerifierHash,
			},
		]);
}
function registerCapture(test: Test, guarded: Guarded) {
	test("source-key revocation and clean rotation after source read cannot substitute the hash authority", async ({
		fixture: f,
	}) => {
		// Arrange: receiver ID is clean; only the captured source key is revoked.
		const i = await prepare(f, "consume");
		const before = await effects(f);
		let injected = false;
		const racing = guarded(f, async (query, boundary) => {
			if (injected || boundary !== "captured" || !query.startsWith("SELECT e.group_id")) return;
			injected = true;
			await revoke(f, "key");
			await f.exec(
				"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ?",
				UNRELATED_PUBLIC_KEY,
				f.input.groupId,
			);
		});
		// Act
		const result = await racing.finalizeAuthLinkAttempt(i.final, i.cfg);
		// Assert: source snapshot survives asynchronous hashing but no longer authorizes a write.
		expect(injected).toBe(true);
		expect(result).toEqual(denial);
		expect(await effects(f)).toEqual(before);
	});
	for (const stage of ["insert", "consume"] as const) {
		test(`captures caller signer/config/proof fields before ${stage} source hash awaits`, async ({
			fixture: f,
		}) => {
			// Arrange
			const i = await prepare(f, stage);
			let injected = false;
			const racing = guarded(f, async (query, boundary) => {
				if (injected || boundary !== "captured" || !query.startsWith("SELECT e.group_id")) return;
				injected = true;
				i.start.signer.publicKey = UNRELATED_PUBLIC_KEY;
				i.start.signer.fingerprint = "8".repeat(64);
				i.start.runtimeVerifierHash = "9".repeat(64);
				i.final.runtimeVerifierHash = "9".repeat(64);
				i.final.completionSecretHash = "9".repeat(64);
				i.cfg.enabled = false;
				i.cfg.issuer = "https://other.example.test";
			});
			// Act
			const result = await perform(racing, i, stage);
			// Assert: mutation does not replace the captured authority or either proof.
			expect(injected).toBe(true);
			expect(result.kind).toBe(stage === "insert" ? "created" : "applied");
			expect(await f.rows(linkRevocationTables[2])).toMatchObject([
				{
					public_key: CANONICAL_PUBLIC_KEY,
					fingerprint: "a".repeat(64),
					runtime_verifier_hash: "b".repeat(64),
					issuer: "https://accounts.example.test",
				},
			]);
		});
	}
}
function registerRollback(test: Test) {
	for (const table of ["coordinator_auth_account_links", "coordinator_auth_link_audit_log"]) {
		test(`${table} SQL failure rolls back consuming UPDATE and every account-link effect`, async ({
			fixture: f,
		}) => {
			// Arrange: fail the actual later statement after the consuming UPDATE ran.
			const i = await prepare(f, "consume");
			const before = await effects(f);
			const trigger = `fixture_link_failure_${table}`;
			await f.exec(
				`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture SQL failure'); END`,
			);
			// Act
			try {
				await expect(f.store.finalizeAuthLinkAttempt(i.final, i.cfg)).rejects.toThrow(
					"auth_link_persistence_error",
				);
			} finally {
				await f.exec(`DROP TRIGGER ${trigger}`);
			}
			const after = await effects(f);
			const valid = await f.store.finalizeAuthLinkAttempt(i.final, i.cfg);
			// Assert: neither proof is consumed on rollback; a subsequent valid call succeeds.
			expect(after).toEqual(before);
			expect(valid.kind).toBe("applied");
		});
	}
}
