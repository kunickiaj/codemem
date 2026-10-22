import { beforeEach, expect, it, vi } from "vitest";
import {
	buildFilterBranchesWithContext,
	buildFilterClausesWithContext,
	type FilterResult,
	type OwnershipFilterContext,
} from "./filters.js";
import { refreshManagedScopeFixture } from "./managed-scope-test-fixtures.js";
import { recordForeignMemoryRevision } from "./memory-creation-provenance.js";
import { scopeId, useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { ensureVectorSchema } from "./schema-bootstrap.js";
import { resolveVisibleScopeIds } from "./scope-resolution.js";
import { summaryLikeSqlPredicate } from "./summary-memory.js";
import type { MemoryFilters } from "./types.js";

const { fixture, enroll, remember, rememberScoped, row } = useLocalCaptureFixture();

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected test network request"));
});

async function seedVisibility() {
	enroll();
	await refreshManagedScopeFixture(fixture.store.db, {
		keysDir: fixture.keysDir,
		deviceId: fixture.store.deviceId,
		scopeIds: [scopeId],
	});
	const local = remember("Local creation and unmanaged author overlap");
	const creation = rememberScoped("Managed immutable creation");
	const insert = fixture.store.db.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, created_at, updated_at, scope_id,
		 origin_device_id, actor_id, metadata_json, import_key, active, tags_text, project)
		VALUES (?, 'discovery', 'Replica', 'Body', '2026-01-01', '2026-01-01', ?,
		 ?, ?, '{}', ?, 1, 'tag', 'test-project')`);
	const replica = (scope: string | null, key: string) =>
		Number(
			insert.run(fixture.sessionId, scope, fixture.store.deviceId, "other-actor", key)
				.lastInsertRowid,
		);
	const managed = replica(scopeId, "managed-replica");
	const hidden = replica("unknown-scope", "hidden-replica");
	const legacy = replica(null, "null-scope-replica");
	return { local, creation, managed, hidden, legacy };
}

function readIds(branches: FilterResult[]): number[] {
	const source = branches
		.map((branch) => {
			const from = branch.joinSessions
				? "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
				: "memory_items";
			return `SELECT memory_items.id FROM ${from} WHERE ${branch.clauses.join(" AND ") || "1 = 1"}`;
		})
		.join(" UNION ALL ");
	return (
		fixture.store.db
			.prepare(`SELECT id FROM (${source}) ORDER BY id`)
			.all(...branches.flatMap((branch) => branch.params)) as { id: number }[]
	).map(({ id }) => id);
}

const contexts = [
	"current proof",
	"raw membership only",
	"revoked membership",
	"archived scope",
	"advanced epoch",
	"missing key",
	"replaced key",
	"foreign revision",
	"edited creation",
	"other actor",
	"claimed device and legacy actor",
	"blank device",
	"unmanaged overlap",
] as const;

function scenarioContext(
	scenario: (typeof contexts)[number],
	ids: Awaited<ReturnType<typeof seedVisibility>>,
) {
	const db = fixture.store.db;
	if (scenario === "raw membership only")
		db.exec("DELETE FROM scope_membership_authorization_evidence");
	if (["revoked membership", "foreign revision", "edited creation"].includes(scenario))
		db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?").run(scopeId);
	if (scenario === "archived scope")
		db.prepare("UPDATE replication_scopes SET status = 'archived' WHERE scope_id = ?").run(scopeId);
	if (scenario === "advanced epoch")
		db.prepare(
			"UPDATE replication_scopes SET membership_epoch = membership_epoch + 1 WHERE scope_id = ?",
		).run(scopeId);
	if (scenario === "foreign revision")
		db.transaction(() =>
			recordForeignMemoryRevision(db, String(row(ids.creation).import_key), "replication"),
		)();
	if (scenario === "edited creation")
		db.prepare("UPDATE memory_items SET body_text = 'Changed' WHERE id = ?").run(ids.creation);
	if (scenario === "unmanaged overlap")
		db.prepare(
			"UPDATE replication_scopes SET status = 'archived', authority_type = 'manual' WHERE scope_id = ?",
		).run(scopeId);
	return identityContext(scenario);
}

function identityContext(scenario: (typeof contexts)[number]): OwnershipFilterContext {
	const db = fixture.store.db;
	const context: OwnershipFilterContext = { ...fixture.store.ownershipFilterContext() };
	if (scenario === "missing key" || scenario === "replaced key") {
		context.expectedPublicKey = scenario === "missing key" ? "" : "replaced-public-key";
		context.loadExpectedPublicKey = undefined;
	}
	if (scenario === "other actor") context.actorId = "other-actor";
	if (scenario === "claimed device and legacy actor") {
		context.actorId = "new-actor";
		context.claimedDeviceIds = [fixture.store.deviceId];
		context.legacyActorIds = [fixture.store.actorId];
	}
	if (scenario === "blank device") context.deviceId = " ";
	context.visibleScopeIds = resolveVisibleScopeIds(db, context.deviceId, context);
	return context;
}

it.each(contexts)("disjoint reads exactly match ordinary reads: %s", async (scenario) => {
	// Arrange: use real capture and coordinator-proof writers, never fabricated proof rows.
	const ids = await seedVisibility();
	const context = scenarioContext(scenario, ids);
	const filters: (MemoryFilters | undefined)[] = [
		undefined,
		{ ownership_scope: "mine" },
		{ ownership_scope: "theirs" },
		{ project: "test-project" },
		{ project: "absent" },
		{ scope_id: scopeId },
		{ kind: "decision" },
	];

	// Act: execute each branch with UNION ALL so duplicates cannot hide behind a set union.
	const results = filters.map((filter) => ({
		ordinary: readIds([buildFilterClausesWithContext(filter, context)]),
		disjoint: readIds(buildFilterBranchesWithContext(filter, context)),
	}));

	// Assert: parity includes filters/parameter order, while explicit IDs catch shared policy mistakes.
	for (const result of results) {
		expect(result.disjoint).toEqual(result.ordinary);
		expect(new Set(result.disjoint).size).toBe(result.disjoint.length);
		expect(result.disjoint).not.toContain(ids.hidden);
	}
	let expected = [ids.local, ids.legacy];
	if (scenario !== "blank device") {
		if (!["foreign revision", "edited creation", "missing key", "replaced key"].includes(scenario))
			expected.push(ids.creation);
		if (
			[
				"current proof",
				"other actor",
				"claimed device and legacy actor",
				"unmanaged overlap",
			].includes(scenario)
		)
			expected.push(ids.managed);
	} else expected = [];
	expect(results[0]?.disjoint).toEqual(expected.sort((a, b) => a - b));
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each(["database resolution", "DB-less", "visibility disabled", "large scope list"])(
	"retains ordinary filter behavior with %s",
	async (mode) => {
		// Arrange
		const ids = await seedVisibility();
		const context = { ...fixture.store.ownershipFilterContext() };
		if (mode === "DB-less") {
			context.scopeVisibilityDb = undefined;
			context.visibleScopeIds = undefined;
		}
		if (mode === "database resolution") context.visibleScopeIds = undefined;
		if (mode === "visibility disabled") context.enforceScopeVisibility = false;
		if (mode === "large scope list")
			context.visibleScopeIds = [scopeId, ...Array.from({ length: 1200 }, (_, i) => `unused-${i}`)];
		// Act
		const ordinary = readIds([buildFilterClausesWithContext(null, context)]);
		const disjoint = readIds(buildFilterBranchesWithContext(null, context));
		// Assert
		expect(disjoint).toEqual(ordinary);
		expect(disjoint).toContain(ids.local);
		if (mode !== "visibility disabled") expect(disjoint).not.toContain(ids.hidden);
	},
);

it.each(["local", "manual", "invite"])(
	"preserves unmanaged %s authorship edge cases without widening access",
	async (authority) => {
		// Arrange: revoke ordinary access; only historical authorship may keep these rows visible.
		const ids = await seedVisibility();
		const db = fixture.store.db;
		db.prepare(
			`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, status, created_at, updated_at)
			VALUES ('unmanaged-history', 'History', 'user', ?, 'archived', '2026-01-01', '2026-01-01')`,
		).run(authority);
		db.prepare("UPDATE memory_items SET scope_id = 'unmanaged-history' WHERE id = ?").run(
			ids.local,
		);
		const cases = [
			{ origin: fixture.store.deviceId, metadata: "{}", key: "replica", allowed: true },
			{
				origin: " ",
				metadata: JSON.stringify({ origin_device_id: fixture.store.deviceId }),
				key: "replica",
				allowed: true,
			},
			{ origin: "local", metadata: "{}", key: null, allowed: true },
			{ origin: "local", metadata: "{}", key: "replica", allowed: false },
			{ origin: "foreign", metadata: "{}", key: null, allowed: false },
			{ origin: null, metadata: "{broken", key: null, allowed: false },
		];
		const update = db.prepare(
			"UPDATE memory_items SET origin_device_id = ?, metadata_json = ?, import_key = ? WHERE id = ?",
		);
		// Act
		const results = cases.map((input) => {
			update.run(input.origin, input.metadata, input.key, ids.local);
			const context = fixture.store.ownershipFilterContext();
			const filter = { scope_id: "unmanaged-history" };
			return {
				ordinary: readIds([buildFilterClausesWithContext(filter, context)]),
				disjoint: readIds(buildFilterBranchesWithContext(filter, context)),
			};
		});
		// Assert: imported local sentinels and foreign/missing authors do not bypass revocation.
		for (const [index, result] of results.entries()) {
			expect(result.disjoint).toEqual(result.ordinary);
			expect(result.disjoint).toEqual(cases[index]?.allowed ? [ids.local] : []);
		}
	},
);

it("keeps ordinary scope branches on the covering aggregate index", async () => {
	// Arrange
	await seedVisibility();
	const context = fixture.store.ownershipFilterContext();
	const branches = buildFilterBranchesWithContext(null, context).slice(0, 2);
	// Act: explain exactly the projections used by stats and session classification.
	const plans = branches.flatMap((branch) =>
		[
			"memory_items.active, memory_items.session_id, TRIM(memory_items.tags_text) != ''",
			summaryLikeSqlPredicate(),
		].map((projection) =>
			fixture.store.db
				.prepare(`EXPLAIN QUERY PLAN SELECT ${projection}
		FROM memory_items WHERE ${branch.clauses.join(" AND ")}`)
				.all(...branch.params),
		),
	);
	// Assert: no ordinary branch fetches the wide memory row or scans the table.
	for (const plan of plans) {
		const details = (plan as { detail: string }[]).map(({ detail }) => detail).join("\n");
		expect(details).toContain("USING COVERING INDEX idx_memory_items_scope_aggregates");
		expect(details).not.toMatch(/SCAN memory_items/);
	}
});

it("counts vector rows rather than distinct memories and materializes authorized IDs", async () => {
	// Arrange: multiple chunks for one visible memory, plus hidden/inactive/orphan rows.
	const ids = await seedVisibility();
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	const db = fixture.store.db;
	ensureVectorSchema(db);
	const insert = db.prepare(
		"INSERT INTO memory_vectors(memory_id, chunk_index, embedding, model, content_hash) VALUES (CAST(? AS INTEGER), CAST(? AS INTEGER), ?, 'fixture-model', 'fixture-hash')",
	);
	const embedding = Buffer.from(new Float32Array(384).buffer);
	for (const [id, chunk] of [
		[ids.local, 0],
		[ids.local, 1],
		[ids.managed, 0],
		[ids.hidden, 0],
		[999999, 0],
	])
		insert.run(id, chunk, embedding);
	const inactive = remember("Inactive vector");
	db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(inactive);
	insert.run(inactive, 0, embedding);
	const prepare = vi.spyOn(db, "prepare");
	// Act
	const before = fixture.store.stats();
	const [query] = prepare.mock.calls.find(([sql]) => sql.includes("WITH visible_ids")) ?? [];
	prepare.mockRestore();
	const branches = buildFilterBranchesWithContext(null, fixture.store.ownershipFilterContext());
	const plan = db
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all(...branches.flatMap((branch) => branch.params)) as { detail: string }[];
	db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?").run(scopeId);
	const after = fixture.store.stats();
	// Assert
	expect(before.database.vector_rows).toBe(3);
	expect(after.database.vector_rows).toBe(2);
	expect(query).toContain("AS MATERIALIZED");
	expect(plan.map(({ detail }) => detail).join("\n")).toContain("MATERIALIZE visible_ids");
	expect(plan.map(({ detail }) => detail).join("\n")).not.toContain(
		"SEARCH memory_items USING INTEGER PRIMARY KEY",
	);
});

it.each(["disabled", "unavailable"])("retains memory stats when vectors are %s", async (state) => {
	// Arrange
	await seedVisibility();
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", state === "disabled" ? "1" : "0");
	const prepare = vi.spyOn(fixture.store.db, "prepare");
	// Act
	const stats = fixture.store.stats();
	// Assert: no vector join is attempted and memory visibility still applies.
	expect(stats.database).toMatchObject({ vector_rows: 0, vector_coverage: 0, memory_items: 4 });
	expect(prepare.mock.calls.some(([sql]) => sql.includes("WITH visible_ids"))).toBe(false);
});
