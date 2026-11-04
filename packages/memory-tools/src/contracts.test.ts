import { describe, expect, it } from "vitest";
import {
	FILTER_NAMES,
	FILTER_PROPERTIES,
	listMemoryToolContracts,
	MEMORY_TOOL_CONTRACTS,
	MEMORY_TOOL_NAMES,
} from "./contracts.js";

describe("memory tool contracts", () => {
	it("lists every tool once, keyed by its own name", () => {
		const contracts = listMemoryToolContracts();
		expect(contracts.map((contract) => contract.name)).toEqual([...MEMORY_TOOL_NAMES]);
		for (const contract of contracts) {
			expect(MEMORY_TOOL_CONTRACTS[contract.name]).toBe(contract);
		}
	});

	it("marks only required properties as required and keeps them in the schema", () => {
		for (const contract of listMemoryToolContracts()) {
			for (const name of contract.input.required ?? []) {
				expect(contract.input.properties, `${contract.name}.${name}`).toHaveProperty(name);
				expect(contract.input.properties[name], `${contract.name}.${name}`).not.toHaveProperty(
					"default",
				);
			}
		}
	});

	it("gives every retrieval surface a tool that defaults to caller scope or is ID-addressed", () => {
		const ledgerTools = listMemoryToolContracts().filter((contract) => contract.surface != null);
		expect(ledgerTools.map((contract) => contract.surface)).toEqual([
			"mcp_search",
			"mcp_search_index",
			"mcp_explain",
			"mcp_recent",
			"mcp_pack",
			"mcp_timeline",
			"mcp_expand",
			"mcp_get",
			"mcp_get_observations",
		]);
	});

	it("never inherits a caller project for ID-addressed tools", () => {
		for (const name of ["memory_get", "memory_get_observations", "memory_forget"] as const) {
			expect(MEMORY_TOOL_CONTRACTS[name].projectScoping).toBe("none");
		}
	});

	it("lets writes honor only the environment project, never the directory", () => {
		expect(MEMORY_TOOL_CONTRACTS.memory_remember.projectScoping).toBe("env");
	});

	it("leaves additionalProperties unset so unknown arguments are stripped like MCP", () => {
		for (const contract of listMemoryToolContracts()) {
			expect(contract.input, contract.name).not.toHaveProperty("additionalProperties");
		}
	});

	it("sends the caller directory only for tools that touch session cwd or context files", () => {
		const directoryTools = listMemoryToolContracts()
			.filter((contract) => contract.sendsDirectory)
			.map((contract) => contract.name);
		expect(directoryTools).toEqual(["memory_remember", "memory_distill_candidates"]);
	});

	it("exposes the sorted filter names the schema tool reports", () => {
		expect(FILTER_NAMES).toEqual(Object.keys(FILTER_PROPERTIES).toSorted());
		expect(FILTER_NAMES).toContain("project");
		expect(FILTER_NAMES).toContain("widen_shared_min_personal_score");
	});
});
