import { h, render, type TargetedEvent } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../lib/state";
import type { FeedItem } from "../types";
import { FeedItemCard } from "./FeedItemCard";

const noticeMock = vi.hoisted(() => vi.fn());
const updateVisibilityMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/notice", () => ({ showGlobalNotice: noticeMock }));
vi.mock("../../../lib/api", () => ({
	updateMemoryVisibility: updateVisibilityMock,
}));

vi.mock("../../../components/primitives/tooltip", () => ({
	Tooltip: ({ children }: { children?: unknown }) => children,
	TooltipProvider: ({ children }: { children?: unknown }) => children,
}));
vi.mock("../../../components/primitives/radix-select", () => ({
	RadixSelect: ({
		ariaLabel,
		disabled,
		id,
		onValueChange,
		options,
		triggerClassName,
		value,
	}: {
		ariaLabel?: string;
		disabled?: boolean;
		id?: string;
		onValueChange: (value: string) => void;
		options: Array<{ disabled?: boolean; label: string; value: string }>;
		triggerClassName?: string;
		value: string;
	}) =>
		h(
			"select",
			{
				"aria-label": ariaLabel,
				className: triggerClassName,
				disabled,
				id,
				onChange: (event: TargetedEvent<HTMLSelectElement>) =>
					onValueChange(event.currentTarget.value),
				value,
			},
			options.map((option) =>
				h(
					"option",
					{ disabled: option.disabled, key: option.value, value: option.value },
					option.label,
				),
			),
		),
}));
vi.mock("./FeedItemMenu", () => ({
	FeedItemMenu: () => h("button", { className: "feed-menu-trigger", type: "button" }, "Menu"),
}));

let mount: HTMLDivElement;

beforeEach(() => {
	state.feedQuery = "";
	state.itemExpandState.clear();
	state.newItemKeys.clear();
	noticeMock.mockReset();
	updateVisibilityMock.mockReset();
	updateVisibilityMock.mockResolvedValue({});
	mount = document.createElement("div");
	document.body.appendChild(mount);
});

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

function renderCard(item: FeedItem): void {
	act(() => {
		render(
			h(FeedItemCard, {
				item,
				onReload: async () => {},
				onRemove: () => {},
				onReplace: () => {},
				onViewRefresh: () => {},
			}),
			mount,
		);
	});
}

function observation(overrides: FeedItem = {}): FeedItem {
	return {
		body_text: "Legacy fallback that the structured pack will not use.",
		created_at: "2026-05-26T23:30:00.000Z",
		facts: ["First durable fact", "Second durable fact"],
		id: 1234,
		kind: "discovery",
		metadata_json: {},
		narrative: "Opening narrative.\n\nFinal narrative paragraph.",
		owned_by_self: true,
		project: "garden-api",
		subtitle: "Derived subtitle that is not pack content.",
		tags: ["retries", "watering"],
		title: "Diagnostic memory",
		visibility: "private",
		...overrides,
	};
}

function disclosureButton(): HTMLButtonElement {
	const button = mount.querySelector<HTMLButtonElement>(".feed-disclosure");
	if (!button) throw new Error("Expected explicit memory disclosure");
	return button;
}

describe("FeedItemCard pack-faithful content", () => {
	it("shows narrative followed by every fact without a representation switch", () => {
		renderCard(observation());

		const detail = mount.querySelector(".feed-detail");
		const narrative = detail?.querySelector(".feed-body.narrative");
		const facts = detail?.querySelector(".feed-pack-facts");
		expect(mount.querySelector(".feed-title")?.tagName).toBe("DIV");
		expect(narrative?.textContent).toContain("Final narrative paragraph.");
		expect(facts?.textContent).toContain("First durable fact");
		expect(facts?.textContent).toContain("Second durable fact");
		expect(
			(narrative as Node).compareDocumentPosition(facts as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(detail?.textContent).not.toContain("Legacy fallback");
		expect(mount.querySelector('[role="radiogroup"]')).toBeNull();
	});

	it("shows the complete body fallback when structured content is absent", () => {
		renderCard(
			observation({
				body_text: "Opening fallback.\n\nFinal fallback paragraph.",
				facts: [],
				narrative: "",
			}),
		);

		expect(mount.querySelector(".feed-body.narrative")?.textContent).toContain(
			"Final fallback paragraph.",
		);
		expect(mount.querySelector(".feed-pack-facts")).toBeNull();
	});

	it("uses the stored session-summary title and structured pack fields", () => {
		renderCard(
			observation({
				facts: ["Release candidate waits for smoke testing"],
				kind: "session_summary",
				narrative: "Published all seven beta packages.",
				summary: { request: "Prepare a release" },
				title: "Verified the beta publication",
			}),
		);

		expect(mount.querySelector(".feed-title")?.textContent).toBe("Verified the beta publication");
		expect(mount.querySelector(".feed-detail")?.textContent).toContain(
			"Published all seven beta packages.",
		);
		expect(mount.querySelector(".feed-detail")?.textContent).toContain(
			"Release candidate waits for smoke testing",
		);
	});
});

describe("FeedItemCard disclosure", () => {
	it("uses a fixed explicit control instead of making the title interactive", () => {
		renderCard(observation());
		const button = disclosureButton();
		expect(button.textContent).toContain("Collapse memory");
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(button.getAttribute("aria-controls")).toBe(
			mount.querySelector(".feed-detail")?.getAttribute("id"),
		);

		button.focus();
		act(() => button.click());

		expect(document.activeElement).toBe(button);
		expect(button.textContent).toContain("Expand memory");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(mount.querySelector(".feed-detail")).toBeNull();
		expect(mount.querySelector(".feed-collapsed-note")?.textContent).toBe(
			"Memory content collapsed",
		);
		expect(state.itemExpandState.get("discovery:1234")).toBe(false);
	});

	it("retains collapse state for the same memory through polling", () => {
		renderCard(observation());
		act(() => disclosureButton().click());

		renderCard(observation({ subtitle: "Updated indexed metadata" }));

		expect(disclosureButton().getAttribute("aria-expanded")).toBe("false");
		expect(mount.querySelector(".feed-detail")).toBeNull();
	});

	it("keeps tags and visibility controls available while content is collapsed", () => {
		renderCard(observation());
		act(() => disclosureButton().click());

		expect(mount.querySelector(".feed-detail")).toBeNull();
		expect(mount.querySelectorAll(".feed-card-footer .tag-chip")).toHaveLength(2);
		expect(mount.querySelector(".feed-visibility-select")).not.toBeNull();
	});

	it("keeps supplemental details reachable when content is empty", () => {
		renderCard(
			observation({ body_text: "", facts: [], narrative: "", workspace_kind: "repository" }),
		);

		expect(disclosureButton().getAttribute("aria-expanded")).toBe("true");
		expect(mount.querySelector(".feed-detail")?.textContent).toContain("Workspace repository");
	});

	it("restores card focus when polling removes a focused disclosure", () => {
		renderCard(observation());
		disclosureButton().focus();

		renderCard(
			observation({
				body_text: "",
				facts: [],
				narrative: "",
				origin_source: "observer",
				tags: [],
			}),
		);

		expect(mount.querySelector(".feed-disclosure")).toBeNull();
		expect(document.activeElement).toBe(mount.querySelector(".feed-item"));
	});
});

describe("FeedItemCard metadata and controls", () => {
	it("keeps identity metadata in the header and tags with the card footer", () => {
		renderCard(
			observation({
				actor_id: "peer-id",
				owned_by_self: false,
				resolved_actor_display_name: "Ada Lovelace",
				trust_state: "unreviewed",
				visibility: "shared",
			}),
		);

		const metadata = mount.querySelector(".feed-meta-line")?.textContent;
		expect(metadata).toContain("garden-api");
		expect(metadata).toContain("Ada Lovelace");
		expect(metadata).toContain("shared");
		expect(metadata).toContain("unreviewed");
		expect(mount.querySelector(".provenance-chip.memory-id")?.textContent).toBe("#1234");
		expect(mount.querySelectorAll(".feed-card-footer .tag-chip")).toHaveLength(2);
		expect(mount.querySelector(".feed-menu-trigger")).toBeNull();
		expect(mount.querySelector(".feed-visibility-select")).toBeNull();
	});

	it.each(["observer", "observer_summary"])("omits redundant %s provenance", (source) => {
		renderCard(observation({ origin_source: source }));
		expect(mount.querySelector(".provenance-chip.source")).toBeNull();
	});

	it("keeps useful source provenance without the noisy From prefix", () => {
		renderCard(observation({ origin_source: "opencode" }));
		expect(mount.querySelector(".provenance-chip.source")?.textContent).toBe("OpenCode");
		expect(mount.textContent).not.toContain("From OpenCode");
	});

	it("uses Radix visibility options and keeps approved outcome notices", async () => {
		renderCard(observation());
		const select = mount.querySelector<HTMLSelectElement>(".feed-visibility-select");
		expect(select?.getAttribute("aria-label")).toBe("Who can see Diagnostic memory");
		expect(Array.from(select?.options || []).map((option) => option.textContent)).toEqual([
			"Only me",
			"Synced peers",
		]);

		if (!select) throw new Error("Expected mocked Radix visibility select");
		select.value = "shared";
		await act(async () => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(noticeMock).toHaveBeenLastCalledWith("Shared with synced peers");

		select.value = "private";
		await act(async () => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(noticeMock).toHaveBeenLastCalledWith("Only you can see this");
	});

	it("disables visibility changes when legacy visibility is unknown", () => {
		renderCard(observation({ visibility: null }));
		const select = mount.querySelector<HTMLSelectElement>(".feed-visibility-select");
		expect(mount.querySelector(".provenance-chip.unknown")?.textContent).toBe("Visibility unknown");
		expect(select?.disabled).toBe(true);
		expect(select?.value).toBe("unknown");
	});

	it("preserves item-menu and new-item behavior", () => {
		state.newItemKeys.add("discovery:1234");
		renderCard(observation());
		expect(mount.querySelector(".feed-item")?.classList.contains("new-item")).toBe(true);
		expect(mount.querySelector(".feed-menu-trigger")).not.toBeNull();
	});
});

describe("FeedItemCard search evidence", () => {
	it("shows a highlighted excerpt while matching content is collapsed", () => {
		state.feedQuery = "coordinator";
		state.itemExpandState.set("discovery:1234", false);
		renderCard(observation({ facts: ["Coordinator routing changed"] }));

		expect(mount.querySelector(".feed-search-match")?.textContent).toContain("Content match");
		expect(mount.querySelector(".feed-search-match mark.match")?.textContent).toBe("Coordinator");
	});

	it("does not duplicate evidence already visible in expanded content", () => {
		state.feedQuery = "coordinator";
		renderCard(observation({ narrative: "The coordinator routes through the approved peer." }));
		expect(mount.querySelector(".feed-detail")?.textContent).toContain("coordinator");
		expect(mount.querySelector(".feed-search-match")).toBeNull();
	});

	it("retains an excerpt when Markdown hides a matching link destination", () => {
		state.feedQuery = "needle";
		renderCard(observation({ narrative: "Visit [documentation](https://example.com/needle)." }));
		expect(mount.querySelector(".feed-detail")?.textContent).not.toContain("needle");
		expect(mount.querySelector(".feed-search-match mark.match")?.textContent).toBe("needle");
	});

	it("never exposes opaque origin source identifiers", () => {
		const rawSource = "internal://tenant/device-81f6d8";
		renderCard(observation({ origin_source: rawSource }));
		expect(mount.querySelector(".provenance-chip.source")?.textContent).toBe("Other source");
		expect(mount.textContent).not.toContain(rawSource);
	});
});
