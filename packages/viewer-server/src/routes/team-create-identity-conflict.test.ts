import { MemoryStore, readCoordinatorSyncConfig } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Simulate this device's person being unconfirmed, as when history adoption is
// waiting on a conflict. The route must not make anyone the Team's admin.
vi.mock("./sync.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./sync.js")>();
	return { ...original, ensureLocalActorRecord: () => false };
});

import { teamCreateRoutes } from "./team-create.js";

describe("Create Team route with an unconfirmed local person", () => {
	const store = new MemoryStore(":memory:");

	afterEach(() => store.close());

	it("refuses and writes nothing", async () => {
		const app = teamCreateRoutes(
			() => store,
			() => ({
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "https://coordinator.example.test",
				syncCoordinatorGroups: ["group-one"],
				syncCoordinatorAdminSecret: "admin-secret-for-tests",
			}),
		);

		const response = await app.request("/api/sync/recipient-policy/v1/teams", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ displayName: "Platform" }),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "team_creator_unavailable" });
		expect(store.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
	});
});
