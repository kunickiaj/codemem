import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { applyLegacyTeamSetupCompletionManifest } from "./legacy-team-setup-completion-manifest.js";
import { refreshLegacyTeamSetupDraft } from "./legacy-team-setup-draft.js";
import {
	type RecipientPolicyReconcilerEffects,
	reconcileRecipientPolicyProject,
} from "./recipient-policy-reconciler.js";
import { isScopeDeviceAdmissionRefused } from "./scope-device-admission.js";
import { teamCoordinatorLinkState } from "./team-member-removal-lookup.js";
import {
	commitTeamRecovery,
	TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS,
	type TeamRecoveryEvidenceReading,
} from "./team-recovery-commit.js";
import { previewTeamRecovery, type TeamRecoveryEvidence } from "./team-recovery-preview.js";
import {
	blockChecks,
	CANDIDATE,
	COORDINATOR_ID,
	DESKTOP,
	GROUP_ID,
	insertScope,
	inviteMember,
	keepScopeProof,
	LAPTOP,
	LAPTOP_REMOVAL,
	NOW,
	PHONE,
	PROJECT,
	pinDevice,
	quarantinedTeam,
	rekeyed,
	scopedRead,
	TABLET,
	TARGET,
} from "./team-recovery-test-fixtures.js";

let db: InstanceType<typeof Database>;
let manifest: CoordinatorLegacyTeamCompletionManifestV1;
let teamId: string;

beforeEach(async () => {
	db = new Database(":memory:");
	manifest = await quarantinedTeam(db);
	teamId = manifest.team_id;
});

afterEach(() => db.close());

const HERE = { coordinatorId: COORDINATOR_ID };
const GROUP = { ...HERE, groupId: GROUP_ID };
const CLOCK_MS = Date.parse(NOW);
const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);
const value = (sql: string) => db.prepare(sql).pluck().get();

type Listed = typeof DESKTOP;

/** What the coordinator reports once the Laptop has been removed from the group. */
function evidence(
	listed: readonly Listed[] = [DESKTOP, TABLET],
	overrides: Partial<TeamRecoveryEvidence> = {},
): TeamRecoveryEvidence {
	return {
		roster: { status: "read", source: GROUP, devices: listed },
		deviceRemovals: { status: "read", source: HERE, removals: [LAPTOP_REMOVAL] },
		deviceBlocks: { status: "read", source: GROUP, checks: blockChecks(listed) },
		completion: { status: "read", source: GROUP, manifest },
		memberRemovals: { status: "read", source: GROUP, removals: [] },
		groupBinding: { status: "read", source: HERE, binding: { team_id: teamId, state: "unbound" } },
		...overrides,
	};
}

/** A reader that answers each call with the next evidence given, repeating the last. */
function reader(...answers: TeamRecoveryEvidence[]) {
	let calls = 0;
	return {
		nowMs: () => CLOCK_MS,
		readEvidence: (): Promise<TeamRecoveryEvidenceReading> => {
			const answer = answers[Math.min(calls, answers.length - 1)] as TeamRecoveryEvidence;
			calls += 1;
			return Promise.resolve({ evidence: answer, startedAtMs: CLOCK_MS });
		},
	};
}

function reviewedDigest(reviewed: TeamRecoveryEvidence = evidence()): string {
	const preview = previewTeamRecovery(db, TARGET, reviewed);
	if (preview.state !== "ready") throw new Error(`refused: ${preview.reason}`);
	return preview.expectedDigest;
}

const commit = (expectedDigest: string, context: ReturnType<typeof reader> = reader(evidence())) =>
	commitTeamRecovery(db, { ...TARGET, expectedDigest }, context);

const refused = (deviceId: string) =>
	isScopeDeviceAdmissionRefused(db, { scopeId: "scope-engineering", deviceId });

const teamState = () => value("SELECT status || ':' || migration_state FROM policy_teams");

function snapshot() {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.pluck()
		.all() as string[];
	return tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]);
}

/**
 * Ordinary reconciliation: the coordinator's copy of the setup applied again.
 * The copy still lists the Laptop, and no removal record is offered.
 */
const applyCoordinatorCopy = () =>
	applyLegacyTeamSetupCompletionManifest(db, {
		...TARGET,
		manifest,
		freshRoster: [DESKTOP, TABLET],
		deviceRemovals: { status: "read", removals: [] },
	});

/** Discovery replaces a quarantined Team's completed attempt with a new one. */
const startNewerAttempt = () =>
	refreshLegacyTeamSetupDraft(db, {
		candidateId: CANDIDATE,
		...TARGET,
		displayName: "Engineering",
		devices: [DESKTOP, TABLET],
		projects: [],
		now: NOW,
	});

/** A reader whose read after the commit first lets `meanwhile` happen, then answers. */
function readerAfter(meanwhile: () => unknown, second: TeamRecoveryEvidence = evidence()) {
	let calls = 0;
	return {
		nowMs: () => CLOCK_MS,
		readEvidence: async (): Promise<TeamRecoveryEvidenceReading> => {
			calls += 1;
			if (calls === 1) return { evidence: evidence(), startedAtMs: CLOCK_MS };
			await meanwhile();
			return { evidence: second, startedAtMs: CLOCK_MS };
		},
	};
}

const blocked = (deviceId: string) =>
	evidence(undefined, {
		deviceBlocks: {
			status: "read",
			source: GROUP,
			checks: blockChecks([DESKTOP, TABLET], [deviceId]),
		},
	});

const memberRemoval = (identityId: string) => ({
	removal_seq: 1,
	group_id: GROUP_ID,
	team_id: teamId,
	identity_id: identityId,
	removed_by_device_id: null,
	removed_at: NOW,
});

describe("Team recovery commit", () => {
	it("makes the Team active again, restores its Project and leaves the removed device out", async () => {
		const result = await commit(reviewedDigest());

		expect(result.state).toBe("recovered");
		expect(teamState()).toBe("active:completed");
		expect(value("SELECT status FROM project_recipients")).toBe("active");
		expect(
			db.prepare("SELECT workspace_identity, scope_id, source FROM project_scope_mappings").all(),
		).toEqual([
			{ workspace_identity: PROJECT, scope_id: "scope-engineering", source: "reviewed_team_setup" },
		]);
		expect(
			db
				.prepare("SELECT device_id, key_fingerprint, reason FROM policy_team_recovery_exclusions")
				.all(),
		).toEqual([
			{ device_id: "device-a", key_fingerprint: LAPTOP.fingerprint, reason: "removed_from_group" },
		]);
		// The setup counts as the source of the Team's group again, so its removals apply.
		expect(value("SELECT finish_digest FROM legacy_team_setup_drafts")).toBe(
			value("SELECT finish_digest FROM legacy_team_setup_completions"),
		);
		expect(teamCoordinatorLinkState(db, teamId)).toMatchObject({
			state: "linked",
			groupId: GROUP_ID,
		});
		// The removed device is refused from current state, with no cache refresh.
		expect(refused("device-a")).toBe(true);
		expect(refused("device-b")).toBe(false);
	});

	it("stays recovered when reconciliation applies the coordinator's copy again", async () => {
		await commit(reviewedDigest());

		await expect(applyCoordinatorCopy()).resolves.toEqual(manifest);
		expect(teamState()).toBe("active:completed");
		expect(refused("device-a")).toBe(true);
	});

	it("discards setup attempts started after the Team was disabled", async () => {
		startNewerAttempt();

		const result = await commit(reviewedDigest());

		expect(result.state).toBe("recovered");
		expect(db.prepare("SELECT state FROM legacy_team_setup_drafts").pluck().all()).toEqual([
			"completed",
		]);
	});

	it("ends the membership of a removed person and of a deactivated one, and records the removal", async () => {
		// Arrange: Person B was removed from the Team, and Person A deactivated.
		run("UPDATE actors SET status = 'deactivated' WHERE actor_id = 'identity-a'");
		const removals = {
			status: "read" as const,
			source: GROUP,
			removals: [memberRemoval("identity-b")],
		};
		const reviewed = evidence(undefined, { memberRemovals: removals });

		const result = await commit(reviewedDigest(reviewed), reader(reviewed));

		expect(result.state).toBe("recovered");
		expect(
			db.prepare("SELECT status FROM policy_team_memberships ORDER BY identity_id").pluck().all(),
		).toEqual(["revoked", "revoked"]);
		expect(value("SELECT identity_id FROM policy_team_member_removals")).toBe("identity-b");
		expect(value("SELECT identity_id FROM policy_team_member_removal_enforcements")).toBe(
			"identity-b",
		);
		expect(refused("device-b")).toBe(true);
	});

	it("writes nothing for another Team when its member removal arrives with the group's list", async () => {
		// Arrange: the list read for the commit carries a removal the preview's list did not.
		const digest = reviewedDigest();
		const elsewhere = { ...memberRemoval("identity-b"), team_id: "team-elsewhere" };
		const arrived = evidence(undefined, {
			memberRemovals: { status: "read", source: GROUP, removals: [elsewhere] },
		});

		const result = await commit(digest, reader(arrived));

		expect(result.state).toBe("recovered");
		expect(value("SELECT COUNT(*) FROM policy_team_member_removals")).toBe(0);
		expect(refused("device-b")).toBe(false);
	});

	it("refuses a read of the scope with a kept proof right after a recovery that skipped its Project", async () => {
		// Arrange: the Desktop kept its scope membership and proof. Someone mapped the
		// Project elsewhere while the Team was disabled, so recovery skips it.
		await keepScopeProof(db, "device-b");
		insertScope(db, "scope-other", "group-other");
		run(
			`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, source,
			 created_at, updated_at) VALUES (?, ?, 'scope-other', 'user', ?, ?)`,
			PROJECT,
			PROJECT,
			NOW,
			NOW,
		);

		const result = await commit(reviewedDigest());

		// Assert: the Desktop is an eligible Team device, and the scope still holds the Project.
		expect(result).toMatchObject({
			state: "recovered",
			preview: { projects: [{ outcome: "skipped", reason: "mapping_changed" }] },
		});
		expect(scopedRead(db, "device-b")).toMatchObject({ authorized: false, state: "policy_denied" });
	});

	it("leaves a Project a person unshared unread, whatever proof a Team device kept", async () => {
		// Arrange: the Desktop kept its scope membership and proof. A person took the
		// Project away from the Team while it was disabled, so recovery skips it.
		await keepScopeProof(db, "device-b");
		run("UPDATE project_recipients SET provenance = 'user', migration_state = 'user_managed'");

		const result = await commit(reviewedDigest());

		expect(result).toMatchObject({
			state: "recovered",
			preview: { projects: [{ outcome: "skipped", reason: "sharing_changed" }] },
		});
		expect(value("SELECT status FROM project_recipients")).toBe("revoked");
		expect(value("SELECT COUNT(*) FROM project_scope_mappings")).toBe(0);
		// The Desktop is an eligible Team device, and the scope still holds the Project.
		expect(scopedRead(db, "device-b")).toMatchObject({ authorized: false, state: "policy_denied" });
	});
});

describe("Team recovery commit refusals", () => {
	it.each([
		["another preview's digest", () => "team-recovery-preview-v1:other", "recovery_preview_stale"],
		[
			"a newer setup attempt edited in place since the preview",
			() => {
				const { attemptId } = startNewerAttempt();
				const digest = reviewedDigest();
				run(
					"UPDATE legacy_team_setup_draft_devices SET decision = 'excluded' WHERE attempt_id = ?",
					attemptId,
				);
				return digest;
			},
			"recovery_preview_stale",
		],
		[
			"a policy row that changed since the preview",
			() => {
				const digest = reviewedDigest();
				run(
					"UPDATE policy_team_device_decisions SET revision = 'edited' WHERE device_id = 'device-b'",
				);
				return digest;
			},
			"recovery_preview_stale",
		],
	])("writes nothing for %s", async (_case, expected, reason) => {
		const expectedDigest = expected();
		const before = snapshot();

		expect(await commit(expectedDigest)).toEqual({ state: "refused", reason });
		expect(snapshot()).toEqual(before);
	});

	it("writes nothing when a surviving device's key and its pin both changed since the preview", async () => {
		// Arrange: the Phone's only key evidence is the pin, which the digest does not read as a row.
		inviteMember(db, teamId, { enrolledKey: null });
		pinDevice(db, "device-d", PHONE.publicKey);
		const digest = reviewedDigest(evidence([DESKTOP, TABLET, PHONE]));
		run("DELETE FROM sync_peers");
		pinDevice(db, "device-d", rekeyed(PHONE).publicKey);
		const before = snapshot();

		const result = await commit(digest, reader(evidence([DESKTOP, TABLET, rekeyed(PHONE)])));

		expect(result).toEqual({ state: "refused", reason: "recovery_preview_stale" });
		expect(snapshot()).toEqual(before);
	});

	it.each([
		["older than the limit", CLOCK_MS - TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS - 1],
		["stamped in the future", CLOCK_MS + 1],
	])("writes nothing on evidence %s", async (_case, startedAtMs) => {
		const digest = reviewedDigest();
		const before = snapshot();
		const context = {
			nowMs: () => CLOCK_MS,
			readEvidence: () => Promise.resolve({ evidence: evidence(), startedAtMs }),
		};

		const result = await commitTeamRecovery(db, { ...TARGET, expectedDigest: digest }, context);

		expect(result).toEqual({ state: "refused", reason: "evidence_stale" });
		expect(snapshot()).toEqual(before);
	});

	it("accepts evidence exactly as old as the limit", async () => {
		const context = {
			nowMs: () => CLOCK_MS,
			readEvidence: () =>
				Promise.resolve({
					evidence: evidence(),
					startedAtMs: CLOCK_MS - TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS,
				}),
		};

		const result = await commitTeamRecovery(
			db,
			{ ...TARGET, expectedDigest: reviewedDigest() },
			context,
		);

		expect(result.state).toBe("recovered");
	});

	it("refuses on what the commit reads, whatever the preview was made on", async () => {
		const digest = reviewedDigest();
		const before = snapshot();
		const unreadable = evidence(undefined, { deviceBlocks: { status: "unavailable" } });

		expect(await commit(digest, reader(unreadable))).toEqual({
			state: "refused",
			reason: "device_blocks_unavailable",
		});
		expect(snapshot()).toEqual(before);
	});
});

describe("Team recovery check after the commit", () => {
	it.each([
		[
			"blocks a surviving device",
			() =>
				evidence(undefined, {
					deviceBlocks: {
						status: "read",
						source: GROUP,
						checks: blockChecks([DESKTOP, TABLET], ["device-b"]),
					},
				}),
		],
		[
			"lists a surviving device as disabled",
			() =>
				evidence(undefined, {
					roster: {
						status: "read",
						source: GROUP,
						devices: [{ ...DESKTOP, enabled: false }, TABLET],
					},
				}),
		],
		[
			"reports the person of a surviving device removed",
			() =>
				evidence(undefined, {
					memberRemovals: {
						status: "read",
						source: GROUP,
						removals: [memberRemoval("identity-b")],
					},
				}),
		],
	])("quarantines the Team again when the coordinator now %s", async (_case, changed) => {
		const result = await commit(reviewedDigest(), reader(evidence(), changed()));

		expect(result).toEqual({ state: "quarantined_again", reason: "evidence_changed" });
		expect(teamState()).toBe("inactive:needs_setup");
		expect(value("SELECT status FROM project_recipients")).toBe("revoked");
		// What recovery took away stays taken away.
		expect(value("SELECT device_id FROM policy_team_recovery_exclusions")).toBe("device-a");
		expect(refused("device-a")).toBe(true);
		expect(refused("device-b")).toBe(true);
	});

	it("quarantines the Team again and keeps its hold when a device is removed between the second roster read and its block check", async () => {
		// Arrange: the second roster still lists the Desktop, and the block check asked after it reports it removed.
		const checks = blockChecks([DESKTOP, TABLET], [], { "device-b": "of_this_key" });
		const second = evidence(undefined, {
			deviceBlocks: { status: "read", source: GROUP, checks },
		});

		const result = await commit(reviewedDigest(), reader(evidence(), second));

		expect(result).toEqual({ state: "quarantined_again", reason: "evidence_changed" });
		expect(teamState()).toBe("inactive:needs_setup");
		expect(value("SELECT COUNT(*) FROM policy_team_recovery_holds")).toBe(1);
		expect(refused("device-b")).toBe(true);
	});

	it("refuses the recovery when a device is removed between the first roster read and its block check", async () => {
		const digest = reviewedDigest();
		const before = snapshot();
		const checks = blockChecks([DESKTOP, TABLET], [], { "device-b": "of_this_key" });
		const first = evidence(undefined, { deviceBlocks: { status: "read", source: GROUP, checks } });

		const result = await commit(digest, reader(first));

		expect(result).toMatchObject({ state: "refused", reason: "device_evidence_contradictory" });
		expect(snapshot()).toEqual(before);
	});

	it("quarantines the Team again and keeps its hold when a device its first read listed is off the roster in the read after the commit", async () => {
		// Arrange: the Desktop left the group during the first read, which its block check could not see.
		const removal = { group_id: GROUP_ID, device_id: "device-b", fingerprint: DESKTOP.fingerprint };
		const second = evidence([TABLET], {
			deviceRemovals: { status: "read", source: HERE, removals: [LAPTOP_REMOVAL, removal] },
		});

		const result = await commit(reviewedDigest(), reader(evidence(), second));

		expect(result).toEqual({ state: "quarantined_again", reason: "evidence_changed" });
		expect(teamState()).toBe("inactive:needs_setup");
		expect(value("SELECT COUNT(*) FROM policy_team_recovery_holds")).toBe(1);
		expect(refused("device-b")).toBe(true);
	});

	it("quarantines the Team again when the evidence cannot be read again", async () => {
		const unreadable = evidence(undefined, { roster: { status: "unavailable" } });

		const result = await commit(reviewedDigest(), reader(evidence(), unreadable));

		expect(result).toEqual({ state: "quarantined_again", reason: "evidence_unavailable" });
		expect(teamState()).toBe("inactive:needs_setup");
	});

	it("keeps the recovery when only a device outside the Team changed", async () => {
		const joined = { ...PHONE, deviceId: "device-new" };

		const result = await commit(
			reviewedDigest(),
			reader(evidence(), evidence([DESKTOP, TABLET, joined])),
		);

		expect(result.state).toBe("recovered");
		expect(teamState()).toBe("active:completed");
	});
});

describe("Team recovery check of where the completed setup came from", () => {
	it.each([
		["another group", { ...GROUP, groupId: "group-other" }],
		["another coordinator", { ...GROUP, coordinatorId: "https://elsewhere.example.invalid" }],
	])(
		"quarantines the Team again when the read after the commit takes the same completed setup from %s",
		async (_case, source) => {
			const elsewhere = evidence(undefined, { completion: { status: "read", source, manifest } });

			const result = await commit(reviewedDigest(), reader(evidence(), elsewhere));

			expect(result).toEqual({ state: "quarantined_again", reason: "evidence_changed" });
			expect(teamState()).toBe("inactive:needs_setup");
			expect(value("SELECT COUNT(*) FROM policy_team_recovery_holds")).toBe(1);
		},
	);
});

describe("Team recovery hold", () => {
	const hold = () => db.prepare("SELECT reason FROM policy_team_recovery_holds").pluck().all();

	it("serves no device until the read after the commit has verified the recovery", async () => {
		await keepScopeProof(db, "device-b");
		const during: unknown[] = [];
		const context = readerAfter(() => during.push(teamState(), scopedRead(db, "device-b").state));

		const result = await commit(reviewedDigest(), context);

		expect(during).toEqual(["active:completed", "policy_denied"]);
		expect(result.state).toBe("recovered");
		expect(hold()).toEqual([]);
		expect(scopedRead(db, "device-b").state).toBe("authorized");
	});

	it.each([
		["cannot be read again", () => evidence(undefined, { roster: { status: "unavailable" } })],
		["shows a newly blocked device", () => blocked("device-b")],
	])(
		"keeps the Team disabled through ordinary reconciliation when the evidence %s",
		async (_case, second) => {
			const result = await commit(reviewedDigest(), reader(evidence(), second()));
			expect(result.state).toBe("quarantined_again");

			// Act: the roster no longer lists the Laptop, and its exclusion exempts it from the check.
			await expect(applyCoordinatorCopy()).rejects.toThrow("team_setup_completion_invalid");

			expect(teamState()).toBe("inactive:needs_setup");
			expect(hold()).toHaveLength(1);
			expect(refused("device-b")).toBe(true);
		},
	);

	it("disables a held Team that ordinary reconciliation reaches before the read comes back", async () => {
		const context = readerAfter(() => applyCoordinatorCopy().catch(() => undefined));

		const result = await commit(reviewedDigest(), context);

		expect(result).toEqual({ state: "quarantined_again", reason: "disabled_before_verification" });
		expect(teamState()).toBe("inactive:needs_setup");
		expect(hold()).toEqual(["awaiting_verification"]);
	});

	it("changes nothing a later recovery did when its own read comes back late and failed", async () => {
		// Arrange: by the time this read fails, another recovery holds the Team.
		const context = readerAfter(
			() => run("UPDATE policy_team_recovery_holds SET recovery_id = 'later-recovery'"),
			blocked("device-b"),
		);

		const result = await commit(reviewedDigest(), context);

		expect(result).toEqual({ state: "superseded" });
		expect(teamState()).toBe("active:completed");
		expect(hold()).toEqual(["awaiting_verification"]);
	});

	it("is lifted by another recovery whose read verifies", async () => {
		await commit(reviewedDigest(), reader(evidence(), blocked("device-b")));
		expect(hold()).toEqual(["evidence_changed"]);

		const result = await commit(reviewedDigest());

		expect(result.state).toBe("recovered");
		expect(hold()).toEqual([]);
		expect(refused("device-b")).toBe(false);
		await expect(applyCoordinatorCopy()).resolves.toEqual(manifest);
	});
});

describe("Team recovery hold and recipient policy", () => {
	/** A coordinator that has granted nothing, and lists the Desktop as enrolled for Person B. */
	function coordinator() {
		const granted: string[] = [];
		const receipt = (input: { effectId: string; scopeId: string; deviceId: string }) => input;
		const effects: RecipientPolicyReconcilerEffects = {
			now: () => NOW,
			snapshot: async ({ scopeId }) => ({
				authoritative: true,
				scopeId,
				fingerprint: `snapshot:${granted.join(",")}`,
				observedAt: NOW,
				memberships: granted.map((deviceId) => ({ deviceId, status: "active" as const })),
			}),
			listBoundaryEnrollments: async () => [
				{ ...DESKTOP, identityId: "identity-b", enabled: true },
			],
			probeCapability: async () => "supported",
			revoke: async (input) => ({ ...receipt(input), status: "revoked" }),
			grant: async (input) => {
				granted.push(input.deviceId);
				return { ...receipt(input), status: "active" };
			},
			refresh: async () => undefined,
		};
		const reconcile = () =>
			reconcileRecipientPolicyProject(
				db,
				{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker" },
				effects,
			);
		return { granted, reconcile };
	}

	const wakes = () => value("SELECT wake_epoch FROM recipient_policy_authority_states");

	it("publishes no grant while the Team is held, and wakes its Projects once the hold is lifted", async () => {
		// Arrange: the Team's scope is one the reconciler manages for the Project.
		run(
			"UPDATE replication_scopes SET kind = 'managed_project' WHERE scope_id = 'scope-engineering'",
		);
		const { granted, reconcile } = coordinator();
		const during: unknown[] = [];
		const context = readerAfter(async () => {
			await reconcile();
			during.push([...granted], wakes());
		});

		const result = await commit(reviewedDigest(), context);

		expect(during).toEqual([[], 0]);
		expect(result.state).toBe("recovered");
		expect(wakes()).toBe(1);
		await reconcile();
		expect(granted).toEqual(["device-b"]);
	});
});

describe("Team recovery after one that stopped", () => {
	const LATER_MS = CLOCK_MS + TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS + 1;

	/** A recovery whose process stopped after its first transaction: the read after it never comes back. */
	async function stoppedRecovery() {
		await keepScopeProof(db, "device-b");
		void commit(
			reviewedDigest(),
			readerAfter(() => new Promise(() => undefined)),
		);
		await vi.waitFor(() => expect(teamState()).toBe("active:completed"));
	}

	it.each([
		["its hold is older than a recovery is given", LATER_MS, () => undefined],
		[
			"no recovery in this process is verifying its hold",
			CLOCK_MS,
			() => run("UPDATE policy_team_recovery_holds SET recovery_id = 'another-process'"),
		],
	])(
		"takes the Team over with no reconciliation in between once %s",
		async (_case, nowMs, arrange) => {
			await stoppedRecovery();
			// While this process still waits for that read, the hold is not anyone's to take.
			const early = previewTeamRecovery(db, TARGET, evidence(), { nowMs: CLOCK_MS });
			expect(early).toEqual({ state: "refused", reason: "team_not_quarantined" });
			arrange();
			const before = snapshot();
			const reading = { evidence: evidence(), startedAtMs: nowMs };
			const during: unknown[] = [];

			// Act: the explicit recovery again, on evidence read now.
			const preview = previewTeamRecovery(db, TARGET, evidence(), { nowMs });
			expect(snapshot()).toEqual(before);
			const expectedDigest = preview.state === "ready" ? preview.expectedDigest : preview.reason;
			const result = await commitTeamRecovery(
				db,
				{ ...TARGET, expectedDigest },
				{
					nowMs: () => nowMs,
					readEvidence: () => {
						during.push(scopedRead(db, "device-b").state);
						return Promise.resolve(reading);
					},
				},
			);

			// Assert: the Desktop was refused from the first recovery's hold to the second's lift.
			expect(result.state).toBe("recovered");
			expect(during).toEqual(["policy_denied", "policy_denied"]);
			expect(value("SELECT COUNT(*) FROM policy_team_recovery_holds")).toBe(0);
			expect(scopedRead(db, "device-b").state).toBe("authorized");
		},
	);

	it("writes nothing when the takeover is refused", async () => {
		await stoppedRecovery();
		const before = snapshot();
		const stale = { ...TARGET, expectedDigest: "team-recovery-preview-v1:other" };

		const result = await commitTeamRecovery(db, stale, {
			nowMs: () => LATER_MS,
			readEvidence: () => Promise.resolve({ evidence: evidence(), startedAtMs: LATER_MS }),
		});

		expect(result).toEqual({ state: "refused", reason: "recovery_preview_stale" });
		expect(snapshot()).toEqual(before);
		expect(scopedRead(db, "device-b").state).toBe("policy_denied");
	});
});

describe("Team recovery and a former scope that only stores a skipped Project's memories", () => {
	/** A memory in the scope whose session ran elsewhere, so only this says which Project it is of. */
	function storeMemory(stored: { memoryProject?: string; recordedRepository?: string }) {
		const metadata = stored.recordedRepository
			? JSON.stringify({ codemem_repository_identity: stored.recordedRepository })
			: null;
		const session = run(
			`INSERT INTO sessions(started_at, cwd, project, tool_version, metadata_json)
			 VALUES (?, '/work/elsewhere', 'elsewhere', 'test', ?)`,
			NOW,
			metadata,
		);
		run(
			`INSERT INTO memory_items(session_id, kind, title, body_text, active, created_at, updated_at,
			 scope_id, project) VALUES (?, 'discovery', 'Stored', 'Stored', 1, ?, ?, 'scope-former', ?)`,
			session.lastInsertRowid,
			NOW,
			NOW,
			stored.memoryProject ?? null,
		);
	}

	it.each([
		["the memory's own Project", { memoryProject: PROJECT }],
		["the repository its session recorded", { recordedRepository: PROJECT }],
	])(
		"refuses a kept-proof read of it, while the Team is held and after, when only %s names the Project",
		async (_case, stored) => {
			// Arrange: no mapping points the Project to the former scope and no setup put it
			// there. The Desktop kept its proof for it. A person unshared the Project.
			insertScope(db, "scope-former", GROUP_ID);
			storeMemory(stored);
			await keepScopeProof(db, "device-b", "scope-former");
			run("UPDATE project_recipients SET provenance = 'user', migration_state = 'user_managed'");
			const read = () => scopedRead(db, "device-b", "scope-former").state;
			const during: unknown[] = [];

			const result = await commit(
				reviewedDigest(),
				readerAfter(() => during.push(read())),
			);

			expect(result).toMatchObject({
				state: "recovered",
				preview: { projects: [{ outcome: "skipped" }] },
			});
			expect(during).toEqual(["policy_denied"]);
			expect(read()).toBe("policy_denied");
		},
	);
});

describe("Team recovery whose read after the commit is too old to act on", () => {
	it("keeps the hold when the read finished in time but waited past the limit for the write lock", async () => {
		// Arrange: the second read starts at once and comes back in time. Only inside
		// the transaction that acts on it, once the write lock is held, is it past the limit.
		await keepScopeProof(db, "device-b");
		const LATER_MS = CLOCK_MS + TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS + 1;
		let reads = 0;
		const context = {
			nowMs: () => (reads === 2 && db.inTransaction ? LATER_MS : CLOCK_MS),
			readEvidence: (): Promise<TeamRecoveryEvidenceReading> => {
				reads += 1;
				return Promise.resolve({ evidence: evidence(), startedAtMs: CLOCK_MS });
			},
		};

		const result = await commit(reviewedDigest(), context);

		expect(result).toEqual({ state: "unverified", reason: "evidence_stale" });
		expect(teamState()).toBe("active:completed");
		expect(value("SELECT reason FROM policy_team_recovery_holds")).toBe("awaiting_verification");
		expect(scopedRead(db, "device-b").state).toBe("policy_denied");

		// The recovery can be tried again: it takes the hold over, and this time verifies in time.
		const retry = await commit(reviewedDigest(), {
			nowMs: () => LATER_MS,
			readEvidence: () => Promise.resolve({ evidence: evidence(), startedAtMs: LATER_MS }),
		});
		expect(retry.state).toBe("recovered");
		expect(scopedRead(db, "device-b").state).toBe("authorized");
	});
});
