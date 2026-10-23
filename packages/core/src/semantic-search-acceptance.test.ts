import { beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { buildFilterClausesWithContext } from "./filters.js";
import { startMaintenanceJob } from "./maintenance-jobs.js";
import { refreshManagedScopeFixture } from "./managed-scope-test-fixtures.js";
import { recordForeignMemoryRevision } from "./memory-creation-provenance.js";
import { scopeId, useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { ensureVectorSchema } from "./schema-bootstrap.js";
import { summaryContinuityFilter } from "./summary-memory.js";
import { insertTestSession } from "./test-utils.js";
import type { MemoryFilters } from "./types.js";
import {
	resolveSemanticSearchModel,
	resolveSemanticSearchModels,
	type SemanticSearchScopeContext,
	semanticSearch,
} from "./vectors.js";

vi.mock("./embeddings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./embeddings.js")>()),
	getEmbeddingClient: vi.fn(),
	embedTexts: vi.fn(),
	resolveEmbeddingClientVectorIdentityLabel: vi.fn(),
}));

const { fixture, enroll, remember, rememberScoped, row } = useLocalCaptureFixture();
const legacyModel = "Xenova/bge-small-en-v1.5";
const currentModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
const queryVector = new Float32Array(384);

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected test network request"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	ensureVectorSchema(fixture.store.db);
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
		model: legacyModel,
		dimensions: 384,
		embed: vi.fn(),
	});
	vi.mocked(embeddings.embedTexts).mockResolvedValue([queryVector]);
	vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue(currentModel);
});

function vector(id: number, value: number, model = currentModel, chunkIndex = 0): void {
	const embedding = new Float32Array(384);
	embedding[0] = value;
	fixture.store.db
		.prepare(`INSERT INTO memory_vectors
		(embedding, memory_id, chunk_index, content_hash, model)
		VALUES (?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?, ?)`)
		.run(embeddings.serializeFloat32(embedding), id, chunkIndex, `${id}-${chunkIndex}`, model);
}

function replica(scope: string | null, sessionId = fixture.sessionId): number {
	return Number(
		fixture.store.db
			.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, confidence, tags_text, active,
		 created_at, updated_at, metadata_json, scope_id, origin_device_id, import_key)
		VALUES (?, 'discovery', 'Replica', 'Full body', 0.6, 'tag', 1,
		 '2026-01-01', '2026-01-02', '{}', ?, 'peer', ?)`)
			.run(sessionId, scope, `replica-${scope}-${sessionId}-${rowCount()}`).lastInsertRowid,
	);
}

function rowCount(): number {
	return (fixture.store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number })
		.n;
}

function context(): SemanticSearchScopeContext {
	return fixture.store.ownershipFilterContext();
}

// Frozen pre-optimization SQL from 0d8c0b1e. Keep the ordinary OR policy builder:
// using the new disjoint builder here would conceal missing/duplicated branches.
function referenceRows(
	filters: MemoryFilters | null,
	ctx: SemanticSearchScopeContext,
	limit: number,
	models: string[],
	summarySessionId?: number | null,
) {
	const db = fixture.store.db;
	const filter = buildFilterClausesWithContext(filters, { ...ctx, enforceScopeVisibility: true });
	const continuity = summaryContinuityFilter(summarySessionId);
	const where = ["memory_items.active = 1", ...filter.clauses, ...continuity.clauses].join(" AND ");
	const sql = `WITH scoped_vectors AS (
		SELECT memory_vectors.memory_id,
		MIN(vec_distance_l2(memory_vectors.embedding, ?)) AS distance
		FROM memory_vectors JOIN memory_items ON memory_items.id = memory_vectors.memory_id
		${filter.joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : ""}
		WHERE memory_vectors.model IN (${models.map(() => "?").join(", ")}) AND ${where}
		GROUP BY memory_vectors.memory_id ORDER BY distance ASC LIMIT ?
	) SELECT memory_items.*, scoped_vectors.distance FROM scoped_vectors
	JOIN memory_items ON memory_items.id = scoped_vectors.memory_id ORDER BY scoped_vectors.distance ASC`;
	const rows = db
		.prepare(sql)
		.all(
			embeddings.serializeFloat32(queryVector),
			...models,
			...filter.params,
			...continuity.params,
			limit,
		) as Record<string, unknown>[];
	return rows.map((item) => ({
		...Object.fromEntries(
			[
				"id",
				"kind",
				"title",
				"body_text",
				"confidence",
				"tags_text",
				"metadata_json",
				"created_at",
				"updated_at",
				"session_id",
				"narrative",
				"facts",
			].map((key) => [key, item[key]]),
		),
		distance: item.distance,
		score: 1 / (1 + Number(item.distance)),
	}));
}

type CapturedQuery = { sql: string; params: unknown[] };
async function captureSearch(run: () => ReturnType<typeof semanticSearch>) {
	const db = fixture.store.db;
	const prepare = db.prepare.bind(db);
	let captured: CapturedQuery | undefined;
	const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
		const statement = prepare(sql);
		if (sql.includes("MIN(vec_distance_l2")) {
			const all = statement.all.bind(statement);
			vi.spyOn(statement, "all").mockImplementation((...params: unknown[]) => {
				captured = { sql, params };
				return all(...params);
			});
		}
		return statement;
	});
	try {
		const results = await run();
		if (!captured) throw new Error("production semantic query was not executed");
		return { results, ...captured };
	} finally {
		spy.mockRestore();
	}
}

async function visibilityCorpus() {
	enroll();
	await refreshManagedScopeFixture(fixture.store.db, {
		keysDir: fixture.keysDir,
		deviceId: fixture.store.deviceId,
		scopeIds: [scopeId],
	});
	const ids = {
		local: remember("Unmanaged and creation-proof overlap"),
		creation: rememberScoped("Immutable managed creation"),
		managed: replica(scopeId),
		hidden: replica("unknown-scope"),
	};
	for (const [index, id] of Object.values(ids).entries()) vector(id, index + 1);
	return ids;
}

describe("authorized semantic query equivalence", () => {
	it.each([undefined, null, "mapped"] as const)(
		"preserves ordered full rows and scores with continuity %s",
		async (continuity) => {
			// Arrange: ties, mixed compatible models/chunks, orphan/inactive vectors and malformed JSON.
			const ids = await visibilityCorpus();
			const db = fixture.store.db;
			const tied = replica("local-default");
			vector(tied, 1);
			const nullScope = replica(null);
			vector(nullScope, 6);
			vector(ids.local, 0.5, legacyModel, 1);
			vector(ids.local, 9, currentModel, 2);
			vector(999999, 0);
			const inactive = replica("local-default");
			vector(inactive, 0);
			db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(inactive);
			const summary = replica("local-default");
			vector(summary, 0.25);
			db.prepare("UPDATE memory_items SET kind = 'session_summary' WHERE id = ?").run(summary);
			db.prepare(
				"UPDATE memory_items SET metadata_json = '{', narrative = 'Narrative', facts = '[\"fact\"]' WHERE id = ?",
			).run(tied);
			const session = insertTestSession(db);
			db.prepare("UPDATE sessions SET project = 'other-project' WHERE id = ?").run(session);
			const otherSession = replica("local-default", session);
			vector(otherSession, 1);
			const otherSummary = replica("local-default", session);
			vector(otherSummary, 0.3);
			db.prepare("UPDATE memory_items SET metadata_json = ? WHERE id = ?").run(
				'{"source":"observer_summary"}',
				otherSummary,
			);
			const summarySessionId = continuity === "mapped" ? fixture.sessionId : continuity;
			const filters: (MemoryFilters | null)[] = [
				null,
				{ project: "test-project" },
				{ project: "absent" },
				{ session_id: session },
				{ scope_id: scopeId },
				{ ownership_scope: "mine" },
				{ ownership_scope: "theirs" },
			];
			const ctx = context();
			// Act
			const comparisons = await Promise.all(
				filters.map(async (filter) => ({
					actual: await semanticSearch(
						db,
						"semantic acceptance",
						200,
						filter,
						ctx,
						summarySessionId,
					),
					expected: referenceRows(filter, ctx, 200, [legacyModel, currentModel], summarySessionId),
				})),
			);
			// Assert: exact ordering, not just sets or approximate distances.
			for (const comparison of comparisons) expect(comparison.actual).toEqual(comparison.expected);
			const all = comparisons[0]?.actual ?? [];
			expect(all.map(({ id }) => id)).not.toContain(ids.hidden);
			expect(all.map(({ id }) => id)).not.toContain(inactive);
			expect(all.map(({ id }) => id)).toContain(nullScope);
			expect(all.find(({ id }) => id === ids.local)?.distance).toBe(0.5);
			expect(all.filter(({ distance }) => distance === 1).map(({ id }) => id)).toEqual([
				tied,
				otherSession,
			]);
			expect(all.some(({ id }) => id === summary)).toBe(continuity !== null);
			expect(all.some(({ id }) => id === otherSummary)).toBe(continuity === undefined);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);
});

describe("semantic result limits", () => {
	it.each([1, 2, 3])("preserves baseline tie ordering across LIMIT %s", async (limit) => {
		// Arrange: insertion/row IDs break equal-distance ties exactly as the baseline did.
		const db = fixture.store.db;
		const first = replica("local-default");
		const second = replica("local-default");
		const third = replica("local-default");
		vector(first, 1, legacyModel);
		vector(first, 1, currentModel, 1);
		vector(second, 1);
		vector(third, 1);
		vector(replica("unknown-scope"), 0);
		// Act
		const actual = await semanticSearch(db, "semantic acceptance", limit, null, context());
		// Assert: chunks/models collapse to one result without changing the tie cutoff.
		expect(actual).toEqual(referenceRows(null, context(), limit, [legacyModel, currentModel]));
		expect(actual.map(({ id }) => id)).toEqual([first, second, third].slice(0, limit));
		expect(actual.every(({ distance, score }) => distance === 1 && score === 0.5)).toBe(true);
	});

	it.each([
		[0, 1],
		[-5, 1],
		[Number.NaN, 1],
		[Number.NEGATIVE_INFINITY, 1],
		[2.9, 2],
		[Number.POSITIVE_INFINITY, 200],
		[999, 200],
	])("clamps limit %s to %s before body fetch", async (limit, expectedLimit) => {
		// Arrange: more rows than the maximum and nearest hidden vectors.
		const db = fixture.store.db;
		for (let index = 0; index < 205; index++) vector(replica("local-default"), index + 1);
		vector(replica("unknown-scope"), 0);
		// Act
		const actual = await semanticSearch(db, "semantic acceptance", limit, null, context());
		const expected = referenceRows(null, context(), expectedLimit, [currentModel]);
		// Assert
		expect(actual).toEqual(expected);
		expect(actual).toHaveLength(expectedLimit);
		expect(actual[0]?.distance).toBe(1);
	});
});

describe("semantic current authorization", () => {
	it.each(["revocation", "foreign revision", "edited creation", "raw membership only"])(
		"reads current authorization after %s without losing genuine history",
		async (change) => {
			// Arrange: warm search before changing authority; recompute context as real callers do.
			const ids = await visibilityCorpus();
			const db = fixture.store.db;
			const before = await semanticSearch(db, "semantic acceptance", 10, null, context());
			if (change === "raw membership only")
				db.exec("DELETE FROM scope_membership_authorization_evidence");
			else
				db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?").run(
					scopeId,
				);
			if (change === "foreign revision")
				db.transaction(() =>
					recordForeignMemoryRevision(db, String(row(ids.creation).import_key), "replication"),
				)();
			if (change === "edited creation")
				db.prepare("UPDATE memory_items SET body_text = 'Edited' WHERE id = ?").run(ids.creation);
			// Act
			const ctx = context();
			const after = await semanticSearch(db, "semantic acceptance", 10, null, ctx);
			// Assert: immutable matching creation survives revocation; mutable origin cannot substitute.
			expect(before.map(({ id }) => id)).toContain(ids.managed);
			expect(after).toEqual(referenceRows(null, ctx, 10, [currentModel]));
			expect(after.map(({ id }) => id)).not.toContain(ids.managed);
			expect(after.map(({ id }) => id)).not.toContain(ids.hidden);
			expect(after.map(({ id }) => id)).toContain(ids.local);
			expect(after.some(({ id }) => id === ids.creation)).toBe(
				!["foreign revision", "edited creation"].includes(change),
			);
		},
	);

	it("evaluates distance only for authorized matching-model chunks before ranking", async () => {
		// Arrange: instrument the SQL function, not the query builder or a substitute query.
		const ids = await visibilityCorpus();
		const db = fixture.store.db;
		vector(ids.hidden, 0, currentModel, 1);
		vector(ids.local, 0, "incompatible", 1);
		vector(ids.local, 5, currentModel, 2);
		vector(999999, 0);
		const inactive = replica("local-default");
		vector(inactive, 0);
		db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(inactive);
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Cutover",
			status: "completed",
			metadata: { target_model: currentModel },
		});
		const evaluated: number[] = [];
		db.function("vec_distance_l2", (bytes: Buffer, _query: Buffer) => {
			const value = bytes.readFloatLE(0);
			evaluated.push(value);
			return value;
		});
		// Act
		const results = await semanticSearch(db, "semantic acceptance", 1, null, context());
		// Assert: hidden/incompatible zero-distance vectors never enter distance or MIN/ranking.
		expect(evaluated.sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
		expect(results.map(({ id, distance, score }) => ({ id, distance, score }))).toEqual([
			{ id: ids.local, distance: 1, score: 0.5 },
		]);
	});
});

it.each(["local", "manual", "invite"])(
	"retains unmanaged %s authorship without membership or managed proof",
	async (authority) => {
		// Arrange: replicas have no local creation snapshots; only the explicit unmanaged exception applies.
		enroll();
		const db = fixture.store.db;
		db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, status, created_at, updated_at)
		VALUES ('history', 'History', 'user', ?, 'archived', '2026-01-01', '2026-01-01')`).run(
			authority,
		);
		const own = replica("history");
		const foreign = replica("history");
		db.prepare("UPDATE memory_items SET origin_device_id = ? WHERE id = ?").run(
			fixture.store.deviceId,
			own,
		);
		vector(own, 1);
		vector(foreign, 0);
		// Act
		const ctx = context();
		const results = await semanticSearch(db, "semantic acceptance", 1, null, ctx);
		// Assert
		expect(results).toEqual(referenceRows(null, ctx, 1, [currentModel]));
		expect(results.map(({ id }) => id)).toEqual([own]);
		expect(results.map(({ id }) => id)).not.toContain(foreign);
	},
);

type Opcode = {
	addr: number;
	opcode: string;
	p1: number;
	p2: number;
	p3: number;
	p4: string | null;
};

function assertPrefilterBytecode(ops: Opcode[]) {
	const columns = fixture.store.db.pragma("table_xinfo(memory_vectors)") as {
		name: string;
		cid: number;
	}[];
	const columnId = (name: string) => columns.find((column) => column.name === name)?.cid;
	const embedding = ops.find((op) => op.opcode === "VColumn" && op.p2 === columnId("embedding"));
	expect(embedding).toBeDefined();
	if (!embedding) throw new Error("missing embedding VColumn");
	const vectorLoop = ops.find((op) => op.opcode === "VNext" && op.p1 === embedding.p1);
	const model = ops.find(
		(op) => op.opcode === "VColumn" && op.p1 === embedding.p1 && op.p2 === columnId("model"),
	);
	const memory = ops.find(
		(op) => op.opcode === "VColumn" && op.p1 === embedding.p1 && op.p2 === columnId("memory_id"),
	);
	expect(model).toBeDefined();
	expect(memory).toBeDefined();
	const beforeEmbedding = ops.filter((op) => op.addr < embedding.addr);
	// Both rejection jumps bypass embedding extraction, not just the distance function.
	expect(
		beforeEmbedding.some(
			(op) =>
				op.opcode === "Ne" &&
				(op.p1 === model?.p3 || op.p3 === model?.p3) &&
				op.p2 === vectorLoop?.addr,
		),
	).toBe(true);
	const seek = beforeEmbedding.find((op) => op.opcode === "SeekGE" && op.p3 === memory?.p3);
	expect(seek).toBeDefined();
	expect(
		beforeEmbedding.some(
			(op) => op.opcode === "IdxGT" && op.p1 === seek?.p1 && op.p2 === vectorLoop?.addr,
		),
	).toBe(true);
	const distance = ops.find(
		(op) => op.opcode === "Function" && op.p4?.startsWith("vec_distance_l2("),
	);
	expect(distance?.addr).toBeGreaterThan(embedding.addr);
}

function assertLateBodyBytecode(ops: Opcode[]) {
	const db = fixture.store.db;
	const root = (
		db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'memory_items'").get() as {
			rootpage: number;
		}
	).rootpage;
	const tableCursors = ops
		.filter((op) => op.opcode === "OpenRead" && op.p2 === root)
		.map((op) => op.p1);
	const seek = ops.findLast((op) => op.opcode === "SeekRowid" && tableCursors.includes(op.p1));
	if (!seek) throw new Error("missing final memory body lookup");
	const materialize = ops.findLast((op) => op.opcode === "Gosub" && op.addr < seek.addr);
	if (!materialize) throw new Error("missing limited ranking materialization");
	const subroutine = ops.filter((op) => op.addr >= materialize.p2 && op.addr < materialize.addr);
	const limitedInsert = subroutine.findLast((op) => op.opcode === "Insert");
	expect(limitedInsert).toBeDefined();
	expect(subroutine.some((op) => op.opcode === "IfNotZero")).toBe(true);
	expect(subroutine.some((op) => op.opcode === "Return" && op.p1 === materialize.p1)).toBe(true);
	expect(
		ops.some(
			(op) =>
				op.opcode === "Rewind" &&
				op.p1 === limitedInsert?.p1 &&
				op.addr > materialize.addr &&
				op.addr < seek.addr,
		),
	).toBe(true);
	const bodyCid = (db.pragma("table_info(memory_items)") as { name: string; cid: number }[]).find(
		(column) => column.name === "body_text",
	)?.cid;
	const bodyReads = ops.filter(
		(op) => op.opcode === "Column" && tableCursors.includes(op.p1) && op.p2 === bodyCid,
	);
	expect(bodyReads.length).toBeGreaterThan(0);
	expect(bodyReads.every((op) => op.addr > seek.addr)).toBe(true);
}

it.each([false, true])(
	"production EXPLAIN checks authorization/model before embedding and fetches bodies after LIMIT (mixed %s)",
	async (mixed) => {
		// Arrange
		const ids = await visibilityCorpus();
		if (mixed) vector(ids.local, 0.5, legacyModel, 1);
		// Act
		const captured = await captureSearch(() =>
			semanticSearch(fixture.store.db, "semantic acceptance", 1, null, context()),
		);
		const plan = fixture.store.db
			.prepare(`EXPLAIN QUERY PLAN ${captured.sql}`)
			.all(...captured.params) as { id: number; parent: number; detail: string }[];
		const bytecode = fixture.store.db
			.prepare(`EXPLAIN ${captured.sql}`)
			.all(...captured.params) as Opcode[];
		// Assert
		expect(captured.results).toHaveLength(1);
		const ranking = plan.find((item) => item.detail === "MATERIALIZE scoped_vectors");
		expect(ranking).toBeDefined();
		expect(
			plan.some(
				(item) => item.detail === "MATERIALIZE authorized_ids" && item.parent === ranking?.id,
			),
		).toBe(true);
		expect(plan.some((item) => /SEARCH authorized_ids/.test(item.detail))).toBe(true);
		expect(
			plan.some(
				(item) =>
					/SEARCH memory_items USING INTEGER PRIMARY KEY/.test(item.detail) && item.parent === 0,
			),
		).toBe(true);
		expect(captured.sql).not.toMatch(/\bMATCH\b/);
		assertPrefilterBytecode(bytecode);
		assertLateBodyBytecode(bytecode);
	},
);

describe("semantic model catalog compatibility", () => {
	it.each(["unknown", null])(
		"keeps global mixed-corpus rejection with hidden label %s",
		async (label) => {
			// Arrange: use an ordinary metadata table to exercise historical nullable labels (vec0 rejects NULL).
			const db = fixture.store.db;
			db.exec("DROP TABLE memory_vectors; CREATE TABLE memory_vectors(model TEXT)");
			db.prepare("INSERT INTO memory_vectors(model) VALUES (?), (?)").run(currentModel, label);
			// Act
			const primary = resolveSemanticSearchModel(db, currentModel);
			const models = resolveSemanticSearchModels(db, currentModel);
			db.prepare("DELETE FROM memory_vectors WHERE model IS ?").run(label);
			const cleanModels = resolveSemanticSearchModels(db, currentModel);
			// Assert: an unverified mixed corpus never becomes an exclusively current corpus.
			expect(primary).toBeNull();
			expect(models).toEqual([]);
			expect(cleanModels).toEqual([currentModel]);
		},
	);

	it.each(["pending", "running", "failed", "completed"] as const)(
		"preserves compatible rebuild policy in state %s",
		(status) => {
			// Arrange
			vector(replica("local-default"), 1, legacyModel);
			vector(replica("local-default"), 2);
			const db = fixture.store.db;
			startMaintenanceJob(db, {
				kind: "vector_model_migration",
				title: "Migration",
				status,
				metadata: { source_model: legacyModel, target_model: currentModel },
			});
			const prepare = vi.spyOn(db, "prepare");
			// Act
			const models = resolveSemanticSearchModels(db, currentModel);
			// Assert: one DISTINCT catalog shared by primary and compatible-model expansion.
			expect(models).toEqual(status === "completed" ? [currentModel] : [legacyModel, currentModel]);
			expect(
				prepare.mock.calls.filter(([sql]) => /SELECT DISTINCT model FROM memory_vectors/.test(sql)),
			).toHaveLength(1);
			expect(prepare.mock.calls.some(([sql]) => /COUNT\(\*\).*memory_vectors/s.test(sql))).toBe(
				false,
			);
		},
	);

	it("sees catalog changes on the next search and preserves global incompatibility", async () => {
		// Arrange
		const id = replica("local-default");
		vector(id, 1);
		const db = fixture.store.db;
		// Act
		const before = await semanticSearch(db, "semantic acceptance", 10, null, context());
		vector(replica("unknown-scope"), 0, "incompatible");
		const after = await semanticSearch(db, "semantic acceptance", 10, null, context());
		db.prepare("DELETE FROM memory_vectors WHERE model = 'incompatible'").run();
		const restored = await semanticSearch(db, "semantic acceptance", 10, null, context());
		// Assert: hidden models still participate in the existing global policy, not per-author policy.
		expect(before.map(({ id }) => id)).toEqual([id]);
		expect(after).toEqual([]);
		expect(restored).toEqual(before);
	});

	it.each(["empty", "absent"])(
		"does not initialize embeddings for an %s vector corpus",
		async (mode) => {
			// Arrange
			if (mode === "absent") fixture.store.db.exec("DROP TABLE memory_vectors");
			const client = vi.mocked(embeddings.getEmbeddingClient).mockClear();
			const embed = vi.mocked(embeddings.embedTexts).mockClear();
			// Act
			const results = await semanticSearch(
				fixture.store.db,
				"semantic acceptance",
				10,
				null,
				context(),
			);
			// Assert
			expect(results).toEqual([]);
			expect(client).not.toHaveBeenCalled();
			expect(embed).not.toHaveBeenCalled();
		},
	);
});

describe("semantic migration and unavailable catalog edges", () => {
	it("shares one model catalog in a search and reloads it for the next search", async () => {
		// Arrange: compatible expansion requires both labels, including duplicate model rows.
		const db = fixture.store.db;
		const id = replica("local-default");
		vector(id, 1, legacyModel);
		vector(id, 2, currentModel, 1);
		vector(id, 3, currentModel, 2);
		const prepare = vi.spyOn(db, "prepare");
		const countCatalogs = () =>
			prepare.mock.calls.filter(([sql]) => sql === "SELECT DISTINCT model FROM memory_vectors")
				.length;
		// Act
		const before = await semanticSearch(db, "semantic acceptance", 10, null, context());
		const firstReads = countCatalogs();
		db.prepare("DELETE FROM memory_vectors WHERE model = ?").run(legacyModel);
		const after = await semanticSearch(db, "semantic acceptance", 10, null, context());
		// Assert
		expect(firstReads).toBe(1);
		expect(countCatalogs()).toBe(2);
		expect(before[0]?.distance).toBe(1);
		expect(after[0]?.distance).toBe(2);
	});

	it.each([
		["pending", false, []],
		["running", false, []],
		["failed", false, []],
		["completed", false, [currentModel]],
		["pending", true, [currentModel]],
		["running", true, [currentModel]],
		["failed", true, []],
	] as const)(
		"preserves incompatible migration state %s and reconciliation=%s",
		(status, reconciled, expected) => {
			// Arrange
			const db = fixture.store.db;
			vector(replica("local-default"), 0, "incompatible");
			vector(replica("local-default"), 1);
			startMaintenanceJob(db, {
				kind: "vector_model_migration",
				title: "Incompatible migration",
				status,
				metadata: {
					source_model: "incompatible",
					target_model: currentModel,
					reconciliation_target_coverage_complete: reconciled,
				},
			});
			// Act
			const models = resolveSemanticSearchModels(db, currentModel);
			db.prepare("DELETE FROM memory_vectors WHERE model = ?").run(currentModel);
			const withoutTarget = resolveSemanticSearchModels(db, currentModel);
			// Assert: target coverage metadata must not invent an absent target model.
			expect(models).toEqual(expected);
			expect(withoutTarget).toEqual([]);
		},
	);

	it("falls back without inference when vec0 exists in schema but cannot be read", async () => {
		// Arrange: simulate a persisted vec0 table opened on a runtime without its module.
		vector(replica("local-default"), 1);
		const db = fixture.store.db;
		const prepare = db.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			if (sql.includes("FROM memory_vectors")) throw new Error("no such module: vec0");
			return prepare(sql);
		});
		const client = vi.mocked(embeddings.getEmbeddingClient).mockClear();
		// Act
		const models = resolveSemanticSearchModels(db, currentModel);
		const results = await semanticSearch(db, "semantic acceptance", 10, null, context());
		// Assert
		expect(models).toEqual([]);
		expect(results).toEqual([]);
		expect(client).not.toHaveBeenCalled();
	});
});
