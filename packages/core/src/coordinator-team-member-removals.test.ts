import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeBaseSchema } from "./better-sqlite-coordinator-store.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	TEAM_MEMBER_REMOVAL_MIGRATION_NAME,
	TEAM_MEMBER_REMOVAL_OBJECTS,
	TEAM_MEMBER_REMOVAL_SCHEMA_SQL,
	TEAM_MEMBER_REMOVAL_STORAGE_PRESENT_SQL,
} from "./coordinator-team-member-removals.js";
import {
	registerTeamMemberRemovalContract,
	TEAM_MEMBER_REMOVAL_CLOCK_MS,
	teamMemberRemovalHarness,
} from "./coordinator-team-member-removals-test-harness.js";

const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
/** Drops every object of migration 0052, dependents first. */
const dropTeamMemberRemovalStorage = (db: Database.Database) => {
	for (const { type, name } of TEAM_MEMBER_REMOVAL_OBJECTS.toReversed())
		db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`);
};
const present = (db: Database.Database) =>
	db.prepare(TEAM_MEMBER_REMOVAL_STORAGE_PRESENT_SQL).pluck().get();

it("ships the same SQL in SQLite, migration 0052, and the Worker schema", () => {
	const migration = readFileSync(
		new URL(`migrations/${TEAM_MEMBER_REMOVAL_MIGRATION_NAME}`, worker),
		"utf8",
	);
	expect(migration).toBe(TEAM_MEMBER_REMOVAL_SCHEMA_SQL);
	expect(readFileSync(new URL("schema.sql", worker), "utf8")).toContain(
		TEAM_MEMBER_REMOVAL_SCHEMA_SQL.trim(),
	);
	// Every statement only creates a new object, so applying it changes no existing row.
	for (const statement of migration.split("\n\n"))
		expect(statement).toMatch(/^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS /u);
});

describe.each(["SQLite", "D1"] as const)("%s Team member removal contract", (backend) => {
	let sequence = 0;
	const test = teamMemberRemovalHarness(async (use) => {
		const f = setupStore(backend, { authClock: () => TEAM_MEMBER_REMOVAL_CLOCK_MS });
		try {
			await use({
				store: f.store,
				prefix: `team-removal-${++sequence}`,
				exec: async (sql, ...values) => f.db.prepare(sql).run(...values),
			});
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerTeamMemberRemovalContract(test);
});

describe.each(["SQLite", "D1"] as const)(
	"%s coordinator without complete Team member removal storage",
	(backend) => {
		const key = { groupId: "group-a", teamId: "team-a", identityId: "identity:a" };

		it.each([
			["no storage", dropTeamMemberRemovalStorage],
			[
				"a table without its delete guard",
				(db: Database.Database) =>
					db.exec("DROP TRIGGER coordinator_team_member_removal_no_delete"),
			],
			[
				"a delete guard of the right name that guards nothing",
				(db: Database.Database) =>
					db.exec(`DROP TRIGGER coordinator_team_member_removal_no_delete;
					CREATE TRIGGER coordinator_team_member_removal_no_delete
					BEFORE DELETE ON coordinator_team_member_removals WHEN 0 BEGIN SELECT 1; END`),
			],
			[
				"a member index that is not unique",
				(db: Database.Database) =>
					db.exec(`DROP INDEX idx_coordinator_team_member_removals_member;
					CREATE INDEX idx_coordinator_team_member_removals_member
					 ON coordinator_team_member_removals (group_id, team_id, identity_id)`),
			],
		])("answers unavailable with %s and writes nothing", async (_name, damage) => {
			const f = setupStore(backend);
			try {
				await f.store.createGroup(key.groupId);
				damage(f.db);
				expect(present(f.db)).toBe(0);

				await expect(f.store.recordTeamMemberRemoval(key)).rejects.toThrow(
					"team_member_removal_unavailable",
				);
				await expect(f.store.listTeamMemberRemovals({ groupId: key.groupId })).rejects.toThrow(
					"team_member_removal_unavailable",
				);
				const table = f.db
					.prepare(
						"SELECT COUNT(*) FROM sqlite_master WHERE name = 'coordinator_team_member_removals'",
					)
					.pluck()
					.get();
				if (table === 1)
					expect(
						f.db.prepare("SELECT COUNT(*) FROM coordinator_team_member_removals").pluck().get(),
					).toBe(0);
			} finally {
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		});
	},
);

describe("Team member removal storage on the SQLite coordinator", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(":memory:");
	});
	afterEach(() => db.close());

	it("is added to a database from an earlier release without changing its other objects or rows", () => {
		initializeBaseSchema(db);
		dropTeamMemberRemovalStorage(db);
		db.exec(`INSERT INTO groups(group_id, created_at) VALUES ('prior-group', 'fixture-time');
			INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at, invite_kind, policy_team_id)
			VALUES ('prior-invite', 'prior-group', 'prior-token', 'auto_admit', 'later', 'fixture-time', 'team_member', 'team-a');`);
		const snapshot = () => ({
			schema: db
				.prepare(
					"SELECT name, sql FROM sqlite_master WHERE name NOT LIKE '%team_member%' AND name <> 'sqlite_sequence' ORDER BY name",
				)
				.all(),
			groups: db.prepare("SELECT * FROM groups").all(),
			invites: db.prepare("SELECT * FROM coordinator_invites").all(),
		});
		const before = snapshot();
		expect(present(db)).toBe(0);

		initializeBaseSchema(db);

		expect(present(db)).toBe(1);
		expect(snapshot()).toEqual(before);
	});

	it("keeps stored removals when the database is opened again", () => {
		initializeBaseSchema(db);
		db.exec(`INSERT INTO coordinator_team_member_removals
			(group_id, team_id, identity_id, removed_by_device_id, removed_at)
			VALUES ('group-a', 'team-a', 'identity:a', NULL, 'fixture-time')`);

		initializeBaseSchema(db);

		expect(db.prepare("SELECT identity_id FROM coordinator_team_member_removals").all()).toEqual([
			{ identity_id: "identity:a" },
		]);
	});

	it("does not replace an altered guard on opening, and stays unavailable", () => {
		initializeBaseSchema(db);
		db.exec(`DROP TRIGGER coordinator_team_member_removal_no_update;
			CREATE TRIGGER coordinator_team_member_removal_no_update
			BEFORE UPDATE ON coordinator_team_member_removals WHEN 0 BEGIN SELECT 1; END`);

		initializeBaseSchema(db);

		expect(present(db)).toBe(0);
	});
});

describe("writers of Team member removals", () => {
	it("are the Team member module alone, never a trigger, so nothing else adds or lifts a removal", () => {
		const source = new URL("./", import.meta.url);
		const writers = readdirSync(source)
			.filter((name) => name.endsWith(".ts") && !name.includes(".test.") && !name.includes("test-"))
			.filter((name) =>
				/INSERT INTO (\$\{REMOVALS\}|coordinator_team_member_removals)/u.test(
					readFileSync(new URL(name, source), "utf8").replace(/\s+/gu, " "),
				),
			);

		expect(writers).toEqual(["coordinator-team-member-removals.ts"]);
		expect(TEAM_MEMBER_REMOVAL_SCHEMA_SQL).not.toMatch(/INSERT INTO|coordinator_invites/u);
	});
});
