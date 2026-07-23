import { afterEach, describe, expect, it } from "vitest";

import { state } from "../../lib/state";
import {
	actorDisplayLabel,
	assignmentNote,
	buildActorSelectOptions,
	shouldClearStalePeersFeedback,
} from "./helpers";

const originalActors = state.lastSyncActors;
const originalPeers = state.lastSyncPeers;
const originalViewModel = state.lastSyncViewModel;
const healthyPrimaryStatus = {
	state: "healthy" as const,
	badgeLabel: "Healthy",
	meta: "Sync is healthy.",
	nextAction: null,
};

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
			primaryStatus: healthyPrimaryStatus,
			summary: { connectedDeviceCount: 0, seenOnTeamCount: 0, offlineTeamDeviceCount: 0 },
			attentionItems: [],
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
			primaryStatus: healthyPrimaryStatus,
			summary: { connectedDeviceCount: 0, seenOnTeamCount: 0, offlineTeamDeviceCount: 0 },
			attentionItems: [],
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
		state.lastSyncViewModel = {
			primaryStatus: healthyPrimaryStatus,
			summary: { connectedDeviceCount: 0, seenOnTeamCount: 0, offlineTeamDeviceCount: 0 },
			attentionItems: [],
			duplicatePeople: [],
		};

		expect(buildActorSelectOptions()).toEqual([
			{ value: "", label: "No person assigned" },
			{ value: "actor-local", label: "You" },
		]);
	});
});

describe("shouldClearStalePeersFeedback", () => {
	it("clears when the related peer reappears in the loaded list", () => {
		expect(
			shouldClearStalePeersFeedback({ relatedPeerDeviceId: "peer-rejoined" }, [
				{ peer_device_id: "peer-rejoined" },
			]),
		).toBe(true);
	});

	it("does not clear when no peers match", () => {
		expect(
			shouldClearStalePeersFeedback({ relatedPeerDeviceId: "peer-removed" }, [
				{ peer_device_id: "peer-other" },
			]),
		).toBe(false);
	});

	it("does not clear when feedback has no relatedPeerDeviceId", () => {
		expect(shouldClearStalePeersFeedback({}, [{ peer_device_id: "peer-any" }])).toBe(false);
	});

	it("does not clear when feedback is null", () => {
		expect(shouldClearStalePeersFeedback(null, [{ peer_device_id: "peer-any" }])).toBe(false);
	});

	it("trims whitespace before comparing peer ids", () => {
		expect(
			shouldClearStalePeersFeedback({ relatedPeerDeviceId: "  peer-id  " }, [
				{ peer_device_id: "peer-id" },
			]),
		).toBe(true);
	});
});
