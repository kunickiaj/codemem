// Each test changes one retained-ownership fact after the binding's reads and before the
// batch that binds the device. The negative owner guards in that batch must refuse it.
import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	completeDeviceClaimBinding,
	deviceClaimBindingStatements,
	isDeviceClaimBindingConflict,
	prepareFirstLinkDeviceClaimBinding,
} from "./coordinator-device-claim-binding.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";
import { retainProducerOwner } from "./coordinator-producer-negative-owner-test-fixtures.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	linkedLegacySetupFixture,
} from "./linked-legacy-setup-test-fixtures.js";

let legacy: LinkedLegacySetupFixture | undefined;
afterEach(async () => {
	await legacy?.close();
	legacy = undefined;
});

/** A backend that runs `beforeBatch` once, after the reads and just before the write. */
function racingBackend(db: LinkedLegacySetupFixture["coordinator"]["db"], beforeBatch: () => void) {
	let armed = true;
	return {
		...nativeBackend(db),
		all: async <T>({ sql, values }: AuthLinkStatement) => db.prepare(sql).all(...values) as T[],
		batch: async (statements: AuthLinkStatement[]) => {
			if (armed) beforeBatch();
			armed = false;
			return db
				.transaction(() => statements.map((s) => db.prepare(s.sql).run(...s.values).changes))
				.immediate();
		},
	};
}

async function retainedOwnerFixture() {
	legacy = await linkedLegacySetupFixture("SQLite");
	const subject: RaceSubject = {
		...legacy.account.signer,
		coordinatorId: LEGACY_SETUP.coordinatorId,
		ownerIdentityId: LEGACY_SETUP.identityId,
	};
	await retainProducerOwner(legacy.coordinator.db, subject);
	return { db: legacy.coordinator.db, subject, account: legacy.account };
}

const bindings = (db: LinkedLegacySetupFixture["coordinator"]["db"], deviceId: string) =>
	db.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id=?").all(deviceId);

describe("device binding with retained owner evidence", () => {
	it("binds the device while nothing changes", async () => {
		// Arrange
		const { db, subject, account } = await retainedOwnerFixture();
		const backend = racingBackend(db, () => undefined);
		// Act
		const result = await completeDeviceClaimBinding(
			backend,
			{ signer: account.signer, currentIdentityId: subject.ownerIdentityId },
			account.config,
			Date.parse(LEGACY_SETUP.now),
		);
		// Assert
		expect(result.kind).toBe("completed");
	});

	const races = NEGATIVE_OWNER_CHANGES.filter((race) => !race.skip?.binding);
	it.each(races)("refuses the binding when $fact ($reads)", async (race) => {
		// Arrange
		const { db, subject, account } = await retainedOwnerFixture();
		race.arrange?.(db, subject);
		let atWrite: unknown[] | undefined;
		const backend = racingBackend(db, () => {
			race.change(db, subject);
			atWrite = bindings(db, subject.deviceId);
		});
		// Act
		const outcome = await completeDeviceClaimBinding(
			backend,
			{ signer: account.signer, currentIdentityId: subject.ownerIdentityId },
			account.config,
			Date.parse(LEGACY_SETUP.now),
		).catch((error: unknown) => error);
		// Assert: the binding's own refusal, and no binding written.
		expect(isDeviceClaimBindingConflict(outcome)).toBe(true);
		expect(bindings(db, subject.deviceId)).toEqual(atWrite);
	});
});

// A first-link retry that finds its own binding reuses it. Those statements carry their own
// copies of the negative owner guards; each change below is visible to no other check.
describe("first-link reuse of an existing binding", () => {
	const changes: [string, (db: LinkedLegacySetupFixture["coordinator"]["db"]) => void][] = [
		[
			"the resolution table gains an index",
			(db) =>
				db.exec(
					"CREATE INDEX raced_resolution_index ON coordinator_legacy_owner_resolutions(created_at)",
				),
		],
		[
			"a second retained resolution is stored",
			(db) =>
				db.exec(`INSERT INTO coordinator_legacy_owner_resolutions SELECT coordinator_id,'raced-resolution',resolution_version,device_id,key_id,owner_identity_id,purpose,scope,source_attestation_id,source_group_id,source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at
 FROM coordinator_legacy_owner_resolutions LIMIT 1`),
		],
	];
	const cases = changes.flatMap(([fact, change]) =>
		[true, false].map((pinned) => ({ fact, change, pinned })),
	);
	it.each(cases)("refuses the reuse when $fact (producer pin $pinned)", async (c) => {
		// Arrange: the device's own binding exists, with retained ownership by its owner.
		const { db, subject, account } = await retainedOwnerFixture();
		db.prepare(
			"INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) VALUES (?,?,?,?,?,?,?,?)",
		).run(
			subject.deviceId,
			await ed25519KeyIdForRevocation(subject.publicKey),
			subject.ownerIdentityId,
			subject.coordinatorId,
			"own-binding",
			"owner_enrollment",
			"device_claim:own",
			"2026-10-03T12:00:00.000Z",
		);
		const backend = racingBackend(db, () => undefined);
		const plan = await prepareFirstLinkDeviceClaimBinding(
			backend,
			{ signer: account.signer, currentIdentityId: subject.ownerIdentityId },
			account.config,
			Date.parse(LEGACY_SETUP.now),
		);
		if (!plan?.existingBinding) throw new Error("expected a plan that reuses the binding");
		const enrollments = () => db.prepare("SELECT * FROM enrolled_devices ORDER BY 1,2").all();
		const winning = c.pinned ? { winning: { sql: "? = 1", values: [1] } } : {};
		// Act
		c.change(db);
		const before = enrollments();
		const outcome = await backend
			.batch(deviceClaimBindingStatements(plan, "unused-binding", "event", winning))
			.catch((error: unknown) => error);
		// Assert
		expect(isDeviceClaimBindingConflict(outcome)).toBe(true);
		expect(enrollments()).toEqual(before);
	});
});
