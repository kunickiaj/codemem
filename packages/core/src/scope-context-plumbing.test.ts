import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFilterClausesWithContext, type OwnershipFilterContext } from "./filters.js";
import { resolveVisibleScopeIds } from "./scope-resolution.js";
import { initTestSchema, seedMixedScopeFixture } from "./test-utils.js";

const connections: Database.Database[] = [];
afterEach(() => {
	for (const db of connections.splice(0)) db.close();
});

// P2 stages context only: raw membership remains sufficient, as on main.
// The later proof-activation PR must update these same cases to require actual
// proof and deny wrong/missing runtime keys, rather than drop these cases.
describe.each(["exists", "db", "pre-resolved"] as const)("%s membership-only context", (path) => {
	it.each([
		{ key: "wrong", expectedPublicKey: "wrong-runtime-key", current: true },
		{ key: "missing", expectedPublicKey: undefined, current: true },
		{ key: "wrong", expectedPublicKey: "wrong-runtime-key", current: false },
		{ key: "missing", expectedPublicKey: undefined, current: false },
	])(
		"ignores $key key context with current membership=$current",
		({ expectedPublicKey, current }) => {
			// Arrange: coordinator rows have active membership but no authorization proof.
			const db = new Database(":memory:");
			connections.push(db);
			initTestSchema(db);
			const fixture = seedMixedScopeFixture(db);
			if (!current) {
				db.prepare("UPDATE replication_scopes SET membership_epoch = 1 WHERE scope_id = ?").run(
					fixture.authorizedScopeId,
				);
			}
			const loadExpectedPublicKey = vi.fn(() => expectedPublicKey);
			const context: OwnershipFilterContext = {
				deviceId: fixture.deviceId,
				enforceScopeVisibility: true,
				expectedPublicKey,
				loadExpectedPublicKey,
			};
			const baseline = resolveVisibleScopeIds(db, fixture.deviceId);

			// Act: exercise the new resolver option and both context resolution paths.
			const resolved = resolveVisibleScopeIds(db, fixture.deviceId, context);
			if (path === "db") context.scopeVisibilityDb = db;
			if (path === "pre-resolved") context.visibleScopeIds = resolved;
			const filter = buildFilterClausesWithContext(undefined, context);
			const rows = db
				.prepare(`SELECT id FROM memory_items WHERE ${filter.clauses.join(" AND ")} ORDER BY id`)
				.all(...filter.params);

			// Assert: no new grant, no lost current membership, and no signing-key I/O.
			expect(resolved).toEqual(baseline);
			expect(resolved.includes(fixture.authorizedScopeId)).toBe(current);
			expect(resolved).not.toContain(fixture.unauthorizedScopeId);
			const expectedIds = current ? fixture.visibleIds : [fixture.personalId];
			expect(rows).toEqual(expectedIds.map((id) => ({ id })));
			expect(loadExpectedPublicKey).toHaveBeenCalledTimes(0);
		},
	);
});
