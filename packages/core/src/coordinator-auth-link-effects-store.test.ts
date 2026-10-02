import { describe, expect } from "vitest";
import {
	advance,
	attempt,
	authorize,
	backendTest,
	cfg,
	completionHash,
	expectRejected,
	finalize,
	type LinkFixture,
	NOW,
	rows,
	signer,
	snapshot,
	status,
	TABLES,
	type Test,
} from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, enroll, review, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

async function secondConfirmed(
	f: LinkFixture,
	options: { otherIdentity?: boolean; otherSubject?: boolean } = {},
) {
	let secondSigner = signer;
	if (options.otherIdentity) {
		const reviewed = review({
			identityId: "identity-b",
			deviceId: "device-b",
			attestationId: "attestation-b",
			reviewReceiptId: "receipt-b",
			fingerprint: "f".repeat(64),
		});
		await enroll(f.store, reviewed);
		await f.store.createAuthControllerAttestation(reviewed);
		secondSigner = { ...signer, deviceId: reviewed.deviceId, fingerprint: reviewed.fingerprint };
	}
	const input = attempt({
		attemptId: "attempt-b",
		runtimeVerifierHash: "1".repeat(64),
		signer: secondSigner,
	});
	const hash = "2".repeat(64);
	await f.store.createAuthLinkAttempt(input, f.cfg);
	await f.store.claimAuthLinkAttempt(
		{ attemptId: input.attemptId, browserTransactionHash: hash },
		f.cfg,
	);
	await f.store.recordAuthLinkOidcVerified(
		{
			attemptId: input.attemptId,
			browserTransactionHash: hash,
			account: {
				issuer: cfg.issuer,
				subject: options.otherSubject ? "opaque-subject-b" : "opaque-subject-a",
			},
		},
		f.cfg,
	);
	await f.store.confirmAuthLinkAttempt(
		{
			attemptId: input.attemptId,
			browserTransactionHash: hash,
			completionSecretHash: "3".repeat(64),
		},
		f.cfg,
	);
	return finalize({
		attemptId: input.attemptId,
		runtimeVerifierHash: input.runtimeVerifierHash,
		completionSecretHash: "3".repeat(64),
		signer: secondSigner,
		deviceId: secondSigner.deviceId,
		fingerprint: secondSigner.fingerprint,
		identityId: options.otherIdentity ? "identity-b" : "identity-a",
	});
}

function registerUniqueTests(test: Test) {
	test.for(["account", "identity", "both"])(
		"competing attempts enforce full %s uniqueness",
		async (scope, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			const second = await secondConfirmed(f, {
				otherIdentity: scope === "account",
				otherSubject: scope === "identity",
			});
			// Act
			const results = await Promise.all([
				f.store.finalizeAuthLinkAttempt(finalize(), f.cfg),
				f.store.finalizeAuthLinkAttempt(second, f.cfg),
			]);
			// Assert
			expect(results.filter((result) => result.kind === "applied")).toHaveLength(1);
			expect(results.filter((result) => result.kind === "rejected")).toEqual([
				{ kind: "rejected", error: "link_conflict" },
			]);
			expect(rows(f, TABLES[1])).toHaveLength(1);
			expect(rows(f, TABLES[2])).toHaveLength(1);
			expect(
				rows(f, TABLES[0])
					.map((row) => row.state)
					.sort(),
			).toEqual(["confirmed", "finalized"]);
		},
	);
	test.for(["account", "identity"])(
		"revoked %s tombstone still blocks a fresh attempt",
		async (scope, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "finalized");
			f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(NOW);
			const second = await secondConfirmed(f, {
				otherIdentity: scope === "account",
				otherSubject: scope === "identity",
			});
			const before = snapshot(f);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(second, f.cfg);
			// Assert
			expectRejected(result, "link_conflict");
			expect(snapshot(f)).toEqual(before);
		},
	);
	test("another attempt's completion commitment cannot overwrite verified state", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		await advance(
			f,
			"oidc_verified",
			attempt({ attemptId: "attempt-b", runtimeVerifierHash: "1".repeat(64) }),
			"2".repeat(64),
		);
		const before = snapshot(f);
		// Act
		const result = await f.store.confirmAuthLinkAttempt(
			{
				attemptId: "attempt-b",
				browserTransactionHash: "2".repeat(64),
				completionSecretHash: completionHash,
			},
			f.cfg,
		);
		// Assert
		expectRejected(result, "attempt_conflict");
		expect(snapshot(f)).toEqual(before);
	});
}

function registerRollbackTests(test: Test) {
	test("winning consume token binds link and audit even when SQL changes() reports zero", async ({
		fixture: f,
	}) => {
		// Arrange: SQL changes() is unreliable across D1 batch statements; native run metadata is not.
		await authorize(f);
		await advance(f, "confirmed");
		f.db.function("changes", () => 0);
		expect(f.db.prepare("SELECT changes() AS count").get()).toEqual({ count: 0 });
		// Act
		const applied = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		const committed = snapshot(f);
		const retry = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		// Assert: never persist consumption without its link and redacted audit.
		expect(applied).toEqual({ kind: "applied", status: status("finalized") });
		expect(rows(f, TABLES[0])[0].state).toBe("finalized");
		expect(rows(f, TABLES[1])).toHaveLength(1);
		expect(rows(f, TABLES[2])).toHaveLength(1);
		expect(retry).toEqual({ kind: "existing", status: status("finalized") });
		expect(snapshot(f)).toEqual(committed);
		expect(f.db.prepare("SELECT changes() AS count").get()).toEqual({ count: 0 });
	});
	test.for([TABLES[1], TABLES[2]])(
		"rolls back winning consume when INSERT into %s aborts",
		async (table, { fixture: f }) => {
			// Arrange: a bound fixture marker limits failure to this coordinator's INSERT.
			await authorize(f);
			await advance(f, "confirmed");
			const before = snapshot(f);
			f.db.exec(`CREATE TEMP TRIGGER fail_link_write BEFORE INSERT ON ${table}
			WHEN NEW.coordinator_id = 'coordinator-a'
			BEGIN SELECT RAISE(ABORT, 'test_link_write_failure'); END`);
			// Act
			const result = f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
			// Assert: infrastructure errors are not uniqueness/domain conflicts.
			await expect(result).rejects.toThrow("auth_link_persistence_error");
			expect(snapshot(f)).toEqual(before);
			f.db.exec("DROP TRIGGER fail_link_write");
			expect(await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg)).toEqual({
				kind: "applied",
				status: status("finalized"),
			});
		},
	);
	test.for([TABLES[1], TABLES[2]])(
		"missing %s read-back is never an existing success",
		async (table, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "finalized");
			f.db.exec(`DELETE FROM ${table}`);
			const before = snapshot(f);
			// Act
			const retry = f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
			// Assert
			await expect(retry).rejects.toThrow("auth_link_persistence_incomplete");
			expect(snapshot(f)).toEqual(before);
		},
	);
}

function registerD1Tests(test: Test) {
	test("SQLite-backed D1 retries recover an effect after a targeted post-commit read failure", async ({
		fixture: f,
	}) => {
		// Arrange: target link read-back and this fixture's bound namespace, not every query.
		await authorize(f);
		await advance(f, "confirmed");
		let injected = false;
		const db = sqliteD1(f.db, {
			beforeRead(query, values) {
				if (injected || !query.includes(TABLES[1]) || !values.includes(cfg.coordinatorId)) return;
				if (rows(f, TABLES[0])[0].state !== "finalized") return;
				injected = true;
				throw new Error("test_auth_link_read_failure");
			},
		});
		const faulting = new D1CoordinatorStore(db, { authClock: () => f.now });
		// Act
		const first = faulting.finalizeAuthLinkAttempt(finalize(), f.cfg);
		// Assert: the failed response does not undo the already committed batch.
		await expect(first).rejects.toThrow("auth_link_persistence_error");
		expect(injected).toBe(true);
		expect(rows(f, TABLES[1])).toHaveLength(1);
		expect(rows(f, TABLES[2])).toHaveLength(1);
		expect(await faulting.finalizeAuthLinkAttempt(finalize(), f.cfg)).toEqual({
			kind: "existing",
			status: status("finalized"),
		});
	});
	test.for(["key", "disabled", "archive"] as const)(
		"SQLite-backed D1 write guard rejects %s changed after preparation",
		async (change, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			const before = snapshot(f);
			const mutate = {
				key: "UPDATE enrolled_devices SET public_key = 'replacement-key'",
				disabled: "UPDATE enrolled_devices SET enabled = 0",
				archive: "UPDATE groups SET archived_at = '2026-10-02T00:00:00Z'",
			};
			let injected = false;
			const racing = new D1CoordinatorStore(
				sqliteD1(f.db, {
					beforeBatch(statements) {
						if (injected) return;
						if (
							!statements.some(
								({ query, values }) =>
									query.includes("UPDATE coordinator_auth_link_attempts") &&
									values.includes("attempt-a") &&
									values.includes(cfg.coordinatorId),
							)
						)
							return;
						injected = true;
						f.db.exec(mutate[change]);
					},
				}),
				{ authClock: () => f.now },
			);
			// Act
			const result = await racing.finalizeAuthLinkAttempt(finalize(), f.cfg);
			// Assert
			expect(injected).toBe(true);
			expectRejected(result, "controller_not_active");
			expect(snapshot(f)).toEqual(before);
		},
	);
}

function registerProofBindingTest(test: Test) {
	test("proofs from another confirmed attempt cannot finalize the target", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		const second = await secondConfirmed(f);
		const before = snapshot(f);
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(
			{
				...second,
				runtimeVerifierHash: finalize().runtimeVerifierHash,
				completionSecretHash: finalize().completionSecretHash,
			},
			f.cfg,
		);
		// Assert
		expectRejected(result, "attempt_unavailable");
		expect(snapshot(f)).toEqual(before);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerUniqueTests(test);
	registerRollbackTests(test);
	registerProofBindingTest(test);
	if (backend === "D1") registerD1Tests(test);
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-link atomic effects parity (D1 is SQLite-backed)",
	registerBackend,
);
