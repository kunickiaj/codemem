import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ingestHook = await import(
	new URL("../../../../plugins/claude/scripts/ingest-hook.mjs", import.meta.url).href
);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

let root: string;
let env: Record<string, string>;
let payload: Record<string, unknown>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codemem-claude-ingest-hook-"));
	env = {
		HOME: root,
		CODEMEM_DB: join(root, "mem.sqlite"),
		CODEMEM_PROJECT: "codemem",
		CODEMEM_CLAUDE_HOOK_CONTEXT_DIR: join(root, "state"),
		CODEMEM_VIEWER_HOST: "127.0.0.1",
		CODEMEM_VIEWER_PORT: "38888",
	};
	payload = {
		hook_event_name: "UserPromptSubmit",
		session_id: "claude-session",
		prompt: "check the fixture",
		cwd: root,
		timestamp: "2026-08-16T00:00:00.000Z",
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});

describe("Claude ingest HTTP acknowledgements", () => {
	// A durable HTTP acknowledgement must not launch another ingest process.
	it.each([
		{ status: 202, body: { accepted: 1, queued: 1 } },
		{ status: 202, body: { accepted: 0, queued: 0 } },
		{ status: 200, body: { inserted: 1, skipped: 0 } },
		{ status: 200, body: { inserted: 0, skipped: 1 } },
	])("does not launch CLI fallback after HTTP $status $body", async ({ status, body }) => {
		// Arrange
		const fetchImpl = vi.fn(async () => jsonResponse(body, status));
		vi.stubGlobal("fetch", fetchImpl);
		const runFallback = vi.fn(() => true);

		// Act
		const result = await ingestHook.runClaudeIngestHook({
			env,
			readInput: async () => JSON.stringify(payload),
			runFallback,
			now: () => 0,
		});

		// Assert
		expect(result).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(runFallback).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "null", body: null },
		{ label: "array", body: [] },
		{ label: "primitive", body: true },
		{ label: "empty object", body: {} },
		{ label: "missing queued", body: { accepted: 1 } },
		{ label: "missing accepted", body: { queued: 1 } },
		{ label: "boolean accepted", body: { accepted: true, queued: 1 } },
		{ label: "string queued", body: { accepted: 1, queued: "1" } },
		{ label: "missing skipped", body: { inserted: 1 } },
		{ label: "missing inserted", body: { skipped: 1 } },
		{ label: "string inserted", body: { inserted: "1", skipped: 0 } },
		{ label: "boolean skipped", body: { inserted: 1, skipped: false } },
		{ label: "mixed shapes", body: { accepted: 1, skipped: 0 } },
		{ label: "malformed JSON", malformed: true },
		{ label: "HTTP failure with valid counts", body: { accepted: 1, queued: 1 }, status: 503 },
		{ label: "network failure", networkFailure: true },
	])("uses CLI fallback for $label", async ({ body, status, malformed, networkFailure }) => {
		// Arrange
		const fetchImpl = vi.fn(async () => {
			if (networkFailure) throw new Error("fixture connection failure");
			if (malformed) return new Response("{", { status: 202 });
			return jsonResponse(body, status ?? 202);
		});
		vi.stubGlobal("fetch", fetchImpl);
		const runFallback = vi.fn(() => true);

		// Act
		const result = await ingestHook.runClaudeIngestHook({
			env,
			readInput: async () => JSON.stringify(payload),
			runFallback,
			now: () => 0,
		});

		// Assert
		expect(result).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(runFallback).toHaveBeenCalledExactlyOnceWith(
			"codemem",
			["enqueue-raw-event"],
			expect.any(String),
			undefined,
		);
	});
});

describe("Claude ingest SessionEnd acknowledgements", () => {
	it.each([
		{ label: "queued", status: 202, body: { accepted: 1, queued: 1 } },
		{ label: "legacy", status: 200, body: { inserted: 1, skipped: 0 } },
	])("does not retry an accepted $label SessionEnd response", async ({ status, body }) => {
		// Arrange
		const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
			jsonResponse(body, status),
		);
		vi.stubGlobal("fetch", fetchImpl);
		const runFallback = vi.fn(() => true);

		// Act
		const result = await ingestHook.runClaudeIngestHook({
			env,
			readInput: async () => JSON.stringify({ ...payload, hook_event_name: "SessionEnd" }),
			runFallback,
			now: () => 0,
		});

		// Assert
		expect(result).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
			headers: { "X-Codemem-Boundary-Flush": "1" },
		});
		expect(runFallback).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "accepted", body: { accepted: 1, queued: 1 }, fallbackCalls: 0 },
		{ label: "invalid", body: { accepted: true, queued: 1 }, fallbackCalls: 1 },
	])("handles a $label enqueue-only SessionEnd retry", async ({ body, fallbackCalls }) => {
		// Arrange
		const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
			jsonResponse(body, 202),
		);
		fetchImpl.mockImplementationOnce(async () => {
			throw new Error("fixture boundary timeout");
		});
		vi.stubGlobal("fetch", fetchImpl);
		const runFallback = vi.fn(() => true);

		// Act
		const result = await ingestHook.runClaudeIngestHook({
			env,
			readInput: async () => JSON.stringify({ ...payload, hook_event_name: "SessionEnd" }),
			runFallback,
			now: () => 0,
		});

		// Assert
		expect(result).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const firstRequest = fetchImpl.mock.calls[0]?.[1];
		const retryRequest = fetchImpl.mock.calls[1]?.[1];
		expect(new Headers(firstRequest?.headers).get("X-Codemem-Boundary-Flush")).toBe("1");
		expect(new Headers(retryRequest?.headers).has("X-Codemem-Boundary-Flush")).toBe(false);
		expect(retryRequest?.body).toBe(firstRequest?.body);
		expect(runFallback).toHaveBeenCalledTimes(fallbackCalls);
	});
});
