/// <reference types="vite/client" />

import { describe, expect, it, vi } from "vitest";
import staticHtml from "../../../../static/index.html?raw";
import { FeedSearchInput, FeedStatus } from "./FeedTabView";

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
});
