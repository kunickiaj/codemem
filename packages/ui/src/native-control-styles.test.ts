/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import stagingScript from "../scripts/stage-viewer-static.mjs?raw";
import controls from "../static/controls.css?inline";
import html from "../static/index.html?raw";
import themes from "../static/themes.css?inline";
import tokens from "../static/tokens.css?inline";

describe("shared select control styles", () => {
	it("changes the shared trigger border on hover only when enabled", () => {
		// Objective: disabled selects must not look interactive on hover.
		// Arrange
		const normalized = controls.replace(/\s+/g, " ");

		// Act
		const enabledHover = normalized.match(
			/\.radix-select-trigger:hover:not\(:disabled\) \{([^}]+)\}/,
		)?.[1];

		// Assert
		expect(enabledHover).toContain("border-color: var(--border-hover)");
		expect(normalized).not.toMatch(/\.radix-select-trigger:hover\s*\{/);
		expect(normalized).not.toMatch(/\.radix-select-trigger:hover:disabled\s*\{/);
	});

	it("truncates long shared select labels without shrinking the icons", () => {
		// Objective: long project names must fit while the chevron and selected indicator stay visible.
		// Arrange
		const normalized = controls.replace(/\s+/g, " ");

		// Act
		const labelRule = normalized.match(
			/\.radix-select-trigger > span:first-child, \.radix-select-item > span:first-child \{([^}]+)\}/,
		)?.[1];
		const iconRule = normalized.match(
			/\.radix-select-icon, \.radix-select-indicator \{([^}]+)\}/,
		)?.[1];

		// Assert
		for (const declaration of [
			"min-width: 0",
			"overflow: hidden",
			"text-overflow: ellipsis",
			"white-space: nowrap",
		]) {
			expect(labelRule).toContain(declaration);
		}
		expect(iconRule).toContain("flex: 0 0 auto");
		expect(iconRule).not.toContain("overflow: hidden");
		expect(iconRule).not.toContain("text-overflow");
	});

	it("uses shared popup tokens and limits select content to available space", () => {
		// Objective: every select gets a themed popup without feature-specific CSS or unbounded height.
		// Arrange
		const normalized = controls.replace(/\s+/g, " ");

		// Act
		const popupRule = normalized.match(/\.radix-select-content \{([^}]+)\}/)?.[1];
		const viewportRule = normalized.match(/\.radix-select-viewport \{([^}]+)\}/)?.[1];

		// Assert
		expect(popupRule).toContain("border-radius: var(--popup-radius)");
		expect(popupRule).toContain("box-shadow: var(--popup-shadow)");
		expect(popupRule).toContain("max-height: var(--radix-select-content-available-height)");
		expect(popupRule).toContain("max-width: min(420px, calc(100vw - 24px))");
		expect(viewportRule).toContain("padding: var(--popup-padding)");
		expect(popupRule).not.toContain("max-height: none");
		expect(popupRule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});

	it("shares the field focus halo without removing button focus outlines", () => {
		// Objective: field halos remain consistent while keyboard users can still see focused buttons.
		// Arrange
		const normalized = controls.replace(/\s+/g, " ");

		// Act
		const fieldRule = normalized.match(/([^{}]+\.radix-select-trigger:focus-visible) \{([^}]+)\}/);
		const baselineRule = normalized.match(
			/:where\(button, input, select, textarea\):focus-visible \{([^}]+)\}/,
		)?.[1];

		// Assert
		expect(fieldRule?.[1]).toContain("textarea:focus-visible");
		expect(fieldRule?.[1]).toContain("select:focus-visible");
		expect(fieldRule?.[1]).not.toMatch(/(?:^|,)\s*button:focus-visible/);
		expect(fieldRule?.[2]).toContain("box-shadow: var(--control-focus-shadow)");
		expect(baselineRule).toContain("outline: 2px solid var(--accent)");
		expect(baselineRule).not.toContain("outline: none");
	});

	it("keeps compact select styling additive to the default geometry", () => {
		// Arrange
		const normalized = controls.replace(/\s+/g, " ");

		// Act
		const defaultRule = normalized.match(/\.radix-select-trigger \{([^}]+)\}/)?.[1];
		const compactRule = normalized.match(
			/\.radix-select-trigger\[data-size="compact"\] \{([^}]+)\}/,
		)?.[1];

		// Assert
		expect(defaultRule).toContain("min-width: 0");
		expect(defaultRule).toContain("font-size: var(--font-size-md)");
		expect(compactRule).toContain("font-size: var(--font-size-sm)");
		expect(compactRule).not.toContain("min-width");
		expect(compactRule).not.toContain("border:");
	});
});

describe("shared popup styles", () => {
	it.each(["feed-menu-panel", "project-scope-picker-popover", "autocomplete-popover"])(
		"uses the same popup tokens for %s without local radius or shadow values",
		(className) => {
			// Objective: menus, scope pickers, and autocomplete share the Select popup theme.
			// Arrange
			const normalized = html.replace(/\s+/g, " ");

			// Act
			const rule = normalized.match(new RegExp(`(?:^|})\\s*\\.${className} \\{([^}]+)\\}`))?.[1];

			// Assert
			expect(rule).toContain("border-radius: var(--popup-radius)");
			expect(rule).toContain("box-shadow: var(--popup-shadow)");
			expect(rule).toContain("padding: var(--popup-padding)");
			expect(rule).not.toMatch(/border-radius:\s*\d/);
			expect(rule).not.toMatch(/box-shadow:\s*\d/);
		},
	);
});

describe("native control styles", () => {
	it("keeps the Models in use disclosure at normal text size", () => {
		const rule = html.match(/\.observer-routing-details summary \{([^}]+)\}/)?.[1];
		expect(rule).toContain("font-size: var(--font-size-base)");
		expect(rule).toContain("color: var(--text-secondary)");
	});
	it("loads the global control baseline after theme tokens", () => {
		const tokensIndex = html.indexOf('<link rel="stylesheet" href="/assets/tokens.css" />');
		const themesIndex = html.indexOf('<link rel="stylesheet" href="/assets/themes.css" />');
		const controlsIndex = html.indexOf('<link rel="stylesheet" href="/assets/controls.css" />');

		expect(tokensIndex).toBeGreaterThan(-1);
		expect(themesIndex).toBeGreaterThan(tokensIndex);
		expect(controlsIndex).toBeGreaterThan(themesIndex);
	});

	it("covers native control families without feature-specific classes", () => {
		const normalizedControls = controls.replace(/\s+/g, " ");

		expect(normalizedControls).toContain(":where(button, input, select, textarea)");
		expect(normalizedControls).toContain('input[type="checkbox"]');
		expect(normalizedControls).toContain('input[type="radio"]');
		expect(normalizedControls).toContain('input[type="file"]');
		expect(normalizedControls).toContain('input[type="range"]');
		expect(normalizedControls).toContain("@media (forced-colors: active)");
	});

	it("declares the browser color scheme for dark and light themes", () => {
		expect(tokens).toContain("color-scheme: dark");
		expect(themes).toContain("color-scheme: light");
	});

	it("keeps baseline hover states at zero specificity", () => {
		// Arrange: shared component hover rules have their own selector contract.
		const nativeHoverPattern = /(:where\([^{}]*:hover:not\(:disabled\)[^{}]*)\{/g;

		// Act
		const hoverSelectors = [...controls.matchAll(nativeHoverPattern)].map(([, selector]) =>
			selector.trim(),
		);

		// Assert
		expect(hoverSelectors).toHaveLength(2);
		for (const selector of hoverSelectors) {
			expect(selector.startsWith(":where(")).toBe(true);
			expect(selector.endsWith(")")).toBe(true);
		}
	});

	it("keeps disabled file selector buttons non-interactive", () => {
		const normalizedControls = controls.replace(/\s+/g, " ");

		expect(normalizedControls).toContain(
			':where(input[type="file"]:not(:disabled))::file-selector-button:hover',
		);
		expect(normalizedControls).not.toContain(
			':where(input[type="file"])::file-selector-button:hover',
		);
		expect(normalizedControls).toContain(
			':where(input[type="file"]:disabled)::file-selector-button { cursor: not-allowed; }',
		);
	});

	it("keeps direct device card actions compact in equal-height grids", () => {
		const normalizedHtml = html.replace(/\s+/g, " ");
		const mobileStyles = normalizedHtml.slice(normalizedHtml.indexOf("@media (max-width: 720px)"));

		expect(normalizedHtml).toContain(
			"#devicesMount .recipient-policy-sharing-card > .settings-button { align-self: end; margin-top: var(--sp-4); }",
		);
		expect(normalizedHtml).toContain(
			"#devicesMount .device-identity-card-actions { align-self: end; display: grid; gap: var(--sp-2); margin-top: var(--sp-4); }",
		);
		expect(mobileStyles).toContain(
			"#devicesMount .recipient-policy-sharing-card > .settings-button, #devicesMount .device-identity-card-actions .settings-button { min-height: 44px; width: 100%; }",
		);
	});

	it("uses one geometry for sibling Sharing decision actions", () => {
		// Arrange
		const normalizedHtml = html.replace(/\s+/g, " ");
		const normalizedControls = controls.replace(/\s+/g, " ");

		// Act
		const sharedGeometry = normalizedControls.match(
			/\.settings-button, \.settings-save \{([^}]+)\}/,
		)?.[1];

		// Assert
		expect(sharedGeometry).toContain("min-height: 36px;");
		expect(sharedGeometry).toContain("padding: var(--sp-2) var(--sp-3);");
		expect(sharedGeometry).toContain("border-radius: var(--radius-md);");
		expect(tokens).toMatch(/--radius-md:\s*12px/);
		expect(normalizedHtml).not.toContain(
			".recipient-policy-review-actions > :is(.settings-save, .settings-button)",
		);
	});

	it("precompresses every linked static stylesheet", () => {
		const stylesheets = [...html.matchAll(/href="\/assets\/([^"?]+\.css)"/g)].map(
			([, filename]) => filename,
		);

		expect(stylesheets).not.toHaveLength(0);
		for (const filename of stylesheets) {
			expect(stagingScript).toContain(`"${filename}"`);
		}
	});

	it("cache-busts the staged viewer bundle from its content hash", () => {
		expect(stagingScript).toContain('createHash("sha256")');
		expect(stagingScript).toContain(`/assets/app.js?v=\${appVersion}`);
	});
});
