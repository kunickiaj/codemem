/**
 * Route tests for GET /api/pi/sessions/search — the REST twin of the core
 * searchPiSessions contract (design D5/D6). Seeding goes through the real
 * POST /api/pi-hooks pipeline so the searched rows are what live ingest and
 * pi-sessions-import store.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, MemoryStore, type RawEventSweeper } from "@codemem/core";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../index.js";

// Keep route tests hermetic: no embedding model downloads on the hot path.
// Save/restore so sibling suites in a shared worker are unaffected.
let savedEmbeddingDisabled: string | undefined;
let savedProjectEnv: string | undefined;
beforeAll(() => {
	savedEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	// resolveHookProject prefers CODEMEM_PROJECT over payload labels; pin it
	// off so seeded events keep their explicit project attribution.
	savedProjectEnv = process.env.CODEMEM_PROJECT;
	delete process.env.CODEMEM_PROJECT;
});
afterAll(() => {
	if (savedEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
	else process.env.CODEMEM_EMBEDDING_DISABLED = savedEmbeddingDisabled;
	if (savedProjectEnv === undefined) delete process.env.CODEMEM_PROJECT;
	else process.env.CODEMEM_PROJECT = savedProjectEnv;
});

function createTestStore(): { store: MemoryStore; cleanup: () => void } {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-session-search-route-"));
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

function createTestApp() {
	let store: MemoryStore | null = null;
	let storeCleanup: (() => void) | null = null;
	const staticDir = mkdtempSync(join(tmpdir(), "codemem-pi-session-search-static-"));
	writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
	const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
	process.env.CODEMEM_VIEWER_STATIC_DIR = staticDir;
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
		sweeper: null as unknown as RawEventSweeper,
	});
	return {
		app,
		cleanup: () => {
			storeCleanup?.();
			store = null;
			storeCleanup = null;
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(staticDir, { recursive: true, force: true });
		},
	};
}

function jsonHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Origin: "http://127.0.0.1:38888",
	};
}

interface PiSessionSearchMatchBody {
	source: string;
	session_id: string;
	project: string | null;
	role: string;
	timestamp: string | null;
	snippet: string;
	snippet_truncated: boolean;
	full_length: number;
}

interface PiSessionSearchBody {
	query: string;
	results: PiSessionSearchMatchBody[];
	returned: number;
	total_matches: number;
	truncated: boolean;
}

async function seedPiMessage(
	app: ReturnType<typeof createApp>,
	seed: {
		sessionId: string;
		entryId: string;
		role: "user" | "assistant";
		text: string;
		ts: string;
		project?: string;
	},
): Promise<void> {
	const res = await app.request("/api/pi-hooks", {
		method: "POST",
		headers: jsonHeaders(),
		body: JSON.stringify({
			piEvent: "message_end",
			sessionId: seed.sessionId,
			entryId: seed.entryId,
			role: seed.role,
			text: seed.text,
			ts: seed.ts,
			...(seed.project ? { project: seed.project } : {}),
		}),
	});
	expect(res.status).toBe(200);
}

describe("GET /api/pi/sessions/search", () => {
	it("returns matches most-recent-first with attribution fields", async () => {
		const { app, cleanup } = createTestApp();
		try {
			await seedPiMessage(app, {
				sessionId: "pi-sess-search-1",
				entryId: "e1",
				role: "user",
				text: "lighthouse retrofit planning notes",
				ts: "2026-04-01T12:00:00.000Z",
				project: "pi-search-proj",
			});
			await seedPiMessage(app, {
				sessionId: "pi-sess-search-2",
				entryId: "e2",
				role: "assistant",
				text: "lighthouse retrofit completed",
				ts: "2026-04-02T12:00:00.000Z",
				project: "pi-search-proj",
			});

			const res = await app.request("/api/pi/sessions/search?query=lighthouse", {
				headers: jsonHeaders(),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as PiSessionSearchBody;
			expect(body.returned).toBe(2);
			expect(body.total_matches).toBe(2);
			expect(body.truncated).toBe(false);
			// most-recent-first
			expect(body.results.map((r) => r.session_id)).toEqual([
				"pi-sess-search-2",
				"pi-sess-search-1",
			]);
			// attribution fields present on every result
			for (const match of body.results) {
				expect(match.source).toBe("pi");
				expect(match.session_id).toMatch(/^pi-sess-search-/);
				expect(match.project).toBe("pi-search-proj");
				expect(["user", "assistant"]).toContain(match.role);
				expect(match.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			}
			expect(body.results[1]?.role).toBe("user");
			expect(body.results[0]?.role).toBe("assistant");
		} finally {
			cleanup();
		}
	});

	it("returns an explicit empty result (not an error) for no matches", async () => {
		const { app, cleanup } = createTestApp();
		try {
			await seedPiMessage(app, {
				sessionId: "pi-sess-empty",
				entryId: "e1",
				role: "user",
				text: "nothing to see here",
				ts: "2026-04-01T12:00:00.000Z",
			});
			const res = await app.request("/api/pi/sessions/search?query=xenoglossia", {
				headers: jsonHeaders(),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as PiSessionSearchBody;
			expect(body.results).toEqual([]);
			expect(body.returned).toBe(0);
			expect(body.total_matches).toBe(0);
			expect(body.truncated).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("GET /api/pi/sessions/search truncation", () => {
	it("marks snippet and count truncation", async () => {
		const { app, cleanup } = createTestApp();
		try {
			await seedPiMessage(app, {
				sessionId: "pi-sess-trunc",
				entryId: "e1",
				role: "user",
				text: `truncmarker ${"x".repeat(5000)}`,
				ts: "2026-04-01T12:00:00.000Z",
			});
			const res = await app.request("/api/pi/sessions/search?query=truncmarker&snippet_chars=200", {
				headers: jsonHeaders(),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as PiSessionSearchBody;
			expect(body.results[0]?.snippet.length).toBe(200);
			expect(body.results[0]?.snippet_truncated).toBe(true);
			expect(body.results[0]?.full_length).toBeGreaterThan(200);
		} finally {
			cleanup();
		}
	});

	it("sets the truncation marker when matches exceed the limit", async () => {
		const { app, cleanup } = createTestApp();
		try {
			for (let i = 0; i < 3; i++) {
				await seedPiMessage(app, {
					sessionId: "pi-sess-limit",
					entryId: `e${i}`,
					role: "user",
					text: `limitprobe event ${i}`,
					ts: new Date(Date.UTC(2026, 3, 1, 12, 0, i)).toISOString(),
				});
			}
			const res = await app.request("/api/pi/sessions/search?query=limitprobe&limit=2", {
				headers: jsonHeaders(),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as PiSessionSearchBody;
			expect(body.returned).toBe(2);
			expect(body.total_matches).toBe(3);
			expect(body.truncated).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("GET /api/pi/sessions/search params", () => {
	it("filters by project and session_id query params", async () => {
		const { app, cleanup } = createTestApp();
		try {
			await seedPiMessage(app, {
				sessionId: "pi-sess-fa",
				entryId: "e1",
				role: "user",
				text: "quayside shared probe",
				ts: "2026-04-01T12:00:00.000Z",
				project: "pi-search-alpha",
			});
			await seedPiMessage(app, {
				sessionId: "pi-sess-fb",
				entryId: "e2",
				role: "user",
				text: "quayside shared probe",
				ts: "2026-04-01T12:00:01.000Z",
				project: "pi-search-beta",
			});

			const byProject = await app.request(
				"/api/pi/sessions/search?query=quayside&project=pi-search-alpha",
				{ headers: jsonHeaders() },
			);
			const projectBody = (await byProject.json()) as PiSessionSearchBody;
			expect(projectBody.returned).toBe(1);
			expect(projectBody.results[0]?.session_id).toBe("pi-sess-fa");

			const bySession = await app.request(
				"/api/pi/sessions/search?query=quayside&session_id=pi-sess-fb",
				{ headers: jsonHeaders() },
			);
			const sessionBody = (await bySession.json()) as PiSessionSearchBody;
			expect(sessionBody.returned).toBe(1);
			expect(sessionBody.results[0]?.session_id).toBe("pi-sess-fb");
		} finally {
			cleanup();
		}
	});

	it("rejects a blank query with 400 like search_index", async () => {
		const { app, cleanup } = createTestApp();
		try {
			const res = await app.request("/api/pi/sessions/search?query=%20%20", {
				headers: jsonHeaders(),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toMatch(/query required/);
		} finally {
			cleanup();
		}
	});
});
