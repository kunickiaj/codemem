import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tableExists } from "./db.js";
import {
	listProjectBoundaryMigrationRecords,
	migrationRecordCoversMove,
	type ProjectBoundaryMigrationState,
	recordProjectBoundaryMigration,
} from "./project-boundary-migration-records.js";
import { initTestSchema } from "./test-utils.js";

const SOURCE = "team:group-a:default";
const SECOND_SOURCE = "client-setup";
const BOUNDARY = "managed-project:project-p";
let db: InstanceType<typeof Database>;

function store(state: ProjectBoundaryMigrationState, generation: number) {
	return recordProjectBoundaryMigration(db, {
		boundaryScopeId: BOUNDARY,
		sourceScopeId: SOURCE,
		additionalSourceScopeIds: [SECOND_SOURCE],
		state,
		generation,
	});
}

function covers(state: ProjectBoundaryMigrationState, move: { from: string; to: string }) {
	return migrationRecordCoversMove(
		[
			{
				boundaryScopeId: BOUNDARY,
				sourceScopeId: SOURCE,
				additionalSourceScopeIds: [SECOND_SOURCE],
				state,
				generation: 1,
			},
		],
		{ fromScopeId: move.from, toScopeId: move.to },
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

describe("this device's migration records", () => {
	it("reads no records before one is stored", () => {
		expect(listProjectBoundaryMigrationRecords(db)).toEqual([]);
	});

	it("reads no records, and creates nothing, on a database the schema step could not upgrade", () => {
		const notUpgraded = new Database(":memory:");

		expect(listProjectBoundaryMigrationRecords(notUpgraded)).toEqual([]);
		expect(tableExists(notUpgraded, "project_boundary_migrations")).toBe(false);
		notUpgraded.close();
	});

	it("returns a stored record", () => {
		store("committed", 1);

		expect(listProjectBoundaryMigrationRecords(db)).toEqual([
			{
				boundaryScopeId: BOUNDARY,
				sourceScopeId: SOURCE,
				additionalSourceScopeIds: [SECOND_SOURCE],
				state: "committed",
				generation: 1,
			},
		]);
	});

	it("replaces a record with a newer generation", () => {
		store("committed", 1);

		expect(store("rolled_back", 2)).toBe(true);
		expect(listProjectBoundaryMigrationRecords(db)[0]?.state).toBe("rolled_back");
	});

	it("ignores an older generation, so a late read cannot undo a rollback", () => {
		store("rolled_back", 2);

		expect(store("committed", 1)).toBe(false);
		expect(listProjectBoundaryMigrationRecords(db)[0]?.state).toBe("rolled_back");
	});

	it.each([
		{ name: "a boundary that is also its own source", boundaryScopeId: SOURCE },
		{ name: "an empty boundary ID", boundaryScopeId: "" },
		{ name: "a generation below one", generation: 0 },
	])("refuses $name", (overrides) => {
		expect(() =>
			recordProjectBoundaryMigration(db, {
				boundaryScopeId: BOUNDARY,
				sourceScopeId: SOURCE,
				state: "committed",
				generation: 1,
				...overrides,
			}),
		).toThrow("project_boundary_migration_record_invalid");
	});
});

describe("which moves a record covers", () => {
	it.each([
		{ state: "committed", from: SOURCE, to: BOUNDARY, covered: true },
		{ state: "committed", from: SECOND_SOURCE, to: BOUNDARY, covered: true },
		{ state: "committed", from: BOUNDARY, to: SOURCE, covered: false },
		{ state: "committed", from: "another-scope", to: BOUNDARY, covered: false },
		{ state: "committed", from: SOURCE, to: "another-boundary", covered: false },
		{ state: "rolled_back", from: BOUNDARY, to: SOURCE, covered: true },
		{ state: "rolled_back", from: BOUNDARY, to: SECOND_SOURCE, covered: true },
		{ state: "rolled_back", from: SOURCE, to: BOUNDARY, covered: false },
		{ state: "detached", from: BOUNDARY, to: SOURCE, covered: false },
		{ state: "detached", from: SOURCE, to: BOUNDARY, covered: false },
	] as const)("$state: $from to $to is covered: $covered", (move) => {
		expect(covers(move.state, move)).toBe(move.covered);
	});
});

describe("a stored row the writer would not have accepted", () => {
	it.each([
		{ name: "a generation below one", set: "generation = 0" },
		{ name: "an unknown state", set: "state = 'anything'" },
		{
			name: "a boundary listed as its own source",
			set: `additional_source_scope_ids_json = '["${BOUNDARY}"]'`,
		},
	])("is not read as a record: $name", ({ set }) => {
		store("committed", 1);
		db.exec(`UPDATE project_boundary_migrations SET ${set}`);

		expect(listProjectBoundaryMigrationRecords(db)).toEqual([]);
	});
});
