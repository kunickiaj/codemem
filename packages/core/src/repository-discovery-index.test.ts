import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import {
	ensureRepositoryDiscoveryIndex,
	loadRepositoryDiscoveryEvidence,
	replaceRepositoryDiscoveryEvidence,
	repositoryDiscoveryRevision,
} from "./repository-discovery-index.js";
import { bootstrapSchema } from "./schema-bootstrap.js";

it("invalidates persisted repository evidence for every session identity mutation", () => {
	const db = new Database(":memory:");
	try {
		bootstrapSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		expect(repositoryDiscoveryRevision(db)).toBe(0);
		expect(loadRepositoryDiscoveryEvidence(db)).toBeNull();
		const sessionId = Number(
			db
				.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, ?)")
				.run("2026-09-24T00:00:00Z", "/workspace/one", "{}").lastInsertRowid,
		);
		const revision = repositoryDiscoveryRevision(db);
		expect(revision).toBe(1);
		const rows = [
			{
				cwd: "/workspace/one",
				recordedIdentitiesJson: "[]",
				filesystemIdentity: null,
				filesystemAnchor: "/workspace",
				anchorMtimeNs: "123",
				checkedAtMs: 1000,
			},
		];
		expect(replaceRepositoryDiscoveryEvidence(db, revision ?? -1, rows)).toBe(true);
		expect(loadRepositoryDiscoveryEvidence(db)).toEqual(rows);
		db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?").run(
			'{"codemem_repository_identity":"https://example.test/repo.git"}',
			sessionId,
		);
		expect(repositoryDiscoveryRevision(db)).toBe(2);
		expect(loadRepositoryDiscoveryEvidence(db)).toBeNull();
		expect(replaceRepositoryDiscoveryEvidence(db, revision ?? -1, [])).toBe(false);
		expect(db.prepare("SELECT cwd FROM repository_workspace_evidence").pluck().all()).toEqual([
			"/workspace/one",
		]);
		db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run("/workspace/two", sessionId);
		expect(repositoryDiscoveryRevision(db)).toBe(3);
		db.prepare("UPDATE sessions SET git_remote = ? WHERE id = ?").run(
			"https://example.test/second.git",
			sessionId,
		);
		expect(repositoryDiscoveryRevision(db)).toBe(4);
		db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
		expect(repositoryDiscoveryRevision(db)).toBe(5);
		ensureRepositoryDiscoveryIndex(db);
		expect(repositoryDiscoveryRevision(db)).toBe(5);
	} finally {
		db.close();
	}
});
