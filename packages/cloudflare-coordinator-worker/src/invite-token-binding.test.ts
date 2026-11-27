import { randomBytes } from "node:crypto";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sqliteD1, workerSchemaSql } from "../../core/src/coordinator-auth-store-test-fixtures.js";
import { createCloudflareCoordinatorWorker } from "./index.js";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(workerSchemaSql());
	// The operator has recorded that every Worker serving the database matches tokens by digest only.
	db.prepare(
		`INSERT INTO coordinator_metadata (name, value, updated_at)
		VALUES ('invite_token_min_serving_lookup_version', 1, '2026-03-28T00:00:00Z')`,
	).run();
});
afterEach(() => db.close());

function createInvite(bindings: Record<string, unknown>) {
	const worker = createCloudflareCoordinatorWorker({ now: () => "2026-03-28T00:00:00Z" });
	return worker.fetch(
		new Request("https://coord.example.test/v1/admin/invites", {
			method: "POST",
			headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": "test-secret" },
			body: JSON.stringify({
				group_id: "g1",
				policy: "approval_required",
				expires_at: "2099-01-01T00:00:00Z",
				coordinator_url: "https://coord.example.test",
			}),
		}),
		{
			COORDINATOR_DB: sqliteD1(db),
			CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
			...bindings,
		},
	);
}

it("seals invitation tokens with its own key binding and refuses to create one without it", async () => {
	// Arrange
	await new D1CoordinatorStore(sqliteD1(db)).createGroup("g1", "Team Alpha");
	// Act: the test process environment has a key, which the Worker must not use.
	const refused = await createInvite({});
	const created = await createInvite({ CODEMEM_INVITE_TOKEN_KEY: randomBytes(32).toString("hex") });
	const { payload } = (await created.json()) as { payload: { token: string } };
	// Assert
	expect(process.env.CODEMEM_INVITE_TOKEN_KEY).toBeTruthy();
	expect(refused.status).toBe(503);
	expect(await refused.json()).toEqual({ error: "invite_token_key_unavailable" });
	expect(created.status).toBe(200);
	expect(db.prepare("SELECT token FROM coordinator_invites").all()).toEqual([
		{ token: expect.stringMatching(/^sealed:/u) },
	]);
	expect(JSON.stringify(db.prepare("SELECT * FROM coordinator_invites").all())).not.toContain(
		payload.token,
	);
});
