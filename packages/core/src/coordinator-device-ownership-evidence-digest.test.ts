import { afterEach, beforeEach, expect, vi } from "vitest";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	binding,
	cfg,
	claim,
	collectInput,
	controller,
	databaseSnapshot,
	evidenceBackend,
	evidenceTest,
	history,
	insert,
	invitation,
	otherKey,
	signer,
	sourceRef,
	timestamp,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { EXPECTED_KEY_ID } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";

function digest(reader: CoordinatorDeviceOwnershipEvidence, snapshot: unknown) {
	return reader.reviewedEvidenceDigest(snapshot);
}

async function captured(
	reader: CoordinatorDeviceOwnershipEvidence,
	input: Parameters<CoordinatorDeviceOwnershipEvidence["collect"]>[0],
) {
	const result = await reader.collect(input);
	expect(result.kind).toBe("collected");
	if (result.kind !== "collected") throw new Error("synthetic collection unavailable");
	return result;
}

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	test("original snapshots hash deterministically across fresh readers without reads or writes", async ({
		f,
	}) => {
		// Arrange: digest only captured data; no database capability is needed afterwards.
		const db = evidenceBackend(f, backend);
		const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
		const freshReader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
		const input = await collectInput(f);
		const first = await captured(reader, input);
		const second = await captured(freshReader, input);
		const before = databaseSnapshot(f);
		const firstRead = vi.spyOn(db, "first").mockRejectedValue(new Error("no digest queries"));
		const allRead = vi.spyOn(db, "all").mockRejectedValue(new Error("no digest queries"));
		// Act
		const result = await digest(reader, first.recheckSnapshot);
		const repeated = await digest(reader, first.recheckSnapshot);
		const independent = await digest(freshReader, second.recheckSnapshot);
		// Assert: a digest string is not an authority object, row dump, or provider subject.
		expect(result).toMatch(/^[a-f0-9]{64}$/u);
		expect(repeated).toBe(result);
		expect(independent).toBe(result);
		expect(firstRead).not.toHaveBeenCalled();
		expect(allRead).not.toHaveBeenCalled();
		expect(databaseSnapshot(f)).toEqual(before);
	});

	test.for(["copied", "serialized", "foreign", "fake", "null"] as const)(
		"rejects %s snapshot tokens rather than hashing public token fields",
		async (mode, { f }) => {
			// Arrange
			const db = evidenceBackend(f, backend);
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			const original = await captured(reader, await collectInput(f));
			const foreign = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			let token: unknown = original.recheckSnapshot;
			if (mode === "copied") token = { ...original.recheckSnapshot };
			if (mode === "serialized") token = JSON.parse(JSON.stringify(token));
			if (mode === "fake") token = Object.freeze({ version: 1 });
			if (mode === "null") token = null;
			// Act
			const result = await digest(mode === "foreign" ? foreign : reader, token);
			// Assert
			expect(result).toBeNull();
		},
	);

	test.for([
		"same owner controller",
		"device collision different key",
		"canonical key different device",
		"binding",
		"claim",
		"project actor",
		"resolution",
		"enrollment",
		"revocation",
		"history",
		"subject key family",
	] as const)("includes relevant %s changes", async (change, { f }) => {
		// Arrange
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		const original = change === "resolution" ? controller(f) : null;
		const old = await captured(reader, await collectInput(f));
		switch (change) {
			case "same owner controller":
				controller(f);
				break;
			case "device collision different key":
				controller(f, { public_key: otherKey });
				break;
			case "canonical key different device":
				controller(f, { device_id: "same-key-other-device" });
				break;
			case "binding":
				binding(f, { identity_id: "A" });
				break;
			case "claim":
				claim(f, { identity_id: "A" });
				break;
			case "project actor":
				invitation(f, {
					invite_kind: "project_share",
					assigned_identity_id: null,
					recipient_actor_id: "C",
				});
				break;
			case "resolution":
				if (!original) throw new Error("synthetic source unavailable");
				insert(f, "coordinator_legacy_owner_resolutions", sourceRef(original));
				break;
			case "enrollment":
				expect(
					f.db
						.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id=?")
						.get(signer.deviceId),
				).toEqual({ identity_id: null });
				f.db
					.prepare("UPDATE enrolled_devices SET identity_id='A' WHERE device_id=?")
					.run(signer.deviceId);
				expect(
					f.db
						.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id=?")
						.get(signer.deviceId),
				).toEqual({ identity_id: "A" });
				break;
			case "revocation":
				insert(f, "coordinator_device_revocations", {
					subject_kind: "ed25519_key",
					subject_value: EXPECTED_KEY_ID,
					revocation_id: "synthetic-revocation",
					evidence_group_id: signer.groupId,
					evidence_device_id: signer.deviceId,
					evidence_public_key: signer.publicKey,
					evidence_fingerprint: signer.fingerprint,
					created_at: timestamp,
				});
				break;
			case "history":
				history(f);
				break;
			case "subject key family":
				await f.store.enrollDevice(signer.groupId, {
					deviceId: "same-key-device",
					publicKey: signer.publicKey,
					fingerprint: "f".repeat(64),
				});
				break;
		}
		// Act: fresh history is deliberately rebuilt before collecting the changed state.
		const fresh = await captured(reader, await collectInput(f));
		const before = await digest(reader, old.recheckSnapshot);
		const after = await digest(reader, fresh.recheckSnapshot);
		// Assert
		expect(after).toMatch(/^[a-f0-9]{64}$/u);
		expect(after).not.toBe(before);
	});

	test.for(["review_receipt_id", "evidence_digest", "revoked_at"] as const)(
		"includes original controller source %s, not only owner classification",
		async (field, { f }) => {
			// Arrange
			controller(f);
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			const old = await captured(reader, await collectInput(f));
			const value = {
				review_receipt_id: "changed-receipt",
				evidence_digest: "e".repeat(64),
				revoked_at: "2026-10-02T00:00:00.000Z",
			}[field];
			f.db.prepare(`UPDATE coordinator_auth_controller_attestations SET ${field}=?`).run(value);
			// Act
			const fresh = await captured(reader, await collectInput(f));
			const before = await digest(reader, old.recheckSnapshot);
			const after = await digest(reader, fresh.recheckSnapshot);
			// Assert
			expect(after).not.toBe(before);
		},
	);

	test("ignores unrelated people, devices, and different canonical keys", async ({ f }) => {
		// Arrange
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		const old = await captured(reader, await collectInput(f));
		controller(f, { identity_id: "B", device_id: "unrelated", public_key: otherKey });
		invitation(f, { bound_device_id: "unrelated", bound_public_key: otherKey });
		await f.store.enrollDevice(signer.groupId, {
			deviceId: "unrelated",
			publicKey: otherKey,
			fingerprint: "f".repeat(64),
		});
		// Act
		const fresh = await captured(reader, await collectInput(f));
		const before = await digest(reader, old.recheckSnapshot);
		const after = await digest(reader, fresh.recheckSnapshot);
		// Assert
		expect(after).toBe(before);
	});

	test("includes canonical full history metadata even when owner labels stay unchanged", async ({
		f,
	}) => {
		// Arrange: a Team display change does not change any included-owner decision.
		history(f);
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		const old = await captured(reader, await collectInput(f));
		f.db
			.prepare(
				"UPDATE coordinator_legacy_team_completions SET manifest_json=replace(manifest_json,?,?)",
			)
			.run("Synthetic Team", "Renamed synthetic Team");
		// Act
		const fresh = await captured(reader, await collectInput(f));
		const before = await digest(reader, old.recheckSnapshot);
		const after = await digest(reader, fresh.recheckSnapshot);
		// Assert: hashing classification/weakLabels alone would miss this change.
		expect(fresh.weakLabels).toEqual(old.weakLabels);
		expect(after).not.toBe(before);
	});

	test("includes actual signer's raw public key even when canonical identity is unchanged", async ({
		f,
	}) => {
		// Arrange: raw current signer text is part of the reviewed subject, not a discovery hint.
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		const old = await captured(reader, await collectInput(f));
		const publicKey = `${signer.publicKey} synthetic-comment`;
		f.db
			.prepare("UPDATE enrolled_devices SET public_key=? WHERE device_id=?")
			.run(publicKey, signer.deviceId);
		const input = await collectInput(f);
		input.actualSigner.publicKey = publicKey;
		input.verifiedHistory = await f.store.captureAuthControllerLegacyHistory({
			coordinatorId: cfg.coordinatorId,
			...signer,
			publicKey,
		});
		// Act
		const fresh = await captured(reader, input);
		const before = await digest(reader, old.recheckSnapshot);
		const after = await digest(reader, fresh.recheckSnapshot);
		// Assert
		expect(await ed25519KeyIdForRevocation(publicKey)).toBe(EXPECTED_KEY_ID);
		expect(after).not.toBe(before);
	});

	test("valid Unicode/junk discovery false positives do not churn the human digest", async ({
		f,
	}) => {
		// Arrange: reuse accepted compatibility forms, then prove actual decoded identity.
		const falsePositiveKey = `\u2003${otherKey.replace(" ", "\u00a0!")}\u2003`;
		expect(await ed25519KeyIdForRevocation(falsePositiveKey)).toBe(
			await ed25519KeyIdForRevocation(otherKey),
		);
		expect(await ed25519KeyIdForRevocation(falsePositiveKey)).not.toBe(EXPECTED_KEY_ID);
		controller(f, { device_id: "other-device", public_key: falsePositiveKey, identity_id: "B" });
		const db = evidenceBackend(f, backend);
		const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
		const old = await captured(reader, await collectInput(f));
		const atomic = reader.prepareAtomicRecheck(old.recheckSnapshot);
		f.db
			.prepare(
				"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed-unrelated-receipt'",
			)
			.run();
		controller(f, {
			attestation_id: "another-false-positive",
			device_id: "another-device",
			public_key: falsePositiveKey,
			identity_id: "B",
		});
		invitation(f, { bound_device_id: "other-device", bound_public_key: falsePositiveKey });
		// Act
		const fresh = await captured(reader, await collectInput(f));
		expect(fresh.decision).toBe("compatible");
		expect(await db.first(atomic)).toEqual({ matches: 0 });
		const before = await digest(reader, old.recheckSnapshot);
		const after = await digest(reader, fresh.recheckSnapshot);
		// Assert: old atomic rowset pins remain strict, unlike the human semantic digest.
		expect(fresh.decision).toBe("compatible");
		expect(after).toBe(before);
		expect(await db.first(atomic)).toEqual({ matches: 0 });
	});

	test("equivalent validated schema spelling keeps digest but invalidates raw atomic catalog pin", async ({
		f,
	}) => {
		// Arrange: only an empty synthetic fixture table is recreated, never a live schema.
		const db = evidenceBackend(f, backend);
		const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
		const old = await captured(reader, await collectInput(f));
		const atomic = reader.prepareAtomicRecheck(old.recheckSnapshot);
		f.db.exec("DROP TABLE coordinator_legacy_owner_resolutions");
		f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL.replaceAll("\n", "\n  "));
		// Act
		const fresh = await captured(reader, await collectInput(f));
		expect(await db.first(atomic)).toEqual({ matches: 0 });
		const before = await digest(reader, old.recheckSnapshot);
		const after = await digest(reader, fresh.recheckSnapshot);
		// Assert
		expect(after).toBe(before);
		expect(await db.first(atomic)).toEqual({ matches: 0 });
	});
}
