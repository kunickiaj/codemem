import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { buildFilterClausesWithContext, type OwnershipFilterContext } from "./filters.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { resolveVisibleScopeIds } from "./scope-resolution.js";
import { initTestSchema, seedMixedScopeFixture } from "./test-utils.js";

const connections: Database.Database[] = [];
afterEach(() => {
	for (const db of connections.splice(0)) db.close();
});

it.each([0, 500, 501])("preserves resolved visibility with %i scope ids", (count) => {
	// Arrange: the resolved set includes only one managed scope, never its denied neighbor.
	const db = new Database(":memory:");
	connections.push(db);
	initTestSchema(db);
	const fixture = seedMixedScopeFixture(db);
	db.prepare("UPDATE memory_items SET scope_id = NULL WHERE id = ?").run(fixture.personalId);
	const visibleScopeIds = Array.from({ length: count }, (_, i) => `filler-${i}`);
	if (count) visibleScopeIds[0] = fixture.authorizedScopeId;
	// Act: exercise empty, inline-limit, and JSON fallback predicates against SQLite.
	const filter = buildFilterClausesWithContext(null, {
		actorId: "fixture-actor",
		deviceId: fixture.deviceId,
		enforceScopeVisibility: true,
		visibleScopeIds,
	});
	const rows = db
		.prepare(`SELECT id FROM memory_items WHERE ${filter.clauses.join(" AND ")}
		ORDER BY id`)
		.all(...filter.params);
	// Assert: fallback cannot grant the raw-membership neighbor or lose readable rows.
	expect(rows).toEqual((count ? fixture.visibleIds : [fixture.personalId]).map((id) => ({ id })));
	expect(filter.clauses.join(" ").includes("json_each")).toBe(count > 500);
});

describe.each(["exists", "db", "pre-resolved"] as const)("%s proof-required context", (path) => {
	it.each([
		{ key: "wrong", expectedPublicKey: "wrong-runtime-key", current: true },
		{ key: "missing", expectedPublicKey: undefined, current: true },
		{ key: "wrong", expectedPublicKey: "wrong-runtime-key", current: false },
		{ key: "missing", expectedPublicKey: undefined, current: false },
	])(
		"denies $key key context with current membership=$current",
		async ({ expectedPublicKey, current }) => {
			// Arrange: retained proof exists, but the runtime key is wrong or missing.
			const db = new Database(":memory:");
			connections.push(db);
			initTestSchema(db);
			const fixture = seedMixedScopeFixture(db);
			await refreshTestScopeRows(db, { [fixture.deviceId]: CANONICAL_PUBLIC_KEY });
			db.exec(`INSERT INTO replication_scopes
				(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
				VALUES ('local-control', 'Local', 'user', 'local', 0, 'active', '', ''),
				('manual-control', 'Manual', 'user', 'manual', 0, 'active', '', '');`);
			db.prepare(`INSERT INTO scope_memberships
				(scope_id, device_id, role, status, membership_epoch, updated_at)
				VALUES ('manual-control', ?, 'member', 'active', 0, '')`).run(fixture.deviceId);
			if (!current) {
				db.prepare("UPDATE replication_scopes SET membership_epoch = 1 WHERE scope_id = ?").run(
					fixture.authorizedScopeId,
				);
			}
			const loadExpectedPublicKey = vi.fn(() => expectedPublicKey);
			const context: OwnershipFilterContext = {
				actorId: "fixture-actor",
				deviceId: fixture.deviceId,
				enforceScopeVisibility: true,
				expectedPublicKey,
				loadExpectedPublicKey,
			};
			const baseline = resolveVisibleScopeIds(db, fixture.deviceId);

			// Act: exercise the new resolver option and both context resolution paths.
			const resolved = resolveVisibleScopeIds(db, fixture.deviceId, context);
			expect(loadExpectedPublicKey).toHaveBeenCalledTimes(!expectedPublicKey && current ? 1 : 0);
			loadExpectedPublicKey.mockClear();
			if (path === "db") context.scopeVisibilityDb = db;
			if (path === "pre-resolved") context.visibleScopeIds = resolved;
			const filter = buildFilterClausesWithContext(undefined, context);
			const rows = db
				.prepare(`SELECT id FROM memory_items WHERE ${filter.clauses.join(" AND ")} ORDER BY id`)
				.all(...filter.params);

			// Assert: unmanaged access survives; managed proof needs the actual key.
			expect(resolved).toEqual(baseline);
			expect(resolved).not.toContain(fixture.authorizedScopeId);
			expect(resolved).not.toContain(fixture.unauthorizedScopeId);
			expect(resolved).toEqual(expect.arrayContaining(["local-control", "manual-control"]));
			expect(rows).toEqual([{ id: fixture.personalId }]);
			expect(loadExpectedPublicKey).toHaveBeenCalledTimes(
				path === "db" && !expectedPublicKey && current ? 1 : 0,
			);
		},
	);
});
