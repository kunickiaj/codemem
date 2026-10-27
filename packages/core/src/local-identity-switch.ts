/**
 * Local Identity switch after a coordinator rebind (ADR 0005 Section 8, S4).
 *
 * A durable record moves through:
 * - pending: recorded before finalize was sent;
 * - coordinator_bound: the coordinator returned a matching receipt;
 * - db_committed: the local actor, device binding and generation changed in
 *   one SQLite transaction;
 * - completed: config `actor_id` now names the target Identity.
 * A pending attempt the coordinator never committed ends as not_committed.
 *
 * The old local actor is only retired (is_local = 0); it stays active and is
 * not merged, because merged Team members block that Team's local device
 * eligibility. Memories, Team memberships, grants and peers are untouched.
 */

import type {
	DeviceRebindPending,
	DeviceRebindReceiptV1,
} from "./coordinator-device-rebind-client.js";
import type { Database } from "./db.js";
import { assignIdentityDeviceInTransaction } from "./identity-device-assignment.js";
import { adoptLocalCapture } from "./memory-local-capture.js";
import { mutateCodememConfigFile } from "./observer-config.js";

export type LocalIdentitySwitchState =
	| "pending"
	| "coordinator_bound"
	| "db_committed"
	| "completed"
	| "not_committed";

export interface LocalIdentitySwitch {
	attemptId: string;
	coordinatorOrigin: string;
	groupId: string;
	deviceId: string;
	previousIdentityId: string;
	targetIdentityId: string;
	reviewDigest: string;
	expiresAtMs: number;
	state: LocalIdentitySwitchState;
	bindingId: string | null;
}

export class LocalIdentitySwitchError extends Error {
	constructor(
		readonly code:
			| "local_identity_switch_in_progress"
			| "local_identity_switch_conflict"
			| "local_identity_switch_not_found"
			| "local_identity_override_set",
	) {
		super(code);
	}
}

const OPEN_STATES = ["pending", "coordinator_bound", "db_committed"] as const;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_identity_switches (
	attempt_id TEXT PRIMARY KEY NOT NULL,
	coordinator_origin TEXT NOT NULL,
	group_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	previous_identity_id TEXT NOT NULL,
	target_identity_id TEXT NOT NULL CHECK (target_identity_id <> previous_identity_id),
	review_digest TEXT NOT NULL,
	expires_at_ms INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN
		('pending', 'coordinator_bound', 'db_committed', 'completed', 'not_committed')),
	binding_id TEXT CHECK ((binding_id IS NULL) = (state IN ('pending', 'not_committed'))),
	receipt_json TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_identity_switches_open
	ON local_identity_switches(device_id)
	WHERE state IN ('pending', 'coordinator_bound', 'db_committed');
CREATE TABLE IF NOT EXISTS local_identity_generation (
	id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
	generation INTEGER NOT NULL CHECK (generation >= 1),
	actor_id TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`;

export function ensureLocalIdentitySwitchSchema(db: Database): void {
	db.exec(SCHEMA_SQL);
}

const conflict = (): never => {
	throw new LocalIdentitySwitchError("local_identity_switch_conflict");
};

/**
 * An override would ignore the switched config, so it stops the switch. The
 * store treats CODEMEM_ACTOR_ID as an override whenever it is set, even empty.
 */
export function assertNoLocalIdentityOverride(env: NodeJS.ProcessEnv = process.env): void {
	if (Object.hasOwn(env, "CODEMEM_ACTOR_ID") || env.CODEMEM_DEVICE_ID?.trim())
		throw new LocalIdentitySwitchError("local_identity_override_set");
}

/** Where the switch reads and writes config, and the environment it checks. */
export interface LocalIdentitySwitchContext {
	configPath?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * The configured Identity this switch replaces: the previous one, or nothing
 * when the previous one is the device's default. Read through the same
 * resolution as the final write.
 */
function configuredActor(configPath: string | undefined): string {
	let configured = "";
	mutateCodememConfigFile((data) => {
		configured = typeof data.actor_id === "string" ? data.actor_id.trim() : "";
		return undefined;
	}, configPath);
	return configured;
}

function configStillPrevious(configured: string, previous: string, deviceId: string): boolean {
	return configured === previous || (configured === "" && previous === `local:${deviceId}`);
}

/** Drift in config stops the switch before anything changes, not after. */
function assertConfigStillPrevious(
	row: { previous_identity_id: string; device_id: string },
	context: LocalIdentitySwitchContext,
): void {
	assertNoLocalIdentityOverride(context.env);
	if (
		!configStillPrevious(
			configuredActor(context.configPath),
			row.previous_identity_id,
			row.device_id,
		)
	)
		conflict();
}

type Row = {
	attempt_id: string;
	coordinator_origin: string;
	group_id: string;
	device_id: string;
	previous_identity_id: string;
	target_identity_id: string;
	review_digest: string;
	expires_at_ms: number;
	state: LocalIdentitySwitchState;
	binding_id: string | null;
};

function toSwitch(row: Row): LocalIdentitySwitch {
	return {
		attemptId: row.attempt_id,
		coordinatorOrigin: row.coordinator_origin,
		groupId: row.group_id,
		deviceId: row.device_id,
		previousIdentityId: row.previous_identity_id,
		targetIdentityId: row.target_identity_id,
		reviewDigest: row.review_digest,
		expiresAtMs: row.expires_at_ms,
		state: row.state,
		bindingId: row.binding_id,
	};
}

function readRow(db: Database, attemptId: string): Row | undefined {
	return db.prepare("SELECT * FROM local_identity_switches WHERE attempt_id = ?").get(attemptId) as
		| Row
		| undefined;
}

/** The single open switch on this device, if any; resume starts here. */
export function readOpenLocalIdentitySwitch(db: Database): LocalIdentitySwitch | null {
	const table = db
		.prepare(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_identity_switches'",
		)
		.get();
	if (!table) return null;
	const row = db
		.prepare(
			`SELECT * FROM local_identity_switches WHERE state IN (${OPEN_STATES.map(() => "?").join(", ")})`,
		)
		.get(...OPEN_STATES) as Row | undefined;
	return row ? toSwitch(row) : null;
}

type LocalActor = { actor_id: string; status: string; merged_into_actor_id: string | null };

/** The one active, unmerged local actor; anything else is a conflict. */
function currentLocalActor(db: Database): string {
	const local = db
		.prepare("SELECT actor_id, status, merged_into_actor_id FROM actors WHERE is_local = 1")
		.all() as LocalActor[];
	const actor = local[0];
	if (local.length !== 1 || actor?.status !== "active" || actor.merged_into_actor_id !== null)
		return conflict();
	return actor.actor_id;
}

function localDevice(db: Database): { device_id: string; public_key: string } {
	const devices = db.prepare("SELECT device_id, public_key FROM sync_device").all() as Array<{
		device_id: string;
		public_key: string;
	}>;
	const device = devices[0];
	if (devices.length !== 1 || !device) return conflict();
	return device;
}

const SAME_RECORD_FIELDS = [
	["coordinator_origin", "coordinatorOrigin"],
	["group_id", "groupId"],
	["device_id", "deviceId"],
	["previous_identity_id", "previousIdentityId"],
	["target_identity_id", "targetIdentityId"],
	["review_digest", "reviewDigest"],
	["expires_at_ms", "expiresAtMs"],
] as const;

/**
 * Records the attempt before finalize is sent (the client's recordPending).
 * Repeating the same record is a no-op; a different one for the same attempt,
 * or any other open switch, refuses.
 */
export function recordLocalIdentitySwitch(
	db: Database,
	pending: DeviceRebindPending,
	context: LocalIdentitySwitchContext = {},
): void {
	ensureLocalIdentitySwitchSchema(db);
	if (sameRecordExists(db, pending)) return;
	assertConfigStillPrevious(
		{ previous_identity_id: pending.previousIdentityId, device_id: pending.deviceId },
		context,
	);
	db.transaction(() => {
		if (sameRecordExists(db, pending)) return;
		if (readOpenLocalIdentitySwitch(db))
			throw new LocalIdentitySwitchError("local_identity_switch_in_progress");
		if (
			localDevice(db).device_id !== pending.deviceId ||
			currentLocalActor(db) !== pending.previousIdentityId
		)
			conflict();
		insertPending(db, pending);
	}).immediate();
}

/**
 * The same attempt again is a no-op, unless it already ended uncommitted: a
 * client must never send finalize for that attempt. A different record for
 * the same attempt is a conflict.
 */
function sameRecordExists(db: Database, pending: DeviceRebindPending): boolean {
	const existing = readRow(db, pending.attemptId);
	if (!existing) return false;
	const same = SAME_RECORD_FIELDS.every(([column, key]) => existing[column] === pending[key]);
	if (!same || existing.state === "not_committed") conflict();
	return true;
}

function insertPending(db: Database, pending: DeviceRebindPending): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO local_identity_switches (attempt_id, coordinator_origin, group_id, device_id,
		 previous_identity_id, target_identity_id, review_digest, expires_at_ms, state,
		 created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
	).run(
		pending.attemptId,
		pending.coordinatorOrigin,
		pending.groupId,
		pending.deviceId,
		pending.previousIdentityId,
		pending.targetIdentityId,
		pending.reviewDigest,
		pending.expiresAtMs,
		now,
		now,
	);
}

function requireRow(db: Database, attemptId: string): Row {
	const row = readRow(db, attemptId);
	if (!row) throw new LocalIdentitySwitchError("local_identity_switch_not_found");
	return row;
}

/** Stores the coordinator's receipt; it must describe exactly the recorded switch. */
export function markLocalIdentitySwitchBound(db: Database, receipt: DeviceRebindReceiptV1): void {
	db.transaction(() => {
		ensureLocalIdentitySwitchSchema(db);
		const row = requireRow(db, receipt.attemptId);
		if (
			receipt.deviceId !== row.device_id ||
			receipt.previousIdentityId !== row.previous_identity_id ||
			receipt.targetIdentityId !== row.target_identity_id
		)
			conflict();
		if (row.state !== "pending") {
			if (row.binding_id !== receipt.bindingId || row.state === "not_committed") conflict();
			return;
		}
		db.prepare(
			`UPDATE local_identity_switches SET state = 'coordinator_bound', binding_id = ?,
			 receipt_json = ?, updated_at = ? WHERE attempt_id = ? AND state = 'pending'`,
		).run(receipt.bindingId, JSON.stringify(receipt), new Date().toISOString(), row.attempt_id);
	}).immediate();
}

/** Only for an attempt the coordinator can no longer finalize (resume said not_committed). */
export function markLocalIdentitySwitchNotCommitted(db: Database, attemptId: string): void {
	db.transaction(() => {
		ensureLocalIdentitySwitchSchema(db);
		const row = requireRow(db, attemptId);
		if (row.state === "not_committed") return;
		if (row.state !== "pending") conflict();
		db.prepare(
			`UPDATE local_identity_switches SET state = 'not_committed', updated_at = ?
			 WHERE attempt_id = ? AND state = 'pending'`,
		).run(new Date().toISOString(), attemptId);
	}).immediate();
}

/** Target becomes the local actor; an existing target actor must be an active, unmerged one. */
function switchActors(db: Database, row: Row, displayName: string, now: string): void {
	const target = db
		.prepare("SELECT status, merged_into_actor_id FROM actors WHERE actor_id = ?")
		.get(row.target_identity_id) as Omit<LocalActor, "actor_id"> | undefined;
	if (target && (target.status !== "active" || target.merged_into_actor_id !== null)) conflict();
	// Retire only the "this is me" flag: the old actor stays active and is not merged.
	db.prepare(
		"UPDATE actors SET is_local = 0, updated_at = ? WHERE actor_id = ? AND is_local = 1",
	).run(now, row.previous_identity_id);
	if (target)
		db.prepare("UPDATE actors SET is_local = 1, updated_at = ? WHERE actor_id = ?").run(
			now,
			row.target_identity_id,
		);
	else
		db.prepare(
			`INSERT INTO actors (actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES (?, ?, 1, 'active', ?, ?)`,
		).run(row.target_identity_id, displayName, now, now);
}

type Assignment = { identity_id: string; assignment_version: number; status: string };

/** Moves only this device's own binding, from the old Identity to the target. */
function switchDeviceBinding(db: Database, row: Row, displayName: string, now: string): void {
	const current = db
		.prepare(
			"SELECT identity_id, assignment_version, status FROM identity_devices WHERE device_id = ?",
		)
		.get(row.device_id) as Assignment | undefined;
	if (current && (current.status !== "active" || current.identity_id !== row.previous_identity_id))
		conflict();
	const provenance = {
		displayName,
		provenance: "user_confirmed_identity_setup",
		revision: row.binding_id as string,
		migrationState: "user_managed",
		idempotencyKey: `device-rebind:${row.attempt_id}`,
	};
	assignIdentityDeviceInTransaction(db, {
		deviceId: row.device_id,
		targetIdentityId: row.target_identity_id,
		expectation: current
			? {
					kind: "existing",
					identityId: current.identity_id,
					assignmentVersion: current.assignment_version,
				}
			: { kind: "absent" },
		insert: provenance,
		now,
	});
	// The person confirmed this binding in the browser and the coordinator committed it.
	db.prepare(
		`UPDATE identity_devices SET provenance = ?, revision = ?, migration_state = ?, updated_at = ?
		 WHERE device_id = ? AND identity_id = ?`,
	).run(
		provenance.provenance,
		provenance.revision,
		provenance.migrationState,
		now,
		row.device_id,
		row.target_identity_id,
	);
}

/** Key type and data, ignoring a trailing comment, as local capture compares keys. */
const wireKey = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(" ");

const ADOPTION_CONFLICTS = new Set([
	"device_adoption_actor_conflict",
	"memory_local_capture_adoption_conflict",
]);

function adoptCapture(db: Database, deviceId: string, actorId: string, publicKey: string): void {
	try {
		adoptLocalCapture(db, deviceId, {
			actorId,
			runtimeDeviceId: deviceId,
			expectedPublicKey: publicKey,
		});
	} catch (error) {
		// Storage faults stay visible; only adoption contradictions are switch conflicts.
		if (error instanceof Error && ADOPTION_CONFLICTS.has(error.message)) conflict();
		throw error;
	}
}

/** Processes holding an older generation refuse to write (S4b). */
function bumpGeneration(db: Database, actorId: string, now: string): void {
	db.prepare(
		`INSERT INTO local_identity_generation (id, generation, actor_id, updated_at)
		 VALUES (1, 1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET generation = generation + 1, actor_id = excluded.actor_id,
		 updated_at = excluded.updated_at`,
	).run(actorId, now);
}

/**
 * One transaction: actors, this device's binding, the generation marker, and
 * the record's state. Repeating after commit is a no-op.
 */
export function applyLocalIdentitySwitch(
	db: Database,
	input: {
		attemptId: string;
		displayName: string;
		/** The runtime key from the keys directory, checked against sync_device. */
		expectedPublicKey: string;
	},
	context: LocalIdentitySwitchContext = {},
): void {
	const displayName = input.displayName.trim();
	if (!displayName) conflict();
	ensureLocalIdentitySwitchSchema(db);
	const pendingRow = requireRow(db, input.attemptId);
	if (pendingRow.state === "db_committed" || pendingRow.state === "completed") return;
	assertConfigStillPrevious(pendingRow, context);
	db.transaction(() => {
		const row = requireRow(db, input.attemptId);
		if (row.state === "db_committed" || row.state === "completed") return;
		if (row.state !== "coordinator_bound") conflict();
		const device = localDevice(db);
		if (
			device.device_id !== row.device_id ||
			wireKey(device.public_key) !== wireKey(input.expectedPublicKey) ||
			currentLocalActor(db) !== row.previous_identity_id
		)
			conflict();
		// Bind any unadopted capture source to this device before the actor changes.
		adoptCapture(db, device.device_id, row.previous_identity_id, input.expectedPublicKey);
		const now = new Date().toISOString();
		switchActors(db, row, displayName, now);
		switchDeviceBinding(db, row, displayName, now);
		bumpGeneration(db, row.target_identity_id, now);
		db.prepare(
			`UPDATE local_identity_switches SET state = 'db_committed', updated_at = ?
			 WHERE attempt_id = ? AND state = 'coordinator_bound'`,
		).run(now, row.attempt_id);
	}).immediate();
}

/**
 * Points config `actor_id` at the target, with the local actor's display name.
 * The config must still name the old Identity (or nothing, when that is the
 * device's default), or already the target. Marks the record completed.
 */
export function completeLocalIdentitySwitch(
	db: Database,
	input: { attemptId: string; configPath?: string },
): void {
	ensureLocalIdentitySwitchSchema(db);
	const row = requireRow(db, input.attemptId);
	if (row.state === "completed") return;
	if (row.state !== "db_committed") conflict();
	// Keyed on the generation marker, not is_local: a stale process may re-flag
	// the old actor as local, and the store re-flags the target once config names it.
	const generation = db
		.prepare("SELECT actor_id FROM local_identity_generation WHERE id = 1")
		.get() as { actor_id: string } | undefined;
	const actor = db
		.prepare("SELECT display_name FROM actors WHERE actor_id = ? AND status = 'active'")
		.get(row.target_identity_id) as { display_name: string } | undefined;
	const displayName = actor?.display_name?.trim();
	if (generation?.actor_id !== row.target_identity_id || !displayName) conflict();
	mutateCodememConfigFile((data) => {
		const configured = typeof data.actor_id === "string" ? data.actor_id.trim() : "";
		if (configured === row.target_identity_id) return undefined;
		if (!configStillPrevious(configured, row.previous_identity_id, row.device_id)) conflict();
		return { ...data, actor_id: row.target_identity_id, actor_display_name: displayName };
	}, input.configPath);
	db.prepare(
		`UPDATE local_identity_switches SET state = 'completed', updated_at = ?
		 WHERE attempt_id = ? AND state = 'db_committed'`,
	).run(new Date().toISOString(), row.attempt_id);
}
