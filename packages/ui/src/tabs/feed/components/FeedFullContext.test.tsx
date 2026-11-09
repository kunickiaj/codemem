import { projectFeedItem } from "@codemem/core/feed-contract";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../lib/state";
import type { FeedItem } from "../types";
import { FeedItemCard } from "./FeedItemCard";

const contextMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api", () => ({ loadMemoryContext: contextMock }));
vi.mock("../../../components/primitives/tooltip", () => ({
	Tooltip: ({ children }: { children?: unknown }) => children,
}));
vi.mock("../../../components/primitives/radix-select", () => ({ RadixSelect: () => null }));
vi.mock("./FeedItemMenu", () => ({ FeedItemMenu: () => null }));

let mount: HTMLDivElement;
const revision = "r17";
const contextText = "Opening context.\n\nFinal **durable** paragraph.";
function fullRow(overrides: FeedItem = {}): FeedItem {
	return {
		id: 17,
		kind: "discovery",
		title: "Stored memory",
		project: "garden",
		facts: ["Visible key point"],
		narrative: contextText,
		body_text: "Hidden duplicate body",
		files: ["garden.ts"],
		workspace_kind: "repository",
		owned_by_self: true,
		visibility: "private",
		created_at: "2026-05-26T23:30:00.000Z",
		...overrides,
	};
}
function projected(overrides: FeedItem = {}, query = state.feedQuery, contextRevision = revision) {
	return projectFeedItem({ item: { ...fullRow(overrides) }, query, contextRevision });
}
function pending() {
	let resolve!: (value: unknown) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function renderCards(...items: FeedItem[]): void {
	act(() =>
		render(
			h(
				"div",
				null,
				items.map((item) =>
					h(FeedItemCard, {
						key: String(item.id),
						item,
						onReload: async () => {},
						onRemove: () => {},
						onReplace: () => {},
						onViewRefresh: () => {},
					}),
				),
			),
			mount,
		),
	);
}
function details(index = 0): HTMLDetailsElement {
	const node = mount.querySelectorAll<HTMLDetailsElement>(".feed-observation-context")[index];
	if (!node) throw new Error("Expected Full context disclosure");
	return node;
}
function toggle(open: boolean, index = 0): void {
	act(() => {
		const node = details(index);
		node.open = open;
		node.dispatchEvent(new Event("toggle"));
	});
}
async function settle(action: () => void = () => {}): Promise<void> {
	await act(async () => {
		action();
		await Promise.resolve();
	});
}
function response(context = contextText) {
	return { id: 17, revision, context };
}
function requestSignal(index = 0): AbortSignal {
	return contextMock.mock.calls[index][0].signal;
}

function renderReloadCard(onReload: () => Promise<void>, onContextReload?: () => Promise<void>) {
	act(() =>
		render(
			h(FeedItemCard, {
				item: projected(),
				onReload,
				onContextReload,
				onRemove: () => {},
				onReplace: () => {},
				onViewRefresh: () => {},
			}),
			mount,
		),
	);
}

beforeEach(() => {
	state.currentProject = "garden";
	state.feedScopeFilter = "mine";
	state.feedQuery = "";
	state.viewerActorId = "viewer-a";
	state.itemExpandState.clear();
	state.newItemKeys.clear();
	contextMock.mockReset();
	mount = document.createElement("div");
	document.body.appendChild(mount);
});
afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.restoreAllMocks();
});

describe("Feed Full context lazy disclosure", () => {
	it.each([
		{ kind: "session_summary", narrative: "Entire summary", facts: ["Summary fact"] },
		{ kind: "change", narrative: "Entire direct narrative", facts: [] },
		{ kind: "discovery", narrative: "", facts: [], body_text: "Entire legacy body" },
		{ kind: "bugfix", narrative: contextText, facts: ["Visible key point"] },
	])("preserves expanded default content without a context request: $kind", (fields) => {
		// Arrange: compare rendered default content against the existing full-row contract.
		renderCards(fullRow(fields));
		const legacyDetail = mount.querySelector(".feed-detail")?.textContent;
		const legacyVisible = legacyDetail?.replace(contextText.replaceAll("**", ""), "");
		// Act
		renderCards(projected(fields));
		// Assert
		expect(contextMock).not.toHaveBeenCalled();
		expect(mount.querySelector(".feed-disclosure")?.getAttribute("aria-expanded")).toBe("true");
		expect(mount.querySelector(".feed-files")?.textContent).toContain("garden.ts");
		expect(mount.querySelector(".feed-expanded-provenance")?.textContent).toContain("repository");
		if (fields.kind === "bugfix") {
			expect(details().open).toBe(false);
			expect(details().querySelector("summary")?.getAttribute("aria-label")).toBe(
				"Full context for Stored memory",
			);
			expect(mount.querySelector(".feed-pack-facts")?.textContent).toContain("Visible key point");
			expect(mount.querySelector(".feed-body.narrative")).toBeNull();
		} else {
			expect(mount.querySelector(".feed-detail")?.textContent).toBe(legacyVisible);
		}
	});

	it("does not fetch on outer collapse or expansion, then loads only the inner disclosure", async () => {
		// Arrange
		const job = pending();
		contextMock.mockReturnValue(job.promise);
		state.feedQuery = "durable";
		renderCards(projected());
		// Act
		const outer = mount.querySelector<HTMLButtonElement>(".feed-disclosure");
		act(() => outer?.click());
		act(() => outer?.click());
		// Assert
		expect(contextMock).not.toHaveBeenCalled();
		// Act
		toggle(true);
		await settle();
		// Assert
		expect(contextMock).toHaveBeenCalledTimes(1);
		expect(contextMock).toHaveBeenCalledWith({
			id: 17,
			project: "garden",
			scope: "mine",
			q: "durable",
			classification: "observation",
			signal: expect.any(AbortSignal),
		});
		// Act
		await settle(() => job.resolve(response()));
		// Assert: ordinary narrative rendering, including markdown, survives the asynchronous boundary.
		expect(details().querySelector(".feed-body.narrative")?.textContent).toContain(
			"Final durable paragraph.",
		);
		expect(details().querySelector("strong")?.textContent).toBe("durable");
	});

	it("keeps old-server full rows inline without fetching even when opened", async () => {
		// Arrange
		renderCards(fullRow());
		// Act
		toggle(true);
		await settle();
		// Assert
		expect(details().querySelector(".feed-body.narrative")?.textContent).toContain(
			"Final durable paragraph.",
		);
		expect(contextMock).not.toHaveBeenCalled();
	});
});

describe("Feed Full context cancellation", () => {
	it.each(["inner collapse", "outer collapse", "unmount"])(
		"cancels on %s and ignores late completion",
		async (action) => {
			// Arrange
			const job = pending();
			contextMock.mockReturnValue(job.promise);
			renderCards(projected());
			toggle(true);
			await settle();
			const signal = requestSignal();
			// Act
			if (action === "inner collapse") toggle(false);
			else if (action === "outer collapse")
				act(() => mount.querySelector<HTMLButtonElement>(".feed-disclosure")?.click());
			else act(() => render(null, mount));
			await settle(() => job.resolve(response("Late obsolete context")));
			// Assert
			expect(signal.aborted).toBe(true);
			expect(mount.textContent).not.toContain("Late obsolete context");
		},
	);

	it.each(["query", "project", "scope", "actor", "revision"])(
		"rejects stale %s results after rerender",
		async (field) => {
			// Arrange
			const job = pending();
			contextMock.mockReturnValueOnce(job.promise).mockReturnValue(pending().promise);
			renderCards(projected());
			toggle(true);
			await settle();
			const signal = requestSignal();
			// Act
			if (field === "query") state.feedQuery = "different";
			if (field === "project") state.currentProject = "other";
			if (field === "scope") state.feedScopeFilter = "theirs";
			if (field === "actor") state.viewerActorId = "viewer-b";
			renderCards(projected({}, state.feedQuery, field === "revision" ? "r18" : revision));
			await settle(() => job.resolve(response("Obsolete context")));
			// Assert
			expect(signal.aborted).toBe(true);
			expect(mount.textContent).not.toContain("Obsolete context");
		},
	);

	it.each(["query", "project", "scope", "actor"])(
		"checks live %s before parent rerenders",
		async (field) => {
			// Arrange
			const job = pending();
			contextMock.mockReturnValue(job.promise);
			renderCards(projected());
			toggle(true);
			await settle();
			// Act
			if (field === "query") state.feedQuery = "different";
			if (field === "project") state.currentProject = "other";
			if (field === "scope") state.feedScopeFilter = "theirs";
			if (field === "actor") state.viewerActorId = "viewer-b";
			await settle(() => job.resolve(response("Obsolete context")));
			// Assert
			expect(mount.textContent).not.toContain("Obsolete context");
		},
	);
});

describe("Feed Full context response validation and recovery", () => {
	it.each([false, true])(
		"uses the dedicated changed-context reload when provided: %s",
		async (dedicated) => {
			// Arrange
			const onReload = vi.fn().mockResolvedValue(undefined);
			const onContextReload = vi.fn().mockResolvedValue(undefined);
			contextMock.mockResolvedValue({ ...response(), revision: "changed" });
			renderReloadCard(onReload, dedicated ? onContextReload : undefined);
			toggle(true);
			await settle();
			const reload = Array.from(details().querySelectorAll("button")).find((button) =>
				/reload feed/i.test(button.textContent || ""),
			);
			expect(reload).toBeDefined();
			// Act
			await settle(() => reload?.click());
			// Assert: older callers retain the ordinary reload fallback.
			expect(onContextReload).toHaveBeenCalledTimes(Number(dedicated));
			expect(onReload).toHaveBeenCalledTimes(Number(!dedicated));
		},
	);

	it("does not let an old request overwrite a newer successful context", async () => {
		// Arrange
		const oldRead = pending();
		const currentRead = pending();
		contextMock.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise);
		renderCards(projected());
		toggle(true);
		await settle();
		// Act
		state.feedQuery = "current";
		renderCards(projected());
		await settle(() => currentRead.resolve(response("Current context")));
		await settle(() => oldRead.resolve(response("Obsolete context")));
		// Assert
		expect(details().querySelector(".feed-body.narrative")?.textContent).toContain(
			"Current context",
		);
		expect(mount.textContent).not.toContain("Obsolete context");
		expect(requestSignal().aborted).toBe(true);
	});

	it.each([
		{ id: 18, revision, context: "Wrong identity context" },
		{ id: 17, revision: "r18", context: "Wrong revision context" },
		{ id: 17, revision, context: { private: "Malformed context" } },
		null,
	])("rejects mismatched or malformed context response %j", async (payload) => {
		// Arrange
		contextMock.mockResolvedValue(payload);
		renderCards(projected());
		// Act
		toggle(true);
		await settle();
		// Assert
		expect(details().querySelector(".feed-body.narrative")).toBeNull();
		expect(details().textContent).toMatch(/retry|try again|reload feed/i);
		expect(details().textContent).not.toMatch(/Wrong|Malformed/);
	});

	it.each(["404", "network", "timeout"])(
		"shows a generic retry for %s and can recover",
		async (failure) => {
			// Arrange
			contextMock
				.mockRejectedValueOnce(new Error(`${failure}: /api/memory/17/context?private=secret`))
				.mockResolvedValueOnce(response());
			renderCards(projected());
			// Act
			toggle(true);
			await settle();
			// Assert
			expect(details().textContent).not.toMatch(/secret|\/api\/|404|network|timeout/);
			const retry = Array.from(details().querySelectorAll("button")).find((button) =>
				/retry|try again/i.test(button.textContent || ""),
			);
			expect(retry).toBeDefined();
			// Act
			act(() => retry?.click());
			await settle();
			// Assert
			expect(contextMock).toHaveBeenCalledTimes(2);
			expect(details().querySelector(".feed-body.narrative")?.textContent).toContain(
				"Final durable paragraph.",
			);
		},
	);

	it("does not lock another card while one request is pending", async () => {
		// Arrange
		contextMock
			.mockReturnValueOnce(pending().promise)
			.mockResolvedValueOnce({ id: 18, revision, context: "Other context" });
		renderCards(projected(), projected({ id: 18 }));
		// Act
		toggle(true);
		toggle(true, 1);
		await settle();
		// Assert
		expect(contextMock).toHaveBeenCalledTimes(2);
		expect(details(1).textContent).toContain("Other context");
		expect(details(0).textContent).not.toContain("Other context");
	});

	it("replaces projected content with a full mutation row using the legacy inline fallback", async () => {
		// Arrange
		const job = pending();
		contextMock.mockReturnValue(job.promise);
		renderCards(projected());
		toggle(true);
		await settle();
		// Act
		renderCards(fullRow({ narrative: "Updated mutation context" }));
		await settle(() => job.resolve(response("Obsolete context")));
		// Assert
		expect(requestSignal().aborted).toBe(true);
		expect(details().textContent).toContain("Updated mutation context");
		expect(mount.textContent).not.toContain("Obsolete context");
	});
});

describe("Feed projected search status copy", () => {
	it("does not suppress the excerpt when the changed-memory error contains the query", async () => {
		// Arrange
		state.feedQuery = "memory";
		contextMock.mockResolvedValue({ ...response("Unusable response"), revision: "r18" });
		const narrative = "Private memory details.";
		renderCards(projected({ narrative, title: "Stored observation" }));
		// Act
		toggle(true);
		await settle();
		// Assert
		expect(details().querySelector("[data-feed-context-status]")?.textContent).toMatch(/memory/i);
		expect(details().querySelector(".feed-body.narrative")).toBeNull();
		expect(mount.querySelector(".feed-search-match")?.textContent).toContain(narrative);
	});

	it.each(["loading", "memory"])(
		"does not count pending or error UI copy as matching content for %s",
		async (query) => {
			// Arrange: status words can also occur in the server's hidden-content excerpt.
			state.feedQuery = query;
			const narrative = "Private memory loading details.";
			const job = pending();
			contextMock.mockReturnValueOnce(job.promise).mockResolvedValueOnce(response(narrative));
			const item = projected({ narrative, title: "Stored observation" });
			renderCards(item);
			// Act
			toggle(true);
			await settle();
			// Assert
			expect(mount.querySelector(".feed-search-match")?.textContent).toContain(narrative);
			// Act
			await settle(() => job.reject(new Error("Private failure")));
			// Assert
			expect(mount.querySelector(".feed-search-match")?.textContent).toContain(narrative);
			const retry = Array.from(details().querySelectorAll("button")).find((button) =>
				/retry|try again/i.test(button.textContent || ""),
			);
			expect(retry).toBeDefined();
			// Act
			act(() => retry?.click());
			await settle();
			// Assert
			expect(details().querySelector(".feed-body.narrative")?.textContent).toContain(narrative);
			expect(mount.querySelector(".feed-search-match")).toBeNull();
			// Act: a view refresh retains loaded content without repeating the read.
			renderCards({ ...item });
			await settle();
			toggle(false);
			await settle();
			// Assert
			expect(mount.querySelector(".feed-search-match")?.textContent).toContain(narrative);
			expect(contextMock).toHaveBeenCalledTimes(2);
		},
	);
});

describe("Feed projected search excerpts", () => {
	it.each([" ", "x"])(
		"keeps projection metadata and excerpts aligned after truncation at %j",
		(boundary) => {
			// Arrange: the server truncates the query before its final whitespace trim.
			const token = "a".repeat(255);
			state.feedQuery = `${token}${boundary}discarded`;
			const effectiveQuery = `${token}${boundary}`.trim();
			const item = projected(
				{ subtitle: `Metadata ${effectiveQuery} detail` },
				state.feedQuery.trim().slice(0, 256),
			);
			// Act
			renderCards(item);
			// Assert: valid server matches must survive client query comparison.
			expect(item.feed.query).toBe(effectiveQuery);
			expect(mount.querySelector(".feed-search-match")?.textContent).toContain(
				item.feed.search_match?.excerpt,
			);
			expect(mount.querySelector(".feed-search-match mark")?.textContent).toBe(effectiveQuery);
		},
	);

	it.each([{ body_text: "Hidden needle body" }, { subtitle: "Metadata needle excerpt" }])(
		"retains server excerpt for hidden body or metadata %j",
		(fields) => {
			// Arrange
			state.feedQuery = "needle";
			const item = projected(fields);
			// Act
			renderCards(item);
			// Assert
			expect(mount.querySelector(".feed-search-match")?.textContent).toContain(
				item.feed.search_match?.excerpt,
			);
			expect(mount.querySelector(".feed-search-match mark")?.textContent).toBe("needle");
			expect(contextMock).not.toHaveBeenCalled();
		},
	);

	it("escapes Unicode excerpt HTML without dropping the search match", () => {
		// Arrange
		state.feedQuery = "café";
		// Act
		renderCards(projected({ subtitle: '<img src=x onerror="bad()"> Café 🪴' }));
		// Assert
		expect(mount.querySelector(".feed-search-match")?.textContent).toContain(
			'<img src=x onerror="bad()"> Café 🪴',
		);
		expect(mount.querySelector(".feed-search-match img")).toBeNull();
		expect(mount.querySelector(".feed-search-match mark")?.textContent).toBe("Café");
	});

	it("suppresses the duplicate excerpt after async content becomes visible and restores it on close", async () => {
		// Arrange
		state.feedQuery = "durable";
		contextMock.mockResolvedValue(response());
		renderCards(projected());
		expect(mount.querySelector(".feed-search-match")).not.toBeNull();
		// Act
		toggle(true);
		await settle();
		// Assert
		expect(mount.querySelector(".feed-search-match")).toBeNull();
		// Act
		toggle(false);
		await settle();
		// Assert
		expect(mount.querySelector(".feed-search-match")).not.toBeNull();
	});

	it("retains the excerpt when only a link URL contains the query", async () => {
		// Arrange
		state.feedQuery = "needle";
		const narrative = "See [reference](https://example.test/needle).";
		contextMock.mockResolvedValue(response(narrative));
		renderCards(projected({ narrative }));
		// Act
		toggle(true);
		await settle();
		// Assert
		expect(details().querySelector("a")?.textContent).toBe("reference");
		expect(mount.querySelector(".feed-search-match")).not.toBeNull();
	});
});
