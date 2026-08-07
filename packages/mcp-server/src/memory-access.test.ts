import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	getRetrievalAttempt,
	initTestSchema,
	MemoryStore,
	purgeRetrievalAttemptsForPrivacy,
	queryRetrievalAttempts,
	seedMixedScopeFixture,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodememMcpServer } from "./index.js";
import { withMcpRetrieval } from "./mcp-retrieval-ledger.js";
import {
	forgetMemoryForMcp,
	getManyForMcp,
	getMemoryForMcp,
	rememberMemoryForMcp,
} from "./memory-access.js";
import type { ToolRegistrationContext } from "./tool-context.js";

type RegisteredTool = {
	handler: (
		args: Record<string, unknown>,
		extra?: { requestId: string | number; sessionId?: string; signal?: AbortSignal },
	) => Promise<{
		content: Array<{ type: string; text: string }>;
	}>;
};

function requestExtra(requestId: string | number, sessionId?: string) {
	return { requestId, sessionId, signal: new AbortController().signal };
}

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

describe("MCP memory access scope guards", () => {
	const originalDeviceId = process.env.CODEMEM_DEVICE_ID;
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let sessionId: number;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-mcp-scope-"));
		dbPath = join(tmpDir, "mem.sqlite");
		process.env.CODEMEM_DEVICE_ID = "mcp-scope-device";
		const db = connect(dbPath);
		initTestSchema(db);
		sessionId = insertSession(db, { cwd: join(tmpDir, "greenroom"), project: "greenroom" });
		grantScopeToDevice(db, "scope-a", "mcp-scope-device");
		insertCoordinatorScope(db, "scope-b");
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
		if (originalDeviceId === undefined) {
			delete process.env.CODEMEM_DEVICE_ID;
		} else {
			process.env.CODEMEM_DEVICE_ID = originalDeviceId;
		}
	});

	it("hides unauthorized scoped IDs and intersects explicit scope filters", () => {
		const authorizedId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-a",
			title: "Authorized MCP note",
		});
		const hiddenId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-b",
			title: "Hidden MCP note",
		});

		expect(getMemoryForMcp(store, authorizedId)?.title).toBe("Authorized MCP note");
		expect(getMemoryForMcp(store, hiddenId)).toBe(null);
		expect(getManyForMcp(store, [hiddenId, authorizedId]).map((item) => item.id)).toEqual([
			authorizedId,
		]);
		expect(getMemoryForMcp(store, authorizedId, { scope_id: "scope-b" })).toBe(null);
	});

	it("keeps mixed-domain unauthorized scope rows out of MCP direct reads", () => {
		const fixture = seedMixedScopeFixture(store.db, store.deviceId);

		expect(getMemoryForMcp(store, fixture.personalId)?.title).toBe(fixture.visibleTitles[0]);
		expect(getMemoryForMcp(store, fixture.authorizedId)?.title).toBe(fixture.visibleTitles[1]);
		expect(getMemoryForMcp(store, fixture.unauthorizedId)).toBe(null);
		expect(
			getManyForMcp(store, fixture.allIds)
				.map((item) => item.id)
				.sort((a, b) => a - b),
		).toEqual([...fixture.visibleIds].sort((a, b) => a - b));
	});

	it("keeps blank project filters default-scoped for expansion-style direct reads", () => {
		const greenroomId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-a",
			title: "Greenroom default project note",
		});
		const otherSessionId = insertSession(store.db, {
			cwd: join(tmpDir, "other"),
			project: "other",
		});
		const otherId = insertScopedMemory(store, {
			sessionId: otherSessionId,
			scopeId: "scope-a",
			title: "Other project note",
		});

		expect(getMemoryForMcp(store, greenroomId, { project: "greenroom" })?.title).toBe(
			"Greenroom default project note",
		);
		expect(getMemoryForMcp(store, otherId, { project: "greenroom" })).toBe(null);
	});

	it("refuses to forget unauthorized or explicitly filtered-out memories", () => {
		const authorizedId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-a",
			title: "Forgettable MCP note",
		});
		const hiddenId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-b",
			title: "Hidden forget target",
		});

		expect(forgetMemoryForMcp(store, hiddenId)).toBe(false);
		expect(readActive(store, hiddenId)).toBe(1);
		expect(forgetMemoryForMcp(store, authorizedId, { scope_id: "scope-b" })).toBe(false);
		expect(readActive(store, authorizedId)).toBe(1);

		expect(forgetMemoryForMcp(store, authorizedId)).toBe(true);
		expect(readActive(store, authorizedId)).toBe(0);
	});

	it("stamps remembered MCP memories with the resolved project scope", () => {
		insertProjectScopeMapping(store, {
			projectPattern: join(tmpDir, "greenroom"),
			scopeId: "scope-a",
		});

		const result = rememberMemoryForMcp(
			store,
			{
				kind: "decision",
				title: "MCP scoped remember",
				body: "Remembered through MCP with a mapped project scope.",
				confidence: 0.8,
				project: "greenroom",
			},
			{
				cwd: join(tmpDir, "greenroom"),
				user: "mcp-test",
				now: () => "2026-01-01T00:00:00.000Z",
			},
		);

		const row = store.db
			.prepare("SELECT scope_id FROM memory_items WHERE id = ?")
			.get(result.memId) as { scope_id: string };
		expect(row.scope_id).toBe("scope-a");
		expect(getMemoryForMcp(store, result.memId)?.title).toBe("MCP scoped remember");
	});

	it("uses the env project for memory_remember when no explicit project is supplied", () => {
		const result = rememberMemoryForMcp(
			store,
			{
				kind: "decision",
				title: "MCP env project remember",
				body: "Remembered through MCP without an explicit project argument.",
				confidence: 0.8,
			},
			{
				cwd: join(tmpDir, "greenroom"),
				user: "mcp-test",
				envProject: "greenroom",
				now: () => "2026-01-01T00:00:00.000Z",
			},
		);

		const row = store.db
			.prepare(
				`SELECT sessions.project AS project
				 FROM memory_items
				 JOIN sessions ON sessions.id = memory_items.session_id
				 WHERE memory_items.id = ?`,
			)
			.get(result.memId) as { project: string | null };
		expect(row.project).toBe("greenroom");
	});

	it("leaves the session project null when no explicit/env project is supplied", () => {
		// memory_remember intentionally does not inherit the server default project.
		// In stdio mode CODEMEM_PROJECT is often unset; the session row should record
		// project=null rather than silently stamping cwd/default.
		const result = rememberMemoryForMcp(
			store,
			{
				kind: "decision",
				title: "MCP null project remember",
				body: "Remembered through MCP without an explicit project argument.",
				confidence: 0.8,
			},
			{
				cwd: join(tmpDir, "greenroom"),
				user: "mcp-test",
				now: () => "2026-01-01T00:00:00.000Z",
			},
		);

		const row = store.db
			.prepare(
				`SELECT sessions.project AS project
				 FROM memory_items
				 JOIN sessions ON sessions.id = memory_items.session_id
				 WHERE memory_items.id = ?`,
			)
			.get(result.memId) as { project: string | null };
		expect(row.project).toBeNull();
	});

	it("normalizes blank project inputs to null on memory_remember", () => {
		// Blank explicit project and blank env project both resolve to null on writes,
		// matching pre-refactor semantics. Default project never fills in for writes.
		const explicitBlank = rememberMemoryForMcp(
			store,
			{
				kind: "decision",
				title: "MCP blank explicit project remember",
				body: "Remembered through MCP with blank explicit project input.",
				confidence: 0.8,
				project: "   ",
			},
			{
				cwd: join(tmpDir, "greenroom"),
				user: "mcp-test",
				now: () => "2026-01-01T00:00:00.000Z",
			},
		);
		const envBlank = rememberMemoryForMcp(
			store,
			{
				kind: "decision",
				title: "MCP blank env project remember",
				body: "Remembered through MCP with blank env project input.",
				confidence: 0.8,
			},
			{
				cwd: join(tmpDir, "greenroom"),
				user: "mcp-test",
				envProject: "   ",
				now: () => "2026-01-01T00:00:00.000Z",
			},
		);

		for (const id of [explicitBlank.memId, envBlank.memId]) {
			const row = store.db
				.prepare(
					`SELECT sessions.project AS project
					 FROM memory_items
					 JOIN sessions ON sessions.id = memory_items.session_id
					 WHERE memory_items.id = ?`,
				)
				.get(id) as { project: string | null };
			expect(row.project).toBeNull();
		}
	});

	it("rolls back remembered MCP memories that resolve to unauthorized scopes", () => {
		insertProjectScopeMapping(store, {
			projectPattern: join(tmpDir, "greenroom"),
			scopeId: "scope-b",
		});

		expect(() =>
			rememberMemoryForMcp(
				store,
				{
					kind: "decision",
					title: "Unauthorized MCP scoped remember",
					body: "This should not be persisted into an unauthorized scope.",
					confidence: 0.8,
					project: "greenroom",
				},
				{
					cwd: join(tmpDir, "greenroom"),
					user: "mcp-test",
					now: () => "2026-01-01T00:00:00.000Z",
				},
			),
		).toThrow("unauthorized_scope");
		expect(countMemoriesByTitle(store, "Unauthorized MCP scoped remember")).toBe(0);
	});

	it("surfaces unauthorized_scope as a stable error contract through memory_remember", async () => {
		// The `unauthorized_scope` string is part of the MCP tool error contract.
		// Any rename would silently break consumers that pattern-match on it, so
		// pin it from the registered tool boundary, not just the helper.
		// The tool handler uses process.cwd() for the session row, so the scope
		// mapping must match that path to force an unauthorized assignment.
		insertProjectScopeMapping(store, {
			projectPattern: process.cwd(),
			scopeId: "scope-b",
		});

		const server = createCodememMcpServer(store, { defaultProject: null });
		const remember = getTool(server, "memory_remember");
		const payload = parseToolJson(
			await remember.handler({
				kind: "decision",
				title: "Tool unauthorized scope",
				body: "Should never persist into an unauthorized scope.",
				confidence: 0.8,
			}),
		) as { error?: string; id?: number };

		expect(payload.error).toBe("unauthorized_scope");
		expect(payload.id).toBeUndefined();
		expect(countMemoriesByTitle(store, "Tool unauthorized scope")).toBe(0);
	});

	describe("registered MCP tool scope behavior (regression for #1119 reviewer P1s)", () => {
		// These tests exercise the *registered tool callbacks*, not the helpers,
		// because two prior reviewer P1s were behavior regressions visible only
		// at the tool boundary (direct-ID ops being silently default-project-scoped
		// and memory_expand losing its explicit-blank-project escape hatch).
		let otherSessionId: number;
		let greenroomId: number;
		let otherProjectId: number;

		beforeEach(() => {
			otherSessionId = insertSession(store.db, { cwd: join(tmpDir, "other"), project: "other" });
			greenroomId = insertScopedMemory(store, {
				sessionId,
				scopeId: "scope-a",
				title: "Greenroom direct-ID note",
			});
			otherProjectId = insertScopedMemory(store, {
				sessionId: otherSessionId,
				scopeId: "scope-a",
				title: "Other-project direct-ID note",
			});
		});

		it("memory_get returns an ID outside the server default project (B1 regression)", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const get = getTool(server, "memory_get");
			const result = parseToolJson(await get.handler({ memory_id: otherProjectId })) as {
				id?: number;
				title?: string;
				error?: string;
			};
			expect(result.error).toBeUndefined();
			expect(result.id).toBe(otherProjectId);
			expect(result.title).toBe("Other-project direct-ID note");
		});

		it("memory_get still honors an explicit project filter on direct-ID lookups", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const get = getTool(server, "memory_get");
			const result = parseToolJson(
				await get.handler({ memory_id: otherProjectId, project: "greenroom" }),
			) as { id?: number; error?: string };
			expect(result.error).toBe("not_found");
			expect(result.id).toBeUndefined();
		});

		it("memory_get_observations returns IDs outside the server default project (B1 regression)", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const getMany = getTool(server, "memory_get_observations");
			const result = parseToolJson(
				await getMany.handler({ ids: [greenroomId, otherProjectId] }),
			) as { items: Array<{ id: number }> };
			const ids = result.items.map((item) => item.id).toSorted((a, b) => a - b);
			expect(ids).toEqual([greenroomId, otherProjectId].toSorted((a, b) => a - b));
		});

		it("memory_forget removes an ID outside the server default project (B1 regression)", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const forget = getTool(server, "memory_forget");
			const result = parseToolJson(await forget.handler({ memory_id: otherProjectId })) as {
				status?: string;
				error?: string;
			};
			expect(result.status).toBe("ok");
			expect(readActive(store, otherProjectId)).toBe(0);
		});

		it("memory_expand with explicit blank project returns cross-project anchors (B2 regression)", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const expand = getTool(server, "memory_expand");
			const result = parseToolJson(
				await expand.handler({ ids: [otherProjectId], project: "" }),
			) as {
				anchors: Array<{ id: number; title: string }>;
				errors: Array<{ code: string }>;
				metadata: { project: string | null };
			};
			expect(result.metadata.project).toBeNull();
			expect(result.anchors.map((anchor) => anchor.id)).toEqual([otherProjectId]);
			expect(result.errors.some((err) => err.code === "PROJECT_MISMATCH")).toBe(false);
		});

		it("memory_expand still applies the default project when project is omitted", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const expand = getTool(server, "memory_expand");
			const result = parseToolJson(await expand.handler({ ids: [otherProjectId] })) as {
				anchors: Array<{ id: number }>;
				errors: Array<{ code: string; ids: number[] }>;
				metadata: { project: string | null };
			};
			expect(result.metadata.project).toBe("greenroom");
			expect(result.anchors).toEqual([]);
			const mismatch = result.errors.find((err) => err.code === "PROJECT_MISMATCH");
			expect(mismatch?.ids).toContain(otherProjectId);
		});

		it("records explicit MCP surfaces, effective filters, returned IDs, and delivery", async () => {
			const hiddenId = insertScopedMemory(store, {
				sessionId,
				scopeId: "scope-b",
				title: "Ledger scope target",
			});
			store.db
				.prepare("UPDATE memory_items SET title = ? WHERE id = ?")
				.run("Ledger scope target", greenroomId);
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const search = getTool(server, "memory_search");
			const response = parseToolJson(
				await search.handler(
					{ query: "Ledger scope target", scope_id: "scope-a", limit: 10 },
					{ requestId: "request-search-1", sessionId: "transport-session-1" },
				),
			) as { items: Array<{ id: number }> };

			expect(response.items.map((item) => item.id)).toContain(greenroomId);
			expect(response.items.map((item) => item.id)).not.toContain(hiddenId);
			const attempt = queryRetrievalAttempts(store.db, { surface: "mcp_search", limit: 1 })[0];
			if (!attempt) throw new Error("expected a recorded MCP search attempt");
			expect(attempt).toMatchObject({
				retrievalStatus: "succeeded",
				deliveryStatus: "handed_off",
				project: "greenroom",
				scopeId: "scope-a",
				mode: null,
				streamId: "transport-session-1",
				limitRequested: 10,
				filterSummary: { project: "greenroom", scope_id: "scope-a" },
			});
			expect(attempt.latencyMs).toBeGreaterThanOrEqual(0);
			expect(attempt.requestId).toMatch(/^[a-f0-9]{64}$/);
			expect(attempt.requestId).not.toContain("request-search-1");
			expect(attempt.exposures.map((exposure) => exposure.memoryId)).toContain(greenroomId);
			expect(attempt.exposures.map((exposure) => exposure.memoryId)).not.toContain(hiddenId);
			const persisted = JSON.stringify(
				store.db
					.prepare("SELECT * FROM retrieval_attempts WHERE attempt_id = ?")
					.get(attempt.attemptId),
			);
			expect(persisted).not.toContain("Ledger scope target");
			expect(persisted).not.toContain(`${tmpDir}/`);
		});

		it("records successful empty search, recent, and timeline calls as undelivered no-results", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			await getTool(server, "memory_search").handler({
				query: "no memory matches this exact query",
				project: "missing-project",
				limit: 5,
			});
			await getTool(server, "memory_recent").handler({ project: "missing-project", limit: 5 });
			await getTool(server, "memory_timeline").handler({
				query: "no timeline anchor matches this exact query",
				project: "missing-project",
				depth_before: 1,
				depth_after: 1,
			});

			for (const surface of ["mcp_search", "mcp_recent", "mcp_timeline"] as const) {
				const attempt = queryRetrievalAttempts(store.db, { surface, limit: 1 })[0];
				expect(attempt, surface).toMatchObject({
					retrievalStatus: "no_results",
					deliveryStatus: "not_attempted",
					candidateCount: 0,
					selectedCount: 0,
					exposures: [],
				});
			}
		});

		it("records missing memory_explain input as failed without changing its structured payload", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const response = parseToolJson(await getTool(server, "memory_explain").handler({}));

			expect(response).toEqual({
				items: [],
				missing_ids: [],
				errors: [
					{
						code: "INVALID_ARGUMENT",
						field: "query",
						message: "at least one of query or ids is required",
					},
				],
				metadata: {
					query: null,
					project: null,
					requested_ids_count: 0,
					returned_items_count: 0,
					include_pack_context: false,
				},
			});
			expect(
				queryRetrievalAttempts(store.db, { surface: "mcp_explain", limit: 1 })[0],
			).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				failureCode: "tool_failed",
				failureStage: "retrieval",
				exposures: [],
			});
		});

		it("records a valid empty memory_explain result as no-results", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const response = parseToolJson(
				await getTool(server, "memory_explain").handler({ ids: [999_999] }),
			) as { items: unknown[]; errors: Array<{ code: string }> };

			expect(response.items).toEqual([]);
			expect(response.errors.map((error) => error.code)).toEqual(["NOT_FOUND"]);
			expect(
				queryRetrievalAttempts(store.db, { surface: "mcp_explain", limit: 1 })[0],
			).toMatchObject({
				retrievalStatus: "no_results",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				failureCode: null,
				exposures: [],
			});
		});

		it("records invalid-only memory_explain ids as failed", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const response = parseToolJson(
				await getTool(server, "memory_explain").handler({ ids: [-1] }),
			) as { items: unknown[]; errors: Array<{ code: string; field: string }> };

			expect(response.items).toEqual([]);
			expect(response.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "INVALID_ARGUMENT", field: "ids" }),
					expect.objectContaining({ code: "INVALID_ARGUMENT", field: "query" }),
				]),
			);
			expect(
				queryRetrievalAttempts(store.db, { surface: "mcp_explain", limit: 1 })[0],
			).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				failureCode: "tool_failed",
				exposures: [],
			});
		});

		it("keeps partial memory_explain errors nonfatal when a memory is delivered", async () => {
			const filteredId = insertScopedMemory(store, {
				sessionId,
				scopeId: "scope-a",
				title: "Filtered explain note",
			});
			store.db.prepare("UPDATE memory_items SET kind = 'decision' WHERE id = ?").run(greenroomId);
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const response = parseToolJson(
				await getTool(server, "memory_explain").handler({
					ids: [greenroomId, filteredId, otherProjectId, 999_999, -1],
					kind: "decision",
				}),
			) as { items: Array<{ id: number }>; errors: Array<{ code: string }> };

			expect(response.items.map((item) => item.id)).toEqual([greenroomId]);
			expect(response.errors.map((error) => error.code)).toEqual([
				"INVALID_ARGUMENT",
				"NOT_FOUND",
				"PROJECT_MISMATCH",
				"FILTER_MISMATCH",
			]);
			expect(
				queryRetrievalAttempts(store.db, { surface: "mcp_explain", limit: 1 })[0],
			).toMatchObject({
				retrievalStatus: "succeeded",
				deliveryStatus: "handed_off",
				candidateCount: 1,
				selectedCount: 1,
				failureCode: null,
				exposures: [{ memoryId: greenroomId, handoffStatus: "handed_off" }],
			});
		});

		it("covers direct, observations, index, explain, recent, pack, timeline, and expand surfaces", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			await getTool(server, "memory_get").handler({ memory_id: otherProjectId });
			await getTool(server, "memory_get_observations").handler({
				ids: [greenroomId, otherProjectId],
			});
			await getTool(server, "memory_search_index").handler({ query: "direct-ID note", limit: 8 });
			await getTool(server, "memory_explain").handler({ ids: [greenroomId], limit: 10 });
			await getTool(server, "memory_recent").handler({ limit: 8 });
			await getTool(server, "memory_pack").handler({ context: "direct-ID note", limit: 5 });
			await getTool(server, "memory_timeline").handler({
				memory_id: greenroomId,
				depth_before: 1,
				depth_after: 1,
			});
			await getTool(server, "memory_expand").handler({
				ids: [otherProjectId],
				project: "",
				depth_before: 1,
				depth_after: 1,
				include_observations: false,
			});

			for (const surface of [
				"mcp_get",
				"mcp_get_observations",
				"mcp_search_index",
				"mcp_explain",
				"mcp_recent",
				"mcp_pack",
				"mcp_timeline",
				"mcp_expand",
			] as const) {
				const attempt = queryRetrievalAttempts(store.db, { surface, limit: 1 })[0];
				expect(attempt?.mode, surface).toBeNull();
				expect(attempt?.deliveryStatus, surface).toBe("handed_off");
			}

			const direct = queryRetrievalAttempts(store.db, { surface: "mcp_get", limit: 1 })[0];
			expect(direct?.project).toBeNull();
			expect(direct?.filterSummary).toBeNull();
			expect(direct?.exposures.map((exposure) => exposure.memoryId)).toEqual([otherProjectId]);
			const expand = queryRetrievalAttempts(store.db, { surface: "mcp_expand", limit: 1 })[0];
			expect(expand?.project).toBeNull();
		});

		it("keeps duplicate processing of one runtime invocation idempotent", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const get = getTool(server, "memory_get");
			const extra = requestExtra("retry-request-1", "transport-session-2");

			const first = await get.handler({ memory_id: greenroomId }, extra);
			const retry = await get.handler({ memory_id: greenroomId }, extra);
			expect(retry).toEqual(first);
			expect(queryRetrievalAttempts(store.db, { surface: "mcp_get" })).toHaveLength(1);
			const secondServer = createCodememMcpServer(store, { defaultProject: "greenroom" });
			await getTool(secondServer, "memory_get").handler(
				{ memory_id: greenroomId },
				requestExtra("retry-request-1", "transport-session-3"),
			);
			expect(queryRetrievalAttempts(store.db, { surface: "mcp_get" })).toHaveLength(2);

			expect(
				purgeRetrievalAttemptsForPrivacy(store.db, { source: "mcp", surface: "mcp_get" }),
			).toBe(2);
			expect(queryRetrievalAttempts(store.db, { surface: "mcp_get" })).toEqual([]);
		});

		it("records repeated completed calls with identical IDs and arguments as new attempts", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const get = getTool(server, "memory_get");

			await get.handler(
				{ memory_id: greenroomId },
				requestExtra("reused-success-id", "long-lived-session"),
			);
			await get.handler(
				{ memory_id: greenroomId },
				requestExtra("reused-success-id", "long-lived-session"),
			);
			await get.handler(
				{ memory_id: greenroomId },
				requestExtra("different-success-id", "long-lived-session"),
			);

			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_get" });
			expect(attempts).toHaveLength(3);
			expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(3);
			expect(new Set(attempts.map((attempt) => attempt.requestId)).size).toBe(3);
		});

		it("records repeated completed no-results calls as new attempts", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const search = getTool(server, "memory_search");
			const args = { query: "no repeated result exists", project: "missing-project", limit: 5 };

			await search.handler(args, requestExtra("reused-empty-id", "long-lived-empty-session"));
			await search.handler(args, requestExtra("reused-empty-id", "long-lived-empty-session"));

			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_search" });
			expect(attempts).toHaveLength(2);
			expect(attempts.every((attempt) => attempt.retrievalStatus === "no_results")).toBe(true);
			expect(new Set(attempts.map((attempt) => attempt.requestId)).size).toBe(2);
		});

		it("includes canonical call content when a transport session reuses a request ID", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const search = getTool(server, "memory_search");
			const recent = getTool(server, "memory_recent");
			const extra = requestExtra("reused-request-id", "long-lived-session");

			await search.handler({ query: "direct-ID note", limit: 5, project: "greenroom" }, extra);
			await search.handler({ project: "greenroom", limit: 5, query: "direct-ID note" }, extra);
			expect(queryRetrievalAttempts(store.db, { surface: "mcp_search" })).toHaveLength(1);

			await search.handler(
				{ query: "different call content", limit: 5, project: "greenroom" },
				extra,
			);
			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_search" });
			expect(attempts).toHaveLength(2);
			expect(new Set(attempts.map((attempt) => attempt.requestId)).size).toBe(2);

			await recent.handler({ limit: 5, project: "greenroom" }, extra);
			const recentAttempt = queryRetrievalAttempts(store.db, { surface: "mcp_recent" })[0];
			expect(recentAttempt?.requestId).toMatch(/^[a-f0-9]{64}$/);
			expect(attempts.map((attempt) => attempt.requestId)).not.toContain(recentAttempt?.requestId);
			for (const attempt of attempts) {
				expect(attempt.requestId).toMatch(/^[a-f0-9]{64}$/);
				expect(attempt.requestId).not.toContain("direct-ID note");
				expect(attempt.requestId).not.toContain("different call content");
			}
		});

		it("does not capture when MCP retrieval ledger capture is disabled", async () => {
			const server = createCodememMcpServer(store, {
				defaultProject: "greenroom",
				captureRetrievalLedger: false,
			});
			const result = parseToolJson(
				await getTool(server, "memory_get").handler({ memory_id: greenroomId }),
			) as { id: number };
			expect(result.id).toBe(greenroomId);
			expect(queryRetrievalAttempts(store.db, { surface: "mcp_get" })).toEqual([]);
		});

		it("records retrieval failures without changing the MCP error response", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			vi.spyOn(store, "search").mockImplementationOnce(() => {
				throw new Error("deterministic search failure");
			});
			const response = parseToolJson(
				await getTool(server, "memory_search").handler({ query: "failure", limit: 5 }),
			) as { error: string };
			expect(response.error).toBe("deterministic search failure");
			expect(
				queryRetrievalAttempts(store.db, { surface: "mcp_search", limit: 1 })[0],
			).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				failureCode: "tool_failed",
				filterSummary: { project: "greenroom" },
			});
		});

		it("keeps filter resolution failures inside the MCP fail-open boundary", async () => {
			const context = retrievalContext(store, "filter-resolution-scope");
			const retrieve = vi.fn(() => ({ value: null, memoryIds: [] }));
			const response = parseToolJson(
				await withMcpRetrieval(
					context,
					{
						surface: "mcp_search",
						toolName: "memory_search",
						toolArguments: { query: "failure" },
						query: "failure",
						resolveFilters: () => {
							throw new Error("filter resolution failed");
						},
					},
					retrieve,
				),
			) as { error: string };

			expect(response.error).toBe("filter resolution failed");
			expect(retrieve).not.toHaveBeenCalled();
			expect(
				queryRetrievalAttempts(store.db, { surface: "mcp_search", limit: 1 })[0],
			).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				filterSummary: null,
				failureCode: "tool_failed",
			});
		});

		it("reconciles a failed MCP request retry into the persisted handed-off success", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const search = getTool(server, "memory_search");
			const extra = requestExtra("failed-then-successful", "retry-session");
			const searchSpy = vi.spyOn(store, "search");
			searchSpy.mockImplementationOnce(() => {
				throw new Error("transient retrieval failure");
			});

			await search.handler(
				{ query: "direct-ID note", limit: 5 },
				requestExtra("failed-then-successful", "retry-session"),
			);
			const failed = queryRetrievalAttempts(store.db, { surface: "mcp_search" })[0];
			expect(failed).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				exposures: [],
			});

			await search.handler({ query: "direct-ID note", limit: 5 }, extra);
			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_search" });
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				attemptId: failed?.attemptId,
				retrievalStatus: "succeeded",
				deliveryStatus: "handed_off",
				failureCode: null,
			});
			expect(attempts[0]?.exposures.length).toBeGreaterThan(0);
			expect(
				attempts[0]?.exposures.every(
					(exposure) =>
						exposure.attemptId === attempts[0]?.attemptId &&
						exposure.handoffStatus === "handed_off",
				),
			).toBe(true);

			searchSpy.mockImplementationOnce(() => {
				throw new Error("later retrieval failure");
			});
			await search.handler(
				{ query: "direct-ID note", limit: 5 },
				requestExtra("failed-then-successful", "retry-session"),
			);
			const afterLaterFailure = queryRetrievalAttempts(store.db, { surface: "mcp_search" });
			expect(afterLaterFailure).toHaveLength(2);
			expect(afterLaterFailure).toContainEqual(attempts[0]);
			expect(afterLaterFailure.some((attempt) => attempt.retrievalStatus === "failed")).toBe(true);
		});

		it("reconciles a failed MCP request retry into one persisted no-results completion", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			const search = getTool(server, "memory_search");
			const args = {
				query: "no memory matches this exact retry query",
				project: "missing-project",
				limit: 5,
			};
			const extra = requestExtra("failed-then-empty", "empty-retry-session");
			const searchSpy = vi.spyOn(store, "search");
			searchSpy.mockImplementationOnce(() => {
				throw new Error("transient empty retrieval failure");
			});

			await search.handler(args, extra);
			const failed = queryRetrievalAttempts(store.db, { surface: "mcp_search" })[0];
			expect(failed).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				exposures: [],
			});

			await search.handler(args, requestExtra("failed-then-empty", "empty-retry-session"));
			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_search" });
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				attemptId: failed?.attemptId,
				retrievalStatus: "no_results",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				failureCode: null,
				exposures: [],
			});

			searchSpy.mockImplementationOnce(() => {
				throw new Error("later empty retrieval failure");
			});
			await search.handler(args, requestExtra("failed-then-empty", "empty-retry-session"));
			const afterLaterFailure = queryRetrievalAttempts(store.db, { surface: "mcp_search" });
			expect(afterLaterFailure).toHaveLength(2);
			expect(afterLaterFailure).toContainEqual(attempts[0]);
			expect(afterLaterFailure.some((attempt) => attempt.retrievalStatus === "failed")).toBe(true);
		});

		it("reconciles an exact failed retry when no results are encoded as not_found", async () => {
			const context = retrievalContext(store, "not-found-error-retry-scope");
			const args = { memory_id: 999_999 };
			const retrySignal = new AbortController().signal;
			const invoke = (
				signal: AbortSignal,
				retrieve: () => Promise<{ value: null; memoryIds: number[]; error?: string }>,
			) =>
				withMcpRetrieval(
					context,
					{
						surface: "mcp_get",
						toolName: "memory_get",
						toolArguments: args,
						requestId: "failed-then-not-found",
						sourceSessionId: "not-found-error-retry-session",
						invocationIdentity: signal,
					},
					retrieve,
				);

			await invoke(new AbortController().signal, async () => {
				throw new Error("transient direct lookup failure");
			});
			const failed = queryRetrievalAttempts(store.db, { surface: "mcp_get" })[0];
			expect(failed).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
			});

			const notFound = async () => ({ value: null, memoryIds: [], error: "not_found" });
			expect(parseToolJson(await invoke(retrySignal, notFound))).toEqual({ error: "not_found" });
			expect(parseToolJson(await invoke(retrySignal, notFound))).toEqual({ error: "not_found" });

			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_get" });
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				attemptId: failed?.attemptId,
				retrievalStatus: "no_results",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				failureCode: null,
				exposures: [],
			});
		});

		it("preserves ordinary error content as a failed retrieval", async () => {
			const context = retrievalContext(store, "error-content-scope");
			const signal = new AbortController().signal;
			const invoke = () =>
				withMcpRetrieval(
					context,
					{
						surface: "mcp_get",
						toolName: "memory_get",
						toolArguments: { memory_id: greenroomId },
						requestId: "ordinary-error-content",
						sourceSessionId: "ordinary-error-session",
						invocationIdentity: signal,
					},
					async () => ({
						value: null,
						memoryIds: [],
						error: "permission_denied",
					}),
				);

			expect(parseToolJson(await invoke())).toEqual({ error: "permission_denied" });
			expect(parseToolJson(await invoke())).toEqual({ error: "permission_denied" });

			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_get" });
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				failureCode: "tool_failed",
				failureStage: "retrieval",
				exposures: [],
			});
		});

		it("records an explicit empty failed status independently from response rendering", async () => {
			const context = retrievalContext(store, "explicit-failed-status-scope");
			const response = parseToolJson(
				await withMcpRetrieval(
					context,
					{
						surface: "mcp_explain",
						toolName: "memory_explain",
						toolArguments: {},
					},
					async () => ({
						value: { items: [], errors: [{ code: "INVALID_ARGUMENT", field: "query" }] },
						memoryIds: [],
						retrievalStatus: "failed",
					}),
				),
			);

			expect(response).toEqual({
				items: [],
				errors: [{ code: "INVALID_ARGUMENT", field: "query" }],
			});
			expect(
				queryRetrievalAttempts(store.db, { surface: "mcp_explain", limit: 1 })[0],
			).toMatchObject({
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				failureCode: "tool_failed",
				failureStage: "retrieval",
				exposures: [],
			});
		});

		it("does not let an explicit failed status override delivered memories", async () => {
			const context = retrievalContext(store, "delivered-status-scope");
			const response = parseToolJson(
				await withMcpRetrieval(
					context,
					{
						surface: "mcp_explain",
						toolName: "memory_explain",
						toolArguments: { ids: [greenroomId] },
					},
					async () => ({
						value: { items: [{ id: greenroomId }] },
						memoryIds: [greenroomId],
						retrievalStatus: "failed",
					}),
				),
			) as { items: Array<{ id: number }> };

			expect(response.items).toEqual([{ id: greenroomId }]);
			expect(
				queryRetrievalAttempts(store.db, { surface: "mcp_explain", limit: 1 })[0],
			).toMatchObject({
				retrievalStatus: "succeeded",
				deliveryStatus: "handed_off",
				candidateCount: 1,
				selectedCount: 1,
				failureCode: null,
			});
		});

		it("keeps concurrent identical successful invocations distinct", async () => {
			const context: ToolRegistrationContext = {
				store,
				defaultProject: () => "greenroom",
				envProject: () => null,
				captureRetrievalLedger: true,
				retrievalLedgerScopeId: "concurrent-ledger-scope",
				retrievalLedgerIdentityMode: "session",
			};
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const call = (signal: AbortSignal) =>
				withMcpRetrieval(
					context,
					{
						surface: "mcp_get",
						toolName: "memory_get",
						toolArguments: { memory_id: greenroomId },
						requestId: "concurrent-reused-id",
						sourceSessionId: "concurrent-session",
						invocationIdentity: signal,
					},
					async () => {
						await gate;
						return { value: { id: greenroomId }, memoryIds: [greenroomId] };
					},
				);

			const first = call(new AbortController().signal);
			const second = call(new AbortController().signal);
			release();
			await Promise.all([first, second]);

			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_get" });
			expect(attempts).toHaveLength(2);
			expect(new Set(attempts.map((attempt) => attempt.requestId)).size).toBe(2);
		});

		it("reconciles a concurrent failure after its successful sibling completes", async () => {
			const context = retrievalContext(store, "failure-success-race-scope");
			const args = { memory_id: greenroomId };
			let rejectFailure!: (error: Error) => void;
			let resolveSuccess!: () => void;
			const failureGate = new Promise<never>((_resolve, reject) => {
				rejectFailure = reject;
			});
			const successGate = new Promise<void>((resolve) => {
				resolveSuccess = resolve;
			});
			const invoke = (
				signal: AbortSignal,
				retrieve: () => Promise<{ value: object; memoryIds: number[] }>,
			) =>
				withMcpRetrieval(
					context,
					{
						surface: "mcp_get",
						toolName: "memory_get",
						toolArguments: args,
						requestId: "failure-success-race",
						sourceSessionId: "failure-success-session",
						invocationIdentity: signal,
					},
					retrieve,
				);

			const failedCall = invoke(new AbortController().signal, () => failureGate);
			const successfulSibling = invoke(new AbortController().signal, async () => {
				await successGate;
				return { value: { id: greenroomId }, memoryIds: [greenroomId] };
			});
			rejectFailure(new Error("concurrent transient failure"));
			await failedCall;
			const failedAttempt = queryRetrievalAttempts(store.db, { surface: "mcp_get" }).find(
				(attempt) => attempt.retrievalStatus === "failed",
			);
			if (!failedAttempt) throw new Error("expected concurrent failed attempt");
			resolveSuccess();
			await successfulSibling;

			await invoke(new AbortController().signal, async () => ({
				value: { id: greenroomId },
				memoryIds: [greenroomId],
			}));

			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_get" });
			expect(attempts).toHaveLength(2);
			expect(attempts.every((attempt) => attempt.retrievalStatus === "succeeded")).toBe(true);
			expect(getRetrievalAttempt(store.db, failedAttempt.attemptId)).toMatchObject({
				attemptId: failedAttempt.attemptId,
				retrievalStatus: "succeeded",
				deliveryStatus: "handed_off",
			});
		});

		it("reconciles two concurrent failures one-for-one with sequential successes", async () => {
			const context = retrievalContext(store, "two-failure-fifo-scope");
			const args = { memory_id: greenroomId };
			const invoke = (
				signal: AbortSignal,
				retrieve: () => Promise<{ value: object; memoryIds: number[] }>,
			) =>
				withMcpRetrieval(
					context,
					{
						surface: "mcp_get",
						toolName: "memory_get",
						toolArguments: args,
						requestId: "two-concurrent-failures",
						sourceSessionId: "two-failure-session",
						invocationIdentity: signal,
					},
					retrieve,
				);
			let rejectFirst!: (error: Error) => void;
			let rejectSecond!: (error: Error) => void;
			const firstGate = new Promise<never>((_resolve, reject) => {
				rejectFirst = reject;
			});
			const secondGate = new Promise<never>((_resolve, reject) => {
				rejectSecond = reject;
			});

			const firstFailure = invoke(new AbortController().signal, () => firstGate);
			const secondFailure = invoke(new AbortController().signal, () => secondGate);
			rejectFirst(new Error("first concurrent failure"));
			await firstFailure;
			const firstAttempt = queryRetrievalAttempts(store.db, { surface: "mcp_get" })[0];
			if (!firstAttempt) throw new Error("expected first concurrent failed attempt");
			rejectSecond(new Error("second concurrent failure"));
			await secondFailure;
			const secondAttempt = queryRetrievalAttempts(store.db, { surface: "mcp_get" }).find(
				(attempt) => attempt.attemptId !== firstAttempt.attemptId,
			);
			if (!secondAttempt) throw new Error("expected second concurrent failed attempt");

			const succeed = () =>
				invoke(new AbortController().signal, async () => ({
					value: { id: greenroomId },
					memoryIds: [greenroomId],
				}));
			await succeed();
			expect(getRetrievalAttempt(store.db, firstAttempt.attemptId)?.retrievalStatus).toBe(
				"succeeded",
			);
			expect(getRetrievalAttempt(store.db, secondAttempt.attemptId)?.retrievalStatus).toBe(
				"failed",
			);
			await succeed();

			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_get" });
			expect(attempts).toHaveLength(2);
			expect(attempts.every((attempt) => attempt.retrievalStatus === "succeeded")).toBe(true);
		});

		it("does not let completed active siblings consume or erase a pending failure", async () => {
			const context = retrievalContext(store, "pending-slot-ownership-scope");
			const args = { memory_id: greenroomId };
			let resolveSibling!: () => void;
			const siblingGate = new Promise<void>((resolve) => {
				resolveSibling = resolve;
			});
			const invoke = (retrieve: () => Promise<{ value: object; memoryIds: number[] }>) =>
				withMcpRetrieval(
					context,
					{
						surface: "mcp_get",
						toolName: "memory_get",
						toolArguments: args,
						requestId: "pending-slot-ownership",
						sourceSessionId: "pending-slot-session",
						invocationIdentity: new AbortController().signal,
					},
					retrieve,
				);

			const activeSibling = invoke(async () => {
				await siblingGate;
				return { value: { id: greenroomId }, memoryIds: [greenroomId] };
			});
			await invoke(async () => {
				throw new Error("failure while sibling active");
			});
			const failedAttempt = queryRetrievalAttempts(store.db, { surface: "mcp_get" }).find(
				(attempt) => attempt.retrievalStatus === "failed",
			);
			if (!failedAttempt) throw new Error("expected pending failed attempt");
			await invoke(async () => ({ value: { id: greenroomId }, memoryIds: [greenroomId] }));
			resolveSibling();
			await activeSibling;
			expect(getRetrievalAttempt(store.db, failedAttempt.attemptId)?.retrievalStatus).toBe(
				"failed",
			);

			await invoke(async () => ({ value: { id: greenroomId }, memoryIds: [greenroomId] }));
			expect(getRetrievalAttempt(store.db, failedAttempt.attemptId)?.retrievalStatus).toBe(
				"succeeded",
			);
			expect(queryRetrievalAttempts(store.db, { surface: "mcp_get" })).toHaveLength(3);
		});

		it("keeps successful MCP results fail-open when identity bookkeeping throws", async () => {
			const context = retrievalContext(store, "hostile-identity-scope");
			const circularArguments: { self?: unknown } = {};
			circularArguments.self = circularArguments;
			const result = parseToolJson(
				await withMcpRetrieval(
					context,
					{
						surface: "mcp_get",
						toolName: "memory_get",
						toolArguments: circularArguments,
						requestId: "hostile-canonical-args",
						sourceSessionId: "hostile-session",
						invocationIdentity: new AbortController().signal,
					},
					async () => ({ value: { id: greenroomId }, memoryIds: [greenroomId] }),
				),
			) as { id: number };
			expect(result.id).toBe(greenroomId);

			Object.defineProperty(context, "retrievalLedgerIdentityMode", {
				get: () => {
					throw new Error("hostile tracker mode getter");
				},
			});
			const second = parseToolJson(
				await withMcpRetrieval(
					context,
					{
						surface: "mcp_get",
						toolName: "memory_get",
						toolArguments: { memory_id: greenroomId },
						requestId: "hostile-completion",
						sourceSessionId: "hostile-session",
					},
					async () => ({ value: { id: greenroomId }, memoryIds: [greenroomId] }),
				),
			) as { id: number };
			expect(second.id).toBe(greenroomId);
			const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_get" });
			expect(attempts).toHaveLength(2);
			expect(attempts.every((attempt) => attempt.retrievalStatus === "succeeded")).toBe(true);
			expect(attempts.every((attempt) => attempt.failureCode === null)).toBe(true);
		});

		it("keeps MCP delivery fail-open when ledger tables are unavailable", async () => {
			const server = createCodememMcpServer(store, { defaultProject: "greenroom" });
			store.db.exec(
				"DROP TABLE attribution_assessment_evidence; DROP TABLE attribution_assessments; DROP TABLE retrieval_exposures; DROP TABLE retrieval_attempts;",
			);
			const response = parseToolJson(
				await getTool(server, "memory_get").handler({ memory_id: greenroomId }),
			) as { id: number };
			expect(response.id).toBe(greenroomId);
		});
	});
});

function insertSession(
	db: ReturnType<typeof connect>,
	input: { cwd: string; project: string },
): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
		)
		.run(now, input.cwd, input.project, "mcp-test", "test");
	return Number(info.lastInsertRowid);
}

function retrievalContext(store: MemoryStore, scopeId: string): ToolRegistrationContext {
	return {
		store,
		defaultProject: () => "greenroom",
		envProject: () => null,
		captureRetrievalLedger: true,
		retrievalLedgerScopeId: scopeId,
		retrievalLedgerIdentityMode: "session",
	};
}

function insertCoordinatorScope(db: ReturnType<typeof connect>, scopeId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR REPLACE INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 'coord-test', 'group-test', 0, 'active', ?, ?)`,
	).run(scopeId, scopeId, now, now);
}

function grantScopeToDevice(
	db: ReturnType<typeof connect>,
	scopeId: string,
	deviceId: string,
): void {
	insertCoordinatorScope(db, scopeId);
	db.prepare(
		`INSERT OR REPLACE INTO scope_memberships(
			scope_id, device_id, role, status, membership_epoch,
			coordinator_id, group_id, updated_at
		 ) VALUES (?, ?, 'member', 'active', 0, 'coord-test', 'group-test', ?)`,
	).run(scopeId, deviceId, new Date().toISOString());
}

function insertScopedMemory(
	store: MemoryStore,
	input: { sessionId: number; scopeId: string; title: string },
): number {
	const now = new Date().toISOString();
	const info = store.db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				tags_text, active, created_at, updated_at, metadata_json, rev, visibility, scope_id)
			 VALUES (?, 'discovery', ?, ?, 0.9, '', 1, ?, ?, '{}', 1, 'shared', ?)`,
		)
		.run(input.sessionId, input.title, `${input.title} body`, now, now, input.scopeId);
	return Number(info.lastInsertRowid);
}

function insertProjectScopeMapping(
	store: MemoryStore,
	input: { projectPattern: string; scopeId: string },
): void {
	const now = new Date().toISOString();
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
				project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 10, 'user', ?, ?)`,
		)
		.run(input.projectPattern, input.scopeId, now, now);
}

function readActive(store: MemoryStore, memoryId: number): number | null {
	const row = store.db.prepare("SELECT active FROM memory_items WHERE id = ?").get(memoryId) as
		| { active: number }
		| undefined;
	return row?.active ?? null;
}

function countMemoriesByTitle(store: MemoryStore, title: string): number {
	const row = store.db
		.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE title = ?")
		.get(title) as { count: number };
	return row.count;
}
