/**
 * codemem pi-session-search CLI tests + the 5.1 parity check: for one fixture
 * query, the viewer route body and the CLI --json output are the identical
 * result object. Both run against the same seeded db (real /api/pi-hooks
 * ingest pipeline); the extension tool mapping is identity over this same
 * response object (asserted in pi-extension tools.session-search.test.ts).
 *
 * Harness mirrors viewer-server routes/pi-session-search.test.ts (in-process
 * createApp, no real port — sandbox remaps viewer ports).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type RawEventSweeper } from "@codemem/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Direct source import: the workspace dep resolves to a possibly-stale dist in
// this project (vitest externalizes node_modules deps), and the route under
// parity test must be the committed source. Precedent:
// enqueue-raw-event.test.ts imports across packages relatively.
import { createApp } from "../../../viewer-server/src/index.js";
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

interface PiSessionSearchBody {
	query: string;
	results: Array<{
		source: string;
		session_id: string;
		project: string | null;
		role: string;
		timestamp: string | null;
		snippet: string;
		snippet_truncated: boolean;
		full_length: number;
	}>;
	returned: number;
	total_matches: number;
	truncated: boolean;
}

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

async function runCliJson(args: string[]): Promise<unknown> {
	const logs: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((line) => {
		logs.push(String(line));
	});
	await piSessionSearchCommand.parseAsync(["node", "pi-session-search", ...args], { from: "node" });
	log.mockRestore();
	return JSON.parse(logs.join("\n"));
}

async function seedParityFixture(app: ReturnType<typeof createApp>): Promise<void> {
	await seedPiMessage(app, {
		sessionId: "pi-sess-search-1",
		entryId: "e1",
		role: "user",
		text: "lighthouse retrofit planning notes",
		ts: "2026-04-01T12:00:00.000Z",
	});
	await seedPiMessage(app, {
		sessionId: "pi-sess-search-2",
		entryId: "e2",
		role: "assistant",
		text: "lighthouse retrofit completed",
		ts: "2026-04-02T12:00:00.000Z",
	});
}

describe("codemem pi-session-search", () => {
	it("--json output is identical to the route body for the same fixture query (5.1 parity)", async () => {
		const testApp = createTestApp();
		try {
			await seedParityFixture(testApp.app);

			const routeRes = await testApp.app.request("/api/pi/sessions/search?query=lighthouse", {
				headers: jsonHeaders(),
			});
			expect(routeRes.status).toBe(200);
			const routeBody = (await routeRes.json()) as PiSessionSearchBody;

			const cliBody = (await runCliJson([
				"lighthouse",
				"--json",
				"--db-path",
				testApp.storePath(),
			])) as PiSessionSearchBody;

			expect(cliBody).toEqual(routeBody);
			expect(cliBody.returned).toBe(2);
			expect(cliBody.results.map((match) => match.session_id).toSorted()).toEqual([
				"pi-sess-search-1",
				"pi-sess-search-2",
			]);
			for (const match of cliBody.results) {
				expect(match.source).toBe("pi");
				expect(match.project).toBe("pi-search-proj");
				expect(["user", "assistant"]).toContain(match.role);
				expect(match.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			}
		} finally {
			testApp.cleanup();
		}
	});

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
