/**
 * Pins the thin-host tool contracts (@codemem/memory-tools) to the MCP server
 * registrations. Any change to a tool name, description, argument, default, or
 * bound must land in both places in the same PR.
 */

import type { MemoryStore } from "@codemem/core";
import { listMemoryToolContracts, MEMORY_TOOL_NAMES } from "@codemem/memory-tools";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodememMcpServer } from "./server.js";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const SAFE_INTEGER_BOUNDS = {
	minimum: Number.MIN_SAFE_INTEGER,
	maximum: Number.MAX_SAFE_INTEGER,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Zod's renderer emits `type: ["a","b"]` for unions and pins `.int()` to the
 * safe-integer range. The contracts use `anyOf` and leave integers unbounded;
 * JSON numbers outside the safe range cannot round-trip exactly anyway, so the
 * bounds add no reachable constraint.
 */
function normalizeNode(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(normalizeNode);
	if (!isRecord(node)) return node;
	let normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) normalized[key] = normalizeNode(value);
	if (Array.isArray(normalized.type)) {
		const { type: variants, ...rest } = normalized;
		normalized = { ...rest, anyOf: (variants as string[]).map((type) => ({ type })) };
	}
	if (normalized.type !== "integer") return normalized;
	const { minimum, maximum, ...unbounded } = normalized;
	if (minimum !== undefined && minimum !== SAFE_INTEGER_BOUNDS.minimum) unbounded.minimum = minimum;
	if (maximum !== undefined && maximum !== SAFE_INTEGER_BOUNDS.maximum) unbounded.maximum = maximum;
	return unbounded;
}

/**
 * Compare the semantic parts; only `$schema` boilerplate is dropped.
 * `additionalProperties` is compared as-is so a strictness change on either
 * side (zod strips unknown keys; `false` would reject them) fails here.
 */
function normalizeInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return {
		type: schema.type,
		properties: normalizeNode(schema.properties ?? {}),
		required: [...((schema.required as string[] | undefined) ?? [])].toSorted(),
		additionalProperties: schema.additionalProperties,
	};
}

describe("memory tool contract parity with the MCP server", () => {
	let client: Client;
	let listed: ListedTool[];

	beforeAll(async () => {
		// Listing tools never touches the store, so an empty object suffices.
		const server = createCodememMcpServer({} as MemoryStore, {
			defaultProject: null,
			captureRetrievalLedger: false,
		});
		client = new Client({ name: "contract-parity", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		listed = (await client.listTools()).tools;
	});

	afterAll(async () => {
		await client.close();
	});

	it("declares exactly the fourteen MCP tools", () => {
		expect(listed.map((tool) => tool.name).toSorted()).toEqual([...MEMORY_TOOL_NAMES].toSorted());
	});

	for (const contract of listMemoryToolContracts()) {
		it(`${contract.name} matches the MCP description and input schema`, () => {
			const tool = listed.find((candidate) => candidate.name === contract.name);
			expect(tool, `${contract.name} is registered`).toBeDefined();
			expect(tool?.description).toBe(contract.description);
			expect(normalizeInputSchema(tool?.inputSchema as Record<string, unknown>)).toEqual(
				normalizeInputSchema(contract.input),
			);
		});
	}
});
