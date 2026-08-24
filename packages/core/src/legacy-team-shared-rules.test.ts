import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	latestLegacyTeamSetupAttempt,
	legacyTeamSetupAttemptCurrentness,
} from "./legacy-team-setup-attempt.js";
import {
	LEGACY_TEAM_SETUP_API_ERROR_BY_CORE_ERROR,
	legacyTeamSetupApiErrorCode,
} from "./legacy-team-setup-errors.js";
import {
	activeUnmergedActorIds,
	activeUnmergedActorIdsFor,
	isActiveUnmergedActor,
	isActiveUnmergedLocalActor,
	preferredActiveUnmergedLocalActorId,
} from "./recipient-policy-actor-eligibility.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-23T12:00:00.000Z";

describe("legacy Team shared setup rules", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	it("selects latest attempt and currentness by rowid rather than timestamps", () => {
		const insert = db.prepare(
			`INSERT INTO legacy_team_setup_drafts(
			 attempt_id, candidate_id, coordinator_id, group_id, display_name,
			 roster_fingerprint, projection_fingerprint, created_at, updated_at
			 ) VALUES (?, ?, 'coordinator-a', 'group-a', 'Team', 'roster', 'projects', ?, ?)`,
		);
		insert.run("attempt-old", "candidate-a", "2099-01-01T00:00:00.000Z", NOW);
		insert.run("attempt-new", "candidate-a", "2000-01-01T00:00:00.000Z", NOW);
		insert.run("attempt-b", "candidate-b", "2000-01-01T00:00:00.000Z", NOW);

		expect(latestLegacyTeamSetupAttempt(db, "candidate-a")).toEqual({
			attemptId: "attempt-new",
			candidateId: "candidate-a",
			isCurrent: true,
		});
		expect(legacyTeamSetupAttemptCurrentness(db, "attempt-old")?.isCurrent).toBe(false);
		expect(legacyTeamSetupAttemptCurrentness(db, "attempt-new")?.isCurrent).toBe(true);
		expect(latestLegacyTeamSetupAttempt(db, "candidate-b")?.attemptId).toBe("attempt-b");
	});

	it("uses one active-unmerged actor rule and requires local attribution explicitly", () => {
		db.prepare(
			`INSERT INTO actors(
			 actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
			 ) VALUES
			 ('local-active', 'Local', 1, 'active', NULL, ?, ?),
			 ('remote-active', 'Remote', 0, 'active', NULL, ?, ?),
			 ('local-merged', 'Merged', 1, 'active', 'local-active', ?, ?),
			 ('local-inactive', 'Inactive', 1, 'deactivated', NULL, ?, ?)`,
		).run(NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW);

		expect(activeUnmergedActorIds(db)).toEqual(["local-active", "remote-active"]);
		expect(
			activeUnmergedActorIdsFor(db, [
				"remote-active",
				"local-merged",
				"missing",
				"local-active",
				"remote-active",
			]),
		).toEqual(["local-active", "remote-active"]);
		expect(activeUnmergedActorIdsFor(db, [])).toEqual([]);
		expect(isActiveUnmergedActor(db, "remote-active")).toBe(true);
		expect(isActiveUnmergedLocalActor(db, "remote-active")).toBe(false);
		expect(isActiveUnmergedLocalActor(db, "local-merged")).toBe(false);
		expect(isActiveUnmergedActor(db, "local-inactive")).toBe(false);
	});

	it("selects one preferred active local actor with a bounded query", () => {
		db.prepare(
			`INSERT INTO actors(
			 actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
			 ) VALUES
			 ('local-a', 'A', 1, 'active', NULL, ?, ?),
			 ('local-b', 'B', 1, 'active', NULL, ?, ?),
			 ('local-merged', 'Merged', 1, 'active', 'local-a', ?, ?),
			 ('remote-preferred', 'Remote', 0, 'active', NULL, ?, ?)`,
		).run(NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW);
		const prepare = vi.spyOn(db, "prepare");

		expect(preferredActiveUnmergedLocalActorId(db, "local-b", "local-a")).toBe("local-b");
		expect(preferredActiveUnmergedLocalActorId(db, "missing", "local-a")).toBe("local-a");
		expect(preferredActiveUnmergedLocalActorId(db, "missing", "also-missing")).toBe("local-a");
		const selectionSql = prepare.mock.calls
			.map(([sql]) => String(sql))
			.filter((sql) => /SELECT .* FROM actors/u.test(sql));
		expect(selectionSql.length).toBeGreaterThan(0);
		expect(selectionSql.every((sql) => /LIMIT 1/u.test(sql))).toBe(true);

		db.prepare("UPDATE actors SET status = 'deactivated' WHERE is_local = 1").run();
		expect(preferredActiveUnmergedLocalActorId(db, "local-b", "local-a")).toBeNull();
	});

	it("maps released draft and activation errors to a bounded API vocabulary", () => {
		expect(legacyTeamSetupApiErrorCode(new Error("legacy_team_setup_draft_not_found"))).toBe(
			"team_setup_confirmation_stale",
		);
		expect(legacyTeamSetupApiErrorCode("legacy_team_setup_assignment_changed")).toBe(
			"team_setup_assignment_changed",
		);
		expect(legacyTeamSetupApiErrorCode(new Error("team_setup_roster_unavailable"))).toBe(
			"team_setup_roster_unavailable",
		);
		expect(legacyTeamSetupApiErrorCode(new Error("legacy_team_setup_roster_too_large"))).toBe(
			"team_setup_roster_unavailable",
		);
		expect(legacyTeamSetupApiErrorCode({ code: "legacy_team_setup_roster_conflict" })).toBe(
			"team_setup_conflict",
		);
		expect(legacyTeamSetupApiErrorCode(new Error("raw sqlite details"))).toBe("team_setup_failed");
		expect(Object.values(LEGACY_TEAM_SETUP_API_ERROR_BY_CORE_ERROR)).not.toContain(
			"legacy_team_setup_draft_not_found",
		);
	});
});
