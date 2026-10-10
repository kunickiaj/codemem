import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type Database } from "./db.js";
import type { EmbeddingClient } from "./embeddings.js";
import { exportMemories, importMemories } from "./export-import.js";
import { backfillTagsText } from "./maintenance/backfill-tags.js";
import { populateMemoryRefs } from "./ref-populate.js";
import { findByConcept, findByFile } from "./ref-queries.js";
import { initTestSchema } from "./test-utils.js";
import { backfillVectors } from "./vectors.js";

vi.mock("./project.js", async (original) => ({
	...(await original<typeof import("./project.js")>()),
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFileSync: vi.fn(() => {
		throw new Error("External subprocess disabled in tests");
	}),
}));
vi.mock("./embeddings.js", async (original) => ({
	...(await original<typeof import("./embeddings.js")>()),
	getEmbeddingClient: vi.fn(() => {
		throw new Error("No provider calls allowed");
	}),
}));

const marker = `export-session:v1:${"a".repeat(64)}`;
function payload(redacted = false): ReturnType<typeof exportMemories> {
	return {
		version: "1.0",
		exported_at: "2026-03-01T00:00:00Z",
		export_metadata: {
			tool_version: "test",
			projects: ["alpha"],
			total_memories: 1,
			total_sessions: 1,
			include_inactive: false,
			filters: {},
		},
		sessions: [
			{
				id: 1,
				export_session_key: marker,
				...(redacted
					? { export_session_redacted: true }
					: {
							started_at: "2026-03-01T00:00:00Z",
							project: "alpha",
							cwd: "/fixture",
							user: "fixture",
							tool_version: "test",
						}),
			},
		],
		user_prompts: redacted
			? []
			: [
					{
						id: 10,
						session_id: 1,
						project: "alpha",
						prompt_text: "Original prompt",
						created_at: "2026-03-01T00:00:00Z",
						import_key: "prompt-alpha",
					},
				],
		memory_items: [
			{
				id: 100,
				session_id: 1,
				project: "alpha",
				kind: "feature",
				title: "alpha memory",
				body_text: "alpha body",
				created_at: "2026-03-01T00:00:00Z",
				updated_at: "2026-03-01T00:00:00Z",
				import_key: "memory-alpha",
				user_prompt_id: redacted ? null : 10,
				user_prompt_import_key: redacted ? null : "prompt-alpha",
			},
		],
		session_summaries: [],
	};
}

let dbPath: string;
let db: Database;
let fixtureRoot: string;
beforeEach(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "codemem-export-feedback-"));
	vi.stubEnv("CODEMEM_CONFIG", join(fixtureRoot, "config.json"));
	dbPath = join(fixtureRoot, "fixture.sqlite");
	db = connect(dbPath);
	initTestSchema(db);
});
afterEach(() => {
	db.close();
	rmSync(fixtureRoot, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
const memory = () =>
	db.prepare("SELECT * FROM memory_items WHERE import_key = 'memory-alpha'").get() as Record<
		string,
		unknown
	>;

function captureDatabaseState(path: string) {
	return {
		main: readFileSync(path),
		wal: existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : null,
		logical: db.serialize(),
	};
}

function assertDatabaseStateUnchanged(before: ReturnType<typeof captureDatabaseState>) {
	const after = captureDatabaseState(dbPath);
	expect(after.main.equals(before.main)).toBe(true);
	expect(after.logical.equals(before.logical)).toBe(true);
	expect(after.wal === null).toBe(before.wal === null);
	if (after.wal === null || before.wal === null) return;
	expect(after.wal.equals(before.wal)).toBe(true);
}

describe("database state snapshots", () => {
	it("detects a committed WAL-only write that main-file comparison misses", () => {
		// Arrange: checkpoint only before the operation, leaving the connection open.
		db.pragma("wal_autocheckpoint = 0");
		db.prepare("CREATE TABLE snapshot_probe (value TEXT)").run();
		db.pragma("wal_checkpoint(TRUNCATE)");
		const before = captureDatabaseState(dbPath);
		// Act: commit a one-page fixture write through SQLite, not raw file edits.
		db.transaction(() => db.prepare("INSERT INTO snapshot_probe VALUES ('changed')").run())();
		const after = captureDatabaseState(dbPath);
		// Assert: the old predicate passes, but persistent WAL and logical bytes differ.
		expect(after.main.equals(before.main)).toBe(true);
		expect(before.wal).not.toBeNull();
		expect(after.wal).not.toBeNull();
		if (before.wal === null || after.wal === null) throw new Error("Fixture WAL must exist");
		expect(after.wal.equals(before.wal)).toBe(false);
		expect(after.logical.equals(before.logical)).toBe(false);
	});
});

function attackPayload(attack: string) {
	const incoming = payload();
	if (attack === "cross-session" || attack === "redacted-other-session")
		incoming.sessions[0].export_session_key = `export-session:v1:${"b".repeat(64)}`;
	if (attack === "redacted-other-session") incoming.sessions[0].export_session_redacted = true;
	if (attack === "invalid-prompt") {
		incoming.user_prompts = [];
		incoming.memory_items[0].user_prompt_id = 999;
		incoming.memory_items[0].user_prompt_import_key = null;
	}
	if (attack === "noncanonical") incoming.sessions[0].export_session_key = "not-canonical";
	if (attack === "foreign-prompt") {
		const foreign = payload();
		foreign.sessions[0].export_session_key = `export-session:v1:${"b".repeat(64)}`;
		foreign.memory_items = [];
		importMemories(foreign, { dbPath });
	}
	if (attack === "native") db.prepare("UPDATE memory_items SET metadata_json = '{}' ").run();
	if (attack !== "redacted" && attack !== "existing-link") return incoming;
	importMemories(payload(), { dbPath });
	incoming.user_prompts[0] = {
		...incoming.user_prompts[0],
		id: 20,
		import_key: "malicious",
		prompt_text: "Malicious",
	};
	incoming.memory_items[0].user_prompt_id = 20;
	incoming.memory_items[0].user_prompt_import_key = "malicious";
	if (attack === "redacted") incoming.sessions[0].export_session_redacted = true;
	return incoming;
}

function mixedRows(moved: boolean) {
	const mixed = payload(true);
	mixed.memory_items.push({
		...mixed.memory_items[0],
		id: 101,
		project: "beta",
		title: "beta memory",
		body_text: "beta body",
		import_key: "memory-beta",
	});
	importMemories(mixed, { dbPath });
	const rows = db.prepare("SELECT id, project FROM memory_items ORDER BY id").all() as {
		id: number;
		project: string;
	}[];
	for (const row of rows) populateMemoryRefs(db, row.id, ["shared.ts"], null, ["shared"]);
	if (moved) db.prepare("UPDATE sessions SET project = 'gamma'").run();
	return rows;
}

function embeddingClient(): EmbeddingClient {
	return {
		model: "test-model",
		dimensions: 384,
		identity: {
			package: "@huggingface/transformers",
			version: "4.2.0",
			model: "test-model",
			revision: "0123456789abcdef0123456789abcdef01234567",
			requestedRevision: "test",
			dtype: "fp32",
			device: "cpu",
			pooling: "mean",
			normalization: "l2",
			dimensions: 384,
		},
		embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384))),
	};
}

function assertReadResult(
	surface: string,
	project: string,
	expected: number[],
	moved: boolean,
	full = false,
) {
	if (surface === "file") {
		expect(
			findByFile(db, "shared.ts", { project })
				.map((row) => row.id)
				.sort(),
		).toEqual(expected);
		return;
	}
	if (surface === "concept") {
		expect(
			findByConcept(db, "shared", { project })
				.map((row) => row.id)
				.sort(),
		).toEqual(expected);
		return;
	}
	if (surface !== "export") return;
	const exported = exportMemories({ dbPath, project });
	expect(exported.memory_items.map((row) => row.id)).toEqual(expected);
	expect(exportMemories({ dbPath, cwd: `/fixture/${project}` }).memory_items).toEqual(
		exported.memory_items,
	);
	expect(exported.sessions).toHaveLength(expected.length ? 1 : 0);
	if (!moved && expected.length)
		expect(exported.sessions[0]).toEqual({
			id: exported.sessions[0].id,
			export_session_key: marker,
			export_session_redacted: true,
		});
	if (full && expected.length)
		expect(exported.user_prompts[0]?.prompt_text).toBe("Original prompt");
	else expect(exported.user_prompts).toEqual([]);
}

describe("prompt restoration", () => {
	it.each([false, true].flatMap((remap) => [false, true].map((byId) => ({ remap, byId }))))(
		"restores only the missing prompt link (remap=$remap, byId=$byId)",
		({ remap, byId }) => {
			// Arrange: the first slice omitted all prompt context.
			const options = { dbPath, remapProject: remap ? "remapped" : null };
			importMemories(payload(true), options);
			const before = memory();
			expect(before.user_prompt_id).toBeNull();
			const incoming = payload();
			if (byId) delete incoming.memory_items[0].user_prompt_import_key;
			// Act
			const result = importMemories(incoming, options);
			const after = memory();
			const bytes = captureDatabaseState(dbPath);
			const exported = exportMemories({ dbPath, allProjects: true });
			// Assert: stable row and revision; no changes to other memory fields.
			expect(result.memory_items).toBe(0);
			expect(after).toEqual({ ...before, user_prompt_id: expect.any(Number) });
			expect(
				db
					.prepare("SELECT prompt_text FROM user_prompts WHERE id = ?")
					.pluck()
					.get(after.user_prompt_id),
			).toBe("Original prompt");
			expect(exported.memory_items[0].user_prompt_id).toBe(after.user_prompt_id);
			expect(exported.memory_items[0].user_prompt_import_key).toBe("prompt-alpha");
			assertDatabaseStateUnchanged(bytes);
		},
	);

	it.each([
		"cross-session",
		"redacted-other-session",
		"foreign-prompt",
		"invalid-prompt",
		"noncanonical",
		"native",
		"redacted",
		"existing-link",
	])("does not hijack a deduped memory: %s", (attack) => {
		// Arrange
		importMemories(payload(true), { dbPath });
		const incoming = attackPayload(attack);
		const before = memory();
		const sessions = db.prepare("SELECT * FROM sessions ORDER BY id").all();
		// Act
		importMemories(incoming, { dbPath });
		// Assert
		expect(memory()).toEqual(before);
		if (attack === "redacted") {
			expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessions);
			expect(
				db.prepare("SELECT id FROM user_prompts WHERE import_key = 'malicious'").get(),
			).toBeUndefined();
		}
	});
});
describe("placeholder project restoration", () => {
	it.each(["redacted", "full"])(
		"retains a real project-only move after %s import on every surface",
		async (mode) => {
			// Arrange: keep the opaque placeholder shape intact during the user move.
			const rows = mixedRows(true);
			const before = memory();
			const session = db.prepare("SELECT * FROM sessions").get() as Record<string, unknown>;
			const incoming = payload(mode === "redacted");
			// Act
			importMemories(incoming, { dbPath });
			const bytes = captureDatabaseState(dbPath);
			const repeat = importMemories(incoming, { dbPath });
			// Assert: source context can fill once, but attribution and memory identity cannot change.
			assertDatabaseStateUnchanged(bytes);
			expect(repeat).toMatchObject({ sessions: 0, memory_items: 0, user_prompts: 0 });
			expect(db.prepare("SELECT id, import_key, project FROM sessions").get()).toEqual({
				id: session.id,
				import_key: marker,
				project: "gamma",
			});
			expect(memory()).toEqual({
				...before,
				user_prompt_id: mode === "full" ? expect.any(Number) : null,
			});
			for (const project of ["alpha", "beta", "gamma", "absent"]) {
				const expected = project === "gamma" ? rows.map((row) => row.id) : [];
				for (const surface of ["file", "concept", "export"])
					assertReadResult(surface, project, expected, true, mode === "full");
				expect((await backfillVectors(db, { project, client: embeddingClient() })).checked).toBe(
					expected.length,
				);
				db.prepare("UPDATE memory_items SET tags_text = ''").run();
				expect(backfillTagsText(db, { project }).checked).toBe(expected.length);
			}
		},
	);

	it.each([false, true])(
		"infers legacy attribution from memory evidence, not custom session project (moved=%s)",
		(moved) => {
			// Arrange: emulate a pre-tracking placeholder, retaining unrelated local metadata.
			importMemories(payload(true), { dbPath });
			const row = db.prepare("SELECT metadata_json FROM sessions").get() as {
				metadata_json: string;
			};
			const metadata = JSON.parse(row.metadata_json);
			delete metadata.placeholder_project;
			metadata.local_note = "keep";
			db.prepare("UPDATE sessions SET metadata_json = ?, project = ?").run(
				JSON.stringify(metadata),
				moved ? "gamma" : "alpha",
			);
			const incoming = payload(true);
			incoming.memory_items = [
				{ ...incoming.memory_items[0], id: 101, project: "beta", import_key: "memory-beta" },
			];
			// Act
			importMemories(incoming, { dbPath });
			const reconciled = db.prepare("SELECT * FROM sessions").get() as Record<string, unknown>;
			importMemories(payload(), { dbPath });
			// Assert: unchanged legacy alpha can recompute to mixed NULL; gamma cannot.
			expect(reconciled.project).toBe(moved ? "gamma" : null);
			expect(JSON.parse(String(reconciled.metadata_json))).toMatchObject({
				local_note: "keep",
				placeholder_project: moved ? "alpha" : null,
			});
			expect(
				JSON.parse(
					String(
						(db.prepare("SELECT metadata_json FROM sessions").get() as Record<string, unknown>)
							.metadata_json,
					),
				),
			).toMatchObject({ local_note: "keep" });
		},
	);

	it.each([false, true])(
		"restores remapped context without replaying attribution after a move (moved=%s)",
		(moved) => {
			// Arrange
			const opts = { dbPath, remapProject: "remapped" };
			importMemories(payload(true), opts);
			if (moved) db.prepare("UPDATE sessions SET project = 'gamma'").run();
			// Act
			importMemories(payload(true), opts);
			importMemories(payload(), opts);
			// Assert
			expect(db.prepare("SELECT project, cwd, started_at FROM sessions").get()).toEqual({
				project: moved ? "gamma" : "remapped",
				cwd: "/fixture",
				started_at: "2026-03-01T00:00:00Z",
			});
		},
	);

	it.each(["gamma", null, "", "   "])(
		"preserves explicit project %j through redacted and full imports",
		(project) => {
			// Arrange
			importMemories(payload(true), { dbPath });
			db.prepare("UPDATE sessions SET project = ?").run(project);
			// Act
			importMemories(payload(true), { dbPath });
			importMemories(payload(), { dbPath });
			// Assert: raw NULL and blank moves must not be normalized back to source attribution.
			expect(db.prepare("SELECT project FROM sessions").get()).toEqual({ project });
		},
	);
});

describe("placeholder export dates", () => {
	it.each([false, true])(
		"qualifies placeholder dates only with eligible activity and project (includeInactive=%s)",
		(includeInactive) => {
			// Arrange: mixed attribution ensures the project predicate is memory-local.
			mixedRows(false);
			db.prepare(
				"UPDATE memory_items SET created_at = '2026-01-01T00:00:00Z' WHERE project = 'alpha'",
			).run();
			db.prepare(
				"UPDATE memory_items SET created_at = '2026-05-01T00:00:00Z', active = 0 WHERE project = 'beta'",
			).run();
			// Act
			const alpha = exportMemories({
				dbPath,
				project: "alpha",
				since: "2026-04-01T00:00:00Z",
				includeInactive,
			});
			const beta = exportMemories({
				dbPath,
				project: "beta",
				since: "2026-04-01T00:00:00Z",
				includeInactive,
			});
			// Assert
			expect(alpha.sessions).toEqual([]);
			expect(beta.memory_items).toHaveLength(includeInactive ? 1 : 0);
			if (includeInactive)
				expect(beta.sessions).toEqual([
					{ id: 1, export_session_key: marker, export_session_redacted: true },
				]);
			else expect(beta.sessions).toEqual([]);
		},
	);

	it("uses readable memory dates for placeholders without changing native session-start filtering", () => {
		// Arrange
		importMemories(payload(true), { dbPath });
		// Act
		const early = exportMemories({ dbPath, project: "alpha", since: "2026-02-01T00:00:00Z" });
		const late = exportMemories({ dbPath, project: "alpha", since: "2026-04-01T00:00:00Z" });
		// Assert
		expect(early.memory_items).toHaveLength(1);
		expect(early.sessions).toEqual([
			{ id: 1, export_session_key: marker, export_session_redacted: true },
		]);
		expect(late.sessions).toEqual([]);
		// Arrange: a newer unreadable memory must not qualify an older readable slice.
		db.prepare("UPDATE memory_items SET created_at = '2026-01-01T00:00:00Z'").run();
		db.prepare(
			"INSERT INTO memory_items(session_id, project, kind, title, body_text, created_at, updated_at, scope_id) VALUES (1, 'alpha', 'feature', 'hidden', 'hidden', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', 'unreadable')",
		).run();
		// Act / Assert
		expect(
			exportMemories({ dbPath, project: "alpha", since: "2026-04-01T00:00:00Z" }).sessions,
		).toEqual([]);
		// Arrange: a readable newer memory now qualifies, but hidden context stays opaque.
		db.prepare(
			"UPDATE memory_items SET created_at = '2026-05-01T00:00:00Z' WHERE scope_id = 'local-default'",
		).run();
		// Act
		const qualified = exportMemories({ dbPath, project: "alpha", since: "2026-04-01T00:00:00Z" });
		// Assert
		expect(qualified.sessions).toEqual([
			{ id: 1, export_session_key: marker, export_session_redacted: true },
		]);
		expect(qualified.memory_items).toHaveLength(1);
		expect(qualified.user_prompts).toEqual([]);
		expect(qualified.session_summaries).toEqual([]);
		// Arrange: restore full context with an older real source start.
		importMemories(payload(), { dbPath });
		// Act / Assert: newer memories cannot replace the full session-start cutoff.
		expect(
			exportMemories({ dbPath, project: "alpha", since: "2026-04-01T00:00:00Z" }).sessions,
		).toEqual([]);
	});
});

describe("project fallback", () => {
	it.each([false, true])(
		"selects only the effective project for tag backfill (moved=%s)",
		(moved) => {
			// Arrange
			const rows = mixedRows(moved);
			// Act and Assert: filled tags reveal the actual selected row ids.
			for (const project of ["alpha", "beta", "gamma", "absent"]) {
				db.prepare("UPDATE memory_items SET tags_text = ''").run();
				const expected = rows
					.filter((row) => (moved ? "gamma" : row.project) === project)
					.map((row) => row.id);
				const result = backfillTagsText(db, { project });
				expect(result.checked).toBe(expected.length);
				expect(
					db.prepare("SELECT id FROM memory_items WHERE tags_text <> '' ORDER BY id").pluck().all(),
				).toEqual(expected);
			}
		},
	);
	it.each(
		[false, true].flatMap((moved) =>
			["file", "concept", "export", "vectors"].map((surface) => ({ moved, surface })),
		),
	)("uses session-first project selection: $surface (moved=$moved)", async ({ moved, surface }) => {
		// Arrange: mixed-project opaque session; the session project takes priority after a move.
		const rows = mixedRows(moved);
		const client = embeddingClient();
		const bytes = captureDatabaseState(dbPath);
		// Act and Assert: each result excludes the other project; absent project returns nothing.
		for (const project of ["alpha", "beta", "gamma", "absent"]) {
			const expected = rows
				.filter((row) => (moved ? "gamma" : row.project) === project)
				.map((row) => row.id);
			assertReadResult(surface, project, expected, moved);
			assertDatabaseStateUnchanged(bytes);
		}
		if (surface !== "vectors") return;
		for (const project of ["alpha", "beta", "gamma", "absent"]) {
			const expected = rows.filter((row) => (moved ? "gamma" : row.project) === project);
			vi.mocked(client.embed).mockClear();
			const result = await backfillVectors(db, { project, client });
			expect(result.checked).toBe(expected.length);
			expect(vi.mocked(client.embed).mock.calls.flat(2)).toEqual(
				expected.map((row) => `${row.project} memory\n${row.project} body`),
			);
		}
		expect(
			db.prepare("SELECT DISTINCT memory_id FROM memory_vectors ORDER BY memory_id").all(),
		).toEqual(rows.map((row) => ({ memory_id: row.id })));
	});
});
