import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./sync-http-client.js", async (original) => ({
	...(await original<typeof import("./sync-http-client.js")>()),
	requestJson: vi.fn(),
}));

import {
	type CoordinatorAuthControllerReviewActionOptions,
	coordinatorAuthControllerReviewAction,
} from "./coordinator-actions.js";
import { requestJson } from "./sync-http-client.js";

const options: CoordinatorAuthControllerReviewActionOptions = {
	purpose: "existing_account_owner",
	remoteUrl: "https://coordinator.example.test/",
	adminSecret: "synthetic-secret",
	groupId: "group-a",
	deviceId: "current-laptop",
	identityId: "identity-a",
	fingerprint: "a".repeat(64),
};

beforeEach(() => {
	vi.mocked(requestJson).mockReset();
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

it.each([undefined, "b".repeat(64)])(
	"serializes explicit owner purpose with confirmation %s",
	async (confirmEvidenceDigest) => {
		// Arrange: echo the requested purpose, whether previewing or confirming.
		const payload = { purpose: options.purpose, state: "ready" };
		vi.mocked(requestJson).mockResolvedValue([200, payload]);
		// Act
		const result = await coordinatorAuthControllerReviewAction({
			...options,
			confirmEvidenceDigest,
		});
		// Assert
		expect(result).toEqual(payload);
		expect(requestJson).toHaveBeenCalledExactlyOnceWith(
			"POST",
			"https://coordinator.example.test/v1/admin/auth-controller-reviews",
			{
				headers: { "X-Codemem-Coordinator-Admin": options.adminSecret },
				body: {
					purpose: "existing_account_owner",
					group_id: options.groupId,
					device_id: options.deviceId,
					identity_id: options.identityId,
					fingerprint: options.fingerprint,
					...(confirmEvidenceDigest === undefined
						? {}
						: { confirm_evidence_digest: confirmEvidenceDigest }),
				},
				timeoutS: 3,
				maxResponseBytes: 2 * 750_000 + 16_384,
			},
		);
	},
);

it.each([null, "ordinary_review", "existing_account_owner\n", false, {}])(
	"rejects runtime purpose %j before transport",
	async (purpose) => {
		// Arrange: untyped callers cannot turn an invalid mode into ordinary review.
		const untyped = {
			...options,
			purpose,
		} as unknown as CoordinatorAuthControllerReviewActionOptions;
		// Act
		const result = coordinatorAuthControllerReviewAction(untyped);
		// Assert
		await expect(result).rejects.toThrow("controller_review_purpose_invalid");
		expect(requestJson).not.toHaveBeenCalled();
	},
);

it.each([undefined, null, "ordinary_review", "existing_account_owner\n"])(
	"rejects missing or mismatched echo %s without ordinary fallback",
	async (purpose) => {
		// Arrange: an old coordinator may return ready without recognizing the new purpose.
		vi.mocked(requestJson).mockResolvedValue([
			200,
			{ state: "ready", ...(purpose === undefined ? {} : { purpose }) },
		]);
		// Act
		const result = coordinatorAuthControllerReviewAction(options);
		// Assert
		await expect(result).rejects.toThrow("controller_review_purpose_unsupported");
		expect(requestJson).toHaveBeenCalledTimes(1);
		expect(vi.mocked(requestJson).mock.calls[0]?.[2]?.body).toMatchObject({
			purpose: "existing_account_owner",
		});
	},
);

it("preserves old coordinator support when purpose is absent", async () => {
	// Arrange: ordinary callers do not require a new response field.
	const { purpose: _purpose, ...ordinary } = options;
	const payload = { state: "ready" };
	vi.mocked(requestJson).mockResolvedValue([200, payload]);
	// Act
	const result = await coordinatorAuthControllerReviewAction(ordinary);
	// Assert
	expect(result).toEqual(payload);
	expect(requestJson).toHaveBeenCalledTimes(1);
	expect(vi.mocked(requestJson).mock.calls[0]?.[2]?.body).not.toHaveProperty("purpose");
});
