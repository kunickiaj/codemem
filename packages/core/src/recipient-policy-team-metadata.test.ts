import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLegacyTeamSetupDraft } from "./legacy-team-setup-draft.js";
import { deterministicPolicyTeamId } from "./recipient-policy-identifiers.js";
import {
	claimRecipientPolicyActorMutations,
	renameRecipientPolicyTeam,
	serializeRecipientPolicyActorMutations,
	serializeRecipientPolicyPublicationMutation,
} from "./recipient-policy-team-metadata.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-26T12:00:00.000Z";
const LATER = "2026-08-26T13:00:00.000Z";

describe("recipient policy Team metadata", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	it("claims deduplicated actor locks in sorted order and releases them once", async () => {
		let releaseActorB: () => void = () => undefined;
		const actorBGate = new Promise<void>((resolve) => {
			releaseActorB = resolve;
		});
		const heldActorB = serializeRecipientPolicyActorMutations(db, ["actor-b"], () => actorBGate);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const releaseActorsPromise = claimRecipientPolicyActorMutations(db, [
			"actor-b",
			"actor-a",
			"actor-a",
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		let actorAStarted = false;
		let releaseActorA: () => void = () => undefined;
		const actorAGate = new Promise<void>((resolve) => {
			releaseActorA = resolve;
		});
		const heldActorA = serializeRecipientPolicyActorMutations(db, ["actor-a"], async () => {
			actorAStarted = true;
			await actorAGate;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(actorAStarted).toBe(false);

		releaseActorB();
		const releaseActors = await releaseActorsPromise;
		releaseActors();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(actorAStarted).toBe(true);

		let trailingActorAStarted = false;
		const trailingActorA = serializeRecipientPolicyActorMutations(db, ["actor-a"], async () => {
			trailingActorAStarted = true;
		});
		releaseActors();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(trailingActorAStarted).toBe(false);

		releaseActorA();
		await Promise.all([heldActorA, heldActorB, trailingActorA]);
		expect(trailingActorAStarted).toBe(true);
	});

	it("releases the publication barrier when an operation fails", async () => {
		await expect(
			serializeRecipientPolicyPublicationMutation(db, async () => {
				throw new Error("publication failed");
			}),
		).rejects.toThrow("publication failed");

		let nextOperationStarted = false;
		await serializeRecipientPolicyPublicationMutation(db, async () => {
			nextOperationStarted = true;
		});
		expect(nextOperationStarted).toBe(true);
	});

	function insertTeam(teamId = "team-local", displayName = "Old Team") {
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'active', 'user', 'revision-1', 'user_managed',
			 'roster-fingerprint', ?, ?, ?)`,
		).run(teamId, displayName, `team-key-${teamId}`, NOW, NOW);
	}

	function linkCompletedSetup(
		teamId: string,
		options: {
			attemptId?: string;
			candidateId?: string;
			coordinatorId?: string;
			groupId?: string;
		} = {},
	) {
		const candidateId =
			options.candidateId ?? "legacy-team-candidate:11111111111111111111111111111111";
		const attemptId = options.attemptId ?? "attempt-1";
		const coordinatorId = options.coordinatorId ?? "https://coordinator.example.test";
		const groupId = options.groupId ?? "group-one";
		expect(deterministicPolicyTeamId(candidateId)).toBe(teamId);
		db.prepare(
			`INSERT INTO legacy_team_setup_drafts(
			 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
			 roster_fingerprint, projection_fingerprint, finish_digest, completed_team_id,
			 created_at, updated_at, completed_at
			 ) VALUES (?, ?, ?, ?,
			 'completed', 'Old Team', 'roster', 'projection', 'finish', ?, ?, ?, ?)`,
		).run(attemptId, candidateId, coordinatorId, groupId, teamId, NOW, NOW, NOW);
		db.prepare(
			`INSERT INTO legacy_team_setup_completions(
			 attempt_id, finish_digest, candidate_ref, confirmed_access_delta_digest,
			 completed_team_id, response_json, completed_at, created_at
			 ) VALUES (?, 'finish', ?, 'access', ?, '{}', ?, ?)`,
		).run(attemptId, candidateId, teamId, NOW, NOW);
	}

	it("renames local metadata without touching coordinator linkage fields", async () => {
		insertTeam();
		const renameCoordinatorGroup = vi.fn();

		const result = await renameRecipientPolicyTeam(db, {
			teamId: "team-local",
			displayName: "  New   Team  ",
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [],
			renameCoordinatorGroup,
			now: LATER,
		});

		expect(result).toMatchObject({ displayName: "New Team", linkedCoordinatorGroupRenamed: false });
		expect(renameCoordinatorGroup).not.toHaveBeenCalled();
		expect(
			db
				.prepare(
					"SELECT display_name, revision, source_fingerprint, idempotency_key, updated_at FROM policy_teams",
				)
				.get(),
		).toEqual({
			display_name: "New Team",
			revision: result.revision,
			source_fingerprint: "roster-fingerprint",
			idempotency_key: "team-key-team-local",
			updated_at: LATER,
		});
		expect(result.revision).not.toBe("revision-1");
	});

	it("renames a proven configured coordinator group before local policy metadata", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId);
		db.prepare(
			`INSERT INTO legacy_team_setup_drafts(
			 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
			 roster_fingerprint, projection_fingerprint, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, 'in_progress', 'Old Team', 'repeat-roster', 'repeat-projection', ?, ?)`,
		).run("attempt-repeat", candidateId, "https://coordinator.example.test", "group-one", NOW, NOW);
		const renameCoordinatorGroup = vi.fn().mockResolvedValue(true);

		const result = await renameRecipientPolicyTeam(db, {
			teamId,
			displayName: "Linked Team",
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [
				{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
			],
			renameCoordinatorGroup,
			now: LATER,
		});

		expect(renameCoordinatorGroup).toHaveBeenCalledWith(
			{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
			"Linked Team",
		);
		expect(result.linkedCoordinatorGroupRenamed).toBe(true);
		expect(db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe("Linked Team");
		expect(
			db
				.prepare(
					"SELECT attempt_id, display_name FROM legacy_team_setup_drafts ORDER BY attempt_id",
				)
				.all(),
		).toEqual([
			{ attempt_id: "attempt-1", display_name: "Linked Team" },
			{ attempt_id: "attempt-repeat", display_name: "Linked Team" },
		]);
	});

	it("preserves a proven historical link when coordinator text is equivalent", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId, { coordinatorId: "https://COORDINATOR.example.test/" });
		linkCompletedSetup(teamId, {
			attemptId: "attempt-2",
			coordinatorId: "https://coordinator.example.test",
		});
		const renameCoordinatorGroup = vi.fn().mockResolvedValue(true);

		await expect(
			renameRecipientPolicyTeam(db, {
				teamId,
				displayName: "Equivalent Team",
				expectedDisplayName: "Old Team",
				configuredCoordinatorGroups: [
					{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
				],
				coordinatorIdsEquivalent: (left, right) =>
					left.toLowerCase().replace(/\/$/u, "") === right.toLowerCase().replace(/\/$/u, ""),
				renameCoordinatorGroup,
				now: LATER,
			}),
		).resolves.toMatchObject({ linkedCoordinatorGroupRenamed: true });
		expect(renameCoordinatorGroup).toHaveBeenCalledWith(
			{ coordinatorId: "https://COORDINATOR.example.test/", groupId: "group-one" },
			"Equivalent Team",
		);
		expect(
			db
				.prepare("SELECT DISTINCT display_name FROM legacy_team_setup_drafts ORDER BY display_name")
				.pluck()
				.all(),
		).toEqual(["Equivalent Team"]);
	});

	it("fails closed when coordinator equivalence does not prove the historical link", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId, { coordinatorId: "https://historical.example.test" });
		const renameCoordinatorGroup = vi.fn();

		await expect(
			renameRecipientPolicyTeam(db, {
				teamId,
				displayName: "Unproven Team",
				expectedDisplayName: "Old Team",
				configuredCoordinatorGroups: [
					{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
				],
				coordinatorIdsEquivalent: (left, right) => left === right,
				renameCoordinatorGroup,
			}),
		).rejects.toMatchObject({ code: "team_link_stale" });
		expect(renameCoordinatorGroup).not.toHaveBeenCalled();
	});

	it("keeps local metadata unchanged when the coordinator rename fails and retries safely", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId);
		const renameCoordinatorGroup = vi
			.fn()
			.mockRejectedValueOnce(new Error("private coordinator detail"))
			.mockResolvedValue(true);
		const input = {
			teamId,
			displayName: "Retry Team",
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [
				{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
			],
			renameCoordinatorGroup,
			now: LATER,
		};

		await expect(renameRecipientPolicyTeam(db, input)).rejects.toMatchObject({
			code: "team_coordinator_rename_failed",
		});
		expect(db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe("Old Team");
		await expect(renameRecipientPolicyTeam(db, input)).resolves.toMatchObject({
			displayName: "Retry Team",
		});
		await expect(renameRecipientPolicyTeam(db, input)).resolves.toMatchObject({
			displayName: "Retry Team",
		});
		expect(renameCoordinatorGroup).toHaveBeenCalledTimes(3);
	});

	it("verifies same-name linked retries with the coordinator while local retries stay cheap", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId, "Current Team");
		linkCompletedSetup(teamId);
		db.prepare("UPDATE legacy_team_setup_drafts SET display_name = 'Current Team'").run();
		const linkedRename = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const linkedInput = {
			teamId,
			displayName: "Current Team",
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [
				{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
			],
			renameCoordinatorGroup: linkedRename,
		};

		await expect(renameRecipientPolicyTeam(db, linkedInput)).resolves.toMatchObject({
			linkedCoordinatorGroupRenamed: true,
		});
		await expect(renameRecipientPolicyTeam(db, linkedInput)).rejects.toMatchObject({
			code: "team_coordinator_rename_failed",
		});
		expect(linkedRename).toHaveBeenCalledTimes(2);

		insertTeam("team-local-same", "Current Team");
		const localRename = vi.fn();
		await expect(
			renameRecipientPolicyTeam(db, {
				teamId: "team-local-same",
				displayName: "Current Team",
				expectedDisplayName: "Old Team",
				configuredCoordinatorGroups: [],
				renameCoordinatorGroup: localRename,
			}),
		).resolves.toMatchObject({ linkedCoordinatorGroupRenamed: false });
		expect(localRename).not.toHaveBeenCalled();
	});

	it("reports a pending local rename after coordinator success and completes on retry", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId);
		db.exec(`CREATE TRIGGER reject_team_rename BEFORE UPDATE ON policy_teams
			BEGIN SELECT RAISE(FAIL, 'local write failed'); END;`);
		const renameCoordinatorGroup = vi.fn().mockResolvedValue(true);
		const input = {
			teamId,
			displayName: "Recovered Team",
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [
				{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
			],
			renameCoordinatorGroup,
			now: LATER,
		};

		await expect(renameRecipientPolicyTeam(db, input)).rejects.toMatchObject({
			code: "team_local_rename_pending",
		});
		expect(db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe("Old Team");
		db.exec("DROP TRIGGER reject_team_rename");
		await expect(renameRecipientPolicyTeam(db, input)).resolves.toMatchObject({
			displayName: "Recovered Team",
		});
		expect(renameCoordinatorGroup).toHaveBeenCalledTimes(2);
	});

	it("does not infer a migrated coordinator link from a matching label", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId, "Same Label");
		linkCompletedSetup(teamId);
		const renameCoordinatorGroup = vi.fn();

		await expect(
			renameRecipientPolicyTeam(db, {
				teamId,
				displayName: "New Team",
				expectedDisplayName: "Same Label",
				configuredCoordinatorGroups: [
					{ coordinatorId: "https://other.example.test", groupId: "Same Label" },
				],
				renameCoordinatorGroup,
			}),
		).rejects.toMatchObject({ code: "team_link_stale" });
		expect(renameCoordinatorGroup).not.toHaveBeenCalled();
		expect(db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe("Same Label");
	});

	it("fails closed when completed history proves more than one configured link", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId);
		linkCompletedSetup(teamId, {
			attemptId: "attempt-2",
			coordinatorId: "https://other.example.test",
			groupId: "group-two",
		});
		const renameCoordinatorGroup = vi.fn();

		await expect(
			renameRecipientPolicyTeam(db, {
				teamId,
				displayName: "New Team",
				expectedDisplayName: "Old Team",
				configuredCoordinatorGroups: [
					{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
					{ coordinatorId: "https://other.example.test", groupId: "group-two" },
				],
				renameCoordinatorGroup,
			}),
		).rejects.toMatchObject({ code: "team_link_ambiguous" });
		expect(renameCoordinatorGroup).not.toHaveBeenCalled();
		expect(db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe("Old Team");
	});

	it("rejects active Teams that alias the same coordinator group", async () => {
		const firstCandidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const secondCandidateId = "legacy-team-candidate:22222222222222222222222222222222";
		const firstTeamId = deterministicPolicyTeamId(firstCandidateId);
		const secondTeamId = deterministicPolicyTeamId(secondCandidateId);
		insertTeam(firstTeamId, "First Team");
		insertTeam(secondTeamId, "Second Team");
		linkCompletedSetup(firstTeamId, {
			candidateId: firstCandidateId,
			coordinatorId: "https://COORDINATOR.example.test/",
		});
		linkCompletedSetup(secondTeamId, {
			attemptId: "attempt-2",
			candidateId: secondCandidateId,
			coordinatorId: "https://coordinator.example.test",
		});
		const renameCoordinatorGroup = vi.fn();
		const coordinatorIdsEquivalent = (left: string, right: string) =>
			left.toLowerCase().replace(/\/$/u, "") === right.toLowerCase().replace(/\/$/u, "");
		const configuredCoordinatorGroups = [
			{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
		];

		for (const [teamId, expectedDisplayName] of [
			[firstTeamId, "First Team"],
			[secondTeamId, "Second Team"],
		] as const) {
			await expect(
				renameRecipientPolicyTeam(db, {
					teamId,
					displayName: "Renamed Team",
					expectedDisplayName,
					configuredCoordinatorGroups,
					coordinatorIdsEquivalent,
					renameCoordinatorGroup,
				}),
			).rejects.toMatchObject({ code: "team_link_ambiguous" });
		}
		expect(renameCoordinatorGroup).not.toHaveBeenCalled();
		expect(
			db.prepare("SELECT display_name FROM policy_teams ORDER BY display_name").pluck().all(),
		).toEqual(["First Team", "Second Team"]);
	});

	it("ignores an inactive Team with an equivalent historical coordinator link", async () => {
		const activeCandidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const inactiveCandidateId = "legacy-team-candidate:22222222222222222222222222222222";
		const activeTeamId = deterministicPolicyTeamId(activeCandidateId);
		const inactiveTeamId = deterministicPolicyTeamId(inactiveCandidateId);
		insertTeam(activeTeamId, "Active Team");
		insertTeam(inactiveTeamId, "Archived Team");
		db.prepare("UPDATE policy_teams SET status = 'archived' WHERE team_id = ?").run(inactiveTeamId);
		linkCompletedSetup(activeTeamId, { candidateId: activeCandidateId });
		linkCompletedSetup(inactiveTeamId, {
			attemptId: "attempt-2",
			candidateId: inactiveCandidateId,
			coordinatorId: "https://COORDINATOR.example.test/",
		});
		const renameCoordinatorGroup = vi.fn().mockResolvedValue(true);

		await expect(
			renameRecipientPolicyTeam(db, {
				teamId: activeTeamId,
				displayName: "Renamed Team",
				expectedDisplayName: "Active Team",
				configuredCoordinatorGroups: [
					{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
				],
				coordinatorIdsEquivalent: (left, right) =>
					left.toLowerCase().replace(/\/$/u, "") === right.toLowerCase().replace(/\/$/u, ""),
				renameCoordinatorGroup,
			}),
		).resolves.toMatchObject({ displayName: "Renamed Team" });
		expect(renameCoordinatorGroup).toHaveBeenCalledOnce();
	});

	it("rejects a possible active Team link when coordinator comparison fails", async () => {
		const firstCandidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const secondCandidateId = "legacy-team-candidate:22222222222222222222222222222222";
		const firstTeamId = deterministicPolicyTeamId(firstCandidateId);
		const secondTeamId = deterministicPolicyTeamId(secondCandidateId);
		insertTeam(firstTeamId, "First Team");
		insertTeam(secondTeamId, "Second Team");
		linkCompletedSetup(firstTeamId, {
			candidateId: firstCandidateId,
			coordinatorId: "https://coordinator-one.example.test",
		});
		linkCompletedSetup(secondTeamId, {
			attemptId: "attempt-2",
			candidateId: secondCandidateId,
			coordinatorId: "https://coordinator-two.example.test",
		});
		const renameCoordinatorGroup = vi.fn();

		await expect(
			renameRecipientPolicyTeam(db, {
				teamId: firstTeamId,
				displayName: "Renamed Team",
				expectedDisplayName: "First Team",
				configuredCoordinatorGroups: [
					{ coordinatorId: "https://coordinator-one.example.test", groupId: "group-one" },
				],
				coordinatorIdsEquivalent: () => {
					throw new Error("comparison unavailable");
				},
				renameCoordinatorGroup,
			}),
		).rejects.toMatchObject({ code: "team_link_ambiguous" });
		expect(renameCoordinatorGroup).not.toHaveBeenCalled();
		expect(
			db
				.prepare("SELECT display_name FROM policy_teams WHERE team_id = ?")
				.pluck()
				.get(firstTeamId),
		).toBe("First Team");
	});

	it("rejects a rename when a conflicting Team link appears during the remote mutation", async () => {
		const firstCandidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const secondCandidateId = "legacy-team-candidate:22222222222222222222222222222222";
		const firstTeamId = deterministicPolicyTeamId(firstCandidateId);
		const secondTeamId = deterministicPolicyTeamId(secondCandidateId);
		insertTeam(firstTeamId, "First Team");
		linkCompletedSetup(firstTeamId, {
			candidateId: firstCandidateId,
			coordinatorId: "https://COORDINATOR.example.test/",
		});
		const renameCoordinatorGroup = vi.fn().mockImplementation(async () => {
			insertTeam(secondTeamId, "Second Team");
			linkCompletedSetup(secondTeamId, {
				attemptId: "attempt-2",
				candidateId: secondCandidateId,
				coordinatorId: "https://coordinator.example.test",
			});
			return true;
		});

		await expect(
			renameRecipientPolicyTeam(db, {
				teamId: firstTeamId,
				displayName: "Renamed Team",
				expectedDisplayName: "First Team",
				configuredCoordinatorGroups: [
					{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
				],
				coordinatorIdsEquivalent: (left, right) =>
					left.toLowerCase().replace(/\/$/u, "") === right.toLowerCase().replace(/\/$/u, ""),
				renameCoordinatorGroup,
			}),
		).rejects.toMatchObject({ code: "team_link_ambiguous" });
		expect(
			db
				.prepare("SELECT display_name FROM policy_teams WHERE team_id = ?")
				.pluck()
				.get(firstTeamId),
		).toBe("First Team");
	});

	it("preserves post-coordinator CAS conflicts as stale", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId);
		const renameCoordinatorGroup = vi.fn().mockImplementation(async () => {
			db.prepare("UPDATE policy_teams SET revision = 'concurrent-revision' WHERE team_id = ?").run(
				teamId,
			);
			return true;
		});

		await expect(
			renameRecipientPolicyTeam(db, {
				teamId,
				displayName: "New Team",
				expectedDisplayName: "Old Team",
				configuredCoordinatorGroups: [
					{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
				],
				renameCoordinatorGroup,
			}),
		).rejects.toMatchObject({ code: "team_rename_stale" });
		expect(db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe("Old Team");
	});

	it("serializes concurrent linked renames before changing the coordinator", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId);
		let finishFirstRename = () => undefined;
		const firstRenamePending = new Promise<void>((resolve) => {
			finishFirstRename = resolve;
		});
		const renameCoordinatorGroup = vi
			.fn()
			.mockImplementationOnce(async () => {
				await firstRenamePending;
				return true;
			})
			.mockResolvedValue(true);
		const base = {
			teamId,
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [
				{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
			],
			renameCoordinatorGroup,
			now: LATER,
		};

		const first = renameRecipientPolicyTeam(db, { ...base, displayName: "First Team" });
		await vi.waitFor(() => expect(renameCoordinatorGroup).toHaveBeenCalledTimes(1));
		const second = renameRecipientPolicyTeam(db, { ...base, displayName: "Second Team" });
		await Promise.resolve();
		expect(renameCoordinatorGroup).toHaveBeenCalledTimes(1);
		finishFirstRename();

		await expect(first).resolves.toMatchObject({ displayName: "First Team" });
		await expect(second).rejects.toMatchObject({ code: "team_rename_stale" });
		expect(renameCoordinatorGroup).toHaveBeenCalledTimes(1);
		expect(db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe("First Team");
	});

	it("does not serialize independent Team renames through a global lock", async () => {
		const firstCandidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const secondCandidateId = "legacy-team-candidate:22222222222222222222222222222222";
		const firstTeamId = deterministicPolicyTeamId(firstCandidateId);
		const secondTeamId = deterministicPolicyTeamId(secondCandidateId);
		insertTeam(firstTeamId);
		insertTeam(secondTeamId);
		linkCompletedSetup(firstTeamId, { candidateId: firstCandidateId });
		linkCompletedSetup(secondTeamId, {
			attemptId: "attempt-2",
			candidateId: secondCandidateId,
			groupId: "group-two",
		});
		let finishFirstRename = () => undefined;
		const firstRenamePending = new Promise<void>((resolve) => {
			finishFirstRename = resolve;
		});
		const firstCoordinatorRename = vi.fn(async () => {
			await firstRenamePending;
			return true;
		});
		const secondCoordinatorRename = vi.fn().mockResolvedValue(true);

		const first = renameRecipientPolicyTeam(db, {
			teamId: firstTeamId,
			displayName: "First Team",
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [
				{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
			],
			renameCoordinatorGroup: firstCoordinatorRename,
		});
		await vi.waitFor(() => expect(firstCoordinatorRename).toHaveBeenCalledOnce());
		const second = renameRecipientPolicyTeam(db, {
			teamId: secondTeamId,
			displayName: "Second Team",
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [
				{ coordinatorId: "https://coordinator.example.test", groupId: "group-two" },
			],
			renameCoordinatorGroup: secondCoordinatorRename,
		});

		await vi.waitFor(() => expect(secondCoordinatorRename).toHaveBeenCalledOnce());
		finishFirstRename();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
	});

	it("updates every repeated completed draft for the exact proven historical link", async () => {
		const candidateId = "legacy-team-candidate:11111111111111111111111111111111";
		const teamId = deterministicPolicyTeamId(candidateId);
		insertTeam(teamId);
		linkCompletedSetup(teamId);
		linkCompletedSetup(teamId, { attemptId: "attempt-2" });

		await renameRecipientPolicyTeam(db, {
			teamId,
			displayName: "Historical Team",
			expectedDisplayName: "Old Team",
			configuredCoordinatorGroups: [
				{ coordinatorId: "https://coordinator.example.test", groupId: "group-one" },
			],
			renameCoordinatorGroup: vi.fn().mockResolvedValue(true),
			now: LATER,
		});

		expect(
			db
				.prepare(
					`SELECT attempt_id, display_name, state, roster_fingerprint,
					 projection_fingerprint, finish_digest FROM legacy_team_setup_drafts
					 ORDER BY attempt_id`,
				)
				.all(),
		).toEqual([
			{
				attempt_id: "attempt-1",
				display_name: "Historical Team",
				state: "completed",
				roster_fingerprint: "roster",
				projection_fingerprint: "projection",
				finish_digest: "finish",
			},
			{
				attempt_id: "attempt-2",
				display_name: "Historical Team",
				state: "completed",
				roster_fingerprint: "roster",
				projection_fingerprint: "projection",
				finish_digest: "finish",
			},
		]);
		expect(getLegacyTeamSetupDraft(db, candidateId)).toMatchObject({
			displayName: "Historical Team",
			state: "completed",
		});
	});

	it.each([
		["", "team_name_invalid"],
		["actor:machine", "team_name_invalid"],
	])("rejects invalid presentation name %j", async (displayName, code) => {
		insertTeam();
		await expect(
			renameRecipientPolicyTeam(db, {
				teamId: "team-local",
				displayName,
				expectedDisplayName: "Old Team",
				configuredCoordinatorGroups: [],
				renameCoordinatorGroup: vi.fn(),
			}),
		).rejects.toMatchObject({ code });
	});

	it("fails unknown and stale Teams without mutation", async () => {
		insertTeam();
		const base = {
			displayName: "New Team",
			expectedDisplayName: "Stale Team",
			configuredCoordinatorGroups: [],
			renameCoordinatorGroup: vi.fn(),
		};
		await expect(
			renameRecipientPolicyTeam(db, { ...base, teamId: "missing" }),
		).rejects.toMatchObject({ code: "team_not_found" });
		await expect(
			renameRecipientPolicyTeam(db, { ...base, teamId: "team-local" }),
		).rejects.toMatchObject({ code: "team_rename_stale" });
		expect(db.prepare("SELECT display_name FROM policy_teams").pluck().get()).toBe("Old Team");
	});
});
