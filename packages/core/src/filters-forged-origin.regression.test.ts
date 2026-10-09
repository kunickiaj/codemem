import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { buildFilterClausesWithContext, type OwnershipFilterContext } from "./filters.js";
import {
	refreshScopeMembershipCache,
	upsertCachedScopeMemberships,
} from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { resolveVisibleScopeIds } from "./scope-resolution.js";
import { initTestSchema } from "./test-utils.js";

const paths = ["scopeVisibilityDb", "visibleScopeIds", "DB-less SQL"] as const;
type FilterPath = (typeof paths)[number];

// Both ownership sources are peer-controlled; neither can authorize a managed read.
const origins = [
	{
		name: "runtime origin column with replica key",
		column: "device-a",
		metadata: {},
		importKey: "peer-replica",
	},
	{
		name: "runtime origin metadata without import key",
		column: " ",
		metadata: { origin_device_id: " device-a " },
		importKey: null,
	},
	{
		name: "legacy local column without import key",
		column: "local",
		metadata: {},
		importKey: null,
	},
	{
		name: "legacy local metadata with blank import key",
		column: null,
		metadata: { origin_device_id: " local " },
		importKey: " ",
	},
] as const;
type Origin = {
	column: string | null;
	metadata: { origin_device_id?: string };
	importKey: string | null;
};

function seedMemory(db: Database.Database, scopeId: string, origin: Origin): void {
	const session = db.prepare("INSERT INTO sessions(started_at) VALUES (?)").run(cacheTime);
	db.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, confidence, tags_text, active,
		 created_at, updated_at, metadata_json, rev, visibility, scope_id, origin_device_id, import_key)
		VALUES (?, 'discovery', 'history', 'body', 0.5, '', 1, ?, ?, ?, 1, 'private', ?, ?, ?)`).run(
		session.lastInsertRowid,
		cacheTime,
		cacheTime,
		JSON.stringify(origin.metadata),
		scopeId,
		origin.column,
		origin.importKey,
	);
}

function seedScope(
	db: Database.Database,
	options: { authority: string; scopeStatus?: string; memberStatus?: string },
): void {
	db.prepare(`INSERT INTO replication_scopes
		(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES ('scope-a', 'Fixture', 'team', ?, 3, ?, ?, ?)`).run(
		options.authority,
		options.scopeStatus ?? "active",
		cacheTime,
		cacheTime,
	);
	const scope = cacheScope({ authority_type: options.authority });
	upsertCachedScopeMemberships(db, [
		{ ...cacheMember(scope), status: options.memberStatus ?? "active" },
	]);
}

function readIds(db: Database.Database, path: FilterPath): unknown[] {
	const context: OwnershipFilterContext = {
		actorId: "actor-a",
		deviceId: "device-a",
		enforceScopeVisibility: true,
		expectedPublicKey: CANONICAL_PUBLIC_KEY,
	};
	if (path === "scopeVisibilityDb") context.scopeVisibilityDb = db;
	if (path === "visibleScopeIds") {
		context.visibleScopeIds = resolveVisibleScopeIds(db, context.deviceId, context);
	}
	const filter = buildFilterClausesWithContext({ scope_id: "scope-a" }, context);
	return db
		.prepare(`SELECT id FROM memory_items WHERE ${filter.clauses.join(" AND ")}`)
		.all(...filter.params);
}

async function refreshProof(db: Database.Database): Promise<void> {
	const snapshot = cacheWireSnapshot();
	await refreshScopeMembershipCache(db, {
		coordinatorId: "server-a",
		groupIds: ["group-a"],
		now: new Date(cacheTime),
		fetchers: {
			listScopes: async () => ({ version: 1, items: [snapshot.scope] }),
			getScopeSnapshot: async () => snapshot,
		},
	});
}

describe.each(paths)("forged origin cannot bypass scope visibility via %s", (path) => {
	it.each(origins)("denies unproven managed scope with $name", (origin) => {
		// Arrange: raw active membership is not a retained coordinator authorization.
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			seedScope(db, { authority: "coordinator" });
			seedMemory(db, "scope-a", origin);
			// Act
			const rows = readIds(db, path);
			// Assert: a forged author cannot replace managed proof.
			expect(rows).toEqual([]);
		} finally {
			db.close();
		}
	});

	it.each(origins)("denies unknown scope with $name", (origin) => {
		// Arrange: the memory references no locally registered scope.
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			seedMemory(db, "scope-a", origin);
			// Act
			const rows = readIds(db, path);
			// Assert: unknown authority must fail closed despite apparent authorship.
			expect(rows).toEqual([]);
		} finally {
			db.close();
		}
	});

	describe.each(["revoked membership", "archived scope", "advanced epoch"] as const)(
		"%s",
		(loss) => {
			it.each(origins)("denies formerly authorized managed history with $name", async (origin) => {
				// Arrange: promote proof using a deterministic fake coordinator, then lose access.
				const db = new Database(":memory:");
				try {
					initTestSchema(db);
					seedScope(db, { authority: "coordinator" });
					seedMemory(db, "scope-a", origin);
					await refreshProof(db);
					const edits = {
						"revoked membership":
							"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'scope-a'",
						"archived scope":
							"UPDATE replication_scopes SET status = 'archived' WHERE scope_id = 'scope-a'",
						"advanced epoch":
							"UPDATE replication_scopes SET membership_epoch = 4 WHERE scope_id = 'scope-a'",
					};
					db.exec(edits[loss]);
					// Act
					const rows = readIds(db, path);
					// Assert: revocation applies even to rows claiming this device authored them.
					expect(rows).toEqual([]);
				} finally {
					db.close();
				}
			});
		},
	);

	describe.each(["local", "manual", "invite"] as const)(
		"explicit unmanaged %s scope",
		(authority) => {
			it.each(origins)("preserves historical authorship access with $name", (origin) => {
				// Arrange: unmanaged history keeps its authorship exception after membership loss.
				const db = new Database(":memory:");
				try {
					initTestSchema(db);
					seedScope(db, { authority, scopeStatus: "archived", memberStatus: "revoked" });
					seedMemory(db, "scope-a", origin);
					// Act
					const rows = readIds(db, path);
					// Assert
					expect(rows).toEqual([{ id: 1 }]);
				} finally {
					db.close();
				}
			});

			it.each([
				{ name: "foreign replica", column: "foreign", metadata: {}, importKey: "peer-replica" },
				{
					name: "imported legacy local replica",
					column: null,
					metadata: { origin_device_id: "local" },
					importKey: "peer-replica",
				},
			])("denies $name after unmanaged access loss", (origin) => {
				// Arrange: neither foreign authors nor imported local sentinels are local history.
				const db = new Database(":memory:");
				try {
					initTestSchema(db);
					seedScope(db, { authority, scopeStatus: "archived", memberStatus: "revoked" });
					seedMemory(db, "scope-a", origin);
					// Act
					const rows = readIds(db, path);
					// Assert
					expect(rows).toEqual([]);
				} finally {
					db.close();
				}
			});
		},
	);
});

describe.each(["scopeVisibilityDb", "visibleScopeIds"] as const)(
	"authorized managed scope via %s",
	(path) => {
		it.each(origins)("permits $name when current proof authorizes the scope", async (origin) => {
			// Arrange: actual current-key proof, not authorship, grants the read.
			const db = new Database(":memory:");
			try {
				initTestSchema(db);
				seedScope(db, { authority: "coordinator" });
				seedMemory(db, "scope-a", origin);
				await refreshProof(db);
				// Act
				const rows = readIds(db, path);
				// Assert
				expect(rows).toEqual([{ id: 1 }]);
			} finally {
				db.close();
			}
		});
	},
);
