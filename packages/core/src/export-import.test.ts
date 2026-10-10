import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportMemories, importMemories, readImportPayload } from "./export-import.js";
import { refreshManagedScopeFixture } from "./managed-scope-test-fixtures.js";
import { MemoryStore } from "./store.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

afterEach(() => vi.unstubAllEnvs());

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

async function seedScopedExportDb(dbPath: string, keysDir: string): Promise<void> {
	const db = new Database(dbPath);
	try {
		initTestSchema(db);
		grantScope(db, "authorized-team");
		await refreshManagedScopeFixture(db, {
			keysDir,
			deviceId: "local",
			scopeIds: ["authorized-team"],
		});
		db.prepare(`INSERT INTO replication_scopes
			(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
			VALUES ('unauthorized-team', 'unauthorized-team', 'team', 'coordinator', 1, 'active', ?, ?)`).run(
			"2026-01-01T00:00:00Z",
			"2026-01-01T00:00:00Z",
		);
		db.prepare(`INSERT INTO sessions(id, started_at, cwd, project, user, tool_version, metadata_json, import_key)
			VALUES (1, '2026-03-01T00:00:00Z', '/tmp/visible', 'visible', 'test', 'test', '{}', 'session-visible'),
			(2, '2026-03-01T00:00:00Z', '/tmp/hidden', 'hidden', 'test', 'test', '{}', 'session-hidden')`).run();
		db.prepare(`INSERT INTO memory_items
			(id, session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, import_key, scope_id)
			VALUES
			(100, 1, 'discovery', 'Visible scoped export', 'visible', 1, '2026-03-01T00:00:01Z', '2026-03-01T00:00:01Z', '{}', 'memory-visible', 'authorized-team'),
			(101, 2, 'discovery', 'Hidden scoped export', 'hidden', 1, '2026-03-01T00:00:02Z', '2026-03-01T00:00:02Z', '{}', 'memory-hidden', 'unauthorized-team')`).run();
	} finally {
		db.close();
	}
}

describe("export mixed-session authority", () => {
	it.each([
		{ active: 1, deletedAt: null, includeInactive: false },
		{ active: 0, deletedAt: null, includeInactive: false },
		{ active: 0, deletedAt: "2026-03-01T11:00:00Z", includeInactive: false },
		{ active: 1, deletedAt: null, includeInactive: true },
		{ active: 0, deletedAt: null, includeInactive: true },
		{ active: 0, deletedAt: "2026-03-01T11:00:00Z", includeInactive: true },
	])("omits session source content after mixed-session authority loss: %j", async (state) => {
		// Arrange: real scope reassignment and verified membership, without a live coordinator.
		const dbPath = createDbPath("mixed-session");
		const keysDir = join(dirname(dbPath), "keys");
		vi.stubEnv("CODEMEM_DEVICE_ID", "local");
		seedSourceDb(dbPath);
		const store = new MemoryStore(dbPath, { keysDir });
		try {
			grantScope(store.db, "authorized-team");
			await refreshManagedScopeFixture(store.db, {
				keysDir,
				deviceId: "local",
				scopeIds: ["authorized-team"],
				now: new Date("2026-03-01T00:00:00Z"),
			});
			store.db
				.prepare(`UPDATE memory_items SET active = 1, deleted_at = NULL,
				origin_device_id = 'local', body_text = 'hidden-source-content' WHERE id = 101`)
				.run();
			store.reassignMemoryScope(101, "authorized-team");
			store.db
				.prepare("UPDATE sessions SET metadata_json = ? WHERE id = 1")
				.run(JSON.stringify({ source_content: "hidden-session-content" }));
			store.db
				.prepare("UPDATE user_prompts SET prompt_text = ?, metadata_json = ? WHERE id = 10")
				.run("hidden-prompt-content", JSON.stringify({ source: "hidden-prompt-metadata" }));
			store.db
				.prepare(
					`UPDATE session_summaries SET request = ?, files_read = ?, files_edited = ?, metadata_json = ? WHERE id = 200`,
				)
				.run(
					"hidden-summary-content",
					'["hidden-read.ts"]',
					'["hidden-edited.ts"]',
					'{"source":"hidden-summary-metadata"}',
				);
			const authorized = exportMemories({ dbPath, keysDir, project: "codemem" });
			expect(authorized.memory_items).toHaveLength(2);
			expect(authorized.sessions[0]?.metadata_json).toEqual({
				source_content: "hidden-session-content",
			});
			expect(authorized.user_prompts[0]?.prompt_text).toBe("hidden-prompt-content");
			expect(authorized.session_summaries[0]?.files_read).toEqual(["hidden-read.ts"]);
			store.db
				.prepare(
					"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'authorized-team'",
				)
				.run();
			store.db
				.prepare("UPDATE memory_items SET active = ?, deleted_at = ? WHERE id = 101")
				.run(state.active, state.deletedAt);

			// Act: exporting must use all session memories for authority, including inactive history.
			const payload = exportMemories({
				dbPath,
				keysDir,
				project: "codemem",
				includeInactive: state.includeInactive,
			});
			const destPath = createDbPath("mixed-session-import");
			const dest = new Database(destPath);
			initTestSchema(dest);
			dest.close();
			const imported = importMemories(payload, { dbPath: destPath });

			// Assert: keep readable memories importable, but no unscoped session source bytes.
			expect(payload.memory_items.map((memory) => memory.id)).toEqual([100]);
			expect(payload.sessions).toEqual([
				{
					id: 1,
					export_session_key: expect.stringMatching(/^export-session:v1:[a-f0-9]{64}$/),
					export_session_redacted: true,
				},
			]);
			expect(payload.user_prompts).toEqual([]);
			expect(payload.session_summaries).toEqual([]);
			expect(JSON.stringify(payload)).not.toContain("hidden-");
			expect(imported).toMatchObject({
				sessions: 1,
				memory_items: 1,
				user_prompts: 0,
				session_summaries: 0,
			});
		} finally {
			store.close();
		}
	});
});

function seedSessionIdentitySource(name: string, importKey: string | null): string {
	const dbPath = createDbPath(name);
	seedSourceDb(dbPath);
	const db = new Database(dbPath);
	try {
		db.prepare("UPDATE sessions SET import_key = ?, project = ?, started_at = ? WHERE id = 1").run(
			importKey,
			`hidden-project-${name}`,
			`2026-03-0${name === "first" ? 1 : 2}T10:00:00Z`,
		);
		db.prepare("UPDATE memory_items SET import_key = ? WHERE id = 100").run(`visible-${name}`);
		db.prepare("UPDATE memory_items SET scope_id = 'inaccessible' WHERE id = 101").run();
	} finally {
		db.close();
	}
	return dbPath;
}

describe("export session identity across hops", () => {
	it.each([
		{ redacted: false, remapProject: null },
		{ redacted: true, remapProject: null },
		{ redacted: false, remapProject: "remapped" },
		{ redacted: true, remapProject: "remapped" },
	])("preserves canonical identity through repeated import/export hops: %j", (state) => {
		// Arrange: A already carries an opaque source identity, with optional unreadable history.
		let canonicalKey = `export-session:v1:${"a".repeat(64)}`;
		if (state.remapProject) {
			const namespace = createHash("sha256")
				.update(JSON.stringify(state.remapProject))
				.digest("hex");
			canonicalKey += `:remap:${namespace}`;
		}
		const sourcePath = seedSessionIdentitySource("first", canonicalKey);
		const source = new Database(sourcePath);
		if (!state.redacted) {
			source.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = 101").run();
		}
		const destPath = createDbPath("multi-hop-destination");
		const dest = new Database(destPath);
		initTestSchema(dest);
		try {
			// Act: A -> B, then B -> B with and without repeating the same explicit remap.
			const first = exportMemories({ dbPath: sourcePath, allProjects: true });
			const initial = importMemories(first, { dbPath: destPath, remapProject: state.remapProject });
			const hop = exportMemories({ dbPath: destPath, allProjects: true });
			const repeat = importMemories(hop, { dbPath: destPath });
			const repeatRemap = importMemories(hop, {
				dbPath: destPath,
				remapProject: state.remapProject,
			});
			const nextHop = exportMemories({ dbPath: destPath, allProjects: true });
			const returned = importMemories(nextHop, { dbPath: sourcePath });
			const returnedAgain = importMemories(nextHop, { dbPath: sourcePath });

			// Assert: canonical source keys survive, no empty duplicate sessions, no orphan memories.
			expect(first.sessions[0]?.export_session_key).toBe(canonicalKey);
			expect(initial.sessions).toBe(1);
			expect(repeat.sessions).toBe(0);
			expect(repeatRemap.sessions).toBe(0);
			expect(nextHop.sessions[0]?.export_session_key).toBe(hop.sessions[0]?.export_session_key);
			expect(returned.sessions).toBe(0);
			expect(returnedAgain.sessions).toBe(0);
			expect(source.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
			expect(dest.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
			expect(
				dest
					.prepare(`SELECT COUNT(*) AS n FROM sessions s
				WHERE NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.session_id = s.id)`)
					.get(),
			).toEqual({ n: 0 });
			expect(
				dest
					.prepare(`SELECT COUNT(*) AS n FROM memory_items m
				WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = m.session_id)`)
					.get(),
			).toEqual({ n: 0 });
		} finally {
			dest.close();
			source.close();
		}
	});

	it.each([
		`export-session:v1:${"a".repeat(64)}`,
		`export-session:v1:${"a".repeat(64)}:remap:${"b".repeat(64)}`,
	])("preserves the valid stored canonical source key %s", (key) => {
		// Arrange: both unnamespaced and supported remap keys can already be stored identities.
		const sourcePath = seedSessionIdentitySource("first", key);

		// Act: repeated exports must not hash an opaque identity again.
		const first = exportMemories({ dbPath: sourcePath, allProjects: true });
		const second = exportMemories({ dbPath: sourcePath, allProjects: true });

		// Assert: exact key bytes survive both exports.
		expect(first.sessions[0]?.export_session_key).toBe(key);
		expect(second.sessions[0]?.export_session_key).toBe(key);
	});

	it.each([
		"export-session:v1:short",
		`export-session:v1:${"a".repeat(64)}:remap:short`,
		`export-session:v1:${"a".repeat(64)}:remap:${"b".repeat(64)}:remap:${"c".repeat(64)}`,
		`export-session:v1:${"a".repeat(64)}:unexpected`,
	])("does not preserve malformed markers as canonical source identity: %s", (key) => {
		// Arrange: a source import key resembles the marker format but violates its grammar.
		const sourcePath = seedSessionIdentitySource("first", key);

		// Act: export it as an ordinary source key, not as a canonical identity.
		const payload = exportMemories({ dbPath: sourcePath, allProjects: true });

		// Assert: malformed keys are hashed into a valid base marker rather than propagated.
		expect(payload.sessions[0]?.export_session_key).not.toBe(key);
		expect(payload.sessions[0]?.export_session_key).toMatch(/^export-session:v1:[a-f0-9]{64}$/);
	});
});

describe("new opaque session identity across hops", () => {
	it.each([false, true])(
		"keeps native identity across enrollment and project moves (legacy=%s)",
		(legacy) => {
			// Arrange: use the actual native write boundary, or a historical keyless session.
			vi.stubEnv("CODEMEM_DEVICE_ID", "");
			vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
			const sourcePath = createDbPath("enrollment-source");
			const keysDir = join(dirname(sourcePath), "keys");
			const store = new MemoryStore(sourcePath);
			const sessionId = store.startSession({ project: "before", cwd: "/tmp/before" });
			store.remember(sessionId, "discovery", "Native memory", "Body", 0.5, []);
			if (legacy)
				store.db.prepare("UPDATE sessions SET import_key = NULL WHERE id = ?").run(sessionId);
			const beforeRow = store.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
			const destPath = createDbPath("enrollment-destination");
			const dest = new Database(destPath);
			initTestSchema(dest);
			try {
				// Act: export before a signer exists, enroll, move the project, and import both exports.
				const before = exportMemories({ dbPath: sourcePath, keysDir, allProjects: true });
				const afterExportRow = store.db
					.prepare("SELECT * FROM sessions WHERE id = ?")
					.get(sessionId);
				const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
				store.adoptEnsuredDeviceIdentity(deviceId);
				store.db.prepare("UPDATE sessions SET project = 'after' WHERE id = ?").run(sessionId);
				const after = exportMemories({ dbPath: sourcePath, keysDir, allProjects: true });
				importMemories(before, { dbPath: destPath });
				const repeated = importMemories(after, { dbPath: destPath });

				// Assert: mutable device/project state cannot create an empty duplicate session.
				expect(afterExportRow).toEqual(beforeRow);
				expect(after.sessions[0]?.export_session_key).toBe(before.sessions[0]?.export_session_key);
				expect(repeated.sessions).toBe(0);
				expect(dest.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
			} finally {
				dest.close();
				store.close();
			}
		},
	);

	it.each([null, "remapped"])(
		"fills only a redacted placeholder with full source context (remap=%s)",
		(remapProject) => {
			// Arrange: the source has unreadable history and all source-context fields.
			const sourcePath = seedSessionIdentitySource("first", "restoration-key");
			const source = new Database(sourcePath);
			source
				.prepare("UPDATE sessions SET ended_at = ?, git_remote = ?, git_branch = ? WHERE id = 1")
				.run("2026-03-01T12:00:00Z", "https://example.com/repo.git", "main");
			const destPath = createDbPath("restoration-destination");
			const dest = new Database(destPath);
			initTestSchema(dest);
			try {
				// Act: redacted -> full -> changed full -> redacted, all with the same canonical key.
				const redacted = exportMemories({ dbPath: sourcePath, allProjects: true });
				importMemories(redacted, { dbPath: destPath, remapProject });
				source.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = 101").run();
				const full = exportMemories({ dbPath: sourcePath, allProjects: true });
				const restored = importMemories(full, { dbPath: destPath, remapProject });
				const restoredRow = dest.prepare("SELECT * FROM sessions").get() as Record<string, unknown>;
				const changed = {
					...full,
					sessions: full.sessions.map((row) => ({
						...row,
						cwd: "/tmp/changed",
						metadata_json: { changed: true },
					})),
				};
				importMemories(changed, { dbPath: destPath, remapProject });
				importMemories(redacted, { dbPath: destPath, remapProject });

				// Assert: restore source fields once, respect remap, and never regress or overwrite full context.
				expect(redacted.sessions[0]).toEqual({
					id: 1,
					export_session_key: full.sessions[0]?.export_session_key,
					export_session_redacted: true,
				});
				expect(restored.sessions).toBe(0);
				expect(restoredRow).toMatchObject({
					started_at: "2026-03-01T10:00:00Z",
					ended_at: "2026-03-01T12:00:00Z",
					cwd: "/tmp/repo",
					user: "adam",
					git_remote: "https://example.com/repo.git",
					git_branch: "main",
					project: remapProject ?? "hidden-project-first",
					tool_version: "test",
				});
				expect(JSON.parse(String(restoredRow.metadata_json))).toMatchObject({
					import_metadata: { k: 1 },
					original_started_at: "2026-03-01T10:00:00Z",
					original_ended_at: "2026-03-01T12:00:00Z",
				});
				expect(dest.prepare("SELECT * FROM sessions").get()).toEqual(restoredRow);
				expect(dest.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
				expect(dest.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 1 });
			} finally {
				dest.close();
				source.close();
			}
		},
	);
});

describe("redacted placeholder protection", () => {
	it.each(["cwd", "metadata"])("does not fill an unrecognized empty session (%s)", (field) => {
		// Arrange: make a valid placeholder, then change evidence that identifies it as redacted.
		const sourcePath = seedSessionIdentitySource("first", "placeholder-protection");
		const source = new Database(sourcePath);
		const destPath = createDbPath("placeholder-protection-destination");
		const dest = new Database(destPath);
		initTestSchema(dest);
		try {
			importMemories(exportMemories({ dbPath: sourcePath, allProjects: true }), {
				dbPath: destPath,
			});
			if (field === "cwd") dest.prepare("UPDATE sessions SET cwd = '/tmp/local-context'").run();
			else dest.prepare("UPDATE sessions SET metadata_json = '{}'").run();
			const before = dest.prepare("SELECT * FROM sessions").get();
			source.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = 101").run();

			// Act: a full export must not replace a row merely because its source time is empty.
			importMemories(exportMemories({ dbPath: sourcePath, allProjects: true }), {
				dbPath: destPath,
			});

			// Assert: local context and unrecognized metadata stay unchanged.
			expect(dest.prepare("SELECT * FROM sessions").get()).toEqual(before);
		} finally {
			dest.close();
			source.close();
		}
	});

	it("keeps redacted context opaque across another export and rejects supplied private fields", () => {
		// Arrange: a redacted payload includes fields that must not be treated as source content.
		const sourcePath = seedSessionIdentitySource("first", "opaque-placeholder");
		const payload = exportMemories({ dbPath: sourcePath, allProjects: true });
		payload.sessions[0] = {
			...payload.sessions[0],
			cwd: "/tmp/private",
			started_at: "private-time",
			user: "private-user",
			metadata_json: { secret: "private-metadata" },
		};
		payload.user_prompts = [
			{ id: 1, session_id: 1, prompt_text: "private-prompt", import_key: "private-prompt-key" },
		];
		payload.session_summaries = [
			{ id: 1, session_id: 1, request: "private-summary", import_key: "private-summary-key" },
		];
		const destPath = createDbPath("opaque-placeholder-destination");
		const dest = new Database(destPath);
		initTestSchema(dest);
		try {
			// Act: import, then re-export a placeholder with no hidden memories on the receiver.
			importMemories(payload, { dbPath: destPath });
			const hop = exportMemories({ dbPath: destPath, allProjects: true });

			// Assert: source context stays absent and the opaque key is unchanged.
			expect(hop.sessions).toEqual([
				{
					id: 1,
					export_session_key: payload.sessions[0]?.export_session_key,
					export_session_redacted: true,
				},
			]);
			expect(JSON.stringify(dest.prepare("SELECT * FROM sessions").get())).not.toContain(
				"private-",
			);
			expect(hop.user_prompts).toEqual([]);
			expect(hop.session_summaries).toEqual([]);
		} finally {
			dest.close();
		}
	});

	it("rolls back a placeholder fill when a later record fails to import", () => {
		// Arrange: a later memory contains non-JSON metadata; no fixture DDL is needed.
		const sourcePath = seedSessionIdentitySource("first", "transaction-placeholder");
		const source = new Database(sourcePath);
		const destPath = createDbPath("transaction-placeholder-destination");
		const dest = new Database(destPath);
		initTestSchema(dest);
		try {
			importMemories(exportMemories({ dbPath: sourcePath, allProjects: true }), {
				dbPath: destPath,
			});
			const before = dest.prepare("SELECT * FROM sessions").get();
			source.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = 101").run();
			const full = exportMemories({ dbPath: sourcePath, allProjects: true });
			full.memory_items.push({
				...full.memory_items[0],
				id: 999,
				import_key: "invalid-metadata",
				metadata_json: { unserializable: 1n },
			});

			// Act / Assert: failure after the fill restores the original placeholder and all row counts.
			expect(() => importMemories(full, { dbPath: destPath })).toThrow(/BigInt/);
			expect(dest.prepare("SELECT * FROM sessions").get()).toEqual(before);
			expect(dest.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 1 });
		} finally {
			dest.close();
			source.close();
		}
	});
});

describe("native opaque identity across import hops", () => {
	it("fails without changing historical rows when immutable identity evidence is absent", () => {
		// Arrange: a historical session and its readable memory both lack import keys.
		const sourcePath = seedSessionIdentitySource("first", null);
		const source = new Database(sourcePath);
		try {
			source.prepare("UPDATE memory_items SET import_key = NULL").run();
			const sessions = source.prepare("SELECT * FROM sessions").all();
			const memories = source.prepare("SELECT * FROM memory_items").all();

			// Act: exports must not manufacture identity from enrollment or ambiguous ownership.
			const act = () => exportMemories({ dbPath: sourcePath, allProjects: true });

			// Assert: the caller receives a decision point, with no marker writes or historical changes.
			expect(act).toThrow("session_identity_unavailable");
			expect(source.prepare("SELECT * FROM sessions").all()).toEqual(sessions);
			expect(source.prepare("SELECT * FROM memory_items").all()).toEqual(memories);
		} finally {
			source.close();
		}
	});

	it("mints independent native UUIDs rather than accepting supplied metadata as identity", () => {
		// Arrange: callers supply the same metadata, but these are genuinely new native sessions.
		const sourcePath = createDbPath("new-native-keys");
		const store = new MemoryStore(sourcePath);
		try {
			// Act: start both sessions through the public store method.
			const opts = { project: "same", metadata: { import_key: "caller-supplied" } };
			const first = store.startSession(opts);
			const second = store.startSession(opts);
			const rows = store.db.prepare("SELECT import_key FROM sessions ORDER BY id").all() as {
				import_key: string;
			}[];

			// Assert: bookkeeping is independent of caller metadata and numeric row IDs.
			expect(first).not.toBe(second);
			expect(rows[0]?.import_key).toMatch(/^[a-f0-9-]{36}$/);
			expect(rows[1]?.import_key).toMatch(/^[a-f0-9-]{36}$/);
			expect(rows[0]?.import_key).not.toBe(rows[1]?.import_key);
			expect(rows[0]?.import_key).not.toBe("caller-supplied");
		} finally {
			store.close();
		}
	});

	it.each([
		{ redacted: false, sourceKey: "native-source-key" },
		{ redacted: true, sourceKey: "native-source-key" },
		{ redacted: false, sourceKey: null },
		{ redacted: true, sourceKey: null },
	])("keeps a newly generated marker stable after the first import: %j", (state) => {
		// Arrange: a native source needs its first opaque identity, unlike an already-imported session.
		const sourcePath = seedSessionIdentitySource("first", state.sourceKey);
		const source = new Database(sourcePath);
		if (!state.redacted) {
			source.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = 101").run();
		}
		source.close();
		const destPath = createDbPath("native-hop-destination");
		const dest = new Database(destPath);
		initTestSchema(dest);
		try {
			// Act: export from the native source, import, re-export, and re-import twice.
			const first = exportMemories({ dbPath: sourcePath, allProjects: true });
			importMemories(first, { dbPath: destPath });
			const hop = exportMemories({ dbPath: destPath, allProjects: true });
			const repeated = importMemories(hop, { dbPath: destPath });
			const repeatedAgain = importMemories(hop, { dbPath: destPath });

			// Assert: the generated marker remains unchanged and dedupe creates no empty session.
			expect(hop.sessions[0]?.export_session_key).toBe(first.sessions[0]?.export_session_key);
			expect(repeated).toMatchObject({ sessions: 0, memory_items: 0 });
			expect(repeatedAgain).toMatchObject({ sessions: 0, memory_items: 0 });
			expect(dest.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
			expect(
				dest.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM memory_items").get(),
			).toEqual({ n: 1 });
		} finally {
			dest.close();
		}
	});
});

const legacySessionMarkers = [
	undefined,
	"invalid-session-marker",
	`export-session:v1:${"a".repeat(64)}:remap:short`,
	`export-session:v1:${"a".repeat(64)}:remap:${"b".repeat(64)}:remap:${"c".repeat(64)}`,
];

describe("export session identity", () => {
	it.each(["source-key", null])(
		"separates sources and retains identity across redaction with %s",
		(key) => {
			// Arrange: same numeric session ID, distinct source identities, and inaccessible history.
			const firstPath = seedSessionIdentitySource("first", key && `${key}-first`);
			const secondPath = seedSessionIdentitySource("second", key && `${key}-second`);
			const destPath = createDbPath("identity-destination");
			const dest = new Database(destPath);
			initTestSchema(dest);
			const first = exportMemories({ dbPath: firstPath, allProjects: true });
			const second = exportMemories({ dbPath: secondPath, allProjects: true });
			try {
				// Act: import two sources, repeat the export, then restore full session authority.
				const firstImport = importMemories(first, { dbPath: destPath });
				const secondImport = importMemories(second, { dbPath: destPath });
				const repeat = exportMemories({ dbPath: firstPath, allProjects: true });
				const repeatedImport = importMemories(repeat, { dbPath: destPath });
				const source = new Database(firstPath);
				source.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = 101").run();
				source.close();
				const full = exportMemories({ dbPath: firstPath, allProjects: true });
				const restoredImport = importMemories(full, { dbPath: destPath });

				// Assert: no collision, no duplicate, no invented source time/user/working directory.
				expect(firstImport.sessions).toBe(1);
				expect(secondImport.sessions).toBe(1);
				expect(repeatedImport.sessions).toBe(0);
				expect(restoredImport.sessions).toBe(0);
				expect(first.sessions[0]?.export_session_key).not.toBe(
					second.sessions[0]?.export_session_key,
				);
				expect(repeat.sessions[0]?.export_session_key).toBe(first.sessions[0]?.export_session_key);
				expect(full.sessions[0]?.export_session_key).toBe(first.sessions[0]?.export_session_key);
				expect(JSON.stringify(first.sessions)).not.toContain("hidden-project");
				expect(dest.prepare("SELECT started_at, cwd, user FROM sessions").all()).toEqual([
					{ started_at: "2026-03-01T10:00:00Z", cwd: "/tmp/repo", user: "adam" },
					{ started_at: "", cwd: null, user: null },
				]);
				expect(
					dest.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM memory_items").get(),
				).toEqual({ n: 2 });
			} finally {
				dest.close();
			}
		},
	);

	it.each(legacySessionMarkers)(
		"reuses and promotes an older full-payload session identity with %s",
		(marker) => {
			// Arrange: a destination imported a full session before opaque keys existed.
			const sourcePath = seedSessionIdentitySource("first", "source-key-first");
			const source = new Database(sourcePath);
			source.prepare("UPDATE memory_items SET scope_id = 'local-default' WHERE id = 101").run();
			const full = exportMemories({ dbPath: sourcePath, allProjects: true });
			const legacy = {
				...full,
				sessions: full.sessions.map(({ export_session_key: _key, ...row }) => ({
					...row,
					export_session_key: marker,
				})),
			};
			const destPath = createDbPath("legacy-identity-destination");
			const dest = new Database(destPath);
			initTestSchema(dest);
			try {
				// Act: import the older format, the new full format, then a redacted export.
				const original = importMemories(legacy, { dbPath: destPath });
				const promoted = importMemories(full, { dbPath: destPath });
				source.prepare("UPDATE memory_items SET scope_id = 'inaccessible' WHERE id = 101").run();
				const redacted = exportMemories({ dbPath: sourcePath, allProjects: true });
				const repeated = importMemories(redacted, { dbPath: destPath });

				// Assert: marker-free imports still work and migration does not create another session.
				expect(original.sessions).toBe(1);
				expect(promoted.sessions).toBe(0);
				expect(repeated.sessions).toBe(0);
				expect(dest.prepare("SELECT started_at, cwd, user FROM sessions").all()).toEqual([
					{ started_at: "2026-03-01T10:00:00Z", cwd: "/tmp/repo", user: "adam" },
				]);
			} finally {
				dest.close();
				source.close();
			}
		},
	);
});

describe("redacted import project attribution", () => {
	it.each([
		{ projects: ["alpha"], remapProject: null, sessionProject: "alpha" },
		{ projects: ["alpha"], remapProject: "remapped", sessionProject: "remapped" },
		{ projects: ["alpha", "beta"], remapProject: null, sessionProject: null },
		{ projects: ["alpha", "beta"], remapProject: "remapped", sessionProject: "remapped" },
		{ projects: ["alpha", null], remapProject: null, sessionProject: null },
	])("keeps only readable memory projects retrievable after redacted import: %j", (state) => {
		// Arrange: readable rows have explicit project attribution distinct from the hidden session.
		const sourcePath = seedSessionIdentitySource("first", "project-source");
		const source = new Database(sourcePath);
		try {
			source
				.prepare(
					"UPDATE memory_items SET project = 'alpha', title = 'projectneedle alpha' WHERE id = 100",
				)
				.run();
			if (state.projects.length > 1) {
				source
					.prepare(`INSERT INTO memory_items(id, session_id, kind, title, body_text, active,
					created_at, updated_at, metadata_json, import_key, scope_id, project)
					VALUES (102, 1, 'feature', 'projectneedle beta', 'readable beta', 1,
					'2026-03-01T10:03:00Z', '2026-03-01T10:03:00Z', '{}', 'visible-beta', 'local-default', ?)`)
					.run(state.projects[1]);
			}
			source
				.prepare("UPDATE memory_items SET project = 'hidden-memory-project' WHERE id = 101")
				.run();
		} finally {
			source.close();
		}
		const payload = exportMemories({ dbPath: sourcePath, allProjects: true });
		const destPath = createDbPath("project-destination");
		const setup = new Database(destPath);
		initTestSchema(setup);
		setup.close();

		// Act: import and repeat, then exercise the store APIs used for retrieval and feed.
		importMemories(payload, { dbPath: destPath, remapProject: state.remapProject });
		const repeated = importMemories(payload, {
			dbPath: destPath,
			remapProject: state.remapProject,
		});
		const rawImport = new Database(destPath, { readonly: true });
		const importedProjects = rawImport
			.prepare("SELECT project FROM memory_items ORDER BY id")
			.all();
		rawImport.close();
		const store = new MemoryStore(destPath);
		try {
			// Assert: matching projects see their own rows; neither hidden nor unrelated projects match.
			expect(importedProjects).toEqual(
				state.projects.map((project) => ({ project: state.remapProject ?? project })),
			);
			expect(payload.sessions[0]?.project).toBeUndefined();
			expect(JSON.stringify(payload)).not.toContain("hidden-project");
			expect(JSON.stringify(payload)).not.toContain("hidden-memory-project");
			expect(repeated).toMatchObject({ sessions: 0, memory_items: 0 });
			expect(store.db.prepare("SELECT project, started_at, cwd, user FROM sessions").get()).toEqual(
				{
					project: state.sessionProject,
					started_at: "",
					cwd: null,
					user: null,
				},
			);
			for (const project of state.projects) {
				if (!project) continue;
				const filter = { project: state.remapProject ?? project };
				const expectedCount = state.remapProject ? state.projects.length : 1;
				expect(store.recent(10, filter)).toHaveLength(expectedCount);
				expect(store.recentByKinds(["feature"], 10, filter)).toHaveLength(expectedCount);
				expect(store.search("projectneedle", 10, filter)).toHaveLength(expectedCount);
			}
			expect(store.db.prepare("SELECT project FROM memory_items ORDER BY id").all()).toEqual(
				state.projects.map((project) => ({ project: state.remapProject ?? project })),
			);
			for (const project of ["unrelated", "hidden-project-first", "hidden-memory-project"]) {
				expect(store.recent(10, { project })).toEqual([]);
				expect(store.search("projectneedle", 10, { project })).toEqual([]);
			}
		} finally {
			store.close();
		}
	});
});

describe("export filters", () => {
	it("preserves authorized session content with narrower export filters and excludes empty sessions", () => {
		// Arrange: inactive history remains readable; filtering it is not an authority loss.
		const dbPath = createDbPath("filtered-session");
		seedSourceDb(dbPath);
		const db = new Database(dbPath);
		try {
			db.prepare(`INSERT INTO sessions(id, started_at, project, user, tool_version, metadata_json)
				VALUES (2, '2026-03-01T10:00:00Z', 'codemem', 'test', 'test', '{}')`).run();
		} finally {
			db.close();
		}

		// Act: project/date/activity filters select exports, not permission.
		const payload = exportMemories({ dbPath, project: "codemem", since: "2026-03-01T00:00:00Z" });
		const excluded = exportMemories({ dbPath, project: "other-project" });

		// Assert: full readable source records survive; unrelated and no-memory sessions do not.
		expect(payload.memory_items.map((memory) => memory.id)).toEqual([100]);
		expect(payload.sessions.map((session) => session.id)).toEqual([1]);
		expect(payload.sessions[0]?.metadata_json).toEqual({ k: 1 });
		expect(payload.user_prompts).toHaveLength(1);
		expect(payload.session_summaries).toHaveLength(1);
		expect(excluded.sessions).toEqual([]);
		expect(excluded.memory_items).toEqual([]);
	});
});

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

	it("exports only locally authorized scopes and tags source scope ids", async () => {
		const dbPath = createDbPath("scoped-export");
		const keysDir = join(dirname(dbPath), "keys");
		vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
		try {
			await seedScopedExportDb(dbPath, keysDir);
			const payload = exportMemories({ dbPath, allProjects: true });
			expect(payload.sessions.map((session) => session.import_key)).toEqual(["session-visible"]);
			expect(payload.memory_items.map((memory) => memory.title)).toEqual(["Visible scoped export"]);
			expect(payload.memory_items[0]?.scope_id).toBe("authorized-team");
		} finally {
			vi.unstubAllEnvs();
		}
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

	it("does not import command failures as session identity metadata", () => {
		const payload = minimalPayload("local-default");
		const session = payload.sessions[0];
		if (!session) throw new Error("expected fixture session");
		session.cwd = "Command failed: git rev-parse --show-toplevel";
		session.project = "error: failed to discover project";
		session.git_remote = "fatal: not a git repository";
		session.git_branch = "fatal: ambiguous argument HEAD";
		const destination = createDbPath("malformed-identity-import");
		const setupDb = new Database(destination);
		initTestSchema(setupDb);
		setupDb.close();

		importMemories(payload, { dbPath: destination });

		const checkDb = new Database(destination, { readonly: true });
		try {
			const imported = checkDb
				.prepare("SELECT cwd, project, git_remote, git_branch FROM sessions LIMIT 1")
				.get();
			expect(imported).toEqual({ cwd: null, project: null, git_remote: null, git_branch: null });
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
