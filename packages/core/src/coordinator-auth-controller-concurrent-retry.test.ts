import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
	ordinaryReview,
	retainedResolution,
} from "./coordinator-auth-controller-consistency-test-fixtures.js";
import {
	binding,
	evidenceTest,
	history,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";

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
			// Both calls miss the initial conflict read before awaiting consistency capture.
			retainedResolution(f);
			const input = await ordinaryReview(f);
			const results = await Promise.all([
				f.store.createAuthControllerAttestation(input),
				f.store.createAuthControllerAttestation(input),
			]);
			expect(results.map((result) => result.kind).sort()).toEqual(["created", "existing"]);
			const created = results.find((result) => result.kind === "created");
			expect(results.find((result) => result.kind === "existing")).toEqual({
				kind: "existing",
				attestation: created?.attestation,
			});
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
				const [created, denied] = await Promise.all([
					f.store.createAuthControllerAttestation(input),
					f.store.createAuthControllerAttestation(wrong),
				]);
				expect(created.kind).toBe("created");
				expect(denied.kind).toBe("rejected");
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
