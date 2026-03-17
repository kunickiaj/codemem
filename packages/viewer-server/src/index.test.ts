/**
 * Viewer server route tests.
 *
 * Uses Hono's built-in test client (app.request()) — no real HTTP server needed.
 * Tests use an in-memory SQLite DB with initTestSchema from @codemem/core.
 */

import { SCHEMA_VERSION } from "@codemem/core";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

import type { ViewerVariables } from "./middleware.js";
import { corsMiddleware } from "./middleware.js";
import configRoutes from "./routes/config.js";
import memoryRoutes from "./routes/memory.js";
import observerStatusRoutes from "./routes/observer-status.js";
import rawEventsRoutes from "./routes/raw-events.js";
import statsRoutes from "./routes/stats.js";
import syncRoutes from "./routes/sync.js";
import { viewerHtml } from "./viewer-html.js";

// ---------------------------------------------------------------------------
// Test schema (inline to avoid importing core test-utils which isn't exported)
// ---------------------------------------------------------------------------

function initTestSchema(db: InstanceType<typeof Database>): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id INTEGER PRIMARY KEY,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			cwd TEXT,
			project TEXT,
			git_remote TEXT,
			git_branch TEXT,
			user TEXT,
			tool_version TEXT,
			metadata_json TEXT,
			import_key TEXT
		);
		CREATE TABLE IF NOT EXISTS memory_items (
			id INTEGER PRIMARY KEY,
			session_id INTEGER NOT NULL REFERENCES sessions(id),
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			subtitle TEXT,
			body_text TEXT NOT NULL,
			confidence REAL DEFAULT 0.5,
			tags_text TEXT DEFAULT '',
			active INTEGER DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			metadata_json TEXT,
			actor_id TEXT,
			actor_display_name TEXT,
			visibility TEXT,
			workspace_id TEXT,
			workspace_kind TEXT,
			origin_device_id TEXT,
			origin_source TEXT,
			trust_state TEXT,
			facts TEXT,
			narrative TEXT,
			concepts TEXT,
			files_read TEXT,
			files_modified TEXT,
			user_prompt_id INTEGER,
			prompt_number INTEGER,
			deleted_at TEXT,
			rev INTEGER DEFAULT 0,
			import_key TEXT
		);
		CREATE TABLE IF NOT EXISTS artifacts (
			id INTEGER PRIMARY KEY,
			session_id INTEGER NOT NULL REFERENCES sessions(id),
			kind TEXT NOT NULL,
			path TEXT,
			content_text TEXT,
			content_hash TEXT,
			content_encoding TEXT,
			content_blob BLOB,
			created_at TEXT NOT NULL,
			metadata_json TEXT
		);
		CREATE TABLE IF NOT EXISTS raw_events (
			id INTEGER PRIMARY KEY,
			source TEXT NOT NULL DEFAULT 'opencode',
			stream_id TEXT NOT NULL DEFAULT '',
			opencode_session_id TEXT NOT NULL,
			event_id TEXT,
			event_seq INTEGER NOT NULL,
			event_type TEXT NOT NULL,
			ts_wall_ms INTEGER,
			ts_mono_ms REAL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(source, stream_id, event_seq),
			UNIQUE(source, stream_id, event_id)
		);
		CREATE TABLE IF NOT EXISTS user_prompts (
			id INTEGER PRIMARY KEY,
			session_id INTEGER,
			project TEXT,
			prompt_text TEXT NOT NULL,
			prompt_number INTEGER,
			created_at TEXT NOT NULL,
			created_at_epoch INTEGER,
			metadata_json TEXT,
			import_key TEXT
		);
		CREATE TABLE IF NOT EXISTS usage_events (
			id INTEGER PRIMARY KEY,
			session_id INTEGER,
			event TEXT NOT NULL,
			tokens_read INTEGER DEFAULT 0,
			tokens_written INTEGER DEFAULT 0,
			tokens_saved INTEGER DEFAULT 0,
			created_at TEXT NOT NULL,
			metadata_json TEXT
		);
		CREATE TABLE IF NOT EXISTS sync_device (
			device_id TEXT PRIMARY KEY,
			public_key TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS sync_peers (
			peer_device_id TEXT PRIMARY KEY,
			name TEXT,
			pinned_fingerprint TEXT,
			public_key TEXT,
			addresses_json TEXT,
			claimed_local_actor INTEGER NOT NULL DEFAULT 0,
			actor_id TEXT,
			projects_include_json TEXT,
			projects_exclude_json TEXT,
			created_at TEXT NOT NULL,
			last_seen_at TEXT,
			last_sync_at TEXT,
			last_error TEXT
		);
		CREATE TABLE IF NOT EXISTS sync_attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			peer_device_id TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			ok INTEGER NOT NULL DEFAULT 0,
			ops_in INTEGER NOT NULL DEFAULT 0,
			ops_out INTEGER NOT NULL DEFAULT 0,
			error TEXT
		);
		CREATE TABLE IF NOT EXISTS actors (
			actor_id TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			is_local INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'active',
			merged_into_actor_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS sync_daemon_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			last_error TEXT,
			last_traceback TEXT,
			last_error_at TEXT,
			last_ok_at TEXT
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
			title, body_text, tags_text,
			content='memory_items', content_rowid='id'
		);
		CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
			INSERT INTO memory_fts(rowid, title, body_text, tags_text)
			VALUES (new.id, new.title, new.body_text, new.tags_text);
		END;
		PRAGMA user_version = ${SCHEMA_VERSION};
	`);
}

function _insertTestSession(db: InstanceType<typeof Database>): number {
	const now = new Date().toISOString();
	const info = db
		.prepare("INSERT INTO sessions (started_at, cwd, user, tool_version) VALUES (?, ?, ?, ?)")
		.run(now, "/tmp/test", "testuser", "test-1.0");
	return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Fake store middleware — injects a MemoryStore backed by in-memory DB
// ---------------------------------------------------------------------------

import { MemoryStore } from "@codemem/core";

/**
 * Build a test Hono app with a real MemoryStore backed by a temp DB file.
 * We use a temp file because MemoryStore calls connect() which opens by path.
 */
function createTestApp(dbPath: string): Hono<{ Variables: ViewerVariables }> {
	const app = new Hono<{ Variables: ViewerVariables }>();

	app.use("*", corsMiddleware());

	// Store middleware that uses the test DB path
	app.use("/api/*", async (c, next) => {
		const store = new MemoryStore(dbPath);
		c.set("store", store);
		try {
			await next();
		} finally {
			store.close();
		}
	});

	app.route("/", statsRoutes);
	app.route("/", memoryRoutes);
	app.route("/", observerStatusRoutes);
	app.route("/", configRoutes);
	app.route("/", rawEventsRoutes);
	app.route("/", syncRoutes);

	app.get("/", (c) => c.html(viewerHtml()));
	app.get("*", (c) => {
		if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
		return c.html(viewerHtml());
	});

	return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("viewer-server", () => {
	let dbPath: string;
	let tmpDir: string;
	let app: Hono<{ Variables: ViewerVariables }>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
		dbPath = join(tmpDir, "test.sqlite");

		// Pre-create the schema so MemoryStore's assertSchemaReady passes
		const setupDb = new Database(dbPath);
		setupDb.pragma("journal_mode = WAL");
		initTestSchema(setupDb);
		setupDb.close();

		app = createTestApp(dbPath);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// --- HTML routes ---

	it("GET / returns HTML", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");
		expect(body).toContain("codemem");
		expect(body).toContain("app.js");
	});

	it("GET /some/spa/route returns HTML (SPA fallback)", async () => {
		const res = await app.request("/some/spa/route");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");
	});

	// --- Stats ---

	it("GET /api/stats returns JSON with database key", async () => {
		const res = await app.request("/api/stats");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("database");
		expect(body.database).toHaveProperty("path");
		expect(body.database).toHaveProperty("sessions");
		expect(body.database).toHaveProperty("memory_items");
	});

	// --- Memory routes ---

	it("GET /api/observations returns items array with pagination", async () => {
		const res = await app.request("/api/observations");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("items");
		expect(Array.isArray(body.items)).toBe(true);
		expect(body).toHaveProperty("pagination");
		expect(body.pagination).toHaveProperty("limit");
		expect(body.pagination).toHaveProperty("offset");
		expect(body.pagination).toHaveProperty("has_more");
	});

	it("GET /api/observations with data returns enriched items", async () => {
		// Seed a session + memory
		const db = new Database(dbPath);
		const now = new Date().toISOString();
		db.prepare("INSERT INTO sessions (started_at, cwd, project) VALUES (?, ?, ?)").run(
			now,
			"/tmp/test",
			"/home/user/myproject",
		);
		const sessionId = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
		db.prepare(
			`INSERT INTO memory_items (session_id, kind, title, body_text, active, created_at, updated_at, metadata_json)
			 VALUES (?, 'discovery', 'Test memory', 'body text', 1, ?, ?, '{}')`,
		).run(sessionId.id, now, now);
		db.close();

		const res = await app.request("/api/observations");
		expect(res.status).toBe(200);
		const body = await json(res);
		const items = body.items as unknown[];
		expect(items.length).toBeGreaterThanOrEqual(1);
		expect(items[0]).toHaveProperty("title", "Test memory");
		expect(items[0]).toHaveProperty("project");
		expect(items[0]).toHaveProperty("owned_by_self");
	});

	it("GET /api/memories redirects to /api/observations", async () => {
		const res = await app.request("/api/memories", { redirect: "manual" });
		expect(res.status).toBe(307);
		expect(res.headers.get("location")).toContain("/api/observations");
	});

	it("GET /api/summaries returns paginated items", async () => {
		const res = await app.request("/api/summaries");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("items");
		expect(body).toHaveProperty("pagination");
	});

	it("GET /api/memory returns items array", async () => {
		const res = await app.request("/api/memory");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("items");
	});

	it("GET /api/sessions returns items", async () => {
		const res = await app.request("/api/sessions");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("items");
	});

	it("GET /api/projects returns projects array", async () => {
		const res = await app.request("/api/projects");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("projects");
		expect(Array.isArray(body.projects)).toBe(true);
	});

	it("GET /api/session returns aggregate counts", async () => {
		const res = await app.request("/api/session");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("total");
		expect(body).toHaveProperty("memories");
		expect(body).toHaveProperty("artifacts");
		expect(body).toHaveProperty("prompts");
		expect(body).toHaveProperty("observations");
	});

	it("GET /api/artifacts requires session_id", async () => {
		const res = await app.request("/api/artifacts");
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.error).toBe("session_id required");
	});

	it("GET /api/pack requires context", async () => {
		const res = await app.request("/api/pack");
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.error).toBe("context required");
	});

	// --- Observer status ---

	it("GET /api/observer-status returns stub response", async () => {
		const res = await app.request("/api/observer-status");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("active", null);
		expect(body).toHaveProperty("queue");
	});

	// --- Raw events ---

	it("GET /api/raw-events returns totals", async () => {
		const res = await app.request("/api/raw-events");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("pending");
		expect(body).toHaveProperty("sessions");
	});

	// --- Config (stubbed) ---

	it("GET /api/config returns 501", async () => {
		const res = await app.request("/api/config");
		expect(res.status).toBe(501);
	});

	// --- Sync ---

	it("GET /api/sync/status returns status object", async () => {
		const res = await app.request("/api/sync/status");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("enabled");
		expect(body).toHaveProperty("peers");
		expect(body).toHaveProperty("attempts");
	});

	it("GET /api/sync/peers returns peers list", async () => {
		const res = await app.request("/api/sync/peers");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("items");
		expect(body).toHaveProperty("redacted");
	});

	it("GET /api/sync/actors returns actors list", async () => {
		const res = await app.request("/api/sync/actors");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("items");
	});

	it("GET /api/sync/attempts returns attempts list", async () => {
		const res = await app.request("/api/sync/attempts");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("items");
	});

	// --- 404 ---

	it("GET /api/unknown returns 404", async () => {
		const res = await app.request("/api/unknown");
		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body).toHaveProperty("error", "not found");
	});

	// --- Visibility update ---

	it("POST /api/memories/visibility updates visibility", async () => {
		// Seed data
		const db = new Database(dbPath);
		const now = new Date().toISOString();
		db.prepare("INSERT INTO sessions (started_at, cwd) VALUES (?, ?)").run(now, "/tmp/test");
		const sessionId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
		db.prepare(
			`INSERT INTO memory_items (session_id, kind, title, body_text, active, created_at, updated_at, visibility, metadata_json, rev)
			 VALUES (?, 'discovery', 'Test', 'body', 1, ?, ?, 'shared', '{}', 1)`,
		).run(sessionId, now, now);
		const memoryId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
		db.close();

		const res = await app.request("/api/memories/visibility", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ memory_id: memoryId, visibility: "private" }),
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toHaveProperty("item");
		expect((body.item as Record<string, unknown>).visibility).toBe("private");
	});
});
