import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	deleteCoordinatorGroupPreference,
	getCoordinatorGroupPreference,
	listCoordinatorGroupPreferences,
	upsertCoordinatorGroupPreference,
} from "./coordinator-group-preferences.js";
import { initTestSchema } from "./test-utils.js";

function openDb(): Database.Database {
	const db = new Database(":memory:");
	initTestSchema(db);
	return db;
}

describe("coordinator group preferences", () => {
	it("returns null for an unknown group", () => {
		const db = openDb();
		try {
			expect(getCoordinatorGroupPreference(db, "https://coord.example", "team-a")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("upsert creates a row with defaults filled in", () => {
		const db = openDb();
		try {
			const row = upsertCoordinatorGroupPreference(db, {
				coordinator_id: "https://coord.example",
				group_id: "team-a",
			});
			expect(row.coordinator_id).toBe("https://coord.example");
			expect(row.group_id).toBe("team-a");
			expect(row.projects_include).toBeNull();
			expect(row.projects_exclude).toBeNull();
			expect(row.auto_seed_scope).toBe(true);
			expect(row.updated_at).toBeTruthy();
		} finally {
			db.close();
		}
	});

	it("upsert updates projects + auto_seed_scope in place", () => {
		const db = openDb();
		try {
			upsertCoordinatorGroupPreference(db, {
				coordinator_id: "https://coord.example",
				group_id: "team-a",
				projects_include: ["work/*"],
				auto_seed_scope: false,
			});
			const updated = upsertCoordinatorGroupPreference(db, {
				coordinator_id: "https://coord.example",
				group_id: "team-a",
				projects_include: ["work/*", "shared/*"],
			});
			expect(updated.projects_include).toEqual(["work/*", "shared/*"]);
			// auto_seed_scope stays false — partial update
			expect(updated.auto_seed_scope).toBe(false);
		} finally {
			db.close();
		}
	});

	it("empty arrays normalize to null (no include filter)", () => {
		const db = openDb();
		try {
			const row = upsertCoordinatorGroupPreference(db, {
				coordinator_id: "https://coord.example",
				group_id: "team-a",
				projects_include: [],
			});
			expect(row.projects_include).toBeNull();
		} finally {
			db.close();
		}
	});

	it("list returns only rows for the matching coordinator", () => {
		const db = openDb();
		try {
			upsertCoordinatorGroupPreference(db, {
				coordinator_id: "https://a.example",
				group_id: "team-a",
			});
			upsertCoordinatorGroupPreference(db, {
				coordinator_id: "https://a.example",
				group_id: "team-b",
			});
			upsertCoordinatorGroupPreference(db, {
				coordinator_id: "https://b.example",
				group_id: "team-a",
			});
			const rows = listCoordinatorGroupPreferences(db, "https://a.example");
			expect(rows.map((r) => r.group_id).sort()).toEqual(["team-a", "team-b"]);
		} finally {
			db.close();
		}
	});

	it("delete removes the row and returns whether it existed", () => {
		const db = openDb();
		try {
			upsertCoordinatorGroupPreference(db, {
				coordinator_id: "https://coord.example",
				group_id: "team-a",
			});
			expect(deleteCoordinatorGroupPreference(db, "https://coord.example", "team-a")).toBe(true);
			expect(deleteCoordinatorGroupPreference(db, "https://coord.example", "team-a")).toBe(false);
			expect(getCoordinatorGroupPreference(db, "https://coord.example", "team-a")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("rejects empty coordinator_id or group_id", () => {
		const db = openDb();
		try {
			expect(() =>
				upsertCoordinatorGroupPreference(db, { coordinator_id: "", group_id: "team-a" }),
			).toThrow(/coordinator_id/);
			expect(() =>
				upsertCoordinatorGroupPreference(db, {
					coordinator_id: "https://coord.example",
					group_id: "",
				}),
			).toThrow(/group_id/);
		} finally {
			db.close();
		}
	});
});
