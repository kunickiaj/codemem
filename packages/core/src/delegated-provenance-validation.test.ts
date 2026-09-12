import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isDelegatedBrief, isDelegatedBriefOnlyBatch } from "./capture-context.js";
import {
	buildTranscript,
	normalizeAdapterEvents,
	normalizeEventsForSessionContext,
} from "./ingest-transcript.js";

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

describe("complete delegated provenance validation", () => {
	it("does not relabel bare claims or preserve them through adapter normalization", () => {
		const text = "Keep retry ownership in the pending queue.";
		const event = {
			type: "user_prompt",
			prompt_text: text,
			capture_context: { origin: "delegated_brief" },
			_adapter: {
				schema_version: "1.0",
				source: "opencode",
				session_id: "child",
				event_type: "prompt",
				payload: { text },
			},
		};
		for (const events of [
			[event],
			normalizeAdapterEvents([event]),
			normalizeEventsForSessionContext([event]),
		]) {
			expect(buildTranscript(events)).toBe(`User: ${text}`);
			expect(isDelegatedBriefOnlyBatch(events)).toBe(false);
		}
	});

	it("retains validated exact text through both normalization paths", () => {
		const text = "  Investigate the queue.\n";
		const event = {
			type: "user_prompt",
			prompt_text: text,
			capture_context: provenance(text),
			_adapter: {
				schema_version: "1.0",
				source: "opencode",
				session_id: "child",
				event_type: "prompt",
				payload: { text },
			},
		};
		for (const events of [
			normalizeAdapterEvents([event]),
			normalizeEventsForSessionContext([event]),
		]) {
			expect(events[0]?.prompt_text).toBe(text);
			expect(isDelegatedBriefOnlyBatch(events)).toBe(true);
		}
	});

	it.each([
		{ prompt_text: "Changed text" },
		{ synthetic: true },
		{ result: "real finding" },
		{ _raw_session_id: "sibling" },
		{ capture_context: provenance("other text") },
	])("rejects incomplete, mismatched or mixed prompt data %#", (change) => {
		const event = {
			type: "user_prompt",
			prompt_text: "Inspect queue",
			capture_context: provenance("Inspect queue"),
			...change,
		};
		expect(isDelegatedBrief(event)).toBe(false);
		expect(isDelegatedBriefOnlyBatch([event])).toBe(false);
	});
});
