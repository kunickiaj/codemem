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
			/\.radix-select-trigger:hover:not\(:disabled\), select\.native-select[^{}]+:hover:not\(:disabled\) \{([^}]+)\}/,
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
		const defaultRule = normalized.match(
			/\.radix-select-trigger, select\.native-select[^{}]+ \{([^}]+)\}/,
		)?.[1];
		const compactRule = normalized.match(
			/\.radix-select-trigger\[data-size="compact"\] \{([^}]+)\}/,
		)?.[1];

		// Assert
		expect(defaultRule).toContain("min-width: var(--select-min-width, 0)");
		expect(defaultRule).toContain("font-size: var(--font-size-md)");
		expect(compactRule).toContain("font-size: var(--font-size-sm)");
		expect(compactRule).not.toContain("min-width");
		expect(compactRule).not.toContain("border:");
	});
});

describe("intentional native select styles", () => {
	it.each([
		['<button class="radix-select-trigger"></button>', true],
		['<button class="radix-select-trigger" disabled></button>', false],
		['<select class="native-select"></select>', true],
		['<select class="native-select" size="1"></select>', true],
		['<select class="native-select" disabled></select>', false],
		['<select class="native-select" hidden></select>', false],
		['<select class="native-select" aria-hidden="true"></select>', false],
		['<select class="native-select" multiple></select>', false],
		['<select class="native-select" size="3"></select>', false],
		["<select></select>", false],
	])(
		"applies shared hover border only to enabled visible single pickers: %s",
		(markup, interactive) => {
			// Arrange: test hover eligibility without claiming jsdom renders pointer states.
			const normalized = controls.replace(/\s+/g, " ");
			const template = document.createElement("template");
			template.innerHTML = markup;
			// Act: preserve qualification and specificity from the actual shared border rule.
			const rule = normalized.match(
				/(\.radix-select-trigger:hover:not\(:disabled\), select\.native-select[^{}]+:hover:not\(:disabled\)) \{([^}]+)\}/,
			);
			if (!rule) throw new Error("shared native/Radix hover rule missing");
			const eligible = template.content.firstElementChild?.matches(
				rule[1].replaceAll(":hover", ""),
			);
			// Assert
			expect(rule[2]).toContain("border-color: var(--border-hover)");
			expect(rule[1]).not.toMatch(/^:where\(/);
			expect(eligible).toBe(interactive);
		},
	);

	it.each([
		['class="native-select"', true],
		['class="native-select" size="0"', true],
		['class="native-select" size="1"', true],
		['class="native-select" size="2"', false],
		['class="native-select" multiple', false],
		['class="native-select" hidden', false],
		['class="native-select" aria-hidden="true"', false],
		['aria-hidden="true" tabindex="-1"', false],
		["", false],
	])("opts in only single native pickers: %s", (attributes, styled) => {
		// Objective: listboxes, unstyled controls, and hidden Radix bubble selects keep native rendering.
		// Arrange
		const normalized = controls.replace(/\s+/g, " ");
		const template = document.createElement("template");
		template.innerHTML = `<select ${attributes}><option>Project</option></select>`;
		// Act: use the shipped appearance selector, not a duplicate selector in the test.
		const selector = normalized.match(/(select\.native-select[^{}]+) \{ appearance: none;/)?.[1];
		if (!selector) throw new Error("native select appearance rule missing");
		const matches = template.content.querySelector("select")?.matches(selector);
		// Assert
		expect(matches).toBe(styled);
	});

	it("shares trigger tokens and reserves the 14px chevron box without platform inset", () => {
		// Arrange
		const normalized = controls.replace(/\s+/g, " ");
		// Act
		const shared = normalized.match(
			/\.radix-select-trigger, select\.native-select[^{}]+ \{([^}]+)\}/,
		)?.[1];
		const native = normalized.match(
			/select\.native-select[^{}]+ \{ appearance: none;([^}]+)\}/,
		)?.[1];
		// Assert
		for (const declaration of [
			"min-width: var(--select-min-width, 0)",
			"padding: var(--sp-2) var(--sp-3)",
			"border-radius: var(--radius-sm)",
			"font-size: var(--font-size-md)",
		])
			expect(shared).toContain(declaration);
		expect(native).toContain("box-sizing: border-box");
		expect(native).toContain("min-height: 38px");
		expect(native).toContain("padding-right: calc(var(--sp-3) + 14px + var(--sp-2))");
		expect(native).toContain("var(--text-tertiary)");
		expect(native).toContain("right calc(var(--sp-3) + 7px) center");
		expect(native).toContain("background-repeat: no-repeat");
		expect(native).not.toMatch(/url\(|#[0-9a-f]{3,8}\b/i);
	});

	it("restores the platform arrow and visible focus in forced colors", () => {
		// Arrange
		const normalized = controls.replace(/\s+/g, " ");
		// Act
		const forcedColors = normalized.slice(normalized.indexOf("@media (forced-colors: active)"));
		const native = forcedColors.match(/select\.native-select[^{}]+ \{([^}]+)\}/)?.[1];
		// Assert
		expect(native).toContain("appearance: auto");
		expect(native).toContain("background-image: none");
		expect(native).not.toContain("appearance: none");
		expect(forcedColors).toContain("outline: 2px solid CanvasText");
		expect(forcedColors).not.toContain("forced-color-adjust: none");
	});
});

describe("shared choice row styles", () => {
	it("resets fieldset intrinsic width and stacks wrappable copy", () => {
		// Objective: narrow dialogs must not inherit fieldset min-content width or inline helper copy.
		// Arrange
		const normalized = html.replace(/\s+/g, " ");
		// Act
		const list = normalized.match(/\.sync-dialog-radio-list \{([^}]+)\}/)?.[1];
		const row = normalized.match(/\.sync-dialog-radio-option \{([^}]+)\}/)?.[1];
		const copy = normalized.match(/\.sync-dialog-choice-copy \{([^}]+)\}/)?.[1];
		const legend = normalized.match(/\.sync-dialog-radio-list legend \{([^}]+)\}/)?.[1];
		// Assert: CSS contracts only; jsdom does not measure layout.
		for (const declaration of ["min-width: 0", "margin: 0", "padding: 0", "border: 0"])
			expect(list).toContain(declaration);
		expect(row).toContain("min-width: 0");
		for (const declaration of [
			"display: flex",
			"flex-direction: column",
			"min-width: 0",
			"overflow-wrap: anywhere",
		])
			expect(copy).toContain(declaration);
		expect(copy).not.toContain("white-space: nowrap");
		expect(legend).toContain("max-width: 100%");
		expect(legend).toContain("overflow-wrap: anywhere");
	});

	it("keeps checked checkbox and radio rows selected without enabled-hover overrides", () => {
		// Arrange
		const normalized = html.replace(/\s+/g, " ");
		// Act
		const hover = normalized.match(/(\.sync-dialog-radio-option:hover[^{}]+) \{([^}]+)\}/);
		const selected = normalized.match(
			/\.sync-dialog-radio-option:has\(button\[data-state="checked"\], input:checked\) \{([^}]+)\}/,
		)?.[1];
		const disabled = normalized.match(
			/\.sync-dialog-radio-option:has\(:disabled, \[data-disabled\]\) \{([^}]+)\}/,
		)?.[1];
		// Assert
		expect(hover?.[1]).toContain(
			':not(:has(:disabled, [data-disabled], button[data-state="checked"], input:checked))',
		);
		expect(hover?.[2]).toContain("border-color: var(--border-hover)");
		expect(selected).toContain("var(--accent-subtle)");
		expect(disabled).toContain("cursor: not-allowed");
		expect(disabled).toContain("opacity: 0.6");
		expect(normalized).toContain(
			":has(:disabled, [data-disabled]) :is(button, input, label) { cursor: not-allowed; }",
		);
		expect(normalized).not.toMatch(/\.sync-dialog-radio-option:hover\s*\{/);
	});
});

describe("shared popup styles", () => {
	it("mutes disabled danger items and never highlights disabled menu actions", () => {
		// Arrange: inspect the shipped CSS, including its cascade ordering.
		const normalized = html.replace(/\s+/g, " ");
		// Act
		const danger = normalized.match(/\.feed-menu-item\.danger \{([^}]+)\}/);
		const disabled = normalized.match(
			/\.feed-menu-item\[data-disabled\], \.feed-menu-item:disabled \{([^}]+)\}/,
		);
		const highlights = [
			...normalized.matchAll(/([^{}]+\.feed-menu-item[^{}]+)\{([^}]+)\}/g),
		].filter((match) => /hover|focus-visible|data-highlighted/.test(match[1]));
		// Assert: the equal-specificity disabled rule wins over the danger color.
		expect(danger?.[1]).toContain("color: var(--accent-warm)");
		expect(disabled?.[1]).toContain("color: var(--text-tertiary)");
		expect(disabled?.index).toBeGreaterThan(danger?.index ?? -1);
		expect(highlights).toHaveLength(2);
		for (const rule of highlights) {
			for (const selector of rule[1].split(",")) {
				expect(selector).toContain(":not([data-disabled]):not(:disabled)");
			}
		}
	});

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
		const nativeHoverPattern = /(?:^|})\s*(:where\([^{}]*:hover:not\(:disabled\)[^{}]*)\{/g;

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
