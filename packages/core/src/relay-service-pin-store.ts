import type { Database } from "./db.js";
import { canonicalRelayServiceKey } from "./relay-ed25519.js";

/**
 * Local pins for the relay service key, one per coordinator and group.
 *
 * The first advertised key is pinned. A different advertised key never
 * replaces the pin: it is held as a pending candidate and relay pauses for
 * that coordinator and group until the user approves the candidate locally.
 * An operator-configured key is an explicit out-of-band rotation and is pinned
 * directly.
 */

export type RelayServicePinState = "pinned" | "pending_change";

export interface RelayServicePin {
	readonly coordinatorId: string;
	readonly groupId: string;
	readonly pinnedKey: string;
	readonly firstSeenAt: string;
	readonly state: RelayServicePinState;
	readonly candidateKey: string | null;
	readonly candidateSeenAt: string | null;
	/** The last candidate cleared without approval, kept so a withdrawn change stays visible. */
	readonly lastCandidateKey: string | null;
	readonly lastCandidateSeenAt: string | null;
}

export type RelayServicePinOutcome =
	| { readonly status: "pinned"; readonly key: string }
	| { readonly status: "paused"; readonly pinnedKey: string; readonly candidateKey: string };

interface PinRow {
	coordinator_id: string;
	group_id: string;
	pinned_key: string;
	first_seen_at: string;
	state: RelayServicePinState;
	candidate_key: string | null;
	candidate_seen_at: string | null;
	last_candidate_key: string | null;
	last_candidate_seen_at: string | null;
}

const initialized = new WeakSet<Database>();

/** Additive compatibility migration, independent of the legacy schema-version marker. */
export function ensureRelayServicePinSchema(db: Database): void {
	if (initialized.has(db)) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_relay_service_pins (
			coordinator_id TEXT NOT NULL,
			group_id TEXT NOT NULL,
			pinned_key TEXT NOT NULL,
			first_seen_at TEXT NOT NULL,
			state TEXT NOT NULL CHECK(state IN ('pinned', 'pending_change')),
			candidate_key TEXT,
			candidate_seen_at TEXT,
			last_candidate_key TEXT,
			last_candidate_seen_at TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(coordinator_id, group_id)
		);
	`);
	// A rolled-back schema must not be remembered as initialized.
	if (!db.inTransaction) initialized.add(db);
}

function readRow(db: Database, coordinatorId: string, groupId: string): PinRow | undefined {
	return db
		.prepare("SELECT * FROM sync_relay_service_pins WHERE coordinator_id = ? AND group_id = ?")
		.get(coordinatorId, groupId) as PinRow | undefined;
}

export function readRelayServicePin(
	db: Database,
	coordinatorId: string,
	groupId: string,
): RelayServicePin | null {
	ensureRelayServicePinSchema(db);
	const row = readRow(db, coordinatorId, groupId);
	return row ? pinFromRow(row) : null;
}

/** Every stored pin, ordered by coordinator and group. */
export function listRelayServicePins(db: Database): RelayServicePin[] {
	ensureRelayServicePinSchema(db);
	const rows = db
		.prepare("SELECT * FROM sync_relay_service_pins ORDER BY coordinator_id, group_id")
		.all() as PinRow[];
	return rows.map(pinFromRow);
}

function pinFromRow(row: PinRow): RelayServicePin {
	return {
		coordinatorId: row.coordinator_id,
		groupId: row.group_id,
		pinnedKey: row.pinned_key,
		firstSeenAt: row.first_seen_at,
		state: row.state,
		candidateKey: row.candidate_key,
		candidateSeenAt: row.candidate_seen_at,
		lastCandidateKey: row.last_candidate_key,
		lastCandidateSeenAt: row.last_candidate_seen_at,
	};
}

function writePinned(
	db: Database,
	coordinatorId: string,
	groupId: string,
	key: string,
	at: string,
) {
	db.prepare(
		`INSERT INTO sync_relay_service_pins(
			coordinator_id, group_id, pinned_key, first_seen_at, state,
			candidate_key, candidate_seen_at, updated_at
		) VALUES (?, ?, ?, ?, 'pinned', NULL, NULL, ?)
		ON CONFLICT(coordinator_id, group_id) DO UPDATE SET
			last_candidate_seen_at = CASE WHEN candidate_key IS NOT NULL
				AND candidate_key != excluded.pinned_key
				THEN candidate_seen_at ELSE last_candidate_seen_at END,
			last_candidate_key = CASE WHEN candidate_key IS NOT NULL
				AND candidate_key != excluded.pinned_key
				THEN candidate_key ELSE last_candidate_key END,
			first_seen_at = CASE WHEN pinned_key = excluded.pinned_key
				THEN first_seen_at ELSE excluded.first_seen_at END,
			pinned_key = excluded.pinned_key,
			state = 'pinned',
			candidate_key = NULL,
			candidate_seen_at = NULL,
			updated_at = excluded.updated_at`,
	).run(coordinatorId, groupId, key, at, at);
}

function holdCandidate(db: Database, row: PinRow, candidate: string, at: string): void {
	const seenAt = row.candidate_key === candidate ? (row.candidate_seen_at ?? at) : at;
	db.prepare(
		`UPDATE sync_relay_service_pins
		 SET state = 'pending_change', candidate_key = ?, candidate_seen_at = ?, updated_at = ?
		 WHERE coordinator_id = ? AND group_id = ?`,
	).run(candidate, seenAt, at, row.coordinator_id, row.group_id);
}

/**
 * Compare the key in use with the stored pin. Keys must already be canonical
 * `ssh-ed25519 <base64>` text. `operatorKey` wins over the advertised key.
 */
export function reconcileRelayServicePin(
	db: Database,
	options: {
		readonly coordinatorId: string;
		readonly groupId: string;
		readonly advertisedKey: string;
		readonly operatorKey?: string;
		readonly now?: Date;
	},
): RelayServicePinOutcome {
	ensureRelayServicePinSchema(db);
	const { coordinatorId, groupId, advertisedKey, operatorKey } = options;
	const at = (options.now ?? new Date()).toISOString();
	return db
		.transaction((): RelayServicePinOutcome => {
			const row = readRow(db, coordinatorId, groupId);
			// An operator key is an explicit rotation. Without a row, this is the first fetch.
			if (operatorKey !== undefined || !row) {
				const key = operatorKey ?? advertisedKey;
				writePinned(db, coordinatorId, groupId, key, at);
				return { status: "pinned", key };
			}
			// The coordinator returned to the pinned key, so nothing new needs approval.
			if (row.pinned_key === advertisedKey) {
				if (row.state !== "pinned") writePinned(db, coordinatorId, groupId, advertisedKey, at);
				return { status: "pinned", key: row.pinned_key };
			}
			holdCandidate(db, row, advertisedKey, at);
			return { status: "paused", pinnedKey: row.pinned_key, candidateKey: advertisedKey };
		})
		.immediate();
}

/**
 * Install a pending candidate key after explicit local user approval. The
 * caller passes the candidate it showed the user, so a key that changed again
 * after display is not approved. Returns false when nothing matching is pending.
 */
export function approveRelayServiceKey(
	db: Database,
	options: {
		readonly coordinatorId: string;
		readonly groupId: string;
		readonly candidateKey: string;
		readonly now?: Date;
	},
): boolean {
	ensureRelayServicePinSchema(db);
	const candidateKey = canonicalRelayServiceKey(options.candidateKey);
	if (!candidateKey) return false;
	const at = (options.now ?? new Date()).toISOString();
	const result = db
		.prepare(
			`UPDATE sync_relay_service_pins
			 SET pinned_key = candidate_key, first_seen_at = ?, state = 'pinned',
			     candidate_key = NULL, candidate_seen_at = NULL, updated_at = ?
			 WHERE coordinator_id = ? AND group_id = ?
			   AND state = 'pending_change' AND candidate_key = ?`,
		)
		.run(at, at, options.coordinatorId, options.groupId, candidateKey);
	return result.changes === 1;
}
