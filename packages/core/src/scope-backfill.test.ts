import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import {
	backfillScopeIds,
	classifyLegacyMemoryScope,
	ensureScopeBackfillScopes,
	hasPendingScopeBackfill,
	LEGACY_SHARED_REVIEW_SCOPE_ID,
	runScopeBackfillPass,
} from "./scope-backfill.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";
import { initTestSchema } from "./test-utils.js";

function insertSession(
	db: InstanceType<typeof Database>,
	overrides: { project?: string | null; cwd?: string | null; gitRemote?: string | null } = {},
): number {
	const now = "2026-05-01T00:00:00Z";
	const cwd = Object.hasOwn(overrides, "cwd") ? overrides.cwd : "/tmp/codemem-test";
	const project = Object.hasOwn(overrides, "project") ? overrides.project : "codemem-test";
	const gitRemote = Object.hasOwn(overrides, "gitRemote") ? overrides.gitRemote : null;
	const result = db
		.prepare(
			`INSERT INTO sessions(started_at, cwd, project, git_remote, user, tool_version)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(now, cwd, project, gitRemote, "test-user", "test");
	return Number(result.lastInsertRowid);
}

function insertMemory(
	db: InstanceType<typeof Database>,
	input: {
		sessionId: number;
		title: string;
		visibility?: string | null;
		workspaceKind?: string | null;
		workspaceId?: string | null;
		active?: number;
		deletedAt?: string | null;
		importKey?: string | null;
		scopeId?: string | null;
	},
): number {
	const now = "2026-05-01T00:00:00Z";
	const result = db
		.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, created_at, updated_at,
				visibility, workspace_id, workspace_kind, active, deleted_at,
				import_key, scope_id, metadata_json
			 ) VALUES (?, 'discovery', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.sessionId,
			input.title,
			`${input.title} body`,
			now,
			now,
			input.visibility ?? null,
			input.workspaceId ?? null,
			input.workspaceKind ?? null,
			input.active ?? 1,
			input.deletedAt ?? null,
			input.importKey ?? null,
			input.scopeId ?? null,
			toJson({}),
		);
	return Number(result.lastInsertRowid);
}

function insertReplicationOp(
	db: InstanceType<typeof Database>,
	opId: string,
	entityId: string,
): void {
	db.prepare(
		`INSERT INTO replication_ops(
			op_id, entity_type, entity_id, op_type, payload_json,
			clock_rev, clock_updated_at, clock_device_id, device_id, created_at
		 ) VALUES (?, 'memory_item', ?, 'upsert', NULL, 1, ?, 'dev-a', 'dev-a', ?)`,
	).run(opId, entityId, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z");
}

describe("scope backfill", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("classifies private and ambiguous legacy memories conservatively", () => {
		expect(classifyLegacyMemoryScope({ visibility: "private" })).toEqual({
			scopeId: LOCAL_DEFAULT_SCOPE_ID,
			reason: "private_or_personal",
			needsReview: false,
		});
		expect(
			classifyLegacyMemoryScope({
				visibility: "shared",
				project: "codemem",
				workspaceId: "shared:default",
			}),
		).toEqual({
			scopeId: LEGACY_SHARED_REVIEW_SCOPE_ID,
			reason: "shared_ambiguous_review",
			needsReview: true,
		});
		expect(
			classifyLegacyMemoryScope({
				visibility: "shared",
				cwd: "/work/acme/service",
				gitRemote: "https://example.com/acme/service.git",
				workspaceId: "shared:team",
			}),
		).toEqual({
			scopeId: LEGACY_SHARED_REVIEW_SCOPE_ID,
			reason: "shared_with_canonical_workspace_review",
			needsReview: true,
		});
	});

	it("seeds required migration scopes idempotently", () => {
		expect(ensureScopeBackfillScopes(db, "2026-05-01T00:00:00Z")).toBe(2);
		expect(ensureScopeBackfillScopes(db, "2026-05-01T00:00:00Z")).toBe(0);

		const rows = db
			.prepare("SELECT scope_id, label, authority_type FROM replication_scopes ORDER BY scope_id")
			.all() as Array<{ scope_id: string; label: string; authority_type: string }>;
		expect(rows).toEqual([
			{
				scope_id: LEGACY_SHARED_REVIEW_SCOPE_ID,
				label: "Legacy shared review",
				authority_type: "local",
			},
			{ scope_id: LOCAL_DEFAULT_SCOPE_ID, label: "Local only", authority_type: "local" },
		]);
	});

	it("backfills memories and existing replication ops without overwriting scopes", () => {
		const privateSession = insertSession(db, { project: "personal", cwd: "/home/me/personal" });
		const sharedSession = insertSession(db, {
			project: "service",
			cwd: "/work/acme/service",
			gitRemote: "https://example.com/acme/service.git",
		});
		const ambiguousSession = insertSession(db, { project: "codemem", cwd: null });

		const privateId = insertMemory(db, {
			sessionId: privateSession,
			title: "Private",
			visibility: "private",
			workspaceKind: "personal",
			workspaceId: "personal:actor-1",
			importKey: "key:private",
		});
		insertMemory(db, {
			sessionId: sharedSession,
			title: "Shared clear",
			visibility: "shared",
			workspaceKind: "shared",
			workspaceId: "shared:team",
			importKey: "key:shared",
		});
		insertMemory(db, {
			sessionId: ambiguousSession,
			title: "Shared ambiguous",
			visibility: "shared",
			workspaceKind: "shared",
			workspaceId: "shared:default",
			importKey: "key:ambiguous",
		});
		insertMemory(db, {
			sessionId: sharedSession,
			title: "Deleted shared",
			visibility: "shared",
			workspaceKind: "shared",
			workspaceId: "shared:team",
			active: 0,
			deletedAt: "2026-05-01T00:00:00Z",
			importKey: "key:deleted",
		});
		insertMemory(db, {
			sessionId: sharedSession,
			title: "Already scoped",
			visibility: "shared",
			workspaceKind: "shared",
			workspaceId: "shared:team",
			importKey: "key:custom",
			scopeId: "custom-scope",
		});

		insertReplicationOp(db, "op-private", "key:private");
		insertReplicationOp(db, "op-deleted", "key:deleted");
		insertReplicationOp(db, "op-numeric", String(privateId));
		insertReplicationOp(db, "op-missing", "key:missing");

		expect(hasPendingScopeBackfill(db)).toBe(true);
		const result = backfillScopeIds(db, { now: "2026-05-01T00:00:00Z" });

		expect(result.seededScopes).toBe(2);
		expect(result.checkedMemoryItems).toBe(4);
		expect(result.updatedMemoryItems).toBe(4);
		expect(result.checkedReplicationOps).toBe(3);
		expect(result.updatedReplicationOps).toBe(3);
		expect(result.skippedReplicationOps).toBe(0);

		const memories = db
			.prepare("SELECT import_key, scope_id FROM memory_items ORDER BY import_key")
			.all() as Array<{ import_key: string; scope_id: string }>;
		expect(memories).toEqual([
			{ import_key: "key:ambiguous", scope_id: LEGACY_SHARED_REVIEW_SCOPE_ID },
			{ import_key: "key:custom", scope_id: "custom-scope" },
			{ import_key: "key:deleted", scope_id: LEGACY_SHARED_REVIEW_SCOPE_ID },
			{ import_key: "key:private", scope_id: LOCAL_DEFAULT_SCOPE_ID },
			{ import_key: "key:shared", scope_id: LEGACY_SHARED_REVIEW_SCOPE_ID },
		]);

		const ops = db
			.prepare("SELECT op_id, scope_id FROM replication_ops ORDER BY op_id")
			.all() as Array<{ op_id: string; scope_id: string | null }>;
		expect(ops).toEqual([
			{ op_id: "op-deleted", scope_id: LEGACY_SHARED_REVIEW_SCOPE_ID },
			{ op_id: "op-missing", scope_id: null },
			{ op_id: "op-numeric", scope_id: LOCAL_DEFAULT_SCOPE_ID },
			{ op_id: "op-private", scope_id: LOCAL_DEFAULT_SCOPE_ID },
		]);

		const second = backfillScopeIds(db, { now: "2026-05-01T00:00:00Z" });
		expect(second.seededScopes).toBe(0);
		expect(second.updatedMemoryItems).toBe(0);
		expect(second.updatedReplicationOps).toBe(0);
	});

	it("skips unmatchable ops when selecting limited replication-op batches", () => {
		const sessionId = insertSession(db, { project: "codemem", cwd: null });
		insertMemory(db, {
			sessionId,
			title: "Scoped memory",
			visibility: "private",
			workspaceKind: "personal",
			workspaceId: "personal:actor-1",
			importKey: "key:matchable",
			scopeId: LOCAL_DEFAULT_SCOPE_ID,
		});
		insertReplicationOp(db, "op-aaa-unmatched", "key:missing");
		insertReplicationOp(db, "op-zzz-matchable", "key:matchable");

		const result = backfillScopeIds(db, { memoryLimit: 10, replicationOpLimit: 1 });

		expect(result.checkedReplicationOps).toBe(1);
		expect(result.updatedReplicationOps).toBe(1);
		expect(result.skippedReplicationOps).toBe(0);
		expect(
			(
				db
					.prepare("SELECT scope_id FROM replication_ops WHERE op_id = 'op-zzz-matchable'")
					.get() as {
					scope_id: string | null;
				}
			).scope_id,
		).toBe(LOCAL_DEFAULT_SCOPE_ID);
	});

	it("runs as a maintenance pass and completes when no matching op work remains", async () => {
		const sessionId = insertSession(db, { project: "personal", cwd: "/home/me/personal" });
		insertMemory(db, {
			sessionId,
			title: "Private",
			visibility: "private",
			workspaceKind: "personal",
			workspaceId: "personal:actor-1",
			importKey: "key:private",
		});
		insertReplicationOp(db, "op-missing", "key:missing");

		await expect(runScopeBackfillPass(db, { batchSize: 10 })).resolves.toBe(false);

		const memory = db.prepare("SELECT scope_id FROM memory_items").get() as { scope_id: string };
		expect(memory.scope_id).toBe(LOCAL_DEFAULT_SCOPE_ID);
		expect(hasPendingScopeBackfill(db)).toBe(false);
	});

	it("hasPendingScopeBackfill returns quickly without joining replication_ops to memory_items", () => {
		// Reproduces the slow-startup case: a database where the legacy
		// pendingWorkCount path's correlated EXISTS join (replication_ops
		// vs memory_items with TRIM and OR-on-keys) blocked the main
		// thread on Pi 4 and even on M4 Max desktops. The fast existence
		// probes must answer "yes, there is pending work" without doing
		// that join. A vitest spy on the bound prepare statement caches
		// the SQL string, but the cleanest assertion is that the query
		// finishes well under a soft deadline even when there are many
		// replication_ops with no matching memory_items.

		// Seed a few memory_items already stamped + many replication_ops
		// pointing at non-existent entity_ids. Under the old correlated
		// EXISTS path each replication_op would scan memory_items twice
		// (once per OR branch); under the cheap probe path the first
		// missing scope_id alone short-circuits.
		const sessionId = insertSession(db, { project: "p", cwd: "/x" });
		insertMemory(db, {
			sessionId,
			title: "stamped",
			workspaceId: "personal:actor-1",
			workspaceKind: "personal",
			importKey: "key:stamped",
			scopeId: LOCAL_DEFAULT_SCOPE_ID,
		});
		const insertOp = db.prepare(
			`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json,
				clock_rev, clock_updated_at, clock_device_id, device_id, created_at, scope_id)
			 VALUES (?, 'memory_item', ?, 'upsert', NULL, 1, ?, 'dev', 'dev', ?, NULL)`,
		);
		const ts = "2026-05-04T00:00:00Z";
		for (let index = 0; index < 500; index += 1) {
			insertOp.run(`op-orphan-${index}`, `key:does-not-exist-${index}`, ts, ts);
		}

		const start = Date.now();
		const pending = hasPendingScopeBackfill(db);
		const elapsedMs = Date.now() - start;

		expect(pending).toBe(true);
		// Soft cap. The intent is "must not depend on the orphan-op
		// volume above" — under the old COUNT(*) join, this assertion
		// would fail on slow disks even at this size.
		expect(elapsedMs).toBeLessThan(50);
	});

	it("hasPendingScopeBackfill rewakes when an orphan op becomes stampable later", async () => {
		// Reviewer-flagged regression: after a complete pass leaves orphan
		// ops behind (no matching memory_items row), a later insert of the
		// matching memory turns those orphans into actual work. The
		// unstamped op count is unchanged, so a count-only probe would
		// say "no work" forever. The probe must also catch the case where
		// new stamped memory_items appear past the recorded watermark.
		const sessionId = insertSession(db, { project: "p", cwd: "/x" });
		insertMemory(db, {
			sessionId,
			title: "already stamped",
			workspaceId: "personal:actor-1",
			workspaceKind: "personal",
			importKey: "key:already-stamped",
			scopeId: LOCAL_DEFAULT_SCOPE_ID,
		});
		// One orphan op pointing at a memory that doesn't exist yet.
		insertReplicationOp(db, "op-pending", "key:future-memory");

		// Run a complete pass — the orphan stays unstamped, but the
		// runner records both watermarks at completion.
		await expect(runScopeBackfillPass(db, { batchSize: 10 })).resolves.toBe(false);
		expect(hasPendingScopeBackfill(db)).toBe(false);

		// The matching memory arrives later (e.g., from a peer sync
		// applying after backfill ran). Its scope_id is already stamped
		// at insert time, so the orphan is now stampable, even though
		// the unstamped op count didn't grow.
		insertMemory(db, {
			sessionId,
			title: "future memory arrives",
			workspaceId: "personal:actor-1",
			workspaceKind: "personal",
			importKey: "key:future-memory",
			scopeId: LOCAL_DEFAULT_SCOPE_ID,
		});

		expect(hasPendingScopeBackfill(db)).toBe(true);
	});
});
