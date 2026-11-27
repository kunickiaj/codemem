import { initTestSchema, type MemoryStore, readCoordinatorSyncConfig } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkTeamToCoordinatorGroup } from "../../../core/src/team-member-removal-test-fixtures.js";
import { teamMemberRemovalRoutes } from "./team-member-removal.js";

const NOW = "2026-07-26T00:00:00.000Z";
const COORDINATOR = "https://coord.example.test";
let db: InstanceType<typeof Database>;
let team: string;

function row(table: string, values: Record<string, unknown>) {
	const columns = Object.keys(values);
	db.prepare(
		`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
	).run(...Object.values(values));
}

const stamps = { created_at: NOW, updated_at: NOW };
const managed = { provenance: "test", revision: "r1", migration_state: "user_managed" };

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	team = linkTeamToCoordinatorGroup(db, {
		candidateId: "candidate-a",
		coordinatorId: COORDINATOR,
		groupId: "group-a",
	});
	row("policy_teams", {
		team_id: team,
		display_name: "Core Team",
		status: "active",
		idempotency_key: "team",
		...managed,
		...stamps,
	});
	row("actors", {
		actor_id: "identity-b",
		display_name: "Bea",
		is_local: 0,
		status: "active",
		...stamps,
	});
	row("policy_team_memberships", {
		team_id: team,
		identity_id: "identity-b",
		role: "member",
		status: "active",
		idempotency_key: "membership-b",
		...managed,
		...stamps,
	});
});

afterEach(() => db.close());

function app(options: { adminSecret?: string } = {}) {
	const actions = {
		listPendingInvitations: vi.fn(async () => []),
		recordRemoval: vi.fn(async () => ({
			status: "created" as const,
			removal: {
				removal_seq: 1,
				group_id: "group-a",
				team_id: team,
				identity_id: "identity-b",
				removed_by_device_id: "device-local",
				removed_at: NOW,
			},
		})),
		revokeInvitation: vi.fn(async () => "revoked" as const),
	};
	const store = {
		db,
		actorId: "identity-local",
		deviceId: "device-local",
	} as unknown as MemoryStore;
	const routes = teamMemberRemovalRoutes(() => store, {
		readCoordinatorConfig: () => ({
			...readCoordinatorSyncConfig({}),
			syncCoordinatorUrl: COORDINATOR,
			syncCoordinatorGroups: ["group-a"],
			syncCoordinatorAdminSecret: options.adminSecret ?? "synthetic-admin",
		}),
		actions,
	});
	const post = (path: string, body: unknown) =>
		routes.request(`/api/sync/recipient-policy/v1/teams/${team}/member-removals/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	return { post, actions };
}

describe("Team member removal routes", () => {
	it("refuses a device without the coordinator admin secret", async () => {
		const response = await app({ adminSecret: "" }).post("preview", { identityId: "identity-b" });

		expect([response.status, await response.json()]).toEqual([
			403,
			{ error: "coordinator_admin_required" },
		]);
	});

	it.each([
		["preview", { identityId: "identity-b", extra: 1 }],
		["preview", { identityId: " identity-b" }],
		["commit", { identityId: "identity-b", expectedDigest: "d" }],
		[
			"commit",
			{ identityId: "identity-b", expectedDigest: "d", revokeInvitationIds: ["bad\u0000id"] },
		],
	])("refuses a malformed %s body", async (path, body) => {
		const response = await app().post(path, body);

		expect([response.status, await response.json()]).toEqual([400, { error: "invalid_input" }]);
	});

	it("previews, then commits the reviewed removal", async () => {
		const { post, actions } = app();
		const preview = await (await post("preview", { identityId: "identity-b" })).json();

		const commit = await post("commit", {
			identityId: "identity-b",
			expectedDigest: preview.expectedDigest,
			revokeInvitationIds: [],
		});

		expect(preview).toMatchObject({ state: "ready", displayName: "Bea", pendingInvitations: [] });
		expect(commit.status).toBe(200);
		expect(await commit.json()).toMatchObject({ state: "removed", appliedHere: true });
		expect(actions.recordRemoval).toHaveBeenCalledOnce();
	});

	it("retries revoking a pending invitation on its own", async () => {
		const { actions } = app();
		actions.listPendingInvitations.mockResolvedValue([
			{ inviteId: "invite-a", createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" },
		] as never);
		const store = {
			db,
			actorId: "identity-local",
			deviceId: "device-local",
		} as unknown as MemoryStore;
		const routes = teamMemberRemovalRoutes(() => store, {
			readCoordinatorConfig: () => ({
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: COORDINATOR,
				syncCoordinatorGroups: ["group-a"],
				syncCoordinatorAdminSecret: "synthetic-admin",
			}),
			actions,
		});
		const revoke = (body: unknown) =>
			routes.request(`/api/sync/recipient-policy/v1/teams/${team}/invitations/revoke`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

		const response = await revoke({ inviteIds: ["invite-a"] });

		expect(await response.json()).toEqual({
			state: "revoked",
			invitations: [{ inviteId: "invite-a", result: "revoked" }],
		});
		expect((await revoke({ inviteIds: [] })).status).toBe(400);
	});

	it("accepts an identity in any format the policy layer accepts", async () => {
		const identityId = "person@example.test/çà";
		row("actors", {
			actor_id: identityId,
			display_name: "Çà",
			is_local: 0,
			status: "active",
			...stamps,
		});
		row("policy_team_memberships", {
			team_id: team,
			identity_id: identityId,
			role: "member",
			status: "active",
			idempotency_key: "membership-unicode",
			...managed,
			...stamps,
		});
		const { post } = app();

		const response = await post("preview", { identityId });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ state: "ready", identityId });
	});

	it("answers 409 for a stale preview and records nothing", async () => {
		const { post, actions } = app();

		const commit = await post("commit", {
			identityId: "identity-b",
			expectedDigest: "team-member-removal-preview-v1:stale",
			revokeInvitationIds: [],
		});

		expect([commit.status, await commit.json()]).toEqual([409, { error: "removal_preview_stale" }]);
		expect(actions.recordRemoval).not.toHaveBeenCalled();
	});
});
