import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { REPOSITORY_IDENTITY_METADATA_KEY } from "./project.js";
import { listProjectScopeInventory } from "./project-scope-settings.js";
import { resolveSessionScopeId } from "./scope-stamping.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

function assertReusedCwdIdentity(store: MemoryStore, tmpDir: string): void {
	const repoRoot = join(tmpDir, "upgraded-repository");
	const missingRoot = join(tmpDir, "missing-repository");
	mkdirSync(repoRoot, { recursive: true });
	const historicalSessionId = store.startSession({ cwd: repoRoot, project: "repository" });
	const missingSessionId = store.startSession({ cwd: missingRoot, project: "missing" });
	mkdirSync(join(repoRoot, ".git"), { recursive: true });
	writeFileSync(
		join(repoRoot, ".git", "config"),
		'[remote "origin"]\n\turl = https://example.test/acme/repository.git\n',
	);
	const currentSessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "session-after-upgrade",
		cwd: repoRoot,
		project: "repository",
	});
	const sessionValue = (column: string, sessionId: number): unknown =>
		store.db.prepare(`SELECT ${column} FROM sessions WHERE id = ?`).pluck().get(sessionId);

	expect(sessionValue("git_remote", historicalSessionId)).toBeNull();
	expect(sessionValue("metadata_json", historicalSessionId)).toBe("{}");
	expect(JSON.parse(String(sessionValue("metadata_json", currentSessionId)))).toMatchObject({
		[REPOSITORY_IDENTITY_METADATA_KEY]: "https://example.test/acme/repository.git",
	});
	expect(sessionValue("git_remote", missingSessionId)).toBeNull();
	const inventory = listProjectScopeInventory(store.db, { limit: 10 });
	expect(inventory.projects).toHaveLength(2);
	expect(
		inventory.projects.find(
			(project) => project.workspace_identity === "https://example.test/acme/repository.git",
		),
	).toMatchObject({ session_count: 2 });
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, 'repository', 'repository-scope', 10, 'user', '2026-09-22', '2026-09-22')`,
		)
		.run("https://example.test/acme/repository.git");
	expect(resolveSessionScopeId(store.db, { sessionId: historicalSessionId })).toBe(
		"repository-scope",
	);
}

describe("raw-event session repository identity", () => {
	let originalConfig: string | undefined;
	let store: MemoryStore;
	let tmpDir: string;

	beforeEach(() => {
		originalConfig = process.env.CODEMEM_CONFIG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-store-project-identity-test-"));
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

	it("uses one canonical repository Project for its main checkout and linked worktrees", () => {
		const mainRepo = join(tmpDir, "main", "repository");
		const worktree = join(tmpDir, "external", "worktree");
		const worktreeGitDir = join(mainRepo, ".git", "worktrees", "external");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
		const sessionId = Number(
			store.db
				.prepare(
					"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, 'repository', '{}')",
				)
				.run("2026-09-21T00:00:00.000Z", worktree).lastInsertRowid,
		);
		writeFileSync(
			join(mainRepo, ".git", "config"),
			'[remote "origin"]\n\turl = https://example.test/acme/repository.git\n',
		);
		const mainSessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "session-main",
			cwd: mainRepo,
			project: "repository",
			metadata: { [REPOSITORY_IDENTITY_METADATA_KEY]: "untrusted-override" },
		});

		expect(
			store.db
				.prepare("SELECT cwd, git_remote, metadata_json FROM sessions WHERE id = ?")
				.get(mainSessionId),
		).toEqual({
			cwd: mainRepo,
			git_remote: null,
			metadata_json: JSON.stringify({
				[REPOSITORY_IDENTITY_METADATA_KEY]: "https://example.test/acme/repository.git",
			}),
		});
		const inventory = listProjectScopeInventory(store.db, { limit: 10 });
		expect(inventory.projects).toHaveLength(1);
		expect(inventory.projects[0]).toMatchObject({
			repository_identity: "https://example.test/acme/repository.git",
			session_count: 2,
			workspace_identity: "https://example.test/acme/repository.git",
			worktrees: expect.arrayContaining([
				expect.objectContaining({ cwd: mainRepo }),
				expect.objectContaining({ cwd: worktree }),
			]),
		});
		store.db
			.prepare(
				`INSERT INTO project_scope_mappings(
					workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(mainRepo, "repository", "legacy-cwd-scope", 10, "user", "2026-09-21", "2026-09-21");
		expect(resolveSessionScopeId(store.db, { sessionId: mainSessionId })).toBe("legacy-cwd-scope");
		expect(resolveSessionScopeId(store.db, { sessionId })).toBe("legacy-cwd-scope");
		const mappedInventory = listProjectScopeInventory(store.db, { limit: 10 });
		expect(mappedInventory.projects).toHaveLength(1);
		expect(mappedInventory.projects[0]).toMatchObject({
			resolved_scope_id: "legacy-cwd-scope",
			workspace_identity: "https://example.test/acme/repository.git",
		});
	});

	it("preserves an existing cwd scope mapping after repository identity is discovered", () => {
		const repoRoot = join(tmpDir, "mapped-repository");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		writeFileSync(
			join(repoRoot, ".git", "config"),
			'[remote "origin"]\n\turl = https://example.test/acme/repository.git\n',
		);
		store.db
			.prepare(
				`INSERT INTO project_scope_mappings(
					workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(repoRoot, repoRoot, "existing-scope", 10, "user", "2026-09-17", "2026-09-17");

		const sessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "session-mapped-repository",
			cwd: repoRoot,
			project: "mapped-repository",
		});

		expect(resolveSessionScopeId(store.db, { sessionId })).toBe("existing-scope");
	});

	it("keeps historical sessions stable when a cwd is reused", () => {
		assertReusedCwdIdentity(store, tmpDir);
	});
});
