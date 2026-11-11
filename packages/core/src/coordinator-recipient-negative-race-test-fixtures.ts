import { vi } from "vitest";
import { isSnapshotChanged } from "./coordinator-auth-read-set.js";
import { type Fixture, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import type { RaceSubject } from "./coordinator-owner-negative-race-test-fixtures.js";
import { readNegativeOwnerConsistency } from "./coordinator-owner-negative-read-set.js";
import { retainProducerOwner } from "./coordinator-producer-negative-owner-test-fixtures.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";

/** An unconsumed invite whose device has retained ownership by the invite's Identity. */
export async function retainedRecipientFixture(
	backend: "SQLite" | "D1",
	kind: "team_member" | "add_device",
	cleanup: Array<() => Promise<void>>,
) {
	const f: Fixture = setupStore(backend);
	cleanup.push(async () => {
		await f.store.close();
		if (f.db.open) f.db.close();
	});
	const harness = {
		store: f.store,
		input: revocationInput("raced"),
		exec: async (sql: string, ...values: unknown[]) => {
			f.db.prepare(sql).run(...values);
		},
		rows: async (table: string) => f.db.prepare(`SELECT * FROM ${table}`).all(),
	};
	const invitation = await recipientInvite(harness, kind);
	const input: CoordinatorConsumeRecipientInviteInput = {
		...invitation.input,
		coordinatorId: "coordinator-a",
	};
	const subject: RaceSubject = {
		coordinatorId: "coordinator-a",
		groupId: harness.input.groupId,
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
		ownerIdentityId: input.identityId,
	};
	await retainProducerOwner(f.db, subject);
	return { f, input, subject };
}

// The first read of the subject's retained resolutions, then the first evidence read: the
// read set's statements, and main's absence check and evidence statement.
const RETAINED_READS = [
	"FROM coordinator_legacy_owner_resolutions\n WHERE coordinator_id=? AND (device_id=? OR key_id=?) ORDER BY row",
	"SELECT NOT EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions",
];
const EVIDENCE_READS = ["json_quote(capped", "ownership_input AS MATERIALIZED"];

/**
 * A second resolution for the same owner and key, reviewed for another device of that key,
 * with its own retained source. The classification accepts it beside the first.
 */
export function sameOwnerResolution(f: Fixture) {
	f.db.exec(`INSERT INTO coordinator_auth_controller_attestations
 SELECT 'raced-source-controller',coordinator_id,identity_id,'raced-source-group','raced-device',public_key,
 fingerprint,'raced-source-review',evidence_digest,enrollment_identity_id,revision,created_at,revoked_at
 FROM coordinator_auth_controller_attestations WHERE attestation_id='producer-original-controller';
 INSERT INTO coordinator_legacy_owner_resolutions SELECT coordinator_id,'raced-resolution',resolution_version,
 'raced-device',key_id,owner_identity_id,purpose,scope,'raced-source-controller','raced-source-group',
 source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,
 'raced-source-review',source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at
 FROM coordinator_legacy_owner_resolutions WHERE resolution_id='producer-original-resolution'`);
}

/** Runs `change` once, after the retained read and before the first evidence read. */
export function afterRetainedRead(f: Fixture, change: () => void) {
	const prepare = f.db.prepare.bind(f.db);
	let state: "waiting" | "armed" | "done" = "waiting";
	const hook = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
		if (sql.includes("auth_snapshot_changed")) return prepare(sql);
		if (state === "waiting" && RETAINED_READS.some((read) => sql.includes(read))) state = "armed";
		else if (state === "armed" && EVIDENCE_READS.some((read) => sql.includes(read))) {
			state = "done";
			change();
		}
		return prepare(sql);
	});
	return { ran: () => state === "done", restore: () => hook.mockRestore() };
}

/** Reads straight from the fixture database, as both negative owner checks may. */
export function fixtureReader(f: Fixture) {
	return {
		first: async <T>({ sql, values }: { sql: string; values: unknown[] }) =>
			(f.db.prepare(sql).get(...values) as T | undefined) ?? null,
		all: async <T>({ sql, values }: { sql: string; values: unknown[] }) =>
			f.db.prepare(sql).all(...values) as T[],
	};
}

/** The recipient's subject as the invite reads it: the device names no enrollment yet. */
export function recipientSubject(subject: RaceSubject) {
	const { groupId: _group, ...input } = subject;
	return input;
}

/**
 * The read set's guards when a same-owner resolution lands mid-read, and whether its full
 * and its retained guards each hold, as the write batch would run them.
 */
export async function portedPinsAfterSameOwnerResolution(f: Fixture, subject: RaceSubject) {
	const hook = afterRetainedRead(f, () => sameOwnerResolution(f));
	const ported = await readNegativeOwnerConsistency(fixtureReader(f), recipientSubject(subject));
	hook.restore();
	if (!ported) return { ran: hook.ran(), refused: true };
	const hold = (guards: { sql: string; values: unknown[] }[]) => {
		try {
			for (const guard of guards) f.db.prepare(guard.sql).get(...guard.values);
			return true;
		} catch (error) {
			if (isSnapshotChanged(error)) return false;
			throw error;
		}
	};
	return { ran: hook.ran(), full: hold(ported.guards), retained: hold(ported.retainedGuards) };
}
