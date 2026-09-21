import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_VIEW_MODE_KEY, state } from "../../../lib/state";
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
vi.mock("./FeedItemMenu", () => ({
	FeedItemMenu: () => h("button", { className: "feed-menu-trigger", type: "button" }, "Menu"),
}));

let mount: HTMLDivElement;

beforeEach(() => {
	localStorage.clear();
	state.feedQuery = "";
	state.itemExpandState.clear();
	// Exercise explicit collapse/disclosure separately from the full-content default below.
	state.itemExpandState.set("discovery:1234", false);
	state.itemViewState.clear();
	state.newItemKeys.clear();
	state.preferredFeedViewMode = "summary";
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
		body_text: "A longer fallback narrative.",
		created_at: "2026-05-26T23:30:00.000Z",
		facts: ["One durable fact"],
		id: 1234,
		kind: "discovery",
		metadata_json: {},
		narrative: "A longer narrative with enough detail to differ from the summary.",
		owned_by_self: true,
		project: "garden-api",
		subtitle: "Short summary.",
		title: "Diagnostic memory",
		visibility: "private",
		...overrides,
	};
}

function titleButton(): HTMLButtonElement {
	const button = mount.querySelector<HTMLButtonElement>("button.feed-title");
	if (!button) throw new Error("Expected title disclosure button");
	return button;
}

describe("FeedItemCard full-content default", () => {
	beforeEach(() => state.itemExpandState.clear());

	it("shows full multiline content and title once without an expansion action", () => {
		const title = `A detailed memory title ${"with more context ".repeat(20)}`;
		const subtitle = `First summary paragraph.\n\n${"More detail. ".repeat(100)}Final summary line.`;
		renderCard(observation({ title, subtitle }));
		expect(mount.querySelector(".feed-title")?.textContent).toBe(title.trim());
		expect(mount.querySelector(".feed-body")?.textContent).toContain("Final summary line.");
		expect(mount.querySelector(".feed-summary")).toBeNull();
		expect(mount.querySelector(".clamp")).toBeNull();
		expect(mount.textContent?.match(/First summary paragraph\./g)).toHaveLength(1);
		expect(mount.textContent).not.toContain("Read more");
	});

	it("keeps all lines of a structured session summary and Facts separately selectable", () => {
		renderCard({
			id: 4321,
			kind: "session_summary",
			title: "Session title",
			summary: {
				request: "Improve the sample queue",
				completed: "First result.\n\nLast result remains visible.",
				learned: "Queue order matters.",
			},
		});
		expect(mount.querySelector(".feed-body")?.textContent).toContain(
			"Last result remains visible.",
		);
		expect(mount.querySelector(".feed-body")?.textContent).not.toContain("Queue order matters.");
		const facts = Array.from(mount.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
			(button) => button.textContent === "Facts",
		);
		act(() => facts?.click());
		expect(mount.querySelector(".feed-body")?.textContent).toContain("Queue order matters.");
		expect(mount.querySelector(".feed-summary")).toBeNull();
	});

	it("shows the complete legacy body and preferred narrative immediately", () => {
		const body = "Opening paragraph.\n\nFinal legacy paragraph.";
		renderCard(observation({ subtitle: "", narrative: "", body_text: body }));
		expect(mount.querySelector(".feed-body")?.textContent).toContain("Final legacy paragraph.");
		act(() => render(null, mount));
		state.itemViewState.clear();
		state.preferredFeedViewMode = "narrative";
		renderCard(observation({ narrative: "Opening narrative.\n\nFinal narrative paragraph." }));
		expect(mount.querySelector(".feed-body")?.textContent).toContain("Final narrative paragraph.");
		expect(mount.querySelector(".feed-summary")).toBeNull();
	});

	it("explains a Summary match when Facts is selected without repeating visible Summary matches", () => {
		state.feedQuery = "summary";
		renderCard(observation());
		expect(mount.querySelector(".feed-search-match")).toBeNull();
		const facts = Array.from(mount.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
			(button) => button.textContent === "Facts",
		);
		act(() => facts?.click());
		expect(mount.querySelector(".feed-body")?.textContent).toContain("One durable fact");
		expect(mount.querySelector(".feed-search-match")?.textContent).toContain("Summary match");
	});
});

describe("FeedItemCard", () => {
	it("renders the collapsed compact skim with mandatory provenance", () => {
		renderCard(
			observation({
				actor_id: "peer-id",
				owned_by_self: false,
				resolved_actor_display_name: "Ada Lovelace",
				tags: ["retries", "watering"],
				trust_state: "unreviewed",
				visibility: "shared",
			}),
		);

		expect(mount.querySelector(".feed-summary")?.textContent).toBe("Short summary.");
		expect(mount.querySelector(".feed-meta-line")?.textContent).toContain("garden-api");
		expect(mount.querySelector(".feed-meta-line")?.textContent).toContain("Ada Lovelace");
		expect(mount.querySelector(".feed-meta-line")?.textContent).toContain("shared");
		expect(mount.querySelector(".feed-meta-line")?.textContent).toContain("unreviewed");
		expect(mount.querySelector(".provenance-chip.memory-id")?.textContent).toBe("#1234");
		expect(mount.querySelectorAll(".tag-chip")).toHaveLength(2);
		expect(mount.querySelector(".feed-detail")).toBeNull();
	});

	it("uses the title button to disclose an accessibly named mode region", () => {
		renderCard(observation());
		const button = titleButton();
		expect(button.getAttribute("aria-expanded")).toBe("false");

		act(() => button.click());

		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(mount.querySelector(".feed-detail")?.getAttribute("aria-label")).toBe(
			"Diagnostic memory Summary",
		);
	});

	it("switches Facts and Narrative in place and remembers the global preference", () => {
		renderCard(observation());
		act(() => titleButton().click());
		const narrative = Array.from(mount.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
			(button) => button.textContent === "Narrative",
		);
		expect(narrative).toBeDefined();
		act(() => narrative?.click());

		expect(mount.querySelector(".feed-detail")?.textContent).toContain("longer narrative");
		expect(mount.querySelector(".feed-body")?.classList.contains("narrative")).toBe(true);
		expect(localStorage.getItem(FEED_VIEW_MODE_KEY)).toBe("narrative");
	});

	it("supports arrow-key radio selection and preserves focused controls across polling", () => {
		renderCard(observation());
		const radios = mount.querySelectorAll<HTMLButtonElement>('[role="radio"]');
		radios[0]?.focus();
		act(() => {
			radios[0]?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
			);
		});
		expect(mount.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("Facts");

		const focused = document.activeElement;
		renderCard(observation({ subtitle: "Updated during polling." }));
		expect(document.activeElement).toBe(focused);
	});

	it("keeps an expanded card open while switching modes", () => {
		renderCard(observation());
		act(() => titleButton().click());

		const radios = Array.from(mount.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
		const facts = radios.find((radio) => radio.textContent === "Facts");
		act(() => facts?.click());

		expect(titleButton().getAttribute("aria-expanded")).toBe("true");
		expect(mount.querySelector(".feed-detail")?.textContent).toContain("One durable fact");
	});

	it("prevents Home and End defaults when selection is already at the boundary", () => {
		renderCard(observation());
		const radios = mount.querySelectorAll<HTMLButtonElement>('[role="radio"]');
		const first = radios[0];
		const last = radios[radios.length - 1];
		first?.focus();
		const home = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" });
		act(() => {
			first?.dispatchEvent(home);
		});
		expect(home.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		expect(first?.getAttribute("aria-checked")).toBe("true");

		act(() => last?.click());
		last?.focus();
		const end = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "End" });
		act(() => {
			last?.dispatchEvent(end);
		});
		expect(end.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(last);
		expect(last?.getAttribute("aria-checked")).toBe("true");
	});

	it("keeps expansion for the same identity through removal and return without transferring it", () => {
		renderCard(observation());
		act(() => titleButton().click());
		expect(mount.querySelector(".feed-detail")).not.toBeNull();

		act(() => render(null, mount));
		renderCard(observation({ subtitle: "Updated after filtering." }));
		expect(mount.querySelector(".feed-detail")?.textContent).toContain("Updated after filtering.");

		act(() => render(null, mount));
		renderCard(observation({ id: 999, title: "Different memory" }));
		expect(mount.querySelector(".feed-detail")).not.toBeNull();
		expect(state.itemExpandState.has("discovery:999")).toBe(false);
	});
});

describe("FeedItemCard polling fallback", () => {
	it.each([false, true])("restores sole-mode focus once (expanded: %s)", async (expanded) => {
		renderCard(observation());
		if (expanded) act(() => titleButton().click());
		const summary = mount.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]');
		expect(summary?.textContent).toBe("Summary");
		summary?.focus();
		const singleMode = observation({
			facts: [],
			body_text: "Short summary.",
			narrative: "Short summary.",
		});
		renderCard(singleMode);
		await act(async () => {
			await Promise.resolve();
		});
		expect(mount.querySelector('[role="radiogroup"]')).toBeNull();
		const card = mount.querySelector<HTMLElement>(".feed-item");
		expect(document.activeElement).toBe(card);
		card?.blur();
		renderCard(singleMode);
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.activeElement).toBe(document.body);
	});
	it("uses the stable fallback order instead of another card's preference", async () => {
		renderCard(observation());
		act(() => titleButton().click());
		const narrative = Array.from(mount.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
			(radio) => radio.textContent === "Narrative",
		);
		act(() => narrative?.click());
		state.preferredFeedViewMode = "facts";

		renderCard(observation({ body_text: "Short summary.", narrative: "" }));
		await act(async () => {
			await Promise.resolve();
		});

		expect(mount.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("Summary");
	});

	it("keeps the card open and restores mode focus when polling removes the active mode", () => {
		renderCard(observation());
		act(() => titleButton().click());
		const narrative = Array.from(mount.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
			(radio) => radio.textContent === "Narrative",
		);
		act(() => narrative?.click());
		narrative?.focus();

		renderCard(observation({ body_text: "Short summary.", narrative: "Short summary." }));

		const fallback = mount.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]');
		expect(titleButton().getAttribute("aria-expanded")).toBe("true");
		expect(fallback?.textContent).toBe("Summary");
		expect(document.activeElement).toBe(fallback);
		expect(mount.querySelector(".feed-detail")?.textContent).toContain("Short summary");
	});

	it.each([false, true])(
		"restores focus when every mode disappears (expanded: %s)",
		async (expanded) => {
			renderCard(observation());
			if (expanded) act(() => titleButton().click());
			const summary = mount.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]');
			summary?.focus();

			renderCard(observation({ body_text: "", facts: [], narrative: "", subtitle: "" }));
			await act(async () => {
				await Promise.resolve();
			});

			expect(mount.querySelector(".feed-title")?.tagName).toBe("DIV");
			expect(mount.querySelector(".feed-detail")).toBeNull();
			expect(document.activeElement).toBe(mount.querySelector(".feed-item"));
			expect(state.itemViewState.has("discovery:1234")).toBe(false);
			mount.querySelector<HTMLElement>(".feed-item")?.blur();
			renderCard(observation({ body_text: "", facts: [], narrative: "", subtitle: "" }));
			await act(async () => {
				await Promise.resolve();
			});
			expect(document.activeElement).toBe(document.body);
		},
	);
});

describe("FeedItemCard fallback disclosure", () => {
	it("keeps supplemental provenance reachable when no content mode exists", () => {
		renderCard(
			observation({
				body_text: "",
				facts: [],
				narrative: "",
				subtitle: "",
				workspace_kind: "repository",
			}),
		);

		const button = titleButton();
		act(() => button.click());

		expect(mount.querySelector(".feed-detail")?.getAttribute("aria-label")).toBe(
			"Diagnostic memory details",
		);
		expect(mount.querySelector(".feed-detail")?.textContent).toContain("Workspace repository");
		expect(mount.querySelectorAll('[role="radio"]')).toHaveLength(0);
	});
});

describe("FeedItemCard content and actions", () => {
	it("does not grant self-owned actions to a peer whose display name is You", () => {
		renderCard(
			observation({
				actor_id: "peer-id",
				owned_by_self: false,
				resolved_actor_display_name: "You",
				trust_state: "unreviewed",
			}),
		);

		expect(mount.querySelector(".provenance-chip.author")?.textContent).toBe("You");
		expect(mount.textContent).toContain("unreviewed");
		expect(mount.querySelector(".feed-menu-trigger")).toBeNull();
		expect(mount.querySelector(".feed-visibility-select")).toBeNull();
	});

	it("labels missing peer trust state explicitly", () => {
		renderCard(observation({ actor_id: "peer-id", owned_by_self: false, trust_state: null }));

		expect(mount.querySelector(".provenance-chip.trust")?.textContent).toBe("Trust unknown");
	});

	it("labels missing legacy visibility explicitly", () => {
		renderCard(observation({ visibility: null }));

		expect(mount.querySelector(".provenance-chip.unknown")?.textContent).toBe("Visibility unknown");
		const select = mount.querySelector<HTMLSelectElement>(".feed-visibility-select");
		expect(select?.disabled).toBe(true);
		expect(select?.value).toBe("unknown");
		expect(select?.querySelector("option[value='unknown']")?.textContent).toBe("Unknown");
	});

	it("shows a highlighted excerpt when search matches only hidden detail", () => {
		state.feedQuery = "coordinator";
		renderCard(observation({ facts: ["Coordinator routing changed"], subtitle: "Visible skim" }));

		expect(mount.querySelector(".feed-search-match")?.textContent).toContain("Coordinator");
		expect(mount.querySelector(".feed-search-match mark.match")?.textContent).toBe("Coordinator");
		expect(mount.querySelector(".feed-detail")).toBeNull();
	});
});

describe("FeedItemCard search refresh", () => {
	it.each(["K", "İ"])("highlights original Unicode text for query %s", (query) => {
		state.feedQuery = `  ${query}  `;
		renderCard(observation({ title: query, subtitle: `Summary ${query}` }));
		expect(mount.querySelector(".feed-title mark.match")?.textContent).toBe(query);
		expect(mount.querySelector(".feed-summary mark.match")?.textContent).toBe(query);
		renderCard(observation({ facts: [`${"x".repeat(100)} ${query}`] }));
		expect(mount.querySelector(".feed-search-match mark.match")?.textContent).toBe(query);
	});
	it.each([
		{ name: "Facts list items", mode: "facts" as const, facts: ["one", "two"], narrative: "" },
		{ name: "Markdown paragraphs", mode: "narrative" as const, facts: [], narrative: "one\n\ntwo" },
		{
			name: "Markdown heading and paragraph",
			mode: "narrative" as const,
			facts: [],
			narrative: "# one\n\ntwo",
		},
		{
			name: "Markdown list items",
			mode: "narrative" as const,
			facts: [],
			narrative: "- one\n- two",
		},
		{ name: "Markdown line break", mode: "narrative" as const, facts: [], narrative: "one  \ntwo" },
	])("retains an excerpt across $name", ({ mode, facts, narrative }) => {
		state.feedQuery = "onetwo";
		state.preferredFeedViewMode = mode;
		renderCard(
			observation({
				facts: mode === "facts" ? facts : ["onetwo"],
				narrative: mode === "facts" ? "onetwo" : narrative,
			}),
		);
		act(() => titleButton().click());
		expect(mount.querySelector(".feed-body")).not.toBeNull();
		expect(mount.querySelector(".feed-search-match mark.match")?.textContent).toBe("onetwo");
	});
	it.each(["one**two**", "one*two*", "one`two`", "one[two](https://example.com)"])(
		"hides an excerpt for a visible word split by inline formatting: %s",
		(narrative) => {
			state.feedQuery = "onetwo";
			state.preferredFeedViewMode = "narrative";
			renderCard(observation({ narrative, facts: ["onetwo"] }));
			expect(mount.querySelector(".feed-search-match")).not.toBeNull();
			act(() => titleButton().click());
			expect(mount.querySelector(".feed-body")?.textContent).toContain("onetwo");
			expect(mount.querySelector(".feed-search-match")).toBeNull();
		},
	);
	it("restores focus when polling removes the title disclosure", () => {
		renderCard(observation());
		titleButton().focus();
		renderCard(observation({ body_text: "", narrative: "", facts: [], subtitle: "" }));
		expect(document.activeElement).toBe(mount.querySelector(".feed-item"));
	});
	it("does not restore radio focus after an explicit blur", async () => {
		renderCard(observation());
		const radio = mount.querySelector<HTMLButtonElement>('[role="radio"]');
		radio?.focus();
		radio?.blur();
		renderCard(observation({ body_text: "", narrative: "", facts: [], subtitle: "" }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.activeElement).toBe(document.body);
	});
	it("highlights the trimmed query truncated to the server limit", () => {
		const needle = "A".repeat(256);
		state.feedQuery = `  ${needle}ignored  `;
		renderCard(observation({ narrative: `Prefix ${needle} suffix` }));
		expect(mount.querySelector(".feed-search-match mark.match")?.textContent).toBe(needle);
	});
	it("retains an excerpt when Markdown renders a matching destination as a link", () => {
		state.feedQuery = "needle";
		state.preferredFeedViewMode = "narrative";
		renderCard(observation({ narrative: "Visit [documentation](https://example.com/needle)." }));
		act(() => titleButton().click());
		expect(mount.querySelector(".feed-detail")?.textContent).not.toContain("needle");
		expect(mount.querySelector(".feed-search-match mark.match")?.textContent).toBe("needle");
	});
	it("does not duplicate a fully visible title match after resizing", () => {
		const originalWidth = window.innerWidth;
		try {
			window.innerWidth = 1000;
			state.feedQuery = "needle";
			renderCard(observation({ title: `${"Long title ".repeat(3)}needle` }));
			expect(mount.querySelector(".feed-search-match")).toBeNull();
			act(() => {
				window.innerWidth = 500;
				window.dispatchEvent(new Event("resize"));
			});
			expect(mount.querySelector(".feed-search-match")).toBeNull();
		} finally {
			window.innerWidth = originalWidth;
		}
	});
	it("explains observation matches in indexed request metadata", () => {
		state.feedQuery = "needle";
		renderCard(observation({ metadata_json: { request: "needle" } }));
		expect(mount.querySelector(".feed-search-match mark.match")?.textContent).toBe("needle");
	});
});

describe("FeedItemCard search disclosure and actions", () => {
	it("keeps a hidden Facts match visible while expanded Summary is active", () => {
		state.feedQuery = "coordinator";
		renderCard(observation({ facts: ["Coordinator routing changed"], subtitle: "Visible skim" }));
		act(() => titleButton().click());

		expect(mount.querySelector(".feed-search-match")?.textContent).toContain("Coordinator");

		const facts = Array.from(mount.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
			(radio) => radio.textContent === "Facts",
		);
		act(() => facts?.click());
		expect(mount.querySelector(".feed-search-match")).toBeNull();
	});

	it("hides the search excerpt when the active mode also contains the query", () => {
		state.feedQuery = "coordinator";
		renderCard(
			observation({
				facts: ["Coordinator routing changed"],
				narrative: "The coordinator now routes through the approved peer.",
				subtitle: "Visible skim",
			}),
		);
		act(() => titleButton().click());
		const narrative = Array.from(mount.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
			(radio) => radio.textContent === "Narrative",
		);
		act(() => narrative?.click());

		expect(mount.querySelector(".feed-search-match")).toBeNull();
	});

	it("never exposes opaque origin source identifiers", () => {
		const rawSource = "internal://tenant/device-81f6d8";
		renderCard(observation({ origin_source: rawSource }));
		act(() => titleButton().click());

		expect(mount.textContent).toContain("From Other source");
		expect(mount.textContent).not.toContain(rawSource);
	});

	it("keeps files and resolved device detail behind disclosure", () => {
		renderCard(
			observation({
				actor_id: "peer-id",
				files: ["src/retry.ts"],
				origin_device_id: "raw-device-id",
				owned_by_self: false,
				resolved_actor_display_name: "Ada",
				resolved_device_display_name: "Ada's MacBook",
			}),
		);
		expect(mount.textContent).not.toContain("Ada's MacBook");
		expect(mount.querySelector(".feed-files")).toBeNull();

		act(() => titleButton().click());
		expect(mount.textContent).toContain("Device Ada's MacBook");
		expect(mount.querySelector(".feed-expanded-provenance")).not.toBeNull();
		expect(mount.querySelector(".feed-files")?.textContent).toContain("src/retry.ts");
		expect(mount.textContent).not.toContain("raw-device-id");
	});

	it("uses the approved visibility outcome notices", async () => {
		renderCard(observation());
		const select = mount.querySelector<HTMLSelectElement>(".feed-visibility-select");
		if (!select) throw new Error("Expected visibility select");
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

	it("preserves visibility, item-menu, and new-item behavior with exact copy", () => {
		const item = observation();
		state.newItemKeys.add("discovery:1234");
		renderCard(item);

		expect(mount.querySelector(".feed-item")?.classList.contains("new-item")).toBe(true);
		expect(mount.querySelector(".feed-menu-trigger")).not.toBeNull();
		const select = mount.querySelector<HTMLSelectElement>(".feed-visibility-select");
		expect(select?.getAttribute("aria-label")).toBe("Who can see Diagnostic memory");
		expect(Array.from(select?.options || []).map((option) => option.textContent)).toEqual([
			"Only me",
			"Synced peers",
		]);
	});
});
