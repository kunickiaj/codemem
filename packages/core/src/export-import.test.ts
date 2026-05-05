import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { exportMemories, importMemories, readImportPayload } from "./export-import.js";
import { initTestSchema } from "./test-utils.js";

function createDbPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-export-import-"));
	return join(dir, `${name}.sqlite`);
}

function seedSourceDb(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		initTestSchema(db);
		db.prepare(
			`INSERT INTO sessions(id, started_at, cwd, project, user, tool_version, metadata_json, import_key)
			 VALUES (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"k":1}', 'sess-1')`,
		).run();
		db.prepare(
			`INSERT INTO user_prompts(id, session_id, project, prompt_text, prompt_number, created_at, created_at_epoch, metadata_json, import_key)
			 VALUES (10, 1, 'codemem', 'Run tests', 1, '2026-03-01T10:01:00Z', 1, '{"p":1}', 'prompt-1')`,
		).run();
		db.prepare(
			`INSERT INTO memory_items(
				id, session_id, kind, title, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, facts, concepts, files_read, files_modified,
				user_prompt_id, prompt_number, import_key
			) VALUES (
				100, 1, 'feature', 'Added export', 'implemented export', 0.9, 'ts export', 1,
				'2026-03-01T10:02:00Z', '2026-03-01T10:02:00Z', '{"m":1}', '["fact"]', '["concept"]', '["a.ts"]', '["b.ts"]',
				10, 1, 'memory-1'
			)`,
		).run();
		db.prepare(
			`INSERT INTO memory_items(
				id, session_id, kind, title, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, deleted_at, import_key
			) VALUES (
				101, 1, 'exploration', 'Inactive', 'skipped by default', 0.5, '', 0,
				'2026-03-01T10:03:00Z', '2026-03-01T10:03:00Z', '{}', '2026-03-01T10:03:30Z', 'memory-2'
			)`,
		).run();
		db.prepare(
			`INSERT INTO session_summaries(
				id, session_id, project, request, investigated, learned, completed, next_steps,
				notes, files_read, files_edited, prompt_number, created_at, created_at_epoch, metadata_json, import_key
			) VALUES (
				200, 1, 'codemem', 'ship export', 'cli parity', 'ts store is thinner', 'ported base', 'port config next',
				'', '["a.ts"]', '["b.ts"]', 1, '2026-03-01T10:04:00Z', 1, '{"s":1}', 'summary-1'
			)`,
		).run();
	} finally {
		db.close();
	}
}

function grantScope(db: Database.Database, scopeId: string, deviceId = "local"): void {
	const now = "2026-01-01T00:00:00Z";
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`,
	).run(scopeId, scopeId, now, now);
	db.prepare(
		`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		 VALUES (?, ?, 'member', 'active', 1, ?)`,
	).run(scopeId, deviceId, now);
}

function minimalPayload(scopeId: string): ReturnType<typeof exportMemories> {
	return {
		version: "1.0",
		exported_at: "2026-03-01T00:00:00Z",
		export_metadata: {
			tool_version: "codemem",
			projects: ["codemem"],
			total_memories: 1,
			total_sessions: 1,
			include_inactive: false,
			filters: {},
		},
		sessions: [
			{
				id: 1,
				started_at: "2026-03-01T00:00:00Z",
				cwd: "/tmp/codemem",
				project: "codemem",
				user: "test",
				tool_version: "test",
				metadata_json: {},
				import_key: "session-1",
			},
		],
		memory_items: [
			{
				id: 100,
				session_id: 1,
				kind: "discovery",
				title: "Scoped import",
				body_text: "Scoped body",
				created_at: "2026-03-01T00:00:01Z",
				updated_at: "2026-03-01T00:00:01Z",
				metadata_json: {},
				import_key: "memory-100",
				scope_id: scopeId,
			},
		],
		session_summaries: [],
		user_prompts: [],
	};
}

describe("export/import", () => {
	it("exports parsed JSON fields and prompt import key links", () => {
		const dbPath = createDbPath("source");
		seedSourceDb(dbPath);

		const payload = exportMemories({ dbPath });

		expect(payload.version).toBe("1.0");
		expect(payload.sessions).toHaveLength(1);
		expect(payload.memory_items).toHaveLength(1);
		expect(payload.session_summaries).toHaveLength(1);
		expect(payload.user_prompts).toHaveLength(1);
		expect(payload.sessions[0]?.metadata_json).toEqual({ k: 1 });
		expect(payload.memory_items[0]?.facts).toEqual(["fact"]);
		expect(payload.memory_items[0]?.scope_id).toBe("local-default");
		expect(payload.memory_items[0]?.user_prompt_import_key).toBe("prompt-1");
	});

	it("exports only locally authorized scopes and tags source scope ids", () => {
		const dbPath = createDbPath("scoped-export");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			grantScope(db, "authorized-team");
			db.prepare(
				`INSERT INTO replication_scopes(
					scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
				 ) VALUES ('unauthorized-team', 'unauthorized-team', 'team', 'coordinator', 1, 'active', ?, ?)`,
			).run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
			db.prepare(
				`INSERT INTO sessions(id, started_at, cwd, project, user, tool_version, metadata_json, import_key)
				 VALUES (1, '2026-03-01T00:00:00Z', '/tmp/visible', 'visible', 'test', 'test', '{}', 'session-visible'),
						(2, '2026-03-01T00:00:00Z', '/tmp/hidden', 'hidden', 'test', 'test', '{}', 'session-hidden')`,
			).run();
			db.prepare(
				`INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key, scope_id
				 ) VALUES
					(100, 1, 'discovery', 'Visible scoped export', 'visible', 1, '2026-03-01T00:00:01Z', '2026-03-01T00:00:01Z', '{}', 'memory-visible', 'authorized-team'),
					(101, 2, 'discovery', 'Hidden scoped export', 'hidden', 1, '2026-03-01T00:00:02Z', '2026-03-01T00:00:02Z', '{}', 'memory-hidden', 'unauthorized-team')`,
			).run();
		} finally {
			db.close();
		}

		const payload = exportMemories({ dbPath, allProjects: true });

		expect(payload.sessions.map((session) => session.import_key)).toEqual(["session-visible"]);
		expect(payload.memory_items.map((memory) => memory.title)).toEqual(["Visible scoped export"]);
		expect(payload.memory_items[0]?.scope_id).toBe("authorized-team");
	});

	it("exports null-scope legacy rows as local-default even when project mappings exist", () => {
		const dbPath = createDbPath("mapped-null-scope-export");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			grantScope(db, "authorized-team");
			db.prepare(
				`INSERT INTO project_scope_mappings(
					workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
				 ) VALUES ('/tmp/mapped', '/tmp/mapped', 'authorized-team', 10, 'user', ?, ?)`,
			).run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
			db.prepare(
				`INSERT INTO sessions(id, started_at, cwd, project, user, tool_version, metadata_json, import_key)
				 VALUES (1, '2026-03-01T00:00:00Z', '/tmp/mapped', 'mapped', 'test', 'test', '{}', 'session-mapped')`,
			).run();
			db.prepare(
				`INSERT INTO memory_items(
					id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key, scope_id
				 ) VALUES (100, 1, 'discovery', 'Legacy null scope', 'legacy', 1, '2026-03-01T00:00:01Z', '2026-03-01T00:00:01Z', '{}', 'memory-legacy', NULL)`,
			).run();
		} finally {
			db.close();
		}

		const payload = exportMemories({ dbPath, allProjects: true });

		expect(payload.memory_items).toHaveLength(1);
		expect(payload.memory_items[0]?.scope_id).toBe("local-default");
	});

	it("includes inactive memories when requested", () => {
		const dbPath = createDbPath("inactive");
		seedSourceDb(dbPath);

		const payload = exportMemories({ dbPath, includeInactive: true });

		expect(payload.memory_items).toHaveLength(2);
	});

	it("imports idempotently and supports dry run", () => {
		const sourcePath = createDbPath("source-import");
		seedSourceDb(sourcePath);
		const payload = exportMemories({ dbPath: sourcePath, includeInactive: true });

		const destPath = createDbPath("dest-import");
		const destDb = new Database(destPath);
		initTestSchema(destDb);
		destDb.close();

		const dryRun = importMemories(payload, { dbPath: destPath, dryRun: true });
		expect(dryRun.dryRun).toBe(true);
		expect(dryRun.sessions).toBe(1);

		const first = importMemories(payload, { dbPath: destPath, remapProject: "/tmp/remapped" });
		expect(first.sessions).toBe(1);
		expect(first.user_prompts).toBe(1);
		expect(first.memory_items).toBe(2);
		expect(first.session_summaries).toBe(1);

		const second = importMemories(payload, { dbPath: destPath, remapProject: "/tmp/remapped" });
		expect(second.sessions).toBe(0);
		expect(second.user_prompts).toBe(0);
		expect(second.memory_items).toBe(0);
		expect(second.session_summaries).toBe(0);

		const checkDb = new Database(destPath, { readonly: true });
		try {
			const promptEpoch = (
				checkDb.prepare("SELECT created_at_epoch FROM user_prompts LIMIT 1").get() as {
					created_at_epoch: number;
				}
			).created_at_epoch;
			const summaryEpoch = (
				checkDb.prepare("SELECT created_at_epoch FROM session_summaries LIMIT 1").get() as {
					created_at_epoch: number;
				}
			).created_at_epoch;
			const counts = {
				sessions: (checkDb.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
				prompts: (checkDb.prepare("SELECT COUNT(*) AS n FROM user_prompts").get() as { n: number })
					.n,
				memories: (checkDb.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number })
					.n,
				summaries: (
					checkDb.prepare("SELECT COUNT(*) AS n FROM session_summaries").get() as { n: number }
				).n,
				project: (
					checkDb.prepare("SELECT project FROM sessions LIMIT 1").get() as { project: string }
				).project,
				inactiveMemory: checkDb
					.prepare("SELECT active, deleted_at FROM memory_items WHERE import_key = ?")
					.get("memory-2") as { active: number; deleted_at: string | null },
				memoryScopes: checkDb
					.prepare("SELECT DISTINCT scope_id FROM memory_items ORDER BY scope_id")
					.all() as Array<{ scope_id: string | null }>,
			};
			expect(counts).toEqual({
				sessions: 1,
				prompts: 1,
				memories: 2,
				summaries: 1,
				project: "/tmp/remapped",
				inactiveMemory: { active: 0, deleted_at: "2026-03-01T10:03:30Z" },
				memoryScopes: [{ scope_id: "local-default" }],
			});
			// Original created_at_epoch values (1) from the source DB are preserved
			expect(promptEpoch).toBe(1);
			expect(summaryEpoch).toBe(1);
		} finally {
			checkDb.close();
		}
	});

	it("preserves imported source scopes only when locally authorized", () => {
		const authorizedDestPath = createDbPath("authorized-import-scope");
		const authorizedDb = new Database(authorizedDestPath);
		try {
			initTestSchema(authorizedDb);
			grantScope(authorizedDb, "authorized-team");
		} finally {
			authorizedDb.close();
		}

		const result = importMemories(minimalPayload("authorized-team"), {
			dbPath: authorizedDestPath,
		});
		expect(result.memory_items).toBe(1);
		const checkDb = new Database(authorizedDestPath, { readonly: true });
		try {
			const row = checkDb.prepare("SELECT scope_id FROM memory_items LIMIT 1").get() as {
				scope_id: string;
			};
			expect(row.scope_id).toBe("authorized-team");
		} finally {
			checkDb.close();
		}

		const unauthorizedDestPath = createDbPath("unauthorized-import-scope");
		const unauthorizedDb = new Database(unauthorizedDestPath);
		try {
			initTestSchema(unauthorizedDb);
		} finally {
			unauthorizedDb.close();
		}
		expect(() =>
			importMemories(minimalPayload("authorized-team"), { dbPath: unauthorizedDestPath }),
		).toThrow(/unauthorized_scope: authorized-team/);
		expect(() =>
			importMemories(minimalPayload("legacy-shared-review"), { dbPath: unauthorizedDestPath }),
		).toThrow(/unauthorized_scope: legacy-shared-review/);
	});

	it("re-imports idempotently after a previously-authorized scope loses authorization", () => {
		// Initial import: destination has authority for the source scope.
		const destPath = createDbPath("revoked-scope-reimport");
		const grantedDb = new Database(destPath);
		try {
			initTestSchema(grantedDb);
			grantScope(grantedDb, "previously-authorized-team");
		} finally {
			grantedDb.close();
		}

		const payload = minimalPayload("previously-authorized-team");
		const initial = importMemories(payload, { dbPath: destPath });
		expect(initial.memory_items).toBe(1);

		// Revoke the scope membership/authority.
		const revokeDb = new Database(destPath);
		try {
			revokeDb
				.prepare("UPDATE replication_scopes SET status = 'archived' WHERE scope_id = ?")
				.run("previously-authorized-team");
			revokeDb
				.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
				.run("previously-authorized-team");
		} finally {
			revokeDb.close();
		}

		// Re-importing the exact same payload must be a no-op, not a hard reject.
		const second = importMemories(payload, { dbPath: destPath });
		expect(second.memory_items).toBe(0);
	});

	it("reads import payload from file", () => {
		const file = join(mkdtempSync(join(tmpdir(), "codemem-export-file-")), "export.json");
		writeFileSync(
			file,
			JSON.stringify({
				version: "1.0",
				exported_at: "2026-03-01T00:00:00Z",
				export_metadata: {},
				sessions: [],
				memory_items: [],
				session_summaries: [],
				user_prompts: [],
			}),
			"utf8",
		);

		const payload = readImportPayload(file);
		expect(payload.version).toBe("1.0");
		expect(readFileSync(file, "utf8")).toContain('"1.0"');
	});
});
