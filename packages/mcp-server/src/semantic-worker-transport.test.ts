import { getRetrievalAttempt } from "@codemem/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetEmbeddingRuntimeFactory,
	_setEmbeddingRuntimeFactory,
} from "../../core/src/embeddings.js";
import { attachSemanticExecutorForTesting } from "../../core/src/semantic/semantic-executor-seam.js";
import {
	request,
	useSemanticWorkerFixture,
} from "../../core/src/semantic/semantic-worker-test-fixtures.js";
import { createApp } from "../../viewer-server/src/index.js";
import { createCodememMcpServer } from "./index.js";

const f = useSemanticWorkerFixture();
let client: Client;
let server: ReturnType<typeof createCodememMcpServer>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
	_setEmbeddingRuntimeFactory(async () => f.client);
	app = createApp({ storeFactory: () => f.store, sweeper: null });
	server = createCodememMcpServer(f.store, {
		defaultProject: null,
		envProject: null,
		captureRetrievalLedger: true,
	});
	client = new Client({ name: "worker-fixture", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
});
afterEach(async () => {
	await client?.close();
	await server?.close();
	_resetEmbeddingRuntimeFactory();
	vi.useRealTimers();
});

function usageCount(): number {
	return (
		f.store.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE event = 'pack'").get() as {
			n: number;
		}
	).n;
}

function install() {
	const executor = f.openExecutor();
	const search = vi.spyOn(executor, "search");
	attachSemanticExecutorForTesting(f.store, executor);
	return { executor, search };
}

async function tool(name: string, args: Record<string, unknown>) {
	const result = await client.callTool({ name, arguments: args });
	if (result.isError || !result.structuredContent) throw new Error(JSON.stringify(result));
	return result.structuredContent;
}

function postPack(body: Record<string, unknown>) {
	return app.request("/api/pack", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:38888" },
		body: JSON.stringify(body),
	});
}

describe("semantic worker through actual viewer and MCP handlers", () => {
	it("preserves inline response and trace through HTTP, records the attempt, and writes usage once", async () => {
		// Arrange: freeze only parent Date, slightly ahead of worker wall time so its deadline remains valid.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60_000);
		const expectedTrace = await f.store.buildMemoryPackTraceAsync(request.query, 10);
		const expectedResponse = await f.store.buildMemoryPackAsync(request.query, 10);
		// Restore identical history for the worker comparison, rather than normalizing delta metrics.
		f.store.db.prepare("DELETE FROM usage_events WHERE event = 'pack'").run();
		const before = usageCount();
		const { search } = install();
		const attemptId = "00000000-0000-4000-8000-000000000101";

		// Act
		const response = await postPack({
			context: request.query,
			limit: 10,
			all_projects: true,
			attempt: { attempt_id: attemptId, source: "opencode", request_id: "fixture-http-pack" },
		});
		const body = await response.json();
		const afterHttp = usageCount();
		const trace = await f.store.buildMemoryPackTraceAsync(request.query, 10);

		// Assert: traces retain real candidate decisions; trace-only does not add usage.
		expect(response.status).toBe(200);
		expect(body).toEqual({
			...expectedResponse,
			ledger_artifact_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(trace).toEqual(expectedTrace);
		expect(afterHttp).toBe(before + 1);
		expect(usageCount()).toBe(afterHttp);
		expect(getRetrievalAttempt(f.store.db, attemptId)).toMatchObject({
			retrievalStatus: "succeeded",
		});
		expect(search).toHaveBeenCalledTimes(2);
		expect(trace.retrieval.candidates.map(({ id }) => id)).toContain(f.ids.semantic);
		expect(trace.retrieval.candidates.map(({ id }) => id)).not.toContain(f.ids.hidden);
	});

	it("runs MCP memory_pack against the same attached store and keeps raw searches keyword-only", async () => {
		// Arrange: both handlers share this store, but only pack should invoke semantic execution.
		const { search } = install();
		const before = usageCount();

		// Act
		const pack = await tool("memory_pack", { context: request.query, limit: 10 });
		const callsAfterPack = search.mock.calls.length;
		const raw = await tool("memory_search", { query: request.query, limit: 10 });
		const index = await tool("memory_search_index", { query: request.query, limit: 10 });

		// Assert: the semantic-only row has no keyword support and stays out of raw search.
		expect(pack.item_ids).toContain(f.ids.semantic);
		expect(pack.item_ids).not.toContain(f.ids.hidden);
		expect(raw.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: f.ids.keyword })]),
		);
		expect(raw.items).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: f.ids.semantic })]),
		);
		expect(index.items).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: f.ids.semantic })]),
		);
		expect(callsAfterPack).toBe(1);
		expect(search).toHaveBeenCalledTimes(1);
		expect(usageCount()).toBe(before + 1);
		expect(
			f.store.db
				.prepare(
					"SELECT surface, retrieval_status FROM retrieval_attempts WHERE surface = 'mcp_pack'",
				)
				.all(),
		).toEqual([{ surface: "mcp_pack", retrieval_status: "succeeded" }]);
	});

	it("keeps HTTP and MCP keyword fallback when embeddings are disabled without loading a client", async () => {
		// Arrange
		const getClient = vi.fn(async () => f.client);
		const executor = f.openExecutor({ getClient });
		attachSemanticExecutorForTesting(f.store, executor);
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");

		// Act
		const response = await postPack({ context: request.query, all_projects: true });
		const httpPack = await response.json();
		const mcpPack = await tool("memory_pack", { context: request.query });

		// Assert
		expect(response.status).toBe(200);
		expect(httpPack.item_ids).toContain(f.ids.keyword);
		expect(mcpPack.item_ids).toEqual(httpPack.item_ids);
		expect(getClient).not.toHaveBeenCalled();
		expect(usageCount()).toBe(2);
	});

	it("falls back to keyword retrieval after worker shutdown without rerunning ranking inline", async () => {
		// Arrange: a closed executor remains explicitly attached; it must not route to inline SQL.
		const { executor } = install();
		await executor.search(request);
		await executor.close();
		const prepares = vi.spyOn(f.store.db, "prepare");

		// Act
		const pack = await tool("memory_pack", { context: request.query });

		// Assert
		expect(pack.item_ids).toContain(f.ids.keyword);
		expect(prepares.mock.calls.map(([sql]) => sql).join("\n")).not.toContain("vec_distance_l2");
		expect(usageCount()).toBe(1);
	});
});
