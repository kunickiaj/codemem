import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema, MemoryStore, queryRetrievalAttempts } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callCodememToolLocally } from "./local-call.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CODEMEM_CONFIG", "CODEMEM_EMBEDDING_DISABLED", "HOME", "CODEMEM_PROJECT"];

let store: MemoryStore;
let tempDirectory: string;

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	tempDirectory = mkdtempSync(join(tmpdir(), "codemem-local-call-"));
	const projectDirectory = join(tempDirectory, "local-call-fixture");
	mkdirSync(projectDirectory);
	process.env.CODEMEM_CONFIG = join(tempDirectory, "config.json");
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	process.env.HOME = tempDirectory;
	delete process.env.CODEMEM_PROJECT;
	vi.spyOn(process, "cwd").mockReturnValue(projectDirectory);

	const databasePath = join(tempDirectory, "memory.sqlite");
	const database = connect(databasePath);
	initTestSchema(database);
	database.close();
	store = new MemoryStore(databasePath);
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

async function rememberSentinel(): Promise<number> {
	const outcome = await callCodememToolLocally(store, "memory_remember", {
		kind: "discovery",
		title: "Local call sentinel",
		body: "Local call sentinel body for fallback parity.",
		project: "local-call-fixture",
	});
	if (!outcome.ok) throw new Error(outcome.error);
	return (outcome.result as { id: number }).id;
}

describe("callCodememToolLocally", () => {
	it("represents an unknown-tool protocol error in the local failure envelope", async () => {
		const outcome = await callCodememToolLocally(store, "no_such_tool", {});
		expect(outcome).toEqual({ ok: false, error: "Tool no_such_tool not found" });
		expect((await callCodememToolLocally(store, "memory_schema", {})).ok).toBe(true);
	});
	it("returns the structured MCP result for a successful call", async () => {
		const id = await rememberSentinel();

		const outcome = await callCodememToolLocally(store, "memory_search", {
			query: "sentinel",
			limit: 5,
		});

		expect(outcome.ok).toBe(true);
		const items = (outcome as { result: { items: Array<{ id: number; body: string }> } }).result
			.items;
		expect(items.map((item) => item.id)).toEqual([id]);
		expect(items[0]?.body).toContain("fallback parity");
	});

	it("scopes default reads to the project of the process working directory", async () => {
		await rememberSentinel();
		vi.spyOn(process, "cwd").mockReturnValue(join(tempDirectory, "other-project"));

		const outcome = await callCodememToolLocally(store, "memory_search", { query: "sentinel" });

		expect(outcome).toEqual({ ok: true, result: { items: [] } });
	});

	it("reports a tool-level error with the tool's payload", async () => {
		const outcome = await callCodememToolLocally(store, "memory_get", { memory_id: 999_999 });

		expect(outcome.ok).toBe(false);
		expect(outcome).toMatchObject({ ok: false, error: "not_found" });
	});

	it("rejects arguments that fail the tool's input schema", async () => {
		const outcome = await callCodememToolLocally(store, "memory_remember", { kind: "discovery" });

		expect(outcome.ok).toBe(false);
	});

	it("reports an unknown tool as an error rather than throwing", async () => {
		const outcome = await callCodememToolLocally(store, "memory_nope", {});

		expect(outcome.ok).toBe(false);
	});

	it("uses the caller's directory instead of the process directory for default reads", async () => {
		await rememberSentinel();
		vi.spyOn(process, "cwd").mockReturnValue(join(tempDirectory, "viewer-home"));

		const outcome = await callCodememToolLocally(
			store,
			"memory_search",
			{ query: "sentinel" },
			{ cwd: join(tempDirectory, "local-call-fixture"), envProject: null },
		);

		expect((outcome as { result: { items: unknown[] } }).result.items).toHaveLength(1);
	});

	it("ignores this process's CODEMEM_PROJECT when the caller says it has none", async () => {
		await rememberSentinel();
		process.env.CODEMEM_PROJECT = "viewer-env-project";

		const outcome = await callCodememToolLocally(
			store,
			"memory_search",
			{ query: "sentinel" },
			{ cwd: join(tempDirectory, "local-call-fixture"), envProject: null },
		);

		expect((outcome as { result: { items: unknown[] } }).result.items).toHaveLength(1);
	});

	it("records the caller's directory on the write session, not the process directory", async () => {
		vi.spyOn(process, "cwd").mockReturnValue(join(tempDirectory, "viewer-home"));
		const callerDirectory = join(tempDirectory, "local-call-fixture");

		const outcome = await callCodememToolLocally(
			store,
			"memory_remember",
			{ kind: "decision", title: "Caller cwd", body: "Session cwd comes from the caller." },
			{ cwd: callerDirectory, envProject: null },
		);

		const id = (outcome as { result: { id: number } }).result.id;
		const row = store.db
			.prepare(
				"SELECT sessions.cwd AS cwd FROM memory_items JOIN sessions ON sessions.id = memory_items.session_id WHERE memory_items.id = ?",
			)
			.get(id) as { cwd: string };
		expect(row.cwd).toBe(callerDirectory);
	});

	it("records each identical call from one session as its own attempt", async () => {
		await rememberSentinel();
		const call = () =>
			callCodememToolLocally(
				store,
				"memory_search",
				{ query: "sentinel" },
				{ sessionId: "ses_repeat", statelessLedger: true },
			);

		await call();
		await call();

		expect(queryRetrievalAttempts(store.db, { surface: "mcp_search" })).toHaveLength(2);
	});

	it("records a retried delivery of the same host call ID once", async () => {
		await rememberSentinel();
		const call = () =>
			callCodememToolLocally(
				store,
				"memory_search",
				{ query: "sentinel" },
				{ sessionId: "ses_retry", statelessLedger: true, requestId: "call_1" },
			);

		await call();
		await call();

		expect(queryRetrievalAttempts(store.db, { surface: "mcp_search" })).toHaveLength(1);
	});

	it("attributes retrieval-ledger rows to the supplied host session", async () => {
		await rememberSentinel();

		await callCodememToolLocally(
			store,
			"memory_search",
			{ query: "sentinel" },
			{ sessionId: "ses_host_fallback" },
		);

		// stdio MCP groups a process's calls under one random stream; the host
		// session plays that role here so its calls group the same way.
		const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_search" });
		expect(attempts).toHaveLength(1);
		expect(attempts[0]?.streamId).toBe("ses_host_fallback");
		expect(attempts[0]?.source).toBe("mcp");
	});
});
