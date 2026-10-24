import { afterEach, beforeEach, expect, vi } from "vitest";
import { backendTest, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	captureInternalOwnerResolutionReview,
	commitReviewedOwnerResolution,
} from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
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

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} captures an exact explicit resolution review without writes or retaining mutable input`, async ({
		fixture: f,
	}) => {
		// Arrange: trusted builder has actual linked-account generation and history.
		const h = backendFor(f, kind);
		await seed(f, h, { weakCurrent: true });
		const input = await buildReview(f);
		const before = snapshot(f);
		// Act
		const captured = captureInternalOwnerResolutionReview(input);
		input.consent.confirmedDigest = "0".repeat(64);
		// Assert
		expect(captured).not.toBeNull();
		expect(captured?.consent.confirmedDigest).toBe(input.consent.evidenceDigest);
		expect(snapshot(f)).toEqual(before);
	});
	for (const mode of [
		"missing consent",
		"ordinary verified boolean",
		"wrong purpose",
		"wrong scope",
		"different digest",
		"uppercase digest",
		"malformed digest",
		"extra secret",
		"getter confirmation",
		"missing history",
		"missing owner target",
	] as const) {
		test(`${kind} rejects ${mode} confirmation before any write`, async ({ fixture: f }) => {
			// Arrange
			const h = backendFor(f, kind);
			await seed(f, h);
			const input = await buildReview(f);
			const invalid: Record<string, unknown> = structuredClone(input);
			const consent: Record<string, unknown> = { ...input.consent };
			invalid.consent = consent;
			const getter = vi.fn(() => input.consent.evidenceDigest);
			switch (mode) {
				case "missing consent":
					delete invalid.consent;
					break;
				case "ordinary verified boolean":
					invalid.consent = { verified: true };
					break;
				case "wrong purpose":
					consent.purpose = "controller_review";
					break;
				case "wrong scope":
					consent.scope = "all_owner_labels";
					break;
				case "different digest":
					consent.confirmedDigest = "0".repeat(64);
					break;
				case "uppercase digest":
					consent.evidenceDigest = consent.confirmedDigest = "A".repeat(64);
					break;
				case "malformed digest":
					consent.evidenceDigest = consent.confirmedDigest = "abc";
					break;
				case "extra secret":
					consent.accessToken = "synthetic-secret";
					break;
				case "getter confirmation":
					Object.defineProperty(consent, "confirmedDigest", { get: getter });
					break;
				case "missing history": {
					const snapshot = input.controllerReview.verifiedSnapshot;
					invalid.controllerReview = {
						...input.controllerReview,
						verifiedSnapshot: { ...snapshot, legacyHistory: undefined },
					};
					break;
				}
				case "missing owner target": {
					const snapshot = input.controllerReview.verifiedSnapshot;
					invalid.controllerReview = {
						...input.controllerReview,
						verifiedSnapshot: { ...snapshot, accountOwnerTarget: undefined },
					};
					break;
				}
			}
			const before = snapshot(f);
			// Act: capture failure is not authority and cannot be submitted as a successful review.
			const captured = captureInternalOwnerResolutionReview(invalid);
			// Assert
			expect(captured).toBeNull();
			expect(getter).not.toHaveBeenCalled();
			expect(h.batchCount()).toBe(0);
			expect(snapshot(f)).toEqual(before);
		});
	}
	test(`${kind} a bare ordinary controller review is not a resolution review`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		const input = await buildReview(f);
		const before = snapshot(f);
		// Act
		const captured = captureInternalOwnerResolutionReview(input.controllerReview);
		// Assert
		expect(captured).toBeNull();
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} forged nonmatching confirmation cannot bypass capture by calling the writer`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = backendFor(f, kind);
		await seed(f, h);
		const input = await buildReview(f);
		input.consent.confirmedDigest = "0".repeat(64);
		const before = snapshot(f);
		// Act / Assert
		await expect(
			commitReviewedOwnerResolution({
				backend: h.backend,
				evidence: h.evidence,
				review: input,
				now: new Date(NOW).toISOString(),
			}),
		).rejects.toThrow();
		expect(snapshot(f)).toEqual(before);
	});
}
