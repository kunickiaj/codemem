import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DELEGATED_BRIEF_LABEL } from "./capture-context.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import { MemoryStore } from "./store.js";

const BRIEF = "Search maintenance behavior and summarize the result.";
let directory: string;
let store: MemoryStore;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-delegated-summary-"));
	store = new MemoryStore(join(directory, "test.sqlite"));
});

afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

function delegatedContext() {
	return {
		version: 1,
		host: "opencode-v1",
		origin: "delegated_brief",
		parent_session_id: "parent",
		child_session_id: "child",
		task_call_id: "task",
		message_id: "message",
		requested_agent: "explore",
		current_agent: "explore",
		brief_sha256: createHash("sha256").update(BRIEF).digest("hex"),
	};
}

function events(hasCurrentDelegatedTask: boolean): Record<string, unknown>[] {
	const primary = [
		{
			type: "tool.execute.after",
			tool: "codemem_memory_search",
			args: { query: "maintenance job" },
			result: "Found the maintenance path.",
		},
		{ type: "assistant_message", assistant_text: "Delegated search complete." },
	];
	if (!hasCurrentDelegatedTask) return primary;
	return [
		{
			type: "user_prompt",
			prompt_text: BRIEF,
			capture_context: delegatedContext(),
		},
		...primary,
	];
}

function optionsFor(observe: ReturnType<typeof vi.fn>): IngestOptions {
	return {
		observer: {
			observe,
			getStatus: () => ({
				provider: "test",
				model: "fixture",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		},
	} as unknown as IngestOptions;
}

it.each([
	{
		current: true,
		sessionClass: "micro_high_signal",
		disposition: "stored",
		summaries: 1,
	},
	{
		current: false,
		sessionClass: "micro_low_value",
		disposition: "suppressed",
		summaries: 0,
	},
])("classifies current provenance without promoting prior briefs: $current", async (testCase) => {
	const observe = vi.fn(async () => ({
		raw: `<summary><request>Review delegated search results</request><investigated>Checked the result set</investigated><learned>The search found the maintenance path</learned><completed>Reported the findings</completed><next_steps></next_steps><notes></notes></summary>`,
		parsed: null,
		provider: "test",
		model: "fixture",
	}));
	await ingest(
		{
			cwd: "/fixture",
			project: "fixture",
			events: events(testCase.current),
			sessionContext: {
				flusher: "raw_events",
				source: "opencode",
				streamId: "child",
				opencodeSessionId: "child",
				promptCount: 0,
				toolCount: 1,
				durationMs: 20_000,
				delegatedBriefs: [BRIEF],
			},
		},
		store,
		optionsFor(observe),
	);
	const session = store.db.prepare("SELECT metadata_json FROM sessions").get() as {
		metadata_json: string;
	};
	const metadata = JSON.parse(session.metadata_json);
	const observerInput = observe.mock.calls[0]?.[1] ?? "";
	expect(store.recent(10).filter((item) => item.kind === "session_summary")).toHaveLength(
		testCase.summaries,
	);
	expect(metadata.post.session_class).toBe(testCase.sessionClass);
	expect(metadata.post.summary_disposition).toBe(testCase.disposition);
	expect(metadata.session_context).not.toHaveProperty("delegatedBriefs");
	expect(observerInput).toContain(DELEGATED_BRIEF_LABEL);
	expect(observerInput).not.toContain(`User: ${BRIEF}`);
});
