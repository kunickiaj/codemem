import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { TEAM_GROUP_BINDING_OBJECTS } from "./coordinator-team-group-bindings.js";
import { TEAM_GROUP_BINDING_CLOCK_MS } from "./coordinator-team-group-bindings-test-harness.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";

const dropStorage = (db: Database.Database) => {
	for (const { type, name } of TEAM_GROUP_BINDING_OBJECTS.toReversed())
		db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`);
};

let directory: string;
let path: string;
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "team-group-binding-routes-"));
	path = join(directory, "coordinator.sqlite");
	const store = new BetterSqliteCoordinatorStore(path);
	await store.createGroup("group-a");
	await store.createGroup("group-b");
	await store.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const runtime = { adminSecret: () => "test-secret", now: () => "2026-11-26T12:00:00Z" };
const app = (
	open = () =>
		new BetterSqliteCoordinatorStore(path, { authClock: () => TEAM_GROUP_BINDING_CLOCK_MS }),
) => createCoordinatorApp({ storeFactory: open, runtime, requestVerifier: async () => false });
const admin = { "X-Codemem-Coordinator-Admin": "test-secret" };
const bind = (body: unknown, headers: Record<string, string> = admin, target = app()) =>
	target.request("/v1/admin/team-group-bindings", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
const read = (query: string, headers: Record<string, string> = admin, target = app()) =>
	target.request(`/v1/admin/team-group-bindings${query}`, { headers });

async function mintTeamInvitation(groupId: string, teamId = "team-a") {
	const reviewedIntent = {
		version: 1,
		journey: "team",
		team: { teamId, displayName: "Team", futureProjectsInherit: true },
		projects: [],
		excludedProjects: [],
	};
	return app().request("/v1/admin/invites", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...admin },
		body: JSON.stringify({
			group_id: groupId,
			policy: "auto_admit",
			expires_at: "2099-01-01T00:00:00Z",
			coordinator_url: "https://coordinator.example.test",
			invite_kind: "team_member",
			policy_team_id: teamId,
			reviewed_intent: reviewedIntent,
			reviewed_preview_digest: await recipientReviewedIntentDigest(reviewedIntent),
		}),
	});
}

describe("Team group binding routes", () => {
	it("refuses both routes without the admin secret", async () => {
		const wrong = { "X-Codemem-Coordinator-Admin": "wrong" };

		expect((await bind({ team_id: "team-a", group_id: "group-a" }, {})).status).toBe(401);
		expect((await bind({ team_id: "team-a", group_id: "group-a" }, wrong)).status).toBe(401);
		expect((await read("?team_id=team-a", wrong)).status).toBe(401);
		expect(await (await read("?team_id=team-a")).json()).toEqual({
			version: 1,
			items: [{ team_id: "team-a", state: "unbound" }],
		});
	});

	it("binds once, answers the same binding again, and refuses a second group", async () => {
		const created = await bind({ team_id: "team-a", group_id: "group-a" });
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({
			version: 1,
			status: "created",
			binding: { team_id: "team-a", group_id: "group-a" },
		});

		expect((await bind({ team_id: "team-a", group_id: "group-a" })).status).toBe(200);
		const other = await bind({ team_id: "team-a", group_id: "group-b" });
		expect(other.status).toBe(409);
		expect(await other.json()).toEqual({ error: "team_bound_to_other_group" });
		const unknown = await bind({ team_id: "team-b", group_id: "group-missing" });
		expect(unknown.status).toBe(404);
	});

	it("reads several Teams at once", async () => {
		await bind({ team_id: "team-a", group_id: "group-a" });

		const response = await read("?team_id=team-a&team_id=team-b");

		expect(await response.json()).toEqual({
			version: 1,
			items: [
				{ team_id: "team-a", state: "bound", group_id: "group-a" },
				{ team_id: "team-b", state: "unbound" },
			],
		});
	});

	it.each([
		["malformed JSON", "{"],
		["an unknown field", { team_id: "team-a", group_id: "group-a", source: "admin" }],
		["a missing group", { team_id: "team-a" }],
		["a numeric Team", { team_id: 7, group_id: "group-a" }],
	])("refuses a bind body with %s", async (_name, body) => {
		expect((await bind(body)).status).toBe(400);
		expect(await (await read("?team_id=team-a")).json()).toMatchObject({
			items: [{ state: "unbound" }],
		});
	});

	it.each([
		["no Team", ""],
		["an unknown parameter", "?team_id=team-a&group_id=group-a"],
		["too many Teams", `?${Array.from({ length: 51 }, (_, i) => `team_id=t${i}`).join("&")}`],
	])("refuses a read with %s", async (_name, query) => {
		expect((await read(query)).status).toBe(400);
	});

	it("answers 503 while the database has no binding storage", async () => {
		// Opening the SQLite store installs missing storage, so drop it after each open.
		const withoutStorage = app(() => {
			const store = new BetterSqliteCoordinatorStore(path);
			dropStorage(store.db);
			return store;
		});

		expect((await read("?team_id=team-a", admin, withoutStorage)).status).toBe(503);
		const response = await bind({ team_id: "team-a", group_id: "group-a" }, admin, withoutStorage);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "team_group_binding_unavailable" });
	});
});

describe("minting a Team invitation", () => {
	it("binds the Team to the first group and refuses another group with 409", async () => {
		expect((await mintTeamInvitation("group-a")).status).toBe(200);

		const other = await mintTeamInvitation("group-b");

		expect(other.status).toBe(409);
		expect(await other.json()).toEqual({ error: "team_bound_to_other_group" });
		expect(await (await read("?team_id=team-a")).json()).toMatchObject({
			items: [{ state: "bound", group_id: "group-a" }],
		});
	});

	it("answers 409 for a Team ID two groups used before bindings existed", async () => {
		const store = new BetterSqliteCoordinatorStore(path);
		store.db.exec(`INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at, invite_kind, policy_team_id) VALUES
			('prior-a', 'group-a', 'ta', 'auto_admit', '2099', '2026', 'team_member', 'team-shared'),
			('prior-b', 'group-b', 'tb', 'auto_admit', '2099', '2026', 'team_member', 'team-shared')`);
		await store.close();

		const response = await mintTeamInvitation("group-a", "team-shared");

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "team_binding_conflict" });
		expect(await (await read("?team_id=team-shared")).json()).toMatchObject({
			items: [{ state: "conflict" }],
		});
	});
});
