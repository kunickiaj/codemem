import type { MemoryStore } from "@codemem/core";
import { describe, expect, it } from "vitest";
import { createCodememMcpServer } from "./index.js";

describe("createCodememMcpServer", () => {
	it("exports a side-effect-free factory from the package root", () => {
		expect(createCodememMcpServer).toBeTypeOf("function");
	});

	it("registers the full MCP memory tool surface", () => {
		const server = createCodememMcpServer({} as MemoryStore, { defaultProject: null });
		const tools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
		).toSorted();

		expect(tools).toEqual([
			"memory_distill_candidates",
			"memory_expand",
			"memory_explain",
			"memory_forget",
			"memory_get",
			"memory_get_observations",
			"memory_learn",
			"memory_pack",
			"memory_recent",
			"memory_remember",
			"memory_schema",
			"memory_search",
			"memory_search_index",
			"memory_timeline",
		]);
	});
});
