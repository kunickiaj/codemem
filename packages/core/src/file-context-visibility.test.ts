import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { seedProvenMixedScopeFixture } from "./managed-scope-test-fixtures.js";
import { useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { buildMemoryPack } from "./pack.js";
import { findByFile, type RefQueryOptions } from "./ref-queries.js";
import { generateKeypair } from "./sync-identity.js";
import type { MixedScopeFixture } from "./test-utils.js";

const path = "src/security.ts";
const { fixture, enroll, rememberScoped } = useLocalCaptureFixture();
let scopes: MixedScopeFixture;

beforeEach(async () => {
	// Arrange: real validation of synthetic grants, with an explicit temporary signing key.
	enroll("file-device");
	scopes = await seedProvenMixedScopeFixture(
		fixture.store.db,
		fixture.keysDir,
		fixture.store.deviceId,
	);
	for (const id of scopes.allIds) addRef(id);
});

function addRef(id: number, file = path, relation = "modified") {
	fixture.store.db
		.prepare(
			"INSERT OR IGNORE INTO memory_file_refs(memory_id, file_path, relation) VALUES (?, ?, ?)",
		)
		.run(id, file, relation);
	fixture.store.db
		.prepare("UPDATE memory_items SET files_modified = ? WHERE id = ?")
		.run(JSON.stringify([file]), id);
}

function insertReplica(
	scopeId: string,
	title: string,
	options: { file?: string; relation?: string } = {},
) {
	const id = Number(
		fixture.store.db
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				tags_text, active, created_at, updated_at, metadata_json, visibility, scope_id, import_key)
				VALUES (?, 'decision', ?, ?, 0.9, '', 1, '2099-01-01', '2099-01-01', '{}', 'shared', ?, ?)`)
			.run(scopes.sessionId, title, `${title} confidential body`, scopeId, `replica-${title}`)
			.lastInsertRowid,
	);
	addRef(id, options.file, options.relation);
	return id;
}

function scopedIds(file = path, options?: RefQueryOptions) {
	return fixture.store.findByFile(file, options).map(({ id }) => id);
}

function assertReadParity(expectedIds: number[]) {
	const store = fixture.store;
	const visibleByGet = scopes.allIds.filter((id) => store.get(id) !== null);
	const visibleBySearch = store.search(scopes.query, 100).map(({ id }) => id);
	expect(visibleByGet.sort()).toEqual([...expectedIds].sort());
	expect(visibleBySearch.sort()).toEqual([...expectedIds].sort());
	expect(scopedIds().sort()).toEqual([...expectedIds].sort());
}

describe("file context uses the existing memory read boundary", () => {
	it("admits proven managed and local rows but denies an unproven managed replica", () => {
		// Arrange: seedProvenMixedScopeFixture grants only the authorized managed scope.
		const expectedIds = scopes.visibleIds;
		// Act / Assert: get and search are the existing policy, not a new file-specific policy.
		assertReadParity(expectedIds);
		const serialized = JSON.stringify(fixture.store.findByFile(path));
		expect(serialized).toContain(scopes.visibleTitles[1]);
		expect(serialized).not.toContain(scopes.unauthorizedTitle);
	});

	it.each([path, "src/"])("filters denied newest matches before LIMIT for %s", (file) => {
		// Arrange: every unfiltered candidate slot is denied, including the default window.
		const deniedIds = Array.from({ length: 45 }, (_, n) =>
			insertReplica(scopes.unauthorizedScopeId, `denied-window-${n}`),
		);
		fixture.store.db
			.prepare("UPDATE memory_items SET active = 0 WHERE id = ?")
			.run(scopes.personalId);
		// Act
		const raw = findByFile(fixture.store.db, file, { limit: 1 });
		const visible = fixture.store.findByFile(file, { limit: 1 });
		// Assert: filtering after LIMIT would lose this older authorized row entirely.
		expect(deniedIds).toContain(raw[0]?.id);
		expect(visible.map(({ id }) => id)).toEqual([scopes.authorizedId]);
	});

	it.each(["membership revoked", "scope revoked", "epoch advanced", "key missing", "key replaced"])(
		"refreshes file visibility on the same open store after %s",
		(change) => {
			// Arrange: warm all read paths before changing authority.
			assertReadParity(scopes.visibleIds);
			const db = fixture.store.db;
			// Act
			if (change === "membership revoked")
				db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?").run(
					scopes.authorizedScopeId,
				);
			if (change === "scope revoked")
				db.prepare("UPDATE replication_scopes SET status = 'revoked' WHERE scope_id = ?").run(
					scopes.authorizedScopeId,
				);
			if (change === "epoch advanced")
				db.prepare(
					"UPDATE replication_scopes SET membership_epoch = membership_epoch + 1 WHERE scope_id = ?",
				).run(scopes.authorizedScopeId);
			if (change === "key missing")
				renameSync(join(fixture.keysDir, "device.key"), join(fixture.keysDir, "saved.key"));
			if (change === "key replaced") {
				const replacement = join(fixture.dir, "replacement");
				generateKeypair(join(replacement, "device.key"), join(replacement, "device.pub"));
				writeFileSync(
					join(fixture.keysDir, "device.key"),
					readFileSync(join(replacement, "device.key")),
				);
			}
			// Assert: an earlier successful read cannot cache a stale managed grant.
			assertReadParity([scopes.personalId]);
		},
	);

	it("does not treat mutable same-actor or origin fields as managed proof", () => {
		// Arrange: the unproven replica claims both local ownership fields.
		fixture.store.db
			.prepare("UPDATE memory_items SET actor_id = ?, origin_device_id = ? WHERE id = ?")
			.run(fixture.store.actorId, fixture.store.deviceId, scopes.unauthorizedId);
		// Act / Assert
		assertReadParity(scopes.visibleIds);
	});

	it.each(["column", "metadata"])(
		"preserves unmanaged authored access from %s without granting a foreign replica access",
		(originSource) => {
			// Arrange: unmanaged authorship is an existing exception even without membership.
			fixture.store.db
				.prepare("UPDATE replication_scopes SET authority_type = 'manual' WHERE scope_id = ?")
				.run(scopes.unauthorizedScopeId);
			const authoredId = insertReplica(scopes.unauthorizedScopeId, "authored unmanaged");
			if (originSource === "column") {
				fixture.store.db
					.prepare("UPDATE memory_items SET origin_device_id = ? WHERE id = ?")
					.run(fixture.store.deviceId, authoredId);
			} else {
				fixture.store.db
					.prepare("UPDATE memory_items SET metadata_json = ? WHERE id = ?")
					.run(JSON.stringify({ origin_device_id: fixture.store.deviceId }), authoredId);
			}
			fixture.store.db
				.prepare("UPDATE memory_items SET actor_id = ? WHERE id = ?")
				.run(fixture.store.actorId, scopes.unauthorizedId);
			// Act
			const result = scopedIds();
			// Assert: matching actor alone does not turn the other row into local authorship.
			expect(fixture.store.get(authoredId)?.id).toBe(authoredId);
			expect(result).toContain(authoredId);
			expect(fixture.store.get(scopes.unauthorizedId)).toBeNull();
			expect(result).not.toContain(scopes.unauthorizedId);
		},
	);

	it("uses scope authorization rather than actor equality for foreign-actor rows", () => {
		// Arrange: another actor has one authorized and one inaccessible managed row.
		fixture.store.db
			.prepare(
				"UPDATE memory_items SET actor_id = 'foreign-actor', origin_device_id = 'foreign-device' WHERE id IN (?, ?)",
			)
			.run(scopes.authorizedId, scopes.unauthorizedId);
		// Act / Assert: foreign authorship alone neither denies a grant nor creates one.
		assertReadParity(scopes.visibleIds);
	});

	it("retains immutable local creation after revocation but rejects content that no longer matches", () => {
		// Arrange: the maintained writer, not mutable origin fields, creates local evidence.
		const id = rememberScoped("Signed local history", { files_modified: [path] });
		const db = fixture.store.db;
		db.prepare(
			"UPDATE replication_scopes SET status = 'revoked' WHERE scope_id = 'capture-revoked'",
		).run();
		const snapshots = db.prepare("SELECT * FROM memory_local_creation_snapshots").all();
		// Act
		const intactGet = fixture.store.get(id);
		const intactIds = scopedIds();
		db.prepare("UPDATE memory_items SET body_text = 'tampered replica' WHERE id = ?").run(id);
		const changedGet = fixture.store.get(id);
		const changedIds = scopedIds();
		// Assert: read parity includes the immutable-history exception and its content check.
		expect(intactGet?.id).toBe(id);
		expect(intactIds).toContain(id);
		expect(changedGet).toBeNull();
		expect(changedIds).not.toContain(id);
		expect(db.prepare("SELECT * FROM memory_local_creation_snapshots").all()).toEqual(snapshots);
	});
});

describe("file visibility composes with reference filters", () => {
	it.each([
		{ options: { project: "mixed-domain-fixture" }, expected: true },
		{ options: { project: "another-project" }, expected: false },
		{ options: { relation: "modified" as const }, expected: true },
		{ options: { relation: "read" as const }, expected: false },
		{ options: { kind: "decision" }, expected: true },
		{ options: { kind: "bugfix" }, expected: false },
		{ options: { since: "2026-04-01T00:00:02.000Z" }, expected: true },
		{ options: { since: "2099-01-01" }, expected: false },
	])("preserves $options with authorization", ({ options, expected }) => {
		// Arrange: only the authorized decision can pass the positive filter cases.
		fixture.store.db
			.prepare("UPDATE memory_items SET active = 0 WHERE id = ?")
			.run(scopes.personalId);
		// Act
		const ids = scopedIds(path, options);
		// Assert
		expect(ids).toEqual(expected ? [scopes.authorizedId] : []);
	});

	it("preserves current-session summary eligibility without admitting denied summaries", () => {
		// Arrange: a summary in each scope and a non-summary local observation.
		fixture.store.db
			.prepare("UPDATE memory_items SET kind = 'session_summary' WHERE id IN (?, ?)")
			.run(scopes.authorizedId, scopes.unauthorizedId);
		// Act
		const current = scopedIds(path, { summarySessionId: scopes.sessionId });
		const absent = scopedIds(path, { summarySessionId: null });
		const other = scopedIds(path, { summarySessionId: scopes.sessionId + 100 });
		// Assert
		expect(current.sort()).toEqual([...scopes.visibleIds].sort());
		expect(absent).toEqual([scopes.personalId]);
		expect(other).toEqual([scopes.personalId]);
	});

	it("preserves session project precedence and memory-project fallback", () => {
		// Arrange: session project wins while present, even if the row names another project.
		fixture.store.db.prepare("UPDATE memory_items SET project = 'row-project'").run();
		// Act
		const sessionMatches = scopedIds(path, { project: "mixed-domain-fixture" });
		const shadowedRowMatches = scopedIds(path, { project: "row-project" });
		fixture.store.db
			.prepare("UPDATE sessions SET project = NULL WHERE id = ?")
			.run(scopes.sessionId);
		const fallbackMatches = scopedIds(path, { project: "row-project" });
		// Assert: authorization intersects both project paths, never widens them.
		expect(sessionMatches.sort()).toEqual([...scopes.visibleIds].sort());
		expect(shadowedRowMatches).toEqual([]);
		expect(fallbackMatches.sort()).toEqual([...scopes.visibleIds].sort());
	});

	it("treats SQL wildcard characters in directory prefixes literally", () => {
		// Arrange: a lookalike prefix must not widen the authorized file match.
		addRef(scopes.authorizedId, "src/under_score%/a.ts");
		addRef(scopes.personalId, "src/underXscoreOther/a.ts");
		// Act
		const matching = scopedIds("src/under_score%/");
		const missing = scopedIds("src/under_score%/missing/");
		// Assert
		expect(matching).toEqual([scopes.authorizedId]);
		expect(missing).toEqual([]);
	});
});

describe("file-hint candidate windows", () => {
	it.each(["search", "pack"])(
		"%s finds older authorized references without exposing denied content",
		(surface) => {
			// Arrange: no title/body mentions the path, so only indexed file hints can find the row.
			fixture.store.db
				.prepare("UPDATE memory_items SET active = 0 WHERE id = ?")
				.run(scopes.personalId);
			const deniedIds = Array.from({ length: 45 }, (_, n) =>
				insertReplica(scopes.unauthorizedScopeId, `hidden-hint-${n}`),
			);
			// Act: pack's working-set route must work even when its query has no path hint.
			const search = surface === "search" ? fixture.store.search(path, 1) : null;
			const pack =
				surface === "pack"
					? buildMemoryPack(fixture.store, "no_matching_lexical_terms", 1, null, {
							working_set_paths: [path],
						})
					: null;
			const ids = search?.map(({ id }) => id) ?? pack?.item_ids ?? [];
			const serialized = JSON.stringify(search ?? pack);
			// Assert: merely checking absence would miss starvation caused by post-LIMIT filtering.
			expect(ids).toContain(scopes.authorizedId);
			expect(serialized).toContain(scopes.visibleTitles[1]);
			for (const id of deniedIds) expect(ids).not.toContain(id);
			expect(ids).not.toContain(scopes.unauthorizedId);
			expect(serialized).not.toContain("hidden-hint-");
			expect(serialized).not.toContain(scopes.unauthorizedTitle);
		},
	);

	it.each(["search", "pack"])(
		"%s excludes a previously readable file hint after revocation",
		(surface) => {
			// Arrange: only the managed row is visible for this file.
			fixture.store.db
				.prepare("UPDATE memory_items SET active = 0 WHERE id = ?")
				.run(scopes.personalId);
			const retrieve = () => {
				if (surface === "search") return fixture.store.search(path, 1);
				return buildMemoryPack(fixture.store, "no_matching_lexical_terms", 1, null, {
					working_set_paths: [path],
				});
			};
			const before = JSON.stringify(retrieve());
			// Act: repeat on the same open store after losing the managed grant.
			fixture.store.db
				.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
				.run(scopes.authorizedScopeId);
			const after = retrieve();
			const ids = Array.isArray(after) ? after.map(({ id }) => id) : after.item_ids;
			// Assert
			expect(before).toContain(scopes.visibleTitles[1]);
			expect(ids).toEqual([]);
			expect(JSON.stringify(after)).not.toContain(scopes.visibleTitles[1]);
			expect(JSON.stringify(after)).not.toContain(scopes.unauthorizedTitle);
		},
	);
});
