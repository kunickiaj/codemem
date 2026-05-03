/* End-to-end mixed personal/work/OSS sync invariants for the
 * sharing-domain enforcement story. Exercises a single mixed device
 * against three peers — each authorized for one sharing scope — plus a
 * default-scope local-only memory and a rogue unauthenticated peer.
 *
 * Each test asserts a single boundary invariant: outbound filter,
 * snapshot bootstrap, revocation, personal-grant, peer project filter,
 * and per-peer-per-scope cursor independence. The intent is to lock
 * the cross-scope leak surface so that a regression in any one path
 * fails fast in CI rather than under a real mixed deployment. */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import {
	DEFAULT_SYNC_SCOPE_ID,
	filterReplicationOpsForSyncWithStatus,
	getReplicationCursor,
	loadMemorySnapshotPageForPeer,
	peerCanSyncPrivateOpByPersonalScopeGrant,
	personalScopeGrantStatusForPeer,
	setReplicationCursor,
	setSyncResetState,
} from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const LOCAL_DEVICE = "dev-local";
const LOCAL_ACTOR = "actor-local";

const PEER_PERSONAL = "dev-personal-laptop";
const PEER_ACME = "dev-acme";
const PEER_OSS = "dev-oss";
const PEER_ROGUE = "dev-rogue";

const PERSONAL_SCOPE = `personal:${LOCAL_ACTOR}`;
const ACME_SCOPE = "acme-work";
const OSS_SCOPE = "oss-shared";

interface MixedFixture {
	db: InstanceType<typeof Database>;
	sessions: Record<string, number>;
	ops: Record<string, ReplicationOp>;
}

function setupMixedFixture(): MixedFixture {
	const db = new Database(":memory:");
	initTestSchema(db);
	insertTestSession(db);

	// Per-scope replication reset boundary so the snapshot loader has the
	// matching anchor for each scope-limited bootstrap call.
	for (const scopeId of [PERSONAL_SCOPE, ACME_SCOPE, OSS_SCOPE]) {
		setSyncResetState(
			db,
			{
				generation: 1,
				snapshot_id: "snap-1",
				baseline_cursor: "2026-05-03T00:00:00Z|baseline-op",
				retained_floor_cursor: "2026-05-03T00:00:00Z|baseline-op",
			},
			scopeId,
		);
	}

	// Sessions per project — the snapshot loader joins memory_items to
	// sessions to pick up project metadata.
	const sessions = {
		personal: insertSessionWithProject(db, "personal"),
		acme: insertSessionWithProject(db, "acme/internal"),
		oss: insertSessionWithProject(db, "acme/oss"),
		experimental: insertSessionWithProject(db, "experimental"),
	};

	// Memberships:
	// - personal scope: only the local device + the user's other personal device.
	// - acme scope: local + the work peer.
	// - oss scope: local + the OSS peer.
	// dev-rogue is intentionally not granted any scope membership.
	grantScope(db, PERSONAL_SCOPE, [LOCAL_DEVICE, PEER_PERSONAL]);
	grantScope(db, ACME_SCOPE, [LOCAL_DEVICE, PEER_ACME]);
	grantScope(db, OSS_SCOPE, [LOCAL_DEVICE, PEER_OSS]);

	// Memories spanning every scope plus a local-only fallback.
	insertMemory(db, sessions.personal, {
		importKey: "key:personal-1",
		scopeId: PERSONAL_SCOPE,
		visibility: "private",
		workspaceId: PERSONAL_SCOPE,
		workspaceKind: "personal",
		actorId: LOCAL_ACTOR,
		project: "personal",
	});
	insertMemory(db, sessions.acme, {
		importKey: "key:work-1",
		scopeId: ACME_SCOPE,
		visibility: "shared",
		workspaceId: ACME_SCOPE,
		workspaceKind: "shared",
		project: "acme/internal",
	});
	insertMemory(db, sessions.oss, {
		importKey: "key:oss-1",
		scopeId: OSS_SCOPE,
		visibility: "shared",
		workspaceId: OSS_SCOPE,
		workspaceKind: "shared",
		project: "acme/oss",
	});
	insertMemory(db, sessions.experimental, {
		importKey: "key:local-1",
		scopeId: null,
		visibility: "shared",
		project: "experimental",
	});

	// One replication op per memory so the outbound filter has work to do.
	const ops: Record<string, ReplicationOp> = {
		personal: makeOp({
			opId: "op-personal-1",
			entityId: "key:personal-1",
			scopeId: PERSONAL_SCOPE,
			createdAt: "2026-05-03T00:00:01Z",
			payload: {
				project: "personal",
				visibility: "private",
				scope_id: PERSONAL_SCOPE,
				workspace_id: PERSONAL_SCOPE,
				workspace_kind: "personal",
				actor_id: LOCAL_ACTOR,
			},
		}),
		acme: makeOp({
			opId: "op-acme-1",
			entityId: "key:work-1",
			scopeId: ACME_SCOPE,
			createdAt: "2026-05-03T00:00:02Z",
			payload: {
				project: "acme/internal",
				visibility: "shared",
				scope_id: ACME_SCOPE,
				workspace_id: ACME_SCOPE,
				workspace_kind: "shared",
			},
		}),
		oss: makeOp({
			opId: "op-oss-1",
			entityId: "key:oss-1",
			scopeId: OSS_SCOPE,
			createdAt: "2026-05-03T00:00:03Z",
			payload: {
				project: "acme/oss",
				visibility: "shared",
				scope_id: OSS_SCOPE,
				workspace_id: OSS_SCOPE,
				workspace_kind: "shared",
			},
		}),
		local: makeOp({
			opId: "op-local-1",
			entityId: "key:local-1",
			// Use the explicit DEFAULT_SYNC_SCOPE_ID so the outbound filter's
			// default-scope guard branch is the one being exercised, not just
			// the project-filter fallthrough that a null scope would hit.
			scopeId: DEFAULT_SYNC_SCOPE_ID,
			createdAt: "2026-05-03T00:00:04Z",
			payload: {
				project: "experimental",
				visibility: "shared",
			},
		}),
	};

	for (const peer of [PEER_PERSONAL, PEER_ACME, PEER_OSS, PEER_ROGUE]) {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, claimed_local_actor, created_at) VALUES (?, 0, ?)",
		).run(peer, "2026-05-03T00:00:00Z");
	}

	// Each peer narrows itself to its team's known projects. The
	// experimental project is in nobody's include list, so a default-scope
	// op carrying that project falls through every peer's filter and stays
	// local. The rogue peer's include list deliberately excludes every
	// project, so even if scope checks were bypassed it could not draw
	// content out of this device.
	setPeerProjectFilters(db, PEER_PERSONAL, ["personal"], null);
	setPeerProjectFilters(db, PEER_ACME, ["acme/internal"], null);
	setPeerProjectFilters(db, PEER_OSS, ["acme/oss"], null);
	setPeerProjectFilters(db, PEER_ROGUE, ["nothing-allowed"], null);

	return { db, sessions, ops };
}

// ---------------------------------------------------------------------------
// Inline test helpers
// ---------------------------------------------------------------------------

function insertSessionWithProject(db: InstanceType<typeof Database>, project: string): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
		)
		.run(now, `/tmp/${project}`, project, "test-user", "test");
	return Number(info.lastInsertRowid);
}

function insertMemory(
	db: InstanceType<typeof Database>,
	sessionId: number,
	opts: {
		importKey: string;
		scopeId: string | null;
		visibility: string;
		workspaceId?: string | null;
		workspaceKind?: string | null;
		actorId?: string | null;
		project: string;
	},
): void {
	const now = "2026-05-03T00:00:00Z";
	db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, created_at, updated_at, import_key, rev,
			active, visibility, actor_id, workspace_id, workspace_kind, scope_id, metadata_json
		 ) VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
	).run(
		sessionId,
		opts.importKey,
		now,
		now,
		opts.importKey,
		opts.visibility,
		opts.actorId ?? null,
		opts.workspaceId ?? null,
		opts.workspaceKind ?? null,
		opts.scopeId,
		toJson({ clock_device_id: LOCAL_DEVICE, project: opts.project }),
	);
}

function grantScope(
	db: InstanceType<typeof Database>,
	scopeId: string,
	deviceIds: string[],
	overrides: { membershipEpoch?: number; status?: string } = {},
): void {
	const now = "2026-05-03T00:00:00Z";
	const scopeKind = scopeId.startsWith("personal:") ? "personal" : "team";
	const authorityType = scopeId.startsWith("personal:") ? "user" : "coordinator";
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)
		 ON CONFLICT(scope_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
	).run(scopeId, scopeId, scopeKind, authorityType, now, now);
	for (const deviceId of deviceIds) {
		db.prepare(
			`INSERT INTO scope_memberships(
				scope_id, device_id, role, status, membership_epoch, updated_at
			 ) VALUES (?, ?, 'member', ?, ?, ?)
			 ON CONFLICT(scope_id, device_id) DO UPDATE SET
				status = excluded.status,
				membership_epoch = excluded.membership_epoch,
				updated_at = excluded.updated_at`,
		).run(scopeId, deviceId, overrides.status ?? "active", overrides.membershipEpoch ?? 1, now);
	}
}

function revokeScopeMembership(
	db: InstanceType<typeof Database>,
	scopeId: string,
	deviceId: string,
): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE scope_memberships
		 SET status = 'revoked', updated_at = ?
		 WHERE scope_id = ? AND device_id = ?`,
	).run(now, scopeId, deviceId);
	// Bump the scope epoch so cached authorization treats prior grants as stale.
	db.prepare(
		`UPDATE replication_scopes
		 SET membership_epoch = membership_epoch + 1, updated_at = ?
		 WHERE scope_id = ?`,
	).run(now, scopeId);
}

function setPeerProjectFilters(
	db: InstanceType<typeof Database>,
	peerDeviceId: string,
	include: string[] | null,
	exclude: string[] | null,
): void {
	db.prepare(
		`UPDATE sync_peers
		 SET projects_include_json = ?, projects_exclude_json = ?
		 WHERE peer_device_id = ?`,
	).run(include ? toJson(include) : null, exclude ? toJson(exclude) : null, peerDeviceId);
}

function makeOp(input: {
	opId: string;
	entityId: string;
	scopeId: string | null;
	createdAt: string;
	payload: Record<string, unknown>;
}): ReplicationOp {
	return {
		op_id: input.opId,
		entity_type: "memory_item",
		entity_id: input.entityId,
		op_type: "upsert",
		payload_json: toJson(input.payload),
		clock_rev: 1,
		clock_updated_at: input.createdAt,
		clock_device_id: LOCAL_DEVICE,
		device_id: LOCAL_DEVICE,
		created_at: input.createdAt,
		scope_id: input.scopeId,
	};
}

function filterForPeer(
	db: InstanceType<typeof Database>,
	ops: ReplicationOp[],
	peerDeviceId: string,
) {
	return filterReplicationOpsForSyncWithStatus(db, ops, peerDeviceId, {
		localDeviceId: LOCAL_DEVICE,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mixed personal/work/OSS sync — boundary enforcement", () => {
	let fixture: MixedFixture;

	beforeEach(() => {
		fixture = setupMixedFixture();
	});

	afterEach(() => {
		fixture.db.close();
	});

	it("routes outbound ops to the peer authorized for their scope only", () => {
		const allOps = [fixture.ops.personal, fixture.ops.acme, fixture.ops.oss, fixture.ops.local];

		const [acmeOps] = filterForPeer(fixture.db, allOps, PEER_ACME);
		expect(acmeOps.map((op) => op.op_id)).toEqual(["op-acme-1"]);

		const [ossOps] = filterForPeer(fixture.db, allOps, PEER_OSS);
		expect(ossOps.map((op) => op.op_id)).toEqual(["op-oss-1"]);

		const [personalOps] = filterForPeer(fixture.db, allOps, PEER_PERSONAL);
		expect(personalOps.map((op) => op.op_id)).toEqual(["op-personal-1"]);
	});

	it("never routes default-scope local-only ops to any peer", () => {
		// Widen every peer's project filter so it would accept the
		// `experimental` project on its own merits. The default-scope guard
		// is the only thing left blocking the op — if that branch regresses,
		// the op leaks and this test fails.
		for (const peer of [PEER_PERSONAL, PEER_ACME, PEER_OSS, PEER_ROGUE]) {
			setPeerProjectFilters(fixture.db, peer, ["experimental"], null);
		}
		for (const peer of [PEER_PERSONAL, PEER_ACME, PEER_OSS, PEER_ROGUE]) {
			const [allowed, , skipped] = filterForPeer(fixture.db, [fixture.ops.local], peer);
			expect(allowed).toEqual([]);
			expect(skipped?.reason).toBe("scope_filter");
			expect(skipped?.scope_id).toBe(DEFAULT_SYNC_SCOPE_ID);
		}
	});

	it("never routes any scoped op to an unauthorized rogue peer", () => {
		const allOps = [fixture.ops.personal, fixture.ops.acme, fixture.ops.oss];
		const [allowed] = filterForPeer(fixture.db, allOps, PEER_ROGUE);
		expect(allowed).toEqual([]);
	});

	it("scope-limited snapshot bootstrap returns only memories for the requested scope", () => {
		const acmePage = loadMemorySnapshotPageForPeer(fixture.db, {
			peerDeviceId: PEER_ACME,
			scopeId: ACME_SCOPE,
			generation: 1,
			snapshotId: "snap-1",
			baselineCursor: "2026-05-03T00:00:00Z|baseline-op",
			limit: 50,
		});
		expect(acmePage.items.map((item) => item.entity_id)).toEqual(["key:work-1"]);

		const ossPage = loadMemorySnapshotPageForPeer(fixture.db, {
			peerDeviceId: PEER_OSS,
			scopeId: OSS_SCOPE,
			generation: 1,
			snapshotId: "snap-1",
			baselineCursor: "2026-05-03T00:00:00Z|baseline-op",
			limit: 50,
		});
		expect(ossPage.items.map((item) => item.entity_id)).toEqual(["key:oss-1"]);

		const personalPage = loadMemorySnapshotPageForPeer(fixture.db, {
			peerDeviceId: PEER_PERSONAL,
			scopeId: PERSONAL_SCOPE,
			generation: 1,
			snapshotId: "snap-1",
			baselineCursor: "2026-05-03T00:00:00Z|baseline-op",
			limit: 50,
		});
		expect(personalPage.items.map((item) => item.entity_id)).toEqual(["key:personal-1"]);
	});

	it("revoking the work peer halts further work-scope ops without touching other scopes", () => {
		revokeScopeMembership(fixture.db, ACME_SCOPE, PEER_ACME);

		const [acmeAfter] = filterForPeer(fixture.db, [fixture.ops.acme], PEER_ACME);
		expect(acmeAfter).toEqual([]);

		// Other scopes are unaffected.
		const [ossAfter] = filterForPeer(fixture.db, [fixture.ops.oss], PEER_OSS);
		expect(ossAfter.map((op) => op.op_id)).toEqual(["op-oss-1"]);
		const [personalAfter] = filterForPeer(fixture.db, [fixture.ops.personal], PEER_PERSONAL);
		expect(personalAfter.map((op) => op.op_id)).toEqual(["op-personal-1"]);
	});

	it("requires an explicit personal-scope grant for same-actor private sync", () => {
		const status = personalScopeGrantStatusForPeer(fixture.db, {
			peerDeviceId: PEER_PERSONAL,
			actorId: LOCAL_ACTOR,
		});
		expect(status).toMatchObject({ scope_id: PERSONAL_SCOPE, authorized: true });

		const payload = JSON.parse(fixture.ops.personal.payload_json ?? "null") as Record<
			string,
			unknown
		>;
		expect(
			peerCanSyncPrivateOpByPersonalScopeGrant(
				fixture.db,
				fixture.ops.personal,
				payload,
				PEER_PERSONAL,
			),
		).toBe(true);
		// A peer without the personal grant cannot ride the same-actor private path.
		expect(
			peerCanSyncPrivateOpByPersonalScopeGrant(
				fixture.db,
				fixture.ops.personal,
				payload,
				PEER_ACME,
			),
		).toBe(false);
	});

	it("a broad peer project filter narrows within scope but cannot widen across scopes", () => {
		setPeerProjectFilters(fixture.db, PEER_ACME, ["acme/internal", "acme/oss"], null);

		const [allowed, , skipped] = filterForPeer(
			fixture.db,
			[fixture.ops.acme, fixture.ops.oss],
			PEER_ACME,
		);
		expect(allowed.map((op) => op.op_id)).toEqual(["op-acme-1"]);
		// The OSS op is skipped because the peer is not in the OSS scope, even
		// though its project name is included in the broad project filter.
		expect(skipped?.reason).toBe("scope_filter");
	});

	it("advances replication cursors independently per peer and per scope", () => {
		setReplicationCursor(
			fixture.db,
			PEER_ACME,
			{ lastApplied: "2026-05-03T00:00:02Z|op-acme-1" },
			ACME_SCOPE,
		);
		setReplicationCursor(
			fixture.db,
			PEER_OSS,
			{ lastApplied: "2026-05-03T00:00:03Z|op-oss-1" },
			OSS_SCOPE,
		);

		expect(getReplicationCursor(fixture.db, PEER_ACME, ACME_SCOPE)[0]).toBe(
			"2026-05-03T00:00:02Z|op-acme-1",
		);
		expect(getReplicationCursor(fixture.db, PEER_OSS, OSS_SCOPE)[0]).toBe(
			"2026-05-03T00:00:03Z|op-oss-1",
		);
		// Cross reads come back null — the cursor is partitioned by (peer, scope).
		expect(getReplicationCursor(fixture.db, PEER_ACME, OSS_SCOPE)[0]).toBeNull();
		expect(getReplicationCursor(fixture.db, PEER_OSS, ACME_SCOPE)[0]).toBeNull();
		// The default scope for the work peer is also independent — moving its
		// scoped cursor must not bleed into its default cursor.
		expect(getReplicationCursor(fixture.db, PEER_ACME, DEFAULT_SYNC_SCOPE_ID)[0]).toBeNull();
	});
});
