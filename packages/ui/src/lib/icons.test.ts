/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import viewerHtml from "../../static/index.html?raw";
import { initializeViewerIcons } from "./icons";
import { initThemeToggle, setTheme } from "./theme";

const usedIconNames = [
	"activity",
	"archive",
	"book-open",
	"circle-arrow-up",
	"circle-help",
	"check-circle",
	"copy-check",
	"filter",
	"inbox",
	"layers",
	"loader",
	"minus-circle",
	"package",
	"pencil",
	"percent",
	"shield-check",
	"tag",
	"trending-down",
	"trending-up",
	"alert-triangle",
	"settings",
	"sun",
	"moon",
	"x",
	"help-circle",
];

function viewerIcons() {
	const lucide = (globalThis as { lucide?: { createIcons: () => void } }).lucide;
	if (!lucide) throw new Error("Viewer icon adapter was not installed");
	return lucide;
}

function appendPlaceholder(name: string) {
	const icon = document.createElement("i");
	icon.setAttribute("data-lucide", name);
	document.body.appendChild(icon);
	return icon;
}

beforeEach(() => {
	document.body.innerHTML = "";
	localStorage.clear();
	vi.stubGlobal("lucide", undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Icons must not fetch remote assets");
		}),
	);
});

afterEach(() => {
	document.body.innerHTML = "";
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-color-mode");
	document.documentElement.removeAttribute("data-theme-variant");
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("bundled viewer icons", () => {
	// The adapter must cover both current names and the viewer's legacy aliases.
	it.each(usedIconNames)("renders the used %s placeholder on initialization", (name) => {
		// Arrange
		appendPlaceholder(name);

		// Act
		initializeViewerIcons();

		// Assert
		const svg = document.querySelector("svg");
		expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(svg?.children.length).toBeGreaterThan(0);
		expect(document.querySelector("i[data-lucide]")).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("renders the actual static viewer placeholders without executing its scripts", () => {
		// Arrange
		const source = new DOMParser().parseFromString(viewerHtml, "text/html");
		const placeholders = [...source.querySelectorAll("[data-lucide]")];
		for (const placeholder of placeholders) {
			document.body.appendChild(document.importNode(placeholder, true));
		}

		// Act
		initializeViewerIcons();

		// Assert
		expect(placeholders.length).toBeGreaterThan(0);
		expect(document.querySelectorAll("svg")).toHaveLength(placeholders.length);
		expect(document.querySelector("i[data-lucide]")).toBeNull();
	});

	it("installs a usable adapter even when there are no initial placeholders", () => {
		// Arrange
		expect(document.body.children).toHaveLength(0);

		// Act
		initializeViewerIcons();
		viewerIcons().createIcons();

		// Assert
		expect(viewerIcons().createIcons).toBeTypeOf("function");
		expect(document.body.children).toHaveLength(0);
	});

	it("renders later placeholders through the existing global createIcons API", () => {
		// Arrange
		initializeViewerIcons();
		appendPlaceholder("alert-triangle");
		appendPlaceholder("check-circle");

		// Act
		viewerIcons().createIcons();

		// Assert
		expect(document.querySelectorAll("svg")).toHaveLength(2);
		expect(document.querySelector("i[data-lucide]")).toBeNull();
	});

	it("does not duplicate rendered icons on repeated calls", () => {
		// Arrange
		appendPlaceholder("settings");
		initializeViewerIcons();

		// Act
		viewerIcons().createIcons();
		viewerIcons().createIcons();

		// Assert
		expect(document.querySelectorAll("svg")).toHaveLength(1);
		expect(document.querySelector("svg svg")).toBeNull();
	});

	it("preserves placeholder classes and accessible labels", () => {
		// Arrange
		const placeholder = appendPlaceholder("circle-help");
		placeholder.className = "health-icon custom-size";
		placeholder.setAttribute("aria-label", "Health information");
		placeholder.setAttribute("role", "img");

		// Act
		initializeViewerIcons();

		// Assert
		const svg = document.querySelector("svg");
		expect(svg?.classList.contains("health-icon")).toBe(true);
		expect(svg?.classList.contains("custom-size")).toBe(true);
		expect(svg?.getAttribute("aria-label")).toBe("Health information");
		expect(svg?.getAttribute("role")).toBe("img");
	});

	it("leaves an unknown icon name inert while rendering known siblings", () => {
		// Arrange
		const unknown = appendPlaceholder('<script>alert("icon")</script>');
		appendPlaceholder("moon");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Act
		initializeViewerIcons();
		viewerIcons().createIcons();

		// Assert
		expect(unknown.isConnected).toBe(true);
		expect(unknown.children).toHaveLength(0);
		expect(document.querySelectorAll("svg")).toHaveLength(1);
		expect(document.querySelector("script, iframe, [onload], [onerror]")).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("bundled theme and static entrypoint icons", () => {
	it.each([
		{
			initial: "light",
			icon: "moon",
			next: "dark",
			nextIcon: "sun",
			label: "Switch to dark theme",
			nextLabel: "Switch to light theme",
		},
		{
			initial: "dark",
			icon: "sun",
			next: "light",
			nextIcon: "moon",
			label: "Switch to light theme",
			nextLabel: "Switch to dark theme",
		},
	])(
		"renders the $initial theme toggle and its replacement after a click",
		({ initial, icon, next, nextIcon, label, nextLabel }) => {
			// Arrange
			initializeViewerIcons();
			setTheme(initial);
			const button = document.createElement("button");
			document.body.appendChild(button);

			// Act
			initThemeToggle(button);

			// Assert
			expect(button.querySelector("svg")?.classList.contains(`lucide-${icon}`)).toBe(true);
			expect(button.getAttribute("aria-label")).toBe(label);
			expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

			// Act
			button.click();

			// Assert
			expect(document.documentElement.getAttribute("data-theme")).toBe(next);
			expect(button.querySelectorAll("svg")).toHaveLength(1);
			expect(button.querySelector("svg")?.classList.contains(`lucide-${nextIcon}`)).toBe(true);
			expect(button.getAttribute("aria-label")).toBe(nextLabel);
			expect(button.querySelector("i")).toBeNull();
		},
	);

	it("accepts a missing theme toggle without disturbing existing icons", () => {
		// Arrange
		appendPlaceholder("sun");
		initializeViewerIcons();
		const markup = document.body.innerHTML;

		// Act
		initThemeToggle(null);

		// Assert
		expect(document.body.innerHTML).toBe(markup);
	});

	it("loads the local app bundle but no remote scripts in static HTML", () => {
		// Arrange
		const source = new DOMParser().parseFromString(viewerHtml, "text/html");

		// Act
		const scriptSources = [...source.querySelectorAll("script[src]")].map((script) =>
			script.getAttribute("src"),
		);

		// Assert
		expect(scriptSources).toContain("/assets/app.js");
		expect(scriptSources.some((src) => /^(?:https?:)?\/\//i.test(src ?? ""))).toBe(false);
	});
});
