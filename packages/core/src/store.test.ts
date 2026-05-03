import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, tableExists } from "./db.js";
import { buildFilterClauses, buildFilterClausesWithContext } from "./filters.js";
import { MemoryStore } from "./store.js";
import { setSyncDaemonPhase } from "./sync-daemon.js";
import { loadReplicationOpsSince } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import * as vectors from "./vectors.js";

// ---------------------------------------------------------------------------
// Helper: create a MemoryStore backed by a temp DB with test schema.
// We can't use the MemoryStore constructor directly because it calls
// assertSchemaReady which requires the schema to already exist. Instead,
// we pre-initialize the schema, then construct the store.
// ---------------------------------------------------------------------------

describe("MemoryStore", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let prevCodememConfig: string | undefined;
	let prevActorId: string | undefined;
	let prevActorDisplayName: string | undefined;
	let prevCrossSessionDedupWindowMs: string | undefined;
	let prevCodememDebug: string | undefined;

	beforeEach(() => {
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		prevActorId = process.env.CODEMEM_ACTOR_ID;
		prevActorDisplayName = process.env.CODEMEM_ACTOR_DISPLAY_NAME;
		prevCrossSessionDedupWindowMs = process.env.CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS;
		prevCodememDebug = process.env.CODEMEM_DEBUG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-store-test-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
		delete process.env.CODEMEM_ACTOR_ID;
		delete process.env.CODEMEM_ACTOR_DISPLAY_NAME;
		delete process.env.CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS;
		delete process.env.CODEMEM_DEBUG;
		dbPath = join(tmpDir, "test.sqlite");
		// Pre-create the schema so MemoryStore constructor's assertSchemaReady passes
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		// Now open via MemoryStore
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store?.close();
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		if (prevActorId === undefined) delete process.env.CODEMEM_ACTOR_ID;
		else process.env.CODEMEM_ACTOR_ID = prevActorId;
		if (prevActorDisplayName === undefined) delete process.env.CODEMEM_ACTOR_DISPLAY_NAME;
		else process.env.CODEMEM_ACTOR_DISPLAY_NAME = prevActorDisplayName;
		if (prevCrossSessionDedupWindowMs === undefined) {
			delete process.env.CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS;
		} else {
			process.env.CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS = prevCrossSessionDedupWindowMs;
		}
		if (prevCodememDebug === undefined) delete process.env.CODEMEM_DEBUG;
		else process.env.CODEMEM_DEBUG = prevCodememDebug;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// -- get ----------------------------------------------------------------

	describe("get", () => {
		it("returns null for non-existent memory", () => {
			expect(store.get(9999)).toBeNull();
		});

		it("returns a memory item with parsed metadata", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Test title", "Test body");

			const result = store.get(memId);
			expect(result).not.toBeNull();
			expect(result?.id).toBe(memId);
			expect(result?.kind).toBe("discovery");
			expect(result?.title).toBe("Test title");
			expect(result?.body_text).toBe("Test body");
			// metadata_json should be parsed into an object
			expect(typeof result?.metadata_json).toBe("object");
		});
	});

	// -- remember -----------------------------------------------------------

	describe("remember", () => {
		it("defaults deviceId to stable 'local' when sync_device is empty", () => {
			expect(store.deviceId).toBe("local");
			expect(store.actorId).toBe("local:local");
		});

		it("loads actor identity defaults from codemem config file", () => {
			store.close();
			writeFileSync(
				process.env.CODEMEM_CONFIG as string,
				JSON.stringify({ actor_id: "actor:config", actor_display_name: "Config User" }),
			);
			store = new MemoryStore(dbPath);

			expect(store.actorId).toBe("actor:config");
			expect(store.actorDisplayName).toBe("Config User");
		});

		it("lets env overrides win over config-backed actor identity", () => {
			store.close();
			writeFileSync(
				process.env.CODEMEM_CONFIG as string,
				JSON.stringify({ actor_id: "actor:config", actor_display_name: "Config User" }),
			);
			process.env.CODEMEM_ACTOR_ID = "actor:env";
			process.env.CODEMEM_ACTOR_DISPLAY_NAME = "Env User";
			store = new MemoryStore(dbPath);

			expect(store.actorId).toBe("actor:env");
			expect(store.actorDisplayName).toBe("Env User");
		});

		it("inserts a memory item and returns the ID", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "feature", "My Feature", "Feature body", 0.8);

			expect(memId).toBeGreaterThan(0);

			const row = store.get(memId);
			expect(row).not.toBeNull();
			expect(row?.kind).toBe("feature");
			expect(row?.title).toBe("My Feature");
			expect(row?.body_text).toBe("Feature body");
			expect(row?.confidence).toBe(0.8);
			expect(row?.active).toBe(1);
			expect(row?.rev).toBe(1);
			expect(row?.deleted_at).toBeNull();
		});

		it("redacts secrets in title, body, and metadata before persisting", () => {
			const sessionId = insertTestSession(store.db);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const awsId = "AKIAIOSFODNN7EXAMPLE";
			const memId = store.remember(
				sessionId,
				"discovery",
				`Found token ${pat} in config`,
				`Body has ${awsId} embedded`,
				0.5,
				undefined,
				{ password: "supersecretvalue123", note: "harmless" },
			);

			const row = store.get(memId);
			expect(row?.title).toContain("[REDACTED:github_pat_classic]");
			expect(row?.title).not.toContain(pat);
			expect(row?.body_text).toContain("[REDACTED:aws_access_key_id]");
			expect(row?.body_text).not.toContain(awsId);
			const meta = row?.metadata_json as Record<string, unknown>;
			expect(meta.password).toBe("[REDACTED:context_secret]");
			expect(meta.note).toBe("harmless");
		});

		it("redacts secrets in tags before persisting", () => {
			const sessionId = insertTestSession(store.db);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const memId = store.remember(sessionId, "discovery", "Title", "Body", 0.5, ["safe-tag", pat]);
			const row = store.get(memId);
			expect(row?.tags_text).toContain("[REDACTED:github_pat_classic]");
			expect(row?.tags_text).toContain("safe-tag");
			expect(row?.tags_text).not.toContain(pat);
		});

		it("applies workspace-config secret_scanner rules to local writes", () => {
			store.close();
			writeFileSync(
				process.env.CODEMEM_CONFIG as string,
				JSON.stringify({
					secret_scanner: {
						rules: [{ kind: "internal_acme_token", pattern: "\\bACME-[A-Z0-9]{10}\\b" }],
						allowlist: ["AKIAFAKEFIXTURE0001"],
					},
				}),
			);
			store = new MemoryStore(dbPath);
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(
				sessionId,
				"discovery",
				"workspace title with ACME-AB12CD34EF token",
				"Body has AKIAFAKEFIXTURE0001 fixture and AKIAIOSFODNN7EXAMPLE real",
			);
			const row = store.get(memId);
			// Workspace rule fires
			expect(row?.title).toContain("[REDACTED:internal_acme_token]");
			expect(row?.title).not.toContain("ACME-AB12CD34EF");
			// Allowlist entry passes through
			expect(row?.body_text).toContain("AKIAFAKEFIXTURE0001");
			// Default rules still active for everything else
			expect(row?.body_text).toContain("[REDACTED:aws_access_key_id]");
			expect(row?.body_text).not.toContain("AKIAIOSFODNN7EXAMPLE");
		});

		it("never persists original secrets to the replication_ops payload", () => {
			const sessionId = insertTestSession(store.db);
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const awsId = "AKIAIOSFODNN7EXAMPLE";
			const memId = store.remember(
				sessionId,
				"discovery",
				`title with ${pat}`,
				`body with ${awsId}`,
				0.5,
				[pat],
				{ password: "supersecretvalue123" },
			);
			expect(memId).toBeGreaterThan(0);

			const ops = store.db
				.prepare("SELECT payload_json FROM replication_ops WHERE entity_type = 'memory_item'")
				.all() as Array<{ payload_json: string | null }>;
			expect(ops.length).toBeGreaterThan(0);
			for (const op of ops) {
				const payload = op.payload_json ?? "";
				expect(payload).not.toContain(pat);
				expect(payload).not.toContain(awsId);
				expect(payload).not.toContain("supersecretvalue123");
			}
		});

		it("stamps local-default scope on new memory and replication op by default", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "feature", "Scoped default", "Feature body");

			const memory = store.db
				.prepare("SELECT import_key, scope_id FROM memory_items WHERE id = ?")
				.get(memId) as { import_key: string; scope_id: string | null };
			expect(memory.scope_id).toBe("local-default");

			const op = store.db
				.prepare("SELECT scope_id, payload_json FROM replication_ops WHERE entity_id = ?")
				.get(memory.import_key) as { scope_id: string | null; payload_json: string };
			expect(op.scope_id).toBe("local-default");
			expect(JSON.parse(op.payload_json).scope_id).toBe("local-default");
		});

		it("stamps mapped scope on new memory and replication op", () => {
			const sessionId = insertTestSession(store.db);
			store.db
				.prepare("UPDATE sessions SET cwd = ?, project = ? WHERE id = ?")
				.run("/work/acme/service", "service", sessionId);
			store.db
				.prepare(
					`INSERT INTO project_scope_mappings(
						workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"/work/acme/service",
					"/work/acme/*",
					"acme-work",
					10,
					"user",
					"2026-05-01T00:00:00Z",
					"2026-05-01T00:00:00Z",
				);

			const memId = store.remember(sessionId, "feature", "Scoped mapped", "Feature body");
			const memory = store.db
				.prepare("SELECT import_key, scope_id FROM memory_items WHERE id = ?")
				.get(memId) as { import_key: string; scope_id: string | null };
			expect(memory.scope_id).toBe("acme-work");

			const op = store.db
				.prepare("SELECT scope_id, payload_json FROM replication_ops WHERE entity_id = ?")
				.get(memory.import_key) as { scope_id: string | null; payload_json: string };
			expect(op.scope_id).toBe("acme-work");
			expect(JSON.parse(op.payload_json).scope_id).toBe("acme-work");
		});

		it("reassigns memory scope with an old-scope tombstone and new-scope upsert", () => {
			const sessionId = insertTestSession(store.db);
			store.db
				.prepare(
					`INSERT INTO replication_scopes(
						scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
					 ) VALUES (?, ?, 'team', 'local', 0, 'active', ?, ?)`,
				)
				.run("acme-work", "Acme Work", "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z");

			const memId = store.remember(sessionId, "feature", "Scoped reassignment", "Feature body");
			const before = store.db
				.prepare("SELECT import_key, scope_id, rev FROM memory_items WHERE id = ?")
				.get(memId) as { import_key: string; scope_id: string | null; rev: number };
			expect(before.scope_id).toBe("local-default");

			const updated = store.reassignMemoryScope(memId, "acme-work");

			expect(updated.scope_id).toBe("acme-work");
			expect(updated.rev).toBe(before.rev + 2);
			expect(updated.metadata_json).toMatchObject({
				last_scope_reassignment: {
					old_scope_id: "local-default",
					new_scope_id: "acme-work",
				},
			});
			const ops = store.db
				.prepare(`SELECT op_id, op_type, clock_rev, scope_id, payload_json, created_at
					 FROM replication_ops
					 WHERE entity_id = ?
					 ORDER BY clock_rev ASC, op_type ASC`)
				.all(before.import_key) as Array<{
				op_id: string;
				op_type: string;
				clock_rev: number;
				scope_id: string | null;
				payload_json: string | null;
				created_at: string;
			}>;

			expect(ops).toHaveLength(3);
			expect(ops[0]).toEqual(
				expect.objectContaining({ op_type: "upsert", clock_rev: 1, scope_id: "local-default" }),
			);
			expect(ops[1]).toEqual(
				expect.objectContaining({ op_type: "delete", clock_rev: 2, scope_id: "local-default" }),
			);
			expect(ops[1]?.payload_json).toBeNull();
			expect(ops[2]).toEqual(
				expect.objectContaining({ op_type: "upsert", clock_rev: 3, scope_id: "acme-work" }),
			);
			expect(JSON.parse(ops[2]?.payload_json ?? "{}").scope_id).toBe("acme-work");

			const reassignmentStreamOps = ops
				.filter((op) => op.clock_rev > before.rev)
				.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.op_id.localeCompare(b.op_id));
			expect(reassignmentStreamOps).toHaveLength(2);
			expect(reassignmentStreamOps.map((op) => op.op_type)).toEqual(["delete", "upsert"]);
			const [deleteStreamOp, upsertStreamOp] = reassignmentStreamOps;
			if (!deleteStreamOp || !upsertStreamOp) throw new Error("expected reassignment pair");
			expect(deleteStreamOp.created_at).toBe(upsertStreamOp.created_at);
			expect(deleteStreamOp.op_id < upsertStreamOp.op_id).toBe(true);
			const [sameTimestampOps] = loadReplicationOpsSince(
				store.db,
				`${deleteStreamOp.created_at}|zzzzzzzz`,
				10,
			);
			expect(sameTimestampOps.map((op) => op.op_type)).toEqual(["delete", "upsert"]);
		});

		it("generates an import_key when not provided", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const row = store.get(memId);
			expect(row?.import_key).toBeTruthy();
			expect(typeof row?.import_key).toBe("string");
		});

		it("preserves provided import_key in metadata", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body", 0.5, undefined, {
				import_key: "custom-key-123",
			});

			const row = store.get(memId);
			expect(row?.import_key).toBe("custom-key-123");
		});

		it("validates and normalizes memory kind", () => {
			const sessionId = insertTestSession(store.db);
			// Accepts valid kind
			const memId = store.remember(sessionId, "  Discovery  ", "Title", "Body");
			const row = store.get(memId);
			expect(row?.kind).toBe("discovery");
		});

		it("rejects invalid memory kind", () => {
			const sessionId = insertTestSession(store.db);
			expect(() => store.remember(sessionId, "yolo", "Title", "Body")).toThrow(
				/Invalid memory kind/,
			);
		});

		it("succeeds with empty title", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "", "Body with empty title");
			expect(memId).toBeGreaterThan(0);

			const row = store.get(memId);
			expect(row).not.toBeNull();
			expect(row?.title).toBe("");
			expect(row?.body_text).toBe("Body with empty title");
		});

		it("rejects invalid kind with descriptive error including valid kinds", () => {
			const sessionId = insertTestSession(store.db);
			try {
				store.remember(sessionId, "made_up_kind", "Title", "Body");
				expect.unreachable("should have thrown");
			} catch (e) {
				const msg = (e as Error).message;
				expect(msg).toMatch(/Invalid memory kind/);
				expect(msg).toContain("made_up_kind");
			}
		});

		it("sets clock_device_id in metadata", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");
			const row = store.get(memId);
			expect(row?.metadata_json.clock_device_id).toBe(store.deviceId);
		});

		it("sets origin_device_id", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");
			const row = store.get(memId);
			expect(row?.origin_device_id).toBe(store.deviceId);
		});

		it("sorts and deduplicates tags", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "T", "B", 0.5, [
				"beta",
				"alpha",
				"beta",
			]);

			const row = store.get(memId);
			expect(row?.tags_text).toBe("alpha beta");
		});

		it("kicks off vector storage after remembering a memory", () => {
			const storeVectorsSpy = vi.spyOn(vectors, "storeVectors").mockResolvedValue();
			try {
				const sessionId = insertTestSession(store.db);
				const memId = store.remember(sessionId, "feature", "Vector title", "Vector body");

				expect(storeVectorsSpy).toHaveBeenCalledTimes(1);
				expect(storeVectorsSpy).toHaveBeenCalledWith(
					store.db,
					memId,
					"Vector title",
					"Vector body",
				);
			} finally {
				storeVectorsSpy.mockRestore();
			}
		});

		it("does not fail remember when vector storage fails", () => {
			const storeVectorsSpy = vi
				.spyOn(vectors, "storeVectors")
				.mockRejectedValue(new Error("embedding unavailable"));
			try {
				const sessionId = insertTestSession(store.db);
				expect(() =>
					store.remember(sessionId, "feature", "Resilient title", "Resilient body"),
				).not.toThrow();
			} finally {
				storeVectorsSpy.mockRestore();
			}
		});

		it("does not launch vector writes from inside an open transaction", () => {
			const storeVectorsSpy = vi.spyOn(vectors, "storeVectors").mockResolvedValue();
			try {
				const sessionId = insertTestSession(store.db);
				store.db.transaction(() => {
					store.remember(sessionId, "feature", "Tx title", "Tx body");
					expect(storeVectorsSpy).not.toHaveBeenCalled();
				})();
				expect(storeVectorsSpy).not.toHaveBeenCalled();
			} finally {
				storeVectorsSpy.mockRestore();
			}
		});

		it("returns the existing id for same-session duplicate normalized titles", () => {
			const sessionId = insertTestSession(store.db);
			const firstId = store.remember(
				sessionId,
				"feature",
				"PR #123 Sync pass orchestrator ported to TypeScript",
				"Original body",
			);
			const duplicateId = store.remember(
				sessionId,
				"feature",
				"Sync pass orchestrator ported to TypeScript",
				"Duplicate body",
			);

			expect(duplicateId).toBe(firstId);
			const count = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
				count: number;
			};
			expect(count.count).toBe(1);
		});

		it("returns same-session duplicates when legacy scope is missing", () => {
			const nullScopeSessionId = insertTestSession(store.db);
			const nullScopeId = store.remember(
				nullScopeSessionId,
				"feature",
				"Legacy null scope title",
				"Original body",
			);
			store.db.prepare("UPDATE memory_items SET scope_id = NULL WHERE id = ?").run(nullScopeId);

			const nullScopeDuplicateId = store.remember(
				nullScopeSessionId,
				"feature",
				"Legacy null scope title",
				"Duplicate body",
			);

			const emptyScopeSessionId = insertTestSession(store.db);
			const emptyScopeId = store.remember(
				emptyScopeSessionId,
				"feature",
				"Legacy empty scope title",
				"Original body",
			);
			store.db.prepare("UPDATE memory_items SET scope_id = '' WHERE id = ?").run(emptyScopeId);

			const emptyScopeDuplicateId = store.remember(
				emptyScopeSessionId,
				"feature",
				"Legacy empty scope title",
				"Duplicate body",
			);

			expect(nullScopeDuplicateId).toBe(nullScopeId);
			expect(emptyScopeDuplicateId).toBe(emptyScopeId);
			const count = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
				count: number;
			};
			expect(count.count).toBe(2);
		});

		it("logs same-session dedup hits when CODEMEM_DEBUG=1", () => {
			process.env.CODEMEM_DEBUG = "1";
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				const sessionId = insertTestSession(store.db);
				const firstId = store.remember(sessionId, "feature", "Same session title", "Original body");
				const duplicateId = store.remember(
					sessionId,
					"feature",
					"Same session title",
					"Duplicate body",
				);

				expect(duplicateId).toBe(firstId);
				expect(stderrSpy).toHaveBeenCalledWith(
					expect.stringContaining("[codemem] memory dedup hit scope=same_session"),
				);
			} finally {
				stderrSpy.mockRestore();
			}
		});

		it("returns the existing id for same-session duplicates when normalization strips the title", () => {
			const sessionId = insertTestSession(store.db);
			const firstId = store.remember(sessionId, "feature", "PR #77", "Original body");
			const duplicateId = store.remember(sessionId, "feature", "PR #77", "Duplicate body");

			expect(duplicateId).toBe(firstId);
			const count = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
				count: number;
			};
			expect(count.count).toBe(1);
		});

		it("returns the existing id for cross-session duplicates within the default window", () => {
			const sessionA = insertTestSession(store.db);
			const sessionB = insertTestSession(store.db);
			const firstId = store.remember(
				sessionA,
				"discovery",
				"Issue #649 Context inspector stale query state",
				"Original body",
				0.9,
			);
			const duplicateId = store.remember(
				sessionB,
				"discovery",
				"Context inspector stale query state",
				"Duplicate body",
				0.5,
			);

			expect(duplicateId).toBe(firstId);
			const count = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
				count: number;
			};
			expect(count.count).toBe(1);
		});

		it("does not dedup duplicate titles across different scopes", () => {
			const sessionA = insertTestSession(store.db);
			const sessionB = insertTestSession(store.db);
			store.db
				.prepare("UPDATE sessions SET cwd = ?, project = ? WHERE id = ?")
				.run("/work/acme/service", "service", sessionA);
			store.db
				.prepare("UPDATE sessions SET cwd = ?, project = ? WHERE id = ?")
				.run("/oss/codemem", "codemem", sessionB);
			store.db
				.prepare(
					`INSERT INTO project_scope_mappings(
						workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"/work/acme/service",
					"/work/acme/*",
					"acme-work",
					10,
					"user",
					"2026-05-01T00:00:00Z",
					"2026-05-01T00:00:00Z",
					"/oss/codemem",
					"/oss/*",
					"oss-codemem",
					10,
					"user",
					"2026-05-01T00:00:00Z",
					"2026-05-01T00:00:00Z",
				);

			const firstId = store.remember(sessionA, "discovery", "Shared title", "Original body", 0.9);
			const secondId = store.remember(sessionB, "discovery", "Shared title", "Duplicate body", 0.5);

			expect(secondId).not.toBe(firstId);
			const scopes = store.db
				.prepare("SELECT scope_id FROM memory_items ORDER BY id")
				.all() as Array<{ scope_id: string | null }>;
			expect(scopes).toEqual([{ scope_id: "acme-work" }, { scope_id: "oss-codemem" }]);
		});

		it("logs cross-session dedup hits when CODEMEM_DEBUG=1", () => {
			process.env.CODEMEM_DEBUG = "1";
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				const sessionA = insertTestSession(store.db);
				const sessionB = insertTestSession(store.db);
				const firstId = store.remember(
					sessionA,
					"discovery",
					"Cross session title",
					"Original body",
					0.9,
				);
				const duplicateId = store.remember(
					sessionB,
					"discovery",
					"Cross session title",
					"Duplicate body",
					0.5,
				);

				expect(duplicateId).toBe(firstId);
				expect(stderrSpy).toHaveBeenCalledWith(
					expect.stringContaining("[codemem] memory dedup hit scope=cross_session"),
				);
			} finally {
				stderrSpy.mockRestore();
			}
		});

		it("inserts a new row for cross-session duplicates outside the dedup window", () => {
			const sessionA = insertTestSession(store.db);
			const sessionB = insertTestSession(store.db);
			const firstId = store.remember(
				sessionA,
				"discovery",
				"Duplicate title",
				"Original body",
				0.9,
			);
			store.db
				.prepare("UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?")
				.run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", firstId);

			const secondId = store.remember(sessionB, "discovery", "Duplicate title", "New body", 0.5);

			expect(secondId).not.toBe(firstId);
			const count = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
				count: number;
			};
			expect(count.count).toBe(2);
		});

		it("disables cross-session dedup when the window env var is 0", () => {
			store.close();
			process.env.CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS = "0";
			store = new MemoryStore(dbPath);

			const sessionA = insertTestSession(store.db);
			const sessionB = insertTestSession(store.db);
			const firstId = store.remember(
				sessionA,
				"discovery",
				"Duplicate title",
				"Original body",
				0.9,
			);
			const secondId = store.remember(sessionB, "discovery", "Duplicate title", "New body", 0.5);

			expect(secondId).not.toBe(firstId);
			const count = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
				count: number;
			};
			expect(count.count).toBe(2);
		});

		it("clamps absurdly large cross-session dedup windows instead of throwing", () => {
			store.close();
			process.env.CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS = "9000000000000000";
			store = new MemoryStore(dbPath);

			const sessionA = insertTestSession(store.db);
			const sessionB = insertTestSession(store.db);

			expect(() => {
				store.remember(sessionA, "discovery", "Large window title", "Original body", 0.9);
				store.remember(sessionB, "discovery", "Large window title", "Duplicate body", 0.5);
			}).not.toThrow();
		});

		it("does not dedup across different kinds even with the same normalized title", () => {
			const sessionA = insertTestSession(store.db);
			const sessionB = insertTestSession(store.db);
			const firstId = store.remember(
				sessionA,
				"discovery",
				"Duplicate title",
				"Original body",
				0.9,
			);
			const secondId = store.remember(
				sessionB,
				"session_summary",
				"Duplicate title",
				"Summary body",
				0.5,
			);

			expect(secondId).not.toBe(firstId);
			const count = store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as {
				count: number;
			};
			expect(count.count).toBe(2);
		});

		it("returns the existing id before shared-write blocking when a duplicate already exists", () => {
			const sessionId = insertTestSession(store.db);
			const firstId = store.remember(sessionId, "discovery", "Shared duplicate", "Body", 0.5, [], {
				visibility: "shared",
			});

			setSyncDaemonPhase(store.db, "needs_attention");

			expect(
				store.remember(sessionId, "discovery", "Shared duplicate", "Body changed", 0.5, [], {
					visibility: "shared",
				}),
			).toBe(firstId);
		});

		it("intentionally prefers the first row when normalized titles match but bodies differ", () => {
			const sessionA = insertTestSession(store.db);
			const sessionB = insertTestSession(store.db);
			const firstId = store.remember(
				sessionA,
				"discovery",
				"PR #321 observer narrative persistence",
				"First body",
				0.9,
			);
			const duplicateId = store.remember(
				sessionB,
				"discovery",
				"Observer narrative persistence",
				"Second body with different details",
				0.4,
			);

			expect(duplicateId).toBe(firstId);
			const row = store.get(firstId);
			expect(row?.body_text).toBe("First body");
		});

		it("does not log dedup hits by default", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				const sessionId = insertTestSession(store.db);
				store.remember(sessionId, "feature", "Silent dedup title", "Original body");
				store.remember(sessionId, "feature", "Silent dedup title", "Duplicate body");

				expect(stderrSpy).not.toHaveBeenCalled();
			} finally {
				stderrSpy.mockRestore();
			}
		});

		it("populates memory_file_refs for files_read and files_modified", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "File refs test", "Body", 0.5, [], {
				files_read: ["src/auth.ts", "src/config.ts"],
				files_modified: ["src/auth.ts"],
			});

			const fileRefs = store.db
				.prepare("SELECT * FROM memory_file_refs WHERE memory_id = ? ORDER BY file_path, relation")
				.all(memId) as Array<{ memory_id: number; file_path: string; relation: string }>;

			expect(fileRefs).toHaveLength(3);
			expect(fileRefs).toContainEqual({
				memory_id: memId,
				file_path: "src/auth.ts",
				relation: "read",
			});
			expect(fileRefs).toContainEqual({
				memory_id: memId,
				file_path: "src/config.ts",
				relation: "read",
			});
			expect(fileRefs).toContainEqual({
				memory_id: memId,
				file_path: "src/auth.ts",
				relation: "modified",
			});
		});

		it("populates memory_concept_refs with normalized concepts", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Concept refs test", "Body", 0.5, [], {
				concepts: ["Auth", "security", " oauth "],
			});

			const conceptRefs = store.db
				.prepare("SELECT * FROM memory_concept_refs WHERE memory_id = ? ORDER BY concept")
				.all(memId) as Array<{ memory_id: number; concept: string }>;

			expect(conceptRefs).toHaveLength(3);
			expect(conceptRefs).toContainEqual({ memory_id: memId, concept: "auth" });
			expect(conceptRefs).toContainEqual({ memory_id: memId, concept: "security" });
			expect(conceptRefs).toContainEqual({ memory_id: memId, concept: "oauth" });
		});

		it("creates no ref rows when files and concepts are null or empty", () => {
			const sessionId = insertTestSession(store.db);
			// No metadata at all
			const memId1 = store.remember(sessionId, "discovery", "No refs test 1", "Body");
			// Empty arrays
			const memId2 = store.remember(sessionId, "discovery", "No refs test 2", "Body", 0.5, [], {
				files_read: [],
				files_modified: [],
				concepts: [],
			});

			for (const memId of [memId1, memId2]) {
				const fileRefs = store.db
					.prepare("SELECT * FROM memory_file_refs WHERE memory_id = ?")
					.all(memId);
				const conceptRefs = store.db
					.prepare("SELECT * FROM memory_concept_refs WHERE memory_id = ?")
					.all(memId);
				expect(fileRefs).toHaveLength(0);
				expect(conceptRefs).toHaveLength(0);
			}
		});

		it("rolls back memory_items insert when ref population fails", () => {
			const sessionId = insertTestSession(store.db);

			// Sabotage the memory_file_refs table so INSERT OR IGNORE still throws
			store.db.exec("DROP TABLE memory_file_refs");

			expect(() =>
				store.remember(sessionId, "discovery", "Rollback test", "Body", 0.5, [], {
					files_read: ["src/oops.ts"],
				}),
			).toThrow();

			// The memory_items insert should have been rolled back
			const row = store.db
				.prepare("SELECT id FROM memory_items WHERE title = ?")
				.get("Rollback test");
			expect(row).toBeUndefined();
		});
	});

	// -- forget --------------------------------------------------------------

	describe("memoryOwnedBySelf", () => {
		it("returns false (without throwing) when sync_peers table is unavailable", () => {
			store.db.prepare("DROP TABLE IF EXISTS sync_peers").run();

			expect(() =>
				store.memoryOwnedBySelf({
					actor_id: "legacy-sync:peer-missing",
					origin_device_id: "peer-missing",
					metadata: {},
				}),
			).not.toThrow();
			expect(
				store.memoryOwnedBySelf({
					actor_id: "legacy-sync:peer-missing",
					origin_device_id: "peer-missing",
					metadata: {},
				}),
			).toBe(false);
		});

		it("returns true for claimed same-actor peer origin_device_id", () => {
			store.db
				.prepare(
					"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, ?)",
				)
				.run("peer-claimed-1", store.actorId, 1, "2026-01-01T00:00:00Z");

			expect(
				store.memoryOwnedBySelf({
					actor_id: null,
					origin_device_id: "peer-claimed-1",
					metadata: {},
				}),
			).toBe(true);
		});

		it("returns true for legacy-sync actor IDs tied to claimed peers", () => {
			store.db
				.prepare(
					"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, ?)",
				)
				.run("peer-claimed-2", store.actorId, 1, "2026-01-01T00:00:00Z");

			expect(
				store.memoryOwnedBySelf({
					actor_id: "legacy-sync:peer-claimed-2",
					origin_device_id: null,
					metadata: {},
				}),
			).toBe(true);
		});

		it("reads actor/origin ownership from metadata when top-level fields are absent", () => {
			store.db
				.prepare(
					"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, ?)",
				)
				.run("peer-claimed-3", store.actorId, 1, "2026-01-01T00:00:00Z");

			expect(
				store.memoryOwnedBySelf({
					metadata: {
						actor_id: "legacy-sync:peer-claimed-3",
						origin_device_id: "peer-claimed-3",
					},
				}),
			).toBe(true);
		});

		it("does not re-query sync_peers on every call when invoked in a hot loop", () => {
			store.db
				.prepare(
					"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, ?)",
				)
				.run("peer-cache-1", store.actorId, 1, "2026-01-01T00:00:00Z");

			// First call seeds the cache. Subsequent calls hit the cache and
			// must not re-issue SELECTs against sync_peers — the previous
			// implementation issued two per call which blocked the libuv
			// event loop on large stores.
			expect(
				store.memoryOwnedBySelf({
					origin_device_id: "peer-cache-1",
					metadata: {},
				}),
			).toBe(true);

			const spy = vi.spyOn(store, "sameActorPeerIds");
			try {
				for (let index = 0; index < 50; index += 1) {
					store.memoryOwnedBySelf({
						origin_device_id: "peer-cache-1",
						metadata: {},
					});
				}
				expect(spy).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		});

		it("invalidateOwnershipCache forces the next call to re-query sync_peers", () => {
			// Prime the cache without any peers configured so isolated callers
			// see "not owned" first.
			expect(
				store.memoryOwnedBySelf({
					origin_device_id: "peer-cache-2",
					metadata: {},
				}),
			).toBe(false);

			// Add a claimed peer after the cache was seeded; without
			// invalidation the cached negative result would survive its TTL.
			store.db
				.prepare(
					"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, ?)",
				)
				.run("peer-cache-2", store.actorId, 1, "2026-01-01T00:00:00Z");

			store.invalidateOwnershipCache();

			expect(
				store.memoryOwnedBySelf({
					origin_device_id: "peer-cache-2",
					metadata: {},
				}),
			).toBe(true);
		});
	});

	describe("forget", () => {
		it("soft-deletes an existing memory", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "To Delete", "Body");

			store.forget(memId);

			const row = store.get(memId);
			expect(row).not.toBeNull();
			expect(row?.active).toBe(0);
			expect(row?.deleted_at).toBeTruthy();
			expect(row?.rev).toBe(2); // was 1, bumped to 2
		});

		it("updates metadata_json with clock_device_id", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "To Delete", "Body");
			store.forget(memId);

			const row = store.get(memId);
			expect(row?.metadata_json.clock_device_id).toBe(store.deviceId);
		});

		it("is a no-op for non-existent memory", () => {
			// Should not throw
			store.forget(99999);
		});
	});

	// -- rebootstrap mutation guard ------------------------------------------

	describe("rebootstrap mutation guard", () => {
		it("blocks remember() for shared-visibility memories when phase is needs_attention", () => {
			setSyncDaemonPhase(store.db, "needs_attention");
			const sessionId = insertTestSession(store.db);
			expect(() =>
				store.remember(sessionId, "discovery", "Shared", "Body", 0.5, [], {
					visibility: "shared",
				}),
			).toThrow("sync_rebootstrap_in_progress");
		});

		it("allows remember() for private memories when phase is needs_attention", () => {
			setSyncDaemonPhase(store.db, "needs_attention");
			const sessionId = insertTestSession(store.db);
			const id = store.remember(sessionId, "discovery", "Private", "Body", 0.5, [], {
				visibility: "private",
			});
			expect(id).toBeGreaterThan(0);
		});

		it("allows remember() for shared memories when phase is null (normal)", () => {
			const sessionId = insertTestSession(store.db);
			const id = store.remember(sessionId, "discovery", "Shared", "Body", 0.5, [], {
				visibility: "shared",
			});
			expect(id).toBeGreaterThan(0);
		});

		it("blocks forget() for shared-visibility memories when phase is needs_attention", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Shared", "Body", 0.5, [], {
				visibility: "shared",
			});
			setSyncDaemonPhase(store.db, "needs_attention");
			expect(() => store.forget(memId)).toThrow("sync_rebootstrap_in_progress");
		});

		it("allows forget() for private memories when phase is needs_attention", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Private", "Body", 0.5, [], {
				visibility: "private",
			});
			setSyncDaemonPhase(store.db, "needs_attention");
			store.forget(memId);
			expect(store.get(memId)?.active).toBe(0);
		});

		it("blocks remember() with default visibility (shared) when phase is needs_attention", () => {
			setSyncDaemonPhase(store.db, "needs_attention");
			const sessionId = insertTestSession(store.db);
			// No explicit visibility — defaults to "shared" via resolveProvenance
			expect(() => store.remember(sessionId, "discovery", "Default", "Body")).toThrow(
				"sync_rebootstrap_in_progress",
			);
		});

		it("blocks updateMemoryVisibility() to shared when phase is needs_attention", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Private", "Body", 0.5, [], {
				visibility: "private",
			});
			setSyncDaemonPhase(store.db, "needs_attention");
			expect(() => store.updateMemoryVisibility(memId, "shared")).toThrow(
				"sync_rebootstrap_in_progress",
			);
		});

		it("allows updateMemoryVisibility() to private when phase is needs_attention", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Shared", "Body", 0.5, [], {
				visibility: "shared",
			});
			setSyncDaemonPhase(store.db, "needs_attention");
			// Demoting to private should always work
			const updated = store.updateMemoryVisibility(memId, "private");
			expect(updated.visibility).toBe("private");
		});

		it("unblocks mutations after phase is cleared", () => {
			setSyncDaemonPhase(store.db, "needs_attention");
			const sessionId = insertTestSession(store.db);
			expect(() =>
				store.remember(sessionId, "discovery", "Shared", "Body", 0.5, [], {
					visibility: "shared",
				}),
			).toThrow("sync_rebootstrap_in_progress");

			setSyncDaemonPhase(store.db, null);
			const id = store.remember(sessionId, "discovery", "Shared", "Body", 0.5, [], {
				visibility: "shared",
			});
			expect(id).toBeGreaterThan(0);
		});
	});

	// -- recent --------------------------------------------------------------

	describe("recent", () => {
		it("returns active memories ordered by created_at DESC", () => {
			const sessionId = insertTestSession(store.db);
			// Insert with explicit timestamps to guarantee ordering
			const base = "2026-01-01T00:00:0";
			for (const [i, kind] of (["discovery", "feature", "bugfix"] as const).entries()) {
				store.db
					.prepare(
						`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
					tags_text, active, created_at, updated_at, metadata_json, rev)
					VALUES (?, ?, ?, ?, 0.5, '', 1, ?, ?, '{}', 1)`,
					)
					.run(sessionId, kind, `Item ${i}`, `Body ${i}`, `${base}${i}Z`, `${base}${i}Z`);
			}

			const results = store.recent(10);
			expect(results).toHaveLength(3);
			// Newest first (bugfix at :02, feature at :01, discovery at :00)
			expect(results[0]?.kind).toBe("bugfix");
			expect(results[2]?.kind).toBe("discovery");
		});

		it("excludes soft-deleted memories", () => {
			const sessionId = insertTestSession(store.db);
			const id1 = store.remember(sessionId, "discovery", "Keep", "Body");
			const id2 = store.remember(sessionId, "discovery", "Delete", "Body");
			store.forget(id2);

			const results = store.recent(10);
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe(id1);
		});

		it("respects limit and offset", () => {
			const sessionId = insertTestSession(store.db);
			for (let i = 0; i < 5; i++) {
				store.remember(sessionId, "discovery", `Item ${i}`, `Body ${i}`);
			}

			const page1 = store.recent(2, null, 0);
			const page2 = store.recent(2, null, 2);
			expect(page1).toHaveLength(2);
			expect(page2).toHaveLength(2);
			expect(page1[0].id).not.toBe(page2[0].id);
		});

		it("filters by kind", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "D1", "Body");
			store.remember(sessionId, "feature", "F1", "Body");
			store.remember(sessionId, "discovery", "D2", "Body");

			const results = store.recent(10, { kind: "discovery" });
			expect(results).toHaveLength(2);
			for (const r of results) {
				expect(r.kind).toBe("discovery");
			}
		});
	});

	// -- recentByKinds -------------------------------------------------------

	describe("recentByKinds", () => {
		it("filters by multiple kinds", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "D1", "Body");
			store.remember(sessionId, "feature", "F1", "Body");
			store.remember(sessionId, "bugfix", "B1", "Body");
			store.remember(sessionId, "refactor", "R1", "Body");

			const results = store.recentByKinds(["discovery", "bugfix"]);
			expect(results).toHaveLength(2);
			const kinds = results.map((r) => r.kind);
			expect(kinds).toContain("discovery");
			expect(kinds).toContain("bugfix");
		});

		it("returns empty array for empty kinds list", () => {
			const results = store.recentByKinds([]);
			expect(results).toEqual([]);
		});
	});

	// -- stats ---------------------------------------------------------------

	describe("stats", () => {
		it("returns a structured stats object", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "Title", "Body");

			const result = store.stats();
			expect(result.database).toBeDefined();
			expect(result.database.path).toBe(dbPath);
			expect(result.database.size_bytes).toBeGreaterThan(0);
			expect(result.database.sessions).toBe(1);
			expect(result.database.memory_items).toBe(1);
			expect(result.database.active_memory_items).toBe(1);
			expect(result.database.artifacts).toBe(0);
			expect(result.database.raw_events).toBe(0);
		});

		it("counts inactive memories in total but not active", () => {
			const sessionId = insertTestSession(store.db);
			const _id1 = store.remember(sessionId, "discovery", "Active", "Body");
			const id2 = store.remember(sessionId, "discovery", "Deleted", "Body");
			store.forget(id2);

			const result = store.stats();
			expect(result.database.memory_items).toBe(2);
			expect(result.database.active_memory_items).toBe(1);
		});

		it("handles memory_vectors count failures without crashing", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "Vector test", "Body");
			store.db.exec("CREATE TABLE IF NOT EXISTS memory_vectors(id INTEGER)");

			const originalPrepare = store.db.prepare.bind(store.db);
			(store.db as unknown as { prepare: typeof store.db.prepare }).prepare = ((
				statement: string,
			) => {
				if (statement.includes("FROM memory_vectors")) {
					throw new Error("no such module: vec0");
				}
				return originalPrepare(statement);
			}) as typeof store.db.prepare;

			try {
				const result = store.stats();
				expect(result.database.vector_coverage).toBe(0);
			} finally {
				(store.db as unknown as { prepare: typeof store.db.prepare }).prepare = originalPrepare;
			}
		});
	});

	// -- updateMemoryVisibility ----------------------------------------------

	describe("updateMemoryVisibility", () => {
		it("updates visibility to private with actor-scoped workspace_id", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const updated = store.updateMemoryVisibility(memId, "private");
			expect(updated.visibility).toBe("private");
			expect(updated.workspace_kind).toBe("personal");
			// Python uses personal:${actor_id} where actor_id = local:${device_id}
			expect(updated.workspace_id).toBe(`personal:${store.actorId}`);
		});

		it("updates metadata_json with clock_device_id on visibility change", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const updated = store.updateMemoryVisibility(memId, "shared");
			expect(updated.metadata_json.clock_device_id).toBe(store.deviceId);
			expect(updated.metadata_json.visibility).toBe("shared");
		});

		it("updates visibility to shared", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const updated = store.updateMemoryVisibility(memId, "shared");
			expect(updated.visibility).toBe("shared");
			expect(updated.workspace_kind).toBe("shared");
		});

		it("bumps rev on visibility change", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const original = store.get(memId);
			const updated = store.updateMemoryVisibility(memId, "private");
			expect(updated.rev).toBe((original?.rev as number) + 1);
		});

		it("throws for invalid visibility", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			expect(() => store.updateMemoryVisibility(memId, "invalid")).toThrow(
				/visibility must be private or shared/,
			);
		});

		it("throws for non-existent memory", () => {
			expect(() => store.updateMemoryVisibility(99999, "shared")).toThrow(/memory not found/);
		});

		it("throws for inactive memory", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");
			store.forget(memId);

			expect(() => store.updateMemoryVisibility(memId, "shared")).toThrow(/memory not found/);
		});

		it("throws for memory owned by another device", () => {
			const sessionId = insertTestSession(store.db);
			// Insert a memory with a different origin_device_id
			store.db
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
					tags_text, active, created_at, updated_at, metadata_json,
					origin_device_id, rev)
					VALUES (?, 'discovery', 'Foreign', 'Body', 0.5, '', 1, ?, ?, '{}', 'other-device', 1)`,
				)
				.run(sessionId, new Date().toISOString(), new Date().toISOString());
			const foreignId = Number(
				(store.db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id,
			);

			expect(() => store.updateMemoryVisibility(foreignId, "private")).toThrow(
				/not owned by this device/,
			);
		});
	});

	// -- close ---------------------------------------------------------------

	// -- moveMemoryProject ---------------------------------------------------

	describe("moveMemoryProject", () => {
		function sessionProject(db: MemoryStore["db"], sessionId: number): string | null {
			const row = db.prepare("SELECT project FROM sessions WHERE id = ?").get(sessionId) as
				| { project: string | null }
				| undefined;
			return row?.project ?? null;
		}

		it("updates the parent session's project to the trimmed value", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const result = store.moveMemoryProject(memId, "  new-project  ");
			expect(result.project).toBe("new-project");
			expect(result.session_id).toBe(sessionId);
			expect(sessionProject(store.db, sessionId)).toBe("new-project");
		});

		it("reports the number of sibling memories that moved with the session", () => {
			const sessionId = insertTestSession(store.db);
			const memA = store.remember(sessionId, "discovery", "Title A", "Body");
			store.remember(sessionId, "discovery", "Title B", "Body");
			store.remember(sessionId, "discovery", "Title C", "Body");

			const result = store.moveMemoryProject(memA, "other");
			expect(result.moved_memory_count).toBe(3);
		});

		it("excludes inactive siblings from the moved_memory_count", () => {
			const sessionId = insertTestSession(store.db);
			const memA = store.remember(sessionId, "discovery", "Title A", "Body");
			const memB = store.remember(sessionId, "discovery", "Title B", "Body");
			store.forget(memB);

			const result = store.moveMemoryProject(memA, "other");
			expect(result.moved_memory_count).toBe(1);
		});

		it("throws when project is empty or whitespace", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			expect(() => store.moveMemoryProject(memId, "")).toThrow(/non-empty/);
			expect(() => store.moveMemoryProject(memId, "   ")).toThrow(/non-empty/);
		});

		it("throws when the memory is not found", () => {
			expect(() => store.moveMemoryProject(99999, "anything")).toThrow(/memory not found/);
		});

		it("throws when the memory is inactive", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");
			store.forget(memId);

			expect(() => store.moveMemoryProject(memId, "new")).toThrow(/memory not found/);
		});

		it("recognizes self-ownership from metadata_json on legacy rows with null top-level columns", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");
			// Simulate a legacy/imported row: clear top-level actor_id /
			// origin_device_id, but stash the same values inside metadata_json.
			store.db
				.prepare(
					`UPDATE memory_items
					 SET actor_id = NULL,
					     origin_device_id = NULL,
					     metadata_json = ?
					 WHERE id = ?`,
				)
				.run(JSON.stringify({ actor_id: store.actorId, origin_device_id: store.deviceId }), memId);

			// Ownership check should succeed now that metadata_json is parsed.
			const result = store.moveMemoryProject(memId, "legacy-move");
			expect(result.project).toBe("legacy-move");
		});
	});

	describe("close", () => {
		it("closes the database connection", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "Title", "Body");
			store.close();

			// After close, operations should throw
			expect(() => store.get(1)).toThrow();
			// Prevent afterEach from double-closing
			store = undefined as unknown as MemoryStore;
		});
	});
});

// ---------------------------------------------------------------------------
// buildFilterClauses (unit tests)
// ---------------------------------------------------------------------------

describe("buildFilterClauses", () => {
	it("returns empty for null/undefined filters", () => {
		const result = buildFilterClauses(null);
		expect(result.clauses).toEqual([]);
		expect(result.params).toEqual([]);
		expect(result.joinSessions).toBe(false);
	});

	it("builds kind filter", () => {
		const result = buildFilterClauses({ kind: "discovery" });
		expect(result.clauses).toEqual(["memory_items.kind = ?"]);
		expect(result.params).toEqual(["discovery"]);
	});

	it("builds include_visibility filter", () => {
		const result = buildFilterClauses({ include_visibility: ["private", "shared"] });
		expect(result.clauses).toHaveLength(1);
		expect(result.clauses[0]).toContain("IN");
		expect(result.params).toEqual(["private", "shared"]);
	});

	it("normalizes visibility/workspace/trust values like Python", () => {
		const result = buildFilterClauses({
			visibility: [" Shared ", "INVALID", "private"],
			include_workspace_kinds: ["PERSONAL", "nope", "shared"],
			include_trust_states: ["Unreviewed", "bogus", "trusted"],
		});
		expect(result.params).toEqual([
			"shared",
			"private",
			"personal",
			"shared",
			"unreviewed",
			"trusted",
		]);
	});

	it("builds exclude_actor_ids filter", () => {
		const result = buildFilterClauses({ exclude_actor_ids: ["actor:123"] });
		expect(result.clauses).toHaveLength(1);
		expect(result.clauses[0]).toContain("NOT IN");
		expect(result.params).toEqual(["actor:123"]);
	});

	it("combines multiple filters", () => {
		const result = buildFilterClauses({
			kind: "feature",
			include_visibility: ["shared"],
			exclude_workspace_kinds: ["personal"],
		});
		expect(result.clauses).toHaveLength(3);
		expect(result.params).toEqual(["feature", "shared", "personal"]);
	});

	it("builds ownership_scope mine clause with actor/device context", () => {
		const result = buildFilterClausesWithContext(
			{ ownership_scope: "mine" },
			{ actorId: "local:device-1", deviceId: "device-1" },
		);
		expect(result.clauses).toEqual([
			"(COALESCE(memory_items.actor_id, '') = ? OR COALESCE(memory_items.origin_device_id, '') = ?)",
		]);
		expect(result.params).toEqual(["local:device-1", "device-1"]);
	});

	it("builds ownership_scope theirs clause with null-safe comparisons", () => {
		const result = buildFilterClausesWithContext(
			{ ownership_scope: "theirs" },
			{ actorId: "local:device-1", deviceId: "device-1" },
		);
		expect(result.clauses).toEqual([
			"(COALESCE(memory_items.actor_id, '') != ? AND COALESCE(memory_items.origin_device_id, '') != ?)",
		]);
		expect(result.params).toEqual(["local:device-1", "device-1"]);
	});
});

// ---------------------------------------------------------------------------
// Fresh-database auto-bootstrap
// ---------------------------------------------------------------------------

describe("MemoryStore constructor auto-bootstrap", () => {
	let tmpDir: string;
	let prevCodememConfig: string | undefined;

	beforeEach(() => {
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-bootstrap-test-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
	});

	afterEach(() => {
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("bootstraps schema when constructed against a path with no existing file", () => {
		const dbPath = join(tmpDir, "fresh.sqlite");
		// No pre-seeding — let the constructor discover an uninitialized DB.
		// This mirrors the MCP server / claude-hook-ingest entry points hitting
		// a fresh plugin install inside a wiped sandbox VM.
		const store = new MemoryStore(dbPath);
		try {
			// If bootstrap worked, basic reads succeed and stats report an empty store.
			const stats = store.stats();
			expect(stats.database.memory_items).toBe(0);
			expect(stats.database.sessions).toBe(0);
			expect(tableExists(store.db, "memory_vectors")).toBe(true);

			// Real query-path coverage: exercising `recent` / `recentByKinds`
			// hits memory_items + FTS/provenance joins that assertSchemaReady
			// alone doesn't catch if any table is missing.
			expect(store.recent(10)).toEqual([]);
			expect(store.recentByKinds(["discovery"])).toEqual([]);

			// And a write-then-read round-trip through the same constructor-
			// bootstrapped handle — the actual MCP-server hot path on fresh DBs.
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(
				sessionId,
				"discovery",
				"post-bootstrap insert",
				"written on an auto-bootstrapped DB",
			);
			expect(store.get(memId)?.title).toBe("post-bootstrap insert");
		} finally {
			store.close();
		}
	});

	it("bootstraps schema when constructed against an empty existing file", () => {
		const dbPath = join(tmpDir, "empty.sqlite");
		// Touch an empty file so connect() has to bootstrap an existing empty DB.
		writeFileSync(dbPath, "");
		const store = new MemoryStore(dbPath);
		try {
			const stats = store.stats();
			expect(stats.database.memory_items).toBe(0);
			// Same query-path smoke test as the fresh-path case.
			expect(store.recent(10)).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("does not re-bootstrap an already-initialized database", () => {
		const dbPath = join(tmpDir, "existing.sqlite");
		// First construction bootstraps.
		const first = new MemoryStore(dbPath);
		const sessionId = insertTestSession(first.db);
		const memId = first.remember(
			sessionId,
			"discovery",
			"persisted memory",
			"should survive a second construction",
		);
		first.close();

		// Second construction must not wipe or re-run bootstrap DDL destructively.
		const second = new MemoryStore(dbPath);
		try {
			const fetched = second.get(memId);
			expect(fetched?.title).toBe("persisted memory");
		} finally {
			second.close();
		}
	});
});
