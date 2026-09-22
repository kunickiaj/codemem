import { MemoryStore } from "@codemem/core";
import { afterEach, describe, expect, it } from "vitest";
import { projectInventoryRowsForWorkspace } from "./sync.js";

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
