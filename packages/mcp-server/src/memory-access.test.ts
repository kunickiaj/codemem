import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema, MemoryStore, seedMixedScopeFixture } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodememMcpServer } from "./index.js";
import {
	forgetMemoryForMcp,
	getManyForMcp,
	getMemoryForMcp,
	rememberMemoryForMcp,
} from "./memory-access.js";

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
