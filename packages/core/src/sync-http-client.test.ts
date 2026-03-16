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
