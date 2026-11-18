import { type Database, tableExists } from "./db.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";
import {
	listProjectBoundaryMigrationRecords,
	migrationRecordCoversMove,
	type ProjectBoundaryMigrationRecord,
} from "./project-boundary-migration-records.js";
import {
	getCachedScopeAuthorization,
	getEffectiveCachedScopeAuthorization,
} from "./scope-membership-cache-read.js";
import { clockDeviceIdFromMetadataJson, isNewerClock } from "./sync-replication.js";
import type { SyncMemorySnapshotItem } from "./types.js";

/*
 * A scoped snapshot used to add a second row when this device already held the
 * memory under another scope. That is what happens when a Project moves to its
 * own boundary: a device holds the older copy and then pulls the boundary.
 * Where a migration record covers the move, this decides between replacing the
 * older copy and keeping it, so the device ends with one row. Where no record
 * covers it, nothing here applies and the snapshot is applied as before.
 *
 * Only a copy this device can still read counts. A tombstone under the older
 * scope never holds an item back, because an existing share leaves exactly that
 * behind and delivers the live copy by snapshot.
 */

export type CrossScopeDecision =
	/** No record covers a copy this device holds. Apply the item as before. */
	| { kind: "apply" }
	/** Keep the copy this device holds, and do not add the item. */
	| { kind: "keep_existing" }
	/** Remove these copies and add the item in their place. */
	| { kind: "replace"; memoryIds: number[]; originDeviceId: string | null };

export interface CrossScopeSnapshotContext {
	/** False when this device holds no migration record, so no item is ever held back. */
	readonly hasRecords: boolean;
	decide(item: SyncMemorySnapshotItem, itemScopeId: string): CrossScopeDecision;
}

interface HeldCopy {
	id: number;
	scope_id: string | null;
	rev: number | null;
	updated_at: string;
	metadata_json: string | null;
	origin_device_id: string | null;
}

interface Party {
	deviceId: string;
	publicKey: string;
}

const APPLY: CrossScopeDecision = { kind: "apply" };
const NO_RECORDS: CrossScopeSnapshotContext = { hasRecords: false, decide: () => APPLY };
/** The states in which stale-row cleanup removes what a peer sent into a scope. */
const LEFT_SCOPE_STATES = new Set(["revoked", "scope_inactive", "stale_epoch"]);

function itemIsNewer(item: SyncMemorySnapshotItem, copy: HeldCopy): boolean {
	return isNewerClock(
		[item.clock_rev, item.clock_updated_at, item.clock_device_id],
		[copy.rev ?? 0, copy.updated_at, clockDeviceIdFromMetadataJson(copy.metadata_json)],
	);
}

/** Membership the coordinator proved for this exact key. A membership row alone is not enough. */
function provenMember(db: Database, party: Party | null, scopeId: string): boolean {
	if (!party?.publicKey) return false;
	return getEffectiveCachedScopeAuthorization(db, {
		deviceId: party.deviceId,
		scopeId,
		expectedPublicKey: party.publicKey,
	}).authorized;
}

function localParty(db: Database): Party | null {
	const rows = db.prepare("SELECT device_id, public_key FROM sync_device LIMIT 2").all() as Array<{
		device_id: string;
		public_key: string;
	}>;
	const row = rows.length === 1 ? rows[0] : undefined;
	return row ? { deviceId: row.device_id, publicKey: row.public_key } : null;
}

function servingParty(db: Database, peerDeviceId: string): Party {
	const publicKey = db
		.prepare("SELECT public_key FROM sync_peers WHERE peer_device_id = ?")
		.pluck()
		.get(peerDeviceId) as string | null | undefined;
	return { deviceId: peerDeviceId, publicKey: publicKey ?? "" };
}

class RecordedMoves implements CrossScopeSnapshotContext {
	readonly hasRecords = true;
	private readonly proven = new Map<string, boolean>();
	private readonly local: Party | null;
	private readonly serving: Party;

	constructor(
		private readonly db: Database,
		private readonly records: readonly ProjectBoundaryMigrationRecord[],
		peerDeviceId: string,
	) {
		this.local = localParty(db);
		this.serving = servingParty(db, peerDeviceId);
	}

	private isProvenMember(party: Party | null, scopeId: string): boolean {
		const key = `${party?.deviceId ?? ""}\u0000${scopeId}`;
		let answer = this.proven.get(key);
		if (answer === undefined) {
			answer = provenMember(this.db, party, scopeId);
			this.proven.set(key, answer);
		}
		return answer;
	}

	private coveredCopies(importKey: string, itemScopeId: string): HeldCopy[] {
		const held = this.db
			.prepare(
				`SELECT id, scope_id, rev, updated_at, metadata_json, origin_device_id
				 FROM memory_items
				 WHERE import_key = ? AND COALESCE(scope_id, '') != ?
				   AND COALESCE(visibility, '') != 'private'
				   AND active = 1 AND deleted_at IS NULL
				 ORDER BY id`,
			)
			.all(importKey, itemScopeId) as HeldCopy[];
		return held.filter(
			(copy) =>
				copy.scope_id != null &&
				migrationRecordCoversMove(this.records, {
					fromScopeId: copy.scope_id,
					toScopeId: itemScopeId,
				}),
		);
	}

	/**
	 * This device has left the copy's scope, and the copy came from a peer. That is
	 * the state in which stale-row cleanup deletes it. Missing proof of a membership
	 * that is still listed is not this state: the proof can come back, and the copy
	 * with it.
	 */
	private receiverLeftScopeOf(copy: HeldCopy): boolean {
		const origin = copy.origin_device_id;
		if (!this.local || !origin || origin === "local" || origin === this.local.deviceId) {
			return false;
		}
		const cached = getCachedScopeAuthorization(this.db, {
			deviceId: this.local.deviceId,
			scopeId: copy.scope_id ?? "",
		});
		if (cached.authorized || !cached.scope) return false;
		return !cached.membership || LEFT_SCOPE_STATES.has(cached.state);
	}

	/** The serving peer created this memory, by a record this device verified when it arrived. */
	private servingPeerCreated(importKey: string): boolean {
		if (!tableExists(this.db, "memory_source_bindings")) return false;
		return getVerifiedMemorySource(this.db, importKey)?.sourceDeviceId === this.serving.deviceId;
	}

	/**
	 * A copy this device keeps is replaced only on the word of a device that could
	 * have rewritten it anyway: the device that created it, or a proven member of
	 * the scope it is in. A peer's copy in a scope this device has left is not
	 * kept, because a device that never held it would be given the item.
	 */
	private mayReplace(importKey: string, copy: HeldCopy): boolean {
		if (this.receiverLeftScopeOf(copy)) return true;
		if (this.servingPeerCreated(importKey)) return true;
		return this.isProvenMember(this.serving, copy.scope_id ?? "");
	}

	decide(item: SyncMemorySnapshotItem, itemScopeId: string): CrossScopeDecision {
		const copies = this.coveredCopies(item.entity_id, itemScopeId);
		if (copies.length === 0) return APPLY;
		const replaceable = copies.every(
			(copy) => itemIsNewer(item, copy) && this.mayReplace(item.entity_id, copy),
		);
		if (!replaceable) return { kind: "keep_existing" };
		return {
			kind: "replace",
			memoryIds: copies.map((copy) => copy.id),
			originDeviceId: copies[0]?.origin_device_id ?? null,
		};
	}
}

/** Loaded once per snapshot. A device with no migration record does no extra work per item. */
export function crossScopeSnapshotContext(
	db: Database,
	peerDeviceId: string,
): CrossScopeSnapshotContext {
	const records = listProjectBoundaryMigrationRecords(db);
	return records.length === 0 ? NO_RECORDS : new RecordedMoves(db, records, peerDeviceId);
}
