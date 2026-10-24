import { afterEach, beforeEach, expect, vi } from "vitest";
import {
	input,
	otherKey,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import {
	advance,
	attempt,
	backendTest,
	finalize,
	type LinkFixture,
} from "./coordinator-auth-link-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	beforeProducerWinningWrite,
	prepareProducerOwner,
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";

async function confirmed(f: LinkFixture) {
	f.db.exec(seedEnrollmentSql);
	await advance(
		f,
		"confirmed",
		attempt({
			authority: { kind: "device_claim", identityId: input.identityId },
			signer: input.signer,
		}),
	);
	expect(f.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual({
		state: "confirmed",
	});
}
const proof = () => finalize({ signer: input.signer, fingerprint: input.signer.fingerprint });
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} same-owner retained claim fact still requires its original source`, async ({
		fixture: f,
	}) => {
		// Arrange: no live controller remains to trigger the older ordinary controller denial.
		await retainProducerOwner(
			f.db,
			{ ...input.signer, coordinatorId: f.cfg.coordinatorId, ownerIdentityId: input.identityId },
			{ removeSource: true },
		);
		await confirmed(f);
		const before = producerSnapshot(f.db);
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
		// Assert
		expect(result).toMatchObject({ kind: "rejected" });
		expect(producerSnapshot(f.db)).toEqual(before);
	});
	test(`${backend} device claim pins empty subject facts at winning UPDATE`, async ({
		fixture: f,
	}) => {
		// Arrange: removed original source leaves only the new retained negative fact.
		const seed = await prepareProducerOwner(
			f.db,
			{ ...input.signer, coordinatorId: f.cfg.coordinatorId, ownerIdentityId: "owner-A" },
			{ removeSource: true },
		);
		await confirmed(f);
		let atWrite: ReturnType<typeof producerSnapshot> | undefined;
		const hook = beforeProducerWinningWrite(
			f.db,
			/UPDATE coordinator_auth_link_attempts\s+SET state = 'finalized'/,
			() => {
				seed();
				atWrite = producerSnapshot(f.db);
			},
		);
		try {
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
			// Assert
			expect(hook.observed()).toBe(true);
			expect(result).toMatchObject({ kind: "rejected" });
			expect(producerSnapshot(f.db)).toEqual(atWrite);
		} finally {
			hook.restore();
		}
	});
	for (const catalog of ["missing", "ready", "foreign"] as const) {
		test(`${backend} device claim preserves ordinary ${catalog} no-local-fact admission`, async ({
			fixture: f,
		}) => {
			// Arrange: foreign retained ownership must not become a local owner collision.
			if (catalog === "missing")
				f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
			if (catalog === "ready") f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
			if (catalog === "foreign")
				await retainProducerOwner(f.db, {
					...input.signer,
					coordinatorId: "foreign-coordinator",
					ownerIdentityId: "owner-A",
				});
			await confirmed(f);
			const history = f.db.prepare("SELECT * FROM coordinator_legacy_team_completions").all();
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
			// Assert
			expect(result).toMatchObject({ kind: "applied" });
			expect(f.db.prepare("SELECT * FROM coordinator_auth_device_claims").all()).toHaveLength(1);
			expect(f.db.prepare("SELECT * FROM coordinator_legacy_team_completions").all()).toEqual(
				history,
			);
		});
	}
	for (const match of ["device", "canonical key"] as const) {
		test(`${backend} device claim cannot assign B over retained A by ${match} after source removal`, async ({
			fixture: f,
		}) => {
			// Arrange: remove the original controller so ordinary strong-owner checks cannot mask the gap.
			await retainProducerOwner(
				f.db,
				{
					...input.signer,
					publicKey: match === "device" ? otherKey : `${input.signer.publicKey} original-alias`,
					coordinatorId: f.cfg.coordinatorId,
					ownerIdentityId: "owner-A",
				},
				{
					removeSource: true,
					resolutionDeviceId: match === "device" ? input.signer.deviceId : "old-device",
				},
			);
			await confirmed(f);
			const before = producerSnapshot(f.db);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
			// Assert: no attempt transition, claim, link, audit, profile or access writes.
			expect(result).toMatchObject({ kind: "rejected" });
			expect(producerSnapshot(f.db)).toEqual(before);
		});
	}
	test(`${backend} same-owner retained fact cannot bypass disabled current enrollment`, async ({
		fixture: f,
	}) => {
		// Arrange
		await confirmed(f);
		await retainProducerOwner(f.db, {
			...input.signer,
			coordinatorId: f.cfg.coordinatorId,
			ownerIdentityId: input.identityId,
		});
		f.db
			.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?")
			.run(input.signer.deviceId);
		const before = producerSnapshot(f.db);
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
		// Assert
		expect(result).toMatchObject({ kind: "rejected" });
		expect(producerSnapshot(f.db)).toEqual(before);
	});
	test(`${backend} partial resolution catalog fails closed without claim sibling writes`, async ({
		fixture: f,
	}) => {
		// Arrange
		await confirmed(f);
		f.db.exec(
			"DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions; CREATE TABLE coordinator_legacy_owner_resolutions (device_id TEXT)",
		);
		const before = producerSnapshot(f.db);
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
		// Assert
		expect(result).toMatchObject({ kind: "rejected" });
		expect(producerSnapshot(f.db)).toEqual(before);
	});
	test(`${backend} missing catalog captured before winning claim UPDATE cannot appear unnoticed`, async ({
		fixture: f,
	}) => {
		// Arrange: hook the actual winning SQL, allowing future CTE composition.
		await confirmed(f);
		f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
		let atWrite: ReturnType<typeof producerSnapshot> | undefined;
		const hook = beforeProducerWinningWrite(
			f.db,
			/UPDATE coordinator_auth_link_attempts\s+SET state = 'finalized'/,
			() => {
				f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
				atWrite = producerSnapshot(f.db);
			},
		);
		try {
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
			// Assert
			expect(hook.observed()).toBe(true);
			expect(result).toMatchObject({ kind: "rejected" });
			expect(producerSnapshot(f.db)).toEqual(atWrite);
		} finally {
			hook.restore();
		}
	});
}
