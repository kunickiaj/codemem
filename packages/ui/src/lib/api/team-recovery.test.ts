import { afterEach, describe, expect, it, vi } from "vitest";
import { commitTeamRecovery, previewTeamRecovery, TeamRecoveryApiError } from "./team-recovery";

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
	teamName: "Engineering",
	candidateRef: "candidate-1",
	people: [{ identityId: "identity-b", displayName: "Person B", outcome: "member" }],
	devices: [
		{
			deviceId: "device-b",
			displayName: "Desktop",
			identityId: "identity-b",
			outcome: "regains_access",
		},
		{
			deviceId: "device-a",
			displayName: null,
			identityId: null,
			outcome: "stays_out",
			reason: "removed_from_group",
		},
	],
	projects: [{ projectIdentity: "project-1", displayName: "api", outcome: "restored" }],
	discardedSetupAttempts: 0,
	expectedDigest: "digest-1",
};

const failure = (call: Promise<unknown>) =>
	call.then(
		() => {
			throw new Error("expected a refusal");
		},
		(cause: unknown) => cause as TeamRecoveryApiError,
	);

afterEach(() => vi.unstubAllGlobals());

describe("Team recovery API", () => {
	it("previews with the Team ID encoded in the path and an empty body", async () => {
		const fetchMock = respond(200, PREVIEW);

		const preview = await previewTeamRecovery({ teamId: "team/a" });

		expect(preview).toMatchObject({ teamName: "Engineering", expectedDigest: "digest-1" });
		expect(preview.devices.map((device) => device.outcome)).toEqual([
			"regains_access",
			"stays_out",
		]);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("/api/sync/recipient-policy/v1/teams/team%2Fa/recovery/preview");
		expect(init?.body).toBe("{}");
	});

	it.each([
		["another Team", { teamId: "team-other" }],
		[
			"a row with an outcome it does not know",
			{ devices: [{ deviceId: "d", displayName: null, outcome: "admitted" }] },
		],
		["no digest", { expectedDigest: "" }],
	])("refuses a preview for %s", async (_case, broken) => {
		respond(200, { ...PREVIEW, ...broken });

		const error = await failure(previewTeamRecovery({ teamId: "team/a" }));

		expect(error).toBeInstanceOf(TeamRecoveryApiError);
		expect(error.errorCode).toBe("team_recovery_failed");
	});

	it("commits the reviewed digest", async () => {
		const fetchMock = respond(200, { state: "recovered", preview: PREVIEW });

		await commitTeamRecovery({ teamId: "team/a", expectedDigest: "digest-1" });

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("/api/sync/recipient-policy/v1/teams/team%2Fa/recovery/commit");
		expect(init?.body).toBe(JSON.stringify({ expectedDigest: "digest-1" }));
	});

	it("carries a refusal's devices and an unsettled recovery's reason", async () => {
		respond(409, { error: "device_key_changed", deviceIds: ["device-b"] });
		const refused = await failure(previewTeamRecovery({ teamId: "team/a" }));
		respond(503, { error: "recovery_unverified", reason: "evidence_stale" });
		const unverified = await failure(commitTeamRecovery({ teamId: "team/a", expectedDigest: "d" }));

		expect([refused.statusCode, refused.errorCode, refused.detail.deviceIds]).toEqual([
			409,
			"device_key_changed",
			["device-b"],
		]);
		expect([unverified.errorCode, unverified.detail.reason]).toEqual([
			"recovery_unverified",
			"evidence_stale",
		]);
	});

	it("reports an error code it does not know, and a failed request, as a failed recovery", async () => {
		respond(500, { error: "something_new", reason: "made_up" });
		const unknown = await failure(commitTeamRecovery({ teamId: "team/a", expectedDigest: "d" }));
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const offline = await failure(previewTeamRecovery({ teamId: "team/a" }));

		expect([unknown.errorCode, unknown.detail.reason]).toEqual(["team_recovery_failed", undefined]);
		expect([offline.errorCode, offline.statusCode]).toEqual(["team_recovery_failed", 0]);
	});
});
