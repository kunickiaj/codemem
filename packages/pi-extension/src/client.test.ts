import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: (...args: Parameters<typeof actual.execFile>) => execFileMock(...args),
	};
});

import { BOUNDARY_CLI_TIMEOUT_MS, type ExecCodememFn, PiCodememClient } from "./client.js";
import { defaultPiExtensionConfig } from "./config.js";
import {
	buildViewerIdentityTarget,
	checkIngestAvailable,
	createViewerRuntime,
	resolveViewerDbPath,
} from "./viewer.js";

/** No viewer probing/spawn in unit tests — CLI paths only. */
const offlineConfig = { ...defaultPiExtensionConfig(), viewerEnabled: false };
const onlineConfig = defaultPiExtensionConfig({ viewerEnabled: true, viewerAutoStart: false });

const IDENTITY_KEYS = [
	"device_id",
	"actor_id_present",
	"actor_id",
	"config_path",
	"runtime_root",
	"workspace_id",
	"home_dir",
	"pack_compression",
	"embedding_disabled",
	"embedding_offline",
	"embedding_model",
	"embedding_revision",
] as const;

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

function stubMatchingPackFetch(
	pack_text: string,
	cwd = process.cwd(),
	packBody: Record<string, unknown> = {},
) {
	const dbPath = resolveViewerDbPath(cwd);
	const identity = buildViewerIdentityTarget(process.env, cwd);
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
					db_path: dbPath,
					identity_target: identity,
				});
			}
			if (url.pathname === "/api/pack") {
				const body = {
					pack_text,
					items: [],
					metrics: { total_items: pack_text ? 1 : 0, pack_tokens: 1 },
					...packBody,
				};
				return {
					ok: true,
					status: 200,
					json: async () => body,
					text: async () => JSON.stringify(body),
				};
			}
			return jsonErr(404, {});
		}),
	);
}

describe("PiCodememClient.projectFromCwd (git-root walk)", () => {
	let tmpDir: string | null = null;

	afterEach(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = null;
		}
	});

	it("resolves git repo basename as project from a nested cwd", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-client-test-"));
		const repoRoot = join(tmpDir, "my-repo");
		const nested = join(repoRoot, "packages", "core");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		expect(PiCodememClient.projectFromCwd(nested)).toBe("my-repo");
		// Parity with the core resolver used by the store.
		expect(PiCodememClient.projectFromCwd(nested)).toBe(resolveProject(nested));
	});

	it("resolves the primary checkout basename for a linked worktree", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-client-test-"));
		const mainRepo = join(tmpDir, "main-repo");
		const worktree = join(tmpDir, "feature-worktree");
		mkdirSync(join(mainRepo, ".git", "worktrees", "feature-worktree"), { recursive: true });
		writeFileSync(join(mainRepo, ".git", "worktrees", "feature-worktree", "commondir"), "../..\n");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${join(mainRepo, ".git", "worktrees", "feature-worktree")}`,
		);

		expect(PiCodememClient.projectFromCwd(worktree)).toBe("main-repo");
		expect(PiCodememClient.projectFromCwd(worktree)).toBe(resolveProject(worktree));
	});

	it("falls back to the cwd basename outside a repository", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-client-test-"));
		const plain = join(tmpDir, "plain-dir");
		mkdirSync(plain, { recursive: true });

		expect(PiCodememClient.projectFromCwd(plain)).toBe("plain-dir");
		expect(PiCodememClient.projectFromCwd(plain)).toBe(resolveProject(plain));
	});
});

describe("fetchPackText preformatted flag", () => {
	const packBody = (pack_text: string) => ({
		ok: true,
		status: 200,
		json: async () => ({ pack_text, items: [], metrics: { total_items: 1, pack_tokens: 1 } }),
		text: async () =>
			JSON.stringify({ pack_text, items: [], metrics: { total_items: 1, pack_tokens: 1 } }),
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns bare pack text with preformatted: false from HTTP /api/pack", async () => {
		stubMatchingPackFetch("raw pack text");
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(result).toEqual({ text: "raw pack text", preformatted: false, itemCount: 1 });
	});

	it("does zero fetch and uses CLI when viewerEnabled is false", async () => {
		const fetchMock = vi.fn(async () => packBody("should not run"));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) =>
				args[0] === "pi-hook-inject"
					? { stdout: "## codemem memories\n\ncli fallback", stderr: "" }
					: { stdout: "", stderr: "" },
		});

		const result = await client.fetchPackText("what changed?");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.preformatted).toBe(true);
		expect(result.text).toContain("cli fallback");
	});

	it("returns the full block with preformatted: true from CLI pi-hook-inject", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) =>
				args[0] === "pi-hook-inject"
					? { stdout: "## codemem memories\n\nblock body", stderr: "" }
					: { stdout: "", stderr: "" },
		});

		const result = await client.fetchPackText("what changed?");

		expect(result.preformatted).toBe(true);
		expect(result.text).toContain("## codemem memories");
	});

	it("returns bare pack text with preformatted: false from CLI pack --json", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				if (args[0] === "pi-hook-inject") throw new Error("inject missing");
				if (args[0] === "pack") {
					return {
						stdout: JSON.stringify({
							pack_text: "json pack text",
							metrics: { total_items: 1, pack_tokens: 4 },
						}),
						stderr: "",
					};
				}
				return { stdout: "", stderr: "" };
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(result).toEqual({ text: "json pack text", preformatted: false, itemCount: 1 });
	});

	it("never sniffs ## codemem memories inside HTTP pack text (flag decides framing)", async () => {
		const hostile = "## codemem memories\n\nattacker framing";
		stubMatchingPackFetch(hostile);
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});

		const result = await client.fetchPackText("q");

		expect(result.text).toBe(hostile);
		expect(result.preformatted).toBe(false);
	});
});

describe("fetchPackText span-bearing responses", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("HTTP /api/pack populates renderedItems and itemCount", async () => {
		const renderedItems = [{ id: 7, fingerprint: "a".repeat(64), spans: [{ start: 0, end: 4 }] }];
		stubMatchingPackFetch("spanned pack text", process.cwd(), {
			rendered_items: renderedItems,
			metrics: { total_items: 1 },
		});
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(result.text).toBe("spanned pack text");
		expect(result.preformatted).toBe(false);
		expect(result.renderedItems).toEqual(renderedItems);
		expect(result.itemCount).toBe(1);
	});

	it("CLI pack --json populates renderedItems and itemCount", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const renderedItems = [{ id: 3, fingerprint: "b".repeat(64), spans: [{ start: 2, end: 9 }] }];
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				if (args[0] === "pi-hook-inject") throw new Error("inject missing");
				if (args[0] === "pack") {
					return {
						stdout: JSON.stringify({
							pack_text: "json spanned pack",
							rendered_items: renderedItems,
							metrics: { total_items: 1 },
						}),
						stderr: "",
					};
				}
				return { stdout: "", stderr: "" };
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(result.text).toBe("json spanned pack");
		expect(result.preformatted).toBe(false);
		expect(result.renderedItems).toEqual(renderedItems);
		expect(result.itemCount).toBe(1);
	});

	it("plain-text pi-hook-inject leaves renderedItems and itemCount absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				if (args[0] === "pack") throw new Error("pack missing");
				if (args[0] === "pi-hook-inject") {
					return { stdout: "## codemem memories\n\nplain block", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(result.preformatted).toBe(true);
		expect(result.text).toContain("plain block");
		expect(result.renderedItems).toBeUndefined();
		expect(result.itemCount).toBeUndefined();
	});

	it("prefers span-bearing pack --json over plain-text pi-hook-inject when both are available", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				if (args[0] === "pack") {
					return {
						stdout: JSON.stringify({
							pack_text: "spanned text",
							rendered_items: [
								{ id: 1, fingerprint: "c".repeat(64), spans: [{ start: 0, end: 5 }] },
							],
							metrics: { total_items: 1 },
						}),
						stderr: "",
					};
				}
				if (args[0] === "pi-hook-inject") {
					return { stdout: "## codemem memories\n\nplain fallback", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(result.preformatted).toBe(false);
		expect(result.text).toBe("spanned text");
		expect(result.renderedItems).toHaveLength(1);
		expect(result.itemCount).toBe(1);
	});

	it("a successful empty HTTP pack ends the chain without spawning a command", async () => {
		stubMatchingPackFetch("", process.cwd(), { rendered_items: [], metrics: { total_items: 0 } });
		const cliCalls: string[][] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				cliCalls.push([...args]);
				return { stdout: "", stderr: "" };
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(result.text).toBe("");
		expect(result.renderedItems).toEqual([]);
		expect(result.itemCount).toBe(0);
		expect(cliCalls).toHaveLength(0);
	});
});

const zeroItemText = "## Index\n(no items)\n\n## Detail\n(no items)";
let packContractLogDir: string | null = null;

function stubPackBody(body: unknown, cwd = process.cwd()) {
	const dbPath = resolveViewerDbPath(cwd);
	const identity = buildViewerIdentityTarget(process.env, cwd);
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
					db_path: dbPath,
					identity_target: identity,
				});
			}
			if (url.pathname === "/api/pack") return jsonOk(body);
			return jsonErr(404, {});
		}),
	);
}

function usePackContractLog(): string {
	packContractLogDir = mkdtempSync(join(tmpdir(), "codemem-pi-metric-"));
	const path = join(packContractLogDir, "plugin.log");
	vi.stubEnv("CODEMEM_PLUGIN_LOG_PATH", path);
	return path;
}

describe("pack contract", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		if (packContractLogDir) {
			rmSync(packContractLogDir, { recursive: true, force: true });
			packContractLogDir = null;
		}
	});

	it("keeps a valid zero-item HTTP pack and does not fall through", async () => {
		stubPackBody({
			pack_text: zeroItemText,
			rendered_items: [],
			metrics: { total_items: 0, pack_tokens: 11 },
		});
		const commands: string[] = [];
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				commands.push(args[0] ?? "");
				return { stdout: "## codemem memories\n\nshould not run", stderr: "" };
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(commands).toEqual([]);
		expect(result.preformatted).toBe(false);
		expect(result.text).toBe(zeroItemText);
		expect(result.itemCount).toBe(0);
	});

	it("falls through when HTTP returns {} or an error-shaped body", async () => {
		for (const body of [{}, { error: { code: "pack_failed", message: "no" } }]) {
			stubPackBody(body);
			const commands: string[] = [];
			const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
				execImpl: async (args) => {
					commands.push(args[0] ?? "");
					if (args[0] === "pi-hook-inject") {
						return { stdout: "## codemem memories\n\ncli fallback", stderr: "" };
					}
					return { stdout: "{}", stderr: "" };
				},
			});

			const result = await client.fetchPackText("what changed?");

			expect(result.preformatted).toBe(true);
			expect(result.text).toContain("cli fallback");
			expect(commands).toContain("pi-hook-inject");
		}
	});

	it("falls through when CLI pack --json is {} or error-shaped, and keeps a zero-item pack", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const cases = [
			{ stdout: "{}", fallback: true },
			{ stdout: JSON.stringify({ error: "pack_failed", message: "no" }), fallback: true },
			{
				stdout: JSON.stringify({
					pack_text: zeroItemText,
					rendered_items: [],
					metrics: { total_items: 0, pack_tokens: 11 },
				}),
				fallback: false,
			},
		];
		for (const item of cases) {
			const commands: string[] = [];
			const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
				execImpl: async (args) => {
					commands.push(args[0] ?? "");
					if (args[0] === "pack") return { stdout: item.stdout, stderr: "" };
					return { stdout: "## codemem memories\n\ncli fallback", stderr: "" };
				},
			});

			const result = await client.fetchPackText("what changed?");

			if (item.fallback) {
				expect(commands).toContain("pi-hook-inject");
				expect(result.preformatted).toBe(true);
			} else {
				expect(commands).toEqual(["pack"]);
				expect(result.preformatted).toBe(false);
				expect(result.text).toBe(zeroItemText);
				expect(result.itemCount).toBe(0);
			}
		}
	});
});

describe("pi inject metrics", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		if (packContractLogDir) {
			rmSync(packContractLogDir, { recursive: true, force: true });
			packContractLogDir = null;
		}
	});

	it("logs inject.pack.ok source=pi for span-bearing successes and not for pi-hook-inject", async () => {
		const logPath = usePackContractLog();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			project: "codemem",
			execImpl: async (args) => {
				if (args[0] !== "pack") throw new Error("inject should not run");
				return {
					stdout: JSON.stringify({
						pack_text: "json pack text",
						metrics: { total_items: 2, pack_tokens: 9 },
					}),
					stderr: "",
				};
			},
		});

		await client.fetchPackText("what changed?");

		const line = readFileSync(logPath, "utf8");
		expect(line).toContain("inject.pack.ok");
		expect(line).toContain("source=pi");
		expect(line).toContain("origin=local");
		expect(line).toContain("items=2");
		expect(line).toContain("pack_tokens=9");
		expect(line).toContain(`query_len=${"what changed?".length}`);
		expect(line).toContain("empty=false");
		expect(line).toContain('project="codemem"');

		const hookOnly = join(packContractLogDir ?? tmpdir(), "hook-only.log");
		vi.stubEnv("CODEMEM_PLUGIN_LOG_PATH", hookOnly);
		const fallback = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				if (args[0] === "pack") throw new Error("pack missing");
				return { stdout: "## codemem memories\n\nplain block", stderr: "" };
			},
		});
		await fallback.fetchPackText("what changed?");
		expect(existsSync(hookOnly)).toBe(false);
	});

	it("logs origin=viewer for a proven HTTP pack", async () => {
		const logPath = usePackContractLog();
		stubPackBody({
			pack_text: "viewer pack",
			metrics: { total_items: 1, pack_tokens: 3 },
		});
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});

		await client.fetchPackText("what changed?");

		const line = readFileSync(logPath, "utf8");
		expect(line).toContain("source=pi");
		expect(line).toContain("origin=viewer");
		expect(line).toContain("items=1");
		expect(line).toContain("pack_tokens=3");
	});
});

describe("boundary CLI timeout budget", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("passes an independent >=20s budget to pi-hook-ingest for boundary flushes", async () => {
		// HTTP timeout intentionally tiny so the old httpTimeoutMs+2000 bug would
		// show up here (2050ms) — the flush must get the independent budget.
		const config = { ...offlineConfig, httpTimeoutMs: 50 };
		const seen: Array<{ argv: string[]; timeoutMs?: number }> = [];
		const execImpl: ExecCodememFn = async (args, opts) => {
			seen.push({ argv: [...args], timeoutMs: opts?.timeoutMs });
			return { stdout: JSON.stringify({ inserted: 0, skipped: 1 }), stderr: "" };
		};
		const client = new PiCodememClient(config, createViewerRuntime(), { execImpl });

		await client.ingest({ piEvent: "session_before_compact", sessionId: "s1", cwd: "/tmp/a" });
		await client.ingest({ piEvent: "session_shutdown", sessionId: "s1", cwd: "/tmp/a" });

		expect(seen).toHaveLength(2);
		for (const call of seen) {
			expect(call.argv[0]).toBe("pi-hook-ingest");
			expect(call.timeoutMs).toBe(BOUNDARY_CLI_TIMEOUT_MS);
			expect(call.timeoutMs).toBeGreaterThanOrEqual(20_000);
		}
	});
});

describe("HTTP ingest identity proof", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("HTTP payloads carry db_path + identity_target", async () => {
		const cwd = "/tmp/pi-ext-ingest";
		vi.stubEnv("CODEMEM_DB", "/tmp/pi-ext-mem.sqlite");
		const posts: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/api/raw-events/status")) {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.includes("/api/pi-hooks")) {
					posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
					return jsonOk({ inserted: 1, skipped: 0 });
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

		const result = await client.ingest({ piEvent: "session_start", sessionId: "s1" });

		expect(result).toMatchObject({ ok: true, via: "http", inserted: 1 });
		expect(posts).toHaveLength(1);
		expect(posts[0]?.db_path).toBe(resolveViewerDbPath(cwd));
		expect(posts[0]?.identity_target).toEqual(buildViewerIdentityTarget(process.env, cwd));
		for (const key of IDENTITY_KEYS) {
			expect(posts[0]?.identity_target).toHaveProperty(key);
		}
	});

	it("goes straight to CLI on a viewer target-conflict 409 without retrying HTTP", async () => {
		const cwd = "/tmp/pi-ext-mismatch";
		vi.stubEnv("CODEMEM_DB", "/tmp/other.sqlite");
		const posts: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/api/raw-events/status")) {
					return jsonOk({ ingest: { available: true } });
				}
				if (url.includes("/api/pi-hooks")) {
					posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
					return jsonErr(409, { error: { code: "viewer_db_mismatch" } });
				}
				return jsonErr(404, {});
			}),
		);
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async () => ({
				stdout: JSON.stringify({ inserted: 1, skipped: 0 }),
				stderr: "",
			}),
		});

		const result = await client.ingest({ piEvent: "session_start", sessionId: "s1" });

		expect(result).toMatchObject({ ok: true, via: "cli", inserted: 1 });
		expect(posts).toHaveLength(1);
		expect(posts[0]?.db_path).toBe(resolveViewerDbPath(cwd));
		expect(posts[0]?.identity_target).toEqual(buildViewerIdentityTarget(process.env, cwd));
	});
});

describe("HTTP pack identity proof", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("proves GET /api/prompt-pack-profile then POSTs /api/pack with db_path + identity_target", async () => {
		const cwd = "/tmp/pi-ext-pack";
		vi.stubEnv("CODEMEM_DB", "/tmp/pi-ext-pack.sqlite");
		const dbPath = resolveViewerDbPath(cwd);
		const identity = buildViewerIdentityTarget(process.env, cwd);
		const requests: Array<{ path: string; method: string; redirect?: string; body: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
				requests.push({
					path: url.pathname,
					method: (init?.method ?? "GET").toUpperCase(),
					redirect: init?.redirect,
					body,
				});
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
				if (url.pathname === "/api/pack") {
					return jsonOk({
						pack_text: "viewer pack body",
						items: [],
						metrics: { total_items: 1, pack_tokens: 3 },
					});
				}
				return jsonErr(404, {});
			}),
		);
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			project: "codemem",
			execImpl: async () => {
				throw new Error("CLI should not run");
			},
		});

		const result = await client.fetchPackText("fix auth callback");

		expect(result).toEqual({ text: "viewer pack body", preformatted: false, itemCount: 1 });
		const packRequests = requests.filter(
			(r) => r.path === "/api/prompt-pack-profile" || r.path === "/api/pack",
		);
		expect(packRequests.map((r) => r.path)).toEqual(["/api/prompt-pack-profile", "/api/pack"]);
		expect(packRequests[0]?.method).toBe("GET");
		expect(packRequests[0]?.redirect).toBe("manual");
		expect(packRequests[1]?.method).toBe("POST");
		expect(packRequests[1]?.body).toMatchObject({
			context: "fix auth callback",
			limit: onlineConfig.injectLimit,
			token_budget: onlineConfig.injectTokenBudget,
			project: "codemem",
			db_path: dbPath,
			identity_target: identity,
		});
	});

	it("falls back to CLI when the viewer proves a different target", async () => {
		const cwd = "/tmp/pi-ext-pack-mismatch";
		vi.stubEnv("CODEMEM_DB", "/tmp/wanted.sqlite");
		const packPosts: string[] = [];
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
						db_path: "/tmp/someone-else.sqlite",
						identity_target: buildViewerIdentityTarget(process.env, cwd),
					});
				}
				if (url.pathname === "/api/pack") {
					packPosts.push((init?.method ?? "GET").toUpperCase());
					return jsonOk({ pack_text: "wrong viewer memories" });
				}
				return jsonErr(404, {});
			}),
		);
		const client = new PiCodememClient(onlineConfig, createViewerRuntime(), {
			cwd,
			execImpl: async (args) =>
				args[0] === "pi-hook-inject"
					? { stdout: "## codemem memories\n\nlocal fallback", stderr: "" }
					: { stdout: "", stderr: "" },
		});

		const result = await client.fetchPackText("continue work");

		expect(result.preformatted).toBe(true);
		expect(result.text).toContain("local fallback");
		expect(result.text).not.toContain("wrong viewer memories");
		expect(packPosts).toHaveLength(0);
	});
});

describe("viewerEnabled HTTP gate", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("ingest does zero fetch when viewerEnabled is false", async () => {
		const fetchMock = vi.fn(async () => jsonOk({ inserted: 1, skipped: 0 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async () => ({
				stdout: JSON.stringify({ inserted: 1, skipped: 0 }),
				stderr: "",
			}),
		});

		const result = await client.ingest({ piEvent: "session_start", sessionId: "s1" });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: true, via: "cli", inserted: 1 });
	});

	it("checkIngestAvailable does zero fetch when viewerEnabled is false", async () => {
		const fetchMock = vi.fn(async () => jsonOk({ ingest: { available: true } }));
		vi.stubGlobal("fetch", fetchMock);

		const available = await checkIngestAvailable(offlineConfig, createViewerRuntime());

		expect(fetchMock).not.toHaveBeenCalled();
		expect(available).toBe(false);
	});
});

describe("execCodemem abort listener", () => {
	afterEach(() => {
		execFileMock.mockReset();
	});

	it("aborting after successful execs does not fire leftover listeners", async () => {
		const kills: string[] = [];
		execFileMock.mockImplementation((_file, _args, _opts, cb) => {
			const child = {
				kill: (sig?: NodeJS.Signals) => {
					kills.push(String(sig ?? "kill"));
				},
				stdin: { write: () => true, end: () => undefined },
			};
			queueMicrotask(() => {
				if (typeof cb === "function") cb(null, "ok", "");
			});
			return child;
		});

		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {});
		const ac = new AbortController();
		await client.execCodemem(["--version"], { signal: ac.signal });
		await client.execCodemem(["--version"], { signal: ac.signal });
		await client.execCodemem(["--version"], { signal: ac.signal });
		ac.abort();

		expect(kills).toEqual([]);
	});
});
