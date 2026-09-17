import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
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

	it("persists repository identity for sessions created from linked worktrees", () => {
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
		).toEqual({ cwd: worktree, git_remote: "https://example.test/acme/repository.git" });
	});
});
