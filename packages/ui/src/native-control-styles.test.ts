/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import stagingScript from "../scripts/stage-viewer-static.mjs?raw";
import controls from "../static/controls.css?inline";
import html from "../static/index.html?raw";
import themes from "../static/themes.css?inline";
import tokens from "../static/tokens.css?inline";

describe("native control styles", () => {
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
		const hoverSelectors = [...controls.matchAll(/([^{}]+:hover:not\(:disabled\)[^{}]*)\{/g)].map(
			([, selector]) => selector.trim(),
		);

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
