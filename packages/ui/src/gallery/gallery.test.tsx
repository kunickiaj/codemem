import { describe, expect, it } from "vitest";
import { GALLERY_FAMILIES, Gallery } from "./gallery";
import { click, node, setupGalleryTests } from "./gallery-test-helpers";
import { LONG_LABEL } from "./inputs";

const { getMount } = setupGalleryTests(() => <Gallery />);

describe("gallery fixture contracts", () => {
	it("mounts all eight linked families with actual controls and no network", () => {
		// Arrange
		const mount = getMount();
		const fixtures = {
			buttons: "button",
			selects: "select",
			fields: "textarea",
			choices: '[role="switch"]',
			tabs: '[role="tablist"]',
			indicators: '[data-testid="gallery-chips"]',
			overlays: '[data-testid="gallery-dialog-trigger"]',
			loading: '[role="status"]',
		};
		// Act
		const sections = [...mount.querySelectorAll("section")];
		// Assert: missing or duplicated families cannot pass just by repeating headings.
		expect(GALLERY_FAMILIES).toEqual(Object.keys(fixtures));
		expect(sections.map((section) => section.id)).toEqual(GALLERY_FAMILIES);
		for (const [id, selector] of Object.entries(fixtures)) {
			const section = node(`#${id}`);
			expect(section.querySelector(selector)).not.toBeNull();
			expect(document.getElementById(section.getAttribute("aria-labelledby") || "")).not.toBeNull();
			expect(mount.querySelectorAll(`nav a[href="#${id}"]`)).toHaveLength(1);
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(mount.querySelectorAll("script,iframe")).toHaveLength(0);
	});

	it("updates every enabled button locally but ignores disabled and busy examples", () => {
		// Arrange
		const buttons = [...node("#buttons").querySelectorAll<HTMLButtonElement>("button")];
		const enabled = buttons.filter((button) => !button.disabled);
		const disabled = buttons.filter((button) => button.disabled);
		// Act
		for (const button of enabled) click(button);
		for (const button of disabled) click(button);
		// Assert
		expect(node('[data-testid="gallery-button-result"]').textContent).toBe(
			`Fixture clicks: ${enabled.length}`,
		);
		expect(disabled).toHaveLength(2);
		expect(disabled.some((button) => button.getAttribute("aria-busy") === "true")).toBe(true);
		expect(enabled.some((button) => button.textContent === LONG_LABEL)).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("switches both theme attributes to light and back without retaining light state", () => {
		// Arrange
		const toggle = node('[data-testid="gallery-theme-toggle"]');
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		// Act
		click(toggle);
		// Assert
		expect(document.documentElement.dataset).toMatchObject({ theme: "light", colorMode: "light" });
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		// Act
		click(toggle);
		// Assert
		expect(document.documentElement.dataset).toMatchObject({ theme: "dark", colorMode: "dark" });
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
	});
});
