/**
 * Viewer-server integration tests.
 *
 * Uses initTestSchema from @codemem/core (fix #5 — no duplicated DDL).
 * Uses Record<string, unknown> instead of Record<string, any> (fix #6).
 */

import { initTestSchema, insertTestSession, type MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create an in-memory MemoryStore backed by a fresh test schema.
 * The caller must close() when done.
 */
function createTestStore(): MemoryStore {
	// Create raw DB, init schema, then wrap in MemoryStore via its constructor
	// MemoryStore constructor calls connect() which creates a new DB.
	// Instead, we need to use the store directly with a test DB path.
	// Use :memory: via a temporary approach.
	const rawDb = new Database(":memory:");
	initTestSchema(rawDb);

	// MemoryStore expects a file path; for tests we create a thin wrapper
	// that reuses the raw DB.
	// Since MemoryStore.constructor calls connect() internally, we need to
	// create a store-compatible object. For now, create a real MemoryStore
	// using a temp file, but that's slow. Instead, create a lightweight
	// test harness.
	//
	// Actually, MemoryStore from core re-opens the db. For in-memory tests,
	// we need to work around this. The cleanest approach: insert test data
	// into the raw DB, then use it directly for assertions.

	// Return the raw DB wrapped to match the subset of MemoryStore we need.
	return {
		db: rawDb,
		dbPath: ":memory:",
		deviceId: "test-device-001",
		stats() {
			return {
				database: {
					path: ":memory:",
					size_bytes: 0,
					sessions: 0,
					memory_items: 0,
					active_memory_items: 0,
					artifacts: 0,
					vector_rows: 0,
					raw_events: 0,
				},
			};
		},
		close() {
			rawDb.close();
		},
	} as unknown as MemoryStore;
}

/** Create a test Hono app backed by a fresh in-memory DB. */
function createTestApp() {
	let store: MemoryStore | null = null;

	const app = createApp(() => {
		// Reuse the same store for the lifetime of the test
		if (!store) {
			store = createTestStore();
		}
		return store;
	});

	return {
		app,
		getStore: () => store,
		cleanup: () => {
			if (store) {
				store.close();
				store = null;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("viewer-server", () => {
	describe("GET /api/stats", () => {
		it("returns database stats", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("database");
				const db = body.database as Record<string, unknown>;
				expect(db).toHaveProperty("path");
				expect(db).toHaveProperty("sessions");
				expect(db).toHaveProperty("memory_items");
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/sessions", () => {
		it("returns sessions list", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				// Force store creation
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (store) {
					insertTestSession(store.db);
				}
				const res = await app.request("/api/sessions");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("items");
				const items = body.items as Record<string, unknown>[];
				expect(items.length).toBeGreaterThanOrEqual(1);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/projects", () => {
		it("returns empty projects for fresh DB", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/projects");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("projects");
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/observer-status", () => {
		it("returns stub observer status", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/observer-status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.active).toBeNull();
				expect(body).toHaveProperty("queue");
			} finally {
				cleanup();
			}
		});
	});

	describe("CORS middleware", () => {
		it("rejects POST without Origin header", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ memory_id: 1, visibility: "shared" }),
				});
				expect(res.status).toBe(403);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("forbidden");
			} finally {
				cleanup();
			}
		});

		it("rejects POST with non-loopback Origin", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify({ memory_id: 1, visibility: "shared" }),
				});
				expect(res.status).toBe(403);
			} finally {
				cleanup();
			}
		});

		it("allows POST with loopback Origin", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: 999, visibility: "shared" }),
				});
				// Should get past CORS (404 or 400 expected, not 403)
				expect(res.status).not.toBe(403);
			} finally {
				cleanup();
			}
		});

		it("allows GET without Origin header", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
			} finally {
				cleanup();
			}
		});
	});

	describe("viewer HTML", () => {
		it("returns HTML at root with hardcoded title", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/");
				expect(res.status).toBe(200);
				const html = await res.text();
				expect(html).toContain("<title>codemem</title>");
				expect(html).toContain('id="root"');
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/sync/peers", () => {
		it("returns empty peers list", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				// Ensure store + actors table exist
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (store) {
					// Create actors table if not present
					store.db.exec(`
						CREATE TABLE IF NOT EXISTS actors (
							actor_id TEXT PRIMARY KEY,
							display_name TEXT NOT NULL,
							is_local INTEGER NOT NULL DEFAULT 0,
							status TEXT NOT NULL DEFAULT 'active',
							merged_into_actor_id TEXT,
							created_at TEXT NOT NULL,
							updated_at TEXT NOT NULL
						)
					`);
				}
				const res = await app.request("/api/sync/peers");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("items");
				expect(body.redacted).toBe(true);
			} finally {
				cleanup();
			}
		});
	});
});
