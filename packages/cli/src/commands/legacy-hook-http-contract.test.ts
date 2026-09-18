import { afterEach, describe, expect, it, vi } from "vitest";
import { tryHttpIngest as tryClaudeHttpIngest } from "./claude-hook-ingest.js";
import { tryHttpIngest as tryCodexHttpIngest } from "./codex-hook-ingest.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Claude hook HTTP contract", () => {
	it("accepts queued responses and forwards the boundary marker", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ accepted: 1, queued: 1 }), { status: 202 }));
		await expect(
			tryClaudeHttpIngest({ hook_event_name: "SessionEnd" }, "127.0.0.1", 38888, {
				flushBoundary: true,
			}),
		).resolves.toMatchObject({ ok: true, inserted: 0, skipped: 0, queued: 1 });
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
			"X-Codemem-Boundary-Flush": "1",
		});
	});

	it.each([
		["timeout", new DOMException("timed out", "AbortError"), "timeout"],
		["connection", new TypeError("fetch failed"), "connection"],
	] as const)("classifies %s failures", async (_, error, cause) => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
		await expect(tryClaudeHttpIngest({}, "127.0.0.1", 38888)).resolves.toMatchObject({
			ok: false,
			cause,
		});
	});

	it("classifies target mismatch and malformed responses", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { code: "viewer_db_mismatch" } }), { status: 409 }),
			)
			.mockResolvedValueOnce(new Response("not-json", { status: 202 }));
		await expect(tryClaudeHttpIngest({}, "127.0.0.1", 38888)).resolves.toMatchObject({
			cause: "http_status",
			status: 409,
			targetMismatch: true,
		});
		await expect(tryClaudeHttpIngest({}, "127.0.0.1", 38888)).resolves.toMatchObject({
			cause: "malformed_response",
		});
	});
});

describe("Codex hook HTTP contract", () => {
	it("accepts queued responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ accepted: 1, queued: 1 }), { status: 202 }),
				),
		);
		await expect(tryCodexHttpIngest({}, "127.0.0.1", 38888)).resolves.toMatchObject({
			ok: true,
			inserted: 0,
			skipped: 0,
			queued: 1,
		});
	});

	it.each([
		["timeout", new DOMException("timed out", "AbortError"), "timeout"],
		["connection", new TypeError("fetch failed"), "connection"],
	] as const)("classifies %s failures", async (_, error, cause) => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
		await expect(tryCodexHttpIngest({}, "127.0.0.1", 38888)).resolves.toMatchObject({
			ok: false,
			cause,
		});
	});

	it("classifies target mismatch and malformed responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: { code: "viewer_db_mismatch" } }), { status: 409 }),
				)
				.mockResolvedValueOnce(new Response("not-json", { status: 202 })),
		);
		await expect(tryCodexHttpIngest({}, "127.0.0.1", 38888)).resolves.toMatchObject({
			cause: "http_status",
			status: 409,
			targetMismatch: true,
		});
		await expect(tryCodexHttpIngest({}, "127.0.0.1", 38888)).resolves.toMatchObject({
			cause: "malformed_response",
		});
	});
});
