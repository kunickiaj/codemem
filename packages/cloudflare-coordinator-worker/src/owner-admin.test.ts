import {
	createInMemoryRequestRateLimiter,
	D1CoordinatorStore,
} from "@codemem/core/internal/cloudflare-coordinator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOwnerAdmin, isOwnerAdminPath } from "./owner-admin.js";

const CAPABILITY_PATH = "/v1/admin/owner-enrollment-capabilities";
const GRANT_PATH = "/v1/admin/identity-group-grants";
const ADMIN_SECRET = "test-only-admin-secret";
const START = { identity_id: "identity-a", group_id: "group-a" };

function fixture() {
	const prepare = vi.fn(() => {
		throw new Error("unexpected database access");
	});
	const grant = vi
		.spyOn(D1CoordinatorStore.prototype, "issueIdentityGroupGrantFromControllerAttestation")
		.mockResolvedValue({ kind: "rejected", error: "grant_authority_unavailable" });
	const options = {
		coordinatorId: "coordinator-a",
		adminSecret: ADMIN_SECRET as string | null,
		db: { prepare },
		limiter: createInMemoryRequestRateLimiter({ now: () => 0 }),
		issueCapability: vi
			.fn<(start: unknown) => Promise<string | null>>()
			.mockResolvedValue("test-only-capability"),
	};
	const check = vi.spyOn(options.limiter, "check");
	return { options, prepare, grant, check };
}

function request(path = CAPABILITY_PATH, init: RequestInit = {}) {
	return new Request(`https://coordinator.example.test${path}`, {
		method: "POST",
		body: JSON.stringify({ start: START }),
		...init,
		headers: init.headers ?? {
			"Content-Type": "application/json",
			"X-Codemem-Coordinator-Admin": ADMIN_SECRET,
		},
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("owner administration request boundary", () => {
	it.each([CAPABILITY_PATH, GRANT_PATH])("recognizes only the explicit admin path %s", (path) => {
		// Arrange
		const candidate = path;
		// Act
		const result = isOwnerAdminPath(candidate);
		// Assert
		expect(result).toBe(true);
	});

	it.each(["/v1/auth/callback", "/v1/auth/sign-in", `${CAPABILITY_PATH}/`, "/v1/admin/unknown"])(
		"does not turn %s into automatic owner issuance",
		async (path) => {
			// Arrange: sign-in and other non-admin paths cannot grant ownership.
			const f = fixture();
			const req = request(path);
			// Act
			const result = await handleOwnerAdmin(req, f.options);
			// Assert
			expect(result.status).toBe(404);
			expect(await result.json()).toEqual({ error: "not_found" });
			expect(req.bodyUsed).toBe(false);
			expect(f.options.issueCapability).not.toHaveBeenCalled();
			expect(f.grant).not.toHaveBeenCalled();
			expect(f.prepare).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ name: "missing configured secret", configured: null, supplied: ADMIN_SECRET },
		{ name: "empty configured secret", configured: "", supplied: ADMIN_SECRET },
		{ name: "missing header", configured: ADMIN_SECRET, supplied: null },
		{ name: "wrong secret", configured: ADMIN_SECRET, supplied: "incorrect-secret" },
		{ name: "oversized header", configured: ADMIN_SECRET, supplied: "x".repeat(8193) },
	])("rejects $name before reading a body, rate limiting or accessing D1", async (input) => {
		// Arrange: throwing if the body getter is touched proves authentication runs first.
		const f = fixture();
		f.options.adminSecret = input.configured;
		const headers = new Headers({ "Content-Type": "application/json" });
		if (input.supplied !== null) headers.set("X-Codemem-Coordinator-Admin", input.supplied);
		const req = request(GRANT_PATH, { headers });
		const bodyRead = vi.fn(() => {
			throw new Error("body must not be read");
		});
		Object.defineProperty(req, "body", { get: bodyRead });
		// Act
		const result = await handleOwnerAdmin(req, f.options);
		// Assert
		expect(result.status).toBe(401);
		expect(await result.json()).toEqual({ error: "unauthorized" });
		expect(bodyRead).not.toHaveBeenCalled();
		expect(f.check).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
		expect(f.grant).not.toHaveBeenCalled();
		expect(f.options.issueCapability).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "GET", path: CAPABILITY_PATH, init: { method: "GET", body: null }, status: 405 },
		{ name: "PUT", path: CAPABILITY_PATH, init: { method: "PUT" }, status: 405 },
		{ name: "query", path: `${CAPABILITY_PATH}?start=untrusted`, init: {}, status: 400 },
		{
			name: "Origin",
			path: CAPABILITY_PATH,
			init: {
				headers: {
					Origin: "https://coordinator.example.test",
					"X-Codemem-Coordinator-Admin": ADMIN_SECRET,
				},
			},
			status: 400,
		},
		{
			name: "missing content type",
			path: CAPABILITY_PATH,
			init: { headers: { "X-Codemem-Coordinator-Admin": ADMIN_SECRET } },
			status: 415,
		},
		{
			name: "text content type",
			path: CAPABILITY_PATH,
			init: {
				headers: { "Content-Type": "text/plain", "X-Codemem-Coordinator-Admin": ADMIN_SECRET },
			},
			status: 415,
		},
		{
			name: "wrong charset",
			path: CAPABILITY_PATH,
			init: {
				headers: {
					"Content-Type": "application/json; charset=latin1",
					"X-Codemem-Coordinator-Admin": ADMIN_SECRET,
				},
			},
			status: 415,
		},
	])(
		"rejects $name without reading the body or performing actions",
		async ({ path, init, status }) => {
			// Arrange
			const f = fixture();
			const req = request(path, init);
			// Act
			const result = await handleOwnerAdmin(req, f.options);
			// Assert
			expect(result.status).toBe(status);
			expect(req.bodyUsed).toBe(false);
			expect(f.options.issueCapability).not.toHaveBeenCalled();
			expect(f.grant).not.toHaveBeenCalled();
			expect(f.prepare).not.toHaveBeenCalled();
		},
	);
});

describe("explicit capability start payloads", () => {
	it.each(["application/json", "Application/JSON; charset=UTF-8"])(
		"issues a capability only for an authenticated explicit start with %s",
		async (contentType) => {
			// Arrange
			const f = fixture();
			const req = request(CAPABILITY_PATH, {
				headers: { "Content-Type": contentType, "X-Codemem-Coordinator-Admin": ADMIN_SECRET },
			});
			// Act
			const result = await handleOwnerAdmin(req, f.options);
			// Assert
			expect(result.status).toBe(200);
			expect(await result.json()).toEqual({ capability: "test-only-capability" });
			expect(f.options.issueCapability).toHaveBeenCalledExactlyOnceWith(START);
			expect(f.prepare).not.toHaveBeenCalled();
			expect(f.grant).not.toHaveBeenCalled();
			expect(result.headers.get("Cache-Control")).toBe("no-store");
			expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
			expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
		},
	);

	it.each([
		{ path: CAPABILITY_PATH, body: {} },
		{ path: CAPABILITY_PATH, body: { unknown: START } },
		{ path: CAPABILITY_PATH, body: { start: START, extra: true } },
		{ path: GRANT_PATH, body: { start: START } },
		{ path: GRANT_PATH, body: { attestation_id: 123 } },
		{ path: GRANT_PATH, body: { attestation_id: "attestation-a", identity_id: "identity-a" } },
		{ path: GRANT_PATH, body: { issuer: "google", subject: "signed-in-account" } },
		{ path: CAPABILITY_PATH, body: [] },
		{ path: CAPABILITY_PATH, body: null },
	])("rejects invalid or extra fields: $body on $path", async ({ path, body }) => {
		// Arrange: account sign-in evidence is not an explicit controller attestation.
		const f = fixture();
		// Act
		const result = await handleOwnerAdmin(request(path, { body: JSON.stringify(body) }), f.options);
		// Assert
		expect(result.status).toBe(400);
		expect(await result.json()).toEqual({ error: "invalid_request" });
		expect(f.options.issueCapability).not.toHaveBeenCalled();
		expect(f.grant).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
	});

	it.each([16384, 16385])("enforces the 16 KiB byte boundary at %i bytes", async (size) => {
		// Arrange: whitespace pads one valid object without a large checked-in fixture.
		const f = fixture();
		const json = JSON.stringify({ start: "é" });
		const body = json + " ".repeat(size - new TextEncoder().encode(json).byteLength);
		// Act
		const result = await handleOwnerAdmin(request(CAPABILITY_PATH, { body }), f.options);
		// Assert
		expect(result.status).toBe(size === 16384 ? 200 : 400);
		expect(f.options.issueCapability).toHaveBeenCalledTimes(size === 16384 ? 1 : 0);
		expect(f.prepare).not.toHaveBeenCalled();
	});

	it("cancels a streamed body once cumulative bytes exceed 16 KiB", async () => {
		// Arrange: each individual chunk is below the limit; their total is not.
		const f = fixture();
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(8192));
				controller.enqueue(new Uint8Array(8193));
			},
			cancel,
		});
		const req = request();
		Object.defineProperty(req, "body", { value: stream });
		// Act
		const result = await handleOwnerAdmin(req, f.options);
		// Assert
		expect(result.status).toBe(400);
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream.locked).toBe(false);
		expect(f.options.issueCapability).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
	});

	it("rejects a missing body without invoking an owner action", async () => {
		// Arrange
		const f = fixture();
		// Act
		const result = await handleOwnerAdmin(request(CAPABILITY_PATH, { body: null }), f.options);
		// Assert
		expect(result.status).toBe(400);
		expect(f.options.issueCapability).not.toHaveBeenCalled();
		expect(f.grant).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
	});

	it("returns 409 when the trusted issuer declines the start", async () => {
		// Arrange
		const f = fixture();
		f.options.issueCapability.mockResolvedValue(null);
		// Act
		const result = await handleOwnerAdmin(request(), f.options);
		// Assert
		expect(result.status).toBe(409);
		expect(await result.json()).toEqual({ error: "enrollment_unavailable" });
		expect(f.options.issueCapability).toHaveBeenCalledExactlyOnceWith(START);
		expect(f.grant).not.toHaveBeenCalled();
	});
});

describe("explicit attestation grants and failures", () => {
	it.each(["created", "existing"] as const)(
		"returns an explicit %s controller grant",
		async (kind) => {
			// Arrange: mock the store boundary; authority verification belongs to store tests.
			const f = fixture();
			const grant = {
				coordinator_id: "coordinator-a",
				identity_id: "identity-a",
				group_id: "group-a",
				status: "active" as const,
				revision: 1,
				source_kind: "controller_attestation" as const,
				source_receipt_id: "receipt-a",
				created_at: "2026-01-01T00:00:00.000Z",
				revoked_at: null,
			};
			f.grant.mockResolvedValue({ kind, grant });
			// Act
			const result = await handleOwnerAdmin(
				request(GRANT_PATH, { body: JSON.stringify({ attestation_id: "attestation-a" }) }),
				f.options,
			);
			// Assert
			expect(result.status).toBe(200);
			expect(await result.json()).toEqual({ kind, grant });
			expect(f.grant).toHaveBeenCalledExactlyOnceWith({
				coordinatorId: "coordinator-a",
				attestationId: "attestation-a",
			});
			expect(f.options.issueCapability).not.toHaveBeenCalled();
		},
	);

	it("returns 409 for unavailable controller authority without issuing a capability", async () => {
		// Arrange
		const f = fixture();
		// Act
		const result = await handleOwnerAdmin(
			request(GRANT_PATH, { body: JSON.stringify({ attestation_id: "untrusted-attestation" }) }),
			f.options,
		);
		// Assert
		expect(result.status).toBe(409);
		expect(await result.json()).toEqual({ kind: "rejected", error: "grant_authority_unavailable" });
		expect(f.options.issueCapability).not.toHaveBeenCalled();
	});

	it.each(["issuer", "store", "json", "utf8", "body"])(
		"returns a generic 503 for %s failure without exposing secrets",
		async (failure) => {
			// Arrange
			const f = fixture();
			const error = new Error(`${ADMIN_SECRET}: test-only-private-error`);
			let req = request();
			if (failure === "issuer") f.options.issueCapability.mockRejectedValue(error);
			if (failure === "store") {
				f.grant.mockRejectedValue(error);
				req = request(GRANT_PATH, { body: JSON.stringify({ attestation_id: "attestation-a" }) });
			}
			if (failure === "json") req = request(CAPABILITY_PATH, { body: "{" });
			if (failure === "utf8") req = request(CAPABILITY_PATH, { body: new Uint8Array([0xff]) });
			if (failure === "body")
				Object.defineProperty(req, "body", {
					get: () => {
						throw error;
					},
				});
			// Act
			const result = await handleOwnerAdmin(req, f.options);
			// Assert: exact payload excludes exception messages, credentials and stack traces.
			expect(result.status).toBe(503);
			expect(await result.json()).toEqual({ error: "enrollment_unavailable" });
		},
	);

	it("shares the 20-request limit across both actions in one coordinator, not across coordinators", async () => {
		// Arrange: freeze time to prevent token replenishment during the test.
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const f = fixture();
		const statuses: number[] = [];
		// Act
		for (let index = 0; index < 20; index++) {
			const req =
				index % 2 === 0
					? request()
					: request(GRANT_PATH, { body: JSON.stringify({ attestation_id: "attestation-a" }) });
			statuses.push((await handleOwnerAdmin(req, f.options)).status);
		}
		const deniedRequest = request();
		const denied = await handleOwnerAdmin(deniedRequest, f.options);
		const other = await handleOwnerAdmin(request(), {
			...f.options,
			coordinatorId: "coordinator-b",
		});
		// Assert
		expect(statuses).toEqual(
			Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 200 : 409)),
		);
		expect(denied.status).toBe(429);
		expect(await denied.json()).toEqual({ error: "rate_limited" });
		expect(deniedRequest.bodyUsed).toBe(false);
		expect(other.status).toBe(200);
		expect(f.options.issueCapability).toHaveBeenCalledTimes(11);
		expect(f.grant).toHaveBeenCalledTimes(10);
		expect(f.check).toHaveBeenCalledWith(JSON.stringify(["owner-admin", "coordinator-a"]), 20);
		expect(f.check).toHaveBeenCalledWith(JSON.stringify(["owner-admin", "coordinator-b"]), 20);
	});
});
