import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
	DeviceRebindPending,
	DeviceRebindReceiptV1,
} from "./coordinator-device-rebind-client.js";
import {
	applyLocalIdentitySwitch,
	assertNoLocalIdentityOverride,
	completeLocalIdentitySwitch,
	markLocalIdentitySwitchBound,
	markLocalIdentitySwitchNotCommitted,
	readOpenLocalIdentitySwitch,
	recordLocalIdentitySwitch,
} from "./local-identity-switch.js";
import { initTestSchema, seedMixedScopeFixture } from "./test-utils.js";

const OLD = "identity-old";
const TARGET = "identity-target";
const NOW = "2026-10-26T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The switch may change only these; every other table must stay byte-identical. */
const SWITCHED_TABLES = new Set([
	"actors",
	"identity_devices",
	"local_identity_switches",
	"local_identity_generation",
	"memory_local_capture_adoption",
]);

/** A migrated device of OLD: memories, a Team membership, and a peer device of OLD. */
function localFixture() {
	const dir = mkdtempSync(join(tmpdir(), "codemem-identity-switch-"));
	dirs.push(dir);
	const db = new Database(join(dir, "local.sqlite"));
	initTestSchema(db);
	seedMixedScopeFixture(db, "device-a");
	db.prepare("UPDATE memory_items SET actor_id = ?, origin_device_id = 'device-a'").run(OLD);
	const actor = db.prepare(
		"INSERT INTO actors (actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
	);
	actor.run(OLD, "Old me", 1, NOW, NOW);
	actor.run("identity-peer", "Peer", 0, NOW, NOW);
	const binding = db.prepare(
		`INSERT INTO identity_devices (device_id, identity_id, display_name, status, provenance, revision,
		 migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, ?, ?, 'active', 'legacy_team_migration', 'r1', 'migrated', ?, ?, ?)`,
	);
	binding.run("device-a", OLD, "Work laptop", "bind-a", NOW, NOW);
	binding.run("device-b", OLD, "Old desktop", "bind-b", NOW, NOW);
	db.prepare(
		`INSERT INTO policy_teams (team_id, display_name, status, provenance, revision, migration_state,
		 idempotency_key, created_at, updated_at) VALUES ('team-a', 'Team A', 'active', 'p', 'r', 'm', 'team-a', ?, ?)`,
	).run(NOW, NOW);
	db.prepare(
		`INSERT INTO policy_team_memberships (team_id, identity_id, role, status, provenance, revision,
		 migration_state, idempotency_key, created_at, updated_at)
		 VALUES ('team-a', ?, 'member', 'active', 'p', 'r', 'm', 'member-old', ?, ?)`,
	).run(OLD, NOW, NOW);
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, `${JSON.stringify({ actor_id: OLD, actor_display_name: "Old me" })}\n`);
	return { db, configPath };
}

const pending: DeviceRebindPending = {
	attemptId: "rebind-a",
	coordinatorOrigin: "https://coordinator.example.test",
	groupId: "group-a",
	deviceId: "device-a",
	previousIdentityId: OLD,
	targetIdentityId: TARGET,
	reviewDigest: "e".repeat(64),
	expiresAtMs: 1_791_029_400_000,
};
const receipt: DeviceRebindReceiptV1 = {
	attemptId: "rebind-a",
	bindingId: "binding-a",
	deviceId: "device-a",
	previousIdentityId: OLD,
	targetIdentityId: TARGET,
	enrollmentCount: 2,
	finalizedAtMs: 1_791_029_000_000,
};

function snapshot(db: Database.Database) {
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.pluck()
		.all() as string[];
	return Object.fromEntries(
		tables
			.filter((name) => !SWITCHED_TABLES.has(name))
			.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
	);
}

const config = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const deviceKey = (db: Database.Database) =>
	db.prepare("SELECT public_key FROM sync_device").pluck().get() as string;
const ctx = (configPath: string) => ({ configPath, env: {} });

function recordAndBind(db: Database.Database, configPath: string) {
	recordLocalIdentitySwitch(db, pending, ctx(configPath));
	markLocalIdentitySwitchBound(db, receipt);
}

function apply(db: Database.Database, configPath: string, displayName = "Target me") {
	applyLocalIdentitySwitch(
		db,
		{ attemptId: "rebind-a", displayName, expectedPublicKey: deviceKey(db) },
		ctx(configPath),
	);
}

function switchThrough(db: Database.Database, configPath: string) {
	recordAndBind(db, configPath);
	apply(db, configPath);
	completeLocalIdentitySwitch(db, { attemptId: "rebind-a", configPath });
}

describe("local Identity switch", () => {
	it("switches the local actor, this device's binding and config, and nothing else", async () => {
		// Arrange
		const { db, configPath } = localFixture();
		const before = snapshot(db);
		// Act
		switchThrough(db, configPath);
		// Assert
		expect(snapshot(db)).toEqual(before);
		const actors = db
			.prepare(
				"SELECT actor_id, is_local, status, merged_into_actor_id FROM actors ORDER BY actor_id",
			)
			.all();
		expect(actors).toEqual([
			{ actor_id: OLD, is_local: 0, status: "active", merged_into_actor_id: null },
			{ actor_id: "identity-peer", is_local: 0, status: "active", merged_into_actor_id: null },
			{ actor_id: TARGET, is_local: 1, status: "active", merged_into_actor_id: null },
		]);
		const bindings = db
			.prepare(
				"SELECT device_id, identity_id, provenance, revision FROM identity_devices ORDER BY device_id",
			)
			.all();
		expect(bindings).toEqual([
			{
				device_id: "device-a",
				identity_id: TARGET,
				provenance: "user_confirmed_identity_setup",
				revision: "binding-a",
			},
			{
				device_id: "device-b",
				identity_id: OLD,
				provenance: "legacy_team_migration",
				revision: "r1",
			},
		]);
		expect(db.prepare("SELECT generation, actor_id FROM local_identity_generation").get()).toEqual({
			generation: 1,
			actor_id: TARGET,
		});
		expect(config(configPath)).toEqual({ actor_id: TARGET, actor_display_name: "Target me" });
		expect(readOpenLocalIdentitySwitch(db)).toBeNull();
	});

	it("repeats every step without changing anything twice", async () => {
		// Arrange
		const { db, configPath } = localFixture();
		switchThrough(db, configPath);
		const after = db.prepare("SELECT * FROM identity_devices ORDER BY device_id").all();
		// Act
		switchThrough(db, configPath);
		// Assert
		expect(db.prepare("SELECT * FROM identity_devices ORDER BY device_id").all()).toEqual(after);
		expect(db.prepare("SELECT generation FROM local_identity_generation").pluck().get()).toBe(1);
	});

	it("resumes a switch interrupted after the database commit", async () => {
		// Arrange
		const { db, configPath } = localFixture();
		recordAndBind(db, configPath);
		apply(db, configPath);
		// Act
		const open = readOpenLocalIdentitySwitch(db);
		completeLocalIdentitySwitch(db, { attemptId: open?.attemptId ?? "", configPath });
		// Assert
		expect(open).toMatchObject({ state: "db_committed", bindingId: "binding-a" });
		expect(config(configPath).actor_id).toBe(TARGET);
	});
});

describe("local Identity switch refusals", () => {
	it("refuses a second open switch, a changed record, and a stale current Identity", () => {
		// Arrange
		const { db, configPath } = localFixture();
		const record = (patch: Partial<DeviceRebindPending>) =>
			recordLocalIdentitySwitch(db, { ...pending, ...patch }, ctx(configPath));
		record({});
		// Act / Assert
		expect(() => record({ attemptId: "rebind-b" })).toThrow("local_identity_switch_in_progress");
		expect(() => record({ reviewDigest: "f".repeat(64) })).toThrow(
			"local_identity_switch_conflict",
		);
		markLocalIdentitySwitchNotCommitted(db, "rebind-a");
		// An attempt that ended uncommitted must never be finalized again.
		expect(() => record({})).toThrow("local_identity_switch_conflict");
		expect(() => record({ attemptId: "rebind-c", previousIdentityId: "identity-peer" })).toThrow(
			"local_identity_switch_conflict",
		);
	});

	it("refuses a receipt for a different switch or binding", () => {
		// Arrange
		const { db, configPath } = localFixture();
		recordAndBind(db, configPath);
		// Act / Assert
		expect(() =>
			markLocalIdentitySwitchBound(db, { ...receipt, targetIdentityId: "identity-other" }),
		).toThrow("local_identity_switch_conflict");
		expect(() => markLocalIdentitySwitchBound(db, { ...receipt, bindingId: "binding-b" })).toThrow(
			"local_identity_switch_conflict",
		);
		expect(readOpenLocalIdentitySwitch(db)).toMatchObject({ bindingId: "binding-a" });
	});

	it("changes nothing when the target actor moved since the attempt was recorded", () => {
		// Arrange: the target actor was merged into someone else in the meantime.
		const { db, configPath } = localFixture();
		recordAndBind(db, configPath);
		db.prepare(
			"INSERT INTO actors (actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at) VALUES (?, 'T', 0, 'merged', 'identity-peer', ?, ?)",
		).run(TARGET, NOW, NOW);
		const actors = db.prepare("SELECT * FROM actors ORDER BY actor_id").all();
		// Act / Assert
		expect(() => apply(db, configPath)).toThrow("local_identity_switch_conflict");
		expect(db.prepare("SELECT * FROM actors ORDER BY actor_id").all()).toEqual(actors);
		expect(readOpenLocalIdentitySwitch(db)).toMatchObject({ state: "coordinator_bound" });
	});

	it("refuses config drift before the database changes, at record and at apply", () => {
		// Arrange
		const { db, configPath } = localFixture();
		const drift = () =>
			writeFileSync(configPath, `${JSON.stringify({ actor_id: "identity-elsewhere" })}\n`);
		drift();
		// Act / Assert: at record
		expect(() => recordLocalIdentitySwitch(db, pending, ctx(configPath))).toThrow(
			"local_identity_switch_conflict",
		);
		writeFileSync(configPath, `${JSON.stringify({ actor_id: OLD })}\n`);
		recordAndBind(db, configPath);
		drift();
		// Act / Assert: at apply
		expect(() => apply(db, configPath)).toThrow("local_identity_switch_conflict");
		expect(
			db
				.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'device-a'")
				.pluck()
				.get(),
		).toBe(OLD);
		expect(readOpenLocalIdentitySwitch(db)).toMatchObject({ state: "coordinator_bound" });
	});

	it("leaves a config that changed after the database step alone", () => {
		// Arrange
		const { db, configPath } = localFixture();
		recordAndBind(db, configPath);
		apply(db, configPath);
		writeFileSync(configPath, `${JSON.stringify({ actor_id: "identity-elsewhere" })}\n`);
		// Act / Assert
		expect(() => completeLocalIdentitySwitch(db, { attemptId: "rebind-a", configPath })).toThrow(
			"local_identity_switch_conflict",
		);
		expect(config(configPath)).toEqual({ actor_id: "identity-elsewhere" });
		expect(readOpenLocalIdentitySwitch(db)).toMatchObject({ state: "db_committed" });
	});

	it("refuses while an environment override pins the Identity, even an empty one", () => {
		// Arrange
		const { db, configPath } = localFixture();
		const record = (env: NodeJS.ProcessEnv) =>
			recordLocalIdentitySwitch(db, pending, { configPath, env });
		// Act / Assert
		expect(() => record({ CODEMEM_ACTOR_ID: "" })).toThrow("local_identity_override_set");
		expect(() => record({ CODEMEM_DEVICE_ID: "device-a" })).toThrow("local_identity_override_set");
		expect(() => assertNoLocalIdentityOverride({ CODEMEM_DEVICE_ID: " " })).not.toThrow();
	});

	it("only lets an unfinished attempt end as not committed", () => {
		// Arrange
		const { db, configPath } = localFixture();
		recordAndBind(db, configPath);
		// Act / Assert
		expect(() => markLocalIdentitySwitchNotCommitted(db, "rebind-a")).toThrow(
			"local_identity_switch_conflict",
		);
	});
});

describe("local Identity switch variants", () => {
	it("switches from the device's default Identity when config names none", () => {
		// Arrange
		const { db, configPath } = localFixture();
		const fallback = "local:device-a";
		db.prepare("UPDATE actors SET actor_id = ? WHERE actor_id = ?").run(fallback, OLD);
		db.prepare("DELETE FROM identity_devices WHERE device_id = 'device-a'").run();
		writeFileSync(configPath, "{}\n");
		const fromDefault = { ...pending, previousIdentityId: fallback };
		// Act
		recordLocalIdentitySwitch(db, fromDefault, ctx(configPath));
		markLocalIdentitySwitchBound(db, { ...receipt, previousIdentityId: fallback });
		apply(db, configPath);
		completeLocalIdentitySwitch(db, { attemptId: "rebind-a", configPath });
		// Assert: no prior binding, so one is created for the target.
		expect(config(configPath)).toEqual({ actor_id: TARGET, actor_display_name: "Target me" });
		expect(
			db
				.prepare(
					"SELECT identity_id, provenance FROM identity_devices WHERE device_id = 'device-a'",
				)
				.get(),
		).toEqual({ identity_id: TARGET, provenance: "user_confirmed_identity_setup" });
	});

	it("reuses an existing target actor and keeps its name", () => {
		// Arrange
		const { db, configPath } = localFixture();
		db.prepare(
			"INSERT INTO actors (actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, 'Known target', 0, 'active', ?, ?)",
		).run(TARGET, NOW, NOW);
		// Act
		switchThrough(db, configPath);
		// Assert
		expect(
			db.prepare("SELECT display_name, is_local FROM actors WHERE actor_id = ?").get(TARGET),
		).toEqual({
			display_name: "Known target",
			is_local: 1,
		});
		expect(config(configPath).actor_display_name).toBe("Known target");
	});

	it("still completes after a stale process re-flagged the old actor as local", () => {
		// Arrange
		const { db, configPath } = localFixture();
		recordAndBind(db, configPath);
		apply(db, configPath);
		db.prepare("UPDATE actors SET is_local = (actor_id = ?)").run(OLD);
		// Act
		completeLocalIdentitySwitch(db, { attemptId: "rebind-a", configPath });
		// Assert
		expect(config(configPath).actor_id).toBe(TARGET);
		expect(readOpenLocalIdentitySwitch(db)).toBeNull();
	});
});
