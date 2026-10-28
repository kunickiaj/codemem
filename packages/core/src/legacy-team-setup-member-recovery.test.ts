import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_ACCOUNT_PROFILE_SCHEMA_SQL } from "./coordinator-auth-account-profile-contract.js";
import {
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
	AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
} from "./coordinator-auth-lifecycle-schema.js";
import { COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL } from "./coordinator-device-ownership-schema.js";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { discoverLegacyTeamCandidates } from "./legacy-team-candidate.js";
import {
	applyLegacyTeamSetupCompletionManifest,
	deriveLegacyTeamSetupCompletionManifest,
	legacyTeamSetupCompletionActorIds,
	reconstructLegacyTeamSetupCompletionManifest,
} from "./legacy-team-setup-completion-manifest.js";
import {
	getLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "./legacy-team-setup-draft.js";
import { legacyTeamCandidateId, legacyTeamDeviceRef } from "./recipient-policy-identifiers.js";
import { claimRecipientPolicyActorMutations } from "./recipient-policy-team-metadata.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-09-01T12:00:00.000Z";
const COORDINATOR = "https://coordinator.example.invalid";
const GROUP = "group-recovery";
const CANDIDATE = legacyTeamCandidateId(COORDINATOR, GROUP);
const ROSTER = ["a", "b", "c", "excluded"].map((suffix, index) => ({
	deviceId: `device-${suffix}`,
	fingerprint: String(index + 1).repeat(64),
	displayName: `Laptop ${suffix}`,
	enabled: true,
}));
type Db = InstanceType<typeof Database>;

function addActor(db: Db, id: string, name = "Existing person", local = 0) {
	db.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
	 VALUES (?, ?, ?, 'active', ?, ?)`).run(id, name, local, NOW, NOW);
}

function createDb() {
	const db = new Database(":memory:");
	initTestSchema(db);
	db.exec(COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL);
	db.exec(AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL);
	db.exec(AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL);
	db.exec(AUTH_ACCOUNT_PROFILE_SCHEMA_SQL);
	addActor(db, "identity-a", "Self", 1);
	return db;
}

function discover(db: Db, deviceId = "device-a") {
	return discoverLegacyTeamCandidates(db, {
		projection: { localActorId: "identity-a", localDeviceId: deviceId },
		groups: [
			{ coordinatorId: COORDINATOR, groupId: GROUP, displayName: "Recovery Team", devices: ROSTER },
		],
		now: NOW,
	});
}

function reviewedManifest(db: Db, options: { legacyEvidence?: boolean } = {}) {
	discover(db);
	let draft = getLegacyTeamSetupDraft(db, CANDIDATE);
	if (!draft) throw new Error("Missing source draft");
	for (const device of draft.devices) {
		const rosterDevice = ROSTER.find(
			(row) => legacyTeamDeviceRef(CANDIDATE, row.deviceId) === device.deviceRef,
		);
		if (!rosterDevice) throw new Error("Missing source roster device");
		const suffix = rosterDevice.deviceId.replace("device-", "");
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: `identity-${suffix}`,
			expectation: device.expectation,
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: suffix === "excluded" ? "excluded" : "included",
			now: NOW,
		});
	}
	// Preserve the uploader's self evidence and every remote label.
	db.prepare(`UPDATE legacy_team_setup_draft_devices SET identity_evidence = CASE
	 WHEN device_id = 'device-a' THEN 'self' ELSE 'label' END
	 WHERE attempt_id = ?`).run(draft.attemptId);
	if (options.legacyEvidence)
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET identity_evidence = NULL WHERE attempt_id = ?",
		).run(draft.attemptId);
	return deriveLegacyTeamSetupCompletionManifest(db, {
		candidateRef: CANDIDATE,
		attemptId: draft.attemptId,
		completedAt: NOW,
	});
}

function actors(db: Db) {
	return db.prepare("SELECT * FROM actors ORDER BY actor_id").all();
}

function recoveryState(db: Db) {
	return [
		"actors",
		"policy_teams",
		"policy_team_memberships",
		"legacy_team_setup_drafts",
		"legacy_team_setup_draft_devices",
		"identity_devices",
		"legacy_team_setup_completions",
	].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

function ownershipState(db: Db) {
	return [
		"coordinator_device_ownership_bindings",
		"coordinator_auth_account_associations",
		"coordinator_auth_account_links",
		"coordinator_auth_account_profiles",
	].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

let source: Db;
let target: Db;
let manifest: CoordinatorLegacyTeamCompletionManifestV1;
const apply = (db: Db, overrides = {}) =>
	applyLegacyTeamSetupCompletionManifest(db, {
		coordinatorId: COORDINATOR,
		groupId: GROUP,
		freshRoster: ROSTER,
		manifest,
		...overrides,
	});

beforeEach(async () => {
	source = createDb();
	target = createDb();
	for (const suffix of ["b", "c", "excluded"]) addActor(source, `identity-${suffix}`);
	manifest = reviewedManifest(source);
	await apply(source);
	expect(discover(source)[0]?.status).toBe("ready");
	discover(target, "device-fresh");
});
afterEach(() => {
	source.close();
	target.close();
});

describe("canonical Team member recovery", () => {
	it("recovers exact remote IDs without substituting same-name actors and replays unchanged", async () => {
		// Arrange: the target has only self and an unrelated actor with the placeholder name.
		addActor(target, "unrelated", "Team member");
		const existing = actors(target);
		const ownership = ownershipState(target);
		// Act: import a genuinely completed source manifest, then replay it.
		await apply(target);
		const recovered = actors(target);
		await apply(target);
		// Assert: recovery creates remote placeholders, not ownership or account authority.
		expect(actors(target)).toEqual(recovered);
		for (const row of existing) expect(recovered).toContainEqual(row);
		for (const id of ["identity-b", "identity-c"]) {
			expect(recovered).toContainEqual(
				expect.objectContaining({
					actor_id: id,
					display_name: "Team member",
					is_local: 0,
					status: "active",
					merged_into_actor_id: null,
				}),
			);
		}
		expect(recovered).not.toContainEqual(
			expect.objectContaining({ actor_id: "identity-excluded" }),
		);
		expect(
			target
				.prepare("SELECT identity_id FROM policy_team_memberships ORDER BY identity_id")
				.pluck()
				.all(),
		).toEqual(["identity-a", "identity-b", "identity-c"]);
		expect(ownershipState(target)).toEqual(ownership);
		expect(
			reconstructLegacyTeamSetupCompletionManifest(target, { candidateRef: CANDIDATE })
				.device_decisions,
		).toEqual(manifest.device_decisions);
		expect(discover(target, "device-fresh")[0]?.status).toBe("ready");
	});

	it("preserves all fields of an existing named remote actor and local self", async () => {
		// Arrange.
		addActor(target, "identity-b", "Named teammate");
		const before = actors(target);
		// Act.
		await apply(target);
		// Assert.
		for (const row of before) expect(actors(target)).toContainEqual(row);
	});

	it("preserves absent evidence in a pre-evidence canonical manifest", async () => {
		// Arrange: legacy manifests omit evidence for every included device.
		source.close();
		source = createDb();
		for (const suffix of ["b", "c", "excluded"]) addActor(source, `identity-${suffix}`);
		manifest = reviewedManifest(source, { legacyEvidence: true });
		await apply(source);
		const ownership = ownershipState(target);
		// Act.
		await apply(target);
		// Assert.
		const reconstructed = reconstructLegacyTeamSetupCompletionManifest(target, {
			candidateRef: CANDIDATE,
		});
		expect(reconstructed.device_decisions).toEqual(manifest.device_decisions);
		for (const decision of reconstructed.device_decisions)
			expect(decision).not.toHaveProperty("identity_evidence");
		expect(ownershipState(target)).toEqual(ownership);
	});
});

describe("canonical Team member recovery rollback", () => {
	it.each(["inactive", "merged"])(
		"rejects an existing %s actor without reviving it or retaining other stubs",
		async (state) => {
			// Arrange: c is still absent, so activation failure must undo its insertion.
			addActor(target, "identity-b", "Do not revive");
			if (state === "inactive")
				target.prepare("UPDATE actors SET status = 'inactive' WHERE actor_id = 'identity-b'").run();
			else
				target
					.prepare(
						"UPDATE actors SET merged_into_actor_id = 'identity-a' WHERE actor_id = 'identity-b'",
					)
					.run();
			const before = recoveryState(target);
			// Act.
			const result = apply(target);
			// Assert.
			await expect(result).rejects.toMatchObject({ code: "team_setup_conflict" });
			expect(recoveryState(target)).toEqual(before);
		},
	);

	it.each(["digest", "binding", "disabled", "missing", "rekeyed"])(
		"does not create actors with invalid %s evidence",
		async (fault) => {
			// Arrange.
			const before = recoveryState(target);
			const invalid = structuredClone(manifest);
			let freshRoster = ROSTER;
			if (fault === "digest") invalid.finish_digest = "0".repeat(64);
			if (fault === "binding") invalid.group_id = "another-group";
			if (fault === "missing")
				freshRoster = ROSTER.filter((device) => device.deviceId !== "device-b");
			if (fault === "disabled")
				freshRoster = ROSTER.map((device) => ({ ...device, enabled: false }));
			if (fault === "rekeyed")
				freshRoster = ROSTER.map((device) => ({ ...device, fingerprint: "f".repeat(64) }));
			// Act.
			const result = apply(target, { manifest: invalid, freshRoster });
			// Assert.
			await expect(result).rejects.toMatchObject({ code: "team_setup_completion_invalid" });
			expect(recoveryState(target)).toEqual(before);
		},
	);

	it("rolls actor insertion and draft rewriting back after a late activation failure", async () => {
		// Arrange: the trigger fails after activation has inserted Team policy.
		target.exec(`CREATE TRIGGER reject_completion BEFORE INSERT ON legacy_team_setup_completions
		 BEGIN SELECT RAISE(ABORT, 'test late activation failure'); END`);
		const before = recoveryState(target);
		// Act.
		const result = apply(target);
		// Assert.
		await expect(result).rejects.toMatchObject({ code: "team_setup_failed" });
		expect(recoveryState(target)).toEqual(before);
	});
});

describe("canonical Team member exact replay lifecycle", () => {
	it.each(["inactive", "merged", "absent"])(
		"does not revive or recreate an %s teammate during an exact completed replay",
		async (state) => {
			// Arrange: canonical activation succeeded before the teammate changed locally.
			await apply(target);
			if (state === "inactive") {
				target.prepare("UPDATE actors SET status = 'inactive' WHERE actor_id = 'identity-b'").run();
			} else if (state === "merged") {
				target
					.prepare(
						"UPDATE actors SET merged_into_actor_id = 'identity-a' WHERE actor_id = 'identity-b'",
					)
					.run();
			} else {
				target.prepare("DELETE FROM actors WHERE actor_id = 'identity-b'").run();
			}
			const before = recoveryState(target);
			// Act: exact replay currently returns the retained completion without reactivation.
			const result = await apply(target);
			// Assert: this terminal shortcut does not validate or repair actor lifecycle.
			expect(result).toEqual(manifest);
			expect(recoveryState(target)).toEqual(before);
		},
	);
});

describe("canonical Team member recovery serialization", () => {
	it("waits for the absent member's actor lock before standalone recovery", async () => {
		// Arrange.
		const release = await claimRecipientPolicyActorMutations(target, ["identity-b"]);
		let settled = false;
		// Act: drain microtasks, without a wall-clock sleep, while the lock stays held.
		const pending = apply(target).finally(() => {
			settled = true;
		});
		try {
			for (let turn = 0; turn < 40; turn++) await Promise.resolve();
			// Assert: no actor or policy can be committed before release.
			expect(settled).toBe(false);
			expect(actors(target)).toHaveLength(1);
		} finally {
			release();
			await pending;
		}
		expect(actors(target)).toHaveLength(3);
	});

	it("includes current reviewed assignments in the actor lock set", () => {
		// Arrange: a prior local reviewed assignment must be serialized too.
		addActor(target, "old-reviewed-actor");
		target
			.prepare(`INSERT INTO identity_devices(
		 identity_id, device_id, display_name, status, provenance, revision, migration_state,
		 assignment_version, idempotency_key, created_at, updated_at
		 ) VALUES ('old-reviewed-actor', 'device-b', 'Prior laptop', 'active', 'reviewed_team_setup',
		 'prior-revision', 'completed', 1, 'prior-assignment', ?, ?)`)
			.run(NOW, NOW);
		// Act.
		const ids = legacyTeamSetupCompletionActorIds(target, manifest);
		// Assert.
		expect(ids).toEqual(["identity-a", "identity-b", "identity-c", "old-reviewed-actor"]);
		expect(ids).not.toContain("identity-excluded");
	});

	it.each([{ ids: [] }, { ids: ["identity-a", "identity-c"] }])(
		"rejects incomplete claimed actor lock coverage $ids",
		async ({ ids }) => {
			// Arrange.
			const before = recoveryState(target);
			// Act: callers cannot bypass actor serialization by claiming unrelated locks.
			const pending = apply(target, {
				recipientPolicyLocksHeld: {
					publication: true,
					actors: ids,
					team: true,
					coordinatorGroup: true,
				},
			});
			// Assert.
			await expect(pending).rejects.toMatchObject({ code: "team_setup_confirmation_stale" });
			expect(recoveryState(target)).toEqual(before);
		},
	);

	it("accepts complete claimed actor lock coverage", async () => {
		// Arrange.
		const ids = legacyTeamSetupCompletionActorIds(target, manifest);
		// Act.
		await apply(target, {
			recipientPolicyLocksHeld: {
				publication: true,
				actors: ids,
				team: true,
				coordinatorGroup: true,
			},
		});
		// Assert.
		expect(actors(target)).toHaveLength(3);
	});
});
