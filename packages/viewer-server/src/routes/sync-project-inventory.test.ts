import { MemoryStore } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectInventoryRowsForWorkspace, syncRoutes } from "./sync.js";

describe("project inventory memory lookup", () => {
	const stores: MemoryStore[] = [];

	afterEach(() => {
		for (const store of stores) store.close();
		stores.length = 0;
	});

	it("includes pre-upgrade memories inferred from repository evidence", () => {
		const store = new MemoryStore(":memory:");
		stores.push(store);
		const cwd = "/workspace/acme/api";
		const repositoryIdentity = "https://git.example.invalid/acme/api.git";
		const legacySessionId = store.getOrCreateSessionForOpencodeSession({
			cwd,
			opencodeSessionId: "legacy-session",
			project: "api",
		});
		const memoryId = store.remember(
			legacySessionId,
			"discovery",
			"legacy repository memory",
			"body",
		);
		const evidenceSessionId = store.getOrCreateSessionForOpencodeSession({
			cwd,
			opencodeSessionId: "evidence-session",
			project: "api",
		});
		store.db
			.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?")
			.run(JSON.stringify({ codemem_repository_identity: repositoryIdentity }), evidenceSessionId);

		expect(
			projectInventoryRowsForWorkspace(store, repositoryIdentity).map((row) => row.id),
		).toEqual([memoryId]);
	});
});

describe("project inventory route repository reads", () => {
	const stores: MemoryStore[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const store of stores) store.close();
		stores.length = 0;
	});

	function createInventoryRequest() {
		const store = new MemoryStore(":memory:");
		stores.push(store);
		store.db
			.prepare("INSERT INTO sessions(started_at, cwd, project, git_remote) VALUES (?, ?, ?, ?)")
			.run("2026-11-01", "route/api", "api", "https://example.test/acme/api.git");
		const evidenceReads = vi.fn();
		const cwdReads = vi.fn();
		const prepare = store.db.prepare.bind(store.db);
		vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
			const statement = prepare(sql);
			const normalized = sql.replace(/\s+/g, " ").trim();
			let recordRead: (() => void) | undefined;
			if (/^SELECT DISTINCT cwd, git_remote, metadata_json FROM sessions\b/i.test(normalized))
				recordRead = evidenceReads;
			if (/^SELECT DISTINCT cwd FROM sessions\b/i.test(normalized)) recordRead = cwdReads;
			if (recordRead) {
				const all = statement.all.bind(statement);
				vi.spyOn(statement, "all").mockImplementation((...args) => {
					recordRead();
					return all(...args);
				});
			}
			return statement;
		});
		return { store, app: syncRoutes(() => store), evidenceReads, cwdReads };
	}

	it("shares one evidence read with sharing decoration and refreshes the next request", async () => {
		// Arrange.
		const { store, app, evidenceReads, cwdReads } = createInventoryRequest();

		// Act.
		const first = await app.request("/api/sync/projects?limit=1");
		const initial = await first.json();
		const initialReads = [evidenceReads.mock.calls.length, cwdReads.mock.calls.length];
		store.db
			.prepare("UPDATE sessions SET git_remote = ?, project = ?")
			.run("https://example.test/acme/updated.git", "updated");
		const next = await app.request("/api/sync/projects?q=updated&status=local_only&limit=1");
		const refreshed = await next.json();

		// Assert: each HTTP request reads SQL evidence once, including decoration.
		expect(first.status).toBe(200);
		expect(next.status).toBe(200);
		expect(initialReads).toEqual([1, 1]);
		expect(evidenceReads).toHaveBeenCalledTimes(2);
		expect(cwdReads).toHaveBeenCalledTimes(2);
		expect(initial).toMatchObject({
			total: 1,
			has_more: false,
			projects: [{ workspace_identity: "https://example.test/acme/api.git" }],
		});
		expect(refreshed).toMatchObject({
			total: 1,
			has_more: false,
			projects: [{ workspace_identity: "https://example.test/acme/updated.git" }],
		});
	});

	it("keeps unmatched filters empty while reading evidence only once", async () => {
		// Arrange.
		const { app, evidenceReads, cwdReads } = createInventoryRequest();

		// Act.
		const response = await app.request("/api/sync/projects?q=missing&status=received&offset=250");
		const result = await response.json();

		// Assert.
		expect(response.status).toBe(200);
		expect(result).toMatchObject({ total: 0, projects: [], has_more: false, offset: 250 });
		expect(evidenceReads).toHaveBeenCalledTimes(1);
		expect(cwdReads).toHaveBeenCalledTimes(1);
	});
});
