import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, connectReadOnly, getSchemaVersion } from "./db.js";
import { createHistoricalStore, releases } from "./project-migration-history-test-fixtures.js";
import { readLocalProjectMigrationReport } from "./project-migration-report.js";

const PEER_ONLY = { sync_boundary_migration: "report" };
const CONFIG = {
	...PEER_ONLY,
	sync_coordinator_url: "https://coord.example",
	sync_coordinator_group: "test",
};
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "migration-report-"));
	for (const key of [
		"SYNC_BOUNDARY_MIGRATION",
		"SYNC_COORDINATOR_URL",
		"SYNC_COORDINATOR_GROUP",
		"SYNC_COORDINATOR_GROUPS",
		"SYNC_PROJECTS_INCLUDE",
		"SYNC_PROJECTS_EXCLUDE",
	])
		vi.stubEnv(`CODEMEM_${key}`, undefined);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("local migration report on historical store shapes", () => {
	for (const release of releases) {
		it(`reads ${release[0]} without migrating or changing the pairing`, () => {
			const path = createHistoricalStore(directory, release);
			const fixture = new DatabaseSync(path);
			try {
				fixture.exec(`INSERT INTO sync_peers(peer_device_id,created_at,projects_include_json)
					VALUES ('device-b','now','["example"]');
					INSERT INTO sessions(id,started_at,project) VALUES (1,'now','example');
					INSERT INTO memory_items(session_id,kind,title,body_text,created_at,updated_at,import_key)
					VALUES(1,'discovery','sample','sample','now','now','historical-key');`);
				if (release[2] >= 7) {
					fixture.exec(
						"UPDATE sync_peers SET discovered_via_coordinator_id='authority', discovered_via_group_id='test'",
					);
				}
			} finally {
				fixture.close();
			}
			const db = connectReadOnly(path);
			try {
				expect(getSchemaVersion(db)).toBe(release[2]);
				expect(readLocalProjectMigrationReport(db, PEER_ONLY)).toEqual({
					mode: "report",
					state: release[2] === 6 ? "not_applicable" : "waiting_for_coordinator",
				});
				expect(readLocalProjectMigrationReport(db, CONFIG)).toMatchObject({
					state: "local_report",
					local_filters: "present",
					projects: null,
				});
				expect(db.prepare("SELECT projects_include_json FROM sync_peers").pluck().get()).toBe(
					'["example"]',
				);
				expect(db.prepare("SELECT import_key FROM memory_items").pluck().get()).toBe(
					"historical-key",
				);
				expect(getSchemaVersion(db)).toBe(release[2]);
			} finally {
				db.close();
			}
		}, 30_000);
	}
});

function currentStore() {
	const db = connect(join(directory, "current.sqlite"));
	db.exec(`INSERT INTO sync_device(device_id,public_key,fingerprint,created_at) VALUES('me','key','fp','now');
		INSERT INTO replication_scopes(scope_id,label,kind,authority_type,coordinator_id,group_id,created_at,updated_at)
		VALUES ('source','source','team','coordinator','authority','test','now','now'),
		('other','other','team','coordinator','authority','test','now','now');
		INSERT INTO project_scope_mappings(workspace_identity,project_pattern,scope_id,created_at,updated_at)
		VALUES ('repository:example','*','source','now','now');
		INSERT INTO sessions(id,started_at,project,metadata_json) VALUES(1,'now','example','{"codemem_repository_identity":"repository:example"}');
		INSERT INTO memory_items(session_id,kind,title,body_text,created_at,updated_at,import_key,scope_id)
		VALUES(1,'discovery','secret title','secret content','now','now','stable-key','other');`);
	return db;
}

it("counts one split candidate without exporting names, content, or any readiness assertion", () => {
	const db = currentStore();
	try {
		expect(readLocalProjectMigrationReport(db, CONFIG)).toEqual({
			mode: "report",
			state: "local_report",
			local_filters: "none",
			maintenance_window: expect.stringMatching(/including current versions.*already read/),
			projects: { candidate_projects: 1, multiple_sources: 1, own_source_rows: 1 },
		});
		expect(readLocalProjectMigrationReport(db, {})).toEqual({ mode: "off", state: "off" });
		expect(readLocalProjectMigrationReport(db, PEER_ONLY).state).toBe("waiting_for_coordinator");
	} finally {
		db.close();
	}
});

it("reports retained overrides, active templates and environment filters conservatively", () => {
	const db = currentStore();
	try {
		const filters = () => readLocalProjectMigrationReport(db, CONFIG).local_filters;
		db.exec(
			`INSERT INTO peer_project_filter_retention(peer_device_id,projects_exclude_json) VALUES ('retired','invalid')`,
		);
		expect(filters()).toBe("unknown");
		db.exec(`UPDATE peer_project_filter_retention SET projects_exclude_json='["restricted"]'`);
		expect(filters()).toBe("present");
		db.exec(`DELETE FROM peer_project_filter_retention;
			INSERT INTO coordinator_group_preferences(coordinator_id,group_id,auto_seed_scope,projects_include_json,updated_at)
			VALUES ('authority','test',1,'["restricted"]','now')`);
		expect(filters()).toBe("present");
		db.exec("UPDATE coordinator_group_preferences SET auto_seed_scope=0");
		expect(filters()).toBe("none");
		vi.stubEnv("CODEMEM_SYNC_PROJECTS_INCLUDE", "only-this");
		expect(filters()).toBe("present");
	} finally {
		db.close();
	}
});
