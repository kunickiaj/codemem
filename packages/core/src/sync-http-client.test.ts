import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";

// ---------------------------------------------------------------------------
// buildBaseUrl
// ---------------------------------------------------------------------------

describe("buildBaseUrl", () => {
	it("adds http:// when no scheme is present", () => {
		expect(buildBaseUrl("192.168.1.1:8080")).toBe("http://192.168.1.1:8080");
	});

	it("preserves https:// scheme", () => {
		expect(buildBaseUrl("https://peer.example.com")).toBe("https://peer.example.com");
	});

	it("preserves http:// scheme", () => {
		expect(buildBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
	});

	it("trims whitespace and trailing slashes", () => {
		expect(buildBaseUrl("  http://host:9000///  ")).toBe("http://host:9000");
	});

	it("returns empty string for empty/blank input", () => {
		expect(buildBaseUrl("")).toBe("");
		expect(buildBaseUrl("   ")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// requestJson (mocked fetch)
// ---------------------------------------------------------------------------

describe("requestJson", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns parsed JSON on success", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			status: 200,
			text: () => Promise.resolve(JSON.stringify({ ok: true, count: 5 })),
		});

		const [status, body] = await requestJson("POST", "http://localhost:8080/push", {
			body: { ops: [] },
		});

		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, count: 5 });

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe("http://localhost:8080/push");
		expect(call[1].method).toBe("POST");
		expect(call[1].headers["Content-Type"]).toBe("application/json");
	});

	it("returns null body for empty response", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			status: 204,
			text: () => Promise.resolve(""),
		});

		const [status, body] = await requestJson("GET", "http://localhost:8080/status");
		expect(status).toBe(204);
		expect(body).toBeNull();
	});

	it("handles non-JSON response gracefully", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			status: 502,
			text: () => Promise.resolve("<html>Bad Gateway</html>"),
		});

		const [status, body] = await requestJson("GET", "http://localhost:8080/health");
		expect(status).toBe(502);
		expect(body).not.toBeNull();
		expect(body?.error).toMatch(/^non_json_response:/);
		expect(body?.error).toContain("Bad Gateway");
	});

	it("handles unexpected JSON type (array)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			status: 200,
			text: () => Promise.resolve("[1, 2, 3]"),
		});

		const [status, body] = await requestJson("GET", "http://localhost:8080/list");
		expect(status).toBe(200);
		expect(body).toEqual({ error: "unexpected_json_type: array" });
	});

	it("sets Accept header and omits Content-Type for bodyless requests", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			status: 200,
			text: () => Promise.resolve("{}"),
		});

		await requestJson("GET", "http://localhost:8080/info");
		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].headers.Accept).toBe("application/json");
		expect(call[1].headers["Content-Type"]).toBeUndefined();
	});

	it("passes custom headers", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			status: 200,
			text: () => Promise.resolve("{}"),
		});

		await requestJson("GET", "http://localhost:8080/auth", {
			headers: { Authorization: "Bearer tok" },
		});

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].headers.Authorization).toBe("Bearer tok");
	});
});

describe("requestJson direct-peer connection policy", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])(
		"closes recipient-bound direct-peer %s connections",
		async (method) => {
			// Arrange: recipient binding, not the HTTP method, selects isolation.
			const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
			globalThis.fetch = fetchMock;

			// Act
			await requestJson(method, "http://localhost:8080/sync", {
				headers: { "X-Codemem-Recipient": "peer-b" },
			});

			// Assert
			expect(new Headers(fetchMock.mock.calls[0][1].headers).get("connection")).toBe("close");
		},
	);

	it.each<Record<string, string>>([
		{ "x-codemem-recipient": "peer-b", connection: "keep-alive" },
		{ "X-CODEMEM-RECIPIENT": "peer-b", CONNECTION: "keep-alive" },
		{
			"x-CoDeMeM-ReCiPiEnT": "peer-b",
			Connection: "keep-alive",
			cOnNeCtIoN: "keep-alive",
		},
	])("overrides all caller Connection spellings for direct peers: %j", async (headers) => {
		// Arrange: duplicate spellings must not become a combined keep-alive/close value.
		const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
		globalThis.fetch = fetchMock;
		const originalHeaders = { ...headers };

		// Act
		await requestJson("POST", "http://localhost:8080/sync", { headers });

		// Assert
		const sentHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
		expect(
			Object.entries(sentHeaders)
				.filter(([name]) => name.toLowerCase() === "connection")
				.map(([, value]) => value),
		).toEqual(["close"]);
		expect(headers).toEqual(originalHeaders);
	});

	it.each([
		["ordinary", {}],
		["coordinator", { "X-Opencode-Signature": "v2:synthetic-signature" }],
		["admin", { Authorization: "Bearer synthetic-token" }],
	])("preserves %s connection policy without a recipient marker", async (_kind, authHeaders) => {
		// Arrange
		const fetchMock = vi.fn().mockImplementation(async () => new Response("{}"));
		globalThis.fetch = fetchMock;
		const headers = { ...authHeaders, cOnNeCtIoN: "keep-alive" };

		// Act
		await requestJson("GET", "http://localhost:8080/status", { headers });
		await requestJson("POST", "http://localhost:8080/status", { headers: authHeaders });

		// Assert: neither explicit keep-alive nor the absent-header default changes.
		expect(fetchMock.mock.calls[0][1].headers).toEqual({ Accept: "application/json", ...headers });
		expect(fetchMock.mock.calls[1][1].headers).toEqual({
			Accept: "application/json",
			...authHeaders,
		});
	});

	it("preserves direct-peer authentication headers and exact supplied body bytes", async () => {
		// Arrange: noncanonical whitespace detects accidental JSON reserialization.
		const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
		globalThis.fetch = fetchMock;
		const bodyBytes = new TextEncoder().encode('{ "ops": [], "label": "sample" }\n');
		const originalBytes = bodyBytes.slice();
		const headers = {
			"X-Codemem-Recipient": "peer-b",
			"X-Codemem-Signature": "v3:synthetic-signature",
			"X-Opencode-Signature": "v2:synthetic-signature",
			"X-Opencode-Timestamp": "1700000000",
			"X-Opencode-Nonce": "synthetic-nonce",
		};

		// Act
		const result = await requestJson("POST", "http://localhost:8080/sync", {
			headers,
			body: { ignored: true },
			bodyBytes,
		});

		// Assert
		expect(result).toEqual([200, { ok: true }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const sent = fetchMock.mock.calls[0][1];
		expect(sent.headers).toMatchObject({
			...headers,
			"Content-Type": "application/json",
			"Content-Length": String(bodyBytes.byteLength),
		});
		expect(sent.body).toBe(bodyBytes);
		expect(bodyBytes).toEqual(originalBytes);
	});

	it("propagates a failed direct-peer POST without blindly retrying", async () => {
		// Arrange: the receiver may already have applied a POST when transport fails.
		const failure = new TypeError("synthetic socket failure");
		const fetchMock = vi.fn().mockRejectedValue(failure);
		globalThis.fetch = fetchMock;

		// Act
		const result = requestJson("POST", "http://localhost:8080/sync", {
			headers: { "X-Codemem-Recipient": "peer-b" },
			body: { ops: [] },
		});

		// Assert
		await expect(result).rejects.toBe(failure);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("requestJson admin redirect policy", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each([
		"X-Codemem-Coordinator-Admin",
		"x-codemem-coordinator-admin",
		"X-CoDeMeM-CoOrDiNaToR-AdMiN",
	])("rejects redirects for credential header %s", async (name) => {
		// Arrange: header presence selects the policy, regardless of casing.
		const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
		globalThis.fetch = fetchMock;
		const headers = { [name]: "synthetic-admin-secret", Connection: "keep-alive" };
		const originalHeaders = { ...headers };

		// Act
		const result = await requestJson("POST", "http://localhost:8080/admin", {
			headers,
			body: { action: "sample" },
		});

		// Assert: do not strip credentials or change non-peer connection policy.
		expect(result).toEqual([200, { ok: true }]);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({
			redirect: "error",
			headers,
		});
		expect(headers).toEqual(originalHeaders);
	});

	it("uses header presence even when the admin credential is empty", async () => {
		// Arrange
		const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
		globalThis.fetch = fetchMock;

		// Act
		await requestJson("GET", "http://localhost:8080/admin", {
			headers: { "X-Codemem-Coordinator-Admin": "" },
		});

		// Assert
		expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
	});

	it.each<Record<string, string>>([
		{},
		{ "X-Codemem-Coordinator-Admin-Actor": "synthetic-audit-actor" },
		{ "X-Opencode-Signature": "v2:synthetic-signature" },
		{ "X-Codemem-Recipient": "peer-b", "X-Codemem-Signature": "v3:synthetic-signature" },
		{ Authorization: "Bearer synthetic-legacy-token" },
	])("keeps legacy redirect following without the admin header: %j", async (headers) => {
		// Arrange
		const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
		globalThis.fetch = fetchMock;

		// Act
		await requestJson("GET", "http://localhost:8080/status", { headers });

		// Assert: absent redirect uses fetch's existing follow default.
		expect([undefined, "follow"]).toContain(fetchMock.mock.calls[0][1].redirect);
	});
});

describe("requestJson response limits and timeouts", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("rounds fractional timeout seconds to integer milliseconds", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			status: 200,
			text: () => Promise.resolve("{}"),
		});
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);

		await requestJson("GET", "http://localhost:8080/info", { timeoutS: 1.001 });

		expect(timeout).toHaveBeenCalledWith(1_001);
	});

	it("rejects a declared response larger than the configured limit", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("{}", {
				status: 200,
				headers: { "content-length": "100" },
			}),
		);

		await expect(
			requestJson("GET", "http://localhost:8080/info", { maxResponseBytes: 10 }),
		).resolves.toEqual([200, { error: "response_too_large" }]);
	});

	it("stops reading a streamed response after the configured limit", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response("123456", { status: 200 }));

		await expect(
			requestJson("GET", "http://localhost:8080/info", { maxResponseBytes: 5 }),
		).resolves.toEqual([200, { error: "response_too_large" }]);
	});

	it("accepts a response exactly at the configured limit", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

		await expect(
			requestJson("GET", "http://localhost:8080/info", { maxResponseBytes: 2 }),
		).resolves.toEqual([200, {}]);
	});
});
