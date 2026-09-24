import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
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
		expect(repositoryDiscoveryRevision(db)).toBe(1);
		expect(loadRepositoryDiscoveryEvidence(db)).toBeNull();
		const sessionId = Number(
			db
				.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, ?)")
				.run("2026-09-24T00:00:00Z", "/workspace/one", "{}").lastInsertRowid,
		);
		const revision = repositoryDiscoveryRevision(db);
		expect(revision).toBe(2);
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
		expect(repositoryDiscoveryRevision(db)).toBe(3);
		expect(loadRepositoryDiscoveryEvidence(db)).toBeNull();
		expect(replaceRepositoryDiscoveryEvidence(db, revision ?? -1, [])).toBe(false);
		expect(db.prepare("SELECT cwd FROM repository_workspace_evidence").pluck().all()).toEqual([
			"/workspace/one",
		]);
		db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run("/workspace/two", sessionId);
		expect(repositoryDiscoveryRevision(db)).toBe(4);
		db.prepare("UPDATE sessions SET git_remote = ? WHERE id = ?").run(
			"https://example.test/second.git",
			sessionId,
		);
		expect(repositoryDiscoveryRevision(db)).toBe(5);
		db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
		expect(repositoryDiscoveryRevision(db)).toBe(6);
		db.exec("DROP TRIGGER trg_repository_discovery_session_update");
		expect(repositoryDiscoveryRevision(db)).toBeNull();
		ensureRepositoryDiscoveryIndex(db);
		expect(repositoryDiscoveryRevision(db)).toBe(7);
	} finally {
		db.close();
	}
});

it("invalidates indexed evidence after restoring a missing session trigger", () => {
	const db = new Database(":memory:");
	try {
		bootstrapSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		const sessionId = Number(
			db
				.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, ?)")
				.run("2026-09-24T00:00:00Z", "/workspace/trigger-repair", "{}").lastInsertRowid,
		);
		const revision = repositoryDiscoveryRevision(db);
		expect(replaceRepositoryDiscoveryEvidence(db, revision ?? -1, [])).toBe(true);
		db.exec("DROP TRIGGER trg_repository_discovery_session_update");
		db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?").run(
			'{"codemem_repository_identity":"https://example.test/new.git"}',
			sessionId,
		);
		ensureRepositoryDiscoveryIndex(db);
		expect(loadRepositoryDiscoveryEvidence(db)).toBeNull();
	} finally {
		db.close();
	}
});

it("holds a write lock while invalidating and repairing a missing trigger", () => {
	const directory = mkdtempSync(join(tmpdir(), "codemem-discovery-repair-"));
	const path = join(directory, "evidence.sqlite");
	const db = new Database(path);
	const other = new Database(path);
	try {
		bootstrapSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		const sessionId = Number(
			db
				.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, '{}')")
				.run("2026-09-24T00:00:00Z", "/workspace/race").lastInsertRowid,
		);
		const revision = repositoryDiscoveryRevision(db);
		expect(replaceRepositoryDiscoveryEvidence(db, revision ?? -1, [])).toBe(true);
		db.exec("DROP TRIGGER trg_repository_discovery_session_update");
		other.pragma("busy_timeout = 0");
		let blocked = false;
		const exec = db.exec.bind(db);
		const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
			if (sql.includes("CREATE TRIGGER IF NOT EXISTS trg_repository_discovery_session_insert")) {
				try {
					other
						.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?")
						.run('{"codemem_repository_identity":"https://example.test/raced.git"}', sessionId);
				} catch (error) {
					blocked = String(error).includes("database is locked");
				}
			}
			return exec(sql);
		});
		try {
			ensureRepositoryDiscoveryIndex(db);
		} finally {
			spy.mockRestore();
		}
		expect(blocked).toBe(true);
		other
			.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?")
			.run('{"codemem_repository_identity":"https://example.test/after.git"}', sessionId);
		expect(loadRepositoryDiscoveryEvidence(db)).toBeNull();
	} finally {
		other.close();
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
