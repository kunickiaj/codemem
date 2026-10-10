import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type ExportPayload, exportMemories, importMemories } from "./export-import.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

const marker = `export-session:v1:${"a".repeat(64)}`;

function destination(): string {
	const path = join(mkdtempSync(join(tmpdir(), "codemem-export-feedback-")), "test.sqlite");
	const db = new Database(path);
	initTestSchema(db);
	db.close();
	return path;
}

function payload(project: string, redacted = true): ExportPayload {
	return {
		version: "1.0",
		exported_at: "2026-03-01T00:00:00Z",
		export_metadata: {
			tool_version: "codemem",
			projects: [project],
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
					: { project, started_at: "2026-03-01T00:00:00Z", cwd: "/fixture/source", user: "test" }),
			},
		],
		memory_items: [
			{
				id: 1,
				session_id: 1,
				project,
				kind: "feature",
				title: `projectneedle ${project}`,
				body_text: project,
				import_key: `memory-${project}`,
			},
		],
		user_prompts: [],
		session_summaries: [],
	};
}

function addChildren(data: ExportPayload, prefix: string, sessionId = 1): void {
	data.user_prompts.push({
		id: sessionId,
		session_id: sessionId,
		prompt_text: `${prefix} prompt`,
		import_key: `${prefix}-prompt`,
	});
	data.session_summaries.push({
		id: sessionId,
		session_id: sessionId,
		request: `${prefix} summary`,
		import_key: `${prefix}-summary`,
	});
}

describe("incoming redaction withholds child records", () => {
	it.each(["empty", "placeholder", "full"])(
		"strips malformed children before full restore (%s)",
		(initial) => {
			// Arrange: the same canonical target can already be empty, redacted, or fully restored.
			const dbPath = destination();
			const full = payload("source", false);
			addChildren(full, "legitimate");
			if (initial === "placeholder") importMemories(payload("alpha"), { dbPath });
			if (initial === "full") importMemories(full, { dbPath });
			const malformed = payload("beta");
			addChildren(malformed, "injected");
			// A different, full incoming session must retain its children in the same transaction.
			malformed.sessions.push({
				id: 2,
				export_session_key: `export-session:v1:${"b".repeat(64)}`,
				project: "other",
				started_at: "2026-03-01T00:00:00Z",
			});
			malformed.memory_items.push({
				id: 2,
				session_id: 2,
				project: "other",
				title: "Other",
				import_key: "memory-other",
			});
			addChildren(malformed, "other", 2);

			// Act: import malformed redacted children, then restore and re-export full context.
			const result = importMemories(malformed, { dbPath });
			const db = new Database(dbPath, { readonly: true });
			try {
				const children = db.prepare("SELECT prompt_text FROM user_prompts ORDER BY id").all();
				importMemories(full, { dbPath });
				const exported = exportMemories({ dbPath, allProjects: true });

				// Assert: readable memories and legitimate full-session children survive, injected data never does.
				expect(result).toMatchObject({ user_prompts: 1, session_summaries: 1, memory_items: 2 });
				expect(children).not.toContainEqual({ prompt_text: "injected prompt" });
				expect(exported.user_prompts.map((row) => row.prompt_text).sort()).toEqual([
					"legitimate prompt",
					"other prompt",
				]);
				expect(exported.session_summaries.map((row) => row.request).sort()).toEqual([
					"legitimate summary",
					"other summary",
				]);
				expect(exported.memory_items.some((row) => row.title === "projectneedle beta")).toBe(true);
				expect(JSON.stringify(exported)).not.toContain("injected");
			} finally {
				db.close();
			}
		},
	);
});

describe("accumulated placeholder project attribution", () => {
	it.each(["remapped", null, "", "   "])(
		"preserves explicit remap when every incoming memory dedupes elsewhere (%j)",
		(remapProject) => {
			// Arrange: the incoming memory already belongs to another canonical session.
			const dbPath = destination();
			const opts = { dbPath, remapProject };
			const elsewhere = payload("alpha");
			elsewhere.sessions = elsewhere.sessions.map((session) => ({
				...session,
				export_session_key: `export-session:v1:${"b".repeat(64)}`,
			}));
			importMemories(elsewhere, opts);
			const incoming = payload("alpha");

			// Act: create and revisit a placeholder with no stored memory evidence.
			const imported = importMemories(incoming, opts);
			const repeated = importMemories(incoming, opts);
			const db = new Database(dbPath, { readonly: true });
			try {
				// Assert: only a nonblank explicit remap is authoritative without readable memories.
				expect(imported).toMatchObject({ sessions: 1, memory_items: 0 });
				expect(repeated).toMatchObject({ sessions: 0, memory_items: 0 });
				expect(
					db
						.prepare(
							"SELECT project FROM sessions WHERE id NOT IN (SELECT session_id FROM memory_items)",
						)
						.get(),
				).toEqual({ project: remapProject?.trim() || null });
				expect(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 1 });
			} finally {
				db.close();
			}
		},
	);

	it.each(
		["", "   "].flatMap((remapProject) => [true, false].map((moved) => ({ remapProject, moved }))),
	)(
		"blank remap preserves deliberate project moves or reconciles unchanged attribution ($remapProject, moved=$moved)",
		({ remapProject, moved }) => {
			// Arrange: blank remap must not override a move or suppress new readable evidence.
			const dbPath = destination();
			const incoming = payload("alpha");
			const opts = { dbPath, remapProject };
			importMemories(incoming, opts);
			const db = new Database(dbPath);
			try {
				db.prepare("UPDATE memory_items SET project = ?").run(moved ? "alpha" : "beta");
				if (moved) db.prepare("UPDATE sessions SET project = 'stale'").run();
				const before = db.prepare("SELECT * FROM sessions").get() as Record<string, unknown>;

				// Act: preserve the moved row; only the unchanged attribution may recompute.
				const repeated = importMemories(incoming, opts);

				// Assert: stored beta replaces computed alpha/NULL, never the deliberate stale move.
				expect(repeated).toMatchObject({ sessions: 0, memory_items: 0 });
				let expected = before;
				if (!moved)
					expected = {
						...before,
						project: "beta",
						metadata_json: JSON.stringify({
							...JSON.parse(String(before.metadata_json)),
							placeholder_project: "beta",
						}),
					};
				expect(db.prepare("SELECT * FROM sessions").get()).toEqual(expected);
			} finally {
				db.close();
			}
		},
	);

	it.each([
		{ first: "alpha", second: "beta", remapProject: null },
		{ first: "beta", second: "alpha", remapProject: null },
		{ first: "alpha", second: "alpha", remapProject: null },
		{ first: "alpha", second: "beta", remapProject: "remapped" },
		{ first: "beta", second: "alpha", remapProject: "remapped" },
	])("reconciles stored readable projects after incremental imports: %j", (state) => {
		// Arrange: each payload contains only one readable slice of the same canonical session.
		const dbPath = destination();
		const first = payload(state.first);
		const second = payload(state.second);
		const opts = { dbPath, remapProject: state.remapProject };

		// Act: ingest both slices and repeat the first, including a misleading deduped payload project.
		importMemories(first, opts);
		const incremental = importMemories(second, opts);
		const duplicate = structuredClone(first);
		duplicate.memory_items = duplicate.memory_items.map((memory) => ({
			...memory,
			project: "not-new-evidence",
		}));
		const repeated = importMemories(duplicate, opts);
		const store = new MemoryStore(dbPath);
		try {
			// Assert: mixed projects use memory attribution; remapped/single projects retain one label.
			const projects = [...new Set([state.first, state.second])];
			expect(store.db.prepare("SELECT project FROM sessions").get()).toEqual({
				project: state.remapProject ?? (projects.length === 1 ? state.first : null),
			});
			expect(incremental.memory_items).toBe(projects.length - 1);
			expect(repeated).toMatchObject({ sessions: 0, memory_items: 0 });
			for (const project of projects) {
				const filter = { project: state.remapProject ?? project };
				const count = state.remapProject ? projects.length : 1;
				expect(store.recent(10, filter)).toHaveLength(count);
				expect(store.recentByKinds(["feature"], 10, filter)).toHaveLength(count);
				expect(store.search("projectneedle", 10, filter)).toHaveLength(count);
			}
			expect(store.recent(10, { project: "not-new-evidence" })).toEqual([]);
		} finally {
			store.close();
		}
	});

	it.each(["full", "unrecognized"])(
		"never relabels an authoritative or non-placeholder session (%s)",
		(initial) => {
			// Arrange: full context or locally edited placeholder evidence must remain authoritative.
			const dbPath = destination();
			importMemories(payload("source", initial !== "full"), { dbPath });
			const db = new Database(dbPath);
			try {
				if (initial === "unrecognized")
					db.prepare("UPDATE sessions SET cwd = '/fixture/local'").run();
				const before = db.prepare("SELECT * FROM sessions").get();

				// Act: later redacted payloads contain different readable memory projects.
				importMemories(payload("alpha"), { dbPath });
				importMemories(payload("beta"), { dbPath });

				// Assert: no redacted payload can clear or replace real/local source context.
				expect(db.prepare("SELECT * FROM sessions").get()).toEqual(before);
				expect(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 3 });
			} finally {
				db.close();
			}
		},
	);
});
