import { afterEach, describe, expect, it, vi } from "vitest";
import { PiCodememClient } from "./client.js";
import { defaultPiExtensionConfig } from "./config.js";
import { registerMemoryTools } from "./tools.js";
import { buildViewerIdentityTarget, createViewerRuntime, resolveViewerDbPath } from "./viewer.js";

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

function matchingProfile(cwd: string) {
	return jsonOk({
		service: "codemem-viewer",
		protocol_version: 1,
		min_supported_protocol_version: 1,
		db_path: resolveViewerDbPath(cwd),
		identity_target: buildViewerIdentityTarget(process.env, cwd),
	});
}

function installTools(client: PiCodememClient): Record<string, ToolDef> {
	const defs: ToolDef[] = [];
	registerMemoryTools({ registerTool: (def: ToolDef) => defs.push(def) } as never, client);
	return Object.fromEntries(defs.map((def) => [def.name, def]));
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("memory_pack schema keeps project and drops kind", () => {
	it("memory_pack schema keeps project and drops kind", () => {
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async () => ({ stdout: "{}", stderr: "" }),
		});
		const tools = installTools(client);
		const properties = tools.memory_pack.parameters.properties ?? {};
		expect(properties).toHaveProperty("project");
		expect(properties).not.toHaveProperty("kind");
	});
});

describe("memory_pack forwards project on HTTP and CLI", () => {
	it("memory_pack forwards project on HTTP and CLI", async () => {
		const cwd = process.cwd();
		const dbPath = resolveViewerDbPath(cwd);
		const identity = buildViewerIdentityTarget(process.env, cwd);
		let packBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
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
				if (url.pathname === "/api/pack" && (init?.method ?? "GET").toUpperCase() === "POST") {
					packBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
					return jsonOk({ pack_text: "http pack", metrics: { total_items: 1, pack_tokens: 2 } });
				}
				return jsonErr(404, {});
			}),
		);
		const httpClient = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});
		await installTools(httpClient).memory_pack.execute(
			"t1",
			{ context: "auth", project: "codemem" },
			undefined,
		);
		expect(packBody?.project).toBe("codemem");

		const cliArgs: string[][] = [];
		const cliClient = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliArgs.push([...args]);
				return { stdout: JSON.stringify({ pack_text: "cli pack" }), stderr: "" };
			},
		});
		await installTools(cliClient).memory_pack.execute(
			"t2",
			{ context: "auth", project: "codemem" },
			undefined,
		);
		const packArgs = cliArgs.find((args) => args[0] === "pack") ?? [];
		expect(packArgs).toContain("--project");
		expect(packArgs).toContain("codemem");
	});
});

describe("memory_get and memory_get_observations forward kind+project over HTTP", () => {
	it("memory_get and memory_get_observations forward kind+project over HTTP", async () => {
		const cwd = process.cwd();
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.pathname === "/api/prompt-pack-profile") {
					return matchingProfile(cwd);
				}
				if (url.pathname === "/api/memories/expand") {
					bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
					return jsonOk({
						observations: [{ id: 3, kind: "decision", project: "codemem" }],
						anchors: [{ id: 3, kind: "decision", project: "codemem" }],
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
		await tools.memory_get.execute(
			"t1",
			{ memory_id: 3, kind: "decision", project: "codemem" },
			undefined,
		);
		await tools.memory_get_observations.execute(
			"t2",
			{ ids: [3], kind: "decision", project: "codemem" },
			undefined,
		);
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body.kind).toBe("decision");
			expect(body.project).toBe("codemem");
		}
	});
});

describe("memory_get CLI rejects kind/project mismatches as not_found", () => {
	it("memory_get CLI rejects kind/project mismatches as not_found", async () => {
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async () => ({
				stdout: JSON.stringify({
					id: 3,
					kind: "feature",
					project: "other",
					title: "shown",
				}),
				stderr: "",
			}),
		});
		const result = await installTools(client).memory_get.execute(
			"t1",
			{ memory_id: 3, kind: "decision", project: "codemem" },
			undefined,
		);
		expect(result.details.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/not_found/);
	});
});

describe("memory_forget HTTP forwards kind+project and does not CLI-delete on not_found", () => {
	it("memory_forget HTTP forwards kind+project and does not CLI-delete on not_found", async () => {
		const cwd = process.cwd();
		let forgetBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.pathname === "/api/prompt-pack-profile") {
					return matchingProfile(cwd);
				}
				if (url.pathname === "/api/memories/forget") {
					forgetBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
					return jsonErr(404, { error: "not_found" });
				}
				return jsonErr(404, {});
			}),
		);
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async (args) => {
				cliArgs.push([...args]);
				return { stdout: JSON.stringify({ status: "ok" }), stderr: "" };
			},
		});
		const result = await installTools(client).memory_forget.execute(
			"t1",
			{ memory_id: 3, kind: "decision", project: "codemem" },
			undefined,
		);
		expect(forgetBody?.kind).toBe("decision");
		expect(forgetBody?.project).toBe("codemem");
		expect(result.details.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/not_found/);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "forget")).toBe(false);
	});
});

describe("memory_forget CLI skips forget when show does not match kind/project", () => {
	it("memory_forget CLI skips forget when show does not match kind/project", async () => {
		const cliArgs: string[][] = [];
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliArgs.push([...args]);
				return {
					stdout: JSON.stringify({ id: 3, kind: "feature", project: "other" }),
					stderr: "",
				};
			},
		});
		const result = await installTools(client).memory_forget.execute(
			"t1",
			{ memory_id: 3, kind: "decision", project: "codemem" },
			undefined,
		);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "show")).toBe(true);
		expect(cliArgs.some((args) => args[0] === "memory" && args[1] === "forget")).toBe(false);
		expect(result.details.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/not_found/);
	});
});

describe("memory_remember forwards confidence on HTTP and CLI", () => {
	it("memory_remember forwards confidence on HTTP and CLI", async () => {
		const cwd = process.cwd();
		let rememberBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/raw-events/status") {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.pathname === "/api/prompt-pack-profile") {
					return matchingProfile(cwd);
				}
				if (url.pathname === "/api/memories/remember") {
					rememberBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
					return jsonOk({ id: 8 });
				}
				return jsonErr(404, {});
			}),
		);
		const httpClient = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});
		await installTools(httpClient).memory_remember.execute(
			"t1",
			{ kind: "decision", title: "t", body: "b", confidence: 0.9 },
			undefined,
		);
		expect(rememberBody?.confidence).toBe(0.9);

		const cliArgs: string[][] = [];
		const cliClient = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliArgs.push([...args]);
				return { stdout: JSON.stringify({ id: 8 }), stderr: "" };
			},
		});
		await installTools(cliClient).memory_remember.execute(
			"t2",
			{ kind: "decision", title: "t", body: "b", confidence: 0.9 },
			undefined,
		);
		const rememberArgs =
			cliArgs.find((args) => args[0] === "memory" && args[1] === "remember") ?? [];
		expect(rememberArgs).toContain("--confidence");
		expect(rememberArgs).toContain("0.9");
	});
});
