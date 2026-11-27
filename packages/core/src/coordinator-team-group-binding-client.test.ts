import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorReadTeamGroupBindingsAction } from "./coordinator-team-group-binding-client.js";

const OPTIONS = { remoteUrl: "https://coord.example.test/", adminSecret: "synthetic-admin" };

function respond(...responses: Array<[number, unknown]>) {
	const fetchMock = vi.fn(async () => {
		const [status, body] = responses.shift() ?? [500, { error: "unexpected" }];
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const bound = (teamId: string, groupId = "group-a") => ({
	team_id: teamId,
	state: "bound",
	group_id: groupId,
});

afterEach(() => vi.unstubAllGlobals());

describe("reading Team group bindings", () => {
	it("asks for each Team once, in chunks of 50, with the admin secret", async () => {
		const teamIds = Array.from({ length: 51 }, (_, i) => `team-${String(i).padStart(2, "0")}`);
		const fetchMock = respond(
			[200, { version: 1, items: teamIds.slice(0, 50).map((id) => bound(id)) }],
			[200, { version: 1, items: [{ team_id: "team-50", state: "unbound" }] }],
		);

		const result = await coordinatorReadTeamGroupBindingsAction({
			...OPTIONS,
			teamIds: [...teamIds, "team-00"],
		});

		expect(result).toHaveLength(51);
		expect(result.at(-1)).toEqual({ team_id: "team-50", state: "unbound" });
		const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
		expect(calls[0]?.[0]).toMatch(
			/^https:\/\/coord\.example\.test\/v1\/admin\/team-group-bindings\?team_id=team-00&/u,
		);
		expect(new Headers(calls[1]?.[1].headers).get("X-Codemem-Coordinator-Admin")).toBe(
			"synthetic-admin",
		);
	});

	it.each([
		["a Team left out", { version: 1, items: [] }],
		["another Team", { version: 1, items: [bound("team-b")] }],
		["an unknown state", { version: 1, items: [{ team_id: "team-a", state: "maybe" }] }],
		[
			"a bound Team without a group",
			{ version: 1, items: [{ team_id: "team-a", state: "bound" }] },
		],
		["an extra field", { version: 1, items: [{ ...bound("team-a"), source: "admin" }] }],
		["another version", { version: 2, items: [bound("team-a")] }],
	])("refuses an answer with %s", async (_label, body) => {
		respond([200, body]);

		await expect(
			coordinatorReadTeamGroupBindingsAction({ ...OPTIONS, teamIds: ["team-a"] }),
		).rejects.toThrow("team_group_binding_response_invalid");
	});

	it("passes on only known error codes", async () => {
		respond([503, { error: "team_group_binding_unavailable" }], [500, { error: "secret detail" }]);

		await expect(
			coordinatorReadTeamGroupBindingsAction({ ...OPTIONS, teamIds: ["team-a"] }),
		).rejects.toMatchObject({ code: "team_group_binding_unavailable" });
		await expect(
			coordinatorReadTeamGroupBindingsAction({ ...OPTIONS, teamIds: ["team-a"] }),
		).rejects.toMatchObject({ code: "coordinator_unavailable" });
	});
});
