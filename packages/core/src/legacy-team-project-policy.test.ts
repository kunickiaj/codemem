import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { isMigratableLegacyTeamProjectIdentity } from "./legacy-team-project-policy.js";
import { SYNC_BOOTSTRAP_CWD_PREFIX } from "./sync-bootstrap-constants.js";
import { initTestSchema } from "./test-utils.js";

describe("isMigratableLegacyTeamProjectIdentity", () => {
	it.each([
		"shared",
		"shared:default",
		"shared:legacy",
		"personal:actor-1",
		"peer-received:peer-a:project:codemem",
	])("rejects synthetic workspace identity %s", (identity) => {
		expect(isMigratableLegacyTeamProjectIdentity(identity)).toBe(false);
	});

	it.each([
		"shared:team",
		"shared:workspace-only",
		"https://example.invalid/project.git",
	])("accepts canonical Project identity %s", (identity) => {
		expect(isMigratableLegacyTeamProjectIdentity(identity)).toBe(true);
	});

	it("accepts peer-prefixed identities only when local inventory proves ownership", () => {
		const db = new Database(":memory:");
		initTestSchema(db);
		try {
			const localIdentity = "peer-received:local-workspace";
			const replicatedIdentity = "peer-received:replicated-workspace";
			const incrementallyReplicatedIdentity = "peer-received:incremental-workspace";
			const inactiveReplicatedIdentity = "peer-received:inactive-replicated-workspace";
			const inactiveIdentity = "peer-received:inactive-workspace";
			const insertSession = db.prepare(
				"INSERT INTO sessions(started_at, cwd, tool_version) VALUES (?, ?, ?)",
			);
			const insertMemory = db.prepare(
				`INSERT INTO memory_items(
				 session_id, kind, title, body_text, active, created_at, updated_at, workspace_id
				 ) VALUES (?, 'discovery', 'title', 'body', ?, ?, ?, ?)`,
			);
			const localSessionId = Number(
				insertSession.run("2026-08-31T00:00:00.000Z", null, null).lastInsertRowid,
			);
			insertMemory.run(
				localSessionId,
				1,
				"2026-08-31T00:00:00.000Z",
				"2026-08-31T00:00:00.000Z",
				`${localIdentity}/`,
			);
			const replicatedSessionId = Number(
				insertSession.run("2026-08-31T00:00:00.000Z", `${SYNC_BOOTSTRAP_CWD_PREFIX}:peer`, null)
					.lastInsertRowid,
			);
			insertMemory.run(
				replicatedSessionId,
				1,
				"2026-08-31T00:00:00.000Z",
				"2026-08-31T00:00:00.000Z",
				replicatedIdentity,
			);
			const incrementalSessionId = Number(
				insertSession.run("2026-08-31T00:00:00.000Z", null, "sync_replication").lastInsertRowid,
			);
			insertMemory.run(
				incrementalSessionId,
				1,
				"2026-08-31T00:00:00.000Z",
				"2026-08-31T00:00:00.000Z",
				incrementallyReplicatedIdentity,
			);
			insertMemory.run(
				incrementalSessionId,
				0,
				"2026-08-31T00:00:00.000Z",
				"2026-08-31T00:00:00.000Z",
				inactiveReplicatedIdentity,
			);
			insertMemory.run(
				localSessionId,
				0,
				"2026-08-31T00:00:00.000Z",
				"2026-08-31T00:00:00.000Z",
				inactiveIdentity,
			);

			expect(isMigratableLegacyTeamProjectIdentity(localIdentity, db)).toBe(true);
			expect(isMigratableLegacyTeamProjectIdentity(replicatedIdentity, db)).toBe(false);
			expect(isMigratableLegacyTeamProjectIdentity(incrementallyReplicatedIdentity, db)).toBe(
				false,
			);
			expect(isMigratableLegacyTeamProjectIdentity(inactiveReplicatedIdentity, db)).toBe(false);
			expect(isMigratableLegacyTeamProjectIdentity(inactiveIdentity, db)).toBe(true);
			expect(isMigratableLegacyTeamProjectIdentity(localIdentity)).toBe(false);
		} finally {
			db.close();
		}
	});
});
