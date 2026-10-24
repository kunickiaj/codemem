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
import {
	deterministicReviewTests,
	scope,
	selection,
	setupReview,
} from "./coordinator-owner-resolution-review-test-fixtures.js";
import { requestJson } from "./sync-http-client.js";

const test = backendTest("SQLite");
const options = {
	remoteUrl: "https://coordinator.example.test",
	adminSecret: "fixture-scoped-admin",
	purpose: "existing_account_owner",
	resolutionScope: scope,
	...selection,
} satisfies CoordinatorAuthControllerReviewActionOptions;
const wireBody = {
	purpose: options.purpose,
	resolution_scope: scope,
	group_id: selection.groupId,
	device_id: selection.deviceId,
	identity_id: selection.identityId,
	fingerprint: selection.fingerprint,
};
deterministicReviewTests();

async function payloads(f: LinkFixture) {
	await setupReview(f, "SQLite");
	const preview = { ...(await f.store.previewOwnerResolutionReview(selection, f.cfg)) };
	if (preview.state !== "ready" || !preview.owner_resolution_digest)
		throw new Error("Real preview unavailable");
	const committed = {
		...(await f.store.confirmOwnerResolutionReview(
			{ ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest },
			f.cfg,
		)),
	};
	vi.mocked(requestJson)
		.mockReset()
		.mockResolvedValueOnce([200, preview])
		.mockResolvedValueOnce([201, committed]);
	return { preview, committed, digest: preview.owner_resolution_digest };
}

test("trusted callback runs once after fresh preview validation and immediately before confirmation, never on the wire", async ({
	fixture: f,
}) => {
	// Arrange: use valid preview and receipt DTOs produced by the actual checked writer.
	const h = await payloads(f);
	const events: string[] = [];
	vi.mocked(requestJson)
		.mockReset()
		.mockImplementation(async (_method, _url, request) => {
			if (Object.hasOwn(request?.body ?? {}, "confirm_owner_resolution_digest")) {
				events.push("confirm");
				return [201, h.committed];
			}
			events.push("preview");
			return [200, h.preview];
		});
	const assertBeforeOwnerResolutionConfirm = vi.fn(() => {
		events.push("callback");
	});
	// Act
	const result = await coordinatorAuthControllerReviewAction({
		...options,
		confirmOwnerResolutionDigest: h.digest,
		assertBeforeOwnerResolutionConfirm,
	});
	// Assert
	expect(result).toEqual(h.committed);
	expect.soft(assertBeforeOwnerResolutionConfirm).toHaveBeenCalledOnce();
	expect(events).toEqual(["preview", "callback", "confirm"]);
	expect(vi.mocked(requestJson).mock.calls.map((call) => call[2]?.body)).toEqual([
		wireBody,
		{ ...wireBody, confirm_owner_resolution_digest: h.digest },
	]);
});

test("a throwing trusted callback prevents the confirmation POST and preserves its pre-dispatch error", async ({
	fixture: f,
}) => {
	// Arrange
	const h = await payloads(f);
	const failure = new Error("actual_runtime_context_changed");
	const assertBeforeOwnerResolutionConfirm = vi.fn(() => {
		throw failure;
	});
	// Act
	const error = await coordinatorAuthControllerReviewAction({
		...options,
		confirmOwnerResolutionDigest: h.digest,
		assertBeforeOwnerResolutionConfirm,
	}).then(
		() => null,
		(caught: unknown) => caught,
	);
	// Assert: do not mislabel a pre-dispatch failure as an already-sent unknown result.
	expect.soft(error).toBe(failure);
	expect.soft(assertBeforeOwnerResolutionConfirm).toHaveBeenCalledOnce();
	expect(requestJson).toHaveBeenCalledTimes(1);
});

for (const value of [null, "callback", 1, {}]) {
	test(`invalid trusted callback ${JSON.stringify(value)} rejects before any preview fetch`, async ({
		fixture: f,
	}) => {
		// Arrange: this cast exists only to exercise runtime validation of untrusted input.
		const h = await payloads(f);
		// Act
		const error = await coordinatorAuthControllerReviewAction({
			...options,
			confirmOwnerResolutionDigest: h.digest,
			assertBeforeOwnerResolutionConfirm: value,
		} as unknown as CoordinatorAuthControllerReviewActionOptions).then(
			() => null,
			(caught: unknown) => caught,
		);
		// Assert
		expect.soft(error).toBeInstanceOf(Error);
		expect(requestJson).not.toHaveBeenCalled();
	});
}

test("preview-only scoped requests never invoke or serialize the callback", async ({
	fixture: f,
}) => {
	// Arrange
	const h = await payloads(f);
	const assertBeforeOwnerResolutionConfirm = vi.fn(() => {
		throw new Error("Preview must be read-only");
	});
	// Act
	const result = await coordinatorAuthControllerReviewAction({
		...options,
		assertBeforeOwnerResolutionConfirm,
	});
	// Assert
	expect(result).toEqual(h.preview);
	expect(assertBeforeOwnerResolutionConfirm).not.toHaveBeenCalled();
	expect(requestJson).toHaveBeenCalledTimes(1);
	expect(vi.mocked(requestJson).mock.calls[0]?.[2]?.body).toEqual(wireBody);
});

test("a callback without explicit resolution scope rejects before fetching", async ({
	fixture: f,
}) => {
	// Arrange
	await payloads(f);
	const { resolutionScope: _scope, ...unscoped } = options;
	const assertBeforeOwnerResolutionConfirm = vi.fn();
	// Act
	const error = await coordinatorAuthControllerReviewAction({
		...unscoped,
		assertBeforeOwnerResolutionConfirm,
	}).then(
		() => null,
		(caught: unknown) => caught,
	);
	// Assert
	expect.soft(error).toBeInstanceOf(Error);
	expect(assertBeforeOwnerResolutionConfirm).not.toHaveBeenCalled();
	expect(requestJson).not.toHaveBeenCalled();
});

for (const mismatch of ["subject", "digest"]) {
	test(`fresh preview ${mismatch} mismatch rejects before callback or confirmation`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await payloads(f);
		const invalid = { ...h.preview };
		if (mismatch === "subject") invalid.device_id = "foreign-device";
		else invalid.owner_resolution_digest = "f".repeat(64);
		vi.mocked(requestJson).mockReset().mockResolvedValueOnce([200, invalid]);
		const assertBeforeOwnerResolutionConfirm = vi.fn();
		// Act / Assert
		await expect(
			coordinatorAuthControllerReviewAction({
				...options,
				confirmOwnerResolutionDigest: h.digest,
				assertBeforeOwnerResolutionConfirm,
			}),
		).rejects.toThrow();
		expect(assertBeforeOwnerResolutionConfirm).not.toHaveBeenCalled();
		expect(requestJson).toHaveBeenCalledTimes(1);
	});
}
