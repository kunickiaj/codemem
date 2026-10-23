import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	cfg,
	controller,
	databaseSnapshot,
	evidenceBackend,
	evidenceTest,
	otherKey,
	signer,
	sourceRef,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { ACCEPTED_ALIASES } from "./coordinator-ed25519-key-id-test-fixtures.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	describe(`${backend}: verifies original controller source, not resolution authority`, () => {
		test.for(ACCEPTED_ALIASES)(
			"preserves original source text and canonical identity: $name",
			async (alias, { f }) => {
				// Arrange: source has no group/enrollment; requester uses a different representation.
				const original = controller(f, { public_key: alias.publicKey });
				const reference = sourceRef(original);
				const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
				const before = databaseSnapshot(f);
				// Act
				const result = await reader.verifyControllerSource({
					sourceRef: reference,
					expectedOwnerId: "A",
					actualSigner: signer,
				});
				// Assert: no resolution row, link, grant, or positive authority is required/created.
				expect(result).toMatchObject({ kind: "verified_controller_source" });
				expect(result).not.toHaveProperty("authority");
				expect(reference.source_public_key).toBe(alias.publicKey);
				expect(databaseSnapshot(f)).toEqual(before);
			},
		);

		test("missing stored source fails even when the reference is valid metadata", async ({ f }) => {
			// Arrange
			const reference = sourceRef(controller(f));
			f.db.prepare("DELETE FROM coordinator_auth_controller_attestations").run();
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.verifyControllerSource({
				sourceRef: reference,
				expectedOwnerId: "A",
				actualSigner: signer,
			});
			// Assert
			expect(result).toMatchObject({ kind: "source_missing" });
		});

		test("revoked source cannot positively verify", async ({ f }) => {
			// Arrange
			const reference = sourceRef(controller(f));
			f.db
				.prepare("UPDATE coordinator_auth_controller_attestations SET revoked_at=?")
				.run("2026-10-02T00:00:00.000Z");
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.verifyControllerSource({
				sourceRef: reference,
				expectedOwnerId: "A",
				actualSigner: signer,
			});
			// Assert
			expect(result).toMatchObject({ kind: "source_revoked" });
		});

		const mutations = [
			["identity_id", "B"],
			["group_id", "changed-group"],
			["device_id", "changed-device"],
			["public_key", `${signer.publicKey} different-stored-comment`],
			["fingerprint", "e".repeat(64)],
			["review_receipt_id", "different-receipt"],
			["evidence_digest", "e".repeat(64)],
			["enrollment_identity_id", null],
			["created_at", "2026-10-02T00:00:00.000Z"],
		] as const;
		test.for(mutations)(
			"pins original stored %s, even canonical equivalent text",
			async ([column, value], { f }) => {
				// Arrange: synthetic corruption of an existing historical row, not a normal writer.
				const reference = sourceRef(controller(f));
				f.db.prepare(`UPDATE coordinator_auth_controller_attestations SET ${column}=?`).run(value);
				const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
				// Act
				const result = await reader.verifyControllerSource({
					sourceRef: reference,
					expectedOwnerId: "A",
					actualSigner: signer,
				});
				// Assert
				expect(result).toMatchObject({ kind: "source_mismatch" });
			},
		);

		test.for([{ deviceId: "different-device" }, { publicKey: otherKey }])(
			"positive verification needs exact device AND canonical key: %j",
			async (patch, { f }) => {
				// Arrange
				const reference = sourceRef(controller(f));
				const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
				// Act
				const result = await reader.verifyControllerSource({
					sourceRef: reference,
					expectedOwnerId: "A",
					actualSigner: { ...signer, ...patch },
				});
				// Assert
				expect(result).toMatchObject({ kind: "source_mismatch" });
			},
		);

		test.for([
			{ source_controller_revision: 2 },
			{ key_id: "f".repeat(64) },
			{ owner_identity_id: "B" },
		])("malformed/inconsistent source metadata cannot verify: %j", async (patch, { f }) => {
			// Arrange
			const reference = { ...sourceRef(controller(f)), ...patch };
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.verifyControllerSource({
				sourceRef: reference,
				expectedOwnerId: "A",
				actualSigner: signer,
			});
			// Assert
			expect(result.kind).not.toBe("verified_controller_source");
		});

		test("another coordinator cannot supply an otherwise identical source", async ({ f }) => {
			// Arrange
			const reference = sourceRef(controller(f));
			f.db
				.prepare(
					"UPDATE coordinator_auth_controller_attestations SET coordinator_id='coordinator-b'",
				)
				.run();
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.verifyControllerSource({
				sourceRef: reference,
				expectedOwnerId: "A",
				actualSigner: signer,
			});
			// Assert
			expect(result).toMatchObject({ kind: "source_missing" });
		});
	});
}
