import { beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../lib/state";

const mocks = vi.hoisted(() => ({
	loadViewerStatus: vi.fn(),
	updateFeedView: vi.fn(),
}));

vi.mock("../../lib/api", () => ({ loadViewerStatus: mocks.loadViewerStatus }));
vi.mock("../feed", () => ({ updateFeedView: mocks.updateFeedView }));

import { refreshViewerStatus } from "./lifecycle";

beforeEach(() => {
	vi.clearAllMocks();
	state.activeTab = "feed";
	state.viewerActorId = null;
	mocks.loadViewerStatus.mockResolvedValue({ identity: { actor_id: "actor-local" } });
});

describe("refreshViewerStatus", () => {
	it("refreshes Feed ownership only when the current actor changes", async () => {
		await refreshViewerStatus();
		await refreshViewerStatus();
		mocks.loadViewerStatus.mockResolvedValueOnce({ identity: { actor_id: "actor-new" } });
		await refreshViewerStatus();

		expect(state.viewerActorId).toBe("actor-new");
		expect(mocks.updateFeedView).toHaveBeenCalledTimes(2);
	});

	it("does not commit an aborted status response", async () => {
		const controller = new AbortController();
		controller.abort();

		await refreshViewerStatus({ signal: controller.signal });

		expect(state.viewerActorId).toBeNull();
		expect(mocks.updateFeedView).not.toHaveBeenCalled();
	});

	it("invalidates inactive Feed ownership when the shared identity changes", async () => {
		state.activeTab = "projects";

		await refreshViewerStatus();

		expect(state.viewerActorId).toBe("actor-local");
		expect(mocks.updateFeedView).toHaveBeenCalledWith(true);
	});
});
