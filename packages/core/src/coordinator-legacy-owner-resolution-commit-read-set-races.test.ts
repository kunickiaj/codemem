// The owner resolution commit reads the reviewed snapshot and owner target as a controller
// review read set, decides, and writes in one batch its guards lead. An owner target change
// made after those reads must abort that batch; one made before them must refuse with no
// batch at all. Only the controller review's reads see the account link: the ownership
// evidence does not read it.
import { afterEach, beforeEach, expect, vi } from "vitest";
import { authControllerAuthorityValues } from "./coordinator-auth-controller.js";
import { controllerEligibleStatement } from "./coordinator-auth-controller-read-set.js";
import { backendTest, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
	now,
	originalController,
	seed,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

const OWNER_TARGET_CHANGES = [
	["link revocation", `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW + 1}`],
	["link generation", "UPDATE coordinator_auth_account_links SET created_at_ms=created_at_ms+1"],
	["link disconnect", "DELETE FROM coordinator_auth_account_links"],
	[
		"link issuer",
		"UPDATE coordinator_auth_account_links SET issuer='https://changed.example.test'",
	],
] as const;

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	for (const [label, change] of OWNER_TARGET_CHANGES) {
		test(`${kind}: a ${label} after the review's reads aborts the guarded batch`, async ({
			fixture: f,
		}) => {
			// Arrange: the change lands after every read, just before the one write batch.
			const h = backendFor(f, kind);
			await seed(f, h);
			const review = await buildReview(f);
			let injected: ReturnType<typeof snapshot> | undefined;
			h.hooks.beforeBatch = () => {
				f.db.exec(change);
				injected = snapshot(f);
			};
			h.resetBatchCount();
			// Act
			const commit = commitReviewedOwnerResolution({
				backend: h.backend,
				evidence: h.evidence,
				review,
				now,
			});
			// Assert: the batch ran and wrote nothing; only the injected change remains.
			await expect(commit).rejects.toThrow(/outcome is unavailable/u);
			expect(h.batchCount()).toBe(1);
			expect(injected).toBeDefined();
			expect(snapshot(f)).toEqual(injected);
		});

		test(`${kind}: a ${label} before the review's reads refuses without a batch`, async ({
			fixture: f,
		}) => {
			// Arrange: the reviewed owner target no longer matches when the commit reads it.
			const h = backendFor(f, kind);
			await seed(f, h);
			const review = await buildReview(f);
			f.db.exec(change);
			const before = snapshot(f);
			h.resetBatchCount();
			// Act
			const commit = commitReviewedOwnerResolution({
				backend: h.backend,
				evidence: h.evidence,
				review,
				now,
			});
			// Assert
			await expect(commit).rejects.toThrow(/outcome is unavailable/u);
			expect(h.batchCount()).toBe(0);
			expect(snapshot(f)).toEqual(before);
		});
	}
	test(`${kind}: reusing a controller, a disabled enrollment after the reads aborts the batch`, async ({
		fixture: f,
	}) => {
		// Arrange: reuse writes no controller, so only the guards and the eligibility
		// assertion in the batch can see the enrollment change.
		const h = backendFor(f, kind);
		await seed(f, h);
		const original = await originalController(f);
		const review = await buildReview(f, { existingController: original });
		let injected: ReturnType<typeof snapshot> | undefined;
		h.hooks.beforeBatch = () => {
			f.db.exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id='current-laptop'");
			injected = snapshot(f);
		};
		// Act
		const commit = commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert
		await expect(commit).rejects.toThrow(/outcome is unavailable/u);
		expect(injected).toBeDefined();
		expect(snapshot(f)).toEqual(injected);
	});
	test(`${kind}: reusing a controller, a label changed between the requester read and the evidence refuses`, async ({
		fixture: f,
	}) => {
		// Arrange: the reviewed snapshot keeps the label the requester read, while the
		// evidence and its digest carry the label set right after. Reuse writes no controller,
		// so only the eligibility assertion compares the reviewed label with the enrollment.
		const h = backendFor(f, kind);
		await seed(f, h);
		const original = await originalController(f);
		const review = await buildReview(f, {
			existingController: original,
			afterRequester: () =>
				f.db.exec(
					"UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id='current-laptop'",
				),
		});
		expect(review.controllerReview.verifiedSnapshot?.enrollmentIdentityId).not.toBe("identity-c");
		const before = snapshot(f);
		// Act
		const commit = commitReviewedOwnerResolution({
			backend: h.backend,
			evidence: h.evidence,
			review,
			now,
		});
		// Assert: nothing is written.
		await expect(commit).rejects.toThrow(/outcome is unavailable/u);
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind}: the weak current label is eligible only under the reviewed label`, async ({
		fixture: f,
	}) => {
		// Arrange: the enrollment carries weak label C; the review is for owner A.
		const h = backendFor(f, kind);
		await seed(f, h, { weakCurrent: true });
		const { controllerReview: input } = await buildReview(f);
		const keyId = await ed25519KeyIdForRevocation(input.publicKey);
		const authority = authControllerAuthorityValues(
			{
				group_id: input.groupId,
				device_id: input.deviceId,
				public_key: input.publicKey,
				fingerprint: input.fingerprint,
				identity_id: input.verifiedSnapshot?.enrollmentIdentityId ?? null,
			},
			keyId,
		);
		const eligible = (options: { reviewedLabel?: boolean }) => {
			const statement = controllerEligibleStatement(input, authority, options);
			return f.db.prepare(statement.sql).get(...statement.values) ?? null;
		};
		// Act, Assert: an ordinary review refuses the labelled enrollment; the explicit
		// owner resolution admits exactly the label it reviewed.
		expect(input.verifiedSnapshot?.enrollmentIdentityId).toBe("identity-c");
		expect(eligible({})).toBeNull();
		expect(eligible({ reviewedLabel: true })).toEqual({ eligible: 1 });
	});
}
