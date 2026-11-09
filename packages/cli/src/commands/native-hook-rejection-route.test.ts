import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViewerIdentityTarget, connect, initTestSchema, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rawEventsRoutes } from "../../../viewer-server/src/routes/raw-events.js";
import { classifyNativeHookHttpFailure as classify } from "./hook-delivery-outcome.js";

const cases = [
	{
		provider: "claude",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "fixture-session",
			prompt: "fixture prompt",
			timestamp: "2026-09-17T12:00:00.000Z",
		},
	},
	{
		provider: "codex",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "fixture-session",
			prompt: "fixture prompt",
			timestamp: "2026-09-17T12:00:00.000Z",
		},
	},
	{
		provider: "pi",
		payload: {
			piEvent: "session_start",
			sessionId: "fixture-session",
			ts: "2026-09-17T12:00:00.000Z",
		},
	},
] as const;
let home: string;
let store: MemoryStore;
let app: ReturnType<typeof rawEventsRoutes>;
let target: { db_path: string; identity_target: ReturnType<typeof buildViewerIdentityTarget> };

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-native-rejection-route-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_EMBEDDING_OFFLINE", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("unexpected network");
		}),
	);
	const dbPath = join(home, "fixture.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(dbPath);
	app = rawEventsRoutes(() => store, null);
	target = { db_path: dbPath, identity_target: buildViewerIdentityTarget() };
});

afterEach(async () => {
	store?.close();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
});

async function post(provider: string, body: string, headers: Record<string, string> = {}) {
	const response = await app.request(`/api/${provider}-hooks`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
	const responseBody: unknown = await response.json();
	return { status: response.status, responseBody, outgoingBytes: Buffer.byteLength(body, "utf8") };
}

it.each(cases)(
	"actual $provider rejects msg_ session IDs and accepts the control",
	async ({ provider, payload }) => {
		// Arrange: target fields and normalization are production implementations.
		const rejected = { ...payload, session_id: "msg_fixture", sessionId: "msg_fixture", ...target };
		// Act.
		const bad = await post(provider, JSON.stringify(rejected));
		const good = await post(provider, JSON.stringify({ ...payload, ...target }));
		// Assert.
		expect(bad).toMatchObject({ status: 400, responseBody: { error: "invalid session id" } });
		expect(classify(bad)).toEqual({ outcome: "terminal", status: 400, reason: "invalid_payload" });
		expect(good).toMatchObject({ status: 200, responseBody: { inserted: 1, skipped: 0 } });
		expect(classify(good)).toBeNull();
	},
);

it.each(cases)(
	"actual $provider parser and nested target errors remain retryable",
	async ({ provider, payload }) => {
		// Arrange: target validation must precede the invalid session ID.
		const nested = JSON.stringify({
			...payload,
			session_id: "msg_fixture",
			sessionId: "msg_fixture",
			db_path: store.dbPath,
		});
		// Act.
		const results = await Promise.all([
			post(provider, "{"),
			post(provider, "[]"),
			post(provider, "{}", { "content-length": "-1" }),
			post(provider, nested),
		]);
		// Assert: real 400 errors outside the one approved plain string cannot authorize retention.
		expect(results.map((result) => result.responseBody)).toEqual([
			{ error: "invalid json" },
			{ error: "payload must be an object" },
			{ error: "invalid content-length" },
			{
				error: {
					code: "invalid_request",
					message: "db_path and identity_target must be provided together",
				},
			},
		]);
		for (const result of results) {
			expect(result.status).toBe(400);
			expect(classify(result)).toBeNull();
		}
	},
);

it.each(cases)(
	"actual $provider counts full targeted UTF-8 bytes at N and N+1",
	async ({ provider, payload }) => {
		// Arrange: read the real route limit. Multibyte text distinguishes UTF-8 bytes from string length.
		const status = await app.request("/api/raw-events/status?limit=0");
		const diagnostics: unknown = await status.json();
		if (!diagnostics || typeof diagnostics !== "object" || !("ingest" in diagnostics)) {
			throw new Error("expected raw-event ingest diagnostics");
		}
		const ingest = diagnostics.ingest;
		if (!ingest || typeof ingest !== "object" || !("max_body_bytes" in ingest)) {
			throw new Error("expected the raw-event body limit");
		}
		const n = ingest.max_body_bytes;
		if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
			throw new Error("expected a positive safe integer body limit");
		}
		const initial = JSON.stringify({ ...payload, ...target, padding: "😀é" });
		const exact = initial + " ".repeat(n - Buffer.byteLength(initial, "utf8"));
		const bare = { ...payload, padding: "😀é" };
		bare.padding += " ".repeat(n - Buffer.byteLength(JSON.stringify(bare), "utf8"));
		// Act: exercise both streamed counting and the Content-Length fast rejection.
		const accepted = await post(provider, exact);
		const rejected = await post(provider, `${exact} `);
		const declared = await post(provider, `${exact} `, { "content-length": String(n + 1) });
		const bareAccepted = await post(provider, JSON.stringify(bare));
		const targetOverhead = await post(provider, JSON.stringify({ ...bare, ...target }));
		// Assert: adding targets alone can exceed the limit. Only the full transmitted bytes decide.
		expect(accepted.outgoingBytes).toBe(n);
		expect(accepted.status).toBe(200);
		expect(classify(accepted)).toBeNull();
		expect(bareAccepted.outgoingBytes).toBe(n);
		expect(bareAccepted.status).toBe(200);
		for (const result of [rejected, declared, targetOverhead]) {
			expect(result.status).toBe(413);
			expect(result.responseBody).toEqual({ error: "payload too large", max_bytes: n });
			expect(result.outgoingBytes).toBeGreaterThan(n);
			expect(classify(result)).toEqual({
				outcome: "terminal",
				status: 413,
				reason: "payload_too_large",
			});
		}
	},
);
