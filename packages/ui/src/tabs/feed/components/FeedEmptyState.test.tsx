import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../lib/state";
import type { FeedViewOps } from "../types";
import { FeedEmptyState } from "./FeedList";

let mount: HTMLDivElement;

const ops: FeedViewOps = {
	hasMorePages: () => false,
	loadFeedData: vi.fn(async () => undefined),
	removeFeedItem: vi.fn(),
	replaceFeedItem: vi.fn(),
	updateFeedQuery: vi.fn(),
	updateFeedView: vi.fn(),
};

function renderEmptyState(): void {
	act(() => render(<FeedEmptyState ops={ops} />, mount));
}

beforeEach(() => {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	state.feedQuery = "";
	state.feedTypeFilter = "all";
	state.feedScopeFilter = "all";
	state.currentProject = "";
	state.feedProcessingStatus = { kind: "ready" };
	vi.clearAllMocks();
});

afterEach(() => {
	act(() => render(null, mount));
	document.body.innerHTML = "";
});

describe("FeedEmptyState", () => {
	it("separates search-zero and filtered-zero states", () => {
		state.feedQuery = "needle";
		renderEmptyState();
		expect(mount.textContent).toContain("No memories match “needle”");
		expect(mount.textContent).toContain("Clear search");

		state.feedQuery = "";
		state.currentProject = "project-a";
		renderEmptyState();
		expect(mount.textContent).toContain("current filters");
		expect(mount.textContent).toContain("Clear filters");
	});

	it("shows pending, paused, unavailable, and truly empty states from explicit status", () => {
		state.feedProcessingStatus = { kind: "pending", count: 2 };
		renderEmptyState();
		expect(mount.textContent).toContain("Processing 2 events");

		state.feedProcessingStatus = { kind: "paused" };
		renderEmptyState();
		expect(mount.textContent).toContain("Capture is paused");

		state.feedProcessingStatus = { kind: "unavailable" };
		renderEmptyState();
		expect(mount.textContent).toContain("Processing status is unavailable");

		state.feedProcessingStatus = { kind: "ready" };
		renderEmptyState();
		expect(mount.textContent).toContain("No memories yet");
		expect(mount.textContent).toContain("Open Settings");
		expect(mount.textContent).toContain("Open Health");
	});
});
