import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { buildMemoryPackTraceAsync, buildMemoryPackWithTraceAsync } from "./pack.js";
import * as retrieval from "./search.js";
import { search } from "./search.js";
import { MemoryStore } from "./store.js";
import * as vectors from "./vectors.js";

vi.mock("./embeddings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./embeddings.js")>()),
	getEmbeddingClient: vi.fn(),
	embedTexts: vi.fn(),
	resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "synthetic-model"),
}));

let store: MemoryStore;
let session: number;
const automatic = { source: "opencode", hostSessionId: "synthetic-semantic" };
const filters = { project: "synthetic" };
const vector = new Float32Array(384).fill(0.1);

function rememberVector(title: string, body: string, sessionId = session) {
	const id = store.remember(sessionId, "decision", title, body, 0.9);
	store.db
		.prepare(
			"INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model) VALUES (?, ?, 0, ?, 'synthetic-model')",
		)
		.run(embeddings.serializeFloat32(vector), BigInt(id), `synthetic-${id}`);
	return id;
}

beforeEach(() => {
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(null);
	vi.mocked(embeddings.embedTexts).mockResolvedValue([vector]);
	vi.spyOn(vectors, "semanticSearch");
	vi.spyOn(retrieval, "search");
	store = new MemoryStore(":memory:");
	session = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: automatic.hostSessionId,
		project: filters.project,
	});
});

function expectVectorMembership(ids: number[]) {
	expect(store.db.prepare("SELECT memory_id FROM memory_vectors ORDER BY memory_id").all()).toEqual(
		[...ids].sort((a, b) => a - b).map((memory_id) => ({ memory_id })),
	);
}

async function enableQueryEmbeddings(vectorIds: number[]) {
	await store.flushPendingVectorWrites();
	expect(embeddings.embedTexts).not.toHaveBeenCalled();
	expectVectorMembership(vectorIds);
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
		model: "synthetic-model",
		dimensions: 384,
		identity: {
			package: "@huggingface/transformers",
			version: "4.2.0",
			model: "synthetic-model",
			revision: "0123456789abcdef0123456789abcdef01234567",
			requestedRevision: "synthetic",
			dtype: "fp32",
			device: "cpu",
			pooling: "mean",
			normalization: "l2",
			dimensions: 384,
		},
		embed: vi.fn(async () => [vector]),
	});
}

afterEach(async () => {
	await store.flushPendingVectorWrites();
	store.close();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("automatic semantic-only guard through local vector search", () => {
	it.each(["Orchid indexing", "remember Orchid indexing", "recap Orchid indexing"])(
		"rejects unsupported nearest neighbors: %s",
		async (query) => {
			const id = rememberVector("Accounting rule", "Invoices balance overnight.");
			expect(search(store, query, 10, filters)).toEqual([]);
			await enableQueryEmbeddings([id]);
			const trace = await buildMemoryPackTraceAsync(
				store,
				query,
				10,
				null,
				filters,
				undefined,
				automatic,
			);
			expect(embeddings.embedTexts).toHaveBeenCalledWith([query], expect.any(Object));
			expect(embeddings.embedTexts).toHaveBeenCalledTimes(1);
			expect(Object.values(trace.assembly.sections).flat()).toEqual([]);
			expect(trace.retrieval.candidates).toContainEqual(
				expect.objectContaining({
					id,
					disposition: "dropped",
					reasons: expect.arrayContaining(["automatic_semantic_only_without_keyword_support"]),
				}),
			);
		},
	);

	it("deliberately rejects a useful paraphrase automatically but retains it manually", async () => {
		const id = rememberVector("Credential rotation", "Replace secrets every quarter.");
		const query = "refresh authentication keys";
		expect(search(store, query, 10, filters)).toEqual([]);
		await enableQueryEmbeddings([id]);
		const automaticTrace = await buildMemoryPackTraceAsync(
			store,
			query,
			10,
			null,
			filters,
			undefined,
			automatic,
		);
		const manual = await buildMemoryPackWithTraceAsync(store, query, 10, null, filters);
		expect(Object.values(automaticTrace.assembly.sections).flat()).toEqual([]);
		expect(manual.response.metrics.fallback_used).toBe(false);
		expect(manual.trace.retrieval.candidates).toContainEqual(
			expect.objectContaining({
				id,
				disposition: "selected",
			}),
		);
		await expect(vi.mocked(vectors.semanticSearch).mock.results.at(-1)?.value).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ id })]),
		);
	});

	it.each(["Orchid indexing", "remember Orchid indexing"])(
		"keeps semantic-only items in a supported hybrid batch: %s",
		async (query) => {
			const keyword = store.remember(
				session,
				"feature",
				"Orchid indexing",
				"Segment boundaries.",
				0.9,
			);
			const semantic = rememberVector("Partition layout", "Divide records into bounded groups.");
			expect(search(store, query, 10, filters).map((row) => row.id)).toEqual([keyword]);
			await enableQueryEmbeddings([semantic]);
			const trace = await buildMemoryPackTraceAsync(
				store,
				query,
				10,
				null,
				filters,
				undefined,
				automatic,
			);
			expect(Object.values(trace.assembly.sections).flat()).toEqual(
				expect.arrayContaining([keyword, semantic]),
			);
		},
	);

	it("preserves semantic-only automatic task browsing", async () => {
		const id = rememberVector("Accounting rule", "Invoices balance overnight.");
		await enableQueryEmbeddings([id]);
		const trace = await buildMemoryPackTraceAsync(
			store,
			"list tasks",
			10,
			null,
			filters,
			undefined,
			automatic,
		);
		expect(trace.mode.selected).toBe("task");
		expect(vi.mocked(retrieval.search).mock.results[0]?.value).toEqual([]);
		await expect(vi.mocked(vectors.semanticSearch).mock.results[0]?.value).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ id })]),
		);
		expect(Object.values(trace.assembly.sections).flat()).toContain(id);
	});
});

describe("automatic async timeline expansion", () => {
	it("does not expand supported async recall into automatic timeline neighbors", async () => {
		// Arrange
		const before = store.remember(session, "discovery", "Accounting", "Invoices balance.", 0.9);
		const anchor = rememberVector("Orchid indexing", "Orchid uses segment boundaries.");
		const after = store.remember(session, "feature", "Tooling", "Formatter configuration.", 0.9);
		const query = "what did we decide about Orchid indexing";
		await enableQueryEmbeddings([anchor]);

		// Act
		const automaticTrace = await buildMemoryPackTraceAsync(
			store,
			query,
			10,
			null,
			filters,
			undefined,
			automatic,
		);
		const manualTrace = await buildMemoryPackTraceAsync(store, query, 10, null, filters);

		// Assert
		expect(embeddings.embedTexts).toHaveBeenCalledTimes(2);
		expect(vi.mocked(embeddings.embedTexts).mock.calls.map(([texts]) => texts)).toEqual([
			[query],
			[query],
		]);
		expectVectorMembership([anchor]);
		expect([...new Set(Object.values(automaticTrace.assembly.sections).flat())]).toEqual([anchor]);
		expect([...new Set(Object.values(manualTrace.assembly.sections).flat())]).toEqual([
			before,
			anchor,
			after,
		]);
	});
});

describe("admitted semantic source metrics", () => {
	it.each(["Orchid indexing", "remember Orchid indexing"])(
		"counts no rejected semantic contributions while retaining every trace candidate: %s",
		async (query) => {
			const ids = [
				rememberVector("Accounting rule", "Invoices balance overnight."),
				rememberVector("Formatter settings", "Indent with tabs."),
			];
			await enableQueryEmbeddings(ids);
			const { response, trace } = await buildMemoryPackWithTraceAsync(
				store,
				query,
				10,
				null,
				filters,
				undefined,
				automatic,
			);
			expect(response.item_ids).toEqual([]);
			expect(response.items).toEqual([]);
			expect(response.metrics.sources.semantic).toBe(0);
			expect(
				trace.retrieval.candidates.map(({ id, disposition }) => ({ id, disposition })),
			).toEqual(ids.map((id) => ({ id, disposition: "dropped" })));
			for (const candidate of trace.retrieval.candidates) {
				expect(candidate.reasons).toContain("automatic_semantic_only_without_keyword_support");
			}
			// Admitted manual candidates still count when budgeting removes every item.
			const manual = await buildMemoryPackWithTraceAsync(store, query, 10, 1, filters);
			expect(manual.response.item_ids).toEqual([]);
			expect(manual.response.metrics.sources.semantic).toBe(ids.length);
			expect(embeddings.embedTexts).toHaveBeenCalledTimes(2);
		},
	);
});

describe("automatic semantic scope and independent file references", () => {
	it.each(["Orchid indexing", "remember Orchid indexing"])(
		"preserves direct file references without admitting the rest of an unsupported batch: %s",
		async (query) => {
			const fileMatch = rememberVector("Partition layout", "Divide records into bounded groups.");
			const unrelated = rememberVector("Accounting rule", "Invoices balance overnight.");
			store.db
				.prepare(
					"INSERT INTO memory_file_refs(memory_id, file_path, relation) VALUES (?, 'src/segments.ts', 'modified')",
				)
				.run(fileMatch);
			const scoped = { ...filters, working_set_paths: ["src/segments.ts"] };
			expect(search(store, query, 10, scoped)).toEqual([]);
			await enableQueryEmbeddings([fileMatch, unrelated]);
			const trace = await buildMemoryPackTraceAsync(
				store,
				query,
				10,
				null,
				scoped,
				undefined,
				automatic,
			);
			expect([...new Set(Object.values(trace.assembly.sections).flat())]).toEqual([fileMatch]);
			expect(trace.retrieval.candidates.find((row) => row.id === unrelated)?.reasons).toContain(
				"automatic_semantic_only_without_keyword_support",
			);
			expect(trace.retrieval.candidates.find((row) => row.id === fileMatch)?.reasons).not.toContain(
				"automatic_semantic_only_without_keyword_support",
			);
		},
	);

	it("does not count keyword hits outside the project or visibility gates as support", async () => {
		const foreignSession = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "synthetic-foreign",
			project: "elsewhere",
		});
		const foreign = rememberVector(
			"Orchid indexing foreign project",
			"Orchid segments.",
			foreignSession,
		);
		const hidden = rememberVector("Orchid indexing hidden scope", "Orchid partitions.");
		expect(hidden).not.toBe(foreign);
		const now = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
				 group_id, membership_epoch, status, created_at, updated_at)
				 VALUES ('synthetic-hidden', 'Synthetic hidden', 'team', 'coordinator', 'synthetic-coord',
				 'synthetic-group', 0, 'active', ?, ?)`,
			)
			.run(now, now);
		store.db
			.prepare("UPDATE memory_items SET scope_id = 'synthetic-hidden' WHERE id = ?")
			.run(hidden);
		const unsupported = rememberVector("Accounting rule", "Invoices balance overnight.");
		await enableQueryEmbeddings([foreign, hidden, unsupported]);
		const trace = await buildMemoryPackTraceAsync(
			store,
			"Orchid indexing",
			10,
			null,
			filters,
			undefined,
			automatic,
		);
		expect(vi.mocked(retrieval.search).mock.results[0]?.value).toEqual([]);
		expect(Object.values(trace.assembly.sections).flat()).toEqual([]);
		expect(trace.retrieval.candidates.map((row) => row.id)).toEqual([unsupported]);
		const semantic = await vi.mocked(vectors.semanticSearch).mock.results[0]?.value;
		expect(semantic.map((row: { id: number }) => row.id)).toEqual([unsupported]);
	});

	it("keeps the requester summary gate on supported async hybrid retrieval", async () => {
		const sibling = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "synthetic-sibling",
			project: filters.project,
		});
		const own = rememberVector("Orchid requester recap", "Current handoff.");
		const foreign = rememberVector("Orchid sibling summary", "Sibling handoff.", sibling);
		expect(foreign).not.toBe(own);
		store.db
			.prepare("UPDATE memory_items SET kind = 'session_summary' WHERE id IN (?, ?)")
			.run(own, foreign);
		const durable = rememberVector("Partition layout", "Divide records into groups.", sibling);
		await enableQueryEmbeddings([own, foreign, durable]);
		const trace = await buildMemoryPackTraceAsync(
			store,
			"recap Orchid",
			10,
			null,
			filters,
			undefined,
			automatic,
		);
		expect(Object.values(trace.assembly.sections).flat()).toEqual(
			expect.arrayContaining([own, durable]),
		);
		expect(trace.retrieval.candidates.map((row) => row.id)).not.toContain(foreign);
	});
});
