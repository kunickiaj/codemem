/**
 * Route tests for pi-hooks ingest + memory tool-support HTTP twins.
 *
 * Contracts mirror packages/mcp-server tool handlers against MemoryStore.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initTestSchema,
	insertTestSession,
	MemoryStore,
	type RawEventSweeper,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

// Keep route tests hermetic: no embedding model downloads on the hot path.
// Save/restore so sibling suites in a shared worker are unaffected.
let savedEmbeddingDisabled: string | undefined;
beforeAll(() => {
	savedEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
});
afterAll(() => {
	if (savedEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
	else process.env.CODEMEM_EMBEDDING_DISABLED = savedEmbeddingDisabled;
});
function createTestStore(): { store: MemoryStore; cleanup: () => void } {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-memory-tools-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	rawDb
		.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("test-device-001", "test-public-key", "test-fingerprint", new Date().toISOString());
	rawDb.close();
	const store = new MemoryStore(dbPath);
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

function createTestApp(opts?: { sweeper?: Partial<RawEventSweeper> | null }) {
	let store: MemoryStore | null = null;
	let storeCleanup: (() => void) | null = null;
	const storeFactory = () => {
		if (!store) {
			const created = createTestStore();
			store = created.store;
			storeCleanup = created.cleanup;
		}
		return store;
	};
	const app = createApp({
		storeFactory,
		sweeper: (opts?.sweeper ?? null) as RawEventSweeper | null,
	});
	return {
		app,
		getStore: () => store,
		ensureStore: () => storeFactory(),
		cleanup: () => {
			storeCleanup?.();
			store = null;
			storeCleanup = null;
		},
	};
}

function jsonHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Origin: "http://127.0.0.1:38888",
	};
}

function seedMemories(store: MemoryStore): { sessionId: number; ids: number[] } {
	const sessionId = insertTestSession(store.db);
	// Ensure project matches insertTestSession default so project filters work.
	store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("test-project", sessionId);
	const ids = [
		store.remember(
			sessionId,
			"discovery",
			"Database migration guide",
			"How to run migrations",
			0.9,
		),
		store.remember(sessionId, "feature", "Auth system", "JWT tokens and refresh flow", 0.8),
		store.remember(sessionId, "decision", "Use SQLite", "Pick sqlite for local store", 0.7),
		store.remember(sessionId, "bugfix", "Fix race in cache", "Race on concurrent writes", 0.6),
	];
	return { sessionId, ids };
}

// ---------------------------------------------------------------------------
// 4.1 POST /api/pi-hooks
// ---------------------------------------------------------------------------

describe("POST /api/pi-hooks", () => {
	it("records a pi event with source=pi and nudges the sweeper with (stream, pi)", async () => {
		const nudge = vi.fn();
		const { app, getStore, cleanup } = createTestApp({
			sweeper: { nudge } as Partial<RawEventSweeper>,
		});
		try {
			const payload = {
				piEvent: "session_start",
				sessionId: "pi-sess-route-1",
				cwd: "/tmp/pi-proj",
				ts: "2026-04-01T12:00:00.000Z",
			};
			const res = await app.request("/api/pi-hooks", {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ inserted: 1, skipped: 0 });

			const store = getStore();
			if (!store) throw new Error("store missing");

			const eventRow = store.db
				.prepare(
					"SELECT source, stream_id, event_id, event_type FROM raw_events WHERE stream_id = ?",
				)
				.get("pi-sess-route-1") as {
				source: string;
				stream_id: string;
				event_id: string;
				event_type: string;
			};
			expect(eventRow.source).toBe("pi");
			expect(eventRow.stream_id).toBe("pi-sess-route-1");
			expect(eventRow.event_id).toBe("pi:pi-sess-route-1:session_start");
			expect(eventRow.event_type).toBe("pi.hook");

			const sessionRow = store.db
				.prepare("SELECT source, stream_id FROM raw_event_sessions WHERE stream_id = ?")
				.get("pi-sess-route-1") as { source: string; stream_id: string };
			expect(sessionRow.source).toBe("pi");

			const opencodeCount = store.db
				.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE source = 'opencode'")
				.get() as { n: number };
			expect(opencodeCount.n).toBe(0);

			expect(nudge).toHaveBeenCalledWith("pi-sess-route-1", "pi");
		} finally {
			cleanup();
		}
	});

	it("dedupes identical pi events on retry", async () => {
		const nudge = vi.fn();
		const { app, getStore, cleanup } = createTestApp({
			sweeper: { nudge } as Partial<RawEventSweeper>,
		});
		try {
			const payload = {
				piEvent: "message_end",
				sessionId: "pi-sess-dedupe",
				entryId: "entry-42",
				role: "user",
				text: "hello from pi",
				ts: "2026-04-01T12:01:00.000Z",
			};
			const first = await app.request("/api/pi-hooks", {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify(payload),
			});
			expect(await first.json()).toEqual({ inserted: 1, skipped: 0 });

			const second = await app.request("/api/pi-hooks", {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify(payload),
			});
			expect(await second.json()).toEqual({ inserted: 0, skipped: 0 });

			const store = getStore();
			if (!store) throw new Error("store missing");
			const count = store.db
				.prepare(
					"SELECT COUNT(*) AS n FROM raw_events WHERE source = 'pi' AND stream_id = ? AND event_id = ?",
				)
				.get("pi-sess-dedupe", "pi:pi-sess-dedupe:entry-42") as { n: number };
			expect(count.n).toBe(1);
			expect(nudge).toHaveBeenCalledTimes(2);
			expect(nudge).toHaveBeenNthCalledWith(1, "pi-sess-dedupe", "pi");
			expect(nudge).toHaveBeenNthCalledWith(2, "pi-sess-dedupe", "pi");
		} finally {
			cleanup();
		}
	});

	it("skips unsupported / flush-only pi events without writing rows", async () => {
		const nudge = vi.fn();
		const { app, getStore, ensureStore, cleanup } = createTestApp({
			sweeper: { nudge } as Partial<RawEventSweeper>,
		});
		try {
			ensureStore();
			const res = await app.request("/api/pi-hooks", {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify({
					piEvent: "session_before_compact",
					sessionId: "pi-sess-compact",
				}),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ inserted: 0, skipped: 1 });
			expect(nudge).not.toHaveBeenCalled();

			const store = getStore();
			if (!store) throw new Error("store missing");
			const count = store.db.prepare("SELECT COUNT(*) AS n FROM raw_events").get() as {
				n: number;
			};
			expect(count.n).toBe(0);
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// 4.2 / 4.3 Memory tool routes vs MCP twins
// ---------------------------------------------------------------------------

describe("memory tool routes", () => {
	describe("POST /api/memories/remember (memory_remember)", () => {
		it("creates a memory and returns { id }", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/remember", {
					method: "POST",
					headers: jsonHeaders(),
					body: JSON.stringify({
						kind: "decision",
						title: "Adopt HTTP tool routes",
						body: "Close the viewer gap so pi can call tools over HTTP.",
						confidence: 0.85,
						project: "codemem",
					}),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as { id: number };
				expect(typeof body.id).toBe("number");
				expect(body.id).toBeGreaterThan(0);

				const store = getStore();
				if (!store) throw new Error("store missing");
				const item = store.get(body.id);
				expect(item?.title).toBe("Adopt HTTP tool routes");
				expect(item?.kind).toBe("decision");
				expect(Number(item?.active)).toBe(1);

				const session = store.db
					.prepare("SELECT project, tool_version FROM sessions WHERE id = ?")
					.get(item?.session_id) as { project: string; tool_version: string };
				expect(session.project).toBe("codemem");
				expect(session.tool_version).toBe("viewer-api");
			} finally {
				cleanup();
			}
		});

		it("rejects invalid kind", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/remember", {
					method: "POST",
					headers: jsonHeaders(),
					body: JSON.stringify({
						kind: "not-a-kind",
						title: "x",
						body: "y",
					}),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error: string };
				expect(body.error).toMatch(/kind must be one of/);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/memories/timeline (memory_timeline)", () => {
		it("returns a chronological window around an anchor id", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const { ids } = seedMemories(store);
				const anchor = ids[2];

				const res = await app.request(
					`/api/memories/timeline?memory_id=${anchor}&depth_before=2&depth_after=2`,
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as { items: Array<{ id: number }> };
				expect(Array.isArray(body.items)).toBe(true);
				expect(body.items.some((item) => item.id === anchor)).toBe(true);
				expect(body.items.length).toBeGreaterThanOrEqual(1);
			} finally {
				cleanup();
			}
		});

		it("anchors via query string like the MCP tool", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				seedMemories(store);
				const res = await app.request(
					"/api/memories/timeline?query=Database&depth_before=1&depth_after=1",
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as { items: Array<{ title: string }> };
				expect(body.items.length).toBeGreaterThan(0);
				expect(body.items.some((item) => /Database|migration/i.test(item.title))).toBe(true);
			} finally {
				cleanup();
			}
		});

		it("honors JSON filters.include_visibility (MCP filter surface parity)", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("test-project", sessionId);
				const sharedId = store.remember(
					sessionId,
					"discovery",
					"Timeline shared visibility row",
					"shared body for timeline filter",
					0.9,
					undefined,
					{ visibility: "shared" },
				);
				const privateId = store.remember(
					sessionId,
					"discovery",
					"Timeline private visibility row",
					"private body for timeline filter",
					0.9,
					undefined,
					{ visibility: "private" },
				);

				const filters = encodeURIComponent(JSON.stringify({ include_visibility: ["private"] }));
				const res = await app.request(
					`/api/memories/timeline?query=Timeline&depth_before=5&depth_after=5&filters=${filters}`,
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as { items: Array<{ id: number; title: string }> };
				const ids = body.items.map((item) => item.id);
				expect(ids).toContain(privateId);
				expect(ids).not.toContain(sharedId);
			} finally {
				cleanup();
			}
		});

		it("rejects malformed filters JSON with 400", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/timeline?query=x&filters=not-json");
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({ error: "filters must be valid JSON" });
			} finally {
				cleanup();
			}
		});
	});

	describe("POST /api/memories/expand (memory_expand)", () => {
		it("returns anchors, timeline, missing_ids, errors, metadata", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const { ids } = seedMemories(store);
				const res = await app.request("/api/memories/expand", {
					method: "POST",
					headers: jsonHeaders(),
					body: JSON.stringify({
						ids: [ids[0], ids[1], 999999],
						depth_before: 1,
						depth_after: 1,
						include_observations: true,
					}),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					anchors: Array<{ id: number }>;
					timeline: Array<{ id: number }>;
					observations: Array<{ id: number }>;
					missing_ids: number[];
					errors: Array<{ code: string }>;
					metadata: {
						requested_ids_count: number;
						returned_anchor_count: number;
						include_observations: boolean;
					};
				};
				expect(body.anchors.map((a) => a.id).sort()).toEqual([ids[0], ids[1]].sort());
				expect(body.timeline.length).toBeGreaterThanOrEqual(2);
				expect(body.observations.length).toBeGreaterThan(0);
				expect(body.missing_ids).toContain(999999);
				expect(body.errors.some((e) => e.code === "NOT_FOUND")).toBe(true);
				expect(body.metadata.requested_ids_count).toBe(3);
				expect(body.metadata.returned_anchor_count).toBe(2);
				expect(body.metadata.include_observations).toBe(true);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/memories/schema (memory_schema)", () => {
		it("returns kinds, kind_descriptions, fields, and filters", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/schema");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					kinds: string[];
					kind_descriptions: Record<string, string>;
					fields: Record<string, string>;
					filters: string[];
				};
				expect(body.kinds).toEqual(
					expect.arrayContaining([
						"discovery",
						"change",
						"feature",
						"bugfix",
						"refactor",
						"decision",
						"exploration",
					]),
				);
				expect(body.kind_descriptions.decision).toMatch(/design/i);
				expect(body.fields.title).toBe("short text");
				expect(body.fields.body).toBe("long text");
				expect(body.filters).toEqual(expect.arrayContaining(["kind", "project", "scope_id"]));
				// Sorted like MCP Object.keys(...).toSorted()
				expect(body.filters).toEqual([...body.filters].toSorted());
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/memories/search_index (memory_search_index)", () => {
		it("returns compact index entries without body text", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				seedMemories(store);
				const res = await app.request("/api/memories/search_index?query=Database&limit=5");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					items: Array<Record<string, unknown>>;
				};
				expect(body.items.length).toBeGreaterThan(0);
				const first = body.items[0];
				expect(first).toEqual(
					expect.objectContaining({
						id: expect.any(Number),
						kind: expect.any(String),
						title: expect.any(String),
						score: expect.any(Number),
						created_at: expect.any(String),
						session_id: expect.any(Number),
						metadata: expect.any(Object),
					}),
				);
				// Compact index: no body / body_text field (MCP parity)
				expect(first).not.toHaveProperty("body");
				expect(first).not.toHaveProperty("body_text");
			} finally {
				cleanup();
			}
		});

		it("requires query", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/search_index");
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({ error: "query required" });
			} finally {
				cleanup();
			}
		});

		it("honors JSON filters.include_visibility so private rows can be selected", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("test-project", sessionId);
				// Distinct titles so FTS/search ranking is unambiguous.
				const sharedId = store.remember(
					sessionId,
					"bugfix",
					"IndexAlpha shared row",
					"shared body IndexAlpha",
					0.9,
					undefined,
					{ visibility: "shared" },
				);
				const privateId = store.remember(
					sessionId,
					"bugfix",
					"IndexAlpha private row",
					"private body IndexAlpha",
					0.9,
					undefined,
					{ visibility: "private" },
				);

				// Without filters both (or at least shared) should be findable.
				const unfiltered = await app.request(
					"/api/memories/search_index?query=IndexAlpha&limit=10",
				);
				expect(unfiltered.status).toBe(200);
				const unfilteredBody = (await unfiltered.json()) as {
					items: Array<{ id: number }>;
				};
				const unfilteredIds = unfilteredBody.items.map((i) => i.id);
				expect(unfilteredIds).toContain(sharedId);

				const filters = encodeURIComponent(JSON.stringify({ include_visibility: ["private"] }));
				const res = await app.request(
					`/api/memories/search_index?query=IndexAlpha&limit=10&filters=${filters}`,
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as { items: Array<{ id: number; title: string }> };
				const ids = body.items.map((item) => item.id);
				expect(ids).toContain(privateId);
				expect(ids).not.toContain(sharedId);
			} finally {
				cleanup();
			}
		});

		it("honors kind inside JSON filters (not only top-level kind)", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				seedMemories(store);
				const filters = encodeURIComponent(JSON.stringify({ kind: "feature" }));
				const res = await app.request(
					`/api/memories/search_index?query=Auth&limit=10&filters=${filters}`,
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as { items: Array<{ kind: string; title: string }> };
				expect(body.items.length).toBeGreaterThan(0);
				for (const item of body.items) {
					expect(item.kind).toBe("feature");
				}
			} finally {
				cleanup();
			}
		});
	});

	describe("POST /api/memories/explain (memory_explain)", () => {
		it("returns scored explanation payload for a query", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				seedMemories(store);
				const res = await app.request("/api/memories/explain", {
					method: "POST",
					headers: jsonHeaders(),
					body: JSON.stringify({ query: "database", limit: 5 }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					items: Array<{ id: number }>;
					errors: unknown[];
				};
				expect(Array.isArray(body.items)).toBe(true);
				expect(Array.isArray(body.errors)).toBe(true);
				expect(body.items.length).toBeGreaterThan(0);
			} finally {
				cleanup();
			}
		});

		it("explains specific ids", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const { ids } = seedMemories(store);
				const res = await app.request("/api/memories/explain", {
					method: "POST",
					headers: jsonHeaders(),
					body: JSON.stringify({ ids: [ids[0], ids[1]], limit: 10 }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as { items: Array<{ id: number }> };
				const returned = body.items.map((i) => i.id);
				expect(returned).toEqual(expect.arrayContaining([ids[0], ids[1]]));
			} finally {
				cleanup();
			}
		});
	});

	describe("POST /api/memories/distill_candidates (memory_distill_candidates)", () => {
		it("returns a distill report shape (judge off for determinism)", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				// Seed recurring-ish content so mining has something to cluster.
				const sessionId = insertTestSession(store.db);
				for (let i = 0; i < 4; i++) {
					store.remember(
						sessionId,
						"discovery",
						`Prefer explicit source attribution ${i}`,
						"Always pass source pi explicitly; never rely on opencode defaults.",
						0.8,
					);
				}
				const res = await app.request("/api/memories/distill_candidates", {
					method: "POST",
					headers: jsonHeaders(),
					body: JSON.stringify({
						limit: 5,
						min_recurrence: 2,
						judge: false,
						all_projects: true,
					}),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					candidates: unknown[];
					metadata: Record<string, unknown>;
				};
				expect(Array.isArray(body.candidates)).toBe(true);
				expect(body.metadata).toEqual(expect.any(Object));
			} finally {
				cleanup();
			}
		});

		it("rejects project combined with all_projects", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/distill_candidates", {
					method: "POST",
					headers: jsonHeaders(),
					body: JSON.stringify({
						all_projects: true,
						project: "codemem",
						judge: false,
					}),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error: string };
				expect(body.error).toMatch(/project cannot be combined with all_projects/);
			} finally {
				cleanup();
			}
		});
	});
});
