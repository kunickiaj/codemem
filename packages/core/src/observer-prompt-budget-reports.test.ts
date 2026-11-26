import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayBatchExtraction } from "./extraction-replay.js";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";
import { MIN_OBSERVER_MAX_CHARS } from "./observer-prompt-budget.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

/*
 * Prompt budget reports count content fitted by its builder as clipped, the
 * configuration enforces a minimum budget, and tier-routed calls report per tier.
 */

const generate = vi.hoisted(() => vi.fn());
vi.mock("./opencode-v2-generation.js", async (importActual) => ({
	...(await importActual<typeof import("./opencode-v2-generation.js")>()),
	generateWithOpenCodeV2: generate,
}));

const SKIP = '<skip_summary reason="low-signal"/>';

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-prompt-budget-reports-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	vi.stubEnv("CODEMEM_OBSERVER_MAX_CHARS", undefined);
	generate.mockResolvedValue({ text: SKIP, error: null });
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	generate.mockReset();
	rmSync(home, { recursive: true, force: true });
});

function serviceObserver(settings: Record<string, unknown> = {}) {
	return new ObserverClient(
		loadObserverConfig({
			observer_runtime: "opencode_v2",
			observer_provider: "openai",
			observer_model: "gpt-5.6",
			...settings,
		}),
	);
}

function replayFixture(prompt: string): string {
	const dbPath = join(home, "replay.sqlite");
	const db = new Database(dbPath);
	try {
		initTestSchema(db);
		db.prepare(
			`INSERT INTO sessions(id, started_at, ended_at, cwd, project, user, tool_version, metadata_json)
			VALUES (500001, '2026-09-07T20:00:00Z', '2026-09-07T20:01:00Z', '/tmp/repo', 'codemem', 'test', 'test', '{}')`,
		).run();
		db.prepare(
			`INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at)
			VALUES ('opencode', 'budget', 'budget', 500001, '2026-09-07T20:00:00Z')`,
		).run();
		db.prepare(
			`INSERT INTO raw_event_flush_batches(id, source, stream_id, opencode_session_id, start_event_seq,
			end_event_seq, extractor_version, status, attempt_count, created_at, updated_at)
			VALUES (50001, 'opencode', 'budget', 'budget', 1, 1, 'raw_events_v1', 'completed', 1,
			'2026-09-07T20:00:00Z', '2026-09-07T20:01:00Z')`,
		).run();
		db.prepare(
			`INSERT INTO raw_events(source, stream_id, opencode_session_id, event_id, event_seq, event_type,
			ts_wall_ms, ts_mono_ms, payload_json, created_at)
			VALUES ('opencode', 'budget', 'budget', 'evt-budget', 1, 'user_prompt', 1000, 1, ?, '2026-09-07T20:00:00Z')`,
		).run(JSON.stringify({ type: "user_prompt", prompt_text: prompt }));
	} finally {
		db.close();
	}
	return dbPath;
}

describe("replay of a batch fitted to its budget", () => {
	it("reports the content length before fitting and counts it as clipped", async () => {
		const dbPath = replayFixture(`${"Explain the queue invalidation. ".repeat(420)}DONE`);

		const result = await replayBatchExtraction(dbPath, serviceObserver(), {
			batchId: 50001,
			scenarioId: "simple-batch-shape",
		});

		const budget = result.observer.promptBudget;
		expect(budget?.contentChars).toBeGreaterThan(13_000);
		expect(budget?.sentContentChars).toBeLessThanOrEqual(budget?.contentBudgetChars ?? 0);
		expect(budget?.contentClipped).toBe(true);
		const request = budget?.sections?.find((section) => section.name === "request");
		expect(request?.chars).toBeGreaterThan(13_000);
		expect(request?.sentChars).toBeLessThan(3_000);
	});
});

describe("minimum observer_max_chars", () => {
	it.each([
		["the config file", { observer_max_chars: 500 }, undefined],
		["the environment", {}, "800"],
	])("raises a value below the minimum from %s and says so", (_source, file, env) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		if (env) vi.stubEnv("CODEMEM_OBSERVER_MAX_CHARS", env);

		const config = loadObserverConfig(file);

		expect(config.observerMaxChars).toBe(MIN_OBSERVER_MAX_CHARS);
		expect(MIN_OBSERVER_MAX_CHARS).toBe(2_000);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(`is below the minimum of 2000; using 2000`),
		);
	});

	it("keeps a value at or above the minimum", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadObserverConfig({ observer_max_chars: 2_000 }).observerMaxChars).toBe(2_000);
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("observer_max_chars"));
	});
});

describe("tier-routed prompt budgets in live status", () => {
	it("keeps each tier's last prompt budget on the configured client", async () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-prompt-budget-tiers-"));
		const store = new MemoryStore(join(directory, "test.sqlite"));
		try {
			const observer = serviceObserver({
				observer_tier_routing_enabled: true,
				observer_simple_model: "gpt-5.6",
			});
			store.recordRawEvent({
				opencodeSessionId: "tiered",
				eventId: "prompt",
				eventType: "user_prompt",
				payload: { type: "user_prompt", prompt_text: "Check the queue" },
			});

			await flushRawEvents(store, { observer }, { opencodeSessionId: "tiered" }).catch(
				() => undefined,
			);

			const status = observer.getStatus();
			expect(generate).toHaveBeenCalledOnce();
			expect(status.promptBudget).toBeNull();
			expect(status.tierPromptBudgets?.simple).toMatchObject({
				maxChars: 12_000,
				contentClipped: false,
			});
			expect(status.tierPromptBudgets?.simple?.sections?.[0]?.name).toBe("request");
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
