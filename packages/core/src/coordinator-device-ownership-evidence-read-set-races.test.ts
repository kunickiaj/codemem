// Each site that relies on a captured ownership evidence read set re-runs its guards in
// the batch that answers or writes. A strong other-owner source added after the capture
// and just before that batch must change the answer, and a write batch must write nothing.
import { expect } from "vitest";
import { beforeStatements } from "./coordinator-auth-controller-race-test-fixtures.js";
import { backendTest, type LinkFixture } from "./coordinator-auth-link-test-fixtures.js";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	binding,
	cfg,
	collectInput,
	evidenceBackend,
	evidenceTest,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import {
	resolutionTable,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { OwnerResolutionReviewOperations } from "./coordinator-owner-resolution-review.js";
import {
	deterministicReviewTests,
	selection,
	setupReview,
} from "./coordinator-owner-resolution-review-test-fixtures.js";

// The last statement of a recheck: it runs once every guard of the capture held.
const RECHECK_END = /^SELECT 1 AS held$/u;
// The last statement of the confirmation's write batch, behind the evidence guards.
const RESOLUTION_INSERT = /^INSERT INTO coordinator_legacy_owner_resolutions \(/u;
const noChange = () => undefined;

/** A strong ownership binding of the reviewed device by another Identity. */
function strongOtherOwner(f: LinkFixture) {
	f.db
		.prepare(`INSERT INTO coordinator_device_ownership_bindings
		(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
		VALUES (?,?,?,?,?,?,?,?)`)
		.run(
			selection.deviceId,
			"e".repeat(64),
			"identity-b",
			f.cfg.coordinatorId,
			"raced-binding",
			"owner_enrollment",
			"raced-source",
			"2026-10-02T00:00:00.000Z",
		);
}

// The capture's second read: the controllers among the keys its first reads discovered.
const DISCOVERED_READ = /attestation_id IN \(SELECT value FROM json_each\(\?\)\)/u;

deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const evidence = evidenceTest(kind);
	evidence(
		`${kind}: the capture's own recheck refuses a binding added between its reads`,
		async ({ f }) => {
			// Arrange: the binding lands after the subject's categories were read, before the
			// discovered controllers are, so only the recheck can see it.
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, kind), cfg);
			const input = await collectInput(f);
			const hook = beforeStatements(f.db, [{ pattern: DISCOVERED_READ, mutate: () => binding(f) }]);
			// Act
			const result = await reader.collect(input);
			hook.restore();
			// Assert
			expect(hook.reached()).toBe(1);
			expect(result).toEqual({ kind: "unavailable", authorizationUnavailable: true });
		},
	);

	const test = backendTest(kind);

	test(`${kind}: the preview's unchanged-capture check refuses a source added after the capture`, async ({
		fixture: f,
	}) => {
		// Arrange: the capture's own recheck passes; the change lands before the second.
		const h = await setupReview(f, kind);
		const operations = new OwnerResolutionReviewOperations(h.backend, () => Date.now());
		const hook = beforeStatements(f.db, [
			{ pattern: RECHECK_END, mutate: noChange },
			{ pattern: RECHECK_END, mutate: () => strongOtherOwner(f) },
		]);
		// Act
		const preview = await operations
			.previewOwnerResolutionReview(selection, f.cfg)
			.catch((error: unknown) => error);
		hook.restore();
		// Assert
		expect(hook.reached()).toBe(2);
		expect(preview).not.toMatchObject({ state: "ready" });
	});

	test(`${kind}: the confirmation batch writes nothing once a source is added after its capture`, async ({
		fixture: f,
	}) => {
		// Arrange: a ready preview, then a confirmation whose write batch sees the change.
		const h = await setupReview(f, kind);
		const operations = new OwnerResolutionReviewOperations(h.backend, () => Date.now());
		const preview = await operations.previewOwnerResolutionReview(selection, f.cfg);
		expect(preview).toMatchObject({ state: "ready" });
		let atWrite: ReturnType<typeof snapshot> | undefined;
		const hook = beforeStatements(f.db, [
			{
				pattern: RESOLUTION_INSERT,
				mutate: () => {
					strongOtherOwner(f);
					atWrite = snapshot(f);
				},
			},
		]);
		// Act
		const confirmed = await operations
			.confirmOwnerResolutionReview(
				{ ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest },
				f.cfg,
			)
			.catch((error: unknown) => error);
		hook.restore();
		// Assert: no receipt was written; only the injected source remains.
		expect(hook.reached()).toBe(1);
		expect(confirmed).toBeInstanceOf(Error);
		expect(snapshot(f)).toEqual(atWrite);
		expect(f.db.prepare(`SELECT count(*) AS n FROM ${resolutionTable}`).get()).toEqual({ n: 0 });
	});
}
