/// <reference types="vite/client" />

import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import staticHtml from "../../../../static/index.html?raw";
import {
	completeFirstRunStep,
	dismissFirstRunGuide,
	FIRST_RUN_GUIDE_STORAGE_KEY,
	readFirstRunGuideRecord,
	reopenFirstRunGuide,
} from "../data/first-run-guide";
import { FirstRunGuide } from "./FirstRunGuide";

let mount: HTMLDivElement;

beforeEach(() => {
	localStorage.clear();
	mount = document.createElement("div");
	document.body.appendChild(mount);
});

afterEach(() => {
	act(() => render(null, mount));
	document.body.innerHTML = "";
});

describe("FirstRunGuide", () => {
	it("tolerates a throwing localStorage getter for reads and writes", () => {
		const getter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		try {
			expect(() =>
				act(() => render(<FirstRunGuide hasMemories hasQueuedEvents={false} />, mount)),
			).not.toThrow();
			act(() => completeFirstRunStep("inspect"));
			act(() => dismissFirstRunGuide());
			expect(mount.querySelector("section")).toBeNull();
			act(() => reopenFirstRunGuide());
			expect(mount.querySelector("section")).not.toBeNull();
			expect(readFirstRunGuideRecord().completed).toEqual(["capture", "inspect"]);
		} finally {
			getter.mockRestore();
			reopenFirstRunGuide();
		}
	});
	it("offers inspection only when a disclosure exists", () => {
		document.body.insertAdjacentHTML(
			"beforeend",
			'<article class="feed-item"><div class="feed-title">Minimal</div></article>',
		);
		act(() => render(<FirstRunGuide hasMemories hasQueuedEvents={false} />, mount));
		expect(mount.textContent).not.toContain("Inspect first memory");
		const card = document.querySelector(".feed-item");
		if (!card) throw new Error("card missing");
		card.innerHTML = '<button class="feed-title">Details</button>';
		act(() => render(<FirstRunGuide hasMemories hasQueuedEvents={false} />, mount));
		expect(mount.textContent).toContain("Inspect first memory");
	});
	it("renders semantic status rows and completes capture from real data", () => {
		act(() => render(<FirstRunGuide hasMemories hasQueuedEvents={false} />, mount));

		expect(mount.querySelector("section[aria-labelledby='firstRunGuideTitle']")).not.toBeNull();
		expect(mount.querySelectorAll("ol > li")).toHaveLength(5);
		expect(mount.textContent).toContain("Capture a memoryCompleted");
		expect(readFirstRunGuideRecord().completed).toContain("capture");
	});

	it("stays hidden after dismissal and can be reopened", () => {
		dismissFirstRunGuide();
		act(() => render(<FirstRunGuide hasMemories={false} hasQueuedEvents={false} />, mount));
		expect(mount.querySelector("section")).toBeNull();

		act(() => reopenFirstRunGuide());
		expect(mount.querySelector("section")).not.toBeNull();
		expect(localStorage.getItem(FIRST_RUN_GUIDE_STORAGE_KEY)).toContain('"showCompleted":true');
	});

	it("updates when another tab changes guide storage", () => {
		act(() => render(<FirstRunGuide hasMemories={false} hasQueuedEvents={false} />, mount));
		localStorage.setItem(
			FIRST_RUN_GUIDE_STORAGE_KEY,
			JSON.stringify({ completed: [], dismissed: true, showCompleted: false }),
		);

		act(() => {
			window.dispatchEvent(new StorageEvent("storage", { key: FIRST_RUN_GUIDE_STORAGE_KEY }));
		});

		expect(mount.querySelector("section")).toBeNull();
	});

	it("uses the real disclosure control to inspect the first memory", () => {
		const card = document.createElement("article");
		card.className = "feed-item";
		const title = document.createElement("button");
		title.className = "feed-title";
		const click = vi.spyOn(title, "click");
		card.appendChild(title);
		document.body.appendChild(card);
		act(() => render(<FirstRunGuide hasMemories hasQueuedEvents={false} />, mount));

		const action = Array.from(mount.querySelectorAll("button")).find(
			(button) => button.textContent === "Inspect first memory",
		);
		act(() => action?.click());

		expect(click).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(title);
	});

	it("opens Context Inspector and focuses its query for Find it again", async () => {
		const toggle = document.createElement("button");
		toggle.id = "contextInspectorToggle";
		toggle.setAttribute("aria-expanded", "false");
		const click = vi.spyOn(toggle, "click");
		const panel = document.createElement("div");
		panel.id = "contextInspectorPanel";
		const query = document.createElement("input");
		query.className = "feed-search";
		panel.appendChild(query);
		document.body.append(toggle, panel);
		act(() => render(<FirstRunGuide hasMemories hasQueuedEvents={false} />, mount));

		const action = Array.from(mount.querySelectorAll("button")).find(
			(button) => button.textContent === "Open Context Inspector",
		);
		await act(async () => action?.click());

		expect(click).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(query);
	});

	it("stacks checklist rows at the approved narrow width", () => {
		const css = staticHtml.replace(/\s+/g, " ");
		expect(css).toContain("@media (max-width: 755px)");
		expect(css).toContain(".first-run-guide-list { grid-template-columns: 1fr; }");
	});
});
