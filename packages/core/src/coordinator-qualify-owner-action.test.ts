import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	coordinatorQualifyOwnerAction,
	RemoteCoordinatorRequestError,
} from "./coordinator-actions.js";

const reference = `controller-v1:${"a".repeat(64)}`;
const options = {
	remoteUrl: "https://coordinator.example.test",
	adminSecret: "fixture-private-admin-credential",
	attestationId: reference,
};
const digest = "b".repeat(64);
const fetchMock = vi.fn<typeof fetch>();
const ready = { state: "ready", evidence_digest: digest };
function json(body: unknown, status = 200, statusText?: string) {
	return new Response(JSON.stringify(body), { status, statusText });
}
function publicError(error: unknown) {
	return [String(error), JSON.stringify(error), error instanceof Error ? error.stack : ""].join(
		"\n",
	);
}
function expectSafeFailure(error: unknown, code: string) {
	expect(error).toBeInstanceOf(Error);
	expect(
		error instanceof RemoteCoordinatorRequestError ? error.code : (error as Error).message,
	).toBe(code);
	expect(publicError(error)).not.toContain(options.adminSecret);
	expect(error).not.toHaveProperty("cause");
	expect(publicError(error)).not.toContain("unchanged");
}
beforeEach(() => {
	fetchMock.mockReset().mockResolvedValue(json(ready));
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it.each([
	"coordinator.example.test",
	"http://coordinator.example.test",
	"https://user:password@example.test",
	"https://coordinator.example.test/path",
	"https://coordinator.example.test?token=secret",
	"https://coordinator.example.test#fragment",
	"not a URL",
	"http://127.0.0.1.example.test",
])(
	"direct public action rejects unsafe origin %j before sending credentials",
	async (remoteUrl) => {
		// Arrange
		const input = { ...options, remoteUrl };
		// Act
		const request = coordinatorQualifyOwnerAction(input);
		// Assert
		await expect(request).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	},
);

it.each(["https://coordinator.example.test", "http://127.0.0.1:7337", "http://[::1]:7337"])(
	"valid origin %s sends exactly the preview reference with isolated admin credentials",
	async (remoteUrl) => {
		// Arrange
		const input = {
			...options,
			remoteUrl,
			identityId: "attacker",
			linkId: "attacker",
			actorId: "attacker",
		};
		// Act
		const result = await coordinatorQualifyOwnerAction(input);
		// Assert
		expect(result).toEqual(ready);
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			`${remoteUrl}/v1/admin/owner-qualifications`,
			expect.objectContaining({
				method: "POST",
				redirect: "error",
				body: new TextEncoder().encode(JSON.stringify({ attestation_id: reference })),
			}),
		);
		const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
		expect(headers.get("X-Codemem-Coordinator-Admin")).toBe(options.adminSecret);
		for (const name of ["Origin", "Authorization", "X-Codemem-Coordinator-Admin-Actor"])
			expect(headers.has(name)).toBe(false);
	},
);

it.each(["created", "existing"])(
	"explicit confirmation %s sends the exact digest only once",
	async (state) => {
		// Arrange
		const response = { state, qualification_id: "qualification-a", evidence_digest: digest };
		fetchMock.mockResolvedValue(json(response, state === "created" ? 201 : 200));
		// Act
		const result = await coordinatorQualifyOwnerAction({
			...options,
			confirmEvidenceDigest: digest,
		});
		// Assert
		expect(result).toEqual(response);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[1]?.body).toEqual(
			new TextEncoder().encode(
				JSON.stringify({
					attestation_id: reference,
					confirm_evidence_digest: digest,
				}),
			),
		);
	},
);

it.each([
	[400, "qualification_invalid_input"],
	[401, "unauthorized"],
	[429, "rate_limited"],
	[409, "preview_changed"],
	[409, "qualification_conflict"],
	[409, "unavailable"],
	[400, "invalid_input"],
	[413, "body_too_large"],
	[503, "qualification_unavailable"],
	[503, "qualification_outcome_unknown"],
])("preserves expected rejection %s/%s without remote detail or cause", async (status, code) => {
	// Arrange
	fetchMock.mockResolvedValue(json({ error: code, detail: options.adminSecret }, status as number));
	// Act
	const error = await coordinatorQualifyOwnerAction({
		...options,
		confirmEvidenceDigest: digest,
	}).catch((value: unknown) => value);
	// Assert
	expect(error).toBeInstanceOf(RemoteCoordinatorRequestError);
	expect(error).toMatchObject({ status, code });
	expect(publicError(error)).not.toContain(options.adminSecret);
	expect(error).not.toHaveProperty("cause");
	expect(fetchMock).toHaveBeenCalledOnce();
});

it.each(["preview", "confirm"])("%s redacts remote error-code credential echo", async (phase) => {
	// Arrange
	fetchMock.mockResolvedValue(
		json({ error: options.adminSecret, detail: options.adminSecret }, 500),
	);
	// Act
	const error = await coordinatorQualifyOwnerAction({
		...options,
		...(phase === "confirm" ? { confirmEvidenceDigest: digest } : {}),
	}).catch((value: unknown) => value);
	// Assert
	expectSafeFailure(
		error,
		phase === "confirm" ? "qualification_outcome_unknown" : "qualification_unavailable",
	);
	expect(fetchMock).toHaveBeenCalledOnce();
});

it.each(["preview", "confirm"])(
	"%s redacts transport exceptions including nested causes",
	async (phase) => {
		// Arrange
		fetchMock.mockRejectedValue(
			new Error(options.adminSecret, { cause: new Error(options.adminSecret) }),
		);
		// Act
		const error = await coordinatorQualifyOwnerAction({
			...options,
			...(phase === "confirm" ? { confirmEvidenceDigest: digest } : {}),
		}).catch((value: unknown) => value);
		// Assert
		expectSafeFailure(
			error,
			phase === "confirm" ? "qualification_outcome_unknown" : "qualification_unavailable",
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	},
);

it.each([
	"invalid-json",
	"invalid-json-200",
	"status-text",
	"unexpected-code",
	"redirect",
	"empty",
	"array",
])("%s cannot expose raw remote content or claim success", async (mode) => {
	// Arrange
	if (mode === "invalid-json")
		fetchMock.mockResolvedValue(new Response(options.adminSecret, { status: 500 }));
	else if (mode === "invalid-json-200")
		fetchMock.mockResolvedValue(new Response(options.adminSecret));
	else if (mode === "status-text") fetchMock.mockResolvedValue(json({}, 500, options.adminSecret));
	else if (mode === "unexpected-code")
		fetchMock.mockResolvedValue(json({ error: "unexpected-private-code" }, 409));
	else if (mode === "redirect")
		fetchMock.mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { Location: `https://other.example.test/${options.adminSecret}` },
			}),
		);
	else if (mode === "empty") fetchMock.mockResolvedValue(new Response(null));
	else fetchMock.mockResolvedValue(json([options.adminSecret]));
	// Act
	const error = await coordinatorQualifyOwnerAction({
		...options,
		confirmEvidenceDigest: digest,
	}).catch((value: unknown) => value);
	// Assert
	expectSafeFailure(error, "qualification_outcome_unknown");
	expect(publicError(error)).not.toContain("unexpected-private-code");
	expect(error).not.toHaveProperty("cause");
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
});

it.each([
	{ attestationId: "wrong" },
	{ attestationId: `${reference}\n` },
	{ confirmEvidenceDigest: "bad" },
	{ confirmEvidenceDigest: `${digest}\n` },
	{ adminSecret: "" },
])("invalid direct input %j cannot transmit credentials", async (change) => {
	// Arrange
	const input = { ...options, ...change };
	// Act
	const request = coordinatorQualifyOwnerAction(input);
	// Assert
	await expect(request).rejects.toThrow();
	expect(fetchMock).not.toHaveBeenCalled();
});
