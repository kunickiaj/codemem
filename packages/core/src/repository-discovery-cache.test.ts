import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import {
	__repositoryDiscoveryCacheTestHooks,
	repositoryIdentitiesFromIndexedEvidence,
} from "./repository-discovery-cache.js";
import {
	ensureRepositoryDiscoveryIndex,
	loadRepositoryDiscoveryEvidence,
	repositoryDiscoveryRevision,
} from "./repository-discovery-index.js";
import { initTestSchema } from "./test-utils.js";

it("bounds identity-map variants across repeated mapping edits", () => {
	const db = new Database(":memory:");
	const cwd = "/workspace/recorded";
	const repository = "https://example.test/acme/recorded.git";
	try {
		initTestSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		db.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, ?)").run(
			"2026-09-24T00:00:00.000Z",
			cwd,
			JSON.stringify({ codemem_repository_identity: repository }),
		);
		for (let index = 0; index < 32; index++) {
			const result = repositoryIdentitiesFromIndexedEvidence(db, [
				`https://example.test/acme/mapping-${index}.git`,
			]);
			expect(result?.identities.get(cwd)).toBe(repository);
			expect(__repositoryDiscoveryCacheTestHooks.variantCount(db)).toBeLessThanOrEqual(8);
		}
		expect(
			repositoryIdentitiesFromIndexedEvidence(db, [
				"https://example.test/acme/mapping-0.git",
			])?.identities.get(cwd),
		).toBe(repository);
	} finally {
		db.close();
	}
});

it("keeps indexed evidence usable beside a relative historical cwd", () => {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		db.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, '{}')").run(
			"2026-09-24T00:00:00.000Z",
			"relative/old-checkout",
		);
		const first = repositoryIdentitiesFromIndexedEvidence(db, [
			"https://example.test/acme/current.git",
		]);
		expect(first).not.toBeNull();
		expect(
			db
				.prepare("SELECT filesystem_identity FROM repository_workspace_evidence WHERE cwd = ?")
				.pluck()
				.get("relative/old-checkout"),
		).toBeNull();
		expect(__repositoryDiscoveryCacheTestHooks.variantCount(db)).toBe(1);
		expect(repositoryIdentitiesFromIndexedEvidence(db, [])).not.toBeNull();
	} finally {
		db.close();
	}
});

it("drops an in-memory snapshot when a missing trigger is repaired", () => {
	const db = new Database(":memory:");
	const cwd = "/workspace/trigger-repaired";
	const before = "https://example.test/acme/before.git";
	const after = "https://example.test/acme/after.git";
	try {
		initTestSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		const sessionId = Number(
			db
				.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, ?)")
				.run(
					"2026-09-24T00:00:00.000Z",
					cwd,
					JSON.stringify({ codemem_repository_identity: before }),
				).lastInsertRowid,
		);
		expect(repositoryIdentitiesFromIndexedEvidence(db, [before])?.identities.get(cwd)).toBe(before);
		db.exec("DROP TRIGGER trg_repository_discovery_session_update");
		db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?").run(
			JSON.stringify({ codemem_repository_identity: after }),
			sessionId,
		);
		ensureRepositoryDiscoveryIndex(db);
		expect(repositoryIdentitiesFromIndexedEvidence(db, [after])?.identities.get(cwd)).toBe(after);
	} finally {
		db.close();
	}
});

it("rebuilds recorded sibling evidence after repairing a missing index table", () => {
	const db = new Database(":memory:");
	const repository = "https://example.test/acme/linked.git";
	const siblings = ["/workspace/linked-main", "/workspace/linked-sibling"];
	try {
		initTestSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		const insert = db.prepare(
			"INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, ?)",
		);
		for (const cwd of siblings) {
			insert.run(
				"2026-09-24T00:00:00.000Z",
				cwd,
				JSON.stringify({ codemem_repository_identity: repository }),
			);
		}
		const before = repositoryIdentitiesFromIndexedEvidence(db, [repository]);
		expect([...(before?.identities.values() ?? [])]).toEqual([repository, repository]);
		const revision = repositoryDiscoveryRevision(db);
		db.exec("DROP TABLE repository_workspace_evidence");
		ensureRepositoryDiscoveryIndex(db);
		expect(loadRepositoryDiscoveryEvidence(db)).toBeNull();
		expect(repositoryDiscoveryRevision(db)).toBeGreaterThan(revision ?? 0);
		const after = repositoryIdentitiesFromIndexedEvidence(db, [repository]);
		expect([...(after?.identities.values() ?? [])]).toEqual([repository, repository]);
		expect(db.prepare("SELECT COUNT(*) FROM repository_workspace_evidence").pluck().get()).toBe(2);
	} finally {
		db.close();
	}
});
