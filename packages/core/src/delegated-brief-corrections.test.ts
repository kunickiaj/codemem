import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	boundedDelegatedBriefs,
	DELEGATED_BRIEF_LABEL,
	isDelegatedBrief,
} from "./capture-context.js";
import { budgetToolEvents } from "./ingest-events.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { buildObserverPrompt, truncateObserverTranscript } from "./ingest-prompts.js";
import { ObserverClient } from "./observer-client.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { MemoryStore } from "./store.js";

const provenance = (text: string) => ({
	version: 1,
	host: "opencode-v1",
	origin: "delegated_brief",
	parent_session_id: "parent",
	child_session_id: "child",
	task_call_id: "task",
	message_id: "message",
	requested_agent: "explore",
	current_agent: "explore",
	brief_sha256: createHash("sha256").update(text).digest("hex"),
});

// Exercise the real observe()/clipping path, replacing only the transport. Skipping
// construction avoids reading any provider credentials or changing configuration.
function clippingObserver(maxChars: number) {
	const postClip = vi.fn(async (_system: string, _user: string) => {
		throw new Error("captured after clipping");
	});
	const client = Object.assign(Object.create(ObserverClient.prototype), {
		maxChars,
		runtime: "test",
		_callOnce: postClip,
		getStatus: () => ({
			provider: "test",
			model: "fixture",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	}) as ObserverClient;
	return { client, postClip };
}

describe("prior brief budgets through actual observer clipping", () => {
	it.each([4000, 12000, 30000])(
		"preserves the entire baseline evidence prefix at cap %i",
		async (maxChars) => {
			const toolEvents = budgetToolEvents(
				[
					{
						toolName: "read",
						toolInput: { path: "queue.ts" },
						toolOutput: `NEW_TOOL_EVIDENCE ${"queue entries survive invalidation. ".repeat(300)}`,
						toolError: null,
						timestamp: null,
						cwd: null,
					},
				],
				8000,
				30,
			);
			const input = {
				project: "fixture",
				userPrompt: "Report observed queue behavior.",
				promptNumber: 1,
				transcript: truncateObserverTranscript("Assistant: inspecting the queue. ".repeat(30), 400),
				toolEvents,
				includeSummary: true,
				lastAssistantMessage: "NEW_ASSISTANT_EVIDENCE",
				diffSummary: "",
				recentFiles: "",
			};
			const baseline = buildObserverPrompt(input);
			const withBriefs = buildObserverPrompt({
				...input,
				delegatedBriefs: Array(4).fill("old instructions ".repeat(1000)),
			});
			expect(withBriefs.system).toBe(baseline.system);
			expect(withBriefs.user.startsWith(baseline.user)).toBe(true);
			expect(withBriefs.user.length - baseline.user.length).toBeLessThanOrEqual(800);
			const { client, postClip } = clippingObserver(maxChars);
			await expect(client.observe(baseline.system, baseline.user)).rejects.toThrow(
				"captured after clipping",
			);
			await expect(client.observe(withBriefs.system, withBriefs.user)).rejects.toThrow(
				"captured after clipping",
			);
			const original = postClip.mock.calls[0]?.[1] ?? "";
			const recovered = postClip.mock.calls[1]?.[1] ?? "";
			expect(original).toContain("NEW_TOOL_EVIDENCE");
			expect(recovered.startsWith(original)).toBe(true);
		},
	);

	it("sanitizes complete private regions before imposing the aggregate cap", () => {
		const brief = `Inspect queue. <private>${"SYNTHETIC_PRIVATE_MARKER".repeat(200)}</private> VISIBLE_AFTER_PRIVATE`;
		expect(boundedDelegatedBriefs([brief])).toEqual(["Inspect queue.  VISIBLE_AFTER_PRIVATE"]);
	});
});

let directory: string;
let store: MemoryStore;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-brief-corrections-"));
	store = new MemoryStore(join(directory, "test.sqlite"));
});
afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

async function retainBrief(text: string) {
	store.recordRawEvent({
		opencodeSessionId: "child",
		eventId: "brief",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: text },
		captureContext: provenance(text),
	});
	await flushRawEvents(store, { observer: { observe: vi.fn() } } as unknown as IngestOptions, {
		opencodeSessionId: "child",
	});
}

function addFinding(stream: string, output: string, eventId = "finding") {
	store.recordRawEvent({
		opencodeSessionId: stream,
		eventId,
		eventType: "tool.execute.after",
		payload: {
			type: "tool.execute.after",
			tool: "read",
			args: { path: "queue.ts" },
			result: output,
		},
	});
}

describe("recovered brief pipeline regressions", () => {
	it("keeps current evidence through real clipping when the prior brief is large", async () => {
		await retainBrief("Earlier instructions. ".repeat(1000));
		const finding = `NEW_TOOL_EVIDENCE ${"Queue entries survive invalidation. ".repeat(400)}`;
		addFinding("baseline", finding);
		addFinding("child", finding);
		addFinding("baseline", `SECOND_TOOL_EVIDENCE ${finding}`, "finding-two");
		addFinding("child", `SECOND_TOOL_EVIDENCE ${finding}`, "finding-two");
		const { client, postClip } = clippingObserver(12000);
		for (const stream of ["baseline", "child"]) {
			await expect(
				flushRawEvents(store, { observer: client }, { opencodeSessionId: stream }),
			).rejects.toThrow("captured after clipping");
		}
		expect(postClip.mock.calls[0]?.[1]).toContain("NEW_TOOL_EVIDENCE");
		expect(postClip.mock.calls[0]?.[1]).toContain("SECOND_TOOL_EVIDENCE");
		expect(postClip.mock.calls[1]?.[1]).toBe(postClip.mock.calls[0]?.[1]);
	});

	it("recovers sanitized short context after new evidence while keeping raw history intact", async () => {
		const text = `Investigate queue. <private>${"SYNTHETIC_PRIVATE_MARKER".repeat(200)}</private> VISIBLE_AFTER_PRIVATE`;
		await retainBrief(text);
		addFinding("child", "NEW_TOOL_EVIDENCE: queue entries survive invalidation.");
		const { client, postClip } = clippingObserver(30000);
		await expect(
			flushRawEvents(store, { observer: client }, { opencodeSessionId: "child" }),
		).rejects.toThrow("captured after clipping");
		const user = postClip.mock.calls[0]?.[1] ?? "";
		expect(user).toContain("VISIBLE_AFTER_PRIVATE");
		expect(user).not.toContain("SYNTHETIC_PRIVATE_MARKER");
		expect(user.indexOf(DELEGATED_BRIEF_LABEL)).toBeGreaterThan(user.indexOf("NEW_TOOL_EVIDENCE"));
		expect(store.rawEventsSinceBySeq("child")[0]?.prompt_text).toBe(text);
	});

	it("keeps sanitizer-induced digest mismatches unknown and retains valid sanitized raw input", () => {
		const text = "Inspect <private>SYNTHETIC_PRIVATE_MARKER</private> queue.";
		ingestRawEvents(store, {
			source: "opencode",
			session_stream_id: "child",
			event_id: "sanitized",
			event_type: "user_prompt",
			payload: { type: "user_prompt", prompt_text: text },
			capture_context: provenance(text),
		});
		const event = store.rawEventsSinceBySeq("child")[0];
		expect(event?.prompt_text).toBe("Inspect  queue.");
		expect(event).not.toHaveProperty("capture_context");
		expect(isDelegatedBrief(event ?? {})).toBe(false);
	});
});
