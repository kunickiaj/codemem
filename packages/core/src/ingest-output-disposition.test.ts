import { afterEach, expect, it, vi } from "vitest";
import { type IngestOptions, ingest, RawEventObserverOutputError } from "./ingest-pipeline.js";
import type { IngestPayload } from "./ingest-types.js";
import type { MemoryStore } from "./store.js";

vi.mock("./raw-event-flush-claim.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./raw-event-flush-claim.js")>()),
	requireRawEventFlushClaim: vi.fn(),
	ownsRawEventFlushClaim: () => true,
}));

afterEach(() => {
	vi.unstubAllEnvs();
});

it.each([
	{
		name: "recognized summary-only output without assistant or tools",
		storeSummary: true,
		raw: "<summary><request>Review synthetic parser behavior</request><completed>Reviewed synthetic validation behavior.</completed></summary>",
		diagnostics: {
			parsed_observation_count: 0,
			parsed_has_summary: true,
			validated_observation_count: 0,
			routed_observation_count: 0,
			summary_removal_reason: "no_assistant_or_tools",
		},
	},
	{
		name: "valid parsed observation removed by the low-signal filter",
		storeSummary: true,
		raw: "<observation><type>discovery</type><title>No code changes were made</title><narrative>No code changes were made during the synthetic review.</narrative></observation>",
		diagnostics: {
			parsed_observation_count: 1,
			parsed_has_summary: false,
			validated_observation_count: 0,
			routed_observation_count: 0,
			summary_removal_reason: "no_candidate",
		},
	},
	{
		name: "parsed summary removed by the low-signal filter",
		storeSummary: true,
		raw: "<summary><request>No code changes were made</request></summary>",
		diagnostics: {
			parsed_observation_count: 0,
			parsed_has_summary: true,
			validated_observation_count: 0,
			routed_observation_count: 0,
			summary_removal_reason: "filtered",
		},
	},
	{
		name: "parsed summary disabled by storage policy",
		storeSummary: false,
		raw: "<summary><request>Review synthetic parser behavior</request></summary>",
		diagnostics: {
			parsed_observation_count: 0,
			parsed_has_summary: true,
			validated_observation_count: 0,
			routed_observation_count: 0,
			summary_removal_reason: "policy",
		},
	},
])(
	"retains sanitized failure diagnostics and tokens for $name",
	async ({ raw, diagnostics, storeSummary }) => {
		// Arrange: fake persistence records calls without opening or writing a database.
		vi.stubEnv("CODEMEM_CAPTURE_ROUTING", "0");
		const run =
			vi.fn<
				(
					sessionId: number,
					input: number | null,
					output: number | null,
					at: string,
					metadata: string,
				) => void
			>();
		const prepare = vi.fn(() => ({ run }));
		const rememberForUser = vi.fn();
		const store = {
			db: {
				prepare,
				transaction: (action: () => unknown) => ({ immediate: action }),
			},
			getOrCreateSessionForOpencodeSession: vi.fn(() => 1),
			assertSessionScopeWritable: vi.fn(),
			endSession: vi.fn(),
			rememberForUser,
		} as unknown as MemoryStore;
		const observe = vi.fn().mockResolvedValue({
			raw,
			parsed: null,
			provider: "test",
			model: "test-model",
			usage: { inputTokens: 5, outputTokens: 7 },
		});
		const options = {
			storeSummary,
			observer: {
				observe,
				getStatus: () => ({ provider: "test", model: "test-model", runtime: "test" }),
			},
			rawFlushPersistence: {
				claim: { batchId: 1, generation: 1, attemptCount: 1 },
				source: "opencode",
				streamId: "synthetic-session",
			},
		} as unknown as IngestOptions;
		const payload: IngestPayload = {
			project: "synthetic-project",
			events: [
				{ type: "user_prompt", prompt_text: "Review synthetic parser behavior", prompt_number: 1 },
			],
			sessionContext: {
				source: "opencode",
				opencodeSessionId: "synthetic-session",
				flusher: "raw_events",
				promptCount: 1,
				toolCount: 0,
				durationMs: 20_000,
			},
		};

		// Act: reject unstorable output while retaining the completed observer call.
		const error = await ingest(payload, store, options).catch((cause: unknown) => cause);

		// Assert: metadata describes the filters without copying synthetic content.
		expect(error).toBeInstanceOf(RawEventObserverOutputError);
		expect(error).toMatchObject({ reason: "unstorable_observer_output" });
		expect(observe).toHaveBeenCalledTimes(1);
		expect(rememberForUser).not.toHaveBeenCalled();
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO usage_events"));
		expect(run).toHaveBeenCalledTimes(1);
		const [sessionId, inputTokens, outputTokens, , metadataJson] = run.mock.calls[0] ?? [];
		expect([sessionId, inputTokens, outputTokens]).toEqual([1, 5, 7]);
		expect(metadataJson).toBeDefined();
		const metadata = JSON.parse(metadataJson ?? "{}");
		expect(metadata).toMatchObject({
			observation_count: 0,
			has_summary: false,
			raw_event_flush_outcome: "failed",
			output_diagnostics: diagnostics,
			observer_output_mode: "legacy_xml",
			observer_output_failure_reason: null,
			observer_output_retry_attempted: false,
			observer_output_repair_attempted: false,
			observer_output_initial_usage: { inputTokens: 5, outputTokens: 7 },
		});
		expect(metadata.output_diagnostics).toEqual(diagnostics);
		expect(metadata.token_usage).toMatchObject({ source: "provider", attempt_count: 1 });
	},
);
