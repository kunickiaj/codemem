import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { listProjectScopeInventory } from "./project-scope-settings.js";
import { resolveSessionScopeId } from "./scope-stamping.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

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

	it("keeps repository grouping separate from canonical session identity", () => {
		const mainRepo = join(tmpDir, "main", "repository");
		const worktree = join(tmpDir, "external", "worktree");
		const worktreeGitDir = join(mainRepo, ".git", "worktrees", "external");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(mainRepo, ".git", "config"),
			'[remote "origin"]\n\turl = https://example.test/acme/repository.git\n',
		);
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

		const sessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "session-worktree",
			cwd: worktree,
			project: "repository",
		});

		expect(
			store.db.prepare("SELECT cwd, git_remote FROM sessions WHERE id = ?").get(sessionId),
		).toEqual({ cwd: worktree, git_remote: null });
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
		const repoRoot = join(tmpDir, "upgraded-repository");
		const missingRoot = join(tmpDir, "missing-repository");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		writeFileSync(
			join(repoRoot, ".git", "config"),
			'[remote "origin"]\n\turl = https://example.test/acme/repository.git\n',
		);
		const historicalSessionId = store.startSession({ cwd: repoRoot, project: "repository" });
		const missingSessionId = store.startSession({ cwd: missingRoot, project: "missing" });

		store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "session-after-upgrade",
			cwd: repoRoot,
			project: "repository",
		});

		expect(
			store.db
				.prepare("SELECT git_remote FROM sessions WHERE id = ?")
				.pluck()
				.get(historicalSessionId),
		).toBeNull();
		expect(
			store.db
				.prepare("SELECT git_remote FROM sessions WHERE id = ?")
				.pluck()
				.get(missingSessionId),
		).toBeNull();
		const inventory = listProjectScopeInventory(store.db, { limit: 10 });
		expect(inventory.projects).toHaveLength(2);
		expect(
			inventory.projects.find((project) => project.workspace_identity === repoRoot),
		).toMatchObject({ session_count: 2 });
	});
});
