import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeBaseSchema } from "./better-sqlite-coordinator-store.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	TEAM_GROUP_BINDING_BACKFILL_CHECK_SQL,
	TEAM_GROUP_BINDING_BACKFILL_SQL,
	TEAM_GROUP_BINDING_MIGRATION_NAME,
	TEAM_GROUP_BINDING_MIGRATION_SQL,
	TEAM_GROUP_BINDING_OBJECTS,
	TEAM_GROUP_BINDING_SCHEMA_SQL,
	TEAM_GROUP_BINDING_STORAGE_PRESENT_SQL,
} from "./coordinator-team-group-bindings.js";
import {
	registerTeamGroupBindingContract,
	TEAM_GROUP_BINDING_CLOCK_MS,
	teamGroupBindingHarness,
} from "./coordinator-team-group-bindings-test-harness.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";

const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
/** Drops every object of migration 0053, dependents first. */
const dropStorage = (db: Database.Database) => {
	for (const { type, name } of TEAM_GROUP_BINDING_OBJECTS.toReversed())
		db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`);
};
const present = (db: Database.Database) =>
	db.prepare(TEAM_GROUP_BINDING_STORAGE_PRESENT_SQL).pluck().get();

it("ships the same SQL in SQLite, migration 0053, and the Worker schema", () => {
	const migration = readFileSync(
		new URL(`migrations/${TEAM_GROUP_BINDING_MIGRATION_NAME}`, worker),
		"utf8",
	);
	expect(migration).toBe(TEAM_GROUP_BINDING_MIGRATION_SQL);
	expect(readFileSync(new URL("schema.sql", worker), "utf8")).toContain(
		TEAM_GROUP_BINDING_SCHEMA_SQL.trim(),
	);
	// Every statement creates a new object, except the backfill, which only adds bindings.
	const statements = migration.trim().split("\n\n");
	expect(statements.slice(-2)).toEqual([
		`${TEAM_GROUP_BINDING_BACKFILL_SQL};`,
		`${TEAM_GROUP_BINDING_BACKFILL_CHECK_SQL};`,
	]);
	for (const statement of statements.slice(0, -2))
		expect(statement).toMatch(/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS /u);
});

describe.each(["SQLite", "D1"] as const)("%s Team group binding contract", (backend) => {
	let sequence = 0;
	const test = teamGroupBindingHarness(async (use) => {
		const f = setupStore(backend, { authClock: () => TEAM_GROUP_BINDING_CLOCK_MS });
		try {
			await use({
				store: f.store,
				prefix: `team-binding-${++sequence}`,
				exec: async (sql, ...values) => f.db.prepare(sql).run(...values),
				count: async (sql, ...values) =>
					Number(
						f.db
							.prepare(sql)
							.pluck()
							.get(...values),
					),
			});
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerTeamGroupBindingContract(test);
});

describe.each(["SQLite", "D1"] as const)(
	"%s coordinator without complete binding storage",
	(backend) => {
		it.each([
			["no storage", dropStorage],
			[
				"a table without its delete guard",
				(db: Database.Database) => db.exec("DROP TRIGGER coordinator_team_group_binding_no_delete"),
			],
		])(
			"refuses Team invitations and binding reads with %s, and still mints other invitations",
			async (_name, damage) => {
				const f = setupStore(backend);
				try {
					await f.store.createGroup("group-a");
					damage(f.db);
					expect(present(f.db)).toBe(0);

					await expect(f.store.readTeamGroupBindings(["team-a"])).rejects.toThrow(
						"team_group_binding_unavailable",
					);
					await expect(
						f.store.bindTeamGroup({ teamId: "team-a", groupId: "group-a" }),
					).rejects.toThrow("team_group_binding_unavailable");
					const reviewedIntent = {
						version: 1,
						journey: "team",
						team: { teamId: "team-a", displayName: "Team", futureProjectsInherit: true },
						projects: [],
						excludedProjects: [],
					};
					await expect(
						f.store.createInvite({
							groupId: "group-a",
							policy: "auto_admit",
							expiresAt: "2099-01-01T00:00:00Z",
							inviteKind: "team_member",
							policyTeamId: "team-a",
							reviewedIntent,
							reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
						}),
					).rejects.toThrow("team_group_binding_unavailable");
					expect(f.db.prepare("SELECT COUNT(*) FROM coordinator_invites").pluck().get()).toBe(0);
					const other = await f.store.createInvite({
						groupId: "group-a",
						policy: "auto_admit",
						expiresAt: "2099-01-01T00:00:00Z",
					});
					expect(other.invite_kind).not.toBe("team_member");
				} finally {
					await f.store.close();
					if (f.db.open) f.db.close();
				}
			},
		);
	},
);

describe("migration 0053 on a database from an earlier release", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(":memory:");
		initializeBaseSchema(db);
		dropStorage(db);
		db.exec(`INSERT INTO groups(group_id, created_at) VALUES ('group-a', 't'), ('group-b', 't');
			INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at, invite_kind, policy_team_id) VALUES
			 ('i1', 'group-a', 't1', 'auto_admit', 'later', '2026-01-02', 'team_member', 'team-one'),
			 ('i2', 'group-a', 't2', 'auto_admit', 'later', '2026-01-01', 'team_member', 'team-one'),
			 ('i3', 'group-a', 't3', 'auto_admit', 'later', '2026-01-01', 'team_member', 'team-shared'),
			 ('i4', 'group-b', 't4', 'auto_admit', 'later', '2026-01-01', 'team_member', 'team-shared'),
			 ('i5', 'group-b', 't5', 'auto_admit', 'later', '2026-01-01', 'add_device', 'team-device');`);
	});
	afterEach(() => db.close());

	const snapshot = () => ({
		schema: db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE name NOT LIKE '%team_group_binding%' AND name <> 'sqlite_sequence' ORDER BY name",
			)
			.all(),
		groups: db.prepare("SELECT * FROM groups").all(),
		invites: db.prepare("SELECT * FROM coordinator_invites ORDER BY invite_id").all(),
	});

	it("binds each Team ID that one group used, leaves a shared one unbound, and changes nothing else", () => {
		const before = snapshot();

		db.exec(TEAM_GROUP_BINDING_MIGRATION_SQL);

		expect(present(db)).toBe(1);
		expect(db.prepare("SELECT * FROM coordinator_team_group_bindings").all()).toEqual([
			{ team_id: "team-one", group_id: "group-a", bound_at: "2026-01-01", source: "backfill" },
		]);
		expect(snapshot()).toEqual(before);
	});

	it("fails, and binds nothing, when the backfill leaves a Team of one group unbound", () => {
		// A guard that skips one Team's binding stands in for a backfill that missed it.
		db.exec(`CREATE TABLE coordinator_team_group_bindings (
			team_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, bound_at TEXT NOT NULL,
			source TEXT NOT NULL CHECK (source IN ('invitation', 'backfill', 'admin')));
			CREATE TRIGGER skip_team_one BEFORE INSERT ON coordinator_team_group_bindings
			WHEN NEW.team_id = 'team-one' BEGIN SELECT RAISE(IGNORE); END`);

		expect(() => db.transaction(() => db.exec(TEAM_GROUP_BINDING_MIGRATION_SQL))()).toThrow(
			/NOT NULL constraint failed: coordinator_team_group_bindings\.group_id/u,
		);
		expect(db.prepare("SELECT COUNT(*) FROM coordinator_team_group_bindings").pluck().get()).toBe(
			0,
		);
	});

	it("is installed the same way when the SQLite coordinator opens the file", () => {
		initializeBaseSchema(db);

		expect(present(db)).toBe(1);
		expect(db.prepare("SELECT team_id FROM coordinator_team_group_bindings").pluck().all()).toEqual(
			["team-one"],
		);
	});

	it("can run again without changing a binding", () => {
		db.exec(TEAM_GROUP_BINDING_MIGRATION_SQL);
		db.exec(
			"INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at, invite_kind, policy_team_id) VALUES ('i6', 'group-b', 't6', 'auto_admit', 'later', 't', 'team_member', 'team-one')",
		);

		db.exec(TEAM_GROUP_BINDING_MIGRATION_SQL);

		expect(
			db.prepare("SELECT team_id, group_id FROM coordinator_team_group_bindings").all(),
		).toEqual([{ team_id: "team-one", group_id: "group-a" }]);
	});
});

describe("writers of Team group bindings", () => {
	it("are the binding module alone, so nothing else binds a Team", () => {
		const source = new URL("./", import.meta.url);
		const writers = readdirSync(source)
			.filter((name) => name.endsWith(".ts") && !name.includes(".test.") && !name.includes("test-"))
			.filter((name) =>
				/INSERT (OR IGNORE )?INTO (\$\{BINDINGS\}|coordinator_team_group_bindings)/u.test(
					readFileSync(new URL(name, source), "utf8").replace(/\s+/gu, " "),
				),
			);

		expect(writers).toEqual(["coordinator-team-group-bindings.ts"]);
	});
});
