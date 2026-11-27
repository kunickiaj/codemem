import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, ensureAdditiveSchemaCompatibility } from "./db.js";
import {
	recordedRepositoryIdentityEvidenceByWorkspace,
	recordedRepositoryIdentitySetsByWorkspace,
	repositoryIdentitiesByWorkspace,
} from "./repository-mapping-aliases.js";
import { resolveSessionScopeId } from "./scope-stamping.js";
import {
	checkSessionRepositoryIdentities,
	installSessionRepositoryIdentity,
	SESSION_IDENTITY_CHECKED_COLUMN,
	SESSION_IDENTITY_COLUMN,
	sessionRepositoryIdentityReady,
} from "./session-repository-identity.js";
import { MemoryStore } from "./store.js";
import { syncPassPreflight } from "./sync-pass.js";
import { initTestSchema } from "./test-utils.js";

let tmpDir: string;
let originalConfig: string | undefined;
beforeEach(() => {
	originalConfig = process.env.CODEMEM_CONFIG;
	tmpDir = mkdtempSync(join(tmpdir(), "codemem-session-identity-"));
	process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
});
afterEach(() => {
	if (originalConfig === undefined) delete process.env.CODEMEM_CONFIG;
	else process.env.CODEMEM_CONFIG = originalConfig;
	rmSync(tmpDir, { recursive: true, force: true });
});

function openDb(): Database {
	const db = connect(join(tmpDir, "mem.sqlite"));
	initTestSchema(db);
	ensureAdditiveSchemaCompatibility(db);
	return db;
}

function insertSession(db: Database, cwd: string, metadataJson: string | null): number {
	return Number(
		db
			.prepare(
				"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES ('2026-11-27T00:00:00Z', ?, 'p', ?)",
			)
			.run(cwd, metadataJson).lastInsertRowid,
	);
}

const KEY = "codemem_repository_identity";
// The JavaScript parser decodes the escaped key and keeps the last of duplicate keys;
// SQLite's JSON functions do neither, and reject JSON nested over 1,000 levels deep.
const ESCAPED = '{"codemem\\u005frepository_identity":"github.com/o/escaped","pad":1}';
const DUPLICATE = `{"${KEY}":"github.com/o/first","${KEY}":"github.com/o/last"}`;
const DEEP = `{"${KEY}":"github.com/o/deep","x":${"[".repeat(1_100)}${"]".repeat(1_100)}}`;

const FOLDERS = {
	"/nonexistent-codemem/escaped": ESCAPED,
	"/nonexistent-codemem/duplicate": DUPLICATE,
	"/nonexistent-codemem/deep": DEEP,
};
const EXPECTED = {
	"/nonexistent-codemem/escaped": ["github.com/o/escaped"],
	"/nonexistent-codemem/duplicate": ["github.com/o/last"],
	"/nonexistent-codemem/deep": ["github.com/o/deep"],
};

function readBothWays(db: Database) {
	const sets = recordedRepositoryIdentitySetsByWorkspace(db);
	const evidence = recordedRepositoryIdentityEvidenceByWorkspace(db, Object.keys(FOLDERS));
	return {
		sets: Object.fromEntries([...sets].map(([cwd, ids]) => [cwd, [...ids].sort()])),
		evidence: Object.fromEntries(
			Object.keys(FOLDERS).map((cwd) => [cwd, [evidence.byWorkspace.get(cwd)]]),
		),
	};
}

describe("session repository identities", () => {
	it("resolve escaped, duplicate and deeply nested keys as JSON.parse does at every backfill stage", () => {
		const db = openDb();
		try {
			for (const [cwd, metadata] of Object.entries(FOLDERS)) insertSession(db, cwd, metadata);
			expect(JSON.parse(DEEP)[KEY]).toBe("github.com/o/deep");

			// Before the worker installs the column, after it with nothing checked, part-way
			// through the backfill, and once every row is checked.
			const stages = [
				() => undefined,
				() => installSessionRepositoryIdentity(db),
				() => checkSessionRepositoryIdentities(db, 1),
				() => checkSessionRepositoryIdentities(db, 100),
			];
			for (const advance of stages) {
				advance();
				expect(readBothWays(db)).toEqual({ sets: EXPECTED, evidence: EXPECTED });
			}
			expect(
				db
					.prepare(`SELECT COUNT(*) FROM sessions WHERE ${SESSION_IDENTITY_CHECKED_COLUMN} = 1`)
					.pluck()
					.get(),
			).toBe(3);
		} finally {
			db.close();
		}
	});

	it("forgets a checked identity when a session's metadata changes or a row arrives flagged", () => {
		const db = openDb();
		try {
			const id = insertSession(db, "/nonexistent-codemem/a", `{"${KEY}":"github.com/o/a"}`);
			installSessionRepositoryIdentity(db);
			checkSessionRepositoryIdentities(db, 10);

			db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?").run(
				`{"${KEY}":"github.com/o/b"}`,
				id,
			);
			const flaggedId = Number(
				db
					.prepare(
						`INSERT INTO sessions(started_at, cwd, metadata_json, ${SESSION_IDENTITY_COLUMN}, ${SESSION_IDENTITY_CHECKED_COLUMN})
						 VALUES ('2026-11-27', '/nonexistent-codemem/c', '{}', 'github.com/o/forged', 1)`,
					)
					.run().lastInsertRowid,
			);

			const state = db.prepare(
				`SELECT ${SESSION_IDENTITY_COLUMN} AS identity, ${SESSION_IDENTITY_CHECKED_COLUMN} AS checked
				 FROM sessions WHERE id = ?`,
			);
			expect(state.get(id)).toEqual({ identity: null, checked: null });
			expect(state.get(flaggedId)).toEqual({ identity: null, checked: null });
			expect(recordedRepositoryIdentitySetsByWorkspace(db).get("/nonexistent-codemem/a")).toEqual(
				new Set(["github.com/o/b"]),
			);
			expect(recordedRepositoryIdentitySetsByWorkspace(db).has("/nonexistent-codemem/c")).toBe(
				false,
			);
		} finally {
			db.close();
		}
	});

	it("parses metadata while a reset trigger is missing, and clears stale flags when it returns", () => {
		const db = openDb();
		try {
			const id = insertSession(db, "/nonexistent-codemem/a", `{"${KEY}":"github.com/o/a"}`);
			installSessionRepositoryIdentity(db);
			checkSessionRepositoryIdentities(db, 10);
			// An older release, or a damaged schema, without the trigger: an update goes unseen.
			db.exec("DROP TRIGGER trg_sessions_repository_identity_reset_update");
			db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?").run(
				`{"${KEY}":"github.com/o/b"}`,
				id,
			);
			const read = () =>
				recordedRepositoryIdentitySetsByWorkspace(db).get("/nonexistent-codemem/a");

			expect(sessionRepositoryIdentityReady(db)).toBe(false);
			expect(read()).toEqual(new Set(["github.com/o/b"]));
			installSessionRepositoryIdentity(db);
			expect(read()).toEqual(new Set(["github.com/o/b"]));
			checkSessionRepositoryIdentities(db, 10);
			expect(read()).toEqual(new Set(["github.com/o/b"]));
		} finally {
			db.close();
		}
	});

	it("is installed by the maintenance worker, not when the database opens", () => {
		const db = openDb();
		try {
			expect(sessionRepositoryIdentityReady(db)).toBe(false);
			expect(installSessionRepositoryIdentity(db)).toBe(true);
			expect(sessionRepositoryIdentityReady(db)).toBe(true);
		} finally {
			db.close();
		}
	});

	it("lets a sync preflight finish while another writer holds the lock", () => {
		const db = openDb();
		// A store whose repository-evidence index from an earlier build is not built yet.
		db.exec("DROP INDEX IF EXISTS idx_sessions_repository_evidence");
		const writer = connect(join(tmpDir, "mem.sqlite"));
		try {
			writer.exec("BEGIN IMMEDIATE");
			const started = Date.now();

			syncPassPreflight(db, { maxRuntimeMs: 100 });

			expect(Date.now() - started).toBeLessThan(1_000);
		} finally {
			if (writer.inTransaction) writer.exec("ROLLBACK");
			writer.close();
			db.close();
		}
	});
});

describe("session repository identity reads during the backfill", () => {
	it("keeps a session the worker checks while a read is in progress", () => {
		const db = openDb();
		const worker = connect(join(tmpDir, "mem.sqlite"));
		try {
			insertSession(db, "/nonexistent-codemem/a", `{"${KEY}":"github.com/o/a"}`);
			installSessionRepositoryIdentity(db);
			// The worker checks the session as soon as the read has run its first statement.
			const prepare = db.prepare.bind(db);
			let checkedDuringRead = false;
			const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
				const statement = prepare(sql);
				if (!sql.includes(`${SESSION_IDENTITY_CHECKED_COLUMN} = 1`)) return statement;
				const all = statement.all.bind(statement);
				statement.all = ((...params: unknown[]) => {
					const rows = all(...params);
					if (!checkedDuringRead)
						checkedDuringRead = checkSessionRepositoryIdentities(worker, 10) > 0;
					return rows;
				}) as typeof statement.all;
				return statement;
			}) as typeof db.prepare);

			const recorded = recordedRepositoryIdentitySetsByWorkspace(db);
			spy.mockRestore();

			expect(checkedDuringRead).toBe(true);
			expect(recorded.get("/nonexistent-codemem/a")).toEqual(new Set(["github.com/o/a"]));
		} finally {
			worker.close();
			db.close();
		}
	});
});

describe("stamping and the write check across the session identity upgrade", () => {
	const repository = "https://example.test/acme/escaped.git";

	function storeWithLocalOnlyConflict() {
		const dbPath = join(tmpDir, "mem.sqlite");
		const setup = connect(dbPath);
		initTestSchema(setup);
		setup.close();
		const store = new MemoryStore(dbPath);
		const localOnly = join(tmpDir, "local-only-checkout");
		const shared = join(tmpDir, "shared-checkout");
		mkdirSync(localOnly);
		mkdirSync(shared);
		store.db
			.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
				 ) VALUES ('shared-scope', 'shared', 'team', 'coordinator', 1, 'active', '2026-11-27', '2026-11-27')`,
			)
			.run();
		const mapping = store.db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 10, 'user', '2026-11-27', '2026-11-27')`,
		);
		// The shared checkout's mapping, and a local-only mapping for another checkout of the
		// same repository, which that checkout records only under an escaped key.
		mapping.run(shared, shared, "shared-scope");
		mapping.run(null, localOnly, "local-default");
		insertSession(store.db, localOnly, `{"codemem\\u005frepository_identity":"${repository}"}`);
		const sessionId = insertSession(store.db, shared, JSON.stringify({ [KEY]: repository }));
		return { store, dbPath, sessionId, localOnly };
	}

	function expectAgreement(store: MemoryStore, sessionId: number) {
		const writeCheck = resolveSessionScopeId(store.db, { sessionId, readOnly: true });
		const stamping = resolveSessionScopeId(store.db, { sessionId });
		// The conflict sets both mappings aside, so neither stamps the shared scope.
		expect({ writeCheck, stamping }).toEqual({
			writeCheck: "local-default",
			stamping: "local-default",
		});
	}

	it("agree on a local-only conflict before, during and after the backfill", () => {
		const fixture = storeWithLocalOnlyConflict();
		const { dbPath, sessionId, localOnly } = fixture;
		let store = fixture.store;
		try {
			expect(repositoryIdentitiesByWorkspace(store.db).get(localOnly)).toBe(repository);
			expectAgreement(store, sessionId);

			// Discovery evidence that an earlier release saved, which lost the escaped identity:
			// the checkout recorded nothing and has no git directory, as of its current mtime.
			const stat = statSync(localOnly, { bigint: true });
			store.db.exec("DROP TABLE IF EXISTS repository_discovery_format");
			store.db
				.prepare(
					`UPDATE repository_workspace_evidence
					 SET recorded_identities_json = '[]', filesystem_identity = NULL,
					     filesystem_anchor = ?, anchor_mtime_ns = ?
					 WHERE cwd = ?`,
				)
				.run(localOnly, `${stat.dev}:${stat.ino}:${stat.mtimeNs}`, localOnly);
			store.close();
			store = new MemoryStore(dbPath);
			expectAgreement(store, sessionId);

			installSessionRepositoryIdentity(store.db);
			expectAgreement(store, sessionId);
			checkSessionRepositoryIdentities(store.db, 1);
			expectAgreement(store, sessionId);
			checkSessionRepositoryIdentities(store.db, 100);
			expectAgreement(store, sessionId);
		} finally {
			store.close();
		}
	});
});
