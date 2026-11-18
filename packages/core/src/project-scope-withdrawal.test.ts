import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	connect,
	type Database,
	ensureAdditiveSchemaCompatibility,
	getSchemaVersion,
	SCHEMA_VERSION,
	tableExists,
} from "./db.js";
import { managedProjectScopeId } from "./managed-project-scope.js";
import { listProjectBoundaryMigrationRecords } from "./project-boundary-migration-records.js";
import {
	isProjectScopeWithdrawn,
	listProjectScopeWithdrawals,
	resumeProjectScope,
	withdrawProjectScope,
} from "./project-scope-withdrawal.js";

const GROUP = "group-a";
const PROJECT = "git:example/atlas";
const BOUNDARY = managedProjectScopeId(GROUP, PROJECT);
const NOW = "2026-11-18T10:00:00.000Z";
const LATER = "2026-11-18T11:00:00.000Z";

let directory: string;
let db: Database;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-withdrawal-"));
	db = connect(join(directory, "mem.sqlite"));
	ensureAdditiveSchemaCompatibility(db);
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("project scope withdrawal schema", () => {
	it("creates the withdrawal table at the current schema version", () => {
		expect(tableExists(db, "project_scope_withdrawals")).toBe(true);
		expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
	});

	it("creates the table on a database that schema 23 left marked as upgraded", () => {
		// Arrange: drop the table and mark the database as already at 23.
		db.exec(`
			DROP TABLE project_scope_withdrawals;
			PRAGMA user_version = 23;
			INSERT OR REPLACE INTO schema_compat_state VALUES (1, 23, '2026-11-01T00:00:00Z');
		`);

		// Act
		ensureAdditiveSchemaCompatibility(db);

		// Assert
		expect(tableExists(db, "project_scope_withdrawals")).toBe(true);
	});
});

describe("withdrawing this device from a Project's boundary", () => {
	it("records a withdrawal keyed by the boundary scope ID", () => {
		withdrawProjectScope(db, {
			canonicalProjectIdentity: PROJECT,
			groupId: GROUP,
			now: NOW,
		});

		expect(isProjectScopeWithdrawn(db, BOUNDARY)).toBe(true);
		expect(listProjectScopeWithdrawals(db)).toEqual([
			{
				scopeId: BOUNDARY,
				canonicalProjectIdentity: PROJECT,
				groupId: GROUP,
				withdrawnAt: NOW,
			},
		]);
	});

	it("is idempotent and keeps the first withdrawal time", () => {
		withdrawProjectScope(db, { canonicalProjectIdentity: PROJECT, groupId: GROUP, now: NOW });
		withdrawProjectScope(db, { canonicalProjectIdentity: PROJECT, groupId: GROUP, now: LATER });

		expect(listProjectScopeWithdrawals(db)).toEqual([
			expect.objectContaining({ scopeId: BOUNDARY, withdrawnAt: NOW }),
		]);
	});

	it("undoes a withdrawal and reports the boundary it reopened", () => {
		withdrawProjectScope(db, { canonicalProjectIdentity: PROJECT, groupId: GROUP, now: NOW });

		const resumed = resumeProjectScope(db, { scopeId: BOUNDARY, now: LATER });

		expect(resumed).toBe(true);
		expect(isProjectScopeWithdrawn(db, BOUNDARY)).toBe(false);
		expect(listProjectScopeWithdrawals(db)).toEqual([]);
		expect(resumeProjectScope(db, { scopeId: BOUNDARY, now: LATER })).toBe(false);
	});

	it("reports nothing withdrawn for other scopes or before the table exists", () => {
		withdrawProjectScope(db, { canonicalProjectIdentity: PROJECT, groupId: GROUP, now: NOW });
		expect(isProjectScopeWithdrawn(db, "team:group-a:default")).toBe(false);

		db.exec("DROP TABLE project_scope_withdrawals");
		expect(isProjectScopeWithdrawn(db, BOUNDARY)).toBe(false);
		expect(listProjectScopeWithdrawals(db)).toEqual([]);
	});

	it("leaves migration records alone", () => {
		db.prepare(
			`INSERT INTO project_boundary_migrations(
			 boundary_scope_id, source_scope_id, state, generation, created_at, updated_at
			 ) VALUES (?, 'team:group-a:default', 'committed', 1, ?, ?)`,
		).run(BOUNDARY, NOW, NOW);
		const before = listProjectBoundaryMigrationRecords(db);

		withdrawProjectScope(db, { canonicalProjectIdentity: PROJECT, groupId: GROUP, now: NOW });
		resumeProjectScope(db, { scopeId: BOUNDARY, now: LATER });

		expect(listProjectBoundaryMigrationRecords(db)).toEqual(before);
	});
});
