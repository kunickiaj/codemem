import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import {
	readRepositoryIdentitySnapshot,
	recordedRepositoryIdentitySetsByWorkspace,
} from "./repository-mapping-aliases.js";
import { ensureSessionsRepositoryEvidenceIndex } from "./sessions-repository-evidence-index.js";
import { initTestSchema } from "./test-utils.js";

const INDEX = "idx_sessions_repository_evidence";

let db: Database.Database;
beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	ensureAdditiveSchemaCompatibility(db);
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

let sessionId = 0;
function session(cwd: string | null, metadataJson: string | null, gitRemote: string | null = null) {
	sessionId += 1;
	db.prepare(
		`INSERT INTO sessions(id, started_at, cwd, project, git_remote, metadata_json)
		 VALUES (?, '2026-11-27T00:00:00Z', ?, 'p', ?, ?)`,
	).run(sessionId, cwd, gitRemote, metadataJson);
}

const identity = (value: unknown) => JSON.stringify({ codemem_repository_identity: value, pad: 1 });

/** The plan of every sessions read that `read` prepares. */
function sessionReadPlans(read: () => unknown): string[] {
	const prepared: string[] = [];
	const prepare = db.prepare.bind(db);
	vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
		if (/\bFROM sessions\b/.test(sql)) prepared.push(sql);
		return prepare(sql);
	}) as typeof db.prepare);
	read();
	vi.restoreAllMocks();
	return prepared.map((sql) =>
		(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
			.map((row) => row.detail)
			.join("; "),
	);
}

describe("sessions repository evidence index", () => {
	it("is created by the schema check and keeps repository reads on the index", () => {
		session("/w/a", identity("github.com/o/a"));

		const plans = sessionReadPlans(() => readRepositoryIdentitySnapshot(db));

		expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(INDEX)).toBeTruthy();
		expect(plans).toHaveLength(2);
		for (const plan of plans) expect(plan).toContain(`USING COVERING INDEX ${INDEX}`);
	});

	it("reads the same recorded identities per folder as parsing the metadata did", () => {
		session("/w/a", identity("github.com/o/a"));
		session("/w/a", identity("  github.com/o/a  "));
		// A non-text identity falls back to the git remote.
		session("/w/b", identity(7), "github.com/o/b");
		// Malformed JSON and blank identities record nothing.
		session("/w/c", '{"codemem_repository_identity": "github.com/o/c"');
		session("/w/d", identity("   "));
		// The key named only as a value is not an identity.
		session("/w/g", JSON.stringify({ note: "codemem_repository_identity" }));
		session("/w/e", identity("github.com/o/e1"));
		session("/w/e", identity("github.com/o/e2"));
		session("/w/f", identity("github.com/o/f"), "github.com/o/other");
		session("/w/h", null, "github.com/o/h");
		session("", identity("github.com/o/blank"));
		session(null, identity("github.com/o/none"));

		const recorded = recordedRepositoryIdentitySetsByWorkspace(db);

		expect(
			Object.fromEntries([...recorded].map(([cwd, identities]) => [cwd, [...identities].sort()])),
		).toEqual({
			"/w/a": ["github.com/o/a"],
			"/w/b": ["github.com/o/b"],
			"/w/e": ["github.com/o/e1", "github.com/o/e2"],
			"/w/f": ["github.com/o/f"],
			"/w/h": ["github.com/o/h"],
		});
	});

	it("leaves a read-only connection without the index", () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-repo-evidence-"));
		const path = join(directory, "mem.sqlite");
		const writable = new Database(path);
		initTestSchema(writable);
		writable.close();
		const readonly = new Database(path, { readonly: true });
		try {
			expect(() => ensureSessionsRepositoryEvidenceIndex(readonly)).not.toThrow();
			expect(
				readonly.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(INDEX),
			).toBeUndefined();
		} finally {
			readonly.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
