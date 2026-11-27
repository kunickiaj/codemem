import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { discoverLegacyTeamCandidates } from "./legacy-team-candidate.js";
import {
	applyLegacyTeamSetupCompletionManifest,
	containLegacyTeamSetupCompletionConflict,
	deriveLegacyTeamSetupCompletionManifest,
} from "./legacy-team-setup-completion-manifest.js";
import {
	refreshLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "./legacy-team-setup-draft.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { recordTeamRecoveryExclusions } from "./team-recovery-exclusions.js";
import {
	CANDIDATE,
	DESKTOP,
	GROUP_ID,
	insertActor,
	insertScope,
	LAPTOP,
	NOW,
	PHONE,
	rekeyed,
	TABLET,
	TARGET,
} from "./team-recovery-test-fixtures.js";
import { initTestSchema } from "./test-utils.js";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	for (const identityId of ["identity-a", "identity-b"]) insertActor(db, identityId);
	insertScope(db, "scope-engineering", GROUP_ID);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run("device-local", CANONICAL_PUBLIC_KEY, fingerprintPublicKey(CANONICAL_PUBLIC_KEY), NOW);
});

afterEach(() => db.close());

const ROSTER = [LAPTOP, DESKTOP, TABLET];

/** A setup with no Projects: the Laptop for Person A, the Desktop for Person B, the Tablet excluded. */
function reviewedSetup() {
	let draft = refreshLegacyTeamSetupDraft(db, {
		candidateId: CANDIDATE,
		...TARGET,
		displayName: "Engineering",
		devices: ROSTER,
		projects: [],
		now: NOW,
	});
	const owners: Record<string, string> = { Laptop: "identity-a", Desktop: "identity-b" };
	for (const reviewed of draft.devices) {
		const { attemptId } = draft;
		const targetIdentityId = owners[reviewed.displayName];
		const { deviceRef, expectation } = reviewed;
		if (targetIdentityId)
			setLegacyTeamSetupDeviceAssignment(db, {
				attemptId,
				deviceRef,
				targetIdentityId,
				expectation,
				now: NOW,
			});
		const decision = targetIdentityId ? "included" : "excluded";
		draft = setLegacyTeamSetupDeviceDecision(db, { attemptId, deviceRef, decision, now: NOW });
	}
	return deriveLegacyTeamSetupCompletionManifest(db, {
		candidateRef: draft.candidateRef,
		attemptId: draft.attemptId,
		completedAt: NOW,
	});
}

/** What Team setup shows for the group, as discovery reads it from the roster. */
const discoveredStatus = (devices = ROSTER) =>
	discoverLegacyTeamCandidates(db, {
		projection: { localActorId: "actor-local", localDeviceId: "device-local" },
		groups: [{ ...TARGET, displayName: "Engineering", devices }],
		now: NOW,
	}).map((candidate) => candidate.status);

describe("Team setup readiness and the roster an activation fingerprints", () => {
	it("reads the Team as ready when the roster lists a device the completed setup does not", async () => {
		// Arrange: the Phone joined the group after the setup was reviewed.
		const manifest = reviewedSetup();
		const withPhone = [...ROSTER, PHONE];

		await applyLegacyTeamSetupCompletionManifest(db, {
			...TARGET,
			manifest,
			freshRoster: withPhone,
		});

		// Assert: discovery fingerprints the same four devices, and the Phone gets no decision.
		expect(discoveredStatus(withPhone)).toEqual(["ready"]);
		expect(
			db
				.prepare("SELECT COUNT(*) FROM policy_team_device_decisions WHERE device_id = ?")
				.pluck()
				.get(PHONE.deviceId),
		).toBe(0);
	});
});

describe("Team setup readiness after a Team recovery exclusion", () => {
	/** A completed Team, disabled, whose recovery left the Laptop out. Returns its reapply. */
	async function disabledWithLaptopLeftOut() {
		const manifest = reviewedSetup();
		const apply = (freshRoster = ROSTER) =>
			applyLegacyTeamSetupCompletionManifest(db, { ...TARGET, manifest, freshRoster });
		await apply();
		expect(discoveredStatus()).toEqual(["ready"]);
		await containLegacyTeamSetupCompletionConflict(db, TARGET);
		recordTeamRecoveryExclusions(db, {
			teamId: manifest.team_id,
			devices: [
				{ deviceId: "device-a", fingerprint: LAPTOP.fingerprint, reason: "removed_from_group" },
			],
			now: NOW,
		});
		db.prepare("UPDATE identity_devices SET status = 'removed' WHERE device_id = 'device-a'").run();
		return apply;
	}

	it("reads the Team as ready after an activation that left the excluded device out", async () => {
		// Arrange: the Laptop is on the roster again.
		const apply = await disabledWithLaptopLeftOut();

		// Act: the completed setup is applied again. Its review still includes the Laptop.
		await apply();

		expect(
			db
				.prepare("SELECT decision FROM policy_team_device_decisions WHERE device_id = 'device-a'")
				.pluck()
				.get(),
		).toBe("excluded");
		expect(discoveredStatus()).toEqual(["ready"]);
	});

	it.each([
		["with a different key", rekeyed(LAPTOP)],
		["disabled", { ...LAPTOP, enabled: false }],
	])(
		"reads the Team as ready after an activation while the excluded device is back on the roster %s",
		async (_case, laptopNow) => {
			// Arrange: the completed setup lists the Laptop as it was reviewed, and the roster lists it as it is now.
			const apply = await disabledWithLaptopLeftOut();
			const changed = [laptopNow, DESKTOP, TABLET];

			await apply(changed);

			expect(discoveredStatus(changed)).toEqual(["ready"]);
		},
	);

	it("reads the Team as ready after an activation while the excluded device is off the roster", async () => {
		// Arrange: the coordinator no longer lists the Laptop, and the completed setup still does.
		const apply = await disabledWithLaptopLeftOut();
		const withoutLaptop = [DESKTOP, TABLET];

		await apply(withoutLaptop);

		expect(discoveredStatus(withoutLaptop)).toEqual(["ready"]);
	});
});
