import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
	beforeControllerWrite,
	ordinaryReview,
	resolutionTable,
	retainedResolution,
} from "./coordinator-auth-controller-consistency-test-fixtures.js";
import { enroll, review } from "./coordinator-auth-store-test-fixtures.js";
import {
	binding,
	claim,
	controller,
	databaseSnapshot,
	evidenceTest,
	history,
	insert,
	invitation,
	otherKey,
	signer,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { ACCEPTED_ALIASES, EXPECTED_KEY_ID } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	describe(`${backend}: ordinary controller owner consistency`, () => {
		test("accepts legacy creation without installing the absent resolution schema", async ({
			f,
		}) => {
			// Arrange: this is an old deployment, not a partial upgrade.
			f.db.exec(`DROP TABLE ${resolutionTable}`);
			const input = await ordinaryReview(f);
			const before = databaseSnapshot(f);
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			// Assert
			expect(result).toMatchObject({ kind: "created", attestation: { identity_id: "A" } });
			expect(
				databaseSnapshot(f).filter(([name]) => name !== "coordinator_auth_controller_attestations"),
			).toEqual(before.filter(([name]) => name !== "coordinator_auth_controller_attestations"));
		});

		test("accepts the same owner with retained provenance and preserves exact retry", async ({
			f,
		}) => {
			// Arrange: the original source's group and enrollment are already absent.
			const retained = retainedResolution(f);
			const input = await ordinaryReview(f);
			const before = databaseSnapshot(f);
			// Act
			const created = await f.store.createAuthControllerAttestation(input);
			const retry = await f.store.createAuthControllerAttestation(input);
			// Assert: metadata is never rewritten and no second resolution is produced.
			expect(created.kind).toBe("created");
			expect(retry).toEqual({
				kind: "existing",
				attestation: created.kind === "created" ? created.attestation : null,
			});
			expect(f.db.prepare(`SELECT * FROM ${resolutionTable}`).all()).toEqual([retained.resolution]);
			expect(
				f.db
					.prepare(
						"SELECT * FROM coordinator_auth_controller_attestations WHERE attestation_id='controller-a'",
					)
					.get(),
			).toEqual(retained.source);
			expect(
				databaseSnapshot(f).filter(([name]) => name !== "coordinator_auth_controller_attestations"),
			).toEqual(before.filter(([name]) => name !== "coordinator_auth_controller_attestations"));
		});
	});
	describe(`${backend}: retained owner collisions`, () => {
		for (const identityId of ["B", "C"]) {
			test.for(["device", "key", "both"] as const)(
				`rejects new owner ${identityId} on retained owner A's %s collision`,
				async (collision, { f }) => {
					// Arrange: null current label and no historical completions allow ordinary review.
					retainedResolution(f);
					const subject = { ...signer };
					if (collision === "device") subject.publicKey = otherKey;
					if (collision === "key") subject.deviceId = "different-device";
					await enroll(f.store, review(subject));
					const input = await ordinaryReview(f, { ...subject, identityId });
					const before = databaseSnapshot(f);
					// Act
					const result = await f.store.createAuthControllerAttestation(input);
					// Assert: device OR canonical key is a negative fact, not an AND match.
					expect(result).toMatchObject({ kind: "rejected" });
					expect(databaseSnapshot(f)).toEqual(before);
				},
			);
		}

		test.for(ACCEPTED_ALIASES)(
			"rejects key-only collision through source alias $name",
			async ({ publicKey }, { f }) => {
				// Arrange: only the canonical identity connects these differently named devices.
				retainedResolution(f, { public_key: publicKey });
				const subject = { ...signer, deviceId: "alias-device" };
				await enroll(f.store, review(subject));
				const input = await ordinaryReview(f, { ...subject, identityId: "B" });
				const before = databaseSnapshot(f);
				// Act
				const result = await f.store.createAuthControllerAttestation(input);
				// Assert
				expect(result).toMatchObject({ kind: "rejected" });
				expect(databaseSnapshot(f)).toEqual(before);
			},
		);

		test.for(ACCEPTED_ALIASES)(
			"accepts independently reviewed owner A through source alias $name",
			async ({ publicKey }, { f }) => {
				// Arrange: the retained key representation never grants authority by itself.
				retainedResolution(f, { public_key: publicKey });
				const input = await ordinaryReview(f);
				// Act
				const result = await f.store.createAuthControllerAttestation(input);
				// Assert
				expect(result).toMatchObject({ kind: "created", attestation: { identity_id: "A" } });
			},
		);
	});
	describe(`${backend}: schema and source validation`, () => {
		test("does not import another coordinator's retained owner collision", async ({ f }) => {
			// Arrange: negative facts remain scoped to their coordinator namespace.
			retainedResolution(f, { coordinator_id: "coordinator-foreign", identity_id: "B" });
			const input = await ordinaryReview(f);
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			// Assert
			expect(result).toMatchObject({ kind: "created", attestation: { identity_id: "A" } });
		});

		test.for(["missing index", "extra trigger", "partial table"] as const)(
			"fails closed on %s",
			async (change, { f }) => {
				// Arrange
				if (change === "missing index") f.db.exec("DROP INDEX idx_legacy_owner_resolutions_key");
				if (change === "extra trigger")
					f.db.exec(
						`CREATE TRIGGER extra_resolution_trigger AFTER INSERT ON ${resolutionTable} BEGIN SELECT 1; END`,
					);
				if (change === "partial table")
					f.db.exec(
						`DROP TABLE ${resolutionTable}; CREATE TABLE ${resolutionTable} (device_id TEXT)`,
					);
				const input = await ordinaryReview(f);
				const before = databaseSnapshot(f);
				// Act
				const result = await f.store.createAuthControllerAttestation(input);
				// Assert: unsupported schema is not equivalent to no schema.
				expect(result).toMatchObject({ kind: "rejected" });
				expect(databaseSnapshot(f)).toEqual(before);
			},
		);

		test.for(["missing", "revoked", "receipt mismatch", "invalid metadata"] as const)(
			"same-owner metadata never bypasses %s provenance",
			async (change, { f }) => {
				// Arrange
				retainedResolution(
					f,
					{},
					change === "invalid metadata" ? { created_at: "not-a-timestamp" } : {},
				);
				if (change === "missing") f.db.exec("DELETE FROM coordinator_auth_controller_attestations");
				if (change === "revoked")
					f.db.exec(
						"UPDATE coordinator_auth_controller_attestations SET revoked_at='2026-10-22T00:00:00.000Z'",
					);
				if (change === "receipt mismatch")
					f.db.exec(
						"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed-receipt'",
					);
				const input = await ordinaryReview(f);
				const before = databaseSnapshot(f);
				// Act
				const result = await f.store.createAuthControllerAttestation(input);
				// Assert
				expect(result).toMatchObject({ kind: "rejected" });
				expect(databaseSnapshot(f)).toEqual(before);
			},
		);
	});
	describe(`${backend}: ordinary authority controls`, () => {
		test.for([
			"other owner binding",
			"other owner claim",
			"other owner controller",
			"other owner invite",
			"unknown controller",
			"ordinary owner label",
			"stale history",
			"disabled",
			"archived",
			"device revocation",
			"key revocation",
		] as const)("same-owner resolution cannot bypass %s", async (change, { f }) => {
			// Arrange: these remain ordinary denials, never positive resolution authority.
			retainedResolution(f);
			const controls = {
				"other owner binding": () => binding(f),
				"other owner claim": () => claim(f),
				"other owner controller": () =>
					controller(f, {
						attestation_id: "other-owner-controller",
						group_id: "other-owner-group",
						review_receipt_id: "other-owner-receipt",
						identity_id: "B",
					}),
				"other owner invite": () => invitation(f, { revoked_at: null }),
				"unknown controller": () =>
					controller(f, {
						attestation_id: "unknown-source",
						group_id: "unknown-source-group",
						review_receipt_id: "unknown-receipt",
						public_key: "ssh-ed25519 $$$$",
					}),
				"ordinary owner label": () => f.db.exec("UPDATE enrolled_devices SET identity_id='B'"),
				"stale history": () => {},
				disabled: () => f.store.setDeviceEnabled(signer.groupId, signer.deviceId, false),
				archived: () => f.store.archiveGroup(signer.groupId),
				"device revocation": () => revokeSubject("device_id", signer.deviceId),
				"key revocation": () => revokeSubject("ed25519_key", EXPECTED_KEY_ID),
			};
			function revokeSubject(kind: string, value: string) {
				insert(f, "coordinator_device_revocations", {
					subject_kind: kind,
					subject_value: value,
					revocation_id: "synthetic-revocation",
					evidence_group_id: signer.groupId,
					evidence_device_id: signer.deviceId,
					evidence_public_key: signer.publicKey,
					evidence_fingerprint: signer.fingerprint,
					created_at: "2026-10-22T00:00:00.000Z",
				});
			}
			await controls[change]();
			const input = await ordinaryReview(f);
			if (change === "stale history") history(f);
			const before = databaseSnapshot(f);
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			// Assert
			expect(result).toMatchObject({ kind: "rejected" });
			expect(databaseSnapshot(f)).toEqual(before);
		});
	});
	describe(`${backend}: atomic winning write`, () => {
		test("accepts an unchanged capture at the real winning write", async ({ f }) => {
			// Arrange: the race wrapper itself must not turn valid reviews into denials.
			retainedResolution(f);
			const input = await ordinaryReview(f);
			const race = beforeControllerWrite(f, () => {});
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			race.restore();
			// Assert
			expect(race.afterChange()).toBeDefined();
			expect(result).toMatchObject({ kind: "created" });
		});

		test.for([
			"missing becomes ready",
			"missing becomes partial",
			"source revoked",
			"source receipt",
			"new binding",
			"new claim",
			"schema changed",
			"new history",
		] as const)("pins %s at the winning backend write", async (change, { f }) => {
			// Arrange: changes occur after review capture, not in an application preflight.
			if (change.startsWith("missing")) f.db.exec(`DROP TABLE ${resolutionTable}`);
			else retainedResolution(f);
			const input = await ordinaryReview(f);
			const race = beforeControllerWrite(f, () => {
				const changes = {
					"missing becomes ready": () => f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
					"missing becomes partial": () =>
						f.db.exec(`CREATE TABLE ${resolutionTable} (device_id TEXT)`),
					"source revoked": () =>
						f.db.exec(
							"UPDATE coordinator_auth_controller_attestations SET revoked_at='2026-10-22T00:00:00.000Z'",
						),
					"source receipt": () =>
						f.db.exec(
							"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed-at-write'",
						),
					"new binding": () => binding(f),
					"new claim": () => claim(f),
					"schema changed": () =>
						f.db.exec(
							`CREATE TRIGGER late_resolution_trigger AFTER INSERT ON ${resolutionTable} BEGIN SELECT 1; END`,
						),
					"new history": () => history(f),
				};
				changes[change]();
			});
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			race.restore();
			// Assert: only the injected external change survives; producer writes nothing.
			expect(race.afterChange()).toBeDefined();
			expect(result).toMatchObject({ kind: "rejected" });
			expect(databaseSnapshot(f)).toEqual(race.afterChange());
		});
	});
}
