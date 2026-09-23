import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { REPOSITORY_IDENTITY_METADATA_KEY } from "./project.js";
import {
	analyzeProjectScopeMappingChangeGuardrails,
	analyzeProjectScopeMappingChangesGuardrails,
	deleteProjectScopeSettingsMapping,
	listProjectScopeCandidates,
	listProjectScopeInventory,
	upsertProjectScopeSettingsMapping,
} from "./project-scope-settings.js";
import {
	hasConflictingRepositoryMappings,
	repositoryIdentitiesByWorkspace,
	withRepositoryMappingAliases,
	withRepositoryMappingAliasesFromIdentities,
} from "./repository-mapping-aliases.js";
import { ensureMemoryScopeId, resolveSessionScopeId } from "./scope-stamping.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

function createLinkedWorktree(tmpDir: string, name: string, remote: string) {
	const mainRepo = join(tmpDir, `${name}-main`);
	const worktree = join(tmpDir, `${name}-worktree`);
	const worktreeGitDir = join(mainRepo, ".git", "worktrees", name);
	mkdirSync(worktreeGitDir, { recursive: true });
	mkdirSync(worktree, { recursive: true });
	writeFileSync(join(mainRepo, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
	writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
	writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
	return { mainRepo, worktree };
}

function insertMapping(store: MemoryStore, cwd: string, scopeId: string): void {
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(cwd, cwd, scopeId, 10, "user", "2026-09-17", "2026-09-17");
}

function insertPatternMapping(store: MemoryStore, pattern: string, scopeId: string): void {
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (NULL, ?, ?, ?, ?, ?, ?)`,
		)
		.run(pattern, scopeId, 10, "user", "2026-09-17", "2026-09-17");
}

function insertScope(store: MemoryStore, scopeId: string): void {
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`,
		)
		.run(scopeId, scopeId, "2026-09-22", "2026-09-22");
}

function expectSiblingWorktreeMapping(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"historical",
		"https://example.test/acme/historical.git",
	);
	insertMapping(store, mainRepo, "historical-scope");
	store.startSession({ cwd: mainRepo, project: "historical" });
	const worktreeSessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "session-new-worktree",
		cwd: worktree,
		project: "historical",
	});
	expect(resolveSessionScopeId(store.db, { sessionId: worktreeSessionId })).toBe(
		"historical-scope",
	);
	const inventory = listProjectScopeInventory(store.db, { limit: 10 });
	expect(inventory.projects).toHaveLength(1);
	expect(inventory.projects[0]).toMatchObject({
		resolved_scope_id: "historical-scope",
		session_count: 2,
		workspace_identity: "https://example.test/acme/historical.git",
	});
}

function expectEquivalentCwdsGroupAsRepository(store: MemoryStore, tmpDir: string): void {
	const cwd = join(tmpDir, "normalized-checkout");
	const repositoryIdentity = "https://example.test/acme/normalized.git";
	store.db
		.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)")
		.run(
			"2026-09-22T00:00:00.000Z",
			cwd,
			"normalized",
			JSON.stringify({ [REPOSITORY_IDENTITY_METADATA_KEY]: repositoryIdentity }),
		);
	store.db
		.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, '{}')")
		.run("2026-09-21T00:00:00.000Z", `${cwd}/`, "normalized");
	expect(listProjectScopeInventory(store.db, { limit: 10 }).projects).toMatchObject([
		{
			repository_identity: repositoryIdentity,
			session_count: 2,
			workspace_identity: repositoryIdentity,
		},
	]);
}

function expectPatternConflictsFailClosed(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"pattern-conflict",
		"https://example.test/acme/pattern-conflict.git",
	);
	insertPatternMapping(store, `${mainRepo}*`, "narrow-scope");
	insertPatternMapping(store, `${worktree}*`, "broad-scope");
	insertScope(store, "pattern-conflict");
	const mainSessionId = store.startSession({ cwd: mainRepo, project: "pattern-conflict" });
	const worktreeSessionId = store.startSession({ cwd: worktree, project: "pattern-conflict" });
	expect(resolveSessionScopeId(store.db, { sessionId: mainSessionId })).toBe("local-default");
	expect(resolveSessionScopeId(store.db, { sessionId: worktreeSessionId })).toBe("local-default");
	const project = listProjectScopeInventory(store.db, { limit: 10 }).projects.find(
		(item) => item.workspace_identity === "https://example.test/acme/pattern-conflict.git",
	);
	expect(project).toMatchObject({
		resolved_scope_id: "local-default",
		suggested_scope_id: null,
		suggestion_reason: null,
		suggestion_signal: null,
		statuses: expect.arrayContaining(["needs_attention"]),
		guardrail_warnings: expect.arrayContaining([
			expect.objectContaining({ code: "conflicting_repository_mappings" }),
		]),
	});
}

function expectExactConflictsFailClosed(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"conflicting",
		"https://example.test/acme/conflicting.git",
	);
	insertMapping(store, mainRepo, "narrow-scope");
	insertMapping(store, worktree, "broad-scope");
	const sessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "session-conflicting-worktree",
		cwd: worktree,
		project: "conflicting",
	});
	expect(resolveSessionScopeId(store.db, { sessionId })).toBe("local-default");
	const memoryId = store.remember(sessionId, "discovery", "conflict", "conflict");
	store.db.prepare("UPDATE memory_items SET scope_id = NULL WHERE id = ?").run(memoryId);
	expect(ensureMemoryScopeId(store.db, memoryId)).toBe("local-default");
	const repositoryProject = listProjectScopeInventory(store.db, { limit: 10 }).projects.find(
		(project) => project.workspace_identity === "https://example.test/acme/conflicting.git",
	);
	expect(repositoryProject).toMatchObject({
		resolved_scope_id: "local-default",
		statuses: expect.arrayContaining(["needs_attention"]),
		guardrail_warnings: expect.arrayContaining([
			expect.objectContaining({
				code: "conflicting_repository_mappings",
				requires_confirmation: true,
			}),
		]),
	});
	const candidate = listProjectScopeCandidates(store.db, { limit: null }).find(
		(item) => item.workspace_identity === "https://example.test/acme/conflicting.git",
	);
	expect(candidate).toMatchObject({
		resolved_scope_id: "local-default",
		guardrail_warnings: expect.arrayContaining([
			expect.objectContaining({ code: "conflicting_repository_mappings" }),
		]),
	});
}

function expectConflictPropagationFailsClosed(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"propagation-conflict",
		"https://example.test/acme/propagation-conflict.git",
	);
	insertScope(store, "propagation-a");
	insertScope(store, "propagation-b");
	const sessionId = store.startSession({ cwd: mainRepo, project: "propagation-conflict" });
	const worktreeSessionId = store.startSession({ cwd: worktree, project: "propagation-conflict" });
	const memoryId = store.remember(sessionId, "discovery", "propagation", "propagation");
	const worktreeMemoryId = store.remember(
		worktreeSessionId,
		"discovery",
		"worktree propagation",
		"worktree propagation",
	);
	upsertProjectScopeSettingsMapping(store.db, {
		deviceId: store.deviceId,
		workspace_identity: mainRepo,
		project_pattern: mainRepo,
		scope_id: "propagation-a",
	});
	expect(
		store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
	).toBe("propagation-a");
	upsertProjectScopeSettingsMapping(store.db, {
		deviceId: store.deviceId,
		workspace_identity: worktree,
		project_pattern: worktree,
		scope_id: "propagation-b",
	});
	expect(
		store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
	).toBe("local-default");
	expect(
		store.db
			.prepare("SELECT scope_id FROM memory_items WHERE id = ?")
			.pluck()
			.get(worktreeMemoryId),
	).toBe("local-default");
	upsertProjectScopeSettingsMapping(store.db, {
		deviceId: store.deviceId,
		workspace_identity: mainRepo,
		project_pattern: mainRepo,
		scope_id: "propagation-b",
	});
	for (const id of [memoryId, worktreeMemoryId]) {
		expect(store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(id)).toBe(
			"propagation-b",
		);
	}
}

function expectInsertedPatternClearsConflictForAllMemories(
	store: MemoryStore,
	tmpDir: string,
): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"insert-clears-conflict",
		"https://example.test/acme/insert-clears-conflict.git",
	);
	insertScope(store, "insert-clear-a");
	insertScope(store, "insert-clear-b");
	insertPatternMapping(store, mainRepo, "insert-clear-a");
	insertPatternMapping(store, worktree, "insert-clear-b");
	const sessionIds = [mainRepo, worktree].map((cwd) =>
		store.startSession({ cwd, project: "insert-clears-conflict" }),
	);
	const memoryIds = sessionIds.map((sessionId, index) =>
		store.remember(sessionId, "discovery", `insert clear ${index}`, `insert clear ${index}`),
	);
	for (const memoryId of memoryIds) {
		expect(
			store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
		).toBe("local-default");
	}

	upsertProjectScopeSettingsMapping(store.db, {
		deviceId: store.deviceId,
		project_pattern: mainRepo,
		scope_id: "insert-clear-b",
		priority: 20,
	});

	for (const memoryId of memoryIds) {
		expect(
			store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
		).toBe("insert-clear-b");
	}
}

function expectLegacyRemoteConflictsFailClosed(store: MemoryStore): void {
	const repositoryIdentity = "https://example.test/acme/legacy-remote-conflict.git";
	const main = "/workspace/legacy-remote-main";
	const worktree = "/workspace/legacy-remote-worktree";
	insertScope(store, "legacy-remote-a");
	insertScope(store, "legacy-remote-b");
	const sessionIds = [main, worktree].map((cwd, index) =>
		Number(
			store.db
				.prepare(
					`INSERT INTO sessions(started_at, cwd, project, git_remote, metadata_json)
					 VALUES (?, ?, 'legacy-remote-conflict', ?, '{}')`,
				)
				.run(
					`2026-09-23T0${index}:00:00.000Z`,
					cwd,
					index === 0 ? repositoryIdentity : `${repositoryIdentity}/`,
				).lastInsertRowid,
		),
	);
	const memoryIds = sessionIds.map((sessionId, index) =>
		store.remember(sessionId, "discovery", `legacy remote ${index}`, `legacy remote ${index}`),
	);

	upsertProjectScopeSettingsMapping(store.db, {
		deviceId: store.deviceId,
		workspace_identity: main,
		project_pattern: main,
		scope_id: "legacy-remote-a",
	});
	for (const memoryId of memoryIds) {
		expect(
			store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
		).toBe("legacy-remote-a");
	}
	const analysis = analyzeProjectScopeMappingChangeGuardrails(store.db, {
		workspace_identity: worktree,
		project_pattern: worktree,
		scope_id: "legacy-remote-b",
	});
	expect(analysis.warnings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "conflicting_repository_mappings",
				requires_confirmation: true,
			}),
		]),
	);

	upsertProjectScopeSettingsMapping(store.db, {
		deviceId: store.deviceId,
		workspace_identity: worktree,
		project_pattern: worktree,
		scope_id: "legacy-remote-b",
	});
	for (const sessionId of sessionIds) {
		expect(resolveSessionScopeId(store.db, { sessionId })).toBe("local-default");
	}
	for (const memoryId of memoryIds) {
		expect(
			store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
		).toBe("local-default");
	}
	const project = listProjectScopeInventory(store.db, { limit: 10 }).projects.find(
		(item) => item.workspace_identity === repositoryIdentity,
	);
	expect(project).toMatchObject({
		resolved_scope_id: "local-default",
		session_count: 2,
		statuses: expect.arrayContaining(["needs_attention"]),
		guardrail_warnings: expect.arrayContaining([
			expect.objectContaining({ code: "conflicting_repository_mappings" }),
		]),
	});
}

function expectRequestedConflictWarning(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"requested-conflict",
		"https://example.test/acme/requested-conflict.git",
	);
	insertScope(store, "requested-a");
	insertScope(store, "requested-b");
	store.startSession({ cwd: mainRepo, project: "requested-conflict" });
	store.startSession({ cwd: worktree, project: "requested-conflict" });
	insertMapping(store, mainRepo, "requested-a");

	const analysis = analyzeProjectScopeMappingChangeGuardrails(store.db, {
		workspace_identity: worktree,
		project_pattern: worktree,
		scope_id: "requested-b",
	});

	expect(analysis.warnings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "conflicting_repository_mappings",
				requires_confirmation: true,
			}),
		]),
	);
}

function expectRequestedPatternConflictWarning(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"requested-pattern-conflict",
		"https://example.test/acme/requested-pattern-conflict.git",
	);
	insertScope(store, "requested-pattern-a");
	insertScope(store, "requested-pattern-b");
	store.startSession({ cwd: mainRepo, project: "requested-pattern-conflict" });
	store.startSession({ cwd: worktree, project: "requested-pattern-conflict" });
	insertPatternMapping(store, mainRepo, "requested-pattern-a");

	const analysis = analyzeProjectScopeMappingChangeGuardrails(store.db, {
		project_pattern: worktree,
		scope_id: "requested-pattern-b",
	});

	expect(analysis.warnings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "conflicting_repository_mappings",
				requires_confirmation: true,
			}),
		]),
	);
}

function expectBulkRequestedConflictWarning(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"bulk-requested-conflict",
		"https://example.test/acme/bulk-requested-conflict.git",
	);
	insertScope(store, "bulk-requested-a");
	insertScope(store, "bulk-requested-b");
	store.startSession({ cwd: mainRepo, project: "bulk-requested-conflict" });
	store.startSession({ cwd: worktree, project: "bulk-requested-conflict" });

	const analyses = analyzeProjectScopeMappingChangesGuardrails(store.db, [
		{ project_pattern: mainRepo, scope_id: "bulk-requested-a" },
		{ project_pattern: worktree, scope_id: "bulk-requested-b" },
	]);

	expect(analyses.flatMap((analysis) => analysis.warnings)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "conflicting_repository_mappings",
				requires_confirmation: true,
			}),
		]),
	);
}

function expectSequentialBulkMoveConflictWarning(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"sequential-bulk-move-conflict",
		"https://example.test/acme/sequential-bulk-move-conflict.git",
	);
	insertScope(store, "sequential-bulk-move-a");
	insertScope(store, "sequential-bulk-move-b");
	store.startSession({ cwd: mainRepo, project: "sequential-bulk-move-conflict" });
	store.startSession({ cwd: worktree, project: "sequential-bulk-move-conflict" });
	insertMapping(store, mainRepo, "sequential-bulk-move-a");
	const mappingId = Number(
		store.db
			.prepare("SELECT id FROM project_scope_mappings WHERE workspace_identity = ?")
			.pluck()
			.get(mainRepo),
	);

	const analyses = analyzeProjectScopeMappingChangesGuardrails(store.db, [
		{
			id: mappingId,
			workspace_identity: worktree,
			project_pattern: worktree,
			scope_id: "sequential-bulk-move-a",
		},
		{
			workspace_identity: mainRepo,
			project_pattern: mainRepo,
			scope_id: "sequential-bulk-move-b",
		},
	]);

	expect(analyses[1]?.existing_mapping).toBeNull();
	expect(analyses.flatMap((analysis) => analysis.warnings)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "conflicting_repository_mappings",
				requires_confirmation: true,
			}),
		]),
	);
}

function expectBulkInsertionOrderConflictWarning(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"bulk-insertion-order-conflict",
		"https://example.test/acme/bulk-insertion-order-conflict.git",
	);
	insertScope(store, "bulk-insertion-order-a");
	insertScope(store, "bulk-insertion-order-b");
	store.startSession({ cwd: mainRepo, project: "bulk-insertion-order-conflict" });
	store.startSession({ cwd: worktree, project: "bulk-insertion-order-conflict" });
	insertMapping(store, mainRepo, "bulk-insertion-order-a");

	const analyses = analyzeProjectScopeMappingChangesGuardrails(store.db, [
		{ project_pattern: worktree, scope_id: "bulk-insertion-order-a" },
		{ project_pattern: worktree, scope_id: "bulk-insertion-order-b" },
	]);

	expect(analyses.flatMap((analysis) => analysis.warnings)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "conflicting_repository_mappings",
				requires_confirmation: true,
			}),
		]),
	);
}

function expectBulkRejectsNonPositiveIds(store: MemoryStore): void {
	insertScope(store, "bulk-invalid-id");
	expect(() =>
		analyzeProjectScopeMappingChangesGuardrails(store.db, [
			{ project_pattern: "/workspace/first", scope_id: "bulk-invalid-id" },
			{ id: -1, project_pattern: "/workspace/second", scope_id: "bulk-invalid-id" },
		]),
	).toThrow("id must be a positive integer");
}

function expectBulkSimulationGuardrails(store: MemoryStore, tmpDir: string): void {
	expectSequentialBulkMoveConflictWarning(store, tmpDir);
	expectBulkInsertionOrderConflictWarning(store, tmpDir);
	expectBulkRejectsNonPositiveIds(store);
}

function expectBulkSimulationPreservesNormalizedDuplicates(store: MemoryStore): void {
	insertScope(store, "normalized-duplicate-a");
	insertScope(store, "normalized-duplicate-b");
	insertMapping(store, "/workspace/normalized-duplicate", "normalized-duplicate-a");
	const olderId = Number(
		store.db
			.prepare("SELECT id FROM project_scope_mappings WHERE scope_id = 'normalized-duplicate-a'")
			.pluck()
			.get(),
	);
	insertMapping(store, "/workspace/normalized-duplicate/", "normalized-duplicate-b");
	const newerId = Number(
		store.db
			.prepare("SELECT id FROM project_scope_mappings WHERE scope_id = 'normalized-duplicate-b'")
			.pluck()
			.get(),
	);

	const analyses = analyzeProjectScopeMappingChangesGuardrails(store.db, [
		{
			id: olderId,
			workspace_identity: "/workspace/normalized-duplicate",
			project_pattern: "/workspace/normalized-duplicate",
			scope_id: "normalized-duplicate-a",
		},
		{
			id: newerId,
			workspace_identity: "/workspace/normalized-duplicate/",
			project_pattern: "/workspace/normalized-duplicate/",
			scope_id: "normalized-duplicate-b",
		},
	]);

	expect(analyses[1]?.existing_mapping).toMatchObject({
		id: newerId,
		scope_id: "normalized-duplicate-b",
	});
}

function expectMappedRepositorySeedsCandidateDiscovery(store: MemoryStore, tmpDir: string): void {
	const remote = "https://example.test/acme/mapping-seeded-candidate.git";
	const { mainRepo } = createLinkedWorktree(tmpDir, "mapping-seeded-candidate", remote);
	insertScope(store, "mapping-seeded-candidate");
	insertMapping(store, remote, "mapping-seeded-candidate");
	const sessionId = Number(
		store.db
			.prepare(
				"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, '{}')",
			)
			.run("2026-09-24T00:00:00.000Z", mainRepo, "mapping-seeded-candidate").lastInsertRowid,
	);

	expect(
		listProjectScopeCandidates(store.db).find(
			(candidate) => candidate.workspace_identity === remote,
		),
	).toMatchObject({ repository_identity: remote, resolved_scope_id: "mapping-seeded-candidate" });
	const inventory = listProjectScopeInventory(store.db, { limit: 10 });
	const matchingProjects = inventory.projects.filter((project) =>
		[remote, mainRepo].includes(project.workspace_identity),
	);
	expect(matchingProjects).toHaveLength(1);
	expect(matchingProjects[0]).toMatchObject({
		workspace_identity: remote,
		resolved_scope_id: "mapping-seeded-candidate",
	});

	const memoryId = store.remember(sessionId, "discovery", "mapped legacy", "mapped legacy");
	expect(
		store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
	).toBe("mapping-seeded-candidate");
	const mappingId = Number(
		store.db
			.prepare("SELECT id FROM project_scope_mappings WHERE scope_id = ?")
			.pluck()
			.get("mapping-seeded-candidate"),
	);
	expect(deleteProjectScopeSettingsMapping(store.db, mappingId, { deviceId: store.deviceId })).toBe(
		true,
	);
	expect(
		store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
	).toBe("local-default");
}

function expectMovedMappingAnalyzesPreviousRepository(store: MemoryStore, tmpDir: string): void {
	const remote = "https://example.test/acme/moved-mapping.git";
	const { mainRepo, worktree } = createLinkedWorktree(tmpDir, "moved-mapping", remote);
	for (const scopeId of ["moved-main", "moved-worktree"]) {
		insertScope(store, scopeId);
	}
	insertPatternMapping(store, mainRepo, "moved-main");
	insertPatternMapping(store, worktree, "moved-worktree");
	const overridingPattern = `${tmpDir}/moved-mapping*`;
	insertPatternMapping(store, overridingPattern, "moved-main");
	store.db
		.prepare("UPDATE project_scope_mappings SET priority = 100 WHERE project_pattern = ?")
		.run(overridingPattern);
	for (const cwd of [mainRepo, worktree]) {
		store.db
			.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)")
			.run(
				"2026-09-24T00:00:00.000Z",
				cwd,
				"moved-mapping",
				JSON.stringify({ [REPOSITORY_IDENTITY_METADATA_KEY]: remote }),
			);
	}
	const mappingId = Number(
		store.db
			.prepare("SELECT id FROM project_scope_mappings WHERE project_pattern = ?")
			.pluck()
			.get(overridingPattern),
	);
	const analysis = analyzeProjectScopeMappingChangeGuardrails(store.db, {
		id: mappingId,
		workspace_identity: null,
		project_pattern: "/workspace/moved-destination",
		scope_id: "moved-main",
	});

	expect(analysis.warnings).toEqual(
		expect.arrayContaining([expect.objectContaining({ code: "conflicting_repository_mappings" })]),
	);
}

function expectDeleteConflictPropagation(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"delete-conflict",
		"https://example.test/acme/delete-conflict.git",
	);
	insertScope(store, "delete-a");
	insertScope(store, "delete-b");
	const memoryIds = [mainRepo, worktree].map((cwd, index) =>
		store.remember(
			store.startSession({ cwd, project: "delete-conflict" }),
			"discovery",
			`delete ${index}`,
			`delete ${index}`,
		),
	);
	insertMapping(store, mainRepo, "delete-a");
	const conflicting = upsertProjectScopeSettingsMapping(store.db, {
		deviceId: store.deviceId,
		workspace_identity: worktree,
		project_pattern: worktree,
		scope_id: "delete-b",
	});
	expect(
		deleteProjectScopeSettingsMapping(store.db, conflicting.id, { deviceId: store.deviceId }),
	).toBe(true);
	for (const memoryId of memoryIds) {
		expect(
			store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
		).toBe("delete-a");
	}
}

function expectEquivalentRepositoryIdentityConflict(store: MemoryStore): void {
	const repositoryIdentity = "https://example.test/acme/equivalent-conflict.git";
	const main = "/workspace/equivalent-conflict-main";
	const worktree = "/workspace/equivalent-conflict-worktree";
	insertScope(store, "equivalent-conflict-a");
	insertScope(store, "equivalent-conflict-b");
	insertPatternMapping(store, main, "equivalent-conflict-a");
	insertPatternMapping(store, worktree, "equivalent-conflict-b");
	for (const [startedAt, cwd, recordedIdentity] of [
		["2026-09-22T00:00:00.000Z", main, repositoryIdentity],
		["2026-09-23T00:00:00.000Z", worktree, `${repositoryIdentity}/`],
	]) {
		store.db
			.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)")
			.run(
				startedAt,
				cwd,
				"equivalent-conflict",
				JSON.stringify({ [REPOSITORY_IDENTITY_METADATA_KEY]: recordedIdentity }),
			);
	}

	const candidate = listProjectScopeCandidates(store.db, { limit: null }).find(
		(project) => project.workspace_identity === repositoryIdentity,
	);
	expect(candidate).toMatchObject({
		resolved_scope_id: "local-default",
		guardrail_warnings: expect.arrayContaining([
			expect.objectContaining({ code: "conflicting_repository_mappings" }),
		]),
	});
}

function expectPartialPatternMappingFailsClosed(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"partially-mapped",
		"https://example.test/acme/partially-mapped.git",
	);
	insertPatternMapping(store, `${mainRepo}*`, "shared-scope");
	const mainSessionId = store.startSession({ cwd: mainRepo, project: "partially-mapped" });
	const worktreeSessionId = store.startSession({ cwd: worktree, project: "partially-mapped" });
	expect(resolveSessionScopeId(store.db, { sessionId: mainSessionId })).toBe("local-default");
	expect(resolveSessionScopeId(store.db, { sessionId: worktreeSessionId })).toBe("local-default");
}

function expectDiscoveredSiblingConflictFailsClosed(store: MemoryStore, tmpDir: string): void {
	const remote = "https://example.test/acme/discovered-sibling-conflict.git";
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"discovered-sibling-conflict",
		remote,
	);
	insertScope(store, "discovered-main");
	insertScope(store, "discovered-sibling");
	insertPatternMapping(store, mainRepo, "discovered-main");
	insertPatternMapping(store, worktree, "discovered-sibling");
	const mainSessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "session-discovered-main",
		cwd: mainRepo,
		project: "discovered-sibling-conflict",
		metadata: { [REPOSITORY_IDENTITY_METADATA_KEY]: remote },
	});
	store.db
		.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, '{}')")
		.run("2026-09-24T00:00:00.000Z", worktree, "discovered-sibling-conflict");

	expect(resolveSessionScopeId(store.db, { sessionId: mainSessionId })).toBe("local-default");
}

function expectMalformedMetadataDoesNotCreateAmbiguity(store: MemoryStore): void {
	const cwd = "/workspace/malformed-metadata";
	const remote = "https://example.test/acme/malformed-metadata.git";
	insertScope(store, "malformed-metadata");
	insertPatternMapping(store, cwd, "malformed-metadata");
	store.db
		.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)")
		.run(
			"2026-09-23T00:00:00.000Z",
			cwd,
			"malformed-metadata",
			JSON.stringify({ [REPOSITORY_IDENTITY_METADATA_KEY]: "fatal: not a git repository" }),
		);
	const validSessionId = Number(
		store.db
			.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)")
			.run(
				"2026-09-24T00:00:00.000Z",
				cwd,
				"malformed-metadata",
				JSON.stringify({ [REPOSITORY_IDENTITY_METADATA_KEY]: remote }),
			).lastInsertRowid,
	);

	expect(resolveSessionScopeId(store.db, { sessionId: validSessionId })).toBe("malformed-metadata");
}

function expectConflictingAliasIsDropped(store: MemoryStore, tmpDir: string): void {
	const { mainRepo, worktree } = createLinkedWorktree(
		tmpDir,
		"alias-pattern-conflict",
		"https://example.test/acme/alias-pattern-conflict.git",
	);
	insertMapping(store, mainRepo, "scope-a");
	insertPatternMapping(store, `${worktree}*`, "scope-b");
	const mainSessionId = store.startSession({ cwd: mainRepo, project: "alias-pattern-conflict" });
	const worktreeSessionId = store.startSession({
		cwd: worktree,
		project: "alias-pattern-conflict",
	});
	expect(resolveSessionScopeId(store.db, { sessionId: mainSessionId })).toBe("local-default");
	expect(resolveSessionScopeId(store.db, { sessionId: worktreeSessionId })).toBe("local-default");
}

function sessionIdForRepository(store: MemoryStore, cwd: string, repository: string): number {
	return store.db
		.prepare(
			`SELECT id FROM sessions WHERE cwd = ?
			 AND json_extract(metadata_json, '$.codemem_repository_identity') = ?`,
		)
		.pluck()
		.get(cwd, repository) as number;
}

it("detects conflicts hidden by aliases or repository patterns", () => {
	const repository = "https://example.test/acme/conflict.git";
	const main = "/workspace/conflict-main";
	const worktree = "/workspace/conflict-worktree";
	const identities = new Map([
		[main, repository],
		[worktree, repository],
	]);
	const exactAndPattern = [
		{ workspace_identity: main, project_pattern: main, scope_id: "scope-a", priority: 10 },
		{
			workspace_identity: null,
			project_pattern: `${worktree}*`,
			scope_id: "scope-b",
			priority: 10,
		},
	];
	const aliases = withRepositoryMappingAliasesFromIdentities(exactAndPattern, identities);
	expect(hasConflictingRepositoryMappings(aliases, identities, repository)).toBe(true);
	expect(
		hasConflictingRepositoryMappings(
			[
				{ workspace_identity: null, project_pattern: `${repository}*`, scope_id: "scope-a" },
				{
					workspace_identity: null,
					project_pattern: `${worktree}*`,
					scope_id: "scope-b",
					priority: 20,
				},
			],
			identities,
			repository,
		),
	).toBe(true);
});

it("ignores shadowed patterns when every repository member has the same winner", () => {
	const repository = "https://example.test/acme/precedence.git";
	const identities = new Map([
		["/workspace/precedence-main", repository],
		["/workspace/precedence-worktree", repository],
	]);
	expect(
		hasConflictingRepositoryMappings(
			[
				{
					workspace_identity: null,
					project_pattern: "https://example.test/acme/*",
					scope_id: "scope-a",
					priority: 20,
				},
				{
					workspace_identity: null,
					project_pattern: "/workspace/*",
					scope_id: "scope-b",
					priority: 10,
				},
			],
			identities,
			repository,
		),
	).toBe(false);
});

it("normalizes repository identity before checking conflicts", () => {
	const repository = "https://example.test/acme/normalized-conflict.git";
	const identities = new Map([
		["/workspace/normalized-main", repository],
		["/workspace/normalized-worktree", repository],
	]);
	expect(
		hasConflictingRepositoryMappings(
			[
				{ project_pattern: "/workspace/normalized-main", scope_id: "scope-a" },
				{ project_pattern: "/workspace/normalized-worktree", scope_id: "scope-b" },
			],
			identities,
			`${repository}/`,
		),
	).toBe(true);
});

it("treats an explicit Local winner as a repository conflict", () => {
	const repository = "https://example.test/acme/local-conflict.git";
	const main = "/workspace/local-main";
	const worktree = "/workspace/local-worktree";
	const identities = new Map([
		[main, repository],
		[worktree, repository],
	]);
	expect(
		hasConflictingRepositoryMappings(
			[
				{ workspace_identity: main, project_pattern: main, scope_id: "scope-a" },
				{ workspace_identity: null, project_pattern: worktree, scope_id: "local-default" },
			],
			identities,
			repository,
		),
	).toBe(true);
});

function expectReusedCheckoutHistoryRemainsAmbiguous(store: MemoryStore, tmpDir: string): void {
	const { mainRepo: cwd } = createLinkedWorktree(
		tmpDir,
		"reused-checkout",
		"https://example.test/acme/first.git",
	);
	const firstRepository = "https://example.test/acme/first.git";
	const secondRepository = "https://example.test/acme/second.git";
	insertScope(store, "first-scope");
	insertScope(store, "second-scope");
	insertMapping(store, cwd, "first-scope");
	insertMapping(store, secondRepository, "second-scope");
	for (const repositoryIdentity of [firstRepository, secondRepository]) {
		store.db
			.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)")
			.run(
				"2026-09-22T00:00:00.000Z",
				cwd,
				"reused",
				JSON.stringify({ [REPOSITORY_IDENTITY_METADATA_KEY]: repositoryIdentity }),
			);
	}
	const metadataLessSessionId = Number(
		store.db
			.prepare(
				"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, '{}')",
			)
			.run("2026-09-21T00:00:00.000Z", cwd, "reused").lastInsertRowid,
	);

	expect(repositoryIdentitiesByWorkspace(store.db).has(cwd)).toBe(false);
	writeFileSync(join(cwd, ".git", "config"), `[remote "origin"]\n\turl = ${secondRepository}\n`);
	const mappings = store.db.prepare("SELECT * FROM project_scope_mappings").all() as Array<{
		workspace_identity: string | null;
		project_pattern: string;
		scope_id: string;
	}>;
	expect(withRepositoryMappingAliases(store.db, mappings)).toHaveLength(2);
	const identifiedSessionId = sessionIdForRepository(store, cwd, secondRepository);
	expect(resolveSessionScopeId(store.db, { sessionId: identifiedSessionId })).toBe("second-scope");
	expect(resolveSessionScopeId(store.db, { sessionId: metadataLessSessionId })).toBe(
		"local-default",
	);
	const candidates = listProjectScopeCandidates(store.db, { limit: null });
	expect(candidates.map((candidate) => candidate.workspace_identity)).toEqual(
		expect.arrayContaining([cwd, firstRepository, secondRepository]),
	);
	expect(
		candidates.find((candidate) => candidate.workspace_identity === secondRepository),
	).toMatchObject({ resolved_scope_id: "second-scope" });
	expect(candidates.find((candidate) => candidate.workspace_identity === cwd)).toMatchObject({
		mapping_id: null,
		resolved_scope_id: "local-default",
	});
	const memoryId = store.remember(identifiedSessionId, "discovery", "ambiguous", "ambiguous");
	const remoteSessionId = Number(
		store.db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, metadata_json)
				 VALUES (?, ?, ?, ?, '{}')`,
			)
			.run("2026-09-21T01:00:00.000Z", cwd, "reused", secondRepository).lastInsertRowid,
	);
	const remoteMemoryId = store.remember(
		remoteSessionId,
		"discovery",
		"ambiguous remote",
		"ambiguous remote",
	);
	upsertProjectScopeSettingsMapping(store.db, {
		deviceId: store.deviceId,
		workspace_identity: cwd,
		project_pattern: cwd,
		scope_id: "first-scope",
	});
	expect(
		store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
	).toBe("second-scope");
	expect(
		store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(remoteMemoryId),
	).toBe("second-scope");
}

function expectMetadataAndRemoteHistoryRemainsAmbiguous(store: MemoryStore): void {
	const cwd = "/workspace/reused-mixed-evidence";
	const metadataRepository = "https://example.test/acme/metadata-repository.git";
	const remoteRepository = "https://example.test/acme/remote-repository.git";
	insertScope(store, "metadata-scope");
	insertScope(store, "remote-scope");
	insertMapping(store, cwd, "metadata-scope");
	insertMapping(store, remoteRepository, "remote-scope");
	store.db
		.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)")
		.run(
			"2026-09-22T00:00:00.000Z",
			cwd,
			"reused-mixed-evidence",
			JSON.stringify({ [REPOSITORY_IDENTITY_METADATA_KEY]: metadataRepository }),
		);
	const remoteSessionId = Number(
		store.db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, metadata_json)
				 VALUES (?, ?, ?, ?, '{}')`,
			)
			.run("2026-09-23T00:00:00.000Z", cwd, "reused-mixed-evidence", remoteRepository)
			.lastInsertRowid,
	);
	const malformedRemoteSessionId = Number(
		store.db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, metadata_json)
				 VALUES (?, ?, ?, 'fatal: not a git repository', '{}')`,
			)
			.run("2026-09-24T00:00:00.000Z", cwd, "reused-mixed-evidence").lastInsertRowid,
	);

	expect(repositoryIdentitiesByWorkspace(store.db).has(cwd)).toBe(false);
	expect(resolveSessionScopeId(store.db, { sessionId: remoteSessionId })).toBe("remote-scope");
	expect(resolveSessionScopeId(store.db, { sessionId: malformedRemoteSessionId })).toBe(
		"local-default",
	);
}

function expectRecordedSiblingEvidence(store: MemoryStore, tmpDir: string): void {
	const remote = "https://example.test/acme/legacy-worktree.git";
	const { mainRepo, worktree } = createLinkedWorktree(tmpDir, "legacy-worktree", remote);
	insertMapping(store, remote, "legacy-worktree-scope");
	store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "session-legacy-main",
		cwd: mainRepo,
		project: "legacy-worktree",
	});
	const sessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "session-legacy-worktree",
		cwd: worktree,
		project: "legacy-worktree",
	});
	store.db.prepare("UPDATE sessions SET metadata_json = '{}' WHERE id = ?").run(sessionId);
	expect(resolveSessionScopeId(store.db, { sessionId })).toBe("legacy-worktree-scope");
}

function expectLateCheckoutDiscovery(store: MemoryStore, tmpDir: string): void {
	const remote = "https://example.test/acme/mounted-later.git";
	const checkout = join(tmpDir, "mounted-later");
	mkdirSync(checkout, { recursive: true });
	insertMapping(store, remote, "mounted-later-scope");
	const sibling = join(tmpDir, "mounted-later-sibling");
	const siblingSessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "session-mounted-later-sibling",
		cwd: sibling,
		project: "mounted-later",
	});
	store.db
		.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?")
		.run(JSON.stringify({ codemem_repository_identity: remote }), siblingSessionId);
	const sessionId = store.startSession({ cwd: checkout, project: "mounted-later" });
	expect(resolveSessionScopeId(store.db, { sessionId })).toBe("local-default");
	mkdirSync(join(checkout, ".git"), { recursive: true });
	writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
	expect(resolveSessionScopeId(store.db, { sessionId })).toBe("mounted-later-scope");
}

function expectScopeStampingRefreshesRepositoryIdentity(store: MemoryStore, tmpDir: string): void {
	const repositoryA = "https://example.test/acme/repository-a.git";
	const repositoryB = "https://example.test/acme/repository-b.git";
	const checkout = join(tmpDir, "reused-checkout-live");
	mkdirSync(join(checkout, ".git"), { recursive: true });
	writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = ${repositoryA}\n`);
	insertMapping(store, repositoryA, "scope-a");
	insertMapping(store, repositoryB, "scope-b");
	for (const [cwd, repositoryIdentity] of [
		[join(tmpDir, "evidence-a"), repositoryA],
		[join(tmpDir, "evidence-b"), repositoryB],
	]) {
		store.db
			.prepare("INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)")
			.run(
				"2026-09-23T00:00:00Z",
				cwd,
				"repository",
				JSON.stringify({ codemem_repository_identity: repositoryIdentity }),
			);
	}
	const sessionId = store.startSession({ cwd: checkout, project: "repository" });
	store.db.prepare("UPDATE sessions SET metadata_json = '{}' WHERE id = ?").run(sessionId);
	expect(resolveSessionScopeId(store.db, { sessionId })).toBe("scope-a");
	writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = ${repositoryB}\n`);
	expect(resolveSessionScopeId(store.db, { sessionId })).toBe("scope-b");
}

function expectPatternConflictInventory(store: MemoryStore): void {
	const now = "2026-09-23T00:00:00Z";
	for (const [scopeId, label] of [
		["scope-a", "Scope A"],
		["scope-b", "Scope B"],
	]) {
		store.db
			.prepare(
				`INSERT INTO replication_scopes(
					scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
				 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`,
			)
			.run(scopeId, label, now, now);
	}
	for (const [pattern, scopeId] of [
		["/workspace/a/*", "scope-a"],
		["/workspace/b/*", "scope-b"],
	]) {
		store.db
			.prepare(
				`INSERT INTO project_scope_mappings(
					workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
				 ) VALUES (NULL, ?, ?, 10, 'user', ?, ?)`,
			)
			.run(pattern, scopeId, now, now);
	}
	const repositoryIdentity = "https://example.test/acme/pattern-conflict.git";
	for (const cwd of ["/workspace/a/api", "/workspace/b/api"]) {
		store.db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, metadata_json)
				 VALUES (?, ?, 'api', ?)`,
			)
			.run(now, cwd, JSON.stringify({ codemem_repository_identity: repositoryIdentity }));
	}

	const inventory = listProjectScopeInventory(store.db, { limit: 10 });
	expect(inventory.projects).toHaveLength(1);
	expect(inventory.projects[0]).toMatchObject({
		mapping_id: null,
		matched_pattern: null,
		resolved_scope_id: "local-default",
		statuses: expect.arrayContaining(["local_only", "needs_attention"]),
		workspace_identity: repositoryIdentity,
		worktrees: expect.arrayContaining([
			expect.objectContaining({ cwd: "/workspace/a/api" }),
			expect.objectContaining({ cwd: "/workspace/b/api" }),
		]),
	});
	expect(inventory.projects[0]?.guardrail_warnings).toEqual(
		expect.arrayContaining([expect.objectContaining({ code: "conflicting_repository_mappings" })]),
	);
}

describe("repository mapping aliases", () => {
	let originalConfig: string | undefined;
	let store: MemoryStore;
	let tmpDir: string;

	beforeEach(() => {
		originalConfig = process.env.CODEMEM_CONFIG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-repository-alias-test-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		if (originalConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = originalConfig;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("inherits a live main-checkout mapping when discovery starts in a sibling worktree", () => {
		expectSiblingWorktreeMapping(store, tmpDir);
	});

	it("uses recorded sibling evidence for a metadata-less legacy worktree", () =>
		expectRecordedSiblingEvidence(store, tmpDir));

	it("retries filesystem discovery after a checkout appears", () =>
		expectLateCheckoutDiscovery(store, tmpDir));

	it("refreshes identity before scope stamping", () =>
		expectScopeStampingRefreshesRepositoryIdentity(store, tmpDir));

	it("fails closed when worktrees have conflicting legacy Space mappings", () => {
		expectExactConflictsFailClosed(store, tmpDir);
	});

	it("moves historical memories local when a mapping creates a repository conflict", () => {
		expectConflictPropagationFailsClosed(store, tmpDir);
	});

	it("reconsiders every repository sibling when an inserted pattern clears a conflict", () => {
		expectInsertedPatternClearsConflictForAllMemories(store, tmpDir);
	});

	it("fails closed for conflicting worktrees recorded only by git remote", () => {
		expectLegacyRemoteConflictsFailClosed(store);
	});

	it("warns before a requested mapping creates a repository conflict", () => {
		expectRequestedConflictWarning(store, tmpDir);
	});

	it("warns before a requested pattern creates a repository conflict", () => {
		expectRequestedPatternConflictWarning(store, tmpDir);
	});

	it("evaluates bulk mapping drafts as one requested state", () => {
		expectBulkRequestedConflictWarning(store, tmpDir);
	});

	it("resolves each bulk draft against preceding identity moves", () => {
		expectBulkSimulationGuardrails(store, tmpDir);
		expectBulkSimulationPreservesNormalizedDuplicates(store);
		expectDeleteConflictPropagation(store, tmpDir);
		expectMappedRepositorySeedsCandidateDiscovery(store, tmpDir);
		expectMovedMappingAnalyzesPreviousRepository(store, tmpDir);
	});

	it("normalizes equivalent repository evidence before candidate conflict checks", () => {
		expectEquivalentRepositoryIdentityConflict(store);
	});

	it("fails closed when worktrees match conflicting Space patterns", () => {
		expectPatternConflictsFailClosed(store, tmpDir);
		expectDiscoveredSiblingConflictFailsClosed(store, tmpDir);
		expectMalformedMetadataDoesNotCreateAmbiguity(store);
	});

	it("fails closed when one mapped worktree has an unmatched sibling", () => {
		expectPartialPatternMappingFailsClosed(store, tmpDir);
	});

	it("drops repository aliases when sibling patterns conflict", () => {
		expectConflictingAliasIsDropped(store, tmpDir);
	});

	it("groups equivalent cwd spellings using recorded repository evidence", () => {
		expectEquivalentCwdsGroupAsRepository(store, tmpDir);
	});

	it("does not infer metadata-less sessions when a cwd has conflicting repository history", () => {
		expectReusedCheckoutHistoryRemainsAmbiguous(store, tmpDir);
	});

	it("preserves remote-only history beside metadata evidence for a reused cwd", () => {
		expectMetadataAndRemoteHistoryRemainsAmbiguous(store);
	});

	it("surfaces worktrees that resolve to different pattern scopes", () => {
		expectPatternConflictInventory(store);
	});
});
