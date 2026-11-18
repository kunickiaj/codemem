import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearProjectBoundaryMigrationHold,
	getProjectBoundaryMigrationHold,
	recordHoldWithdrawnDevices,
} from "./project-boundary-migration-hold.js";
import {
	type ProjectBoundaryMigrationState,
	recordProjectBoundaryMigration,
} from "./project-boundary-migration-records.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-18T00:00:00.000Z";
const LATER = "2026-11-18T01:00:00.000Z";
const SOURCE = "team:group-a:default";
const BOUNDARY = "managed-project:project-p";
const OTHER_BOUNDARY = "managed-project:project-q";
let db: InstanceType<typeof Database>;

function store(generation: number, state: ProjectBoundaryMigrationState = "committed") {
	recordProjectBoundaryMigration(db, {
		boundaryScopeId: BOUNDARY,
		sourceScopeId: SOURCE,
		state,
		generation,
		now: NOW,
	});
}

function hold(boundaryScopeId = BOUNDARY) {
	return getProjectBoundaryMigrationHold(db, boundaryScopeId);
}

function clear(generation: number, reason: "empty_plan" | "summary_confirmed" = "empty_plan") {
	return clearProjectBoundaryMigrationHold(db, {
		boundaryScopeId: BOUNDARY,
		generation,
		reason,
		now: LATER,
	});
}

function withdrawn(generation: number, deviceIds: string[]) {
	return recordHoldWithdrawnDevices(db, {
		boundaryScopeId: BOUNDARY,
		generation,
		deviceIds,
	});
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

describe("the hold on a migrated Project", () => {
	it("does not exist for a boundary with no migration record", () => {
		store(1);

		expect(hold(OTHER_BOUNDARY)).toBeNull();
	});

	it("does not exist in a database without the table", () => {
		db.exec("DROP TABLE project_boundary_migrations");

		expect(hold()).toBeNull();
	});

	it.each(["committed", "rolled_back", "detached"] as const)(
		"is set as soon as a %s record is stored",
		(state) => {
			store(1, state);

			expect(hold()).toEqual({
				boundaryScopeId: BOUNDARY,
				generation: 1,
				held: true,
				clearedReason: null,
				clearedAt: null,
				withdrawnAtFirstPassDeviceIds: null,
			});
		},
	);

	it("is cleared for the record's generation, with the reason and time", () => {
		store(1);

		expect(clear(1, "summary_confirmed")).toBe(true);

		expect(hold()).toMatchObject({
			generation: 1,
			held: false,
			clearedReason: "summary_confirmed",
			clearedAt: LATER,
		});
	});

	it("is set again when a record with a newer generation is stored", () => {
		store(1);
		clear(1);

		store(2, "rolled_back");

		expect(hold()).toMatchObject({
			generation: 2,
			held: true,
			clearedReason: null,
			clearedAt: null,
		});
	});

	it("stays clear when the same record is stored again", () => {
		store(1);
		clear(1);

		store(1);

		expect(hold()).toMatchObject({ generation: 1, held: false });
	});

	it("keeps the first reason when it is cleared twice", () => {
		store(1);
		clear(1, "empty_plan");

		expect(clear(1, "summary_confirmed")).toBe(true);

		expect(hold()).toMatchObject({ held: false, clearedReason: "empty_plan" });
	});
});

describe("a hold that is not cleared", () => {
	it.each([
		{ name: "an older generation", generation: 1 },
		{ name: "a generation the record has not reached", generation: 3 },
	])("stays set when the request names $name", ({ generation }) => {
		store(2);

		expect(clear(generation)).toBe(false);

		expect(hold()).toMatchObject({ generation: 2, held: true });
	});

	it("is not cleared for a boundary with no record", () => {
		expect(clear(1)).toBe(false);
	});

	it("is not cleared in a database without the table", () => {
		db.exec("DROP TABLE project_boundary_migrations");

		expect(clear(1)).toBe(false);
	});

	it.each([
		{ name: "an unknown reason", input: { reason: "because" } },
		{ name: "a generation below one", input: { generation: 0 } },
		{ name: "a boundary ID with surrounding spaces", input: { boundaryScopeId: ` ${BOUNDARY}` } },
	])("refuses $name", ({ input }) => {
		store(1);

		expect(() =>
			clearProjectBoundaryMigrationHold(db, {
				boundaryScopeId: BOUNDARY,
				generation: 1,
				reason: "empty_plan",
				now: LATER,
				...(input as object),
			}),
		).toThrow("project_boundary_migration_hold_invalid");
		expect(hold()).toMatchObject({ held: true });
	});
});

describe("a stored row that cannot be read", () => {
	it.each([
		{ name: "a row that is not a valid record", set: "state = 'anything'" },
		{ name: "a cleared generation ahead of the record", set: "hold_cleared_generation = 5" },
		{ name: "a cleared generation behind the record", set: "hold_cleared_generation = 0" },
		{
			name: "an unknown reason for clearing",
			set: "hold_cleared_generation = generation, hold_cleared_reason = 'because'",
		},
		{
			name: "a cleared generation with no reason",
			set: "hold_cleared_generation = generation, hold_cleared_reason = NULL",
		},
	])("stays held: $name", ({ set }) => {
		store(1);
		clear(1);
		db.exec(`UPDATE project_boundary_migrations SET ${set}`);

		expect(hold()).toMatchObject({ boundaryScopeId: BOUNDARY, held: true, clearedReason: null });
	});

	it("has no generation, so nothing can clear it, when the row is not a valid record", () => {
		store(1);
		db.exec("UPDATE project_boundary_migrations SET generation = 0");

		expect(hold()).toMatchObject({ generation: null, held: true });
		expect(clear(1)).toBe(false);
	});
});

describe("the devices already withdrawn when a hold is first seen", () => {
	it("are unknown before the first pass", () => {
		store(1);

		expect(hold()?.withdrawnAtFirstPassDeviceIds).toBeNull();
	});

	it("are stored once, sorted and without repeats", () => {
		store(1);

		expect(withdrawn(1, ["device-b", "device-a", "device-b"])).toEqual(["device-a", "device-b"]);

		expect(hold()?.withdrawnAtFirstPassDeviceIds).toEqual(["device-a", "device-b"]);
	});

	it("can be an empty list, which is different from unknown", () => {
		store(1);

		expect(withdrawn(1, [])).toEqual([]);

		expect(hold()?.withdrawnAtFirstPassDeviceIds).toEqual([]);
	});

	it("are not replaced by a later pass, so a person withdrawn afterwards is not added", () => {
		store(1);
		withdrawn(1, ["device-a"]);

		expect(withdrawn(1, ["device-a", "device-later"])).toEqual(["device-a"]);

		expect(hold()?.withdrawnAtFirstPassDeviceIds).toEqual(["device-a"]);
	});

	it("survive the hold being cleared", () => {
		store(1);
		withdrawn(1, ["device-a"]);

		clear(1);

		expect(hold()?.withdrawnAtFirstPassDeviceIds).toEqual(["device-a"]);
	});

	it("are unknown again when a record with a newer generation is stored", () => {
		store(1);
		withdrawn(1, ["device-a"]);

		store(2);

		expect(hold()?.withdrawnAtFirstPassDeviceIds).toBeNull();
		expect(withdrawn(2, ["device-c"])).toEqual(["device-c"]);
	});

	it.each([
		{ name: "an older generation", generation: 1 },
		{ name: "a generation the record has not reached", generation: 3 },
	])("are not stored for $name", ({ generation }) => {
		store(2);

		expect(withdrawn(generation, ["device-a"])).toBeNull();

		expect(hold()?.withdrawnAtFirstPassDeviceIds).toBeNull();
	});

	it("are not stored for a boundary with no record", () => {
		expect(withdrawn(1, ["device-a"])).toBeNull();
	});

	it.each([
		{ name: "not a list", stored: '{"device-a":true}' },
		{ name: "not JSON", stored: "device-a" },
		{ name: "a list with an entry that is not a device ID", stored: '["device-a", 7]' },
	])("are unknown, and can be stored again, when the stored list is $name", ({ stored }) => {
		store(1);
		withdrawn(1, ["device-a"]);
		db.prepare("UPDATE project_boundary_migrations SET hold_withdrawn_device_ids_json = ?").run(
			stored,
		);

		expect(hold()?.withdrawnAtFirstPassDeviceIds).toBeNull();
		expect(withdrawn(1, ["device-b"])).toEqual(["device-b"]);
	});

	it.each([
		{ name: "an empty device ID", deviceIds: [""] },
		{ name: "a device ID with surrounding spaces", deviceIds: [" device-a"] },
	])("refuse $name", ({ deviceIds }) => {
		store(1);

		expect(() => withdrawn(1, deviceIds)).toThrow("project_boundary_migration_hold_invalid");
		expect(hold()?.withdrawnAtFirstPassDeviceIds).toBeNull();
	});
});
