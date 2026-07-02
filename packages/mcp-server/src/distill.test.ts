import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observeMock = vi.hoisted(() => vi.fn());

vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	return {
		...actual,
		ObserverClient: class {
			observe = observeMock;
		},
	};
});

import { connect, initTestSchema, MemoryStore } from "@codemem/core";
import { createCodememMcpServer } from "./index.js";

type RegisteredTool = {
	handler: (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
	}>;
};

function getTool(server: ReturnType<typeof createCodememMcpServer>, name: string): RegisteredTool {
	const registry = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
		._registeredTools;
	const tool = registry[name];
	if (!tool) throw new Error(`MCP tool not registered: ${name}`);
	return tool;
}

function parseToolJson(result: { content: Array<{ type: string; text: string }> }): unknown {
	const text = result.content[0]?.text;
	if (typeof text !== "string") throw new Error("tool result missing text content");
	return JSON.parse(text);
}

describe("memory_distill_candidates MCP tool", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let prevCodememConfig: string | undefined;
	let prevEmbeddingDisabled: string | undefined;

	beforeEach(() => {
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		prevEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-mcp-distill-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		dbPath = join(tmpDir, "mem.sqlite");

		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		if (prevEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
		else process.env.CODEMEM_EMBEDDING_DISABLED = prevEmbeddingDisabled;
	});

	function remember(project: string, title: string): number {
		const sessionId = store.startSession({ cwd: join(tmpDir, project), project });
		return store.remember(sessionId, "discovery", title, `${title} body`, 0.9);
	}

	it("mines candidates within the server default project", async () => {
		remember("greenroom", "mcp distill greenroom recurring lesson");
		remember("greenroom", "mcp distill greenroom recurring lesson again");
		remember("other", "mcp distill other recurring lesson");
		remember("other", "mcp distill other recurring lesson again");
		const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
		const distill = getTool(server, "memory_distill_candidates");

		const result = parseToolJson(
			await distill.handler({
				all_projects: false,
				include_documented: false,
				limit: 10,
				max_evidence_items: 5,
				min_recurrence: 2,
			}),
		) as { candidates: Array<{ projects: string[]; scope: string }>; version: number };

		expect(result.version).toBe(1);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			projects: ["greenroom"],
			scope: "project",
		});
	});

	it("supports all-project mining for user-scoped candidates", async () => {
		remember("greenroom", "purple otter lantern protocol recurring lesson");
		remember("other", "purple otter lantern protocol lesson again");
		const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
		const distill = getTool(server, "memory_distill_candidates");

		const result = parseToolJson(
			await distill.handler({
				all_projects: true,
				include_documented: false,
				limit: 10,
				max_evidence_items: 5,
				min_recurrence: 2,
			}),
		) as { candidates: Array<{ projects: string[]; scope: string; suggested_target: string }> };

		expect(result.candidates[0]).toMatchObject({
			projects: ["greenroom", "other"],
			scope: "user",
			suggested_target: "~/.config/opencode/AGENTS.md",
		});
	});

	it("judges candidates and drops routine-activity clusters when judge is set", async () => {
		remember("greenroom", "mcp judge greenroom recurring lesson");
		remember("greenroom", "mcp judge greenroom recurring lesson again");
		observeMock.mockResolvedValue({ raw: "ROUTINE: release status narration" });
		const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
		const distill = getTool(server, "memory_distill_candidates");

		const result = parseToolJson(
			await distill.handler({
				all_projects: false,
				include_documented: false,
				judge: true,
				limit: 10,
				max_evidence_items: 5,
				min_recurrence: 2,
			}),
		) as {
			candidates: unknown[];
			metadata: { judged?: boolean; routine_filtered_count?: number };
		};

		expect(observeMock).toHaveBeenCalledTimes(1);
		expect(result.candidates).toHaveLength(0);
		expect(result.metadata.judged).toBe(true);
		expect(result.metadata.routine_filtered_count).toBe(1);
		observeMock.mockReset();
	});

	it("falls back to unjudged output when the observer is unavailable", async () => {
		remember("greenroom", "mcp judge fallback recurring lesson");
		remember("greenroom", "mcp judge fallback recurring lesson again");
		observeMock.mockRejectedValue(new Error("no observer auth configured"));
		const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
		const distill = getTool(server, "memory_distill_candidates");

		const result = parseToolJson(
			await distill.handler({
				all_projects: false,
				include_documented: false,
				judge: true,
				limit: 10,
				max_evidence_items: 5,
				min_recurrence: 2,
			}),
		) as {
			candidates: unknown[];
			metadata: { judged?: boolean; judge_error?: string };
		};

		expect(result.candidates).toHaveLength(1);
		expect(result.metadata.judged).toBe(false);
		expect(result.metadata.judge_error).toContain("no observer auth configured");
		observeMock.mockReset();
	});

	it("rejects project filters when all-project mining is requested", async () => {
		remember("greenroom", "project filter conflict recurring lesson");
		remember("other", "project filter conflict recurring lesson again");
		const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
		const distill = getTool(server, "memory_distill_candidates");

		const result = parseToolJson(
			await distill.handler({
				all_projects: true,
				include_documented: false,
				limit: 10,
				max_evidence_items: 5,
				min_recurrence: 2,
				project: "greenroom",
			}),
		) as { error?: string };

		expect(result.error).toBe("project cannot be combined with all_projects");
	});
});
