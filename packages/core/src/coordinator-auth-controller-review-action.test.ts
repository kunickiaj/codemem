import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./sync-http-client.js", async (original) => ({
	...(await original<typeof import("./sync-http-client.js")>()),
	requestJson: vi.fn(),
}));

import {
	coordinatorAuthControllerReviewAction,
	RemoteCoordinatorRequestError,
} from "./coordinator-actions.js";
import { requestJson } from "./sync-http-client.js";

const options = {
	remoteUrl: "https://coordinator.example.test/",
	adminSecret: "fixture-secret",
	groupId: "group-a",
	deviceId: "device-a",
	identityId: "actor-a",
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

it.each([
	{ timeoutS: undefined, expected: 3 },
	{ timeoutS: 10, expected: 10 },
	{ timeoutS: 12, expected: 12 },
])("forwards budget $expected and the unchanged 16 KiB limit", async ({ timeoutS, expected }) => {
	// Arrange: preview omits the digest; confirmation includes it with the same HTTP budget.
	const payload = { state: "ready" };
	vi.mocked(requestJson).mockResolvedValue([200, payload]);
	const digest = "b".repeat(64);
	// Act
	const preview = await coordinatorAuthControllerReviewAction({ ...options, timeoutS });
	const confirmed = await coordinatorAuthControllerReviewAction({
		...options,
		timeoutS,
		confirmEvidenceDigest: digest,
	});
	// Assert
	const httpOptions = {
		headers: { "X-Codemem-Coordinator-Admin": "fixture-secret" },
		body: {
			group_id: "group-a",
			device_id: "device-a",
			identity_id: "actor-a",
			fingerprint: options.fingerprint,
		},
		timeoutS: expected,
		maxResponseBytes: 16384,
	};
	const url = "https://coordinator.example.test/v1/admin/auth-controller-reviews";
	expect(vi.mocked(requestJson).mock.calls).toEqual([
		["POST", url, httpOptions],
		[
			"POST",
			url,
			{ ...httpOptions, body: { ...httpOptions.body, confirm_evidence_digest: digest } },
		],
	]);
	expect(preview).toEqual(payload);
	expect(confirmed).toEqual(payload);
});

it.each([
	{
		status: 409,
		payload: { error: "review_stale" },
		error: new RemoteCoordinatorRequestError(409, "review_stale"),
	},
	{ status: 200, payload: null, error: new Error("controller_review_response_invalid") },
	{
		status: 200,
		payload: { error: "response_too_large" },
		error: new Error("coordinator_response_too_large"),
	},
])(
	"rejects unsuccessful response $status/$payload with the configured budget",
	async ({ status, payload, error }) => {
		// Arrange
		vi.mocked(requestJson).mockResolvedValue([status, payload]);
		// Act
		const result = coordinatorAuthControllerReviewAction({ ...options, timeoutS: 12 });
		// Assert
		await expect(result).rejects.toThrow(error);
		expect(requestJson).toHaveBeenCalledExactlyOnceWith(
			"POST",
			"https://coordinator.example.test/v1/admin/auth-controller-reviews",
			expect.objectContaining({ timeoutS: 12, maxResponseBytes: 16384 }),
		);
	},
);
