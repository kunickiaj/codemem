import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import {
	ordinaryReview,
	retainedResolution,
} from "./coordinator-auth-controller-consistency-test-fixtures.js";
import type { Fixture } from "./coordinator-auth-store-test-fixtures.js";
import {
	binding,
	databaseSnapshot,
	evidenceTest,
	history,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import * as negativeConsistency from "./coordinator-owner-negative-consistency.js";

/** SQLite INSERTs are synchronous; hold the last real async capture before its transaction. */
async function overlappingReview(
	f: Fixture,
	input: CoordinatorAuthControllerReviewInput,
	earlierReview: CoordinatorAuthControllerReviewInput,
) {
	const captured = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const prepareConsistency = negativeConsistency.prepareNegativeOwnerConsistency;
	let held = false;
	const captureHook = vi
		.spyOn(negativeConsistency, "prepareNegativeOwnerConsistency")
		.mockImplementation(async (...args) => {
			const pause = !held;
			held = true;
			const result = await prepareConsistency(...args);
			if (pause) {
				captured.resolve();
				await resume.promise;
			}
			return result;
		});
	const prepare = f.db.prepare.bind(f.db);
	const writes: number[] = [];
	const writeHook = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (
			/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+coordinator_auth_controller_attestations\b/iu.test(sql)
		) {
			const run = statement.run.bind(statement);
			statement.run = (...values) => {
				const result = run(...values);
				writes.push(Number(result.changes));
				return result;
			};
		}
		return statement;
	});
	try {
		// The first invocation has missed its conflict read and captured real evidence.
		const loser = f.store.createAuthControllerAttestation(earlierReview);
		const capturedBeforeWrite = await Promise.race([
			captured.promise.then(() => true),
			loser.then(() => false),
		]);
		if (!capturedBeforeWrite) captureHook.mockRestore();
		const winner = await f.store.createAuthControllerAttestation(input);
		const afterWinner = databaseSnapshot(f);
		resume.resolve();
		return { winner, loser: await loser, afterWinner, writes, capturedBeforeWrite };
	} finally {
		resume.resolve();
		captureHook.mockRestore();
		writeHook.mockRestore();
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	describe(`${backend}: concurrent controller retry`, () => {
		test("returns created and exact existing with one new attestation", async ({ f }) => {
			// Arrange: both calls miss the conflict read and capture evidence before either INSERT.
			retainedResolution(f);
			const input = await ordinaryReview(f);
			// Act: complete the later invocation before resuming the earlier one.
			const { winner, loser, afterWinner, writes } = await overlappingReview(f, input, input);
			// Assert: pin changes still allow an exact retry without another row or mutation.
			expect(winner.kind).toBe("created");
			expect(loser).toEqual({
				kind: "existing",
				attestation: winner.kind === "created" ? winner.attestation : null,
			});
			expect(writes).toEqual([1, 0]);
			expect(databaseSnapshot(f)).toEqual(afterWinner);
			expect(
				f.db
					.prepare(
						"SELECT COUNT(*) AS count FROM coordinator_auth_controller_attestations WHERE attestation_id = ?",
					)
					.get(input.attestationId),
			).toEqual({ count: 1 });
		});

		test.for(["receipt", "digest", "snapshot"] as const)(
			"does not replay a concurrent wrong %s review",
			async (change, { f }) => {
				// Arrange: receipt/digest differences are authorized originals, but not exact retries.
				retainedResolution(f);
				const input = await ordinaryReview(f);
				const wrong = { ...input };
				if (change === "receipt") wrong.reviewReceiptId = "wrong-receipt";
				if (change === "digest") wrong.evidenceDigest = "c".repeat(64);
				if (change === "snapshot")
					wrong.verifiedSnapshot = {
						...input.verifiedSnapshot,
						enrollmentIdentityId: "wrong",
						invites: [],
					};
				// Act: the later-started valid request commits before the earlier request resumes.
				const { winner, loser, afterWinner, writes, capturedBeforeWrite } = await overlappingReview(
					f,
					input,
					wrong,
				);
				// Assert: the losing request neither replays nor mutates the winning receipt.
				expect(winner.kind).toBe("created");
				expect(loser.kind).toBe("rejected");
				// Invalid snapshots may fail preflight; receipt/digest controls must overlap at INSERT.
				if (change === "snapshot" && !capturedBeforeWrite) expect(writes).toEqual([1]);
				else expect(writes).toEqual([1, 0]);
				expect(databaseSnapshot(f)).toEqual(afterWinner);
				expect(
					f.db
						.prepare(
							"SELECT review_receipt_id, evidence_digest FROM coordinator_auth_controller_attestations WHERE attestation_id = ?",
						)
						.all(input.attestationId),
				).toEqual([
					{ review_receipt_id: input.reviewReceiptId, evidence_digest: input.evidenceDigest },
				]);
			},
		);

		test.for(["binding", "history", "revocation"] as const)(
			"denies exact replay after late %s",
			async (change, { f }) => {
				retainedResolution(f);
				const input = await ordinaryReview(f);
				const prepare = f.db.prepare.bind(f.db);
				const changes = {
					binding: () => binding(f),
					history: () => history(f),
					revocation: () =>
						f.db.exec(
							"UPDATE coordinator_auth_controller_attestations SET revoked_at='2026-10-23T00:00:00.000Z' WHERE attestation_id='ordinary-controller'",
						),
				};
				let writes = 0;
				const hook = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
					if (
						/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+coordinator_auth_controller_attestations\b/iu.test(
							sql,
						)
					) {
						writes += 1;
						if (writes === 2) changes[change]();
					}
					return prepare(sql);
				});
				const results = await Promise.all([
					f.store.createAuthControllerAttestation(input),
					f.store.createAuthControllerAttestation(input),
				]);
				hook.mockRestore();
				expect(writes).toBe(2);
				expect(results.filter((result) => result.kind === "rejected")).toHaveLength(1);
				expect(results.some((result) => result.kind === "existing")).toBe(false);
			},
		);
	});
}
