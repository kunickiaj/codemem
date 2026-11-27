import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { refreshLegacyTeamSetupDraft } from "./legacy-team-setup-draft.js";
import {
	previewTeamRecovery,
	type TeamRecoveryEvidence,
	type TeamRecoveryPreview,
} from "./team-recovery-preview.js";
import {
	bindDevice,
	blockChecks,
	CANDIDATE,
	COORDINATOR_ID,
	DESKTOP,
	GROUP_ID,
	insertActor,
	insertCheckout,
	insertScope,
	inviteMember,
	LAPTOP,
	LAPTOP_REMOVAL,
	NOW,
	PHONE,
	PROJECT,
	quarantinedTeam,
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

const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);
const CHECKOUT = "/nonexistent/acme/api";

const HERE = { coordinatorId: COORDINATOR_ID };
const GROUP = { ...HERE, groupId: GROUP_ID };

/** What the coordinator reports once the Laptop has been removed from the group. */
function evidence(overrides: Partial<TeamRecoveryEvidence> = {}): TeamRecoveryEvidence {
	// Every roster a test passes is made of the fixture devices, which carry their keys.
	const listed = overrides.roster?.status === "read" ? overrides.roster.devices : [DESKTOP, TABLET];
	const roster = listed as ReadonlyArray<typeof DESKTOP>;
	return {
		roster: { status: "read", source: GROUP, devices: [DESKTOP, TABLET] },
		deviceRemovals: { status: "read", source: HERE, removals: [LAPTOP_REMOVAL] },
		// Unless a test says otherwise, every roster device was checked and none is blocked.
		deviceBlocks: { status: "read", source: GROUP, checks: blockChecks(roster) },
		completion: { status: "read", source: GROUP, manifest },
		memberRemovals: { status: "read", source: GROUP, removals: [] },
		groupBinding: {
			status: "read",
			source: HERE,
			binding: { team_id: teamId, state: "unbound" },
		},
		...overrides,
	};
}

const preview = (overrides: Partial<TeamRecoveryEvidence> = {}) =>
	previewTeamRecovery(db, TARGET, evidence(overrides));

function ready(overrides: Partial<TeamRecoveryEvidence> = {}): TeamRecoveryPreview {
	const result = preview(overrides);
	if (result.state !== "ready") throw new Error(`refused: ${result.reason}`);
	return result;
}

const label = (row: { outcome: string; reason?: string } | undefined) =>
	row?.reason ? `${row.outcome}:${row.reason}` : row?.outcome;
const person = (result: TeamRecoveryPreview, identityId: string) =>
	label(result.people.find((row) => row.identityId === identityId));
const device = (result: TeamRecoveryPreview, deviceId: string) =>
	label(result.devices.find((row) => row.deviceId === deviceId));

function memberRemoval(identityId: string, groupId = GROUP_ID) {
	return {
		removal_seq: 1,
		group_id: groupId,
		team_id: teamId,
		identity_id: identityId,
		removed_by_device_id: null,
		removed_at: NOW,
	};
}

const removing = (identityId: string) => ({
	memberRemovals: { status: "read" as const, source: GROUP, removals: [memberRemoval(identityId)] },
});

function databaseSnapshot() {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.pluck()
		.all() as string[];
	return tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]);
}

describe("Team recovery preview", () => {
	it("lists what recovery restores and leaves out, and writes nothing", () => {
		// Arrange: a local checkout, so the preview resolves live routing as well.
		insertCheckout(db, CHECKOUT, PROJECT);
		const before = databaseSnapshot();

		const result = ready();

		expect(result).toMatchObject({ teamId, teamName: "Engineering", discardedSetupAttempts: 0 });
		expect(result.people.map((row) => [row.identityId, row.outcome])).toEqual([
			["identity-a", "member"],
			["identity-b", "member"],
		]);
		expect(result.devices.map((row) => [row.deviceId, label(row)])).toEqual([
			["device-a", "stays_out:removed_from_group"],
			["device-b", "regains_access"],
			["device-x", "stays_out:excluded_in_review"],
		]);
		expect(result.projects).toMatchObject([{ projectIdentity: PROJECT, outcome: "restored" }]);
		expect(databaseSnapshot()).toEqual(before);
	});

	it("binds the outcome in a digest that changes with what recovery would do", () => {
		const digests = [ready().expectedDigest];
		expect(ready().expectedDigest).toBe(digests[0]);

		// Each step changes one part of the outcome: a device, a person, a Project, the attempts.
		const blocked = { ...LAPTOP_REMOVAL, revoked: true as const };
		digests.push(
			ready({ deviceRemovals: { status: "read", source: HERE, removals: [blocked] } })
				.expectedDigest,
		);
		run("UPDATE actors SET status = 'deactivated' WHERE actor_id = 'identity-a'");
		digests.push(ready().expectedDigest);
		run("UPDATE project_recipients SET provenance = 'user'");
		digests.push(ready().expectedDigest);
		// Discovery starts a new attempt for a quarantined Team. Recovery would discard it.
		refreshLegacyTeamSetupDraft(db, {
			candidateId: CANDIDATE,
			...TARGET,
			displayName: "Engineering",
			devices: [DESKTOP, TABLET],
			projects: [],
			now: NOW,
		});
		const discarding = ready();
		digests.push(discarding.expectedDigest);

		expect(discarding.discardedSetupAttempts).toBe(1);
		expect(new Set(digests).size).toBe(5);
	});

	it("changes the digest when a Project that resumes is routed elsewhere before the commit", () => {
		// Arrange: a person shared the Project with the Team again after it was disabled.
		insertScope(db, "scope-other", "group-other");
		insertCheckout(db, CHECKOUT, PROJECT);
		run("UPDATE project_recipients SET status = 'active', provenance = 'user'");
		const reviewed = ready();

		// Act: before the commit, a pattern moves the Project's checkout to another scope.
		run(
			`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, source,
			 created_at, updated_at) VALUES (NULL, '/nonexistent/acme/*', 'scope-other', 'user', ?, ?)`,
			NOW,
			NOW,
		);
		const moved = ready();

		expect(reviewed.projects).toMatchObject([{ outcome: "resumes", routedScopeIds: [] }]);
		expect(moved.projects).toMatchObject([{ outcome: "resumes", routedScopeIds: ["scope-other"] }]);
		expect(moved.expectedDigest).not.toBe(reviewed.expectedDigest);
	});

	it("refuses when the coordinator blocks an enrolled device it never removed", () => {
		// Arrange: the Laptop is enrolled, enabled and has no removal record, but is blocked.
		const roster = [LAPTOP, DESKTOP, TABLET];
		const checks = blockChecks(roster, ["device-a"]);

		const result = preview({
			roster: { status: "read", source: GROUP, devices: roster },
			deviceRemovals: { status: "read", source: HERE, removals: [] },
			deviceBlocks: { status: "read", source: GROUP, checks },
		});

		expect(result).toEqual({ state: "refused", reason: "device_blocked", deviceIds: ["device-a"] });
	});

	it("passes on the reason a device stops recovery, and a blocked Team policy", () => {
		const missing = preview({ deviceRemovals: { status: "read", source: HERE, removals: [] } });
		run("UPDATE policy_team_memberships SET status = 'active' WHERE identity_id = 'identity-b'");

		expect(missing).toEqual({
			state: "refused",
			reason: "device_missing_without_removal",
			deviceIds: ["device-a"],
		});
		expect(preview()).toEqual({ state: "refused", reason: "team_policy_blocked" });
	});
});

describe("Team recovery preview of people", () => {
	const enforced = () =>
		run(
			"INSERT INTO policy_team_member_removal_enforcements(team_id, identity_id, enforced_at) VALUES (?, 'identity-b', ?)",
			teamId,
			NOW,
		);
	const recorded = (groupId: string) =>
		run(
			`INSERT INTO policy_team_member_removals(team_id, identity_id, coordinator_id, group_id,
			 removal_seq, removed_at, removed_by_device_id, recorded_at)
			 VALUES (?, 'identity-b', ?, ?, 1, ?, NULL, ?)`,
			teamId,
			COORDINATOR_ID,
			groupId,
			NOW,
			NOW,
		);

	it.each([
		["the removals just read", () => undefined, () => removing("identity-b")],
		["a removal this machine enforced earlier", enforced, () => ({})],
		["a removal recorded while the Team had no group", () => recorded(GROUP_ID), () => ({})],
	])("leaves out a person removed from the Team: %s", (_case, arrange, overrides) => {
		arrange();

		const result = ready(overrides());

		expect(person(result, "identity-b")).toBe("left_out:removed_from_team");
		expect(device(result, "device-b")).toBe("stays_out:person_left_out");
		expect(person(result, "identity-a")).toBe("member");
	});

	it("keeps a member whom only another group removed", () => {
		recorded("group-other");

		expect(person(ready(), "identity-b")).toBe("member");
	});

	it.each([
		["deactivated", "UPDATE actors SET status = 'deactivated' WHERE actor_id = 'identity-b'"],
		["merged", "UPDATE actors SET status = 'merged' WHERE actor_id = 'identity-b'"],
		[
			"merged",
			"UPDATE actors SET merged_into_actor_id = 'identity-a' WHERE actor_id = 'identity-b'",
		],
		["identity_missing", "DELETE FROM actors WHERE actor_id = 'identity-b'"],
		["identity_not_active", "UPDATE actors SET status = 'suspended' WHERE actor_id = 'identity-b'"],
	])("leaves out a person whose identity is %s", (reason, sql) => {
		run(sql);

		const result = ready();

		expect(person(result, "identity-b")).toBe(`left_out:${reason}`);
		expect(device(result, "device-b")).toBe("stays_out:person_left_out");
	});

	it("never makes a member of someone whose membership had ended, or of an excluded device's person", () => {
		// Arrange: Person B's membership was revoked. The Tablet's person was never a member.
		run("UPDATE policy_team_memberships SET status = 'revoked' WHERE identity_id = 'identity-b'");
		insertActor(db, "identity-c");
		bindDevice(db, "device-x", "identity-c");

		const result = ready();

		expect(person(result, "identity-b")).toBe("left_out:not_a_member");
		expect(device(result, "device-b")).toBe("stays_out:person_left_out");
		expect(person(result, "identity-c")).toBeUndefined();
		expect(device(result, "device-x")).toBe("stays_out:excluded_in_review");
	});

	it("lists a person who joined through an invitation, and leaves them out once removed", () => {
		inviteMember(db, teamId);
		const roster = { status: "read" as const, source: GROUP, devices: [DESKTOP, TABLET, PHONE] };

		const joined = ready({ roster });
		const removed = ready({ roster, ...removing("identity-d") });

		expect([person(joined, "identity-d"), device(joined, "device-d")]).toEqual([
			"member",
			"regains_access",
		]);
		expect([person(removed, "identity-d"), device(removed, "device-d")]).toEqual([
			"left_out:removed_from_team",
			"stays_out:person_left_out",
		]);
	});
});

describe("Team recovery preview refusals from evidence", () => {
	it.each([
		["roster", "roster_unavailable"],
		["deviceRemovals", "device_removals_unavailable"],
		["deviceBlocks", "device_blocks_unavailable"],
		["completion", "completion_unavailable"],
		["memberRemovals", "member_removals_unavailable"],
		["groupBinding", "team_group_unavailable"],
	] as const)("refuses when the %s read failed", (part, reason) => {
		expect(preview({ [part]: { status: "unavailable" } })).toEqual({ state: "refused", reason });
	});

	it.each([
		[
			"a roster that lists a device twice",
			() => ({
				roster: { status: "read" as const, source: GROUP, devices: [DESKTOP, DESKTOP, TABLET] },
			}),
			"roster_unavailable",
		],
		[
			"member removals from another group",
			() => ({
				memberRemovals: {
					status: "read" as const,
					source: GROUP,
					removals: [memberRemoval("identity-b", "group-other")],
				},
			}),
			"member_removals_unavailable",
		],
		[
			"no completion on the coordinator",
			() => ({ completion: { status: "read" as const, source: GROUP, manifest: null } }),
			"completion_missing",
		],
		[
			"a coordinator copy that fails validation",
			() => ({
				completion: {
					status: "read" as const,
					source: GROUP,
					manifest: { ...manifest, finish_digest: "0".repeat(64) },
				},
			}),
			"completion_invalid",
		],
	])("refuses %s", (_case, overrides, reason) => {
		expect(preview(overrides())).toEqual({ state: "refused", reason });
	});

	const elsewhere = { ...GROUP, coordinatorId: "https://other.example.invalid" };
	const otherGroup = { ...GROUP, groupId: "group-other" };

	it.each([
		["roster", otherGroup, "roster_unavailable"],
		["roster", elsewhere, "roster_unavailable"],
		["deviceRemovals", elsewhere, "device_removals_unavailable"],
		["deviceBlocks", elsewhere, "device_blocks_unavailable"],
		["deviceBlocks", otherGroup, "device_blocks_unavailable"],
		["completion", otherGroup, "completion_unavailable"],
		["memberRemovals", otherGroup, "member_removals_unavailable"],
		["memberRemovals", elsewhere, "member_removals_unavailable"],
		["groupBinding", elsewhere, "team_group_unavailable"],
	] as const)(
		"refuses %s evidence read from another group or coordinator",
		(part, source, reason) => {
			const read = evidence();

			const result = previewTeamRecovery(db, TARGET, {
				...read,
				[part]: { ...read[part], source },
			});

			expect(result).toEqual({ state: "refused", reason });
		},
	);

	it("refuses when the local completed setup differs from the coordinator's copy", () => {
		// Arrange: the local draft no longer includes the Desktop the coordinator's copy includes.
		run(
			"UPDATE legacy_team_setup_draft_devices SET decision = 'excluded', target_identity_id = NULL WHERE device_id = 'device-b'",
		);

		expect(preview()).toEqual({ state: "refused", reason: "setup_differs_from_completion" });
	});
});

type ReportedBinding = { state: "unbound" | "conflict" } | { state: "bound"; group_id: string };

describe("Team recovery preview refusals from the Team and its group", () => {
	const binding = (value: ReportedBinding) => ({
		groupBinding: { status: "read" as const, source: HERE, binding: { team_id: teamId, ...value } },
	});
	const recordOtherGroup = (): void => {
		run(
			`INSERT INTO policy_team_coordinator_links(team_id, coordinator_id, group_id, source, recorded_at)
			 VALUES (?, ?, 'group-other', 'coordinator_binding', ?)`,
			teamId,
			COORDINATOR_ID,
			NOW,
		);
	};
	const nothing = (): void => undefined;
	const groupCases: Array<[string, () => void, ReportedBinding, string]> = [
		[
			"this machine recorded another group for the Team",
			recordOtherGroup,
			{ state: "unbound" },
			"team_group_conflict",
		],
		["the coordinator reports a conflict", nothing, { state: "conflict" }, "team_group_conflict"],
		[
			"the coordinator bound the Team to another group",
			nothing,
			{ state: "bound", group_id: "group-other" },
			"team_group_mismatch",
		],
	];

	it.each(groupCases)("refuses when %s", (_case, arrange, reported, reason) => {
		arrange();

		expect(preview(binding(reported))).toEqual({ state: "refused", reason });
	});

	it("refuses a binding reported for another Team, and accepts one to the setup's group", () => {
		const other = {
			status: "read" as const,
			source: HERE,
			binding: { team_id: "team-other", state: "unbound" as const },
		};

		expect(preview({ groupBinding: other })).toMatchObject({ reason: "team_group_unavailable" });
		expect(preview(binding({ state: "bound", group_id: GROUP_ID })).state).toBe("ready");
	});

	it.each([
		[
			"active",
			"UPDATE policy_teams SET status = 'active', migration_state = 'completed'",
			"team_not_quarantined",
		],
		["archived", "UPDATE policy_teams SET status = 'archived'", "team_not_quarantined"],
		[
			"not from a reviewed setup",
			"UPDATE policy_teams SET provenance = 'user'",
			"team_not_quarantined",
		],
		["unknown here", "DELETE FROM policy_teams", "team_not_found"],
		[
			"missing its completion record",
			"DELETE FROM legacy_team_setup_completions",
			"setup_record_missing",
		],
		[
			"completed for another Team",
			"UPDATE legacy_team_setup_drafts SET completed_team_id = NULL",
			"setup_record_missing",
		],
		[
			"completed from another group",
			"UPDATE legacy_team_setup_drafts SET group_id = 'group-other'",
			"setup_record_missing",
		],
	])("refuses a Team that is %s", (_case, sql, reason) => {
		run(sql);

		expect(preview()).toEqual({ state: "refused", reason });
	});

	it("refuses another group's Team and an unusable group", () => {
		const other = previewTeamRecovery(db, { ...TARGET, groupId: "group-other" }, evidence());
		const invalid = previewTeamRecovery(db, { ...TARGET, groupId: "" }, evidence());

		expect(other).toEqual({ state: "refused", reason: "team_not_found" });
		expect(invalid).toEqual({ state: "refused", reason: "invalid_input" });
	});
});

describe("Team recovery preview of a store from before recovery exclusions", () => {
	it("previews the Team as it does with no exclusions", () => {
		// Arrange: a read-only connection to an older store adds no tables.
		const expected = ready();
		db.exec("DROP TABLE policy_team_recovery_exclusions");

		expect(ready()).toEqual(expected);
	});
});
