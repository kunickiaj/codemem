import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorListGroupsAction } from "./coordinator-actions.js";

const REMOTE = { remoteUrl: "https://coordinator.example.test", adminSecret: "synthetic-admin" };

function coordinatorReplies(body: string, contentType = "application/json") {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
		),
	);
}

function listEveryGroup() {
	return coordinatorListGroupsAction({ ...REMOTE, requireWellFormed: true });
}

afterEach(() => vi.unstubAllGlobals());

describe("listing coordinator groups for a caller that needs every group", () => {
	it.each([
		{ name: "has no list of groups", body: "{}" },
		{ name: "is not JSON", body: "<html>Bad gateway</html>", contentType: "text/html" },
		{ name: "is empty", body: "" },
		{ name: "lists an entry with no group ID", body: JSON.stringify({ items: [{}] }) },
		{ name: "lists an entry that is not a group", body: JSON.stringify({ items: [null] }) },
	])("fails when a successful reply $name", async ({ body, contentType }) => {
		coordinatorReplies(body, contentType);

		await expect(listEveryGroup()).rejects.toThrow();
	});

	it("returns no groups when the coordinator says it has none", async () => {
		coordinatorReplies(JSON.stringify({ items: [] }));

		expect(await listEveryGroup()).toEqual([]);
	});

	it("returns the groups the coordinator lists", async () => {
		coordinatorReplies(
			JSON.stringify({ items: [{ group_id: "group-a" }, { group_id: "group-b" }] }),
		);

		expect((await listEveryGroup()).map((group) => group.group_id)).toEqual(["group-a", "group-b"]);
	});

	it("keeps reading a reply with no list as no groups for other callers", async () => {
		coordinatorReplies("{}");

		expect(await coordinatorListGroupsAction(REMOTE)).toEqual([]);
	});
});
