import { describe, expect, it } from "vitest";

import { actorDisplayLabel, shouldClearStalePeersFeedback } from "./helpers";

describe("actorDisplayLabel", () => {
	it("labels the local actor as You", () => {
		expect(
			actorDisplayLabel({ actor_id: "actor-local", display_name: "Adam", is_local: true }),
		).toBe("You");
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
