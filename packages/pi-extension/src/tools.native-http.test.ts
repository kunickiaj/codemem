import { afterEach, describe, expect, it, vi } from "vitest";
import { PiCodememClient } from "./client.js";
import { defaultPiExtensionConfig } from "./config.js";
import { registerMemoryTools } from "./tools.js";
import {
	buildViewerIdentityTarget,
	createViewerRuntime,
	resolveViewerDbPath,
	viewerRequestTarget,
} from "./viewer.js";

const offlineConfig = { ...defaultPiExtensionConfig(), viewerEnabled: false };
const onlineConfig = defaultPiExtensionConfig({ viewerEnabled: true, viewerAutoStart: false });

type ToolDef = {
	name: string;
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

function jsonOk(body: unknown, status = 200) {
	return {
		ok: true,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

function jsonErr(status: number, body: unknown) {
	return {
		ok: false,
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

/** Old pre-target-aware viewer: serves op routes with 2xx, no profile route. */
function legacyViewerWithoutProfile() {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/raw-events/status") {
			return jsonOk({ ingest: { available: true } });
		}
		if (url.pathname.startsWith("/api/memories/")) {
			return jsonOk({ stale: "viewer", items: [{ id: 1, stale: true }] });
		}
		return jsonErr(404, {});
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("memory_pack uses targeted POST /api/pack, not GET /api/pack", () => {
	it("memory_pack uses targeted POST /api/pack, not GET /api/pack", async () => {
		const cwd = process.cwd();
		const dbPath = resolveViewerDbPath(cwd);
		const identity = buildViewerIdentityTarget(process.env, cwd);
		const calls: Array<{ method: string; path: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				const method = (init?.method ?? "GET").toUpperCase();
				calls.push({ method, path: url.pathname });
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.pathname === "/api/prompt-pack-profile") {
					return jsonOk({
						service: "codemem-viewer",
						protocol_version: 1,
						min_supported_protocol_version: 1,
						db_path: dbPath,
						identity_target: identity,
					});
				}
				if (url.pathname === "/api/pack" && method === "GET") {
					return jsonOk({ pack_text: "from GET", items: ["get"] });
				}
				if (url.pathname === "/api/pack" && method === "POST") {
					return jsonOk({
						pack_text: "from POST",
						items: ["post"],
						metrics: { total_items: 1, pack_tokens: 2 },
					});
				}
				return jsonErr(404, {});
			}),
		);
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});
		const tools = installTools(client);

		const result = await tools.memory_pack.execute(
			"t1",
			{ context: "auth flow", limit: 3 },
			undefined,
		);

		expect(calls.some((call) => call.path === "/api/pack" && call.method === "GET")).toBe(false);
		expect(calls.some((call) => call.path === "/api/pack" && call.method === "POST")).toBe(true);
		expect(JSON.stringify(toolJson(result))).toContain("from POST");
		expect(JSON.stringify(toolJson(result))).not.toContain("from GET");
	});
});

describe("memory_pack falls back to CLI when the viewer proves a different db", () => {
	it("memory_pack falls back to CLI when the viewer proves a different db", async () => {
		const cwd = "/tmp/pi-ext-tool-pack-mismatch";
		vi.stubEnv("CODEMEM_DB", "/tmp/wanted-tool.sqlite");
		const packPosts: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				const method = (init?.method ?? "GET").toUpperCase();
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.pathname === "/api/prompt-pack-profile") {
					return jsonOk({
						service: "codemem-viewer",
						protocol_version: 1,
						min_supported_protocol_version: 1,
						db_path: "/tmp/someone-else.sqlite",
						identity_target: buildViewerIdentityTarget(process.env, cwd),
					});
				}
				if (url.pathname === "/api/pack") {
					packPosts.push(method);
					return jsonOk({ pack_text: "wrong viewer memories" });
				}
				return jsonErr(404, {});
			}),
		);
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async (args) => {
				cliArgs.push([...args]);
				if (args[0] === "pack") {
					return { stdout: JSON.stringify({ pack_text: "local process db" }), stderr: "" };
				}
				return { stdout: "{}", stderr: "" };
			},
		});
		const tools = installTools(client);

		const result = await tools.memory_pack.execute("t1", { context: "continue work" }, undefined);

		expect(packPosts).not.toContain("GET");
		expect(JSON.stringify(toolJson(result))).toContain("local process db");
		expect(JSON.stringify(toolJson(result))).not.toContain("wrong viewer memories");
		expect(cliArgs.some((args) => args[0] === "pack")).toBe(true);
	});
});

describe("every operation re-sends db_path and identity_target as query params", () => {
	it("remember and forget requests carry db_path and identity_target on the query", async () => {
		const cwd = process.cwd();
		const expected = viewerRequestTarget(cwd);
		const seen: Array<{ path: string; dbPath: string | null; identity: string | null }> = [];
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
				if (url.pathname === "/api/memories/remember" || url.pathname === "/api/memories/forget") {
					seen.push({
						path: url.pathname,
						dbPath: url.searchParams.get("db_path"),
						identity: url.searchParams.get("identity_target"),
					});
					return jsonOk(url.pathname.endsWith("remember") ? { id: 7 } : { status: "ok" });
				}
				return jsonErr(404, {});
			}),
		);
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});
		const tools = installTools(client);

		await tools.memory_remember.execute(
			"t1",
			{ kind: "decision", title: "Use targeted writes", body: "Bind HTTP to process DB." },
			undefined,
		);
		await tools.memory_forget.execute("t2", { memory_id: 7 }, undefined);

		expect(seen).toHaveLength(2);
		for (const entry of seen) {
			expect(entry.dbPath).toBe(expected.db_path);
			expect(JSON.parse(entry.identity ?? "null")).toEqual(expected.identity_target);
		}
	});
});

describe("falls back to CLI on 409 for pack/get reads and remember/forget writes", () => {
	it("falls back to CLI on 409 for pack/get reads and remember/forget writes", async () => {
		const cwd = process.cwd();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.pathname === "/api/prompt-pack-profile") {
					return jsonOk({
						service: "codemem-viewer",
						protocol_version: 1,
						min_supported_protocol_version: 1,
						db_path: resolveViewerDbPath(cwd),
						identity_target: buildViewerIdentityTarget(process.env, cwd),
					});
				}
				return jsonErr(409, {
					error: { code: "viewer_db_mismatch", message: "viewer database does not match request" },
				});
			}),
		);
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async (args) => {
				cliArgs.push([...args]);
				if (args[0] === "pack")
					return { stdout: JSON.stringify({ pack_text: "cli pack" }), stderr: "" };
				if (args[0] === "memory" && args[1] === "show") {
					return {
						stdout: JSON.stringify({ id: 3, kind: "decision", title: "shown" }),
						stderr: "",
					};
				}
				if (args[0] === "memory" && args[1] === "remember") {
					return { stdout: JSON.stringify({ id: 9 }), stderr: "" };
				}
				if (args[0] === "memory" && args[1] === "forget") {
					return { stdout: JSON.stringify({ status: "ok" }), stderr: "" };
				}
				return { stdout: "{}", stderr: "" };
			},
		});
		const tools = installTools(client);

		await tools.memory_pack.execute("t1", { context: "q" }, undefined);
		await tools.memory_get.execute("t2", { memory_id: 3 }, undefined);
		await tools.memory_remember.execute(
			"t3",
			{ kind: "decision", title: "t", body: "b" },
			undefined,
		);
		await tools.memory_forget.execute("t4", { memory_id: 3 }, undefined);

		expect(cliArgs.some((args) => args[0] === "pack")).toBe(true);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "show")).toBe(true);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "remember")).toBe(true);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "forget")).toBe(true);
	});
});

describe("does not CLI-replay remember when HTTP commits then the response is lost", () => {
	it("does not CLI-replay remember when HTTP commits then the response is lost", async () => {
		let writes = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.pathname === "/api/prompt-pack-profile") {
					return matchingProfile(process.cwd());
				}
				if (url.pathname === "/api/memories/remember") {
					writes += 1;
					throw Object.assign(new TypeError("fetch failed"), {
						cause: { code: "ECONNRESET" },
					});
				}
				return jsonErr(404, {});
			}),
		);
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliArgs.push([...args]);
				if (args[0] === "memory" && args[1] === "remember") writes += 1;
				return { stdout: JSON.stringify({ id: 2 }), stderr: "" };
			},
		});
		const tools = installTools(client);

		const result = await tools.memory_remember.execute(
			"t1",
			{ kind: "decision", title: "once", body: "do not duplicate" },
			undefined,
		);

		expect(writes).toBe(1);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "remember")).toBe(false);
		expect(result.details.isError).toBe(true);
	});
});

describe("falls back to CLI remember when the connection is refused before send", () => {
	it("falls back to CLI remember when the connection is refused before send", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				throw Object.assign(new TypeError("fetch failed"), {
					cause: { code: "ECONNREFUSED" },
				});
			}),
		);
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliArgs.push([...args]);
				return { stdout: JSON.stringify({ id: 11 }), stderr: "" };
			},
		});
		const tools = installTools(client);

		const result = await tools.memory_remember.execute(
			"t1",
			{ kind: "feature", title: "offline write", body: "viewer down" },
			undefined,
		);

		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "remember")).toBe(true);
		expect(toolJson(result)).toEqual({ id: 11 });
	});
});

describe("falls back to CLI when an older viewer 2xx's while ignoring the target", () => {
	it("falls back to CLI when an older viewer 2xx's while ignoring the target", async () => {
		vi.stubGlobal("fetch", legacyViewerWithoutProfile());
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliArgs.push([...args]);
				if (args[0] === "search") {
					return { stdout: JSON.stringify({ items: [{ id: 5, title: "local" }] }), stderr: "" };
				}
				if (args[0] === "memory" && args[1] === "remember") {
					return { stdout: JSON.stringify({ id: 12 }), stderr: "" };
				}
				return { stdout: "{}", stderr: "" };
			},
		});
		const tools = installTools(client);

		const search = await tools.memory_search.execute("t1", { query: "release steps" }, undefined);
		const remember = await tools.memory_remember.execute(
			"t2",
			{ kind: "decision", title: "t", body: "b" },
			undefined,
		);

		expect(JSON.stringify(toolJson(search))).toContain("local");
		expect(JSON.stringify(toolJson(search))).not.toContain("stale");
		expect(cliArgs.some((args) => args[0] === "search")).toBe(true);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "remember")).toBe(true);
		expect(toolJson(remember)).toEqual({ id: 12 });
	});
});

describe("does zero fetch and uses CLI when viewerEnabled is false", () => {
	it("does zero fetch and uses CLI when viewerEnabled is false", async () => {
		const fetchMock = vi.fn(async () => jsonOk({ id: 1 }));
		vi.stubGlobal("fetch", fetchMock);
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliArgs.push([...args]);
				if (args[0] === "pack") return { stdout: JSON.stringify({ pack_text: "cli" }), stderr: "" };
				if (args[0] === "memory" && args[1] === "remember") {
					return { stdout: JSON.stringify({ id: 4 }), stderr: "" };
				}
				return { stdout: "{}", stderr: "" };
			},
		});
		const tools = installTools(client);

		await tools.memory_pack.execute("t1", { context: "q" }, undefined);
		await tools.memory_remember.execute(
			"t2",
			{ kind: "feature", title: "offline", body: "no http" },
			undefined,
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(cliArgs.some((args) => args[0] === "pack")).toBe(true);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "remember")).toBe(true);
	});
});
