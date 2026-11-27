import { listRecipientPolicyIntent, MemoryStore, readCoordinatorSyncConfig } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { teamCoordinatorLinkState } from "../../../core/src/team-member-removal-lookup.js";
import { teamCreateRoutes } from "./team-create.js";

type CoordinatorOverrides = Partial<ReturnType<typeof readCoordinatorSyncConfig>>;

const READY: CoordinatorOverrides = {
	syncCoordinatorUrl: "https://coordinator.example.test",
	syncCoordinatorGroups: ["group-one"],
	syncCoordinatorAdminSecret: "admin-secret-for-tests",
};

describe("Create Team route", () => {
	let store: MemoryStore;

	beforeEach(() => {
		store = new MemoryStore(":memory:");
	});

	afterEach(() => store.close());

	function post(body: unknown, coordinator: CoordinatorOverrides = READY) {
		const app = teamCreateRoutes(
			() => store,
			() => ({ ...readCoordinatorSyncConfig({}), ...coordinator }),
		);
		return app.request("/api/sync/recipient-policy/v1/teams", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("creates a Team with this device's person as its admin", async () => {
		// Act
		const response = await post({ displayName: "Platform" });

		// Assert
		expect(response.status).toBe(201);
		const team = (await response.json()) as { teamId: string; displayName: string };
		expect(team).toEqual({
			version: 1,
			teamId: expect.stringMatching(/^team-/),
			displayName: "Platform",
		});
		const intent = listRecipientPolicyIntent(store.db);
		expect(intent.teamMemberships).toEqual([
			expect.objectContaining({ teamId: team.teamId, identityId: store.actorId, role: "admin" }),
		]);
	});

	it.each([
		[
			"has no admin secret",
			{ ...READY, syncCoordinatorAdminSecret: "" },
			403,
			"team_create_admin_required",
		],
		[
			"has no coordinator group",
			{ ...READY, syncCoordinatorGroups: [] },
			409,
			"team_create_coordinator_required",
		],
		[
			"has no coordinator",
			{ ...READY, syncCoordinatorUrl: "" },
			409,
			"team_create_coordinator_required",
		],
	])(
		"refuses when this device %s and writes nothing",
		async (_label, coordinator, status, error) => {
			const response = await post({ displayName: "Platform" }, coordinator);

			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error });
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		},
	);

	it.each([
		["a missing name", {}],
		["an extra field", { displayName: "Platform", teamId: "chosen" }],
		["a machine label", { displayName: "actor:machine" }],
	])("rejects %s", async (_label, body) => {
		const response = await post(body);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "team_name_invalid" });
	});

	it("records the configured coordinator group as the Team's group", async () => {
		const response = await post({ displayName: "Platform" });
		const { teamId } = (await response.json()) as { teamId: string };

		expect(teamCoordinatorLinkState(store.db, teamId)).toEqual({
			state: "linked",
			coordinatorId: "https://coordinator.example.test",
			groupId: "group-one",
		});
	});

	it("rejects a name another active Team uses", async () => {
		await post({ displayName: "Platform" });

		const response = await post({ displayName: "PLATFORM" });

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "team_name_taken" });
	});
});
