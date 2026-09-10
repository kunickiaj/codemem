import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema, MemoryStore } from "@codemem/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodememMcpServer } from "./index.js";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

function requireTool(tools: ListedTool[], name: string): ListedTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`MCP tool not listed: ${name}`);
	return tool;
}

function parseTextResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
	if (!("content" in result)) throw new Error("memory_learn returned a task result");
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("memory_learn returned no text content");
	return JSON.parse(content.text);
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(collectStrings);
	if (!value || typeof value !== "object") return [];
	return Object.values(value).flatMap(collectStrings);
}

function extractCalls(text: string): Array<{ name: string; parameters: string[] }> {
	return Array.from(text.matchAll(/\b(memory_[a-z_]+)\(([^)]*)\)/g), (match) => ({
		name: match[1] ?? "",
		parameters: Array.from(
			(match[2] ?? "").matchAll(/(?:^|,\s*)([a-z_]+)(?:\s*=|\s*(?=,|$))/g),
			(parameter) => parameter[1] ?? "",
		),
	}));
}

function assertSearchRoutingGuidance(tools: ListedTool[]): void {
	const search = requireTool(tools, "memory_search");
	const index = requireTool(tools, "memory_search_index");
	const pack = requireTool(tools, "memory_pack");
	const descriptions = {
		search: search.description ?? "",
		index: index.description ?? "",
		pack: pack.description ?? "",
	};

	expect(descriptions.search).toMatch(/keyword-search.*exact terms or identifiers/i);
	expect(descriptions.search).toMatch(/full body text/i);
	expect(descriptions.search).not.toMatch(/semantic search/i);
	expect(descriptions.index).toMatch(/compact entries.*without bodies/i);
	expect(descriptions.index).not.toMatch(/full body text/i);
	expect(descriptions.pack).toMatch(/concept.*keyword and semantic search/i);
	expect(descriptions.pack).toMatch(/automatic keyword-only fallback/i);
	expect(descriptions.pack).toMatch(/exact identifiers/i);
}

function assertLearnGuidance(tools: ListedTool[], guidance: unknown): void {
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const schemaParameterNames = new Set(
		tools.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {})),
	);
	const guidanceText = collectStrings(guidance).join("\n");
	const calls = extractCalls(guidanceText);
	const callNames = new Set(calls.map((call) => call.name));
	const referencedNames = [
		...new Set(
			(guidanceText.match(/\bmemory_[a-z_]+\b/g) ?? []).filter(
				(name) => callNames.has(name) || !schemaParameterNames.has(name),
			),
		),
	];

	expect(referencedNames.length).toBeGreaterThan(0);
	for (const name of referencedNames) {
		expect(name).toMatch(/^memory_[a-z]+(?:_[a-z]+)*$/);
		expect(toolsByName.has(name), `${name} should resolve to a listed MCP tool`).toBe(true);
	}
	expect(guidanceText).not.toMatch(/\bmemory-[a-z_-]+\b/);
	expect(guidanceText).not.toMatch(/\bmemory\.[a-z_]+/);
	for (const call of calls) {
		const tool = toolsByName.get(call.name);
		if (!tool) throw new Error(`Guidance call is not registered: ${call.name}`);
		const schemaParameters = new Set(Object.keys(tool.inputSchema.properties ?? {}));
		for (const parameter of call.parameters) {
			expect(
				schemaParameters.has(parameter),
				`${call.name} should accept guidance parameter ${parameter}`,
			).toBe(true);
		}
	}
}

function assertDirectIdGuidance(tools: ListedTool[]): void {
	const directGet = requireTool(tools, "memory_get");
	const directMany = requireTool(tools, "memory_get_observations");
	const forget = requireTool(tools, "memory_forget");

	for (const description of [directGet.description ?? "", directMany.description ?? ""]) {
		expect(description).toMatch(/exact ID/i);
		expect(description).toMatch(/does not inherit the default project/i);
	}
	expect(forget.description).toMatch(/soft-delete/i);
	expect(forget.description).toMatch(/not secure erasure/i);
	expect(forget.description).toMatch(/filters must match.*not_found/i);
	expect(directMany.description).toMatch(/missing or filtered-out IDs are omitted/i);
}

describe("registered MCP tool guidance", () => {
	let client: Client;
	let server: ReturnType<typeof createCodememMcpServer>;
	let store: MemoryStore;
	let tmpDir: string;
	let previousConfig: string | undefined;
	let previousEmbeddingDisabled: string | undefined;

	beforeEach(async () => {
		previousConfig = process.env.CODEMEM_CONFIG;
		previousEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-mcp-guidance-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";

		const dbPath = join(tmpDir, "memory.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
		server = createCodememMcpServer(store, {
			defaultProject: "default-project",
			captureRetrievalLedger: false,
		});
		client = new Client({ name: "tool-guidance-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
	});

	afterEach(async () => {
		await client.close();
		await server.close();
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
		if (previousConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = previousConfig;
		if (previousEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
		else process.env.CODEMEM_EMBEDDING_DISABLED = previousEmbeddingDisabled;
	});

	it("distinguishes exact keyword search, compact index results, and conceptual packs", async () => {
		const { tools } = await client.listTools();

		assertSearchRoutingGuidance(tools);
	});

	it("memory_learn references only registered underscore names with valid recipe parameters", async () => {
		const { tools } = await client.listTools();
		const guidance = parseTextResult(
			await client.callTool({ name: "memory_learn", arguments: {} }),
		);

		assertLearnGuidance(tools, guidance);
	});

	it("documents direct-ID project scope and forget semantics", async () => {
		const { tools } = await client.listTools();

		assertDirectIdGuidance(tools);
	});
});
