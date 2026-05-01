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
		expect(hasPendingScopeBackfill(db)).toBe(false);

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
		expect(hasPendingScopeBackfill(db)).toBe(false);
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
});
