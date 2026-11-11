// Each test changes one retained-ownership fact after a recipient invite's reads and just
// before its first write batch. The negative owner guards that lead it must refuse it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSnapshotChanged } from "./coordinator-auth-read-set.js";
import { type Fixture, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import { prepareOriginalNegativeOwnerConsistency } from "./coordinator-owner-negative-original-sql-test-fixtures.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";
import { readNegativeOwnerConsistency } from "./coordinator-owner-negative-read-set.js";
import {
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
	vi.restoreAllMocks();
});

const TOKEN_WRITE = /UPDATE coordinator_invites SET token\s*=/;
type Kind = "SQLite" | "D1";

/** An unconsumed invite whose device has retained ownership by the invite's Identity. */
async function retainedRecipient(backend: Kind, kind: "team_member" | "add_device") {
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

/**
 * Consumes the invite, running `change` after the reads and before the first write batch.
 * D1 writes in batches the test can see; the SQLite store writes in one transaction.
 */
async function consumeWith(
	backend: Kind,
	f: Fixture,
	input: CoordinatorConsumeRecipientInviteInput,
	change: () => void,
) {
	if (backend === "SQLite") {
		// The store's write transaction is its only immediate one; its reads come before it.
		let ran = false;
		const transaction = f.db.transaction.bind(f.db);
		type Tx = ReturnType<typeof transaction>;
		const hook = vi.spyOn(f.db, "transaction").mockImplementation((fn) => {
			const tx = transaction(fn);
			const immediate = (...args: unknown[]) => {
				if (!ran) {
					ran = true;
					change();
				}
				return tx.immediate(...(args as []));
			};
			return Object.assign((...args: unknown[]) => tx(...(args as [])), {
				default: tx.default,
				deferred: tx.deferred,
				immediate,
				exclusive: tx.exclusive,
			}) as unknown as Tx;
		});
		try {
			const outcome = await f.store.consumeRecipientInvite(input).catch((e: unknown) => e);
			return { outcome, ran };
		} finally {
			hook.mockRestore();
		}
	}
	let ran = false;
	const store = new D1CoordinatorStore(
		sqliteD1(f.db, {
			beforeBatch: (statements) => {
				if (ran || !statements.some(({ query }) => TOKEN_WRITE.test(query))) return;
				ran = true;
				change();
			},
		}),
	);
	return { outcome: await store.consumeRecipientInvite(input).catch((e: unknown) => e), ran };
}

// The recipient names no enrollment, so the enrollment read selects no group's row.
const races = NEGATIVE_OWNER_CHANGES.filter((race) => race.reads !== "enrollment");

describe.each(["SQLite", "D1"] as const)(
	"%s recipient invite with retained ownership",
	(backend) => {
		it.each(["team_member", "add_device"] as const)(
			"accepts a %s invite while nothing changes",
			async (kind) => {
				// Arrange
				const { f, input } = await retainedRecipient(backend, kind);
				// Act
				const { outcome, ran } = await consumeWith(backend, f, input, () => undefined);
				// Assert
				expect(ran).toBe(true);
				expect(outcome).toMatchObject({ status: "accepted" });
			},
		);

		it.each(races)("refuses and writes nothing when $fact ($reads)", async (race) => {
			// Arrange
			const { f, input, subject } = await retainedRecipient(backend, "add_device");
			race.arrange?.(f.db, subject);
			let atWrite: ReturnType<typeof producerSnapshot> | undefined;
			// Act
			const { outcome, ran } = await consumeWith(backend, f, input, () => {
				race.change(f.db, subject);
				atWrite = producerSnapshot(f.db);
			});
			// Assert
			expect(ran).toBe(true);
			expect(outcome).toBeInstanceOf(Error);
			expect(producerSnapshot(f.db)).toEqual(atWrite);
		});
	},
);

// The first read of the subject's retained resolutions, before the evidence reads. A
// second same-owner resolution lands just after it, before the evidence reads its rows.
const RETAINED_READ =
	"FROM coordinator_legacy_owner_resolutions\n WHERE coordinator_id=? AND (device_id=? OR key_id=?) ORDER BY row";
const EVIDENCE_READ = "json_quote(capped";
// Main's statements at the same two points: its absence check, then its evidence read.
const MAIN_RETAINED_READ = "SELECT NOT EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions";
const MAIN_EVIDENCE_READ = "ownership_input AS MATERIALIZED";
/**
 * A second resolution for the same owner and key, reviewed for another device of that key,
 * with its own retained source. The classification accepts it beside the first.
 */
function sameOwnerResolution(f: Fixture) {
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
function afterRetainedRead(f: Fixture, change: () => void) {
	const prepare = f.db.prepare.bind(f.db);
	let state: "waiting" | "armed" | "done" = "waiting";
	const hook = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
		if (!sql.includes("auth_snapshot_changed")) {
			if (state === "waiting" && (sql.includes(RETAINED_READ) || sql.includes(MAIN_RETAINED_READ)))
				state = "armed";
			else if (
				state === "armed" &&
				(sql.includes(EVIDENCE_READ) || sql.includes(MAIN_EVIDENCE_READ))
			) {
				state = "done";
				change();
			}
		}
		return prepare(sql);
	});
	return { ran: () => state === "done", restore: () => hook.mockRestore() };
}

describe.each(["SQLite", "D1"] as const)(
	"%s recipient invite when a same-owner resolution lands between the retained and evidence reads",
	(backend) => {
		it("pins the same retained rows in its full and retained guards, as main's pins did", async () => {
			// Arrange: main's pins and the read set, each on its own identical fixture, each
			// with the resolution landing mid-read.
			const pins = async (prepare: "main" | "port") => {
				const { f, subject } = await retainedRecipient(backend, "add_device");
				const reader = {
					first: async <T>({ sql, values }: { sql: string; values: unknown[] }) =>
						(f.db.prepare(sql).get(...values) as T | undefined) ?? null,
					all: async <T>({ sql, values }: { sql: string; values: unknown[] }) =>
						f.db.prepare(sql).all(...values) as T[],
				};
				// As the recipient invite reads it: the device names no enrollment yet.
				const { groupId: _group, ...input } = subject;
				const hook = afterRetainedRead(f, () => sameOwnerResolution(f));
				// Act
				const matches = (statement: { sql: string; values: unknown[] }) =>
					(f.db.prepare(statement.sql).get(...statement.values) as { matches: number }).matches ===
					1;
				if (prepare === "main") {
					const original = await prepareOriginalNegativeOwnerConsistency(reader, input);
					hook.restore();
					if (!original) throw new Error("main refused the same-owner subject");
					return {
						ran: hook.ran(),
						full: matches(original),
						retained: matches(original.retainedRecheck),
					};
				}
				const ported = await readNegativeOwnerConsistency(reader, input);
				hook.restore();
				if (!ported) return { ran: hook.ran(), refused: true };
				// Every guard of the set holds, as the write batch would run them.
				const hold = (guards: { sql: string; values: unknown[] }[]) => {
					try {
						for (const guard of guards) f.db.prepare(guard.sql).get(...guard.values);
						return true;
					} catch (error) {
						if (isSnapshotChanged(error)) return false;
						throw error;
					}
				};
				return {
					ran: hook.ran(),
					full: hold(ported.guards),
					retained: hold(ported.retainedGuards),
				};
			};
			// Assert: each pins the database the write batch will see in both its pins.
			expect(await pins("main")).toEqual({ ran: true, full: true, retained: true });
			expect(await pins("port")).toEqual({ ran: true, full: true, retained: true });
		});

		it("accepts, rather than reporting failure after its writes committed", async () => {
			// Arrange
			const { f, input } = await retainedRecipient(backend, "add_device");
			const hook = afterRetainedRead(f, () => sameOwnerResolution(f));
			// Act
			const { outcome } = await consumeWith(backend, f, input, () => undefined);
			hook.restore();
			// Assert: like main, it accepts this compatible owner and its writes stand.
			expect(hook.ran()).toBe(true);
			expect(outcome).toMatchObject({ status: "accepted" });
			expect(
				f.db
					.prepare("SELECT count(*) AS n FROM enrolled_devices WHERE device_id=?")
					.get(input.deviceId),
			).toEqual({ n: 1 });
		});
	},
);
