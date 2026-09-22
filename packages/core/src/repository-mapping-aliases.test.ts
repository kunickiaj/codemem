import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { listProjectScopeInventory } from "./project-scope-settings.js";
import { resolveSessionScopeId } from "./scope-stamping.js";
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
	const checkout = join(tmpDir, "reused-checkout");
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

function expectMergedPatternScopeConflict(store: MemoryStore): void {
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
	});

	it("uses recorded sibling evidence for a metadata-less legacy worktree", () => {
		expectRecordedSiblingEvidence(store, tmpDir);
	});

	it("retries filesystem discovery after a checkout appears", () => {
		expectLateCheckoutDiscovery(store, tmpDir);
	});

	it("refreshes repository identity before stamping a reused checkout", () => {
		expectScopeStampingRefreshesRepositoryIdentity(store, tmpDir);
	});

	it("fails closed when worktrees have conflicting legacy Space mappings", () => {
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
	});

	it("surfaces worktrees that resolve to different pattern scopes", () => {
		expectMergedPatternScopeConflict(store);
	});
});
