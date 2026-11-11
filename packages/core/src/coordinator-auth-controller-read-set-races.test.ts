import { afterEach, describe, expect, vi } from "vitest";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import {
	ordinaryReview,
	retainedResolution,
} from "./coordinator-auth-controller-consistency-test-fixtures.js";
import {
	beforeGuardedTransaction,
	beforeStatements,
} from "./coordinator-auth-controller-race-test-fixtures.js";
import type { Fixture } from "./coordinator-auth-store-test-fixtures.js";
import {
	binding,
	controller,
	databaseSnapshot,
	evidenceTest,
	history,
	invitation,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";

/*
 * Each controller review site reads the reviewed snapshot first and checks it again only
 * through the guards that lead its batch. A change in between must still refuse.
 */

const INVITE = {
	inviteId: "invite-a",
	kind: "team_member" as const,
	actorId: "A",
	assignedIdentityId: "A",
	targetIdentityId: null,
	digest: "c".repeat(64),
};

/** An ordinary review whose snapshot holds one consumed, live invite and history for A. */
async function reviewWithInvite(f: Fixture): Promise<CoordinatorAuthControllerReviewInput> {
	history(f, { label: "A" });
	invitation(f, {
		invite_id: INVITE.inviteId,
		revoked_at: null,
		assigned_identity_id: "A",
		recipient_actor_id: "A",
	});
	const input = await ordinaryReview(f);
	if (!input.verifiedSnapshot) throw new Error("ordinary review snapshot missing");
	input.verifiedSnapshot.invites = [INVITE];
	return input;
}

/** The row a concurrent identical review commits first, exactly as the store writes it. */
function commitWinner(f: Fixture, input: CoordinatorAuthControllerReviewInput) {
	controller(f, {
		attestation_id: input.attestationId,
		coordinator_id: input.coordinatorId,
		identity_id: input.identityId,
		group_id: input.groupId,
		review_receipt_id: input.reviewReceiptId,
		evidence_digest: input.evidenceDigest,
		enrollment_identity_id: input.verifiedSnapshot?.enrollmentIdentityId ?? null,
	});
}

/**
 * A winner commits before this review's insert, so the review recaptures the retained
 * owner facts and retries; a binding then lands before the retry's final guarded check.
 * `nth` is that check's position among the guarded transactions.
 */
async function retryAfterPinChange(f: Fixture, nth: number) {
	retainedResolution(f);
	const input = await reviewWithInvite(f);
	let afterChange: ReturnType<typeof databaseSnapshot> | undefined;
	const hook = beforeGuardedTransaction(
		f.db,
		(position) => {
			if (position === 1) return commitWinner(f, input);
			binding(f);
			afterChange = databaseSnapshot(f);
		},
		[1, nth],
	);
	const result = await f.store.createAuthControllerAttestation(input);
	hook.restore();
	return { result, reached: hook.reached(), afterChange };
}

const setInviteRevoked = (f: Fixture, revoked: string | null) =>
	f.db
		.prepare("UPDATE coordinator_invites SET revoked_at = ? WHERE invite_id = ?")
		.run(revoked, INVITE.inviteId);

// The statements each D1 site sends after its guards: the insert, the retry's eligibility
// read, and its final read of the current attestation, pinned to the reviewed snapshot.
const INSERT = /^\s*INSERT INTO coordinator_auth_controller_attestations\s*\(/u;
const ELIGIBLE = /^\s*SELECT 1 AS eligible FROM enrolled_devices e\b/u;
const CONFLICT_READ =
	/^\s*SELECT \* FROM coordinator_auth_controller_attestations\s+WHERE coordinator_id = \?/u;
const FINAL_READ =
	/^\s*SELECT a\.\* FROM coordinator_auth_controller_attestations a\b[\s\S]*AND e\.identity_id IS \?(?: AND e\.device_id = \? AND e\.public_key = \? AND e\.fingerprint = \?)?$/u;

afterEach(() => vi.restoreAllMocks());

describe("D1: controller review guards at each site", () => {
	const test = evidenceTest("D1");
	// Changes only the controller review's own reads see: the reviewed invite's digest and
	// the reviewed history's metadata. Retained-owner evidence reads neither.
	const snapshotChanges = {
		"invite digest changed": (f: Fixture) =>
			f.db
				.prepare("UPDATE coordinator_invites SET reviewed_preview_digest = ? WHERE invite_id = ?")
				.run("d".repeat(64), INVITE.inviteId),
		"history metadata changed": (f: Fixture) =>
			f.db
				.prepare("UPDATE coordinator_legacy_team_completions SET created_at = ?")
				.run("2026-10-02T00:00:00.000Z"),
	};
	test.for(Object.keys(snapshotChanges) as (keyof typeof snapshotChanges)[])(
		"create batch refuses when %s after its reads",
		async (change, { f }) => {
			// Arrange
			const input = await reviewWithInvite(f);
			let afterChange: ReturnType<typeof databaseSnapshot> | undefined;
			const hook = beforeStatements(f.db, [
				{
					pattern: INSERT,
					mutate: () => {
						snapshotChanges[change](f);
						afterChange = databaseSnapshot(f);
					},
				},
			]);
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			hook.restore();
			// Assert: the guarded insert wrote nothing; only the injected change remains.
			expect(hook.reached()).toBe(1);
			expect(result).toEqual({ kind: "rejected", error: "review_stale" });
			expect(databaseSnapshot(f)).toEqual(afterChange);
		},
	);

	test("create batch refuses a retained owner fact added after its reads", async ({ f }) => {
		// Arrange: the negative owner guards lead the same batch as the controller's own.
		retainedResolution(f);
		const input = await reviewWithInvite(f);
		let afterChange: ReturnType<typeof databaseSnapshot> | undefined;
		const hook = beforeGuardedTransaction(f.db, () => {
			binding(f);
			afterChange = databaseSnapshot(f);
		});
		// Act
		const result = await f.store.createAuthControllerAttestation(input);
		hook.restore();
		// Assert
		expect(hook.observed()).toBe(true);
		expect(result).toMatchObject({ kind: "rejected" });
		expect(databaseSnapshot(f)).toEqual(afterChange);
	});

	test("retry after a pin change refuses a retained owner fact added before its final read", async ({
		f,
	}) => {
		// Arrange, Act: the insert batch is first, eligibility second, the final read third.
		const { result, reached, afterChange } = await retryAfterPinChange(f, 3);
		// Assert
		expect(reached).toEqual([1, 3]);
		expect(result).toEqual({ kind: "rejected", error: "review_stale" });
		expect(databaseSnapshot(f)).toEqual(afterChange);
	});

	test("retry eligibility read refuses an invite revoked only while it runs", async ({ f }) => {
		// Arrange: create, then revoke just before the eligibility batch and restore the
		// invite before the final batch, so only the eligibility guards can see it.
		const input = await reviewWithInvite(f);
		const created = await f.store.createAuthControllerAttestation(input);
		expect(created.kind).toBe("created");
		const before = databaseSnapshot(f);
		const hook = beforeStatements(f.db, [
			{ pattern: ELIGIBLE, mutate: () => setInviteRevoked(f, "2026-10-05T00:00:00.000Z") },
			// The conflict read runs between the two batches, outside both.
			{ pattern: CONFLICT_READ, mutate: () => setInviteRevoked(f, null) },
		]);
		// Act
		const result = await f.store.createAuthControllerAttestation(input);
		hook.restore();
		// Assert: the refused eligibility batch ends the retry before its final read.
		expect(hook.reached()).toBe(1);
		expect(result).toEqual({ kind: "rejected", error: "review_stale" });
		expect(databaseSnapshot(f).filter(([name]) => name !== "coordinator_invites")).toEqual(
			before.filter(([name]) => name !== "coordinator_invites"),
		);
	});

	test.for(Object.keys(snapshotChanges) as (keyof typeof snapshotChanges)[])(
		"retry's final read refuses when %s after eligibility",
		async (change, { f }) => {
			// Arrange
			const input = await reviewWithInvite(f);
			expect((await f.store.createAuthControllerAttestation(input)).kind).toBe("created");
			let afterChange: ReturnType<typeof databaseSnapshot> | undefined;
			const hook = beforeStatements(f.db, [
				{
					pattern: FINAL_READ,
					mutate: () => {
						snapshotChanges[change](f);
						afterChange = databaseSnapshot(f);
					},
				},
			]);
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			hook.restore();
			// Assert: a change after the conflict read makes the review stale.
			expect(hook.reached()).toBe(1);
			expect(result).toEqual({ kind: "rejected", error: "review_stale" });
			expect(databaseSnapshot(f)).toEqual(afterChange);
		},
	);
});

describe("SQLite: controller review guards at its write transaction", () => {
	const test = evidenceTest("SQLite");

	test("retry after a pin change refuses a retained owner fact added after its recapture", async ({
		f,
	}) => {
		// Arrange, Act: the create transaction is first; the retry transaction second.
		const { result, reached, afterChange } = await retryAfterPinChange(f, 2);
		// Assert
		expect(reached).toEqual([1, 2]);
		expect(result).toEqual({ kind: "rejected", error: "review_stale" });
		expect(databaseSnapshot(f)).toEqual(afterChange);
	});

	test("create transaction refuses a retained owner fact added after its async reads", async ({
		f,
	}) => {
		// Arrange: the negative owner reads run before the transaction; their guards lead it.
		retainedResolution(f);
		const input = await reviewWithInvite(f);
		let afterChange: ReturnType<typeof databaseSnapshot> | undefined;
		const hook = beforeGuardedTransaction(f.db, () => {
			binding(f);
			afterChange = databaseSnapshot(f);
		});
		// Act
		const result = await f.store.createAuthControllerAttestation(input);
		hook.restore();
		// Assert
		expect(hook.observed()).toBe(true);
		expect(result).toMatchObject({ kind: "rejected" });
		expect(databaseSnapshot(f)).toEqual(afterChange);
	});

	test("create transaction decides the reviewed invites inside the transaction", async ({ f }) => {
		// Arrange: a change committed just before the write transaction starts.
		const input = await reviewWithInvite(f);
		const hook = beforeGuardedTransaction(f.db, () =>
			setInviteRevoked(f, "2026-10-05T00:00:00.000Z"),
		);
		// Act
		const result = await f.store.createAuthControllerAttestation(input);
		hook.restore();
		// Assert
		expect(hook.observed()).toBe(true);
		expect(result).toEqual({ kind: "rejected", error: "review_stale" });
		expect(
			f.db.prepare("SELECT COUNT(*) AS n FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ n: 0 });
	});
});
