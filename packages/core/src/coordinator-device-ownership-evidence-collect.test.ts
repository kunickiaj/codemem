import { afterEach, beforeEach, expect, vi } from "vitest";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	binding,
	cfg,
	claim,
	collectInput,
	controller,
	databaseSnapshot,
	EXPECTED_KEY_ID,
	evidenceBackend,
	evidenceTest,
	history,
	insert,
	invitation,
	otherKey,
	type Row,
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
	test.for([
		{ matchingInvite: false, decision: "compatible" },
		{ matchingInvite: true, decision: "owner_transfer_required" },
	] as const)(
		`${backend}: filters a long-comment invite inventory before the row limit: $decision`,
		async ({ matchingInvite, decision }, { f }) => {
			// Arrange: valid consumed B invites exceed the 500-row limit but bind other devices/keys.
			const comment = `inventory-comment-${"x".repeat(2000)}`;
			f.db.transaction(() => {
				for (let index = 0; index < 650; index++) {
					invitation(f, {
						invite_id: `inventory-${String(index).padStart(3, "0")}`,
						token: `inventory-token-${index}`,
						bound_device_id: `inventory-device-${index}`,
						bound_public_key: `${otherKey} ${comment}`,
						bound_fingerprint: "f".repeat(64),
					});
				}
				if (matchingInvite) {
					// Last by insertion and invite ID: a pre-filter LIMIT must not hide this alias.
					invitation(f, {
						invite_id: "zz-inventory-target",
						token: "inventory-target-token",
						bound_device_id: "inventory-target-alias",
						bound_public_key: `${signer.publicKey} inventory-target-comment`,
					});
				}
			})();
			const db = evidenceBackend(f, backend);
			const reads = vi.spyOn(db, "all");
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			const input = await collectInput(f);
			// Act
			const result = await reader.collect(input);
			if (result.kind !== "collected") throw new Error("inventory collection rejected");
			const recheck = await db.first(await reader.prepareAtomicRecheck(result.recheckSnapshot));
			const returnedRows = await Promise.all(reads.mock.results.map(({ value }) => value));
			// Assert: irrelevant inventory never crosses the backend boundary; unchanged evidence matches.
			expect(result).toMatchObject({ kind: "collected", decision });
			expect(recheck).toEqual({ matches: 1 });
			expect(returnedRows.every((rows) => rows.length <= 500)).toBe(true);
			expect(JSON.stringify(returnedRows)).not.toContain(comment);
		},
	);

	test(`${backend}: stored resolution metadata cannot override a strong other-owner fact`, async ({
		f,
	}) => {
		// Arrange: parsed sidecar metadata is neither provenance nor authority.
		insert(f, "coordinator_legacy_owner_resolutions", sourceRef(controller(f)));
		binding(f);
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert
		expect(result).toMatchObject({ kind: "collected", decision: "owner_transfer_required" });
	});

	test(`${backend}: submitted author and label strings cannot prove ordinary enrollment C`, async ({
		f,
	}) => {
		// Arrange
		f.db.prepare("UPDATE enrolled_devices SET identity_id='C'").run();
		const input = { ...(await collectInput(f)), submittedAuthorId: "C", weakLabels: ["C"] };
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(input);
		// Assert
		expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
	});

	test(`${backend}: project actor provenance must bind the exact subject`, async ({ f }) => {
		// Arrange: a matching Project actor string for another person is not weak provenance.
		f.db.prepare("UPDATE enrolled_devices SET identity_id='C'").run();
		invitation(f, {
			invite_kind: "project_share",
			recipient_actor_id: "C",
			assigned_identity_id: null,
			bound_device_id: "unrelated",
			bound_public_key: otherKey,
			bound_fingerprint: "f".repeat(64),
		});
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert
		expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
	});
	test.for([null, "A"])("current enrollment %s has no contradiction", async (label, { f }) => {
		// Arrange
		f.db.prepare("UPDATE enrolled_devices SET identity_id=?").run(label);
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		const before = databaseSnapshot(f);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert
		expect(result).toMatchObject({ kind: "collected", decision: "compatible", weakLabels: [] });
		expect(result).not.toHaveProperty("authority");
		expect(result).not.toHaveProperty("authorized");
		expect(databaseSnapshot(f)).toEqual(before);
	});

	for (const source of ["binding", "claim", "controller"] as const) {
		for (const match of ["device", "canonical-key"] as const) {
			test(`${source} other owner blocks by ${match} without historical enrollment`, async ({
				f,
			}) => {
				// Arrange: fixture SQL simulates trusted stored births, not submitted assertions.
				let patch = {
					device_id: "retained-alias",
					key_id: EXPECTED_KEY_ID,
					public_key: signer.publicKey,
				};
				if (match === "device")
					patch = { device_id: signer.deviceId, key_id: "f".repeat(64), public_key: otherKey };
				const sources = {
					binding: () => binding(f, { device_id: patch.device_id, key_id: patch.key_id }),
					claim: () => claim(f, patch),
					controller: () =>
						controller(f, {
							identity_id: "B",
							device_id: patch.device_id,
							public_key: patch.public_key,
						}),
				};
				sources[source]();
				const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
				// Act
				const result = await reader.collect(await collectInput(f));
				// Assert
				expect(result).toMatchObject({ kind: "collected", decision: "owner_transfer_required" });
			});
		}
		test(`${source} same owner creates neither contradiction nor authority`, async ({ f }) => {
			// Arrange
			if (source === "binding") binding(f, { identity_id: "A" });
			if (source === "claim") claim(f, { identity_id: "A" });
			if (source === "controller") controller(f);
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.collect(await collectInput(f));
			// Assert
			expect(result).toMatchObject({ kind: "collected", decision: "compatible" });
			expect(result).not.toHaveProperty("authority");
		});
	}

	test.for(ACCEPTED_ALIASES)(
		"retained controller-only alias blocks: $name",
		async (alias, { f }) => {
			// Arrange: these key bytes exist in no historical enrollment.
			controller(f, {
				identity_id: "B",
				device_id: "removed-device",
				public_key: alias.publicKey,
			});
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.collect(await collectInput(f));
			// Assert
			expect(result).toMatchObject({ kind: "collected", decision: "owner_transfer_required" });
		},
	);

	test("sole alias enrollment removal cannot erase another owner's controller", async ({ f }) => {
		// Arrange
		await f.store.createGroup("retained-group");
		await f.store.enrollDevice("retained-group", {
			deviceId: "alias",
			publicKey: `${signer.publicKey} retained`,
			fingerprint: "e".repeat(64),
		});
		controller(f, {
			identity_id: "B",
			device_id: "alias",
			public_key: `${signer.publicKey} retained`,
			fingerprint: "e".repeat(64),
		});
		await f.store.removeDevice("retained-group", "alias");
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert
		expect(result).toMatchObject({ kind: "collected", decision: "owner_transfer_required" });
	});

	test("ownership bindings are global across coordinator namespaces", async ({ f }) => {
		// Arrange
		binding(f, { coordinator_id: "coordinator-b", device_id: "alias" });
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert
		expect(result).toMatchObject({ kind: "collected", decision: "owner_transfer_required" });
	});

	test("same controller ID in another coordinator contributes no proof or snapshot rows", async ({
		f,
	}) => {
		// Arrange: controller IDs are unique only within their coordinator namespace.
		controller(f);
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		const input = await collectInput(f);
		const local = await reader.collect(input);
		if (local.kind !== "collected") throw new Error("collection fixture rejected");
		controller(f, { coordinator_id: "coordinator-b", identity_id: "B" });
		const before = databaseSnapshot(f);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert: a valid foreign B controller must not become current-coordinator proof.
		expect(result).toMatchObject({ kind: "collected", decision: "compatible" });
		expect(result).toEqual(local);
		expect(databaseSnapshot(f)).toEqual(before);
	});

	test("other-coordinator claims/controllers and unrelated people do not conflict", async ({
		f,
	}) => {
		// Arrange
		claim(f, { coordinator_id: "coordinator-b" });
		controller(f, { coordinator_id: "coordinator-b", identity_id: "B" });
		controller(f, {
			attestation_id: "unrelated",
			review_receipt_id: "unrelated",
			identity_id: "B",
			device_id: "unrelated",
			public_key: otherKey,
		});
		binding(f, { device_id: "unrelated", key_id: "f".repeat(64) });
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert
		expect(result).toMatchObject({ kind: "collected", decision: "compatible" });
	});

	for (const kind of ["team_member", "add_device"] as const) {
		test.for(ACCEPTED_ALIASES)(
			`${kind} consumed-before-revocation invite-only alias survives expiry: $name`,
			async (alias, { f }) => {
				// Arrange: discover aliases from invites, not only enrollment/controller tables.
				invitation(f, {
					invite_kind: kind,
					bound_device_id: "invite-only",
					bound_public_key: alias.publicKey,
					assigned_identity_id: kind === "team_member" ? "B" : null,
					target_identity_id: kind === "add_device" ? "B" : null,
				});
				const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
				// Act
				const result = await reader.collect(await collectInput(f));
				// Assert
				expect(result).toMatchObject({ kind: "collected", decision: "owner_transfer_required" });
				expect(JSON.stringify(result)).not.toContain("synthetic-token-do-not-capture");
			},
		);
	}

	test.for<Row>([
		{ assigned_identity_id: "A", recipient_actor_id: "A" },
		{ bound_device_id: "unrelated", bound_public_key: otherKey },
		{ consumed_at: null, bound_device_id: null, bound_public_key: null, bound_fingerprint: null },
	])(
		"same-owner/unrelated/unconsumed invite is not other-owner proof: %j",
		async (patch, { f }) => {
			// Arrange
			invitation(f, patch);
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.collect(await collectInput(f));
			// Assert
			expect(result).toMatchObject({ kind: "collected", decision: "compatible" });
		},
	);

	test("canonical included history makes C weak metadata, not strong owner proof", async ({
		f,
	}) => {
		// Arrange
		history(f);
		f.db.prepare("UPDATE enrolled_devices SET identity_id='C'").run();
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert
		expect(result).toMatchObject({
			kind: "collected",
			decision: "weak_label_review_required",
			weakLabels: [
				expect.objectContaining({
					label: "C",
					kind: "legacy_included_owner_label",
					group_id: "historical-group",
					device_id: signer.deviceId,
					effect: "account_owner_display_only",
				}),
			],
		});
	});

	test("consumed project_share recipient_actor_id is weak metadata only", async ({ f }) => {
		// Arrange
		invitation(f, {
			invite_kind: "project_share",
			assigned_identity_id: null,
			recipient_actor_id: "C",
		});
		f.db.prepare("UPDATE enrolled_devices SET identity_id='C'").run();
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert
		expect(result).toMatchObject({
			kind: "collected",
			decision: "weak_label_review_required",
			weakLabels: [
				expect.objectContaining({
					label: "C",
					kind: "consumed_project_actor_label",
					group_id: signer.groupId,
					device_id: signer.deviceId,
					effect: "account_owner_display_only",
				}),
			],
		});
	});

	test.for(["none", "excluded", "other-subject", "unconsumed-project"])(
		"C without real weak provenance is unavailable: %s",
		async (provenance, { f }) => {
			// Arrange: enrollment and matching strings are not provenance.
			f.db.prepare("UPDATE enrolled_devices SET identity_id='C'").run();
			if (provenance === "excluded") history(f, { decision: "excluded" });
			if (provenance === "other-subject")
				history(f, { deviceId: "unrelated", fingerprint: "f".repeat(64) });
			if (provenance === "unconsumed-project")
				invitation(f, {
					invite_kind: "project_share",
					assigned_identity_id: null,
					recipient_actor_id: "C",
					consumed_at: null,
				});
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.collect(await collectInput(f));
			// Assert
			expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
		},
	);

	test("strong contradiction wins over valid weak history and source revocation", async ({ f }) => {
		// Arrange
		history(f);
		controller(f, { identity_id: "B", revoked_at: "2026-10-02T00:00:00.000Z" });
		const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
		// Act
		const result = await reader.collect(await collectInput(f));
		// Assert: revocation does not release retained ownership to another person.
		expect(result).toMatchObject({ kind: "collected", decision: "owner_transfer_required" });
	});

	test.for(["device_id", "ed25519_key"])(
		"reports current %s revocation without writes",
		async (kind, { f }) => {
			// Arrange: exact tombstone schema; no external revocation operation.
			insert(f, "coordinator_device_revocations", {
				subject_kind: kind,
				subject_value: kind === "device_id" ? signer.deviceId : EXPECTED_KEY_ID,
				revocation_id: "revoked",
				evidence_group_id: signer.groupId,
				evidence_device_id: signer.deviceId,
				evidence_public_key: signer.publicKey,
				evidence_fingerprint: signer.fingerprint,
				created_at: "2026-10-02T00:00:00.000Z",
			});
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			const before = databaseSnapshot(f);
			// Act
			const result = await reader.collect(await collectInput(f));
			// Assert
			expect(result).toMatchObject({ kind: "collected", decision: "device_revoked" });
			expect(databaseSnapshot(f)).toEqual(before);
		},
	);

	test.for(["groupId", "deviceId", "publicKey", "fingerprint"] as const)(
		"requires exact actual signer %s",
		async (field, { f }) => {
			// Arrange
			const input = await collectInput(f);
			input.actualSigner[field] = "not-the-current-signer";
			const reader = new CoordinatorDeviceOwnershipEvidence(evidenceBackend(f, backend), cfg);
			// Act
			const result = await reader.collect(input);
			// Assert
			expect(result).toMatchObject({ kind: "unavailable", authorizationUnavailable: true });
		},
	);
}
