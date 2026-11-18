import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProjectScopeWithdrawn, MemoryStore, managedProjectScopeId } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectWithdrawalRoutes } from "./project-withdrawal.js";

const GROUP = "group-a";
const ATLAS = "git:example/atlas";
const ATLAS_BOUNDARY = managedProjectScopeId(GROUP, ATLAS);
const RECEIVED_ATLAS = `peer-received:scope:${ATLAS_BOUNDARY}`;

let directory: string;
let store: MemoryStore;

function addAtlasBoundary(): void {
	const now = new Date().toISOString();
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, 'Atlas', 'managed_project', 'coordinator', 'coord-1', ?, 1, 'active', ?, ?)`,
		)
		.run(ATLAS_BOUNDARY, GROUP, now, now);
	store.db
		.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
			 VALUES (?, ?, 'member', 'active', 1, ?)`,
		)
		.run(ATLAS_BOUNDARY, store.deviceId, now);
}

function post(action: "stop" | "resume", body: unknown) {
	return projectWithdrawalRoutes(() => store).request(
		`http://localhost/api/sync/project-withdrawals/v1/${action}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-project-withdrawal-"));
	// Scoped test override only; never read or write the user's signing keys.
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	store = new MemoryStore(join(directory, "store.sqlite"));
});

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("stopping and resuming a Project on this device", () => {
	it("stops and resumes a Project on its own boundary without the admin secret", async () => {
		addAtlasBoundary();

		const stopped = await post("stop", { workspace_identity: RECEIVED_ATLAS });
		const stoppedState = isProjectScopeWithdrawn(store.db, ATLAS_BOUNDARY);
		const resumed = await post("resume", { workspace_identity: RECEIVED_ATLAS });

		expect(stopped.status).toBe(200);
		expect(await stopped.json()).toMatchObject({
			workspace_identity: RECEIVED_ATLAS,
			stopped_at: expect.any(String),
		});
		expect(stoppedState).toBe(true);
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toEqual({ workspace_identity: RECEIVED_ATLAS, stopped_at: null });
		expect(isProjectScopeWithdrawn(store.db, ATLAS_BOUNDARY)).toBe(false);
	});

	it("refuses a Project that doesn't reach this device on its own boundary", async () => {
		const response = await post("stop", { workspace_identity: RECEIVED_ATLAS });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "project_not_on_own_boundary" });
	});

	it("refuses to resume a Project that isn't stopped", async () => {
		addAtlasBoundary();

		const response = await post("resume", { workspace_identity: RECEIVED_ATLAS });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "project_not_stopped" });
	});

	it.each([
		{},
		{ workspace_identity: "" },
		{ workspace_identity: RECEIVED_ATLAS, scope_id: ATLAS_BOUNDARY },
	])("rejects the request body %j", async (body) => {
		const response = await post("stop", body);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "project_identity_invalid" });
	});
});
