import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	binding,
	cfg,
	claim,
	collectInput,
	controller,
	databaseSnapshot,
	evidenceBackend,
	evidenceTest,
	history,
	invitation,
	otherKey,
	signer,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	describe(`${backend}: atomic read-only recheck of relevant evidence`, () => {
		test("unchanged empty source sets match without writes", async ({ f }) => {
			// Arrange
			const db = evidenceBackend(f, backend);
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			const captured = await reader.collect(await collectInput(f));
			if (captured.kind !== "collected") throw new Error("collection fixture rejected");
			const before = databaseSnapshot(f);
			// Act
			const statement = await reader.prepareAtomicRecheck(captured.recheckSnapshot);
			const result = await db.first(statement);
			// Assert: SELECT matches is an equality predicate, not an authorization decision.
			expect(result).toEqual({ matches: 1 });
			expect(databaseSnapshot(f)).toEqual(before);
		});

		test.for([
			"controller",
			"binding",
			"claim",
			"invite",
			"history",
			"enrollment",
			"schema",
		] as const)("new relevant %s invalidates even previously empty sets", async (change, { f }) => {
			// Arrange
			const db = evidenceBackend(f, backend);
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			const captured = await reader.collect(await collectInput(f));
			if (captured.kind !== "collected") throw new Error("collection fixture rejected");
			const statement = await reader.prepareAtomicRecheck(captured.recheckSnapshot);
			const changes = {
				controller: () => controller(f),
				binding: () => binding(f),
				claim: () => claim(f),
				invite: () => invitation(f),
				history: () => history(f),
				enrollment: () => f.db.prepare("UPDATE enrolled_devices SET identity_id='C'").run(),
				schema: () =>
					f.db.exec(
						"CREATE TRIGGER unexpected_resolution_trigger AFTER INSERT ON coordinator_legacy_owner_resolutions BEGIN SELECT 1; END",
					),
			};
			changes[change]();
			// Act: mutate AFTER preparing, so JS preflight is not enough.
			const result = await db.first(statement);
			// Assert
			expect(result).toEqual({ matches: 0 });
		});

		test.for(["deletion", "receipt", "revoked", "history", "invite"])(
			"relevant %s change invalidates retained source snapshot",
			async (change, { f }) => {
				// Arrange
				controller(f);
				history(f);
				invitation(f, { assigned_identity_id: "A", recipient_actor_id: "A" });
				const db = evidenceBackend(f, backend);
				const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
				const captured = await reader.collect(await collectInput(f));
				if (captured.kind !== "collected") throw new Error("collection fixture rejected");
				const statement = await reader.prepareAtomicRecheck(captured.recheckSnapshot);
				if (change === "deletion")
					f.db.prepare("DELETE FROM coordinator_auth_controller_attestations").run();
				if (change === "receipt")
					f.db
						.prepare(
							"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed'",
						)
						.run();
				if (change === "revoked")
					f.db
						.prepare(
							"UPDATE coordinator_auth_controller_attestations SET revoked_at='2026-10-02T00:00:00.000Z'",
						)
						.run();
				if (change === "history")
					f.db
						.prepare(
							"UPDATE coordinator_legacy_team_completions SET created_at='2026-10-02T00:00:00.000Z'",
						)
						.run();
				if (change === "invite") f.db.prepare("DELETE FROM coordinator_invites").run();
				// Act
				const result = await db.first(statement);
				// Assert
				expect(result).toEqual({ matches: 0 });
			},
		);
	});

	test("same-ID foreign controller churn cannot invalidate the local snapshot", async ({ f }) => {
		// Arrange: both valid rows share an ID and key, not a coordinator namespace.
		controller(f);
		controller(f, { coordinator_id: "coordinator-b", identity_id: "B" });
		const db = evidenceBackend(f, backend);
		const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
		const captured = await reader.collect(await collectInput(f));
		if (captured.kind !== "collected") throw new Error("collection fixture rejected");
		const statement = await reader.prepareAtomicRecheck(captured.recheckSnapshot);
		f.db
			.prepare(
				"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='foreign-changed' WHERE coordinator_id=? AND attestation_id=?",
			)
			.run("coordinator-b", "controller-a");
		const before = databaseSnapshot(f);
		// Act: mutate after preparation to exercise the atomic SQL, not JS preflight.
		const result = await db.first(statement);
		const fresh = await reader.collect(await collectInput(f));
		// Assert: only current-coordinator controller changes belong in this snapshot.
		expect(result).toEqual({ matches: 1 });
		expect(fresh).toMatchObject({
			kind: "collected",
			decision: "compatible",
			recheckSnapshot: captured.recheckSnapshot,
		});
		expect(databaseSnapshot(f)).toEqual(before);
	});

	describe(`${backend}: unrelated evidence churn`, () => {
		test("unrelated people's normal churn neither invalidates nor changes relevant snapshot", async ({
			f,
		}) => {
			// Arrange
			const db = evidenceBackend(f, backend);
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			const input = await collectInput(f);
			const captured = await reader.collect(input);
			if (captured.kind !== "collected") throw new Error("collection fixture rejected");
			const statement = await reader.prepareAtomicRecheck(captured.recheckSnapshot);
			controller(f, { identity_id: "B", device_id: "unrelated", public_key: otherKey });
			invitation(f, { bound_device_id: "unrelated", bound_public_key: otherKey });
			await f.store.enrollDevice(signer.groupId, {
				deviceId: "unrelated",
				publicKey: otherKey,
				fingerprint: "f".repeat(64),
			});
			// Act
			const result = await db.first(statement);
			const fresh = await reader.collect(await collectInput(f));
			// Assert: never hash a global inventory into an exact-subject decision.
			expect(result).toEqual({ matches: 1 });
			expect(fresh).toMatchObject({ kind: "collected", recheckSnapshot: captured.recheckSnapshot });
		});
	});
}
