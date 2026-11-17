import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
import {
	createRecipientPolicyTeam,
	RecipientPolicyTeamCreateError,
} from "./recipient-policy-team-create.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-17T12:00:00.000Z";

function insertActor(db: InstanceType<typeof Database>, actorId: string, status = "active"): void {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, ?, 1, ?, ?, ?)`,
	).run(actorId, "Alex", status, NOW, NOW);
}

function createError(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof RecipientPolicyTeamCreateError) return error.code;
		throw error;
	}
	throw new Error("expected createRecipientPolicyTeam to fail");
}

describe("createRecipientPolicyTeam", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		insertActor(db, "identity-alex");
	});

	afterEach(() => db.close());

	it("creates an active Team with its creator as the only admin member", () => {
		// Act
		const result = createRecipientPolicyTeam(db, {
			displayName: "  Platform  ",
			creatorIdentityId: "identity-alex",
			now: NOW,
			teamId: "team-platform",
		});

		// Assert
		expect(result).toEqual({ version: 1, teamId: "team-platform", displayName: "Platform" });
		const intent = listRecipientPolicyIntent(db);
		expect(intent.teams).toEqual([
			expect.objectContaining({
				teamId: "team-platform",
				displayName: "Platform",
				status: "active",
			}),
		]);
		expect(intent.teamMemberships).toEqual([
			expect.objectContaining({
				teamId: "team-platform",
				identityId: "identity-alex",
				role: "admin",
				status: "active",
			}),
		]);
	});

	it("shares no Project with the new Team", () => {
		createRecipientPolicyTeam(db, {
			displayName: "Platform",
			creatorIdentityId: "identity-alex",
			now: NOW,
		});

		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
	});

	it("generates distinct Team IDs", () => {
		const first = createRecipientPolicyTeam(db, {
			displayName: "Platform",
			creatorIdentityId: "identity-alex",
			now: NOW,
		});
		const second = createRecipientPolicyTeam(db, {
			displayName: "Docs",
			creatorIdentityId: "identity-alex",
			now: NOW,
		});

		expect(first.teamId).not.toBe(second.teamId);
		expect(first.teamId).toMatch(/^team-/);
	});
});

describe("createRecipientPolicyTeam names", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		insertActor(db, "identity-alex");
	});

	afterEach(() => db.close());

	it.each(["", "   ", "actor:machine", "x".repeat(121), "Bad\u0000Name"])(
		"rejects the Team name %j",
		(displayName) => {
			expect(
				createError(() =>
					createRecipientPolicyTeam(db, {
						displayName,
						creatorIdentityId: "identity-alex",
						now: NOW,
					}),
				),
			).toBe("team_name_invalid");
			expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		},
	);

	it.each([
		["Platform", "platform"],
		["Équipe", "équipe"],
		["ÖKO", "öko"],
	])("rejects %j when an active Team is named %j, ignoring case", (existing, requested) => {
		createRecipientPolicyTeam(db, {
			displayName: existing,
			creatorIdentityId: "identity-alex",
			now: NOW,
		});

		expect(
			createError(() =>
				createRecipientPolicyTeam(db, {
					displayName: requested,
					creatorIdentityId: "identity-alex",
					now: NOW,
				}),
			),
		).toBe("team_name_taken");
	});

	it("rejects a name an active Team already uses, ignoring case", () => {
		createRecipientPolicyTeam(db, {
			displayName: "Platform",
			creatorIdentityId: "identity-alex",
			now: NOW,
		});

		expect(
			createError(() =>
				createRecipientPolicyTeam(db, {
					displayName: "platform",
					creatorIdentityId: "identity-alex",
					now: NOW,
				}),
			),
		).toBe("team_name_taken");
	});

	it.each([
		["missing", "identity-missing"],
		["deactivated", "identity-deactivated"],
		["another device's", "identity-remote"],
	])("rejects a %s creator without writing anything", (_label, creatorIdentityId) => {
		insertActor(db, "identity-deactivated", "deactivated");
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-remote', 'Brian', 0, 'active', ?, ?)`,
		).run(NOW, NOW);

		expect(
			createError(() =>
				createRecipientPolicyTeam(db, { displayName: "Platform", creatorIdentityId, now: NOW }),
			),
		).toBe("team_creator_unavailable");
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get()).toBe(0);
	});
});
