import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	coordinatorGrantIdentityGroupAction,
	RemoteCoordinatorRequestError,
} from "./coordinator-actions.js";
import {
	isCoordinatorControllerAttestationReference,
	parseCoordinatorIdentityGroupGrantResponse,
} from "./coordinator-identity-group-grant-client.js";

const reference = `controller-v1:${"a".repeat(64)}`;
const options = {
	remoteUrl: "https://coordinator.example.test",
	adminSecret: "fixture-admin-secret",
	attestationId: reference,
};
const grant = {
	coordinator_id: "coordinator-a",
	identity_id: "identity-a",
	group_id: "group-a",
	status: "active",
	revision: 1,
	source_kind: "controller_attestation",
	source_receipt_id: "review-receipt-a",
	created_at: "2026-10-02T12:00:00.000Z",
	revoked_at: null,
};

describe("controller attestation reference", () => {
	it("accepts the exact stored lowercase reference", () => {
		// Arrange
		const input = reference;
		// Act
		const valid = isCoordinatorControllerAttestationReference(input);
		// Assert
		expect(valid).toBe(true);
	});
	it.each([
		undefined,
		null,
		42,
		"",
		`review-v1:${"a".repeat(64)}`,
		`controller-v1:${"A".repeat(64)}`,
		`controller-v1:${"g".repeat(64)}`,
		`controller-v1:${"a".repeat(63)}`,
		`controller-v1:${"a".repeat(65)}`,
		`${reference}\n`,
		` ${reference}`,
	])("rejects malformed reference %j", (input) => {
		// Arrange / Act
		const valid = isCoordinatorControllerAttestationReference(input);
		// Assert
		expect(valid).toBe(false);
	});
});

describe("identity-group grant response validation", () => {
	it.each(["created", "existing"])("returns only validated %s grant fields", (kind) => {
		// Arrange: unrelated server fields must not escape the client boundary.
		const payload = {
			kind,
			grant: { ...grant, credential: "private-remote-value" },
			secret: "private",
		};
		// Act
		const result = parseCoordinatorIdentityGroupGrantResponse(payload);
		// Assert
		expect(result).toEqual({ kind, grant });
	});
	it.each([
		null,
		{},
		{ kind: "created" },
		{ kind: "created", grant: [] },
		{ kind: "created", grant: null },
		{ kind: "created", grant: "invalid" },
		{ kind: "rejected", grant },
		{ kind: "preview", grant },
	])("rejects malformed envelope %j", (payload) => {
		// Arrange / Act
		const parse = () => parseCoordinatorIdentityGroupGrantResponse(payload);
		// Assert
		expect(parse).toThrow("identity_group_grant_response_invalid");
	});
	it.each([
		{ coordinator_id: "" },
		{ coordinator_id: "wrong\ncoordinator" },
		{ coordinator_id: "x".repeat(257) },
		{ identity_id: " identity-a" },
		{ group_id: null },
		{ source_receipt_id: "" },
		{ source_receipt_id: "receipt\u0000" },
		{ status: "revoked" },
		{ status: "stale" },
		{ status: "pending" },
		{ source_kind: "invitation" },
		{ source_kind: undefined },
		{ revision: 0 },
		{ revision: -1 },
		{ revision: 1.5 },
		{ revision: "1" },
		{ revision: Number.MAX_SAFE_INTEGER + 1 },
		{ revision: Number.NaN },
		{ created_at: "not-a-date" },
		{ created_at: "" },
		{ revoked_at: "2026-10-03T00:00:00Z" },
		{ revoked_at: undefined },
	])("rejects invalid grant fields %j", (change) => {
		// Arrange
		const payload = { kind: "created", grant: { ...grant, ...change } };
		// Act
		const parse = () => parseCoordinatorIdentityGroupGrantResponse(payload);
		// Assert
		expect(parse).toThrow("identity_group_grant_response_invalid");
	});
});

describe("explicit admin grant transport", () => {
	const fetchMock = vi.fn<typeof fetch>();
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => vi.unstubAllGlobals());

	it.each(["created", "existing"])("POSTs only the stored reference for %s", async (kind) => {
		// Arrange: caller extras cannot nominate an Identity/group or admin actor.
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ kind, grant }), { status: kind === "created" ? 201 : 200 }),
		);
		const input = { ...options, identityId: "attacker", groupId: "attacker", actorId: "attacker" };
		// Act
		const result = await coordinatorGrantIdentityGroupAction(input);
		// Assert
		expect(result).toEqual({ kind, grant });
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			"https://coordinator.example.test/v1/admin/identity-group-grants",
			expect.objectContaining({
				method: "POST",
				redirect: "error",
				body: new TextEncoder().encode(JSON.stringify({ attestation_id: reference })),
			}),
		);
		const init = fetchMock.mock.calls[0]?.[1];
		const headers = new Headers(init?.headers);
		expect(headers.get("X-Codemem-Coordinator-Admin")).toBe(options.adminSecret);
		expect(headers.get("X-Codemem-Coordinator-Admin-Actor")).toBeNull();
		expect(headers.get("Authorization")).toBeNull();
		expect(JSON.stringify(result)).not.toContain(options.adminSecret);
	});

	it.each([
		{ attestationId: "wrong-reference" },
		{ adminSecret: "" },
		{ remoteUrl: "http://remote.example.test" },
		{ remoteUrl: "https://user:password@example.test" },
		{ remoteUrl: "https://coordinator.example.test/path" },
		{ remoteUrl: "https://coordinator.example.test?token=secret" },
	])("invalid input %j never sends credentials", async (change) => {
		// Arrange
		const input = { ...options, ...change };
		// Act
		const request = coordinatorGrantIdentityGroupAction(input);
		// Assert
		await expect(request).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[400, "invalid_grant_input"],
		[409, "grant_authority_unavailable"],
		[409, "enrollment_unavailable"],
		[401, "unauthorized"],
		[429, "rate_limited"],
	])("preserves supported rejection %s/%s without remote details", async (status, code) => {
		// Arrange: stale/revoked/wrong-coordinator evidence is rejected by server authority checks.
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: code, detail: options.adminSecret }), { status }),
		);
		// Act
		const error = await coordinatorGrantIdentityGroupAction(options).catch(
			(value: unknown) => value,
		);
		// Assert
		expect(error).toBeInstanceOf(RemoteCoordinatorRequestError);
		expect(error).toMatchObject({ status, code });
		expect(String(error)).not.toContain(options.adminSecret);
	});

	it.each(["remote-error", "fetch-error", "malformed-json", "malformed-grant"])(
		"redacts %s",
		async (mode) => {
			// Arrange
			const privateText = `private-cookie ${options.adminSecret}`;
			if (mode === "fetch-error") fetchMock.mockRejectedValue(new Error(privateText));
			else if (mode === "remote-error")
				fetchMock.mockResolvedValue(
					new Response(JSON.stringify({ error: privateText }), { status: 500 }),
				);
			else if (mode === "malformed-json") fetchMock.mockResolvedValue(new Response(privateText));
			else
				fetchMock.mockResolvedValue(
					new Response(
						JSON.stringify({ kind: "created", grant: { ...grant, status: privateText } }),
					),
				);
			// Act
			const error = await coordinatorGrantIdentityGroupAction(options).catch(
				(value: unknown) => value,
			);
			// Assert
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain("identity_group_grant_unavailable");
			expect(String(error)).not.toContain(privateText);
			expect(error).not.toHaveProperty("cause");
		},
	);

	it.each(["declared", "streamed"])("rejects a %s response exceeding 16KiB", async (mode) => {
		// Arrange: a valid grant plus untrusted padding must still obey the transport limit.
		const body = JSON.stringify({ kind: "created", grant, padding: "x".repeat(16384) });
		fetchMock.mockResolvedValue(
			new Response(body, {
				headers: mode === "declared" ? { "Content-Length": String(Buffer.byteLength(body)) } : {},
			}),
		);
		// Act
		const request = coordinatorGrantIdentityGroupAction(options);
		// Assert
		await expect(request).rejects.toThrow("identity_group_grant_unavailable");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
