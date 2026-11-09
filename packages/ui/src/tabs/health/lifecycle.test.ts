import { beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../lib/state";

const mocks = vi.hoisted(() => ({
	loadViewerStatus: vi.fn(),
	updateFeedView: vi.fn(),
	loadFeedData: vi.fn(),
}));

vi.mock("../../lib/api", () => ({ loadViewerStatus: mocks.loadViewerStatus }));
vi.mock("../feed", () => ({
	updateFeedView: mocks.updateFeedView,
	loadFeedData: mocks.loadFeedData,
}));

import { refreshViewerStatus } from "./lifecycle";

beforeEach(() => {
	vi.clearAllMocks();
	state.activeTab = "feed";
	state.viewerActorId = null;
	mocks.loadViewerStatus.mockResolvedValue({ identity: { actor_id: "actor-local" } });
	mocks.loadFeedData.mockReset().mockResolvedValue(undefined);
});

describe("viewer status Feed reloads", () => {
	it("restarts active Feed immediately for a known actor change with the caller signal", async () => {
		// Arrange
		state.viewerActorId = "actor-old";
		const controller = new AbortController();
		// Act
		await refreshViewerStatus({ signal: controller.signal });
		// Assert
		expect(mocks.loadFeedData).toHaveBeenCalledExactlyOnceWith({
			restart: true,
			signal: controller.signal,
		});
	});

	it("does not duplicate the initial Feed request when null identity becomes known", async () => {
		// Arrange
		state.viewerActorId = null;
		// Act
		await refreshViewerStatus();
		// Assert
		expect(mocks.loadFeedData).not.toHaveBeenCalled();
		expect(mocks.updateFeedView).toHaveBeenCalledWith(true);
	});

	it("does not start Feed while Health is active after a known actor change", async () => {
		// Arrange
		state.activeTab = "health";
		state.viewerActorId = "actor-old";
		// Act
		await refreshViewerStatus();
		// Assert
		expect(mocks.loadFeedData).not.toHaveBeenCalled();
		expect(state.viewerActorId).toBe("actor-local");
	});

	it("keeps status successful when the immediate Feed reload fails without retrying on the next status", async () => {
		// Arrange
		state.viewerActorId = "actor-old";
		mocks.loadFeedData.mockRejectedValueOnce(new Error("Feed unavailable"));
		// Act / Assert
		await expect(refreshViewerStatus()).resolves.toBeUndefined();
		await refreshViewerStatus();
		expect(state.viewerActorId).toBe("actor-local");
		expect(mocks.loadFeedData).toHaveBeenCalledTimes(1);
	});
});

describe("refreshViewerStatus", () => {
	it("refreshes Feed ownership only when the current actor changes", async () => {
		await refreshViewerStatus();
		await refreshViewerStatus();
		mocks.loadViewerStatus.mockResolvedValueOnce({ identity: { actor_id: "actor-new" } });
		await refreshViewerStatus();

		expect(state.viewerActorId).toBe("actor-new");
		expect(mocks.updateFeedView).toHaveBeenCalledTimes(1);
		expect(mocks.loadFeedData).toHaveBeenCalledExactlyOnceWith({
			restart: true,
			signal: undefined,
		});
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
