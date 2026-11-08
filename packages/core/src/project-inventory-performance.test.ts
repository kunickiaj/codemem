import { resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectScopeInventory } from "./project-scope-settings.js";
import {
	hasRecordedRepositoryWorkspace,
	readRepositoryIdentitySnapshot,
	repositoryIdentitiesByWorkspace,
} from "./repository-mapping-aliases.js";
import { initTestSchema } from "./test-utils.js";

describe("project inventory request-scoped repository evidence", () => {
	const statements = vi.fn<(sql: string) => void>();
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:", { verbose: statements });
		initTestSchema(db);
		statements.mockClear();
	});
	afterEach(() => db.close());

	function insertSession(cwd: string, project: string, remote: string | null): void {
		db.prepare(
			"INSERT INTO sessions(started_at, cwd, project, git_remote) VALUES (?, ?, ?, ?)",
		).run("2026-11-01T00:00:00Z", cwd, project, remote);
	}

	function expectSingleEvidenceRead(): void {
		const executed = statements.mock.calls.map(([sql]) => sql.replace(/\s+/g, " ").trim());
		expect(
			executed.filter((sql) =>
				/^SELECT DISTINCT cwd, git_remote, metadata_json FROM sessions\b/i.test(sql),
			),
		).toHaveLength(1);
		expect(
			executed.filter((sql) => /^SELECT DISTINCT cwd FROM sessions\b/i.test(sql)),
		).toHaveLength(1);
	}

	it("reads evidence once while preserving canonical grouping and page totals", () => {
		// Arrange: a historical session and recorded repository evidence share a workspace.
		const repository = "https://example.test/acme/api.git";
		insertSession("inventory/api", "api", null);
		insertSession("inventory/api", "api", repository);
		insertSession("inventory/worker", "worker", "https://example.test/acme/worker.git");
		statements.mockClear();

		// Act: pagination still resolves the complete inventory before slicing.
		const result = listProjectScopeInventory(db, { limit: 1 });

		// Assert: the optimization must preserve both grouping and pagination.
		expectSingleEvidenceRead();
		expect(result).toMatchObject({ total: 2, limit: 1, offset: 0, has_more: true });
		expect(result.projects).toMatchObject([
			{ workspace_identity: repository, session_count: 2, display_project: "api" },
		]);
	});

	it("reads fresh evidence on the next request and applies query and status filters", () => {
		// Arrange: the first request sees a workspace without a recorded repository.
		insertSession("inventory/api", "api", null);
		const initial = listProjectScopeInventory(db);
		const repository = "https://example.test/acme/api.git";
		db.prepare("UPDATE sessions SET metadata_json = ?").run(
			JSON.stringify({ codemem_repository_identity: repository }),
		);
		insertSession("inventory/worker", "worker", "https://example.test/acme/worker.git");
		statements.mockClear();

		// Act: a new inventory request must not retain the previous SQL snapshot.
		const refreshed = listProjectScopeInventory(db, { query: "api", status: "local_only" });

		// Assert: changed evidence is visible and filtering does not inflate totals.
		expectSingleEvidenceRead();
		expect(initial.projects[0]?.workspace_identity).not.toBe(repository);
		expect(refreshed).toMatchObject({ total: 1, has_more: false });
		expect(refreshed.projects).toMatchObject([{ workspace_identity: repository }]);
	});

	it("does not merge an ambiguous workspace into either recorded repository", () => {
		// Arrange: conflicting historical repository evidence must stay ambiguous.
		const cwd = "inventory/reused";
		const first = "https://example.test/acme/first.git";
		const second = "https://example.test/acme/second.git";
		insertSession(cwd, "legacy", null);
		insertSession(cwd, "first", first);
		insertSession(cwd, "second", second);
		statements.mockClear();

		// Act.
		const result = listProjectScopeInventory(db);

		// Assert: sharing evidence across stages must not share mutable working maps.
		expectSingleEvidenceRead();
		expect(result.projects.map((project) => project.workspace_identity).sort()).toEqual(
			[resolve(cwd), first, second].sort(),
		);
		expect(result.projects.every((project) => project.session_count === 1)).toBe(true);
	});

	it("keeps empty and unmatched requests empty without repeating evidence reads", () => {
		// Arrange.
		insertSession("inventory/api", "api", "https://example.test/acme/api.git");
		statements.mockClear();

		// Act.
		const result = listProjectScopeInventory(db, { query: "missing", offset: 250 });

		// Assert.
		expectSingleEvidenceRead();
		expect(result).toMatchObject({ projects: [], total: 0, offset: 250, has_more: false });
	});
});

describe("repository snapshot working maps", () => {
	let db: InstanceType<typeof Database>;
	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});
	afterEach(() => db.close());

	it("returns fresh maps when an earlier consumer mutates its working map", () => {
		// Arrange.
		const repository = "https://example.test/acme/api.git";
		db.prepare("INSERT INTO sessions(started_at, cwd, git_remote) VALUES (?, ?, ?)").run(
			"2026-11-01",
			"snapshot/api",
			repository,
		);
		const repositoryIdentitySnapshot = readRepositoryIdentitySnapshot(db);
		const first = repositoryIdentitiesByWorkspace(db, { repositoryIdentitySnapshot });
		first.set("snapshot/api", "https://example.test/acme/changed.git");
		first.set("snapshot/inferred", repository);

		// Act.
		const second = repositoryIdentitiesByWorkspace(db, { repositoryIdentitySnapshot });

		// Assert: row identification must not contaminate another consumer of this snapshot.
		expect(second).not.toBe(first);
		expect([...second]).toEqual([["snapshot/api", repository]]);
		expect(hasRecordedRepositoryWorkspace(second, "snapshot/api")).toBe(true);
		expect(hasRecordedRepositoryWorkspace(second, "snapshot/inferred")).toBe(false);
	});

	it("preserves recorded ambiguity metadata even when no identity enters a working map", () => {
		// Arrange.
		const cwd = "snapshot/reused";
		const insert = db.prepare("INSERT INTO sessions(started_at, cwd, git_remote) VALUES (?, ?, ?)");
		insert.run("2026-11-01", cwd, "https://example.test/acme/first.git");
		insert.run("2026-11-01", cwd, "https://example.test/acme/second.git");
		const repositoryIdentitySnapshot = readRepositoryIdentitySnapshot(db);

		// Act.
		const maps = [
			repositoryIdentitiesByWorkspace(db, { repositoryIdentitySnapshot }),
			repositoryIdentitiesByWorkspace(db, { repositoryIdentitySnapshot }),
		];

		// Assert: losing the WeakMap metadata would permit unsafe fallback discovery.
		for (const map of maps) {
			expect(map.has(cwd)).toBe(false);
			expect(hasRecordedRepositoryWorkspace(map, `${cwd}/`)).toBe(true);
		}
	});
});
