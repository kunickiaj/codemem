import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { TEAM_MEMBER_REMOVAL_OBJECTS } from "./coordinator-team-member-removals.js";
import { TEAM_MEMBER_REMOVAL_CLOCK_MS } from "./coordinator-team-member-removals-test-harness.js";

const dropStorage = (db: Database.Database) => {
	for (const { type, name } of TEAM_MEMBER_REMOVAL_OBJECTS.toReversed())
		db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`);
};

let directory: string;
let path: string;
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "team-member-removal-routes-"));
	path = join(directory, "coordinator.sqlite");
	const store = new BetterSqliteCoordinatorStore(path);
	await store.createGroup("group-a");
	await store.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const runtime = { adminSecret: () => "test-secret", now: () => "2026-11-25T12:00:00Z" };
const app = (
	open = () =>
		new BetterSqliteCoordinatorStore(path, { authClock: () => TEAM_MEMBER_REMOVAL_CLOCK_MS }),
) => createCoordinatorApp({ storeFactory: open, runtime, requestVerifier: async () => false });
const admin = { "X-Codemem-Coordinator-Admin": "test-secret" };
const post = (body: unknown, headers: Record<string, string> = admin, target = app()) =>
	target.request("/v1/admin/team-member-removals", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
const list = (query: string, headers: Record<string, string> = admin) =>
	app().request(`/v1/admin/team-member-removals${query}`, { headers });
const body = {
	group_id: "group-a",
	team_id: "team-a",
	identity_id: "identity:a",
	removed_by_device_id: "device-admin",
};
const removal = {
	removal_seq: 1,
	group_id: "group-a",
	team_id: "team-a",
	identity_id: "identity:a",
	removed_by_device_id: "device-admin",
	removed_at: new Date(TEAM_MEMBER_REMOVAL_CLOCK_MS).toISOString(),
};

describe("recording a Team member removal", () => {
	it("refuses both routes without the admin secret", async () => {
		const wrong = { "X-Codemem-Coordinator-Admin": "wrong" };

		expect((await post(body, {})).status).toBe(401);
		expect((await post(body, wrong)).status).toBe(401);
		expect((await list("?group_id=group-a", wrong)).status).toBe(401);
		expect(await (await list("?group_id=group-a")).json()).toEqual({
			version: 1,
			items: [],
			next_after_seq: null,
		});
	});

	it("records a removal once and then answers with the same record", async () => {
		const created = await post(body);
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({ version: 1, status: "created", removal });

		const again = await post({ ...body, removed_by_device_id: "device-other" });
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ version: 1, status: "existing", removal });
	});

	it.each([
		["malformed JSON", "{"],
		["an unknown field", { ...body, role: "member" }],
		["a missing identity", { group_id: "group-a", team_id: "team-a" }],
		["a padded Team", { ...body, team_id: " team-a" }],
		["a numeric device", { ...body, removed_by_device_id: 7 }],
	])("refuses a body with %s", async (_name, invalid) => {
		const response = await post(invalid);

		expect(response.status).toBe(400);
		expect(await (await list("?group_id=group-a")).json()).toMatchObject({ items: [] });
	});

	it("answers 404 for an unknown group", async () => {
		const response = await post({ ...body, group_id: "group-missing" });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "group_not_found" });
	});

	it("answers 503 while the database has no removal storage", async () => {
		// Opening the SQLite store installs missing storage, so drop it after each open.
		const withoutStorage = app(() => {
			const store = new BetterSqliteCoordinatorStore(path);
			dropStorage(store.db);
			return store;
		});

		const response = await post(body, admin, withoutStorage);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "team_member_removal_unavailable" });
	});
});

describe("listing Team member removals", () => {
	it("lists removals by group and Team", async () => {
		await post(body);
		await post({ ...body, team_id: "team-b", identity_id: "identity:b" });

		const response = await list("?group_id=group-a&team_id=team-a");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			version: 1,
			items: [removal],
			next_after_seq: null,
		});
		expect(
			(await (await list("?group_id=group-a&after_seq=1")).json()).items.map(
				(item: { identity_id: string }) => item.identity_id,
			),
		).toEqual(["identity:b"]);
	});

	it("only reads: listing changes no row", async () => {
		await post(body);
		const changes = () => {
			const db = new Database(path, { readonly: true });
			try {
				return db
					.prepare(
						"SELECT (SELECT COUNT(*) FROM coordinator_team_member_removals) || ':' || (SELECT COUNT(*) FROM coordinator_invites)",
					)
					.pluck()
					.get();
			} finally {
				db.close();
			}
		};
		const before = changes();
		const store = new BetterSqliteCoordinatorStore(path);
		const run = vi.spyOn(store.db, "prepare");
		try {
			const response = await app(() => store).request(
				"/v1/admin/team-member-removals?group_id=group-a",
				{ headers: admin },
			);
			expect(response.status).toBe(200);
			const writes = run.mock.calls
				.map(([sql]) => String(sql).trim())
				.filter((sql) => !/^(SELECT|WITH)\b/iu.test(sql));
			expect(writes).toEqual([]);
		} finally {
			run.mockRestore();
		}
		expect(changes()).toBe(before);
	});

	it.each([
		["no group", ""],
		["an unknown parameter", "?group_id=group-a&identity_id=identity:a"],
		["a repeated parameter", "?group_id=group-a&group_id=group-b"],
		["a negative cursor", "?group_id=group-a&after_seq=-1"],
		["a fractional cursor", "?group_id=group-a&after_seq=1.5"],
	])("refuses a list query with %s", async (_name, query) => {
		const response = await list(query);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_input" });
	});
});
