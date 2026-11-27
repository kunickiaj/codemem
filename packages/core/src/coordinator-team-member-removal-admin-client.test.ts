import { afterEach, describe, expect, it, vi } from "vitest";
import {
	coordinatorListPendingTeamInvitationsAction,
	coordinatorRecordTeamMemberRemovalAction,
	coordinatorRevokeTeamInvitationAction,
} from "./coordinator-team-member-removal-admin-client.js";

const TARGET = { remoteUrl: "https://coord.example.test/", adminSecret: "synthetic-admin" };
const NOW = "2026-07-26T00:00:00.000Z";

function respond(status: number, body: unknown) {
	const fetchMock = vi.fn(
		async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const RECORD = {
	groupId: "group-a",
	teamId: "team-a",
	identityId: "identity-b",
	removedByDeviceId: "device-local",
};
const removal = (overrides: Record<string, unknown> = {}) => ({
	removal_seq: 3,
	group_id: "group-a",
	team_id: "team-a",
	identity_id: "identity-b",
	removed_by_device_id: "device-local",
	removed_at: NOW,
	...overrides,
});

describe("recording a Team member removal on the coordinator", () => {
	it("posts the removal with the admin secret and returns the stored record", async () => {
		const fetchMock = respond(201, { version: 1, status: "created", removal: removal() });

		const result = await coordinatorRecordTeamMemberRemovalAction(TARGET, RECORD);

		expect(result).toEqual({ status: "created", removal: removal() });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://coord.example.test/v1/admin/team-member-removals");
		expect(new Headers(init.headers).get("X-Codemem-Coordinator-Admin")).toBe("synthetic-admin");
		expect(JSON.parse(String(new TextDecoder().decode(init.body as Uint8Array)))).toEqual({
			group_id: "group-a",
			team_id: "team-a",
			identity_id: "identity-b",
			removed_by_device_id: "device-local",
		});
	});

	it.each([
		["another Team", removal({ team_id: "team-b" })],
		["another person", removal({ identity_id: "identity-c" })],
		["no sequence", removal({ removal_seq: 0 })],
	])("refuses a reply naming %s", async (_label, stored) => {
		respond(200, { version: 1, status: "existing", removal: stored });

		await expect(coordinatorRecordTeamMemberRemovalAction(TARGET, RECORD)).rejects.toThrow(
			"team_member_removal_response_invalid",
		);
	});

	it("passes on only a known error code", async () => {
		respond(500, "internal detail token=do-not-log");

		const error = await coordinatorRecordTeamMemberRemovalAction(TARGET, RECORD).catch((e) => e);

		expect(error).toMatchObject({ status: 500, code: "coordinator_unavailable" });
		expect(String(error.message)).not.toContain("do-not-log");
	});
});

describe("listing a Team's pending invitations", () => {
	const invite = (overrides: Record<string, unknown>) => ({
		invite_id: "invite-a",
		group_id: "group-a",
		token: "secret-token",
		invite_kind: "team_member",
		policy_team_id: "team-a",
		consumed_at: null,
		revoked_at: null,
		created_at: NOW,
		expires_at: "2099-01-01T00:00:00.000Z",
		...overrides,
	});

	it("keeps only this Team's unused, unrevoked and unexpired invitations, without tokens", async () => {
		respond(200, {
			items: [
				invite({ invite_id: "invite-b", created_at: "2026-07-27T00:00:00.000Z" }),
				invite({}),
				invite({ invite_id: "invite-other-team", policy_team_id: "team-b" }),
				invite({ invite_id: "invite-device", invite_kind: "add_device" }),
				invite({ invite_id: "invite-used", consumed_at: NOW }),
				invite({ invite_id: "invite-revoked", revoked_at: NOW }),
				invite({ invite_id: "invite-expired", expires_at: "2026-01-01T00:00:00.000Z" }),
			],
		});

		const pending = await coordinatorListPendingTeamInvitationsAction(TARGET, {
			groupId: "group-a",
			teamId: "team-a",
			now: NOW,
		});

		expect(pending).toEqual([
			{ inviteId: "invite-a", createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" },
			{
				inviteId: "invite-b",
				createdAt: "2026-07-27T00:00:00.000Z",
				expiresAt: "2099-01-01T00:00:00.000Z",
			},
		]);
		expect(JSON.stringify(pending)).not.toContain("secret-token");
	});

	it("refuses a list that includes another group's invitation", async () => {
		respond(200, { items: [invite({ group_id: "group-b" })] });

		await expect(
			coordinatorListPendingTeamInvitationsAction(TARGET, {
				groupId: "group-a",
				teamId: "team-a",
				now: NOW,
			}),
		).rejects.toThrow("team_member_removal_response_invalid");
	});
});

describe("revoking a Team invitation", () => {
	it.each([
		[200, { version: 1, status: "revoked", invite_id: "invite-a", revoked_at: NOW }, "revoked"],
		[
			200,
			{ version: 1, status: "already_revoked", invite_id: "invite-a", revoked_at: NOW },
			"already_revoked",
		],
		[409, { error: "invite_consumed" }, "accepted"],
		[404, { error: "invite_not_found" }, "not_found"],
	])("answers %i as %s", async (status, body, expected) => {
		respond(status, body);

		expect(
			await coordinatorRevokeTeamInvitationAction(TARGET, {
				groupId: "group-a",
				inviteId: "invite-a",
			}),
		).toBe(expected);
	});

	it("throws for an invitation that is not a Team invitation", async () => {
		respond(409, { error: "invite_kind_unsupported" });

		await expect(
			coordinatorRevokeTeamInvitationAction(TARGET, { groupId: "group-a", inviteId: "invite-a" }),
		).rejects.toMatchObject({ code: "invite_kind_unsupported" });
	});
});
