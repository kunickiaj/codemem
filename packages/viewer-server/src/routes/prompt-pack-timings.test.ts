import { once } from "node:events";
import {
	MemoryStore,
	promptPackArtifactFingerprint,
	recordPromptPackArtifacts,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PROMPT_PACK_TIMING_HEADER,
	type PromptPackTimingOptions,
	type PromptPackTimingReport,
} from "../prompt-pack-timings.js";
import { packTransportRoutes } from "./pack.js";

vi.mock("@codemem/core", async (importOriginal) => {
	const core = await importOriginal<typeof import("@codemem/core")>();
	return {
		...core,
		promptPackArtifactFingerprint: vi.fn(core.promptPackArtifactFingerprint),
		recordPromptPackArtifacts: vi.fn(core.recordPromptPackArtifacts),
	};
});

const token = "a1234567-1234-4567-89ab-123456789abc";
const body = { context: "private-context-canary", all_projects: true };
const attempt = {
	attempt_id: "018f2db4-f9d3-7a22-8d18-000000000001",
	source: "opencode",
	request_id: "private-ledger-request-canary",
};
let store: MemoryStore;
let reports: PromptPackTimingReport[];
const report = (entry: PromptPackTimingReport) => {
	reports.push(entry);
};
const makeApp = (timings: PromptPackTimingOptions = { enabled: true, report }) =>
	new Hono().route(
		"/",
		packTransportRoutes(() => store, { timings }),
	);
const post = (app: Hono, payload: unknown = body, header: string | undefined = token) =>
	app.request("/api/pack", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(header ? { [PROMPT_PACK_TIMING_HEADER]: header } : {}),
		},
		body: JSON.stringify(payload),
	});

beforeEach(() => {
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("HF_HUB_OFFLINE", "1");
	vi.stubEnv("CODEMEM_TRACE_PROMPT_PACK", "0");
	store = new MemoryStore(":memory:");
	reports = [];
});
afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("prompt pack route timing", () => {
	it.each([undefined, "private-invalid-token-canary"])(
		"ignores absent or invalid headers (%s) without changing builder options",
		async (header) => {
			// Arrange
			const app = makeApp();
			const build = vi.spyOn(store, "buildMemoryPackAsync");
			// Act
			const response = await post(app, body, header ?? "");
			// Assert
			expect(response.status).toBe(200);
			expect(Object.keys(build.mock.calls[0]?.[6] ?? {})).toEqual(["signal"]);
			expect(reports).toEqual([]);
		},
	);

	it("captures the environment flag at factory creation and respects explicit false", async () => {
		// Arrange
		vi.stubEnv("CODEMEM_TRACE_PROMPT_PACK", "1");
		const enabled = makeApp({ report });
		const disabled = makeApp({ enabled: false, report });
		vi.stubEnv("CODEMEM_TRACE_PROMPT_PACK", "0");
		// Act
		const responses = await Promise.all([post(enabled), post(disabled), post(makeApp({ report }))]);
		// Assert
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ outcome: "completed", request_id: token });
	});

	it.each([false, true])(
		"preserves response and ledger identity when attempt metadata exists: %s",
		async (withAttempt) => {
			// Arrange
			const payload = { ...body, ...(withAttempt ? { attempt } : {}) };
			const method = withAttempt ? "buildMemoryPackWithTraceAsync" : "buildMemoryPackAsync";
			const build = vi.spyOn(store, method);
			// Act
			const plain = await post(makeApp({ enabled: false, report }), payload);
			const timed = await post(makeApp(), payload);
			const plainBody = await plain.json();
			const timedBody = await timed.json();
			// Assert
			expect(timed.status).toBe(plain.status);
			expect(timedBody).toEqual(plainBody);
			expect(Object.keys(build.mock.calls[0]?.[6] ?? {})).toEqual(["signal"]);
			expect(build.mock.calls[1]?.[6]).toMatchObject({
				signal: expect.any(AbortSignal),
				onTiming: expect.any(Function),
			});
			expect(reports[0]?.timings_ms).toMatchObject({
				request_body: expect.any(Number),
				request_validation: expect.any(Number),
				pack_build: expect.any(Number),
				response_encode: expect.any(Number),
			});
			if (withAttempt) {
				expect(reports[0]?.timings_ms).toMatchObject({
					artifact_fingerprint: expect.any(Number),
					ledger_write: expect.any(Number),
				});
				expect(
					store.db
						.prepare("SELECT request_id FROM retrieval_attempts WHERE attempt_id = ?")
						.get(attempt.attempt_id),
				).toEqual({ request_id: attempt.request_id });
			}
			expect(JSON.stringify(reports)).not.toMatch(/private-|attempt_id|db_path|identity_target/);
		},
	);
});

describe("prompt pack timing failure and cancellation", () => {
	it.each(["validation", "identity", "build"])(
		"preserves %s errors while reporting only their status class",
		async (failure) => {
			// Arrange
			let payload: unknown = body;
			if (failure === "validation") payload = { ...body, limit: -1 };
			if (failure === "identity") vi.spyOn(store, "hasCurrentIdentity").mockReturnValue(false);
			if (failure === "build")
				vi.spyOn(store, "buildMemoryPackAsync").mockRejectedValue(
					new Error("private-error-canary"),
				);
			// Act
			const plain = await post(makeApp({ enabled: false, report }), payload);
			const timed = await post(makeApp(), payload);
			// Assert
			expect(timed.status).toBe({ build: 500, identity: 409, validation: 400 }[failure]);
			expect(await timed.json()).toEqual(await plain.json());
			expect(reports).toHaveLength(1);
			expect(reports[0]?.outcome).toBe(failure === "build" ? "failed" : "rejected");
			expect(JSON.stringify(reports)).not.toContain("private-");
		},
	);

	it("keeps fingerprint and ledger failures best-effort and leaves background ledger requests untraced", async () => {
		// Arrange
		vi.mocked(promptPackArtifactFingerprint).mockImplementationOnce(() => {
			throw new Error("private-fingerprint-canary");
		});
		vi.mocked(recordPromptPackArtifacts).mockImplementationOnce(() => {
			throw new Error("private-ledger-canary");
		});
		const app = makeApp();
		// Act
		const response = await post(app, { ...body, attempt });
		const ledger = await app.request("/api/prompt-pack-ledger", {
			method: "POST",
			headers: { "Content-Type": "application/json", [PROMPT_PACK_TIMING_HEADER]: token },
			body: "{}",
		});
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toHaveProperty("pack_text");
		expect(ledger.status).toBe(400);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			outcome: "completed",
			incomplete_stages: [],
			timings_ms: { artifact_fingerprint: expect.any(Number), ledger_write: expect.any(Number) },
		});
		expect(JSON.stringify(reports)).not.toContain("private-");
	});

	it("reports an HTTP disconnect while the builder is held and prevents late ledger writes", async () => {
		// Arrange: this server and its in-memory database belong only to this test.
		const artifacts = await store.buildMemoryPackWithTraceAsync(body.context, 10, null, {});
		const entered = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		vi.spyOn(store, "buildMemoryPackWithTraceAsync").mockImplementation(async (...args) => {
			const signal = args[6]?.signal;
			if (!signal) throw new Error("expected request cancellation signal");
			entered.resolve(signal);
			await release.promise;
			return artifacts;
		});
		const app = makeApp();
		const server = serve({
			fetch: async (request) => {
				try {
					return await app.fetch(request);
				} finally {
					completed.resolve();
				}
			},
			hostname: "127.0.0.1",
			port: 0,
		});
		const controller = new AbortController();
		try {
			if (!server.listening) await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing owned HTTP port");
			// Act
			const request = fetch(`http://127.0.0.1:${address.port}/api/pack`, {
				method: "POST",
				signal: controller.signal,
				headers: { "Content-Type": "application/json", [PROMPT_PACK_TIMING_HEADER]: token },
				body: JSON.stringify({ ...body, attempt }),
			}).catch((error: unknown) => error);
			const signal = await entered.promise;
			const aborted = once(signal, "abort");
			controller.abort();
			await aborted;
			// Assert: report emission cannot depend on the stalled builder settling.
			expect(reports).toHaveLength(1);
			expect(reports[0]?.outcome).toBe("aborted");
			expect(reports[0]?.incomplete_stages).toContain("pack_build");
			release.resolve();
			await completed.promise;
			await request;
			expect(reports).toHaveLength(1);
			expect(store.db.prepare("SELECT attempt_id FROM retrieval_attempts").all()).toEqual([]);
		} finally {
			controller.abort();
			release.resolve();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				}),
			);
		}
	});
});
