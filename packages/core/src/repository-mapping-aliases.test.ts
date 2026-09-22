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
});
