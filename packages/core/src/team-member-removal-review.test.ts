import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTeamMemberRemoved } from "./team-member-removal-lookup.js";
import {
	commitTeamMemberRemoval,
	previewTeamMemberRemoval,
	revokePendingTeamInvitations,
	type TeamMemberRemovalContext,
} from "./team-member-removal-review.js";
import { linkTeamToCoordinatorGroup } from "./team-member-removal-test-fixtures.js";
import { initTestSchema } from "./test-utils.js";

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

function person(identityId: string, deviceId: string) {
	row("actors", {
		actor_id: identityId,
		display_name: `Person ${identityId}`,
		is_local: 0,
		status: "active",
		...stamps,
	});
	row("identity_devices", {
		device_id: deviceId,
		identity_id: identityId,
		display_name: `Laptop ${deviceId}`,
		status: "active",
		idempotency_key: `binding-${deviceId}`,
		...managed,
		...stamps,
	});
	row("policy_team_memberships", {
		team_id: team,
		identity_id: identityId,
		role: "member",
		status: "active",
		idempotency_key: `membership-${identityId}`,
		...managed,
		...stamps,
	});
}

const PENDING = [
	{ inviteId: "invite-pending", createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" },
];
const REMOVAL = {
	removal_seq: 4,
	group_id: "group-a",
	team_id: "",
	identity_id: "identity-removed",
	removed_by_device_id: "device-local",
	removed_at: NOW,
};

function context(overrides: Partial<TeamMemberRemovalContext> = {}) {
	const actions = {
		listPendingInvitations: vi.fn(async () => PENDING),
		recordRemoval: vi.fn(async () => ({
			status: "created" as const,
			removal: { ...REMOVAL, team_id: team },
		})),
		revokeInvitation: vi.fn(async () => "revoked" as const),
	};
	const ctx: TeamMemberRemovalContext = {
		coordinator: { remoteUrl: `${COORDINATOR}/`, adminSecret: "synthetic", groupIds: ["group-a"] },
		localIdentityId: "identity-local",
		localDeviceId: "device-local",
		now: () => NOW,
		actions,
		...overrides,
	};
	return { ctx, actions };
}

const subject = () => ({ teamId: team, identityId: "identity-removed" });

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
	person("identity-removed", "device-removed");
	person("identity-staying", "device-staying");
});

afterEach(() => db.close());

describe("previewing a Team member removal", () => {
	it("lists the person's devices and the Team's pending invitations", async () => {
		const { ctx, actions } = context();

		const preview = await previewTeamMemberRemoval(db, subject(), ctx);

		expect(preview).toMatchObject({
			state: "ready",
			teamName: "Core Team",
			displayName: "Person identity-removed",
			devices: [{ deviceId: "device-removed", displayName: "Laptop device-removed" }],
			pendingInvitations: PENDING,
			expectedDigest: expect.stringMatching(/^team-member-removal-preview-v1:[a-f0-9]{64}$/u),
		});
		expect(actions.listPendingInvitations).toHaveBeenCalledWith(ctx.coordinator, {
			groupId: "group-a",
			teamId: team,
			now: NOW,
		});
	});

	it.each([
		[
			"a Team no coordinator group set up",
			() => db.prepare("DELETE FROM legacy_team_setup_completions").run(),
			"team_not_linked",
		],
		[
			"a Team set up from another coordinator",
			() => {},
			"team_coordinator_not_configured",
			{ remoteUrl: "https://other.example.test" },
		],
		[
			"a Team set up from a group this device does not use",
			() => {},
			"team_coordinator_not_configured",
			{ groupIds: ["group-b"] },
		],
		[
			"a person who is not a member",
			() => db.prepare("UPDATE policy_team_memberships SET status = 'revoked'").run(),
			"member_not_found",
		],
	] as const)("refuses %s", async (_label, arrange, error, coordinator = {}) => {
		arrange();
		const { ctx } = context();

		const result = await previewTeamMemberRemoval(db, subject(), {
			...ctx,
			coordinator: { ...ctx.coordinator, ...coordinator },
		});

		expect(result).toEqual({ state: "rejected", error });
	});

	it("refuses to remove this device's own person", async () => {
		const { ctx } = context({ localIdentityId: "identity-removed" });

		expect(await previewTeamMemberRemoval(db, subject(), ctx)).toEqual({
			state: "rejected",
			error: "cannot_remove_yourself",
		});
	});

	it("refuses when the Team's invitations cannot be read", async () => {
		const { ctx, actions } = context();
		actions.listPendingInvitations.mockRejectedValueOnce(new Error("offline"));

		expect(await previewTeamMemberRemoval(db, subject(), ctx)).toEqual({
			state: "rejected",
			error: "invitations_unavailable",
		});
	});
});

describe("committing a Team member removal", () => {
	async function reviewed() {
		const { ctx, actions } = context();
		const preview = await previewTeamMemberRemoval(db, subject(), ctx);
		if (preview.state !== "ready") throw new Error("preview not ready");
		return { ctx, actions, digest: preview.expectedDigest };
	}

	it("records the removal, revokes the chosen invitations and applies it here", async () => {
		const { ctx, actions, digest } = await reviewed();

		const result = await commitTeamMemberRemoval(
			db,
			{ ...subject(), expectedDigest: digest, revokeInvitationIds: ["invite-pending"] },
			ctx,
		);

		expect(result).toEqual({
			state: "removed",
			removal: { ...REMOVAL, team_id: team },
			invitations: [{ inviteId: "invite-pending", result: "revoked" }],
			appliedHere: true,
		});
		expect(actions.recordRemoval).toHaveBeenCalledWith(ctx.coordinator, {
			groupId: "group-a",
			teamId: team,
			identityId: "identity-removed",
			removedByDeviceId: "device-local",
		});
		expect(isTeamMemberRemoved(db, team, "identity-removed")).toBe(true);
		expect(
			db
				.prepare("SELECT identity_id, status FROM policy_team_memberships ORDER BY identity_id")
				.all(),
		).toEqual([
			{ identity_id: "identity-removed", status: "revoked" },
			{ identity_id: "identity-staying", status: "active" },
		]);
	});

	it("reports an invitation someone accepted meanwhile", async () => {
		const { ctx, actions, digest } = await reviewed();
		actions.revokeInvitation.mockResolvedValueOnce("accepted" as never);

		const result = await commitTeamMemberRemoval(
			db,
			{ ...subject(), expectedDigest: digest, revokeInvitationIds: ["invite-pending"] },
			ctx,
		);

		expect(result).toMatchObject({
			invitations: [{ inviteId: "invite-pending", result: "accepted" }],
		});
	});

	it("changes nothing when the preview changed", async () => {
		const { ctx, actions, digest } = await reviewed();
		actions.listPendingInvitations.mockResolvedValueOnce([
			...PENDING,
			{ inviteId: "invite-new", createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" },
		]);

		const result = await commitTeamMemberRemoval(
			db,
			{ ...subject(), expectedDigest: digest, revokeInvitationIds: [] },
			ctx,
		);

		expect(result).toEqual({ state: "rejected", error: "removal_preview_stale" });
		expect(actions.recordRemoval).not.toHaveBeenCalled();
		expect(isTeamMemberRemoved(db, team, "identity-removed")).toBe(false);
	});

	it("refuses to revoke an invitation the preview did not list", async () => {
		const { ctx, actions, digest } = await reviewed();

		const result = await commitTeamMemberRemoval(
			db,
			{ ...subject(), expectedDigest: digest, revokeInvitationIds: ["invite-other"] },
			ctx,
		);

		expect(result).toEqual({ state: "rejected", error: "invalid_input" });
		expect(actions.recordRemoval).not.toHaveBeenCalled();
	});

	it("changes nothing here when the coordinator does not record the removal", async () => {
		const { ctx, actions, digest } = await reviewed();
		actions.recordRemoval.mockRejectedValueOnce(new Error("offline"));

		const result = await commitTeamMemberRemoval(
			db,
			{ ...subject(), expectedDigest: digest, revokeInvitationIds: ["invite-pending"] },
			ctx,
		);

		expect(result).toEqual({ state: "rejected", error: "coordinator_unavailable" });
		expect(actions.revokeInvitation).not.toHaveBeenCalled();
		expect(isTeamMemberRemoved(db, team, "identity-removed")).toBe(false);
	});
});

describe("committing a removal when a later step fails", () => {
	async function reviewed() {
		const { ctx, actions } = context();
		const preview = await previewTeamMemberRemoval(db, subject(), ctx);
		if (preview.state !== "ready") throw new Error("preview not ready");
		return { ctx, actions, digest: preview.expectedDigest };
	}

	it("enforces the removal here even when an invitation revoke stalls, and the revoke can be retried", async () => {
		const { ctx, actions, digest } = await reviewed();
		const order: string[] = [];
		actions.recordRemoval.mockImplementationOnce(async () => {
			order.push("record");
			return { status: "created" as const, removal: { ...REMOVAL, team_id: team } };
		});
		actions.revokeInvitation.mockImplementationOnce(async () => {
			order.push(`revoke, removed here: ${isTeamMemberRemoved(db, team, "identity-removed")}`);
			throw new Error("timed out");
		});

		const result = await commitTeamMemberRemoval(
			db,
			{ ...subject(), expectedDigest: digest, revokeInvitationIds: ["invite-pending"] },
			ctx,
		);
		const retry = await revokePendingTeamInvitations(
			db,
			{ teamId: team, inviteIds: ["invite-pending", "invite-gone"] },
			ctx,
		);

		expect(order).toEqual(["record", "revoke, removed here: true"]);
		expect(result).toMatchObject({
			state: "removed",
			appliedHere: true,
			invitations: [{ inviteId: "invite-pending", result: "unknown" }],
		});
		expect(retry).toEqual({
			state: "revoked",
			invitations: [
				{ inviteId: "invite-pending", result: "revoked" },
				{ inviteId: "invite-gone", result: "not_pending" },
			],
		});
	});

	it("reports the removal as not applied here when this machine ignores it", async () => {
		const { ctx, actions, digest } = await reviewed();
		actions.recordRemoval.mockImplementationOnce(async () => {
			// The Team's setup goes away while the coordinator records the removal.
			db.prepare("DELETE FROM legacy_team_setup_completions").run();
			return { status: "created" as const, removal: { ...REMOVAL, team_id: team } };
		});

		const result = await commitTeamMemberRemoval(
			db,
			{ ...subject(), expectedDigest: digest, revokeInvitationIds: [] },
			ctx,
		);

		expect(result).toMatchObject({ state: "removed", appliedHere: false });
	});

	it("reports the removal as not applied here when the local write fails, and still revokes", async () => {
		const { ctx, actions, digest } = await reviewed();
		db.exec(`CREATE TRIGGER fail_local_removal BEFORE INSERT ON policy_team_member_removals
			BEGIN SELECT RAISE(ABORT, 'write failed'); END`);

		const result = await commitTeamMemberRemoval(
			db,
			{ ...subject(), expectedDigest: digest, revokeInvitationIds: ["invite-pending"] },
			ctx,
		);

		expect(result).toMatchObject({
			state: "removed",
			appliedHere: false,
			invitations: [{ inviteId: "invite-pending", result: "revoked" }],
		});
		expect(actions.revokeInvitation).toHaveBeenCalledOnce();
	});
});

describe("retrying invitation revokes for a Team set up elsewhere", () => {
	it.each([
		["another coordinator", { remoteUrl: "https://other.example.test" }],
		["a group this device does not use", { groupIds: ["group-b"] }],
	] as const)("refuses a Team set up from %s and sends nothing", async (_label, coordinator) => {
		const { ctx, actions } = context();

		const result = await revokePendingTeamInvitations(
			db,
			{ teamId: team, inviteIds: ["invite-pending"] },
			{ ...ctx, coordinator: { ...ctx.coordinator, ...coordinator } },
		);

		expect(result).toEqual({ state: "rejected", error: "team_coordinator_not_configured" });
		expect(actions.listPendingInvitations).not.toHaveBeenCalled();
		expect(actions.revokeInvitation).not.toHaveBeenCalled();
	});
});
