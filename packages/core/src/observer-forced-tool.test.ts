import { describe, expect, it, vi } from "vitest";
import {
	OBSERVER_FORCED_TOOL_DEFINITION,
	requestObserverEnvelopeWithForcedTool,
} from "./observer-forced-tool.js";
import { OBSERVER_ENVELOPE_JSON_SCHEMA } from "./observer-output-schema.js";

const envelope = {
	schema_version: 1,
	status: "captured",
	observations: [
		{
			kind: "decision",
			title: "Use one forced tool",
			narrative: "Tool input uses the shared observer envelope.",
			subtitle: null,
			facts: [],
			concepts: ["how-it-works"],
			files_read: [],
			files_modified: [],
		},
	],
	summary: null,
	skip_reason: null,
};

describe("forced observer tool contract", () => {
	it("uses record_memories with the shared envelope input schema", () => {
		expect(OBSERVER_FORCED_TOOL_DEFINITION).toEqual({
			name: "record_memories",
			description: expect.any(String),
			inputSchema: OBSERVER_ENVELOPE_JSON_SCHEMA,
		});
	});

	it("passes a forced single-tool request through a provider-neutral transport", async () => {
		const invoke = vi.fn(async () => ({
			toolCalls: [{ name: "record_memories", input: envelope }],
			provider: "fixture-provider",
			model: "fixture-model",
			elapsedMs: 7,
			usage: { inputTokens: 20, outputTokens: 10 },
		}));

		const result = await requestObserverEnvelopeWithForcedTool({ invoke }, "system", "user");

		expect(invoke).toHaveBeenCalledWith({
			system: "system",
			user: "user",
			tool: OBSERVER_FORCED_TOOL_DEFINITION,
			toolChoice: { name: "record_memories" },
			parallelToolCalls: false,
		});
		expect(result.parsed).toMatchObject({ ok: true, envelope });
	});

	it.each([
		[[], "forced_tool_missing"],
		[
			[
				{ name: "record_memories", input: envelope },
				{ name: "record_memories", input: envelope },
			],
			"forced_tool_multiple_calls",
		],
		[[{ name: "other_tool", input: envelope }], "forced_tool_input_invalid"],
		[
			[{ name: "record_memories", input: { ...envelope, extra: true } }],
			"forced_tool_input_invalid",
		],
	] as const)("fails closed for tool calls %#", async (toolCalls, reason) => {
		const result = await requestObserverEnvelopeWithForcedTool(
			{
				invoke: async () => ({
					toolCalls,
					provider: "fixture-provider",
					model: "fixture-model",
					elapsedMs: null,
					usage: null,
				}),
			},
			"system",
			"user",
		);

		expect(result.parsed).toMatchObject({ ok: false, reason });
		expect(JSON.stringify(result.parsed)).not.toContain(JSON.stringify(envelope));
	});
});
