import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedItemCard } from "./FeedItemCard";

vi.mock("../../../components/primitives/tooltip", () => ({
	Tooltip: ({ children }: { children?: unknown }) => children,
	TooltipProvider: ({ children }: { children?: unknown }) => children,
}));

let mount: HTMLDivElement;

beforeEach(() => {
	mount = document.createElement("div");
	document.body.appendChild(mount);
});

afterEach(() => {
	act(() => {
		render(null, mount);
	});
	mount.remove();
});

describe("FeedItemCard", () => {
	it("shows the memory database id as quiet provenance", () => {
		act(() => {
			render(
				h(FeedItemCard, {
					item: {
						body_text: "A diagnostic memory body.",
						created_at: "2026-05-26T23:30:00.000Z",
						id: 1234,
						kind: "discovery",
						metadata_json: {},
						owned_by_self: false,
						project: "btha",
						title: "BTHA diagnostic memory",
						visibility: "shared",
					},
					onReload: async () => {},
					onRemove: () => {},
					onReplace: () => {},
					onViewRefresh: () => {},
				}),
				mount,
			);
		});

		expect(mount.textContent).toContain("ID 1234");
		const chip = mount.querySelector(".provenance-chip.memory-id");
		expect(chip?.textContent).toBe("ID 1234");
	});
});
