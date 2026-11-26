import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorListTeamMemberRemovalsAction } from "./coordinator-team-member-removal-client.js";

const OPTIONS = {
	groupId: "group-a",
	remoteUrl: "https://coord.example.test/",
	adminSecret: "synthetic-admin",
};

function removal(seq: number, overrides: Record<string, unknown> = {}) {
	return {
		removal_seq: seq,
		group_id: "group-a",
		team_id: "team-a",
		identity_id: `identity-${seq}`,
		removed_by_device_id: null,
		removed_at: "2026-07-26T00:00:00.000Z",
		...overrides,
	};
}

function respond(...responses: Array<[number, unknown]>) {
	const fetchMock = vi.fn(async () => {
		const [status, body] = responses.shift() ?? [500, { error: "unexpected" }];
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const page = (items: unknown[], next: number | null) => ({
	version: 1,
	items,
	next_after_seq: next,
});

afterEach(() => vi.unstubAllGlobals());

describe("reading a group's Team member removals", () => {
	it("follows the cursor to the last page and sends the admin secret", async () => {
		const fetchMock = respond(
			[200, page([removal(1), removal(4)], 4)],
			[200, page([removal(9)], null)],
		);

		const result = await coordinatorListTeamMemberRemovalsAction(OPTIONS);

		expect(result.map((item) => item.removal_seq)).toEqual([1, 4, 9]);
		const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
		expect(urls).toEqual([
			"https://coord.example.test/v1/admin/team-member-removals?group_id=group-a",
			"https://coord.example.test/v1/admin/team-member-removals?group_id=group-a&after_seq=4",
		]);
		const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
		expect(new Headers(init.headers).get("X-Codemem-Coordinator-Admin")).toBe("synthetic-admin");
	});

	it.each([
		["a known group", 404, { error: "group_not_found" }, "group_not_found"],
		[
			"a proxy's HTML not-found page",
			404,
			"<html>Not Found</html>",
			"team_member_removal_unavailable",
		],
		["a JSON not-found answer without an error code", 404, {}, "team_member_removal_unavailable"],
		[
			"storage that is missing or differs",
			503,
			{ error: "team_member_removal_unavailable" },
			"team_member_removal_unavailable",
		],
		[
			"an unknown remote message",
			500,
			"internal detail token=do-not-log",
			"team_member_removal_unavailable",
		],
	])("refuses %s with a safe code", async (_label, status, body, code) => {
		respond([status, body]);

		const error = await coordinatorListTeamMemberRemovalsAction(OPTIONS).catch((caught) => caught);

		expect(error).toMatchObject({ status, code });
		expect(String(error.message)).not.toContain("do-not-log");
	});

	it.each([
		["a removal from another group", page([removal(1, { group_id: "group-b" })], null)],
		["a malformed identity", page([removal(1, { identity_id: " identity-1" })], null)],
		["a missing field", page([{ ...removal(1), removed_at: undefined }], null)],
		["sequences out of order", page([removal(4), removal(2)], null)],
		["a cursor that does not match the last item", page([removal(1)], 7)],
		["a cursor on an empty page", page([], 3)],
		["an unknown version", { version: 2, items: [], next_after_seq: null }],
	])("refuses a page with %s", async (_label, body) => {
		respond([200, body]);

		await expect(coordinatorListTeamMemberRemovalsAction(OPTIONS)).rejects.toThrow(
			"team_member_removal_list_invalid",
		);
	});

	it("refuses a later page that repeats an earlier removal", async () => {
		respond([200, page([removal(4)], 4)], [200, page([removal(4)], null)]);

		await expect(coordinatorListTeamMemberRemovalsAction(OPTIONS)).rejects.toThrow(
			"team_member_removal_list_invalid",
		);
	});

	it("stops reading a list that never ends", async () => {
		let seq = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				seq += 1;
				return new Response(JSON.stringify(page([removal(seq)], seq)), { status: 200 });
			}),
		);

		await expect(coordinatorListTeamMemberRemovalsAction(OPTIONS)).rejects.toThrow(
			"team_member_removal_list_too_long",
		);
		expect(seq).toBe(50);
	});
});
