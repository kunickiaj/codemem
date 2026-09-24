import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import {
	__repositoryDiscoveryCacheTestHooks,
	repositoryIdentitiesFromIndexedEvidence,
} from "./repository-discovery-cache.js";
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
