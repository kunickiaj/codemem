/// <reference types="vite/client" />

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import staticHtml from "../../../../static/index.html?raw";
import { state } from "../../../lib/state";
import { readFirstRunGuideRecord } from "../data/first-run-guide";
import type { FeedItem, FeedViewOps } from "../types";
import { FeedSearchInput, FeedStatus, FeedTabView, shouldRenderFirstRunGuide } from "./FeedTabView";

vi.mock("../../../components/primitives/tooltip", () => ({
	Tooltip: ({ children }: { children?: unknown }) => children,
	TooltipProvider: ({ children }: { children?: unknown }) => children,
}));

function feedOps(): FeedViewOps {
	return {
		hasMorePages: () => false,
		loadFeedData: vi.fn().mockResolvedValue(undefined),
		removeFeedItem: vi.fn(),
		replaceFeedItem: vi.fn(),
		updateFeedQuery: vi.fn(),
		updateFeedView: vi.fn(),
	};
}

afterEach(() => {
	document.body.innerHTML = "";
	localStorage.clear();
	state.viewerReconnectOpen = false;
});

describe("FeedTabView accessibility primitives", () => {
	it("describes the controlled Feed search input without mounting the full Feed", () => {
		const onQuery = vi.fn();
		const input = FeedSearchInput({ query: "needle", onQuery });

		expect(input.type).toBe("input");
		expect(input.props).toMatchObject({
			"aria-label": "Search memories",
			type: "search",
			value: "needle",
		});
	});

	it("announces Feed result and loading metadata politely", () => {
		const status = FeedStatus({ text: "Searching memories…" });

		expect(status.type).toBe("div");
		expect(status.props).toMatchObject({
			"aria-live": "polite",
			role: "status",
		});
		expect(status.props.children).toBe("Searching memories…");
	});

	it("keeps the tracked static Feed fallback accessible", () => {
		const document = new DOMParser().parseFromString(staticHtml, "text/html");
		const input = document.getElementById("feedSearch");
		const status = document.getElementById("feedMeta");

		expect(input?.getAttribute("type")).toBe("search");
		expect(input?.getAttribute("aria-label")).toBe("Search memories");
		expect(status?.getAttribute("role")).toBe("status");
		expect(status?.getAttribute("aria-live")).toBe("polite");
	});

	it("does not render first-run guidance while loading or disconnected", () => {
		expect(shouldRenderFirstRunGuide("Loading memories…", false)).toBe(false);
		expect(shouldRenderFirstRunGuide(undefined, true)).toBe(false);
		expect(shouldRenderFirstRunGuide(undefined, false)).toBe(true);
	});

	it("keeps a retryable Feed error beside cached items", () => {
		const mount = document.createElement("div");
		document.body.appendChild(mount);
		const item = {
			body_text: "Cached detail",
			created_at: "2026-09-19T00:00:00.000Z",
			kind: "discovery",
			memory_id: 1,
			title: "Cached memory",
		} as FeedItem;

		act(() =>
			render(
				h(FeedTabView, { errorText: "Feed refresh failed", items: [item], ops: feedOps() }),
				mount,
			),
		);

		expect(mount.querySelector('[role="alert"]')?.textContent).toContain("Feed refresh failed");
		expect(mount.textContent).toContain("Cached memory");
		expect(mount.textContent).toContain("Retry");
	});

	it("does not complete Find it again by toggling the inspector", () => {
		state.viewerReconnectOpen = true;
		const mount = document.createElement("div");
		document.body.appendChild(mount);
		act(() => render(h(FeedTabView, { items: [], ops: feedOps() }), mount));
		const inspector = [...mount.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Context Inspector",
		);

		act(() => inspector?.click());

		expect(readFirstRunGuideRecord().completed).not.toContain("find");
	});

	it("does not complete Find it again while a search is only being typed", () => {
		const onQuery = vi.fn();
		const mount = document.createElement("div");
		document.body.appendChild(mount);
		act(() => render(h(FeedSearchInput, { onQuery, query: "" }), mount));
		const input = mount.querySelector<HTMLInputElement>("input");
		if (!input) throw new Error("Feed search input missing");

		input.value = "needle";
		act(() => {
			input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});

		expect(onQuery).toHaveBeenCalledWith("needle");
		expect(readFirstRunGuideRecord().completed).not.toContain("find");
	});
});
