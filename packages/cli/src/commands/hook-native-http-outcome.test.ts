import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { tryHttpIngest as claudeHttp } from "./claude-hook-ingest.js";
import { tryHttpIngest as codexHttp } from "./codex-hook-ingest.js";
import { classifyNativeHookHttpFailure as classify } from "./hook-delivery-outcome.js";
import { ingestPiHookPayload } from "./pi-hook-ingest.js";

vi.mock("./claude-hook-plugin-log.js", () => ({ logHookEvent: vi.fn() }));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
const invalid = { error: "invalid session id" };
const oversized = { error: "payload too large", max_bytes: 64 };
const terminal400 = { outcome: "terminal", status: 400, reason: "invalid_payload" };
const terminal413 = { outcome: "terminal", status: 413, reason: "payload_too_large" };

function capturedRequest(calls: Parameters<typeof fetch>[]): RequestInit & { body: string } {
	const init = calls[0]?.[1];
	if (!init || typeof init.body !== "string") throw new Error("expected a serialized request body");
	return { ...init, body: init.body };
}

it.each([
	{ status: 400, responseBody: invalid, outgoingBytes: 64, expected: terminal400 },
	{ status: 413, responseBody: oversized, outgoingBytes: 65, expected: terminal413 },
])("classifies the exact native rejection with status $status", ({ expected, ...input }) => {
	// Arrange / Act.
	const result = classify(input);
	// Assert.
	expect(result).toEqual(expected);
});

it.each([
	...[
		"invalid json",
		"payload must be an object",
		"invalid content-length",
		"event_id required",
		"Invalid session id",
		"invalid session id ",
	].map((error) => ({ status: 400, responseBody: { error }, outgoingBytes: 100 })),
	...[401, 403, 409, 429, 500, 302].map((status) => ({
		status,
		responseBody: invalid,
		outgoingBytes: 100,
	})),
	...[
		null,
		[],
		"invalid session id",
		{ error: { code: "invalid_request", message: "invalid session id" } },
		{ ...invalid, detail: "unexpected" },
	].map((responseBody) => ({ status: 400, responseBody, outgoingBytes: 100 })),
	...[
		0,
		-1,
		1.5,
		"64",
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
		undefined,
	].map((max_bytes) => ({
		status: 413,
		responseBody: { ...oversized, max_bytes },
		outgoingBytes: 100,
	})),
	...[63, 64, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(
		(outgoingBytes) => ({ status: 413, responseBody: oversized, outgoingBytes }),
	),
	{ status: 400, responseBody: invalid, outgoingBytes: 100, redirected: true },
	{ status: 413, responseBody: oversized, outgoingBytes: 100, redirected: true },
	{ status: 413, responseBody: { ...oversized, detail: "unexpected" }, outgoingBytes: 100 },
])("keeps unproven native rejection retryable: %j", (input) => {
	// Arrange / Act.
	const result = classify(input);
	// Assert.
	expect(result).toBeNull();
});

const payload = {
	session_id: "msg_fixture",
	prompt: "😀é",
	db_path: "fixture.sqlite",
	identity_target: { fixture: true },
};
it.each([
	{ provider: "claude", http: claudeHttp },
	{ provider: "codex", http: codexHttp },
])(
	"$provider measures its serialized UTF-8 body and preserves HTTP behavior",
	async ({ provider, http }) => {
		// Arrange: byte count exceeds JS string length. A character-count implementation would miss this rejection.
		const body = JSON.stringify(payload);
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			Response.json({ error: "payload too large", max_bytes: body.length }, { status: 413 }),
		);
		vi.stubGlobal("fetch", fetchImpl);
		// Act.
		const result = await http(payload, "127.0.0.1", 38888);
		// Assert: metadata is additive. Neither request policy nor the old boolean result changes.
		expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
		expect(result).toMatchObject({
			ok: false,
			inserted: 0,
			skipped: 0,
			failureOutcome: terminal413,
		});
		expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
			`http://127.0.0.1:38888/api/${provider}-hooks`,
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			}),
		);
		expect(capturedRequest(fetchImpl.mock.calls).redirect).toBe(
			provider === "codex" ? "manual" : undefined,
		);
	},
);

it.each([
	{ provider: "claude", http: claudeHttp },
	{ provider: "codex", http: codexHttp },
])("$provider adds terminal metadata only to proven failures", async ({ http }) => {
	// Arrange: cover exact 400, nested targets, redirects, malformed replies, and existing acceptance.
	const redirected = Response.json(invalid, { status: 400 });
	Object.defineProperty(redirected, "redirected", { value: true });
	const fetchImpl = vi
		.fn()
		.mockResolvedValueOnce(Response.json(invalid, { status: 400 }))
		.mockResolvedValueOnce(
			Response.json(
				{ error: { code: "viewer_db_mismatch", message: "invalid session id" } },
				{ status: 409 },
			),
		)
		.mockResolvedValueOnce(redirected)
		.mockResolvedValueOnce(new Response("not JSON", { status: 400 }))
		.mockResolvedValueOnce(Response.json({ inserted: 1, skipped: 0 }));
	vi.stubGlobal("fetch", fetchImpl);
	// Act.
	const results = [];
	for (let i = 0; i < 5; i++) results.push(await http(payload, "127.0.0.1", 38888));
	// Assert.
	expect(results[0]).toMatchObject({ ok: false, failureOutcome: terminal400 });
	expect(results[1]).toMatchObject({ ok: false, targetMismatch: true });
	for (const result of results.slice(1)) expect(result).not.toHaveProperty("failureOutcome");
	expect(results[4]).toMatchObject({ ok: true, inserted: 1, skipped: 0 });
});

it.each([400, 413])(
	"Pi public ingest preserves ordinary spool fallback for HTTP %s without activation",
	async (status) => {
		// Arrange: Pi's HTTP helper remains private. Exercise its real request through the public entrypoint.
		const dir = mkdtempSync(join(tmpdir(), "codemem-pi-http-outcome-"));
		vi.stubEnv("HOME", dir);
		vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
		vi.stubEnv("CODEMEM_PI_HOOK_SPOOL_DIR", dir);
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			Response.json(status === 400 ? invalid : { ...oversized, max_bytes: 1 }, { status }),
		);
		vi.stubGlobal("fetch", fetchImpl);
		const directIngest = vi.fn();
		const live = {
			piEvent: "session_start",
			sessionId: "fixture-session",
			ts: "2026-09-17T12:00:00.000Z",
			text: "😀é",
		};
		try {
			// Act.
			const result = await ingestPiHookPayload(
				live,
				{ host: "127.0.0.1", port: 38888 },
				{ resolveDb: () => join(dir, "test.sqlite"), directIngest },
			);
			// Assert: no automatic retainer or direct fallback was introduced for ordinary events.
			expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
			expect(directIngest).not.toHaveBeenCalled();
			const init = capturedRequest(fetchImpl.mock.calls);
			expect(init.headers).toEqual({ "Content-Type": "application/json" });
			expect(init.redirect).toBeUndefined();
			expect(JSON.parse(init.body)).toMatchObject({
				...live,
				db_path: join(dir, "test.sqlite"),
				identity_target: expect.any(Object),
			});
			const receipts = readdirSync(dir).filter((name) => name.endsWith(".json"));
			expect(receipts).toHaveLength(1);
			const receipt = receipts[0];
			if (receipt === undefined) throw new Error("expected the ordinary spool receipt");
			expect(JSON.parse(readFileSync(join(dir, receipt), "utf8"))).toEqual(live);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
