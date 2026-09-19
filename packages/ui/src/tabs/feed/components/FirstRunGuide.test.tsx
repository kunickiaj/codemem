/// <reference types="vite/client" />

import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import staticHtml from "../../../../static/index.html?raw";
import {
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

	it("stacks checklist rows at the approved narrow width", () => {
		const css = staticHtml.replace(/\s+/g, " ");
		expect(css).toContain("@media (max-width: 755px)");
		expect(css).toContain(".first-run-guide-list { grid-template-columns: 1fr; }");
	});
});
