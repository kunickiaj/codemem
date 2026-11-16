/**
 * MCP memory_session_search — the additive MCP surface for the shared Pi
 * session search (layer 2). Fixtures seed REAL ingest envelopes through
 * ingestRawEvents, so the searched rows are the ones live capture stores.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRawEventEnvelopeFromPiEvent,
	connect,
	ingestRawEvents,
	initTestSchema,
	MemoryStore,
	type RawEventSweeper,
} from "@codemem/core";
import { createApp } from "@codemem/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCodememMcpServer } from "./index.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const PROJECT_A = "pi-mcp-alpha";
const PROJECT_B = "pi-mcp-beta";

interface SessionMatch {
	source: string;
	session_id: string;
	project: string | null;
	role: string;
	timestamp: string | null;
	snippet: string;
	snippet_truncated: boolean;
	full_length: number;
}

interface SearchBody {
	query: string;
	query_truncated: boolean;
	results: SessionMatch[];
	returned: number;
	total_matches: number;
	truncated: boolean;
}

interface SeedMessage {
	sessionId: string;
	entryId: string;
	role: "user" | "assistant";
	text: string;
	ts: string;
	project?: string;
}

function seedPiEvent(
	store: MemoryStore,
	envelope: NonNullable<ReturnType<typeof buildRawEventEnvelopeFromPiEvent>>,
): void {
	ingestRawEvents(
		{ db: store.db },
		{
			source: "pi",
			session_stream_id: envelope.session_stream_id,
			session_id: envelope.session_id,
			opencode_session_id: envelope.opencode_session_id,
			cwd: envelope.cwd,
			project: envelope.project,
			events: [
				{
					event_type: envelope.event_type,
					event_id: envelope.event_id,
					payload: envelope.payload,
					ts_wall_ms: envelope.ts_wall_ms,
					cwd: envelope.cwd,
					project: envelope.project,
				},
			],
		},
	);
}

function seedPiMessage(store: MemoryStore, seed: SeedMessage): void {
	const envelope = buildRawEventEnvelopeFromPiEvent({
		piEvent: "message_end",
		sessionId: seed.sessionId,
		entryId: seed.entryId,
		role: seed.role,
		text: seed.text,
		ts: seed.ts,
		...(seed.project ? { project: seed.project } : {}),
	});
	if (!envelope) throw new Error("expected message envelope for fixture");
	seedPiEvent(store, envelope);
}

function seedPiToolCall(store: MemoryStore, sessionId: string, marker: string): void {
	const envelope = buildRawEventEnvelopeFromPiEvent({
		piEvent: "tool_call",
		sessionId,
		toolCallId: `${sessionId}-tool-1`,
		toolName: "read",
		toolInput: { path: `${marker}.txt` },
		ts: "2026-04-01T12:00:05.000Z",
		project: PROJECT_A,
	});
	if (!envelope) throw new Error("expected tool_call envelope for fixture");
	seedPiEvent(store, envelope);
}

interface Harness {
	store: MemoryStore;
	client: Client;
	tempDir: string;
	close: () => Promise<void>;
}

let savedEmbeddingDisabled: string | undefined;

beforeAll(() => {
	savedEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	// The privacy fixture writes one memory; keep it off the model hot path.
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
});

afterAll(() => {
	if (savedEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
	else process.env.CODEMEM_EMBEDDING_DISABLED = savedEmbeddingDisabled;
});

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) await activeHarnesses.pop()?.close();
	delete process.env.CODEMEM_PROJECT;
	vi.restoreAllMocks();
});

async function createHarness(
	options: { defaultProject?: string | null; lazyDefault?: boolean } = {},
): Promise<Harness> {
	const tempDir = mkdtempSync(join(tmpdir(), "codemem-mcp-pi-session-search-"));
	const dbPath = join(tempDir, "memory.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run("test-device-001", "test-public-key", "test-fingerprint", new Date().toISOString());
	db.close();
	const store = new MemoryStore(dbPath);
	const server = createCodememMcpServer(store, {
		...(options.lazyDefault
			? {}
			: {
					envProject: null,
					defaultProject: options.defaultProject === undefined ? PROJECT_A : options.defaultProject,
				}),
		captureRetrievalLedger: false,
	});
	const client = new Client({ name: "pi-session-search-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	const harness: Harness = {
		store,
		client,
		tempDir,
		close: async () => {
			await client.close();
			await server.close();
			store.close();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
	activeHarnesses.push(harness);
	return harness;
}

function textOf(result: ToolResult): string {
	if (!("content" in result) || !Array.isArray(result.content)) {
		throw new Error("tool returned a task result");
	}
	const first = result.content[0] as { type?: unknown; text?: unknown } | undefined;
	if (first?.type !== "text" || typeof first.text !== "string") {
		throw new Error("tool returned no text content");
	}
	return first.text;
}

function successBody(result: ToolResult): SearchBody {
	if (!("structuredContent" in result) || !result.structuredContent) {
		throw new Error("successful session search omitted structuredContent");
	}
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toEqual(JSON.parse(textOf(result)));
	return result.structuredContent as unknown as SearchBody;
}

async function sessionSearch(
	harness: Harness,
	args: Record<string, unknown> = {},
): Promise<SearchBody> {
	return successBody(
		await harness.client.callTool({ name: "memory_session_search", arguments: args }),
	);
}

function createRestApp(store: MemoryStore): {
	app: ReturnType<typeof createApp>;
	cleanup: () => void;
} {
	const staticDir = mkdtempSync(join(tmpdir(), "codemem-mcp-pi-session-search-static-"));
	writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
	const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
	process.env.CODEMEM_VIEWER_STATIC_DIR = staticDir;
	const app = createApp({
		storeFactory: () => store,
		sweeper: null as unknown as RawEventSweeper,
	});
	return {
		app,
		cleanup: () => {
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(staticDir, { recursive: true, force: true });
		},
	};
}

describe("memory_session_search registration", () => {
	it("is the 15th registered tool alongside the existing memory surface", async () => {
		// Arrange
		const harness = await createHarness();

		// Act
		const tools = (await harness.client.listTools()).tools;

		// Assert
		expect(tools).toHaveLength(15);
		expect(tools.map((tool) => tool.name)).toContain("memory_session_search");
	});
});

describe("memory_session_search raw transcript results", () => {
	it("returns raw user and assistant text with attribution and counts", async () => {
		// Arrange
		const harness = await createHarness();
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-a1",
			entryId: "e1",
			role: "user",
			text: "lighthouse retrofit planning notes",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-a2",
			entryId: "e2",
			role: "assistant",
			text: "lighthouse retrofit completed",
			ts: "2026-04-02T12:00:00.000Z",
			project: PROJECT_A,
		});

		// Act
		const body = await sessionSearch(harness, { query: "lighthouse" });

		// Assert: newest first, raw-text attribution, explicit counts.
		expect(body).toMatchObject({
			query: "lighthouse",
			query_truncated: false,
			returned: 2,
			total_matches: 2,
			truncated: false,
		});
		expect(body.results.map((match) => match.session_id)).toEqual(["pi-sess-a2", "pi-sess-a1"]);
		expect(body.results[0]).toEqual({
			source: "pi",
			session_id: "pi-sess-a2",
			project: PROJECT_A,
			role: "assistant",
			timestamp: "2026-04-02T12:00:00.000Z",
			snippet: "lighthouse retrofit completed",
			snippet_truncated: false,
			full_length: "lighthouse retrofit completed".length,
		});
		expect(body.results[1]).toMatchObject({
			role: "user",
			snippet: "lighthouse retrofit planning notes",
		});
	});

	it("ignores project metadata, tool payloads, and extracted memories", async () => {
		// Arrange: the marker lives in each non-transcript location, never in message text.
		const harness = await createHarness();
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-privacy",
			entryId: "e1",
			role: "user",
			text: "hello there",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		seedPiToolCall(harness.store, "pi-sess-privacy", "toolneedlemarker");
		const remembered = await harness.client.callTool({
			name: "memory_remember",
			arguments: {
				kind: "discovery",
				title: "xylophonesentinel lesson",
				body: "xylophonesentinel body text",
				project: PROJECT_A,
			},
		});
		expect(remembered.isError).not.toBe(true);

		// Act
		const payloadHit = await sessionSearch(harness, { query: "toolneedlemarker" });
		const memoryHit = await sessionSearch(harness, { query: "xylophonesentinel" });
		const projectHit = await sessionSearch(harness, { query: PROJECT_A });

		// Assert: raw-transcript-only privacy, not memory visibility filtering.
		for (const body of [payloadHit, memoryHit, projectHit]) {
			expect(body.results).toEqual([]);
			expect(body.returned).toBe(0);
			expect(body.total_matches).toBe(0);
		}
	});
});

describe("memory_session_search project and session scope", () => {
	it("honors an explicit project and narrows session_id within it", async () => {
		// Arrange: two sessions in the default project, one in another project.
		const harness = await createHarness();
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-a1",
			entryId: "e1",
			role: "user",
			text: "quayside notes one",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-a2",
			entryId: "e2",
			role: "user",
			text: "quayside notes two",
			ts: "2026-04-02T12:00:00.000Z",
			project: PROJECT_A,
		});
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-b1",
			entryId: "e3",
			role: "user",
			text: "quayside notes three",
			ts: "2026-04-03T12:00:00.000Z",
			project: PROJECT_B,
		});

		// Act
		const defaultScope = await sessionSearch(harness, { query: "quayside" });
		const otherProject = await sessionSearch(harness, { query: "quayside", project: PROJECT_B });
		const narrowed = await sessionSearch(harness, {
			query: "quayside",
			session_id: "pi-sess-a2",
		});
		const crossProject = await sessionSearch(harness, {
			query: "quayside",
			project: PROJECT_B,
			session_id: "pi-sess-a1",
		});

		// Assert
		expect(defaultScope.results.map((match) => match.session_id)).toEqual([
			"pi-sess-a2",
			"pi-sess-a1",
		]);
		expect(otherProject.results.map((match) => match.session_id)).toEqual(["pi-sess-b1"]);
		expect(narrowed.results.map((match) => match.session_id)).toEqual(["pi-sess-a2"]);
		expect(crossProject.results).toEqual([]);
	});

	it("resolves an omitted project lazily from CODEMEM_PROJECT and the server cwd", async () => {
		// Arrange: lazy default resolution is the behavior other MCP tools already have.
		const harness = await createHarness({ lazyDefault: true });
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-a1",
			entryId: "e1",
			role: "user",
			text: "quayside alpha note",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-b1",
			entryId: "e2",
			role: "user",
			text: "quayside beta note",
			ts: "2026-04-02T12:00:00.000Z",
			project: PROJECT_B,
		});

		// Act
		process.env.CODEMEM_PROJECT = PROJECT_B;
		const fromEnv = await sessionSearch(harness, { query: "quayside" });
		delete process.env.CODEMEM_PROJECT;
		vi.spyOn(process, "cwd").mockReturnValue(join(harness.tempDir, PROJECT_A));
		const fromCwd = await sessionSearch(harness, { query: "quayside" });

		// Assert
		expect(fromEnv.results.map((match) => match.session_id)).toEqual(["pi-sess-b1"]);
		expect(fromCwd.results.map((match) => match.session_id)).toEqual(["pi-sess-a1"]);
	});
});

describe("memory_session_search bounds and truncation", () => {
	it("caps query input at 8,192 characters and 64 effective tokens", async () => {
		// Arrange
		const harness = await createHarness();
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-bounds",
			entryId: "e1",
			role: "user",
			text: "lighthousekeep retained",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		const sixtyFiveTerms = Array.from({ length: 64 }, (_, index) => `term${index}`)
			.concat("lighthousekeep")
			.join(" ");

		// Act
		const longQuery = await sessionSearch(harness, {
			query: `${"a".repeat(8192)}lighthousekeep`,
		});
		const manyTerms = await sessionSearch(harness, { query: sixtyFiveTerms });

		// Assert: excess input is ignored and marked, never an error.
		expect(longQuery).toMatchObject({ query_truncated: true, returned: 0, truncated: true });
		expect(manyTerms).toMatchObject({ query_truncated: true, returned: 0, truncated: true });
	});

	it("applies limit and snippet caps with explicit truncation counts", async () => {
		// Arrange
		const harness = await createHarness();
		const longText = `lighthouse ${"detail ".repeat(60).trimEnd()}`;
		for (const [index, sessionId] of ["pi-sess-1", "pi-sess-2", "pi-sess-3"].entries()) {
			seedPiMessage(harness.store, {
				sessionId,
				entryId: `e${index}`,
				role: "user",
				text: longText,
				ts: `2026-04-0${index + 1}T12:00:00.000Z`,
				project: PROJECT_A,
			});
		}

		// Act
		const body = await sessionSearch(harness, {
			query: "lighthouse",
			limit: 1,
			snippet_chars: 100,
		});

		// Assert
		expect(body.returned).toBe(1);
		expect(body.total_matches).toBe(3);
		expect(body.truncated).toBe(true);
		expect(body.results[0]?.snippet.length).toBeLessThanOrEqual(100);
		expect(body.results[0]?.snippet_truncated).toBe(true);
		expect(body.results[0]?.full_length).toBe(longText.length);
	});
});

describe("memory_session_search errors and empty envelopes", () => {
	it("rejects out-of-schema values and blank queries", async () => {
		// Arrange
		const harness = await createHarness();

		// Act
		const zeroLimit = await harness.client.callTool({
			name: "memory_session_search",
			arguments: { query: "x", limit: 0 },
		});
		const largeSnippet = await harness.client.callTool({
			name: "memory_session_search",
			arguments: { query: "x", snippet_chars: 4001 },
		});
		const blank = await harness.client.callTool({
			name: "memory_session_search",
			arguments: { query: "   " },
		});

		// Assert
		expect(zeroLimit.isError).toBe(true);
		expect(largeSnippet.isError).toBe(true);
		expect(blank.isError).toBe(true);
		expect(textOf(blank)).toBe(JSON.stringify({ error: "query required" }));
		expect("structuredContent" in blank ? blank.structuredContent : undefined).toBeUndefined();
	});

	it("returns an explicit empty success envelope when nothing matches", async () => {
		// Arrange
		const harness = await createHarness();

		// Act
		const body = await sessionSearch(harness, { query: "absentterm" });

		// Assert
		expect(body).toEqual({
			query: "absentterm",
			query_truncated: false,
			results: [],
			returned: 0,
			total_matches: 0,
			truncated: false,
		});
	});
});

describe("memory_session_search cross-surface parity", () => {
	it("returns the same body as the viewer REST route for the same stored events", async () => {
		// Arrange
		const harness = await createHarness();
		seedPiMessage(harness.store, {
			sessionId: "pi-sess-rest-1",
			entryId: "e1",
			role: "user",
			text: "lighthouse retrofit planning notes",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		const rest = createRestApp(harness.store);

		try {
			// Act
			const mcpBody = await sessionSearch(harness, {
				query: "lighthouse",
				project: PROJECT_A,
				limit: 5,
				snippet_chars: 300,
			});
			const routeRes = await rest.app.request(
				`/api/pi/sessions/search?${new URLSearchParams({
					query: "lighthouse",
					project: PROJECT_A,
					limit: "5",
					snippet_chars: "300",
				})}`,
			);

			// Assert: the CLI suite pins CLI JSON to this same route body.
			expect(routeRes.status).toBe(200);
			expect(await routeRes.json()).toEqual(mcpBody);
		} finally {
			rest.cleanup();
		}
	});
});
