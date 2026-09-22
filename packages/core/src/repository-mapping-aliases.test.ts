import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { REPOSITORY_IDENTITY_METADATA_KEY } from "./project.js";
import {
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
	const mainSessionId = store.startSession({ cwd: mainRepo, project: "pattern-conflict" });
	const worktreeSessionId = store.startSession({ cwd: worktree, project: "pattern-conflict" });
	expect(resolveSessionScopeId(store.db, { sessionId: mainSessionId })).toBe("local-default");
	expect(resolveSessionScopeId(store.db, { sessionId: worktreeSessionId })).toBe("local-default");
	const project = listProjectScopeInventory(store.db, { limit: 10 }).projects.find(
		(item) => item.workspace_identity === "https://example.test/acme/pattern-conflict.git",
	);
	expect(project).toMatchObject({
		resolved_scope_id: "local-default",
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
	store.startSession({ cwd: worktree, project: "propagation-conflict" });
	const memoryId = store.remember(sessionId, "discovery", "propagation", "propagation");
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

	it("fails closed when worktrees have conflicting legacy Space mappings", () => {
		expectExactConflictsFailClosed(store, tmpDir);
	});

	it("moves historical memories local when a mapping creates a repository conflict", () => {
		expectConflictPropagationFailsClosed(store, tmpDir);
	});

	it("fails closed when worktrees match conflicting Space patterns", () => {
		expectPatternConflictsFailClosed(store, tmpDir);
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
		const { mainRepo: cwd } = createLinkedWorktree(
			tmpDir,
			"reused-checkout",
			"https://example.test/acme/first.git",
		);
		const firstRepository = "https://example.test/acme/first.git";
		const secondRepository = "https://example.test/acme/second.git";
		insertMapping(store, cwd, "first-scope");
		for (const repositoryIdentity of [firstRepository, secondRepository]) {
			store.db
				.prepare(
					"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)",
				)
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
		expect(withRepositoryMappingAliases(store.db, mappings)).toHaveLength(1);
		expect(resolveSessionScopeId(store.db, { sessionId: metadataLessSessionId })).toBe(
			"local-default",
		);
		expect(
			listProjectScopeCandidates(store.db, { limit: null }).map(
				(candidate) => candidate.workspace_identity,
			),
		).toEqual(expect.arrayContaining([cwd, firstRepository, secondRepository]));
	});
});
