import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema, MemoryStore } from "@codemem/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodememMcpServer } from "./index.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const expectedAnnotations = {
	memory_distill_candidates: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	memory_expand: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	memory_explain: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	memory_forget: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	memory_get: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	memory_get_observations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	memory_learn: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	memory_pack: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	memory_recent: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	memory_remember: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	memory_schema: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	memory_search: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	memory_search_index: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	memory_timeline: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
} as const;

function textFrom(result: ToolResult): string {
	if (!("content" in result)) throw new Error("tool returned a task result");
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("tool returned no text content");
	return content.text;
}

function assertStructuredSuccess(result: ToolResult): Record<string, unknown> {
	const text = textFrom(result);
	if (!("structuredContent" in result) || !result.structuredContent) {
		throw new Error("successful tool result omitted structuredContent");
	}
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toEqual(JSON.parse(text));
	return result.structuredContent;
}

function assertTextError(result: ToolResult, expectedText?: string): void {
	expect(result.isError).toBe(true);
	expect("structuredContent" in result ? result.structuredContent : undefined).toBeUndefined();
	if (expectedText !== undefined) expect(textFrom(result)).toBe(expectedText);
}

let client: Client;
let server: ReturnType<typeof createCodememMcpServer>;
let store: MemoryStore;
let tempDirectory: string;
let fixtureDirectory: string;
let previousConfig: string | undefined;
let previousEmbeddingDisabled: string | undefined;
let previousHome: string | undefined;
let previousProject: string | undefined;

beforeEach(async () => {
	previousConfig = process.env.CODEMEM_CONFIG;
	previousEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	previousHome = process.env.HOME;
	previousProject = process.env.CODEMEM_PROJECT;
	tempDirectory = mkdtempSync(join(tmpdir(), "codemem-mcp-contract-"));
	fixtureDirectory = join(tempDirectory, "contract-fixture");
	mkdirSync(fixtureDirectory);
	process.env.CODEMEM_CONFIG = join(tempDirectory, "config.json");
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	process.env.HOME = tempDirectory;
	delete process.env.CODEMEM_PROJECT;
	vi.spyOn(process, "cwd").mockReturnValue(fixtureDirectory);

	const databasePath = join(tempDirectory, "memory.sqlite");
	const database = connect(databasePath);
	initTestSchema(database);
	database.close();
	store = new MemoryStore(databasePath);
	server = createCodememMcpServer(store, {
		defaultProject: "contract-fixture",
		envProject: null,
		captureRetrievalLedger: false,
	});
	client = new Client({ name: "structured-output-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
});

afterEach(async () => {
	await client.close();
	await server.close();
	store.close();
	vi.restoreAllMocks();
	rmSync(tempDirectory, { recursive: true, force: true });
	if (previousConfig === undefined) delete process.env.CODEMEM_CONFIG;
	else process.env.CODEMEM_CONFIG = previousConfig;
	if (previousEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
	else process.env.CODEMEM_EMBEDDING_DISABLED = previousEmbeddingDisabled;
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousProject === undefined) delete process.env.CODEMEM_PROJECT;
	else process.env.CODEMEM_PROJECT = previousProject;
});

async function callSuccess(
	name: string,
	args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	return assertStructuredSuccess(await client.callTool({ name, arguments: args }));
}

async function rememberFixturePair(): Promise<[number, number]> {
	const first = await callSuccess("memory_remember", {
		kind: "discovery",
		title: "Contract sentinel recurring lesson",
		body: "Contract sentinel recurring lesson should remain machine readable.",
		confidence: 0.9,
		project: "contract-fixture",
	});
	const second = await callSuccess("memory_remember", {
		kind: "discovery",
		title: "Contract sentinel recurring lesson again",
		body: "Contract sentinel recurring lesson should remain machine readable again.",
		confidence: 0.8,
		project: "contract-fixture",
	});
	return [first.id as number, second.id as number];
}

describe("registered MCP tool declarations", () => {
	it("publishes an output schema and the audited conservative annotations for all 14 tools", async () => {
		// Arrange: the expected map pins retrieval logging, external compute, and write semantics.
		const expectedNames = Object.keys(expectedAnnotations).toSorted();

		// Act
		const tools = (await client.listTools()).tools.toSorted((left, right) =>
			left.name.localeCompare(right.name),
		);

		// Assert
		expect(tools.map((tool) => tool.name)).toEqual(expectedNames);
		for (const tool of tools) {
			expect(tool.outputSchema, `${tool.name} output schema`).toMatchObject({ type: "object" });
			expect(tool.annotations, `${tool.name} annotations`).toEqual(
				expectedAnnotations[tool.name as keyof typeof expectedAnnotations],
			);
		}
	});
});

describe("non-empty MCP structured outputs", () => {
	it("round-trips non-empty state and retrieval results through SDK output validation", async () => {
		// Arrange: create isolated records through the public MCP write tool.
		const [firstId, secondId] = await rememberFixturePair();
		store.db
			.prepare("UPDATE memory_items SET metadata_json = ? WHERE id = ?")
			.run(JSON.stringify({ extension: { source: "fixture" } }), firstId);

		// Act
		const search = await callSuccess("memory_search", { query: "contract sentinel", limit: 10 });
		const index = await callSuccess("memory_search_index", {
			query: "contract sentinel",
			limit: 10,
		});
		const recent = await callSuccess("memory_recent", { limit: 10 });
		const get = await callSuccess("memory_get", { memory_id: firstId });
		const batch = await callSuccess("memory_get_observations", { ids: [firstId, secondId] });
		const timeline = await callSuccess("memory_timeline", {
			memory_id: firstId,
			depth_before: 1,
			depth_after: 1,
		});
		const expand = await callSuccess("memory_expand", {
			ids: [firstId],
			depth_before: 1,
			depth_after: 1,
			include_observations: true,
		});
		const pack = await callSuccess("memory_pack", {
			context: "contract sentinel",
			limit: 5,
		});
		const explain = await callSuccess("memory_explain", {
			query: "contract sentinel",
			ids: [firstId],
			limit: 10,
		});

		// Assert: every retrieval returns useful data, including passthrough metadata.
		expect((search.items as Array<{ metadata: unknown }>).length).toBeGreaterThan(0);
		expect(
			(search.items as Array<{ id: number; metadata: unknown }>).find(
				(item) => item.id === firstId,
			),
		).toMatchObject({ metadata: { extension: { source: "fixture" } } });
		expect((index.items as unknown[]).length).toBeGreaterThan(0);
		expect((recent.items as unknown[]).length).toBeGreaterThan(0);
		expect(get).toMatchObject({ id: firstId, active: 1 });
		expect((batch.items as unknown[]).length).toBe(2);
		expect((timeline.items as unknown[]).length).toBeGreaterThan(0);
		expect((expand.anchors as unknown[]).length).toBe(1);
		expect((expand.observations as unknown[]).length).toBeGreaterThan(0);
		expect((pack.items as unknown[]).length).toBeGreaterThan(0);
		expect(pack.metrics).toMatchObject({
			total_items: expect.any(Number),
			pack_item_ids: pack.item_ids,
		});
		expect((explain.items as unknown[]).length).toBeGreaterThan(0);
		expect(explain.errors).toEqual([]);
	});
});

describe("nullable MCP retrieval fields", () => {
	it("round-trips nullable confidence and legacy nullable fields through all affected tools", async () => {
		// Arrange: these columns are nullable in the real schema despite having insert defaults.
		const [firstId, secondId] = await rememberFixturePair();
		store.db
			.prepare(
				"UPDATE memory_items SET confidence = NULL, tags_text = NULL, metadata_json = NULL WHERE id IN (?, ?)",
			)
			.run(firstId, secondId);

		// Act: call every retrieval surface that emits memory confidence.
		const search = await callSuccess("memory_search", { query: "contract sentinel", limit: 10 });
		const recent = await callSuccess("memory_recent", { limit: 10 });
		const get = await callSuccess("memory_get", { memory_id: firstId });
		const batch = await callSuccess("memory_get_observations", { ids: [firstId, secondId] });
		const timeline = await callSuccess("memory_timeline", {
			memory_id: firstId,
			depth_before: 1,
			depth_after: 1,
		});
		const expand = await callSuccess("memory_expand", {
			ids: [firstId],
			depth_before: 1,
			depth_after: 1,
			include_observations: true,
		});
		const pack = await callSuccess("memory_pack", {
			context: "contract sentinel",
			limit: 5,
		});

		// Assert: SDK output validation accepts the nullable rows without losing text parity.
		expect(search.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: firstId,
					confidence: null,
					metadata: expect.any(Object),
				}),
			]),
		);
		expect(recent.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: firstId, confidence: null, metadata_json: {} }),
			]),
		);
		expect(get).toMatchObject({
			id: firstId,
			confidence: null,
			tags_text: null,
			metadata_json: {},
		});
		expect(batch.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: firstId, confidence: null })]),
		);
		expect(timeline.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: firstId, confidence: null })]),
		);
		expect(expand.anchors).toEqual([expect.objectContaining({ id: firstId, confidence: null })]);
		expect(expand.observations).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: firstId, confidence: null })]),
		);
		expect(pack.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ confidence: null, metadata: expect.any(Object) }),
			]),
		);
	});
});

describe("catalog and distill MCP structured outputs", () => {
	it("returns successful structured catalogs and a local unjudged distill candidate", async () => {
		// Arrange: recurring isolated memories make distillation non-empty without an observer or downloads.
		const ids = await rememberFixturePair();

		// Act
		const distill = await callSuccess("memory_distill_candidates", {
			all_projects: true,
			include_documented: false,
			judge: false,
			limit: 10,
			max_evidence_items: 5,
			min_recurrence: 2,
		});
		const schema = await callSuccess("memory_schema");
		const learn = await callSuccess("memory_learn");

		// Assert
		expect(distill).toMatchObject({
			version: 1,
			candidates: [{ member_ids: ids, recurrence: 2 }],
			metadata: { candidate_count: 1 },
		});
		expect((schema.kinds as unknown[]).length).toBeGreaterThan(0);
		expect(schema.filters).toEqual(expect.arrayContaining(["project", "kind"]));
		expect(learn).toMatchObject({ intro: expect.any(String), recall: { when: expect.any(Array) } });
	});
});

describe("empty MCP structured outputs", () => {
	it("keeps valid zero-result calls inside their declared success envelopes", async () => {
		// Arrange
		const missingProject = "no-such-fixture-project";

		// Act
		const search = await callSuccess("memory_search", { query: "absent", project: missingProject });
		const index = await callSuccess("memory_search_index", {
			query: "absent",
			project: missingProject,
		});
		const recent = await callSuccess("memory_recent", { project: missingProject });
		const batch = await callSuccess("memory_get_observations", { ids: [] });
		const timeline = await callSuccess("memory_timeline", {
			query: "absent",
			project: missingProject,
		});
		const pack = await callSuccess("memory_pack", {
			context: "absent",
			project: missingProject,
			limit: 5,
		});
		const explain = await callSuccess("memory_explain", { ids: [999_999] });
		const expand = await callSuccess("memory_expand", { ids: ["invalid", 999_999] });
		const distill = await callSuccess("memory_distill_candidates", {
			all_projects: true,
			judge: false,
			min_recurrence: 50,
		});

		// Assert
		expect(search).toEqual({ items: [] });
		expect(index).toEqual({ items: [] });
		expect(recent).toEqual({ items: [] });
		expect(batch).toEqual({ items: [] });
		expect(timeline).toEqual({ items: [] });
		expect(pack).toMatchObject({ items: [], item_ids: [], metrics: { total_items: 0 } });
		expect(explain).toMatchObject({
			items: [],
			missing_ids: [999_999],
			errors: [{ code: "NOT_FOUND", ids: [999_999] }],
		});
		expect(expand).toMatchObject({
			anchors: [],
			timeline: [],
			observations: [],
			missing_ids: [999_999],
			errors: [{ code: "INVALID_ARGUMENT" }, { code: "NOT_FOUND" }],
		});
		expect(distill).toMatchObject({ version: 1, candidates: [] });
	});
});

describe("MCP text error outputs", () => {
	it("keeps not-found, filter-mismatch, invalid-input, and repeated-forget results text-only", async () => {
		// Arrange
		const [memoryId] = await rememberFixturePair();
		const rowCountBefore = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
			count: number;
		};

		// Act
		const missing = await client.callTool({
			name: "memory_get",
			arguments: { memory_id: 999_999 },
		});
		const filtered = await client.callTool({
			name: "memory_get",
			arguments: { memory_id: memoryId, project: "other-project" },
		});
		const invalid = await client.callTool({
			name: "memory_get",
			arguments: { memory_id: "invalid" },
		});
		const forgotten = await callSuccess("memory_forget", { memory_id: memoryId });
		const repeated = await client.callTool({
			name: "memory_forget",
			arguments: { memory_id: memoryId },
		});
		const stored = store.db
			.prepare("SELECT active FROM memory_items WHERE id = ?")
			.get(memoryId) as { active: number };
		const rowCountAfter = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
			count: number;
		};

		// Assert
		assertTextError(missing, JSON.stringify({ error: "not_found" }));
		assertTextError(filtered, JSON.stringify({ error: "not_found" }));
		assertTextError(invalid);
		expect(forgotten).toEqual({ status: "ok" });
		assertTextError(repeated, JSON.stringify({ error: "not_found" }));
		expect(stored).toEqual({ active: 0 });
		expect(rowCountAfter).toEqual(rowCountBefore);
	});
});
