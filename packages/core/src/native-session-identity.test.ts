import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import type { IngestPayload } from "./ingest-types.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("node:crypto", async (original) => ({
	...(await original<typeof import("node:crypto")>()),
	randomUUID: vi.fn(),
}));
vi.mock("./project.js", async (original) => ({
	...(await original<typeof import("./project.js")>()),
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", async (original) => ({
	...(await original<typeof import("./vectors.js")>()),
	storeVectors: vi.fn().mockResolvedValue(undefined),
}));

const firstKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let directory: string;
let store: MemoryStore;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "native-session-identity-"));
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const path = join(directory, "memory.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
	vi.mocked(randomUUID).mockReset().mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey);
});

afterEach(async () => {
	await store.flushPendingVectorWrites();
	store.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function key(id: number) {
	return store.db.prepare("SELECT import_key FROM sessions WHERE id = ?").pluck().get(id);
}

it("mints exactly one bookkeeping UUID per new raw-event session, not per lookup", () => {
	// Arrange: two streams with identical project context are separate native sessions.
	const options = { cwd: "/fixture/project", project: "fixture" };
	// Act
	const first = store.getOrCreateSessionForOpencodeSession({ ...options, opencodeSessionId: "a" });
	const reused = store.getOrCreateSessionForOpencodeSession({ ...options, opencodeSessionId: "a" });
	const second = store.getOrCreateSessionForOpencodeSession({ ...options, opencodeSessionId: "b" });
	// Assert
	expect(reused).toBe(first);
	expect(second).not.toBe(first);
	expect([key(first), key(second)]).toEqual([firstKey, secondKey]);
	expect(randomUUID).toHaveBeenCalledTimes(2);
});

it.each([null, "legacy-key", firstKey])(
	"reuses historical raw-event sessions without repairing %s",
	(originalKey) => {
		// Arrange: the stream mapping predates this lookup; even NULL must remain unchanged.
		const id = store.getOrCreateSessionForOpencodeSession({ opencodeSessionId: "historical" });
		store.db.prepare("UPDATE sessions SET import_key = ? WHERE id = ?").run(originalKey, id);
		const before = store.db.prepare("SELECT * FROM sessions ORDER BY id").all();
		const changes = store.db.prepare("SELECT total_changes()").pluck().get();
		vi.mocked(randomUUID).mockClear();
		// Act
		const first = store.getOrCreateSessionForOpencodeSession({ opencodeSessionId: "historical" });
		const second = store.getOrCreateSessionForOpencodeSession({ opencodeSessionId: "historical" });
		// Assert: reuse is read-only, not a migration or ownership claim.
		expect([first, second]).toEqual([id, id]);
		expect(key(id)).toBe(originalKey);
		expect(store.db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(before);
		expect(store.db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		expect(randomUUID).not.toHaveBeenCalled();
	},
);

it("reuses the native raw-event ingest row and its original UUID across flushes", async () => {
	// Arrange: a filtered summary-only micro-session writes no memories, isolating session minting.
	const payload: IngestPayload = {
		cwd: "/fixture/project",
		events: [
			{ type: "user_prompt", prompt_text: "ok", prompt_number: 1 },
			{ type: "assistant_message", assistant_text: "Done." },
		],
		sessionContext: {
			source: "opencode",
			streamId: "native-stream",
			opencodeSessionId: "native-stream",
			promptCount: 1,
			toolCount: 0,
			durationMs: 20_000,
			flusher: "raw_events",
		},
	};
	const observer = {
		observe: vi.fn().mockResolvedValue({
			raw: "<summary><request>No code changes were made</request></summary>",
			parsed: null,
			provider: "test",
			model: "test",
		}),
		getStatus: () => ({
			provider: "test",
			model: "test",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	};
	// Act
	await ingest(payload, store, { observer } as unknown as IngestOptions);
	const first = store.db.prepare("SELECT id, import_key FROM sessions").get();
	await ingest(payload, store, { observer } as unknown as IngestOptions);
	// Assert: repeating a flush must not create a new row or overwrite the original key.
	expect(first).toEqual({ id: 1, import_key: firstKey });
	expect(store.db.prepare("SELECT id, import_key FROM sessions").all()).toEqual([first]);
	expect(randomUUID).toHaveBeenCalledTimes(1);
});

it.each([undefined, "raw_events"])(
	"assigns a UUID to plugin ingest fallback with flusher %s",
	async (flusher) => {
		// Arrange: no OpenCode session ID means a genuinely new native plugin row.
		store.db
			.prepare(
				"INSERT INTO sessions(started_at, import_key) VALUES ('2026-01-01', NULL), ('2026-01-02', 'legacy-key')",
			)
			.run();
		const historical = store.db.prepare("SELECT * FROM sessions ORDER BY id").all();
		const payload: IngestPayload = {
			cwd: "/fixture/project",
			events: [{ type: "user_prompt", prompt_text: "ok", prompt_number: 1 }],
			sessionContext: { flusher, promptCount: 1, toolCount: 0, durationMs: 1000 },
		};
		const observer = {
			observe: vi
				.fn()
				.mockResolvedValue({ raw: "", parsed: null, provider: "test", model: "test" }),
			getStatus: () => ({
				provider: "test",
				model: "test",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};
		// Act
		const ingestion = ingest(payload, store, { observer } as unknown as IngestOptions);
		if (flusher === "raw_events") {
			// Raw-event losslessness rejects this empty micro-session after creating its row.
			await expect(ingestion).rejects.toThrow(
				"observer produced no storable output for raw-event flush",
			);
		} else {
			await ingestion;
		}
		// Assert: bookkeeping is assigned even when extraction yields no memories.
		expect(
			store.db
				.prepare("SELECT import_key FROM sessions WHERE tool_version = 'plugin-ts'")
				.pluck()
				.all(),
		).toEqual([firstKey]);
		expect(randomUUID).toHaveBeenCalledTimes(1);
		expect(store.db.prepare("SELECT * FROM sessions WHERE id <= 2 ORDER BY id").all()).toEqual(
			historical,
		);
	},
);
