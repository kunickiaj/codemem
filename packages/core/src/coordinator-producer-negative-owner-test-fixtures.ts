import type { Database } from "better-sqlite3";
import { vi } from "vitest";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";

type Subject = {
	coordinatorId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	ownerIdentityId: string;
};
function insert(db: Database, table: string, row: Record<string, unknown>) {
	const entries = Object.entries(row);
	db.prepare(
		`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
	).run(...entries.map(([, value]) => value));
}

/** Old retained provenance is seeded before the new producer; no production bypass. */
export async function retainProducerOwner(
	db: Database,
	subject: Subject,
	options: { removeSource?: boolean; resolutionDeviceId?: string } = {},
) {
	(await prepareProducerOwner(db, subject, options))();
}

/** Compute real canonical key metadata before a synchronous winning-write hook. */
export async function prepareProducerOwner(
	db: Database,
	subject: Subject,
	options: { removeSource?: boolean; resolutionDeviceId?: string } = {},
) {
	db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	const deviceId = options.resolutionDeviceId ?? subject.deviceId;
	const source = {
		attestation_id: "producer-original-controller",
		coordinator_id: subject.coordinatorId,
		identity_id: subject.ownerIdentityId,
		group_id: "producer-original-group",
		device_id: deviceId,
		public_key: subject.publicKey,
		fingerprint: subject.fingerprint,
		review_receipt_id: "producer-original-review",
		evidence_digest: "b".repeat(64),
		enrollment_identity_id: null,
		revision: 1,
		created_at: "2026-09-01T00:00:00.000Z",
		revoked_at: null,
	};
	const resolution = {
		coordinator_id: subject.coordinatorId,
		resolution_id: "producer-original-resolution",
		resolution_version: 1,
		device_id: deviceId,
		key_id: await ed25519KeyIdForRevocation(subject.publicKey),
		owner_identity_id: subject.ownerIdentityId,
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: source.attestation_id,
		source_group_id: source.group_id,
		source_controller_revision: source.revision,
		source_public_key: source.public_key,
		source_fingerprint: source.fingerprint,
		source_enrollment_identity_id: null,
		source_created_at: source.created_at,
		source_review_receipt_id: source.review_receipt_id,
		source_evidence_digest: source.evidence_digest,
		resolution_evidence_digest: "d".repeat(64),
		reviewed_weak_labels_json: "[]",
		created_at: "2026-09-02T00:00:00.000Z",
	};
	return () => {
		insert(db, "coordinator_auth_controller_attestations", source);
		insert(db, "coordinator_legacy_owner_resolutions", resolution);
		if (options.removeSource)
			db.prepare("DELETE FROM coordinator_auth_controller_attestations WHERE attestation_id=?").run(
				source.attestation_id,
			);
	};
}

export function producerSnapshot(db: Database) {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
}

/** Execution hook: D1 may prepare before the batch starts its transaction. */
export function beforeProducerWinningWrite(db: Database, gate: RegExp, mutate: () => void) {
	const prepare = db.prepare.bind(db);
	let observed = false;
	let execution: { mockRestore(): void } | undefined;
	const hook = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (!execution && gate.test(sql)) {
			const run = statement.run.bind(statement);
			execution = vi.spyOn(statement, "run").mockImplementationOnce((...values) => {
				observed = true;
				mutate();
				return run(...values);
			});
		}
		return statement;
	});
	return {
		observed: () => observed,
		restore() {
			execution?.mockRestore();
			hook.mockRestore();
		},
	};
}

// Every read-set guard aborts through this JSON path, and guards lead their write batch.
const GUARD_MARKER = "auth_snapshot_changed";
const RESTART = Symbol("restart the batch after the change");
type Transaction = ((...args: unknown[]) => unknown) &
	Record<"deferred" | "immediate" | "exclusive", (...args: unknown[]) => unknown>;

/**
 * Runs `mutate` once, just before the next write batch that starts with read-set guards:
 * after the producer's reads, before its atomic write, and outside that batch's
 * transaction so the change survives the batch's own rollback. The batch's statements are
 * prepared inside its transaction, so the first guard ends that attempt unexecuted; the
 * change is then made and the same batch runs from its start.
 */
export function beforeProducerWriteBatch(db: Database, mutate: () => void) {
	const prepare = db.prepare.bind(db);
	const transaction = db.transaction.bind(db);
	let observed = false;
	const prepared = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		if (!observed && db.inTransaction && sql.includes(GUARD_MARKER)) {
			observed = true;
			throw RESTART;
		}
		return prepare(sql);
	});
	const restartable =
		(run: (...args: unknown[]) => unknown) =>
		(...args: unknown[]) => {
			try {
				return run(...args);
			} catch (error) {
				if (error !== RESTART) throw error;
				mutate();
				return run(...args);
			}
		};
	const transactions = vi.spyOn(db, "transaction").mockImplementation((fn) => {
		const tx = transaction(fn) as unknown as Transaction;
		return Object.assign(restartable(tx), {
			deferred: restartable(tx.deferred),
			immediate: restartable(tx.immediate),
			exclusive: restartable(tx.exclusive),
		}) as unknown as ReturnType<typeof transaction>;
	});
	return {
		observed: () => observed,
		restore() {
			prepared.mockRestore();
			transactions.mockRestore();
		},
	};
}
