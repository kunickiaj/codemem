import { fingerprintPublicKey, insertTestSession, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedCursorUnavailableError } from "../../ui/src/lib/api/feed-request.js";
import { loadMemoriesPage } from "../../ui/src/lib/api/memories.js";
import { memoryRoutes } from "./routes/memory.js";

vi.mock("../../core/src/observer-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../core/src/observer-config.js")>()),
	readCodememConfigFile: () => ({}),
}));

const now = "2026-11-01T00:00:00.000Z";
const publicKey = `ssh-ed25519 ${Buffer.concat([
	Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
	Buffer.alloc(32, 7),
]).toString("base64")}`;
let store: MemoryStore;
let sessionId: number;
let requests: string[];

beforeEach(() => {
	vi.stubEnv("CODEMEM_DEVICE_ID", "cursor-reader");
	vi.stubEnv("CODEMEM_ACTOR_ID", "cursor-author");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.spyOn(MemoryStore.prototype, "enqueueVectorWrite").mockImplementation(() => {});
	store = new MemoryStore(":memory:", {
		runtimeSigningKey: { deviceId: "cursor-reader", publicKey },
	});
	store.db
		.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(store.deviceId, publicKey, fingerprintPublicKey(publicKey), now);
	sessionId = insertTestSession(store.db);
	store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("cursor-project", sessionId);
	const app = memoryRoutes(() => store);
	requests = [];
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			requests.push(String(input));
			return app.request(String(input), init);
		}),
	);
});
afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function seed(at = now) {
	return Number(
		store.db
			.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, created_at, updated_at, metadata_json,
		actor_id, origin_device_id, active, project)
		VALUES (?, 'discovery', 'Cursor observation', 'Searchable cursor body', ?, ?, '{}',
		'cursor-author', 'replica', 1, 'cursor-project')`)
			.run(sessionId, at, now).lastInsertRowid,
	);
}

function itemIds(items: unknown[] | undefined): number[] | undefined {
	return items?.map((item) => {
		if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "number") {
			throw new Error("Expected a feed item with a numeric id.");
		}
		return item.id;
	});
}

it("reads the actual issuer's first and final pages through the strict UI client", async () => {
	// Arrange
	const ids = [seed(), seed(), seed()];
	// Act
	const first = await loadMemoriesPage("cursor-project", {
		view: "feed",
		paging: "cursor",
		limit: 2,
	});
	expect(first.pagination?.next_cursor).toEqual(expect.any(String));
	const next = await loadMemoriesPage("cursor-project", {
		view: "feed",
		paging: "cursor",
		limit: 2,
		cursor: first.pagination?.next_cursor ?? undefined,
	});
	// Assert
	expect(itemIds(first.items)).toEqual([ids[2], ids[1]]);
	expect(itemIds(next.items)).toEqual([ids[0]]);
	expect(next.pagination).toEqual({
		limit: 2,
		offset: null,
		next_offset: null,
		has_more: false,
		paging: "cursor",
		next_cursor: null,
	});
	expect(requests).toHaveLength(2);
});

it("recognizes the issuer's unavailable anchor and permits a plain offset restart", async () => {
	// Arrange: this legal stored timestamp cannot fit a cursor anchor.
	seed("a");
	const long = seed("m".repeat(257));
	const top = seed("z");
	// Act / Assert
	await expect(
		loadMemoriesPage("cursor-project", { view: "feed", paging: "cursor", limit: 2 }),
	).rejects.toBeInstanceOf(FeedCursorUnavailableError);
	const restarted = await loadMemoriesPage("cursor-project", { view: "feed", limit: 2, offset: 0 });
	expect(itemIds(restarted.items)).toEqual([top, long]);
	expect(restarted.pagination).toEqual({ limit: 2, offset: 0, next_offset: 2, has_more: true });
	expect(requests).toHaveLength(2);
	expect(new URL(requests[1], "https://example.test").searchParams.has("paging")).toBe(false);
});
