import { afterEach, describe, expect, it } from "vitest";

import { state } from "../../lib/state";
import { actorDisplayLabel, assignmentNote, buildActorSelectOptions } from "./helpers";

const originalActors = state.lastSyncActors;
const originalPeers = state.lastSyncPeers;
const originalViewModel = state.lastSyncViewModel;

afterEach(() => {
	state.lastSyncActors = originalActors;
	state.lastSyncPeers = originalPeers;
	state.lastSyncViewModel = originalViewModel;
});

describe("actorDisplayLabel", () => {
	it("labels the local actor as You", () => {
		expect(
			actorDisplayLabel({ actor_id: "actor-local", display_name: "Adam", is_local: true }),
		).toBe("You");
	});
});

describe("assignmentNote", () => {
	it("describes local assignment as identity across devices", () => {
		state.lastSyncActors = [{ actor_id: "actor-local", display_name: "Adam", is_local: true }];

		expect(assignmentNote("actor-local")).toContain("identity across your devices");
	});
});

describe("buildActorSelectOptions", () => {
	it("keeps You available while hiding unresolved duplicate people elsewhere", () => {
		state.lastSyncActors = [
			{ actor_id: "actor-local", display_name: "Adam", is_local: true },
			{ actor_id: "actor-shadow", display_name: "Adam", is_local: false },
			{ actor_id: "actor-other", display_name: "Pat", is_local: false },
		];
		state.lastSyncPeers = [];
		state.lastSyncViewModel = {
			duplicatePeople: [
				{
					displayName: "Adam",
					actorIds: ["actor-local", "actor-shadow"],
					includesLocal: true,
				},
			],
		};

		expect(buildActorSelectOptions()).toEqual([
			{ value: "", label: "No person assigned" },
			{ value: "actor-local", label: "You" },
			{ value: "actor-other", label: "Pat" },
		]);
	});

	it("preserves a selected hidden actor so the control never renders blank", () => {
		state.lastSyncActors = [
			{ actor_id: "actor-local", display_name: "Adam", is_local: true },
			{ actor_id: "actor-shadow", display_name: "Adam", is_local: false },
		];
		state.lastSyncPeers = [];
		state.lastSyncViewModel = {
			duplicatePeople: [
				{
					displayName: "Adam",
					actorIds: ["actor-local", "actor-shadow"],
					includesLocal: true,
				},
			],
		};

		expect(buildActorSelectOptions("actor-shadow")).toEqual([
			{ value: "", label: "No person assigned" },
			{ value: "actor-local", label: "You" },
			{ value: "actor-shadow", label: "Adam" },
		]);
	});

	it("keeps an explicit unassigned choice in the option list", () => {
		state.lastSyncActors = [{ actor_id: "actor-local", display_name: "Adam", is_local: true }];
		state.lastSyncPeers = [];
		state.lastSyncViewModel = { duplicatePeople: [] };

		expect(buildActorSelectOptions()).toEqual([
			{ value: "", label: "No person assigned" },
			{ value: "actor-local", label: "You" },
		]);
	});
});
