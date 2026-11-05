/**
 * End-to-end check of the viewer's memory-tool route with the real MCP
 * handlers: a shared viewer running in one directory serves callers in other
 * directories without leaking its own cwd or CODEMEM_PROJECT into scoping.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViewerIdentityTarget, connect, initTestSchema, MemoryStore } from "@codemem/core";
import { memoryToolCallRoutes } from "@codemem/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callCodememToolLocally } from "./local-call.js";

const ENV_KEYS = ["CODEMEM_CONFIG", "CODEMEM_EMBEDDING_DISABLED", "HOME", "CODEMEM_PROJECT"];
const savedEnv: Record<string, string | undefined> = {};

let store: MemoryStore;
let tempDirectory: string;
let app: ReturnType<typeof memoryToolCallRoutes>;

function repo(name: string): string {
	const directory = join(tempDirectory, name);
	mkdirSync(join(directory, ".git"), { recursive: true });
	return directory;
}

async function callTool(
	name: string,
	args: Record<string, unknown>,
	directory: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
	const res = await app.request(`/api/memory-tools/${name}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			arguments: args,
			caller: { directory, env_project: null, session_id: `ses_${name}` },
			db_path: store.dbPath,
			identity_target: buildViewerIdentityTarget(),
		}),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { ok: boolean; result?: unknown; error?: string };
}

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	tempDirectory = mkdtempSync(join(tmpdir(), "codemem-viewer-tool-call-"));
	process.env.CODEMEM_CONFIG = join(tempDirectory, "config.json");
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	process.env.HOME = tempDirectory;
	// The viewer process lives in its own repo with its own CODEMEM_PROJECT.
	process.env.CODEMEM_PROJECT = "viewer-env-project";
	vi.spyOn(process, "cwd").mockReturnValue(repo("viewer-home"));
	const databasePath = join(tempDirectory, "memory.sqlite");
	const database = connect(databasePath);
	initTestSchema(database);
	database.close();
	store = new MemoryStore(databasePath);
	app = memoryToolCallRoutes(
		() => store,
		(s, name, args, caller) => callCodememToolLocally(s, name, args, caller),
	);
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	rmSync(tempDirectory, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("viewer memory-tool route with the real MCP handlers", () => {
	it("keeps each caller's reads in its own project", async () => {
		const alpha = repo("alpha");
		const beta = repo("beta");
		await callTool(
			"memory_remember",
			{ kind: "decision", title: "Alpha sentinel", body: "alpha only", project: "alpha" },
			alpha,
		);
		await callTool(
			"memory_remember",
			{ kind: "decision", title: "Beta sentinel", body: "beta only", project: "beta" },
			beta,
		);

		const fromAlpha = await callTool("memory_search", { query: "sentinel" }, alpha);
		const fromBeta = await callTool("memory_search", { query: "sentinel" }, beta);

		const titles = (outcome: { result?: unknown }) =>
			(outcome.result as { items: Array<{ title: string }> }).items.map((item) => item.title);
		expect(titles(fromAlpha)).toEqual(["Alpha sentinel"]);
		expect(titles(fromBeta)).toEqual(["Beta sentinel"]);
	});

	it("records the caller's directory on writes and ignores the viewer's CODEMEM_PROJECT", async () => {
		const alpha = repo("alpha");

		const outcome = await callTool(
			"memory_remember",
			{ kind: "decision", title: "No project", body: "caller has no env project" },
			alpha,
		);

		const id = (outcome.result as { id: number }).id;
		const row = store.db
			.prepare(
				"SELECT sessions.cwd AS cwd, sessions.project AS project FROM memory_items JOIN sessions ON sessions.id = memory_items.session_id WHERE memory_items.id = ?",
			)
			.get(id) as { cwd: string; project: string | null };
		expect(row).toEqual({ cwd: alpha, project: null });
	});

	it("reads AGENTS.md for distill from the caller's repository", async () => {
		const alpha = repo("alpha");
		writeFileSync(join(alpha, "AGENTS.md"), "# alpha context\n- Alpha recurring lesson\n");
		writeFileSync(join(process.cwd(), "AGENTS.md"), "# viewer context\n");

		const outcome = await callTool(
			"memory_distill_candidates",
			{ judge: false, project: "alpha" },
			alpha,
		);

		expect(outcome.ok).toBe(true);
		const metadata = (outcome.result as { metadata: { context_document_count: number } }).metadata;
		// Project AGENTS.md from the caller's repo; the viewer's own file is never read.
		expect(metadata.context_document_count).toBe(1);
	});
});
