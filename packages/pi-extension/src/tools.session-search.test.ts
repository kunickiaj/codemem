/**
 * memory_session_search tool tests (design D5/D6): native-mode registration +
 * result rendering, viewer-unreachable CLI fallback returning the same result
 * shape, and adapter-mode absence (single-surface guarantee).
 *
 * Harness mirrors tools.native-http.test.ts: fetch stubs + execImpl fake, no
 * real server, no real CLI spawn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiCodememClient } from "./client.js";
import { defaultPiExtensionConfig } from "./config.js";
import codememPiExtension from "./index.js";
import { registerMemoryTools } from "./tools.js";
import { buildViewerIdentityTarget, createViewerRuntime, resolveViewerDbPath } from "./viewer.js";

const offlineConfig = { ...defaultPiExtensionConfig(), viewerEnabled: false };
const onlineConfig = defaultPiExtensionConfig({ viewerEnabled: true, viewerAutoStart: false });

type ToolDef = {
	name: string;
	description?: string;
	parameters: { properties?: Record<string, unknown> };
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	}>;
};

/** Shared contract fixture: the exact response shape core/route/CLI return. */
const FIXTURE_RESPONSE = {
	query: "lighthouse",
	results: [
		{
			source: "pi",
			session_id: "pi-sess-search-2",
			project: "pi-search-proj",
			role: "assistant",
			timestamp: "2026-04-02T12:00:00.000Z",
			snippet: "lighthouse retrofit completed",
			snippet_truncated: false,
			full_length: 29,
		},
		{
			source: "pi",
			session_id: "pi-sess-search-1",
			project: "pi-search-proj",
			role: "user",
			timestamp: "2026-04-01T12:00:00.000Z",
			snippet: "lighthouse retrofit planning notes",
			snippet_truncated: false,
			full_length: 34,
		},
	],
	returned: 2,
	total_matches: 2,
	truncated: false,
};

function jsonOk(body: unknown, status = 200) {
	return {
		ok: true,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

function installTools(client: PiCodememClient): Record<string, ToolDef> {
	const defs: ToolDef[] = [];
	registerMemoryTools({ registerTool: (def: ToolDef) => defs.push(def) } as never, client);
	return Object.fromEntries(defs.map((def) => [def.name, def]));
}

function toolJson(result: { content: Array<{ text: string }>; details: Record<string, unknown> }) {
	if (typeof result.details.value !== "undefined") return result.details.value;
	try {
		return JSON.parse(result.content[0]?.text ?? "null");
	} catch {
		return result.content[0]?.text;
	}
}

function matchingProfile(cwd: string) {
	return jsonOk({
		service: "codemem-viewer",
		protocol_version: 1,
		min_supported_protocol_version: 1,
		db_path: resolveViewerDbPath(cwd),
		identity_target: buildViewerIdentityTarget(process.env, cwd),
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("memory_session_search registration", () => {
	it("registers in native mode and is listed by expectedToolNames", () => {
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async () => ({ stdout: "{}", stderr: "" }),
		});
		const tools = installTools(client);
		expect(tools.memory_session_search).toBeDefined();
		const properties = tools.memory_session_search.parameters.properties ?? {};
		expect(Object.keys(properties).toSorted()).toEqual([
			"limit",
			"project",
			"query",
			"session_id",
			"snippet_chars",
		]);
		// D6: bounded output via description only — no promptSnippet/promptGuidelines.
		expect(Object.hasOwn(tools.memory_session_search, "promptSnippet")).toBe(false);
		expect(Object.hasOwn(tools.memory_session_search, "promptGuidelines")).toBe(false);
		expect(tools.memory_session_search.description).toContain("pi-import-sessions");
	});
});

describe("memory_session_search HTTP path", () => {
	it("renders the route response and forwards query params", async () => {
		const cwd = process.cwd();
		const seenQuery: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.pathname === "/api/prompt-pack-profile") {
					return matchingProfile(cwd);
				}
				if (url.pathname === "/api/pi/sessions/search") {
					seenQuery.push(url);
					return jsonOk(FIXTURE_RESPONSE);
				}
				return jsonOk({});
			}),
		);
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});
		const tools = installTools(client);

		const result = await tools.memory_session_search.execute(
			"t1",
			{
				query: "lighthouse",
				project: "pi-search-proj",
				session_id: "pi-sess-1",
				limit: 3,
				snippet_chars: 500,
			},
			undefined,
		);

		expect(toolJson(result)).toEqual(FIXTURE_RESPONSE);
		expect(seenQuery).toHaveLength(1);
		const params = seenQuery[0].searchParams;
		expect(params.get("query")).toBe("lighthouse");
		expect(params.get("project")).toBe("pi-search-proj");
		expect(params.get("session_id")).toBe("pi-sess-1");
		expect(params.get("limit")).toBe("3");
		expect(params.get("snippet_chars")).toBe("500");
	});

	it("renders an explicit empty result without error", async () => {
		const cwd = process.cwd();
		const empty = {
			query: "xenoglossia",
			results: [],
			returned: 0,
			total_matches: 0,
			truncated: false,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/raw-events/status")
					return jsonOk({ ingest: { available: true } });
				if (url.pathname === "/api/prompt-pack-profile") return matchingProfile(cwd);
				if (url.pathname === "/api/pi/sessions/search") return jsonOk(empty);
				return jsonOk({});
			}),
		);
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});
		const result = await installTools(client).memory_session_search.execute(
			"t1",
			{ query: "xenoglossia" },
			undefined,
		);
		expect(toolJson(result)).toEqual(empty);
		expect(result.details.isError).toBeUndefined();
	});
});

describe("memory_session_search viewer-unreachable fallback", () => {
	it("falls back to CLI and returns the same result shape", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
			}),
		);
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliArgs.push([...args]);
				return { stdout: JSON.stringify(FIXTURE_RESPONSE), stderr: "" };
			},
		});
		const tools = installTools(client);

		const result = await tools.memory_session_search.execute(
			"t1",
			{
				query: "lighthouse",
				project: "pi-search-proj",
				session_id: "pi-sess-1",
				limit: 3,
				snippet_chars: 500,
			},
			undefined,
		);

		expect(toolJson(result)).toEqual(FIXTURE_RESPONSE);
		expect(cliArgs).toHaveLength(1);
		expect(cliArgs[0][0]).toBe("pi-session-search");
		expect(cliArgs[0]).toContain("--json");
		expect(cliArgs[0]).toContain("lighthouse");
		expect(cliArgs[0]).toContain("--project");
		expect(cliArgs[0]).toContain("pi-search-proj");
		expect(cliArgs[0]).toContain("--session-id");
		expect(cliArgs[0]).toContain("pi-sess-1");
		expect(cliArgs[0]).toContain("--limit");
		expect(cliArgs[0]).toContain("3");
		expect(cliArgs[0]).toContain("--snippet-chars");
		expect(cliArgs[0]).toContain("500");
	});
});

describe("memory_session_search adapter mode", () => {
	it("registers no native session-search tool when tools_mode is mcp-adapter", () => {
		vi.stubEnv("CODEMEM_PI_TOOLS_MODE", "mcp-adapter");
		const tools: Array<{ name: string }> = [];
		const pi = {
			on: () => {},
			registerTool: (def: { name: string }) => tools.push(def),
			appendEntry: () => {},
		};
		// Factory-level check: adapter mode is gated in index.ts, before
		// registerMemoryTools runs (single-surface guarantee).
		codememPiExtension(pi as never);
		expect(tools.some((tool) => tool.name === "memory_session_search")).toBe(false);
	});
});
