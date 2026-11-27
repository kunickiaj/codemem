import { afterEach, describe, expect, it, vi } from "vitest";
import {
	commitTeamMemberRemoval,
	loadTeamGroupConflicts,
	previewTeamMemberRemoval,
	retryTeamInvitationRevokes,
	TeamMemberRemovalApiError,
} from "./team-member-removal";

function respond(status: number, body: unknown) {
	const fetchMock = vi.fn(
		async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const PREVIEW = {
	state: "ready",
	teamId: "team/a",
	teamName: "Product",
	identityId: "identity-casey",
	displayName: "Casey",
	devices: [{ deviceId: "device-casey", displayName: "Laptop" }],
	pendingInvitations: [{ inviteId: "invite-1", createdAt: "2026-11-01", expiresAt: "2026-12-01" }],
	expectedDigest: "digest-1",
};

afterEach(() => vi.unstubAllGlobals());

describe("Team member removal API", () => {
	it("previews with the Team ID encoded in the path", async () => {
		const fetchMock = respond(200, PREVIEW);

		const preview = await previewTeamMemberRemoval({
			teamId: "team/a",
			identityId: "identity-casey",
		});

		expect(preview).toMatchObject({ displayName: "Casey", expectedDigest: "digest-1" });
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/sync/recipient-policy/v1/teams/team%2Fa/member-removals/preview",
		);
	});

	it.each([
		["another person", { ...PREVIEW, identityId: "identity-other" }],
		["a malformed device", { ...PREVIEW, devices: [{ deviceId: 7 }] }],
		["a missing digest", { ...PREVIEW, expectedDigest: "" }],
	])("refuses a preview naming %s", async (_label, body) => {
		respond(200, body);

		await expect(
			previewTeamMemberRemoval({ teamId: "team/a", identityId: "identity-casey" }),
		).rejects.toMatchObject({ errorCode: "team_member_removal_failed" });
	});

	it("passes on only known error codes", async () => {
		respond(409, { error: "removal_preview_stale" });
		await expect(
			commitTeamMemberRemoval({
				teamId: "team-a",
				identityId: "identity-casey",
				expectedDigest: "digest-1",
				revokeInvitationIds: [],
			}),
		).rejects.toEqual(new TeamMemberRemovalApiError(409, "removal_preview_stale"));

		respond(500, { error: "remote text https://coordinator.example.invalid" });
		await expect(
			retryTeamInvitationRevokes({ teamId: "team-a", inviteIds: ["invite-1"] }),
		).rejects.toMatchObject({ errorCode: "team_member_removal_failed" });
	});

	it("reads commit and retry results, refusing an unknown invitation result", async () => {
		respond(200, {
			state: "removed",
			appliedHere: false,
			invitations: [{ inviteId: "invite-1", result: "unknown" }],
		});
		await expect(
			commitTeamMemberRemoval({
				teamId: "team-a",
				identityId: "identity-casey",
				expectedDigest: "digest-1",
				revokeInvitationIds: ["invite-1"],
			}),
		).resolves.toEqual({
			appliedHere: false,
			invitations: [{ inviteId: "invite-1", result: "unknown" }],
		});

		respond(200, { state: "revoked", invitations: [{ inviteId: "invite-1", result: "maybe" }] });
		await expect(
			retryTeamInvitationRevokes({ teamId: "team-a", inviteIds: ["invite-1"] }),
		).rejects.toMatchObject({ errorCode: "team_member_removal_failed" });
	});

	it("loads Teams whose coordinator group is a conflict, and fails on a bad answer", async () => {
		respond(200, { teamIds: ["team-a"] });
		await expect(loadTeamGroupConflicts()).resolves.toEqual(["team-a"]);

		respond(503, {});
		await expect(loadTeamGroupConflicts()).rejects.toThrow("team_group_conflicts_unavailable");
	});

	it("gives up on a conflict-list read that stalls past the shared read deadline", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(() => new Promise<Response>(() => undefined)),
			);
			const read = loadTeamGroupConflicts();
			const rejection = expect(read).rejects.toThrow("team_group_conflicts_unavailable");

			await vi.advanceTimersByTimeAsync(15_000);

			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});
});
