import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { jsonContent } from "./content.js";
import { toolOutputSchemas } from "./tool-contracts.js";

const malformedOutputs: ReadonlyArray<{
	label: string;
	schema: ZodType;
	fixture: unknown;
}> = [
	{ label: "remember id", schema: toolOutputSchemas.memory_remember, fixture: { id: "1" } },
	{
		label: "stored body",
		schema: toolOutputSchemas.memory_get,
		fixture: { id: 1, kind: "discovery", title: "missing body" },
	},
	{
		label: "pack metrics",
		schema: toolOutputSchemas.memory_pack,
		fixture: {
			context: "fixture",
			items: [],
			item_ids: [],
			pack_text: "",
			metrics: {
				total_items: 0,
				pack_tokens: "0",
				fallback_used: false,
				limit: 5,
				project: null,
				pack_item_ids: [],
			},
		},
	},
	{
		label: "explain error details",
		schema: toolOutputSchemas.memory_explain,
		fixture: {
			items: [],
			missing_ids: [],
			errors: [{ code: "INVALID_ARGUMENT", field: "query" }],
			metadata: {
				query: null,
				project: null,
				requested_ids_count: 0,
				returned_items_count: 0,
				include_pack_context: false,
			},
		},
	},
];

describe("MCP tool output schemas", () => {
	it.each(malformedOutputs)("rejects malformed $label output", ({ schema, fixture }) => {
		// Arrange: each fixture corrupts or omits one contract field.
		const malformedOutput = fixture;

		// Act
		const result = schema.safeParse(malformedOutput);

		// Assert
		expect(result.success).toBe(false);
	});

	it("preserves unknown metadata while pruning undefined values identically from text and structure", () => {
		// Arrange
		const value = {
			status: "ok",
			metadata: { extension: { source: "fixture" }, omitted: undefined },
		};

		// Act
		const result = jsonContent(value);
		const parsedText = JSON.parse(result.content[0].text);

		// Assert
		expect(result.structuredContent).toEqual(parsedText);
		expect(result.structuredContent).toEqual({
			status: "ok",
			metadata: { extension: { source: "fixture" } },
		});
	});
});
