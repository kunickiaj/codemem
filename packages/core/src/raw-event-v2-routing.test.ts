import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { loadObserverConfig, ObserverAuthError, ObserverClient } from "./observer-client.js";
import { flushRawEvents, observerForRawEvents, oneHostGeneration } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

const generate = vi.hoisted(() => vi.fn());
vi.mock("./opencode-v2-generation.js", async (importActual) => ({
	...(await importActual<typeof import("./opencode-v2-generation.js")>()),
	generateWithOpenCodeV2: generate,
}));

let dir: string;
let configPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-v2-routing-"));
	configPath = join(dir, "config.json");
});

afterEach(() => {
	vi.unstubAllEnvs();
	generate.mockReset();
	rmSync(dir, { recursive: true, force: true });
});

function options(saved: Record<string, unknown> = {}): IngestOptions {
	writeFileSync(configPath, JSON.stringify(saved));
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	return { observer: new ObserverClient(loadObserverConfig(saved)) };
}

it("auto-routes only marked V2 events while retaining exact provider and model", () => {
	const original = options({ observer_provider: "openai", observer_model: "gpt-6-luna" });
	const v2 = observerForRawEvents([{ codemem_host_generation: "v2" }], original, "opencode");
	expect(v2.observer.runtime).toBe("opencode_v2");
	expect(v2.observer.provider).toBe("openai");
	expect(v2.observer.model).toBe("gpt-6-luna");
	expect(observerForRawEvents([{}], original, "opencode")).toBe(original);
	expect(observerForRawEvents([{ codemem_host_generation: "v2" }, {}], original, "opencode")).toBe(
		original,
	);
});

it("retains an explicitly chosen sidecar, API key, or custom endpoint", () => {
	for (const saved of [
		{ observer_runtime: "codex_sidecar" },
		{ observer_runtime: "api_http", observer_api_key: "synthetic-token" },
		{ observer_runtime: "api_http", observer_base_url: "http://localhost:1234" },
	]) {
		const original = options(saved);
		expect(observerForRawEvents([{ codemem_host_generation: "v2" }], original, "opencode")).toBe(
			original,
		);
	}
});

it("does not bypass an explicit Anthropic endpoint environment override", () => {
	vi.stubEnv("CODEMEM_ANTHROPIC_ENDPOINT", "http://localhost:1234");
	const original = options({ observer_provider: "anthropic", observer_model: "claude-sonnet-4-6" });
	expect(observerForRawEvents([{ codemem_host_generation: "v2" }], original, "opencode")).toBe(
		original,
	);
});

it("allows a saved api_http runtime using implicit OpenCode OAuth to migrate", () => {
	const original = options({ observer_runtime: "api_http", observer_model: "gpt-5.6-luna" });
	expect(
		observerForRawEvents([{ codemem_host_generation: "v2" }], original, "opencode").observer
			.runtime,
	).toBe("opencode_v2");
});

it("splits a stream at each host-generation transition instead of mixing credentials", () => {
	const legacy = { event_seq: 0 };
	const v2 = { event_seq: 1, codemem_host_generation: "v2" };
	expect(oneHostGeneration([legacy, v2])).toEqual([legacy]);
	expect(oneHostGeneration([v2, legacy])).toEqual([v2]);
	expect(oneHostGeneration([v2, { ...v2, event_seq: 2 }])).toHaveLength(2);
});

it("holds a rejected V2 model without spending attempts or advancing the stream cursor", async () => {
	const original = options({ observer_runtime: "api_http", observer_model: "gpt-5.6-luna" });
	generate.mockResolvedValue({ text: null, error: "model_unavailable" });
	const path = join(dir, "test.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	const store = new MemoryStore(path);
	try {
		for (const [eventId, eventType] of [
			["first", "user_prompt"],
			["second", "tool.execute.after"],
		]) {
			store.recordRawEvent({
				opencodeSessionId: "v2-session",
				eventId,
				eventType,
				payload: {
					type: eventType,
					prompt_text: "Inspect the file and summarize the result",
					tool: "read",
					args: { filePath: "fixture.ts" },
					codemem_host_generation: "v2",
				},
				tsWallMs: Date.now(),
			});
		}
		await expect(
			flushRawEvents(store, original, {
				opencodeSessionId: "v2-session",
				source: "opencode",
				maxEvents: 100,
			}),
		).rejects.toBeInstanceOf(ObserverAuthError);
		const batch = store.db
			.prepare(
				"SELECT status, attempt_count, observer_error_code FROM raw_event_flush_batches ORDER BY id DESC LIMIT 1",
			)
			.get() as { status: string; attempt_count: number; observer_error_code: string };
		expect(batch).toMatchObject({
			status: "failed",
			attempt_count: 0,
			observer_error_code: "model_unavailable",
		});
		expect(store.rawEventFlushState("v2-session", "opencode")).toBe(-1);
	} finally {
		store.close();
	}
});
