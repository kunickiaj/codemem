import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensurePeerProjectFilterRetentionSchema,
	readRetainedPeerProjectFilters,
} from "./peer-project-filter-retention.js";
import { syncProjectAllowed } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";

const PEER = "peer-retained";
let db: InstanceType<typeof Database>;
type Lists = { include: string[] | null; exclude: string[] | null };
const RESTRICTED: Lists = { include: ["work"], exclude: ["secret"] };

function pair(lists: Lists = { include: null, exclude: null }, deviceId = PEER) {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, projects_include_json, projects_exclude_json, created_at)
		 VALUES (?, ?, ?, '2026-11-18T00:00:00Z')`,
	).run(
		deviceId,
		lists.include === null ? null : JSON.stringify(lists.include),
		lists.exclude === null ? null : JSON.stringify(lists.exclude),
	);
}

function remove(deviceId = PEER) {
	db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(deviceId);
}

function saved() {
	return db
		.prepare(
			"SELECT projects_include_json, projects_exclude_json FROM sync_peers WHERE peer_device_id = ?",
		)
		.get(PEER);
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});
afterEach(() => db.close());

describe("filters retained across pairing deletion", () => {
	it("needs no application-side deletion hook", () => {
		pair(RESTRICTED);

		remove();

		expect(readRetainedPeerProjectFilters(db, PEER)).toEqual({
			projects_include_json: '["work"]',
			projects_exclude_json: '["secret"]',
		});
	});

	it("restores both lists when the pairing is recreated without its own filters", () => {
		pair(RESTRICTED);
		remove();

		pair();

		expect(saved()).toEqual({
			projects_include_json: '["work"]',
			projects_exclude_json: '["secret"]',
		});
		expect(syncProjectAllowed(db, "secret", PEER)).toBe(false);
		expect(syncProjectAllowed(db, "play", PEER)).toBe(false);
		expect(syncProjectAllowed(db, "work", PEER)).toBe(true);
	});

	it("preserves one NULL column without turning the pairing into an inheriting one", () => {
		pair({ include: null, exclude: ["secret"] });
		remove();

		pair();

		expect(saved()).toEqual({
			projects_include_json: null,
			projects_exclude_json: '["secret"]',
		});
	});

	it("preserves empty override lists, which differ from NULL inheritance", () => {
		pair({ include: [], exclude: [] });
		remove();

		pair();

		expect(saved()).toEqual({ projects_include_json: "[]", projects_exclude_json: "[]" });
	});

	it("does not copy another device's restrictions", () => {
		pair(RESTRICTED, "other-peer");
		remove("other-peer");

		pair();

		expect(saved()).toEqual({ projects_include_json: null, projects_exclude_json: null });
	});

	it("leaves explicitly supplied lists for the checked writer to authorize", () => {
		pair(RESTRICTED);
		remove();

		pair({ include: ["other"], exclude: ["secret"] });

		expect(saved()).toEqual({
			projects_include_json: '["other"]',
			projects_exclude_json: '["secret"]',
		});
	});

	it("captures the latest lists after an authorized change and another removal", () => {
		pair(RESTRICTED);
		remove();
		pair();
		db.prepare(
			"UPDATE sync_peers SET projects_include_json = '[]', projects_exclude_json = '[]'",
		).run();

		remove();
		pair();

		expect(saved()).toEqual({ projects_include_json: "[]", projects_exclude_json: "[]" });
	});

	it("retains restrictions through repeated delete/recreate cycles", () => {
		pair(RESTRICTED);
		for (let cycle = 0; cycle < 3; cycle++) {
			remove();
			pair();
		}

		expect(syncProjectAllowed(db, "secret", PEER)).toBe(false);
		expect(syncProjectAllowed(db, "play", PEER)).toBe(false);
	});
});

describe("retention shares the pairing writer's transaction", () => {
	it("keeps the pairing when saving its restrictions fails", () => {
		pair(RESTRICTED);
		db.exec(`CREATE TRIGGER fail_retention BEFORE INSERT ON peer_project_filter_retention
			BEGIN SELECT RAISE(ABORT, 'retention failed'); END`);

		expect(() => remove()).toThrow("retention failed");

		expect(saved()).toEqual({
			projects_include_json: '["work"]',
			projects_exclude_json: '["secret"]',
		});
		expect(readRetainedPeerProjectFilters(db, PEER)).toBeNull();
	});

	it("rolls retention back when deletion is rolled back", () => {
		pair(RESTRICTED);

		expect(() =>
			db.transaction(() => {
				remove();
				throw new Error("abort removal");
			})(),
		).toThrow("abort removal");

		expect(saved()).toBeDefined();
		expect(readRetainedPeerProjectFilters(db, PEER)).toBeNull();
	});

	it("rolls a restored pairing back when creation is rolled back", () => {
		pair(RESTRICTED);
		remove();

		expect(() =>
			db.transaction(() => {
				pair();
				throw new Error("abort pairing");
			})(),
		).toThrow("abort pairing");

		expect(saved()).toBeUndefined();
		expect(readRetainedPeerProjectFilters(db, PEER)?.projects_exclude_json).toBe('["secret"]');
	});
});

describe("retention schema initialization", () => {
	it("does not create storage from the reader", () => {
		const old = new Database(":memory:");

		expect(readRetainedPeerProjectFilters(old, PEER)).toBeNull();
		expect(old.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
		old.close();
	});

	it("leaves existing pairings unchanged when initialization runs again", () => {
		pair(RESTRICTED);
		const before = db.prepare("SELECT * FROM sync_peers").all();

		ensurePeerProjectFilterRetentionSchema(db);

		expect(db.prepare("SELECT * FROM sync_peers").all()).toEqual(before);
	});

	it("does not discard retained rows when initialization runs again", () => {
		pair(RESTRICTED);
		remove();
		const before = readRetainedPeerProjectFilters(db, PEER);

		ensurePeerProjectFilterRetentionSchema(db);

		expect(readRetainedPeerProjectFilters(db, PEER)).toEqual(before);
	});
});
