import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import type { IngestPayload } from "./ingest-types.js";
import { buildMemoryPack } from "./pack.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

const OBSERVATION = `<observation><type>discovery</type><title>Token usage</title><narrative>😀漢字 usage must come from the provider.</narrative><facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation>`;

function payload(): IngestPayload {
	return {
		cwd: "/tmp/test-project",
		events: [
			{
				type: "user_prompt",
				prompt_text: "Record token usage",
				prompt_number: 1,
				timestamp: new Date().toISOString(),
			},
		],
		sessionContext: {
			source: "opencode",
			streamId: "token-usage-test",
			promptCount: 1,
			toolCount: 0,
			durationMs: 1,
		},
	};
}

function observer(
	raw: string | null,
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
	} | null,
	provider = "test",
) {
	return {
		observe: async () => ({ raw, parsed: null, provider, model: "test-model", usage }),
		getStatus: () => ({
			provider,
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	};
}

function structuredObserver(
	observeStructuredJson: () => Promise<{
		raw: string | null;
		parsed: null;
		provider: string;
		model: string;
		usage: { inputTokens: number; outputTokens: number } | null;
		usedStructuredOutputs: boolean;
		failureReason: null;
		transportFailureCode: string | null;
	}>,
) {
	return {
		provider: "openai",
		runtime: "api_http",
		outputMode: "json_schema",
		openaiUseResponses: true,
		hasCustomBaseUrl: false,
		observeStructuredJson,
		getStatus: () => ({
			provider: "openai",
			model: "test-model",
			runtime: "api_http",
			auth: { source: "env", type: "api_direct", hasToken: true },
		}),
	};
}

function latestUsage(store: MemoryStore) {
	return store.db
		.prepare(
			"SELECT tokens_read, tokens_written, metadata_json FROM usage_events WHERE event = 'observer_call' ORDER BY id DESC LIMIT 1",
		)
		.get() as {
		tokens_read: number | null;
		tokens_written: number | null;
		metadata_json: string;
	};
}

function usageCount(store: MemoryStore): number {
	const row = store.db
		.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE event = 'observer_call'")
		.get() as { count: number };
	return row.count;
}

describe("observer token usage persistence", { timeout: 15_000 }, () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-token-usage-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("persists provider-measured input and output token counts", async () => {
		await ingest(payload(), store, {
			observer: observer(OBSERVATION, { inputTokens: 10, outputTokens: 20 }),
			storeSummary: false,
		} as unknown as IngestOptions);

		const usage = latestUsage(store);
		expect(usage.tokens_read).toBe(10);
		expect(usage.tokens_written).toBe(20);
		expect(JSON.parse(usage.metadata_json).token_usage).toEqual({
			unit: "tokens",
			source: "provider",
			input_direction: "observer_input",
			output_direction: "observer_output",
			attempt_count: 1,
		});
		expect(usageCount(store)).toBe(1);
	});

	it.each([
		{
			provider: "anthropic",
			expectedInput: 23,
			description: "adds Anthropic cache token categories",
		},
		{
			provider: "openai",
			expectedInput: 10,
			description: "does not double-count OpenAI cached input",
		},
	])("$description", async ({ provider, expectedInput }) => {
		await ingest(payload(), store, {
			observer: observer(
				OBSERVATION,
				{
					inputTokens: 10,
					outputTokens: 20,
					cacheReadInputTokens: 8,
					cacheCreationInputTokens: 5,
				},
				provider,
			),
			storeSummary: false,
		} as unknown as IngestOptions);

		expect(latestUsage(store)).toMatchObject({
			tokens_read: expectedInput,
			tokens_written: 20,
		});
	});

	it("persists null counts when provider usage is unavailable", async () => {
		await ingest(payload(), store, {
			observer: observer(OBSERVATION, null),
			storeSummary: false,
		} as unknown as IngestOptions);

		const usage = latestUsage(store);
		expect(usage.tokens_read).toBeNull();
		expect(usage.tokens_written).toBeNull();
		expect(JSON.parse(usage.metadata_json).token_usage).toMatchObject({
			source: "unavailable",
			attempt_count: 1,
		});
	});

	it("sums usage across the initial and repair attempts", async () => {
		const lossy = `<summary><request>Repair output</request></summary>${OBSERVATION.slice(0, -14)}`;
		let calls = 0;
		const repairingObserver = observer(OBSERVATION, null);
		repairingObserver.observe = async () => {
			calls += 1;
			return {
				raw: calls === 1 ? lossy : OBSERVATION,
				parsed: null,
				provider: "test",
				model: "test-model",
				usage:
					calls === 1 ? { inputTokens: 11, outputTokens: 3 } : { inputTokens: 7, outputTokens: 2 },
			};
		};

		await ingest(payload(), store, {
			observer: repairingObserver,
			storeSummary: false,
		} as unknown as IngestOptions);

		const usage = latestUsage(store);
		expect(calls).toBe(2);
		expect(usage.tokens_read).toBe(18);
		expect(usage.tokens_written).toBe(5);
		expect(JSON.parse(usage.metadata_json).token_usage).toMatchObject({
			source: "provider",
			attempt_count: 2,
		});
	});
});

describe("observer token usage terminal paths", { timeout: 15_000 }, () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-token-usage-terminal-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("persists one usage row when a completed observer call returns empty output", async () => {
		await ingest(payload(), store, {
			observer: observer(null, { inputTokens: 4, outputTokens: 1 }),
			storeSummary: false,
		} as unknown as IngestOptions);

		expect(latestUsage(store)).toMatchObject({ tokens_read: 4, tokens_written: 1 });
		expect(usageCount(store)).toBe(1);
	});

	it("persists failure telemetry from an explicit observer output error", async () => {
		const invalidObserver = structuredObserver(async () => ({
			raw: "{}",
			parsed: null,
			provider: "openai",
			model: "test-model",
			usage: { inputTokens: 12, outputTokens: 3 },
			usedStructuredOutputs: true,
			failureReason: null,
			transportFailureCode: null,
		}));

		await expect(
			ingest(payload(), store, {
				observer: invalidObserver,
				storeSummary: false,
			} as unknown as IngestOptions),
		).rejects.toThrow("observer output failed validation");

		const usage = latestUsage(store);
		expect(usage).toMatchObject({ tokens_read: 12, tokens_written: 3 });
		expect(JSON.parse(usage.metadata_json).token_usage.attempt_count).toBe(1);
		expect(usageCount(store)).toBe(1);
	});

	it("persists null counts when observer output failure telemetry has no usage", async () => {
		const invalidObserver = structuredObserver(async () => ({
			raw: "{}",
			parsed: null,
			provider: "openai",
			model: "test-model",
			usage: null,
			usedStructuredOutputs: true,
			failureReason: null,
			transportFailureCode: null,
		}));

		await expect(
			ingest(payload(), store, {
				observer: invalidObserver,
				storeSummary: false,
			} as unknown as IngestOptions),
		).rejects.toThrow("observer output failed validation");

		expect(latestUsage(store)).toMatchObject({
			tokens_read: null,
			tokens_written: null,
		});
		expect(usageCount(store)).toBe(1);
	});

	it("uses explicit retry diagnostics for failed observer attempt counts", async () => {
		let calls = 0;
		const failingObserver = structuredObserver(async () => {
			calls += 1;
			return {
				raw: null,
				parsed: null,
				provider: "openai",
				model: "test-model",
				usage: { inputTokens: calls, outputTokens: calls + 1 },
				usedStructuredOutputs: false,
				failureReason: null,
				transportFailureCode: "rate_limited",
			};
		});

		await expect(
			ingest(payload(), store, {
				observer: failingObserver,
				storeSummary: false,
			} as unknown as IngestOptions),
		).rejects.toThrow("observer request failed");

		const usage = latestUsage(store);
		expect(usage).toMatchObject({ tokens_read: 3, tokens_written: 5 });
		expect(JSON.parse(usage.metadata_json).token_usage.attempt_count).toBe(2);
		expect(usageCount(store)).toBe(1);
	});

	it("does not invent usage for arbitrary observer errors", async () => {
		const failingObserver = structuredObserver(async () => {
			throw new Error("unexpected observer bug");
		});

		await expect(
			ingest(payload(), store, {
				observer: failingObserver,
				storeSummary: false,
			} as unknown as IngestOptions),
		).rejects.toThrow("unexpected observer bug");

		expect(usageCount(store)).toBe(0);
	});
});

describe("token usage provenance aggregation", () => {
	it("marks pack estimates and excludes legacy observer text lengths", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-token-aggregate-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		const sessionId = insertTestSession(setupDb);
		setupDb
			.prepare(
				`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
				 VALUES (?, 'observer_call', 500, 200, 0, ?, '{}')`,
			)
			.run(sessionId, new Date().toISOString());
		setupDb.close();
		const aggregateStore = new MemoryStore(dbPath);
		try {
			aggregateStore.remember(sessionId, "feature", "Pack estimate", "Useful context", 0.8);
			buildMemoryPack(aggregateStore, "pack estimate", 10, null, { project: "test-project" });

			const packMetadata = aggregateStore.db
				.prepare(
					"SELECT metadata_json FROM usage_events WHERE event = 'pack' ORDER BY id DESC LIMIT 1",
				)
				.get() as { metadata_json: string };
			expect(JSON.parse(packMetadata.metadata_json).token_usage).toEqual({
				unit: "tokens",
				source: "estimate",
				input_direction: "pack_injected",
				output_direction: null,
				attempt_count: 1,
			});

			const rows = aggregateStore.classifiedUsageAggregate();
			expect(rows.find((row) => row.event === "observer_call")).toMatchObject({
				tokens_read: 0,
				tokens_written: 0,
				legacy_text_length_count: 1,
			});
			expect(rows.find((row) => row.event === "pack")).toMatchObject({
				estimated_count: 1,
				legacy_unclassified_count: 0,
			});
		} finally {
			aggregateStore.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
