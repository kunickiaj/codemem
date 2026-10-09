import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type CreatedMemory, MemoryStore } from "./store.js";
import { storeVectors } from "./vectors.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", () => ({ storeVectors: vi.fn(async () => {}) }));

let directory: string;
let store: MemoryStore;
let sessionId: number;
beforeEach(() => {
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	vi.mocked(storeVectors).mockClear();
	directory = mkdtempSync(join(tmpdir(), "codemem-created-effects-"));
	store = new MemoryStore(join(directory, "test.sqlite"));
	sessionId = store.startSession({ cwd: "/fixture/project", project: "fixture-project" });
});
afterEach(async () => {
	await store.flushPendingVectorWrites();
	store.close();
	rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("collects only identities and embeds committed redacted text once after the outer commit", async () => {
	// Arrange: synthetic secret never reaches disk or the vector dependency.
	const secret = `sk-ant-api03-${"A".repeat(85)}aB1`;
	const createdMemories: CreatedMemory[] = [];
	let memoryId = 0;
	// Act
	store.db
		.transaction(() => {
			memoryId = store.rememberForUser(
				sessionId,
				"discovery",
				`Title ${secret}`,
				`Body ${secret}`,
				0.5,
				undefined,
				undefined,
				{ createdMemories },
			);
			expect(storeVectors).not.toHaveBeenCalled();
			expect(createdMemories).toEqual([{ memoryId, importKey: expect.any(String) }]);
		})
		.immediate();
	const row = store.get(memoryId);
	store.enqueueCommittedVectorWrites(createdMemories);
	await store.flushPendingVectorWrites();
	// Assert: compare actual stored text, not unredacted inputs or collected text.
	expect(row).not.toBeNull();
	expect(row?.title).not.toContain(secret);
	expect(row?.body_text).not.toContain(secret);
	expect(storeVectors).toHaveBeenCalledExactlyOnceWith(
		store.db,
		memoryId,
		row?.title,
		row?.body_text,
	);
});

it("ignores collected identities after the caller rolls back", async () => {
	// Arrange
	const createdMemories: CreatedMemory[] = [];
	// Act
	expect(() =>
		store.db
			.transaction(() => {
				store.rememberForUser(
					sessionId,
					"discovery",
					"Rolled back",
					"Absent body",
					0.5,
					undefined,
					undefined,
					{ createdMemories },
				);
				expect(storeVectors).not.toHaveBeenCalled();
				throw new Error("caller rollback");
			})
			.immediate(),
	).toThrow("caller rollback");
	store.enqueueCommittedVectorWrites(createdMemories);
	await store.flushPendingVectorWrites();
	// Assert
	expect(createdMemories).toHaveLength(1);
	expect(store.get(createdMemories[0].memoryId)).toBeNull();
	expect(store.committedVectorInputs(createdMemories)).toEqual([]);
	expect(storeVectors).not.toHaveBeenCalled();
});

it.each([false, true])(
	"re-reads reused savepoint IDs and deduplicates identities (same import key=%s)",
	async (sameImportKey) => {
		// Arrange: a savepoint rollback leaves an identity in the caller's collector.
		const createdMemories: CreatedMemory[] = [];
		let memoryId = 0;
		// Act
		store.db
			.transaction(() => {
				expect(() =>
					store.db.transaction(() => {
						store.rememberForUser(
							sessionId,
							"discovery",
							"Stale title",
							"Stale body",
							0.5,
							undefined,
							{ import_key: "savepoint-key" },
							{ createdMemories },
						);
						throw new Error("savepoint rollback");
					})(),
				).toThrow("savepoint rollback");
				memoryId = store.rememberForUser(
					sessionId,
					"discovery",
					"Committed title",
					"Committed body",
					0.5,
					undefined,
					{ import_key: sameImportKey ? "savepoint-key" : "replacement-key" },
					{ createdMemories },
				);
				expect(storeVectors).not.toHaveBeenCalled();
			})
			.immediate();
		const inputs = store.committedVectorInputs(createdMemories);
		store.enqueueCommittedVectorWrites(createdMemories);
		await store.flushPendingVectorWrites();
		// Assert: neither stale text nor duplicate work survives ROWID reuse.
		expect(createdMemories).toHaveLength(2);
		expect(createdMemories[0].memoryId).toBe(memoryId);
		expect(createdMemories[1].memoryId).toBe(memoryId);
		expect(inputs).toEqual([{ memoryId, title: "Committed title", bodyText: "Committed body" }]);
		expect(storeVectors).toHaveBeenCalledExactlyOnceWith(
			store.db,
			memoryId,
			"Committed title",
			"Committed body",
		);
	},
);

it("does not collect effects for a deduplicated memory", async () => {
	// Arrange
	const createdMemories: CreatedMemory[] = [];
	const memoryId = store.rememberForUser(sessionId, "discovery", "Duplicate", "Duplicate body");
	await store.flushPendingVectorWrites();
	vi.mocked(storeVectors).mockClear();
	// Act
	const duplicateId = store.db
		.transaction(() =>
			store.rememberForUser(
				sessionId,
				"discovery",
				"Duplicate",
				"Duplicate body",
				0.5,
				undefined,
				undefined,
				{ createdMemories },
			),
		)
		.immediate();
	store.enqueueCommittedVectorWrites(createdMemories);
	await store.flushPendingVectorWrites();
	// Assert
	expect(duplicateId).toBe(memoryId);
	expect(createdMemories).toEqual([]);
	expect(storeVectors).not.toHaveBeenCalled();
});

it.each(["inactive", "deleted", "stale import key", "missing"])(
	"ignores %s identities after commit",
	async (state) => {
		// Arrange
		const createdMemories: CreatedMemory[] = [];
		store.db
			.transaction(() =>
				store.rememberForUser(
					sessionId,
					"discovery",
					"Filtered",
					"Filtered body",
					0.5,
					undefined,
					undefined,
					{ createdMemories },
				),
			)
			.immediate();
		const identity = createdMemories[0];
		if (state === "inactive")
			store.db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(identity.memoryId);
		if (state === "deleted")
			store.db
				.prepare("UPDATE memory_items SET deleted_at = ? WHERE id = ?")
				.run("2026-01-01T00:00:00Z", identity.memoryId);
		if (state === "stale import key") identity.importKey = "not-the-stored-key";
		if (state === "missing") identity.memoryId = -1;
		// Act
		const inputs = store.committedVectorInputs(createdMemories);
		store.enqueueCommittedVectorWrites(createdMemories);
		await store.flushPendingVectorWrites();
		// Assert
		expect(inputs).toEqual([]);
		expect(storeVectors).not.toHaveBeenCalled();
	},
);

it("rejects vector reads and enqueue while the outer transaction is open", async () => {
	// Arrange
	const createdMemories: CreatedMemory[] = [];
	// Act
	store.db
		.transaction(() => {
			store.rememberForUser(
				sessionId,
				"discovery",
				"Pending",
				"Pending body",
				0.5,
				undefined,
				undefined,
				{ createdMemories },
			);
			expect(() => store.committedVectorInputs(createdMemories)).toThrow(
				"vector inputs require a committed transaction",
			);
			expect(() => store.enqueueCommittedVectorWrites(createdMemories)).toThrow(
				"vector inputs require a committed transaction",
			);
		})
		.immediate();
	await store.flushPendingVectorWrites();
	// Assert
	expect(store.committedVectorInputs(createdMemories)).toHaveLength(1);
	expect(storeVectors).not.toHaveBeenCalled();
});

it.each([false, true])(
	"requires an outer collector unless globally disabled (disabled=%s)",
	async (disabled) => {
		// Arrange
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", disabled ? "1" : "0");
		const remember = vi.spyOn(store, "remember");
		const before = store.db.serialize();
		let memoryId = 0;
		const attempt = () =>
			store.db
				.transaction(() => {
					memoryId = store.rememberForUser(
						sessionId,
						"discovery",
						"No collector",
						"No collector body",
					);
				})
				.immediate();
		// Act
		if (disabled) attempt();
		else
			expect(attempt).toThrow(
				"rememberForUser requires createdMemories inside a caller-owned transaction",
			);
		await store.flushPendingVectorWrites();
		// Assert
		if (disabled) {
			expect(store.get(memoryId)?.title).toBe("No collector");
			expect(remember).toHaveBeenCalledOnce();
		} else {
			expect(remember).not.toHaveBeenCalled();
			expect(store.db.serialize().equals(before)).toBe(true);
		}
		expect(storeVectors).not.toHaveBeenCalled();
	},
);

it("retains ordinary raw remember suppression inside a caller transaction", async () => {
	// Arrange
	let memoryId = 0;
	// Act
	store.db
		.transaction(() => {
			memoryId = store.remember(sessionId, "discovery", "Raw transaction", "Raw body");
		})
		.immediate();
	await store.flushPendingVectorWrites();
	// Assert: raw remember does not acquire the user API's post-commit collector behavior.
	expect(store.get(memoryId)?.title).toBe("Raw transaction");
	expect(storeVectors).not.toHaveBeenCalled();
});

it("suppresses explicitly enqueued committed vectors when globally disabled", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const createdMemories: CreatedMemory[] = [];
	const memoryId = store.db
		.transaction(() =>
			store.rememberForUser(
				sessionId,
				"discovery",
				"Disabled effects",
				"Committed disabled body",
				0.5,
				undefined,
				undefined,
				{ createdMemories },
			),
		)
		.immediate();
	// Act
	const inputs = store.committedVectorInputs(createdMemories);
	store.enqueueCommittedVectorWrites(createdMemories);
	await store.flushPendingVectorWrites();
	// Assert: suppression skips only external work, not persistence or committed reads.
	expect(createdMemories).toHaveLength(1);
	expect(inputs).toEqual([
		{ memoryId, title: "Disabled effects", bodyText: "Committed disabled body" },
	]);
	expect(storeVectors).not.toHaveBeenCalled();
});
