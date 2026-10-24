import { expect } from "vitest";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";
import {
	controllerTable,
	resolutionTable,
	revoke,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { OwnerResolutionReviewOperations } from "./coordinator-owner-resolution-review.js";
import {
	deterministicReviewTests,
	expectSafeDto,
	projectLabel,
	scope,
	selection,
	setupReview,
	signer,
} from "./coordinator-owner-resolution-review-test-fixtures.js";

deterministicReviewTests();
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} previews proved weak C and Project labels with complete history, no persisted fact or authority`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setupReview(f, kind);
		projectLabel(f);
		const before = snapshot(f);
		// Act
		const result = await new OwnerResolutionReviewOperations(
			h.backend,
			() => NOW,
		).previewOwnerResolutionReview(selection, f.cfg);
		const ordinary = await f.store.readAccountOwnerTarget(
			{ targetIdentityId: selection.identityId, signer },
			f.cfg,
		);
		// Assert: scope is a description, not a credential or an enrollment rewrite.
		expect(result).toMatchObject({
			purpose: "existing_account_owner",
			resolution_scope: scope,
			state: "ready",
			reasons: [],
			coordinator_id: f.cfg.coordinatorId,
			group_id: selection.groupId,
			device_id: selection.deviceId,
			identity_id: selection.identityId,
			fingerprint: selection.fingerprint,
			owner_resolution_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
			account_owner_target: {
				identity_id: "identity-a",
				link_id: "claim-a",
				auth_config_revision: f.cfg.revision,
				created_at_ms: NOW,
			},
		});
		const history = f.db
			.prepare("SELECT manifest_json FROM coordinator_legacy_team_completions")
			.get() as { manifest_json: string };
		expect(result.legacy_history).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					group_id: "history-c",
					manifest: JSON.parse(history.manifest_json),
				}),
			]),
		);
		expect(JSON.stringify(result.reviewed_weak_labels)).toContain("identity-c");
		expect(JSON.stringify(result.reviewed_weak_labels)).toContain("identity-project");
		expect(result).not.toHaveProperty("owner_resolution");
		expect(result).not.toHaveProperty("recovery_receipt");
		expect(ordinary).toEqual({ kind: "unavailable" });
		expectSafeDto(result);
		expect(snapshot(f)).toEqual(before);
		expect(h.batchCount()).toBe(0);
		for (const table of [controllerTable, resolutionTable])
			expect(f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
	});
	for (const subject of ["device_id", "ed25519_key"] as const) {
		test(`${kind} retiring OTHER origin ${subject} does not revoke selected account A`, async ({
			fixture: f,
		}) => {
			// Arrange
			const h = await setupReview(f, kind);
			await revoke(f, subject, true);
			const before = snapshot(f);
			// Act
			const result = await new OwnerResolutionReviewOperations(
				h.backend,
			).previewOwnerResolutionReview(selection, f.cfg);
			// Assert
			expect(result).toMatchObject({
				state: "ready",
				reasons: [],
				owner_resolution_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			expect(snapshot(f)).toEqual(before);
		});
	}
	const denials: Record<string, (f: LinkFixture) => void | Promise<void>> = {
		"missing A connection": (f) => {
			f.db.exec("DELETE FROM coordinator_auth_account_links");
		},
		"invalid A birth proof": (f) => {
			f.db.exec("UPDATE coordinator_auth_link_attempts SET account_subject='wrong-subject'");
		},
		"revoked A connection": (f) => {
			f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=?").run(NOW + 1);
		},
		"disabled current enrollment": (f) => {
			f.db.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?").run(signer.deviceId);
		},
		"archived current group": (f) => {
			f.db.prepare("UPDATE groups SET archived_at='archived' WHERE group_id=?").run(signer.groupId);
		},
		"malformed stored current key": (f) => {
			f.db
				.prepare("UPDATE enrolled_devices SET public_key='invalid' WHERE device_id=?")
				.run(signer.deviceId);
		},
		"unclassified current label": (f) => {
			f.db
				.prepare("UPDATE enrolled_devices SET identity_id='unproved-owner' WHERE device_id=?")
				.run(signer.deviceId);
		},
		"globally revoked current key": (f) => revoke(f, "ed25519_key"),
		"strong B controller": async (f) => {
			await f.store.createGroup("strong-source");
			await f.store.enrollDevice("strong-source", signer);
			expect(
				await f.store.createAuthControllerAttestation(
					review({ ...signer, groupId: "strong-source", identityId: "identity-b" }),
				),
			).toMatchObject({ kind: "created" });
		},
	};
	for (const [name, mutate] of Object.entries(denials)) {
		test(`${kind} denies ${name} without minting either receipt`, async ({ fixture: f }) => {
			// Arrange
			const h = await setupReview(f, kind);
			await mutate(f);
			const before = snapshot(f);
			// Act
			const result = await new OwnerResolutionReviewOperations(
				h.backend,
			).previewOwnerResolutionReview(selection, f.cfg);
			// Assert
			expect(result.state).toBe("needs_review");
			expect(result.reasons.length).toBeGreaterThan(0);
			expect(result).not.toHaveProperty("owner_resolution_digest");
			expectSafeDto(result);
			expect(snapshot(f)).toEqual(before);
			expect(h.batchCount()).toBe(0);
		});
	}
	for (const config of [
		{ enabled: false },
		{ coordinatorId: "wrong-coordinator" },
		{ issuer: "https://wrong.example.test" },
	]) {
		test(`${kind} rejects trusted-config mismatch ${JSON.stringify(config)}`, async ({
			fixture: f,
		}) => {
			// Arrange
			const h = await setupReview(f, kind);
			const before = snapshot(f);
			// Act
			const result = await new OwnerResolutionReviewOperations(
				h.backend,
			).previewOwnerResolutionReview(selection, { ...f.cfg, ...config });
			// Assert
			expect(result.state).toBe("needs_review");
			expect(result).not.toHaveProperty("owner_resolution_digest");
			expect(snapshot(f)).toEqual(before);
		});
	}
	for (const missing of ["table", "trigger"] as const) {
		test(`${kind} ${missing} missing requires operator upgrade and never installs DDL`, async ({
			fixture: f,
		}) => {
			// Arrange: mutate only the isolated fixture schema.
			const h = await setupReview(f, kind);
			f.db.exec(
				missing === "table"
					? "DROP TABLE coordinator_legacy_owner_resolutions"
					: "DROP TRIGGER legacy_owner_resolution_immutable_update",
			);
			const before = snapshot(f);
			const schema = f.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
			// Act
			const result = await new OwnerResolutionReviewOperations(
				h.backend,
			).previewOwnerResolutionReview(selection, f.cfg);
			// Assert
			expect(result.state).toBe("needs_review");
			expect(result.reasons.join(" ")).toMatch(/upgrade/);
			expect(result).not.toHaveProperty("owner_resolution_digest");
			expect(snapshot(f)).toEqual(before);
			expect(f.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
		});
	}
	for (const changes of [
		{ fingerprint: "f".repeat(64) },
		{ identityId: "unknown-owner" },
		{ groupId: "unknown-group" },
		{ deviceId: "unknown-device" },
	]) {
		test(`${kind} selection must match actual current subject ${JSON.stringify(changes)}`, async ({
			fixture: f,
		}) => {
			// Arrange
			const h = await setupReview(f, kind);
			const before = snapshot(f);
			// Act
			const result = await new OwnerResolutionReviewOperations(
				h.backend,
			).previewOwnerResolutionReview({ ...selection, ...changes }, f.cfg);
			// Assert
			expect(result.state).toBe("needs_review");
			expect(result).not.toHaveProperty("owner_resolution_digest");
			expect(snapshot(f)).toEqual(before);
		});
	}
}
