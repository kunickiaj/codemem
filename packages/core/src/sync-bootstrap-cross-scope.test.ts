import { generateKeyPairSync } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { toJson } from "./db.js";
import { ensureMemorySourceIdentitySchema } from "./memory-source-identity.js";
import {
	type ProjectBoundaryMigrationState,
	recordProjectBoundaryMigration,
} from "./project-boundary-migration-records.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { setSyncResetState } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { SyncMemorySnapshotItem, SyncResetRequired } from "./types.js";

const NOW = "2026-11-18T00:00:00.000Z";
const LOCAL = "device-local";
const AUTHOR = "device-author";
const CARRIER = "device-carrier";
const LATE = "device-added-later";
const SOURCE = "team:group-a:default";
const SECOND_SOURCE = "client-setup";
const BOUNDARY = "managed-project:project-p";
const OTHER_BOUNDARY = "managed-project:project-q";
const KEY = "memory-key-1";
const SNAPSHOT_TIME = "2026-11-18T00:00:05.000Z";

let db: InstanceType<typeof Database>;
let sessionId: number;

/** A second valid device key, so a pinned key can differ from the one the coordinator proved. */
function anotherPublicKey(): string {
	const raw = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
	const type = Buffer.from("ssh-ed25519");
	const blob = Buffer.concat([
		Buffer.from([0, 0, 0, type.length]),
		type,
		Buffer.from([0, 0, 0, 32]),
		raw.subarray(raw.length - 32),
	]);
	return `ssh-ed25519 ${blob.toString("base64")}`;
}

function scope(scopeId: string, kind: string) {
	db.prepare(
		`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		 group_id, membership_epoch, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'coordinator', 'https://coordinator.example.test', 'group-a', 1, 'active', ?, ?)`,
	).run(scopeId, scopeId, kind, NOW, NOW);
}

function member(scopeId: string, deviceId: string) {
	db.prepare(
		`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		 VALUES (?, ?, 'member', 'active', 1, ?)`,
	).run(scopeId, deviceId, NOW);
}

/** The coordinator stops listing the device, and the next refresh records that. */
async function leave(scopeId: string, deviceId: string) {
	db.prepare("DELETE FROM scope_memberships WHERE scope_id = ? AND device_id = ?").run(
		scopeId,
		deviceId,
	);
	await refreshTestScopeRows(db);
}

function pair(deviceId: string, publicKey = CANONICAL_PUBLIC_KEY) {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
		 VALUES (?, ?, ?, ?)`,
	).run(deviceId, publicKey, fingerprintPublicKey(publicKey), NOW);
}

interface CopyOptions {
	scopeId: string;
	rev?: number;
	origin?: string | null;
	active?: boolean;
	visibility?: string;
	updatedAt?: string;
}

function holdCopy(options: CopyOptions) {
	const origin = options.origin === undefined ? AUTHOR : options.origin;
	const metadata = { clock_device_id: origin ?? AUTHOR };
	db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, active, deleted_at, created_at,
		 updated_at, import_key, origin_device_id, rev, visibility, scope_id, metadata_json)
		 VALUES (?, 'discovery', 'older title', 'older body', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		sessionId,
		options.active === false ? 0 : 1,
		options.active === false ? NOW : null,
		NOW,
		options.updatedAt ?? "2026-11-18T00:00:01.000Z",
		KEY,
		origin,
		options.rev ?? 1,
		options.visibility ?? "shared",
		options.scopeId,
		toJson(metadata),
	);
}

function snapshotItem(
	scopeId: string,
	rev = 3,
	opType: SyncMemorySnapshotItem["op_type"] = "upsert",
): SyncMemorySnapshotItem {
	return {
		entity_id: KEY,
		op_type: opType,
		payload_json: JSON.stringify({
			kind: "discovery",
			title: "newer title",
			body_text: "newer body",
			visibility: "shared",
			workspace_kind: "shared",
			workspace_id: "shared:default",
			created_at: NOW,
			metadata_json: { clock_device_id: AUTHOR },
			scope_id: scopeId,
		}),
		clock_rev: rev,
		clock_updated_at: SNAPSHOT_TIME,
		clock_device_id: AUTHOR,
	};
}

function resetInfo(scopeId: string): SyncResetRequired {
	return {
		reset_required: true,
		reason: "generation_mismatch",
		generation: 2,
		snapshot_id: "snapshot-2",
		baseline_cursor: "2026-11-18T00:00:05Z|base-op",
		retained_floor_cursor: null,
		scope_id: scopeId,
	};
}

function record(state: ProjectBoundaryMigrationState, overrides: { boundary?: string } = {}) {
	recordProjectBoundaryMigration(db, {
		boundaryScopeId: overrides.boundary ?? BOUNDARY,
		sourceScopeId: SOURCE,
		additionalSourceScopeIds: [SECOND_SOURCE],
		state,
		generation: 1,
		now: NOW,
	});
}

/** The coordinator still lists this device, but the proof for its key was not retained. */
function loseProof(scopeId: string, deviceId: string) {
	const removed = db
		.prepare(
			"DELETE FROM scope_membership_authorization_evidence WHERE scope_id = ? AND device_id = ?",
		)
		.run(scopeId, deviceId);
	expect(removed.changes).toBe(1);
}

/** This device verified, when the memory arrived, which device created it. */
function verifyCreator(deviceId: string) {
	ensureMemorySourceIdentitySchema(db);
	db.prepare(
		`INSERT INTO memory_source_bindings(entity_id, source_device_id, evidence, created_at)
		 VALUES (?, ?, 'authenticated_namespace', ?)`,
	).run(KEY, deviceId, NOW);
}

function copies() {
	return db
		.prepare(
			`SELECT scope_id, rev, active, title, origin_device_id FROM memory_items
			 WHERE import_key = ? ORDER BY scope_id`,
		)
		.all(KEY);
}

const movedCopy = {
	scope_id: BOUNDARY,
	rev: 3,
	active: 1,
	title: "newer title",
	origin_device_id: AUTHOR,
};
const olderCopy = {
	scope_id: SOURCE,
	rev: 1,
	active: 1,
	title: "older title",
	origin_device_id: AUTHOR,
};

/** Both ways a scoped snapshot is applied: a first pull, and a pull into a scope that has rows. */
const SNAPSHOT_PATHS = [
	{ path: "first pull of the scope", apply: applyBootstrapSnapshot },
	{ path: "merge into a scope that already has rows", apply: mergeBootstrapSnapshot },
] as const;

beforeEach(async () => {
	db = new Database(":memory:");
	initTestSchema(db);
	sessionId = insertTestSession(db);
	setSyncResetState(db, { generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null });
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run(LOCAL, CANONICAL_PUBLIC_KEY, fingerprintPublicKey(CANONICAL_PUBLIC_KEY), NOW);
	for (const deviceId of [AUTHOR, CARRIER, LATE]) pair(deviceId);
	scope(SOURCE, "team_default");
	scope(SECOND_SOURCE, "client");
	scope(BOUNDARY, "managed_project");
	scope(OTHER_BOUNDARY, "managed_project");
	for (const deviceId of [LOCAL, AUTHOR, CARRIER]) {
		member(SOURCE, deviceId);
		member(SECOND_SOURCE, deviceId);
		member(BOUNDARY, deviceId);
	}
	member(BOUNDARY, LATE);
	await refreshTestScopeRows(db);
});

afterEach(() => db.close());

describe.each(SNAPSHOT_PATHS)(
	"a snapshot with no migration record for the move ($path)",
	({ apply }) => {
		function pull(from: string, scopeId = BOUNDARY, rev = 3) {
			return apply(db, from, [snapshotItem(scopeId, rev)], resetInfo(scopeId));
		}

		it("still adds the copy next to the older one, as before", () => {
			holdCopy({ scopeId: SOURCE });

			pull(AUTHOR);

			expect(copies()).toEqual([movedCopy, olderCopy]);
		});

		it("still delivers a memory whose older copy was tombstoned by a share", () => {
			holdCopy({ scopeId: SOURCE, active: false });

			pull(AUTHOR);

			expect(copies()).toContainEqual(movedCopy);
		});

		it("is unchanged when the only record is for another Project's boundary", () => {
			record("committed", { boundary: OTHER_BOUNDARY });
			holdCopy({ scopeId: SOURCE });

			pull(AUTHOR);

			expect(copies()).toHaveLength(2);
		});
	},
);

describe.each(SNAPSHOT_PATHS)(
	"a committed move: the older copy is replaced ($path)",
	({ apply }) => {
		function pull(from: string, scopeId = BOUNDARY, rev = 3) {
			return apply(db, from, [snapshotItem(scopeId, rev)], resetInfo(scopeId));
		}

		beforeEach(() => record("committed"));

		it("replaces the older copy when the author serves the moved one", () => {
			holdCopy({ scopeId: SOURCE });

			pull(AUTHOR);

			expect(copies()).toEqual([movedCopy]);
		});

		it("replaces the older copy when another device from the older setup serves the moved one", () => {
			holdCopy({ scopeId: SOURCE });

			pull(CARRIER);

			expect(copies()).toEqual([movedCopy]);
		});

		it("replaces a copy held under a second older setup the record names", () => {
			holdCopy({ scopeId: SECOND_SOURCE });

			pull(CARRIER);

			expect(copies()).toEqual([movedCopy]);
		});

		it("accepts the device that created the memory after it left the older setup", async () => {
			verifyCreator(AUTHOR);
			await leave(SOURCE, AUTHOR);
			holdCopy({ scopeId: SOURCE });

			pull(AUTHOR);

			expect(copies()).toEqual([movedCopy]);
		});

		it("delivers the memory to a device that is no longer in the older setup", async () => {
			await leave(SOURCE, LOCAL);
			holdCopy({ scopeId: SOURCE });

			pull(LATE);

			expect(copies()).toEqual([movedCopy]);
		});

		it("keeps the device that created the memory when the snapshot does not name it", () => {
			holdCopy({ scopeId: SOURCE, origin: "device-retired-author" });

			pull(CARRIER);

			expect(copies()).toEqual([{ ...movedCopy, origin_device_id: "device-retired-author" }]);
		});
	},
);

describe.each(SNAPSHOT_PATHS)("a committed move: the older copy is kept ($path)", ({ apply }) => {
	function pull(from: string, scopeId = BOUNDARY, rev = 3) {
		return apply(db, from, [snapshotItem(scopeId, rev)], resetInfo(scopeId));
	}

	beforeEach(() => record("committed"));

	it("keeps the older copy when a device added to the Project later serves it", () => {
		holdCopy({ scopeId: SOURCE });

		pull(LATE);

		expect(copies()).toEqual([olderCopy]);
	});

	it("does not take a peer's word that it created the memory", async () => {
		await leave(SOURCE, AUTHOR);
		holdCopy({ scopeId: SOURCE });

		pull(AUTHOR);

		expect(copies()).toEqual([olderCopy]);
	});

	it("does not accept a membership row in the older setup without proof for the pinned key", async () => {
		db.prepare("UPDATE sync_peers SET public_key = ? WHERE peer_device_id = ?").run(
			anotherPublicKey(),
			CARRIER,
		);
		holdCopy({ scopeId: SOURCE });

		pull(CARRIER);

		expect(copies()).toEqual([olderCopy]);
	});

	it("keeps a copy that is as new as the snapshot, and adds no second row", () => {
		holdCopy({ scopeId: SOURCE, rev: 5 });

		pull(AUTHOR);

		expect(copies()).toEqual([{ ...olderCopy, rev: 5 }]);
	});

	it("leaves a private copy alone", () => {
		holdCopy({ scopeId: SOURCE, visibility: "private" });

		pull(AUTHOR);

		expect(copies()).toHaveLength(2);
	});

	it("does not pull a memory back out of the boundary", () => {
		holdCopy({ scopeId: BOUNDARY });

		pull(AUTHOR, SOURCE);

		expect(copies()).toContainEqual({ ...olderCopy, scope_id: BOUNDARY });
	});
});

describe.each(SNAPSHOT_PATHS)(
	"a committed move: a copy this device may not give up ($path)",
	({ apply }) => {
		function pull(from: string, scopeId = BOUNDARY, rev = 3) {
			return apply(db, from, [snapshotItem(scopeId, rev)], resetInfo(scopeId));
		}

		beforeEach(() => record("committed"));

		it.each(["upsert", "delete"] as const)(
			"keeps the older copy when only this device's proof for the older setup is missing (%s)",
			(opType) => {
				loseProof(SOURCE, LOCAL);
				holdCopy({ scopeId: SOURCE });

				apply(db, LATE, [snapshotItem(BOUNDARY, 3, opType)], resetInfo(BOUNDARY));

				expect(copies()).toEqual([olderCopy]);
			},
		);

		it.each([
			{ name: "this device created", origin: LOCAL },
			{ name: "has no recorded creator", origin: null },
		])("keeps a copy that $name, even in a setup this device has left", async ({ origin }) => {
			await leave(SOURCE, LOCAL);
			holdCopy({ scopeId: SOURCE, origin });

			pull(LATE);

			expect(copies()).toEqual([{ ...olderCopy, origin_device_id: origin }]);
		});
	},
);

describe.each(SNAPSHOT_PATHS)(
	"a committed move: tombstones and copies the boundary already held ($path)",
	({ apply }) => {
		function pull(from: string, scopeId = BOUNDARY, rev = 3) {
			return apply(db, from, [snapshotItem(scopeId, rev)], resetInfo(scopeId));
		}

		beforeEach(() => record("committed"));

		it("delivers the live copy past a tombstone the older setup left, at the same revision", () => {
			holdCopy({ scopeId: SOURCE, active: false, rev: 3, updatedAt: SNAPSHOT_TIME });

			pull(AUTHOR);

			expect(copies()).toContainEqual(movedCopy);
		});

		it("delivers the live copy past a tombstone when a device added later serves it", () => {
			holdCopy({ scopeId: SOURCE, active: false });

			pull(LATE);

			expect(copies()).toContainEqual(movedCopy);
		});

		it("keeps a copy the boundary already held when the older copy is not replaced", () => {
			holdCopy({ scopeId: SOURCE });
			holdCopy({ scopeId: BOUNDARY, rev: 2 });

			pull(LATE);

			expect(copies()).toEqual([movedCopy, olderCopy]);
		});
	},
);

describe.each(SNAPSHOT_PATHS)(
	"a snapshot of the older setup after the move was undone ($path)",
	({ apply }) => {
		function pull(from: string, scopeId = BOUNDARY, rev = 3) {
			return apply(db, from, [snapshotItem(scopeId, rev)], resetInfo(scopeId));
		}

		it("replaces the copy in the boundary with the one returned to the older setup", () => {
			record("rolled_back");
			holdCopy({ scopeId: BOUNDARY });

			pull(AUTHOR, SOURCE);

			expect(copies()).toEqual([{ ...movedCopy, scope_id: SOURCE }]);
		});

		it("does not pull a memory out of a boundary that was shared before the attach", () => {
			record("detached");
			holdCopy({ scopeId: BOUNDARY });

			pull(AUTHOR, SOURCE);

			expect(copies()).toContainEqual({ ...olderCopy, scope_id: BOUNDARY });
		});
	},
);
