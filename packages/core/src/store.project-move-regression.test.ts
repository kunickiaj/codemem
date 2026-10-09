import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryStore } from "./store.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", () => ({ storeVectors: vi.fn(async () => {}) }));

let directory: string;
let store: MemoryStore;
afterEach(() => {
	store?.close();
	if (directory) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

it("uses the moved session project for retrieval without changing memory data", () => {
	// Arrange: remember copies the original session project onto the memory row.
	directory = mkdtempSync(join(tmpdir(), "codemem-project-move-"));
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_ACTOR_ID", undefined);
	vi.stubEnv("CODEMEM_ACTOR_DISPLAY_NAME", undefined);
	store = new MemoryStore(join(directory, "test.sqlite"), { keysDir: join(directory, "keys") });
	const sessionId = store.startSession({ project: "old-project" });
	const memId = store.remember(sessionId, "discovery", "relocationneedle", "Original body");
	const memoryBefore = store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(memId);
	const sessionBefore = store.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);

	// Act: the user-facing move changes the session label, not the remembered content.
	const moved = store.moveMemoryProjectForUser(memId, "new-project");
	const retrieval = ["new-project", "old-project"].map((project) => ({
		project,
		recent: store.recent(10, { project }).map((item) => item.id),
		feed: store.recentByKinds(["discovery"], 10, { project }).map((item) => item.id),
		search: store.search("relocationneedle", 10, { project }).map((item) => item.id),
	}));

	// Assert: the new project finds the memory; the old project no longer finds it.
	expect(moved).toEqual({
		session_id: sessionId,
		project: "new-project",
		moved_memory_count: 1,
	});
	expect(store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(memId)).toEqual(
		memoryBefore,
	);
	expect(store.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId)).toEqual({
		...sessionBefore,
		project: "new-project",
	});
	expect(retrieval).toEqual([
		{ project: "new-project", recent: [memId], feed: [memId], search: [memId] },
		{ project: "old-project", recent: [], feed: [], search: [] },
	]);
});
