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
const ready = {
	state: "ready",
	attestation_id: reference,
	evidence_digest: digest,
	fingerprint: "c".repeat(64),
	coordinator_id: "coordinator-a",
	review_receipt_id: "receipt-a",
	link_id: "link-a",
	claim_id: "claim-a",
	identity_id: "identity-a",
	group_id: "group-a",
	device_id: "device-a",
};
const committed = {
	state: "created",
	qualification_id: "qualification-a",
	coordinator_id: "coordinator-a",
	attestation_id: reference,
	evidence_digest: digest,
};
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
		const response = { ...committed, state };
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

const requiredFields = [
	...Object.keys(ready).map((key) => ({ phase: "preview", key })),
	...Object.keys(committed).map((key) => ({ phase: "confirm", key })),
];
it.each(requiredFields)(
	"rejects missing $phase field $key from HTTP 200",
	async ({ phase, key }) => {
		// Arrange
		const response: Record<string, unknown> = { ...(phase === "preview" ? ready : committed) };
		delete response[key];
		response.private_detail = options.adminSecret;
		fetchMock.mockResolvedValue(json(response));
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
	{ phase: "preview", change: { state: "created" } },
	{ phase: "preview", change: { attestation_id: `controller-v1:${"d".repeat(64)}` } },
	{ phase: "preview", change: { evidence_digest: "B".repeat(64) } },
	{ phase: "preview", change: { evidence_digest: `${digest}\n` } },
	{ phase: "preview", change: { fingerprint: "short" } },
	{ phase: "preview", change: { fingerprint: 123 } },
	{ phase: "preview", change: { coordinator_id: "" } },
	{ phase: "preview", change: { review_receipt_id: " receipt " } },
	{ phase: "preview", change: { link_id: "link\ncontrol" } },
	{ phase: "preview", change: { claim_id: "claim\u200bhidden" } },
	{ phase: "preview", change: { identity_id: null } },
	{ phase: "preview", change: { group_id: "x".repeat(257) } },
	{ phase: "preview", change: { device_id: 123 } },
	{ phase: "confirm", change: { state: "ready" } },
	{ phase: "confirm", change: { state: "unknown" } },
	{ phase: "confirm", change: { qualification_id: "" } },
	{ phase: "confirm", change: { qualification_id: "id\u0000bad" } },
	{ phase: "confirm", change: { qualification_id: 123 } },
	{ phase: "confirm", change: { coordinator_id: "x".repeat(257) } },
	{ phase: "confirm", change: { coordinator_id: " coordinator " } },
	{ phase: "confirm", change: { attestation_id: `controller-v1:${"d".repeat(64)}` } },
	{ phase: "confirm", change: { evidence_digest: "d".repeat(64) } },
	{ phase: "confirm", change: { evidence_digest: "B".repeat(64) } },
])(
	"rejects malformed $phase fields $change without exposing response content",
	async ({ phase, change }) => {
		// Arrange
		fetchMock.mockResolvedValue(
			json({
				...(phase === "preview" ? ready : committed),
				...change,
				private_detail: options.adminSecret,
			}),
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

it.each(["preview", "confirm"])(
	"%s rejects error envelopes, not success with private error data",
	async (phase) => {
		// Arrange
		fetchMock.mockResolvedValue(
			json({ ...(phase === "preview" ? ready : committed), error: options.adminSecret }),
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

it.each(["preview", "confirm"])(
	"%s requires fields on the parsed JSON object, not inherited input",
	async (phase) => {
		// Arrange: JSON serialization omits inherited fields; the wire object has no own required fields.
		fetchMock.mockResolvedValue(json(Object.create(phase === "preview" ? ready : committed)));
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

it.each(["preview", "confirm"])(
	"%s returns only validated wire fields, dropping private extras",
	async (phase) => {
		// Arrange
		const expected = phase === "preview" ? ready : committed;
		fetchMock.mockResolvedValue(
			json({
				...expected,
				private_detail: options.adminSecret,
				extra: { cookie: options.adminSecret },
			}),
		);
		// Act
		const result = await coordinatorQualifyOwnerAction({
			...options,
			...(phase === "confirm" ? { confirmEvidenceDigest: digest } : {}),
		});
		// Assert
		expect(result).toEqual(expected);
		expect(JSON.stringify(result)).not.toContain(options.adminSecret);
		expect(fetchMock).toHaveBeenCalledOnce();
	},
);

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

it.each([
	{ phase: "preview", valid: true },
	{ phase: "preview", valid: false },
	{ phase: "confirm", valid: true },
	{ phase: "confirm", valid: false },
])(
	"$phase response remains bound to dispatched options after caller mutation (valid=$valid)",
	async ({ phase, valid }) => {
		// Arrange: mutate caller-owned options while fetch awaits its reply, without timers.
		const input: Parameters<typeof coordinatorQualifyOwnerAction>[0] = {
			...options,
			...(phase === "confirm" ? { confirmEvidenceDigest: digest } : {}),
		};
		const originalResponse = phase === "preview" ? ready : committed;
		fetchMock.mockImplementation(async () => {
			await Promise.resolve();
			input.attestationId = `controller-v1:${"d".repeat(64)}`;
			input.confirmEvidenceDigest = "e".repeat(64);
			if (valid) return json(originalResponse);
			return json({
				...originalResponse,
				attestation_id: input.attestationId,
				evidence_digest: input.confirmEvidenceDigest,
				private_detail: options.adminSecret,
			});
		});
		// Act
		const result = await coordinatorQualifyOwnerAction(input).catch((value: unknown) => value);
		// Assert
		if (valid) expect(result).toEqual(originalResponse);
		else
			expectSafeFailure(
				result,
				phase === "confirm" ? "qualification_outcome_unknown" : "qualification_unavailable",
			);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[1]?.body).toEqual(
			new TextEncoder().encode(
				JSON.stringify({
					attestation_id: reference,
					...(phase === "confirm" ? { confirm_evidence_digest: digest } : {}),
				}),
			),
		);
	},
);
