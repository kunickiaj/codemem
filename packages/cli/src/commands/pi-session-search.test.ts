/**
 * CLI session search against the real Pi ingest pipeline and shared core response.
 * Viewer-route/native-tool parity follows in the final stack layer.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type RawEventSweeper } from "@codemem/core";
import { createApp } from "@codemem/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	formatPiSessionSearchHuman,
	piSessionSearchCommand,
	runPiSessionSearch,
} from "./pi-session-search.js";

let savedEmbeddingDisabled: string | undefined;
let savedProjectEnv: string | undefined;
beforeAll(() => {
	// Hermetic: no embedding model downloads on the ingest hot path. Save/restore
	// so sibling suites in a shared worker are unaffected.
	savedEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	// Keep seeded events' explicit project attribution (resolveHookProject
	// prefers CODEMEM_PROJECT over payload labels).
	savedProjectEnv = process.env.CODEMEM_PROJECT;
	delete process.env.CODEMEM_PROJECT;
});
afterAll(() => {
	if (savedEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
	else process.env.CODEMEM_EMBEDDING_DISABLED = savedEmbeddingDisabled;
	if (savedProjectEnv === undefined) delete process.env.CODEMEM_PROJECT;
	else process.env.CODEMEM_PROJECT = savedProjectEnv;
});
afterEach(() => {
	process.exitCode = undefined;
	vi.restoreAllMocks();
});

function createTestApp() {
	let store: MemoryStore | null = null;
	let storeCleanup: (() => void) | null = null;
	const staticDir = mkdtempSync(join(tmpdir(), "codemem-pi-session-search-cli-static-"));
	writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
	const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
	process.env.CODEMEM_VIEWER_STATIC_DIR = staticDir;
	const storeFactory = () => {
		if (!store) {
			const tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-session-search-cli-"));
			const dbPath = join(tmpDir, "test.sqlite");
			const rawDb = new MemoryStore(dbPath);
			// hasCurrentIdentity needs a paired device row (route test pattern).
			rawDb.db
				.prepare(
					"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
				)
				.run("test-device-001", "test-public-key", "test-fingerprint", new Date().toISOString());
			rawDb.close();
			const created = new MemoryStore(dbPath);
			store = created;
			storeCleanup = () => {
				created.close();
				rmSync(tmpDir, { recursive: true, force: true });
			};
		}
		return store;
	};
	const app = createApp({
		storeFactory,
		sweeper: null as unknown as RawEventSweeper,
	});
	return {
		app,
		storePath: () => storeFactory().dbPath,
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
	return { "Content-Type": "application/json", Origin: "http://127.0.0.1:38888" };
}

async function seedPiMessage(
	app: ReturnType<typeof createApp>,
	seed: {
		sessionId: string;
		entryId: string;
		role: "user" | "assistant";
		text: string;
		ts: string;
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
			project: "pi-search-proj",
		}),
	});
	expect(res.status).toBe(200);
}

describe("codemem pi-session-search", () => {
	it("forwards --project/--session-id/--limit/--snippet-chars like the tool mapping", async () => {
		const testApp = createTestApp();
		try {
			await seedPiMessage(testApp.app, {
				sessionId: "pi-sess-filter-1",
				entryId: "e1",
				role: "user",
				text: "lighthouse retrofit planning notes",
				ts: "2026-04-01T12:00:00.000Z",
			});
			const response = runPiSessionSearch("lighthouse", {
				project: "pi-search-proj",
				sessionId: "pi-sess-filter-1",
				limit: "5",
				snippetChars: "300",
				dbPath: testApp.storePath(),
			});
			expect(response.returned).toBe(1);
			expect(response.results[0]?.session_id).toBe("pi-sess-filter-1");

			const otherSession = runPiSessionSearch("lighthouse", {
				sessionId: "pi-sess-other",
				dbPath: testApp.storePath(),
			});
			expect(otherSession.results).toEqual([]);
			expect(otherSession.returned).toBe(0);
		} finally {
			testApp.cleanup();
		}
	});

	it("human format: Found N header, attributed result lines, truncation marker", () => {
		const human = formatPiSessionSearchHuman({
			query: "lighthouse",
			query_truncated: false,
			results: [
				{
					source: "pi",
					session_id: "pi-sess-1",
					project: "proj-a",
					role: "user",
					timestamp: "2026-04-01T12:00:00.000Z",
					snippet: "lighthouse retrofit notes",
					snippet_truncated: true,
					full_length: 500,
				},
			],
			returned: 1,
			total_matches: 4,
			truncated: true,
		});
		expect(human).toContain('Found 1 results for "lighthouse"');
		expect(human).toContain("user · proj-a · session pi-sess-1 · 2026-04-01T12:00:00.000Z");
		expect(human).toContain("lighthouse retrofit notes…");
		expect(human).toContain("Showing 1 of 4 matches.");
	});

	it("human format: empty result states no matches and the import hint", () => {
		const human = formatPiSessionSearchHuman({
			query: "xenoglossia",
			query_truncated: false,
			results: [],
			returned: 0,
			total_matches: 0,
			truncated: false,
		});
		expect(human).toContain('No results found for "xenoglossia"');
		expect(human).toContain("codemem pi-import-sessions");
	});

	it("blank query fails like the route (json: structured error, exit code)", async () => {
		process.exitCode = undefined;
		const logs: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((line) => {
			logs.push(String(line));
		});
		await piSessionSearchCommand.parseAsync(
			["node", "pi-session-search", "   ", "--json", "--db-path", join(tmpdir(), "unused.sqlite")],
			{ from: "node" },
		);
		log.mockRestore();
		expect(JSON.parse(logs.join("\n"))).toEqual({
			error: "pi_session_search_failed",
			message: "query required",
		});
		expect(process.exitCode).toBe(1);
	});
});

describe("codemem pi-session-search JSON contract", () => {
	it("preserves the matching-query truncation flag in CLI JSON", async () => {
		const testApp = createTestApp();
		try {
			await seedPiMessage(testApp.app, {
				sessionId: "pi-sess-query-cap",
				entryId: "e1",
				role: "user",
				text: "lighthouse retrofit notes",
				ts: "2026-04-01T12:00:00.000Z",
			});
			const query = `${Array.from({ length: 64 }, (_, i) => `querytoken${i}`).join(" ")} lighthouse`;
			const dbPath = testApp.storePath();
			const output: string[] = [];
			vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
			await piSessionSearchCommand.parseAsync(
				["node", "pi-session-search", query, "--json", "--db-path", dbPath],
				{ from: "node" },
			);
			const response = JSON.parse(output.join("\n"));
			expect(response).toMatchObject({
				query,
				query_truncated: true,
				results: [],
				returned: 0,
				total_matches: 0,
				truncated: true,
			});
			expect(process.exitCode).toBeUndefined();
		} finally {
			testApp.cleanup();
		}
	});
});

describe("Pi session search partial-query warnings", () => {
	it("warns on an empty partial-query result instead of suggesting backfill", () => {
		const human = formatPiSessionSearchHuman({
			query: "bounded query",
			query_truncated: true,
			results: [],
			returned: 0,
			total_matches: 0,
			truncated: true,
		});
		expect(human).toContain("No results found");
		expect(human).toContain("only part of the query");
		expect(human).toContain("8,192 characters");
		expect(human).toContain("64 search terms");
		expect(human).not.toContain("codemem pi-import-sessions");
	});

	it("warns about partial matching while retaining nonempty results", () => {
		const human = formatPiSessionSearchHuman({
			query: "bounded query",
			query_truncated: true,
			results: [
				{
					source: "pi",
					session_id: "partial-query-session",
					project: null,
					role: "assistant",
					timestamp: null,
					snippet: "bounded query match",
					snippet_truncated: false,
					full_length: 19,
				},
			],
			returned: 1,
			total_matches: 1,
			truncated: true,
		});
		expect(human).toContain("Found 1 results");
		expect(human).toContain("only part of the query");
		expect(human).toContain("bounded query match");
	});
});
