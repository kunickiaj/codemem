import { expect, vi } from "vitest";

vi.mock("./sync-http-client.js", async (original) => ({
	...(await original<typeof import("./sync-http-client.js")>()),
	requestJson: vi.fn(),
}));

import {
	type CoordinatorAuthControllerReviewActionOptions,
	coordinatorAuthControllerReviewAction,
} from "./coordinator-actions.js";
import { backendTest, type LinkFixture } from "./coordinator-auth-link-test-fixtures.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	buildReview,
	now,
	originalController,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import {
	deterministicReviewTests,
	scope,
	selection,
	setupReview,
	signer,
} from "./coordinator-owner-resolution-review-test-fixtures.js";
import { requestJson } from "./sync-http-client.js";

// Synthetic DTOs come from actual operations, including genuine receipt IDs and birth evidence.
const options = {
	remoteUrl: "https://coordinator.example.test/",
	adminSecret: "synthetic-scoped-client-admin",
	purpose: "existing_account_owner",
	resolutionScope: scope,
	...selection,
} satisfies CoordinatorAuthControllerReviewActionOptions;
const test = backendTest("SQLite");
const wireBody = {
	purpose: options.purpose,
	resolution_scope: scope,
	group_id: selection.groupId,
	device_id: selection.deviceId,
	identity_id: selection.identityId,
	fingerprint: selection.fingerprint,
};
async function payloads(f: LinkFixture) {
	await setupReview(f, "SQLite");
	const preview = await f.store.previewOwnerResolutionReview(selection, f.cfg);
	expect(preview.state).toBe("ready");
	const committed = await f.store.confirmOwnerResolutionReview(
		{ ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest },
		f.cfg,
	);
	vi.mocked(requestJson).mockReset();
	return { preview, committed, digest: preview.owner_resolution_digest as string };
}
function bodyAt(index: number) {
	return vi.mocked(requestJson).mock.calls[index]?.[2]?.body;
}
async function retainedControllerPayloads(f: LinkFixture) {
	const h = await setupReview(f, "SQLite", false);
	const original = await originalController(f);
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id=?")
		.run(signer.deviceId);
	const preview = await f.store.previewOwnerResolutionReview(selection, f.cfg);
	expect(preview.state).toBe("ready");
	vi.mocked(requestJson).mockReset();
	return { h, original, preview, digest: preview.owner_resolution_digest as string };
}
deterministicReviewTests();

test("scoped client preview uses one read-only POST, header-only admin secret and existing transport limits", async ({
	fixture: f,
}) => {
	// Arrange
	const { preview } = await payloads(f);
	vi.mocked(requestJson).mockResolvedValue([200, preview]);
	// Act
	const result = await coordinatorAuthControllerReviewAction(options);
	// Assert
	expect(result).toEqual(preview);
	expect(requestJson).toHaveBeenCalledExactlyOnceWith(
		"POST",
		"https://coordinator.example.test/v1/admin/auth-controller-reviews",
		{
			headers: { "X-Codemem-Coordinator-Admin": options.adminSecret },
			body: wireBody,
			timeoutS: 3,
			maxResponseBytes: 2_000_000,
		},
	);
	expect(JSON.stringify(bodyAt(0))).not.toMatch(
		/confirm|synthetic-scoped-client-admin|credential|public_key/,
	);
});

test("scoped client confirm previews without any confirmation then sends only the new digest", async ({
	fixture: f,
}) => {
	// Arrange
	const { preview, committed, digest } = await payloads(f);
	vi.mocked(requestJson)
		.mockResolvedValueOnce([200, preview])
		.mockResolvedValueOnce([201, committed]);
	// Act
	const result = await coordinatorAuthControllerReviewAction({
		...options,
		confirmOwnerResolutionDigest: digest,
	});
	// Assert
	expect(result).toEqual(committed);
	expect(requestJson).toHaveBeenCalledTimes(2);
	expect(bodyAt(0)).toEqual(wireBody);
	expect(bodyAt(1)).toEqual({ ...wireBody, confirm_owner_resolution_digest: digest });
	for (const call of vi.mocked(requestJson).mock.calls) {
		expect(call[2]).toMatchObject({
			timeoutS: 3,
			headers: { "X-Codemem-Coordinator-Admin": options.adminSecret },
		});
		expect(call[2]?.body).not.toHaveProperty("confirm_evidence_digest");
	}
});

test("restored scoped preview can confirm the fresh digest and return unchanged original receipts", async ({
	fixture: f,
}) => {
	// Arrange
	await payloads(f);
	const restored = await f.store.previewOwnerResolutionReview(selection, f.cfg);
	const reused = await f.store.confirmOwnerResolutionReview(
		{ ...selection, confirmOwnerResolutionDigest: restored.owner_resolution_digest },
		f.cfg,
	);
	vi.mocked(requestJson)
		.mockResolvedValueOnce([200, restored])
		.mockResolvedValueOnce([200, reused]);
	// Act
	const result = await coordinatorAuthControllerReviewAction({
		...options,
		confirmOwnerResolutionDigest: restored.owner_resolution_digest,
	});
	// Assert
	expect(restored.state).toBe("restored");
	expect(result).toEqual(reused);
	expect(result).toMatchObject({
		recovery_receipt: { disposition: "reused" },
		owner_resolution: { disposition: "reused" },
	});
	expect(requestJson).toHaveBeenCalledTimes(2);
});

test("scoped confirmation accepts a reused ordinary controller and review receipt with a newly created resolution", async ({
	fixture: f,
}) => {
	// Arrange: storage permits retained identifiers, not just generated hash-prefix IDs.
	const { preview, digest } = await retainedControllerPayloads(f);
	const committed = await f.store.confirmOwnerResolutionReview(
		{ ...selection, confirmOwnerResolutionDigest: digest },
		f.cfg,
	);
	expect(committed).toMatchObject({
		state: "ready",
		attestation_id: "original-controller",
		recovery_receipt: { disposition: "reused", review_receipt_id: "original-receipt" },
		owner_resolution: {
			disposition: "created",
			resolution_id: expect.stringMatching(/^resolution-v1:[a-f0-9]{64}$/),
		},
	});
	vi.mocked(requestJson)
		.mockResolvedValueOnce([200, preview])
		.mockResolvedValueOnce([200, committed]);
	// Act
	const result = await coordinatorAuthControllerReviewAction({
		...options,
		confirmOwnerResolutionDigest: digest,
	});
	// Assert: accepting the valid reply must not report an unknown outcome or retry.
	expect(result).toEqual(committed);
	expect(requestJson).toHaveBeenCalledTimes(2);
	expect(bodyAt(0)).toEqual(wireBody);
	expect(bodyAt(1)).toEqual({ ...wireBody, confirm_owner_resolution_digest: digest });
	expect(bodyAt(1)).not.toHaveProperty("confirm_evidence_digest");
});

test("read-only restored preview accepts ordinary retained controller, review and resolution identifiers", async ({
	fixture: f,
}) => {
	// Arrange: produce the retained resolution through the real writer and metadata capture.
	const { h, original } = await retainedControllerPayloads(f);
	const committed = await commitReviewedOwnerResolution({
		backend: h.backend,
		evidence: h.evidence,
		review: await buildReview(f, {
			existingController: original,
			resolutionId: "retained-resolution",
		}),
		now,
	});
	expect(committed).toMatchObject({
		controllerDisposition: "reused",
		resolutionDisposition: "created",
		resolution: { resolution_id: "retained-resolution" },
	});
	const restored = await f.store.previewOwnerResolutionReview(selection, f.cfg);
	expect(restored).toMatchObject({
		state: "restored",
		attestation_id: "original-controller",
		recovery_receipt: { disposition: "reused", review_receipt_id: "original-receipt" },
		owner_resolution: { disposition: "reused", resolution_id: "retained-resolution" },
	});
	vi.mocked(requestJson).mockResolvedValueOnce([200, restored]);
	// Act
	const result = await coordinatorAuthControllerReviewAction(options);
	// Assert: status remains read-only with no ordinary or scoped confirmation.
	expect(result).toEqual(restored);
	expect(requestJson).toHaveBeenCalledTimes(1);
	expect(bodyAt(0)).toEqual(wireBody);
});

const receiptIdFields = ["attestation_id", "review_receipt_id", "resolution_id"] as const;
const malformedIds = [
	["empty", ""],
	["whitespace", " original-id "],
	["control", "original\u0000id"],
	["overlength", "a".repeat(257)],
] as const;

function withReceiptField(
	payload: Awaited<ReturnType<typeof payloads>>["committed"],
	field: string,
	value: unknown,
) {
	if (field === "attestation_id") return { ...payload, attestation_id: value };
	if (field === "review_receipt_id")
		return { ...payload, recovery_receipt: { ...payload.recovery_receipt, [field]: value } };
	return { ...payload, owner_resolution: { ...payload.owner_resolution, [field]: value } };
}

for (const field of receiptIdFields) {
	for (const [name, value] of malformedIds) {
		test(`client rejects ${name} ${field} in restored status and confirmation without retry`, async ({
			fixture: f,
		}) => {
			// Arrange: keep every other DTO field valid so each identifier is checked independently.
			const { preview, committed, digest } = await payloads(f);
			const invalid = withReceiptField(committed, field, value);
			vi.mocked(requestJson).mockResolvedValueOnce([200, { ...invalid, state: "restored" }]);
			// Act
			const status = coordinatorAuthControllerReviewAction(options);
			// Assert
			await expect(status).rejects.toThrow("owner_resolution_receipt_invalid");
			expect(requestJson).toHaveBeenCalledTimes(1);
			expect(bodyAt(0)).toEqual(wireBody);
			// Arrange
			vi.mocked(requestJson)
				.mockReset()
				.mockResolvedValueOnce([200, preview])
				.mockResolvedValueOnce([200, invalid]);
			// Act
			const confirmation = coordinatorAuthControllerReviewAction({
				...options,
				confirmOwnerResolutionDigest: digest,
			});
			// Assert
			await expect(confirmation).rejects.toThrow("owner_resolution_outcome_unknown");
			expect(requestJson).toHaveBeenCalledTimes(2);
			expect(bodyAt(0)).toEqual(wireBody);
			expect(bodyAt(1)).toEqual({ ...wireBody, confirm_owner_resolution_digest: digest });
		});
	}
}

for (const receipt of ["recovery_receipt", "owner_resolution"] as const) {
	for (const [field, value] of [
		["evidence_digest", "not-a-hash"],
		["evidence_digest", `${"a".repeat(64)}\n`],
		["created_at", "not-a-date"],
		["created_at", undefined],
		["disposition", "unknown"],
		["disposition", undefined],
	] as const) {
		test(`client still rejects ${receipt} ${field}=${String(value)} without retry`, async ({
			fixture: f,
		}) => {
			// Arrange: generated IDs isolate required receipt metadata from retained-ID acceptance.
			const { preview, committed, digest } = await payloads(f);
			const invalid = { ...committed, [receipt]: { ...committed[receipt], [field]: value } };
			vi.mocked(requestJson).mockResolvedValueOnce([200, { ...invalid, state: "restored" }]);
			// Act
			const status = coordinatorAuthControllerReviewAction(options);
			// Assert
			await expect(status).rejects.toThrow("owner_resolution_receipt_invalid");
			expect(requestJson).toHaveBeenCalledTimes(1);
			// Arrange
			vi.mocked(requestJson)
				.mockReset()
				.mockResolvedValueOnce([200, preview])
				.mockResolvedValueOnce([200, invalid]);
			// Act
			const confirmation = coordinatorAuthControllerReviewAction({
				...options,
				confirmOwnerResolutionDigest: digest,
			});
			// Assert
			await expect(confirmation).rejects.toThrow("owner_resolution_outcome_unknown");
			expect(requestJson).toHaveBeenCalledTimes(2);
			expect(bodyAt(0)).toEqual(wireBody);
			expect(bodyAt(1)).toEqual({ ...wireBody, confirm_owner_resolution_digest: digest });
		});
	}
}

for (const [name, patch] of [
	["missing owner purpose", { purpose: undefined }],
	["null scope", { resolutionScope: null }],
	["unknown scope", { resolutionScope: "all_owners" }],
	[
		"resolution confirmation without scope",
		{ resolutionScope: undefined, confirmOwnerResolutionDigest: "b".repeat(64) },
	],
	["ordinary confirmation in scoped mode", { confirmEvidenceDigest: "b".repeat(64) }],
	["malformed resolution digest", { confirmOwnerResolutionDigest: `${"b".repeat(64)}\n` }],
] as const) {
	test(`client rejects ${name} before any request`, async ({ fixture: f }) => {
		// Arrange
		const { preview } = await payloads(f);
		vi.mocked(requestJson).mockResolvedValue([200, preview]);
		const invalid = {
			...options,
			...patch,
		} as unknown as CoordinatorAuthControllerReviewActionOptions;
		// Act
		const result = coordinatorAuthControllerReviewAction(invalid);
		// Assert
		await expect(result).rejects.toThrow(/invalid|scope|purpose|confirm/i);
		expect(requestJson).not.toHaveBeenCalled();
	});
}

for (const [name, patch] of [
	["old server missing scope", { resolution_scope: undefined }],
	["wrong purpose", { purpose: "ordinary_review" }],
	["wrong scope", { resolution_scope: "all_owners" }],
	[
		"foreign selection",
		{
			group_id: "other-group",
			device_id: "other-device",
			identity_id: "identity-b",
			fingerprint: "9".repeat(64),
		},
	],
	["changed proposed digest", { owner_resolution_digest: "9".repeat(64) }],
] as const) {
	test(`client refuses confirmation after ${name} with no second POST`, async ({ fixture: f }) => {
		// Arrange
		const { preview, digest } = await payloads(f);
		const patches =
			name === "foreign selection"
				? Object.entries(patch).map(([key, value]) => ({ [key]: value }))
				: [patch];
		for (const value of patches) {
			// Arrange: every selected tuple component must match independently.
			vi.mocked(requestJson)
				.mockReset()
				.mockResolvedValue([200, { ...preview, ...value }]);
			// Act
			const result = coordinatorAuthControllerReviewAction({
				...options,
				confirmOwnerResolutionDigest: digest,
			});
			// Assert
			await expect(result).rejects.toThrow(/unsupported|stale|mismatch|invalid|changed/i);
			expect(requestJson).toHaveBeenCalledTimes(1);
			expect(bodyAt(0)).toEqual(wireBody);
		}
	});
}

test("needs-review preview is returned safely but cannot be confirmed", async ({ fixture: f }) => {
	// Arrange
	const { digest } = await payloads(f);
	f.db.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?").run(selection.deviceId);
	const needsReview = await f.store.previewOwnerResolutionReview(selection, f.cfg);
	expect(needsReview.state).toBe("needs_review");
	vi.mocked(requestJson).mockResolvedValue([200, needsReview]);
	// Act
	const result = await coordinatorAuthControllerReviewAction(options);
	const confirmation = coordinatorAuthControllerReviewAction({
		...options,
		confirmOwnerResolutionDigest: digest,
	});
	// Assert
	expect(result).toEqual(needsReview);
	await expect(confirmation).rejects.toThrow(/review|stale|invalid/i);
	expect(requestJson).toHaveBeenCalledTimes(2);
	expect(bodyAt(0)).toEqual(wireBody);
	expect(bodyAt(1)).toEqual(wireBody);
});

for (const phase of ["transport", "missing echo", "malformed receipt"] as const) {
	test(`actual confirmation ${phase} failure reports unknown outcome without retry or rollback claim`, async ({
		fixture: f,
	}) => {
		// Arrange
		const { preview, committed, digest } = await payloads(f);
		vi.mocked(requestJson).mockResolvedValueOnce([200, preview]);
		if (phase === "transport")
			vi.mocked(requestJson).mockRejectedValueOnce(new Error("synthetic socket closed"));
		if (phase === "missing echo")
			vi.mocked(requestJson).mockResolvedValueOnce([
				201,
				{ ...committed, resolution_scope: undefined },
			]);
		if (phase === "malformed receipt")
			vi.mocked(requestJson).mockResolvedValueOnce([
				201,
				{
					...committed,
					recovery_receipt: {
						...committed.recovery_receipt,
						review_receipt_id: "invalid\u0000review-receipt",
					},
				},
			]);
		// Act
		const result = coordinatorAuthControllerReviewAction({
			...options,
			confirmOwnerResolutionDigest: digest,
		});
		// Assert
		await expect(result).rejects.toThrow(/unknown|check.*status|preview.*status/i);
		expect(requestJson).toHaveBeenCalledTimes(2);
		expect(bodyAt(1)).toEqual({ ...wireBody, confirm_owner_resolution_digest: digest });
	});
}

test("scope absent preserves the old single-POST owner-purpose helper", async ({ fixture: f }) => {
	// Arrange
	await payloads(f);
	const { resolutionScope: _scope, ...legacy } = options;
	const payload = { purpose: "existing_account_owner", state: "ready" };
	vi.mocked(requestJson).mockResolvedValue([200, payload]);
	// Act
	const result = await coordinatorAuthControllerReviewAction({
		...legacy,
		confirmEvidenceDigest: "b".repeat(64),
	});
	// Assert
	expect(result).toEqual(payload);
	expect(requestJson).toHaveBeenCalledTimes(1);
	expect(bodyAt(0)).toEqual({
		purpose: legacy.purpose,
		group_id: legacy.groupId,
		device_id: legacy.deviceId,
		identity_id: legacy.identityId,
		fingerprint: legacy.fingerprint,
		confirm_evidence_digest: "b".repeat(64),
	});
});

test("explicit stale confirmation response remains a conflict and never retries", async ({
	fixture: f,
}) => {
	// Arrange
	const { preview, digest } = await payloads(f);
	vi.mocked(requestJson)
		.mockResolvedValueOnce([200, preview])
		.mockResolvedValueOnce([409, { error: "review_stale" }]);
	// Act
	const result = coordinatorAuthControllerReviewAction({
		...options,
		confirmOwnerResolutionDigest: digest,
	});
	// Assert
	await expect(result).rejects.toThrow(/review_stale|stale/i);
	expect(requestJson).toHaveBeenCalledTimes(2);
});
